const test = require("node:test");
const assert = require("node:assert/strict");
const { createCheckoutService, buildCheckoutItems, checkoutInput } = require("../services/checkoutService");
const ids = { parent: "111111111111111111111111", secondParent: "222222222222222222222222", product: "333333333333333333333333", cart: "444444444444444444444444" };
const product = { _id: ids.product, name: "Training shirt", status: "ACTIVE", availabilityStatus: "IN_STOCK", stock: 1, price: 0.1, sizes: [], colors: [] };
const input = { parentId: ids.parent, shippingAddress: "10 Example Street", idempotencyKey: "checkout-test-0001" };

function harness({ invoiceFailure = false, deliveryFailure = false } = {}) {
  let state = { products: [structuredClone(product)], carts: [ids.parent, ids.secondParent].map((parent, index) => ({ _id: `${ids.cart.slice(0, -1)}${index}`, parent, __v: 0, items: [{ product: ids.product, quantity: 1, selectedSize: "", selectedColor: "" }] })), invoices: [], orders: [], deliveries: [] };
  let ended = 0;
  let opened = 0;
  let tail = Promise.resolve();
  const chain = (value) => ({ session: async (session) => { assert.equal(session.active, true, "all reads are inside the transaction"); return structuredClone(value); } });
  const findOrder = (query) => state.orders.find((order) => order.parent === query.parent && order.checkoutKey === query.checkoutKey);
  const models = {
    Parent: { findById: (parent) => chain({ _id: parent, status: "APPROVED", fullName: "Test parent" }) },
    Cart: {
      findOne: ({ parent }) => chain(state.carts.find((cart) => cart.parent === parent)),
      updateOne: async (filter, update, { session }) => { assert.equal(session.active, true); const cart = state.carts.find((entry) => entry._id === filter._id && entry.__v === filter.__v); if (!cart) return { matchedCount: 0 }; Object.assign(cart, update.$set); cart.__v += 1; return { matchedCount: 1 }; },
    },
    Product: {
      find: () => chain(state.products),
      updateOne: async (filter, update, { session }) => { assert.equal(session.active, true); const item = state.products.find((entry) => entry._id === filter._id && entry.stock >= filter.stock.$gte); if (!item) return { matchedCount: 0 }; item.stock += update.$inc.stock; return { matchedCount: 1 }; },
    },
    Order: { findOne: (query) => chain(findOrder(query)), create: async (entries, { session }) => { assert.equal(session.active, true); const item = { ...entries[0], _id: `order-${state.orders.length + 1}` }; state.orders.push(item); return [item]; } },
    Invoice: {
      findById: (invoice) => chain(state.invoices.find((entry) => entry._id === invoice)),
      create: async (entries, { session }) => { assert.equal(session.active, true); if (invoiceFailure) throw new Error("Invoice unavailable"); const item = { ...entries[0], _id: `invoice-${state.invoices.length + 1}` }; state.invoices.push(item); return [item]; },
    },
  };
  const checkout = createCheckoutService({
    models,
    startSession: async () => {
      opened += 1;
      const session = { active: false, withTransaction: async (callback) => {
        // The fake serializes commits as Mongo write conflicts + retries do;
        // no connection, environment, email or external service is involved.
        let release; const previous = tail; tail = new Promise((resolve) => { release = resolve; }); await previous;
        const snapshot = structuredClone(state); session.active = true;
        try { await callback(); } catch (error) { state = snapshot; throw error; }
        finally { session.active = false; release(); }
      }, endSession: async () => { ended += 1; } };
      return session;
    },
    generateInvoiceNumber: async ({ session }) => { assert.equal(session.active, true); return `INV-TEST-${state.invoices.length + 1}`; },
    queueNotification: async (key, payload, session) => { assert.equal(session.active, true); if (deliveryFailure) throw new Error("Outbox unavailable"); state.deliveries.push({ key, payload }); },
  });
  return { checkout, state: () => state, sessions: () => ({ opened, ended }) };
}

test("checkout validates address, parent identity, key, integer quantities and variant selection", () => {
  assert.throws(() => checkoutInput({ ...input, parentId: undefined }), /parent account/);
  assert.throws(() => checkoutInput({ ...input, shippingAddress: "" }), /shipping address/);
  assert.throws(() => checkoutInput({ ...input, idempotencyKey: "bad key!" }), /Idempotency-Key/);
  for (const quantity of [-1, 0, 1.5, "2", Infinity]) assert.throws(() => buildCheckoutItems([{ product: ids.product, quantity }], [product]), /quantity/);
  assert.throws(() => buildCheckoutItems([{ product: ids.product, quantity: 1, selectedSize: "M" }], [product]), /size/);
});

test("checkout uses cents for exact totals and aggregates stock across variants", () => {
  const products = [{ ...product, stock: 20 }, { ...product, _id: "second-product", stock: 20, price: 0.2 }];
  const totals = buildCheckoutItems([{ product: ids.product, quantity: 3 }, { product: "second-product", quantity: 1 }], products);
  assert.equal(totals.totalAmount, 0.5);
  assert.equal(totals.totalMinor, 50);
  assert.throws(() => buildCheckoutItems([{ product: ids.product, quantity: 1 }, { product: ids.product, quantity: 1 }], [product]), /Insufficient stock/);
});

test("successful checkout atomically writes order, invoice, stock, empty cart and durable notifications; retry returns same order", async () => {
  const h = harness();
  const first = await h.checkout(input);
  const second = await h.checkout(input);
  assert.equal(first.repeated, false);
  assert.equal(second.repeated, true);
  assert.equal(first.order._id, second.order._id);
  assert.equal(h.state().products[0].stock, 0);
  assert.equal(h.state().orders.length, 1);
  assert.equal(h.state().invoices.length, 1);
  assert.equal(h.state().deliveries.length, 2);
  assert.deepEqual(h.state().carts[0].items, []);
  assert.deepEqual(h.sessions(), { opened: 2, ended: 2 });
  await assert.rejects(h.checkout({ ...input, shippingAddress: "Different address" }), /different shipping address/);
});

test("legacy clients without an explicit key can read back a committed checkout after a timeout", async () => {
  const h = harness();
  const first = await h.checkout({ ...input, idempotencyKey: undefined });
  const retry = await h.checkout({ ...input, idempotencyKey: undefined });
  assert.equal(retry.repeated, true);
  assert.equal(retry.order._id, first.order._id);
  assert.equal(h.state().orders.length, 1);
});

test("invoice or outbox failure rolls back stock, invoice, order and cart and always releases session", async () => {
  for (const options of [{ invoiceFailure: true }, { deliveryFailure: true }]) {
    const h = harness(options);
    await assert.rejects(h.checkout(input), /unavailable/);
    assert.equal(h.state().products[0].stock, 1);
    assert.equal(h.state().orders.length, 0);
    assert.equal(h.state().invoices.length, 0);
    assert.equal(h.state().carts[0].items.length, 1);
    assert.equal(h.state().deliveries.length, 0);
    assert.deepEqual(h.sessions(), { opened: 1, ended: 1 });
  }
});

test("concurrent checkout attempts cannot sell the last unit twice and failed carts retain their contents", async () => {
  const h = harness();
  const outcomes = await Promise.allSettled([h.checkout(input), h.checkout({ ...input, parentId: ids.secondParent, idempotencyKey: "checkout-test-0002" })]);
  assert.equal(outcomes.filter((entry) => entry.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter((entry) => entry.status === "rejected").length, 1);
  assert.equal(h.state().products[0].stock, 0);
  assert.equal(h.state().orders.length, 1);
  assert.equal(h.state().carts.filter((cart) => cart.items.length === 1).length, 1);
  assert.deepEqual(h.sessions(), { opened: 2, ended: 2 });
});

test("empty or invalid carts release transactions without changing stock", async () => {
  const h = harness(); h.state().carts[0].items = [];
  await assert.rejects(h.checkout(input), /empty/);
  assert.deepEqual(h.sessions(), { opened: 1, ended: 1 });
  assert.equal(h.state().products[0].stock, 1);
});
