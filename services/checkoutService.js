const mongoose = require("mongoose");
const Product = require("../models/Product");
const Cart = require("../models/Cart");
const Order = require("../models/Order");
const Invoice = require("../models/Invoice");
const Parent = require("../models/Parent");
const { toMinorUnits } = require("../utils/money");
const fail = (statusCode, message) => Object.assign(new Error(message), { statusCode });
const id = (value) => String(value?._id || value || "");

function checkoutInput(input = {}) {
  if (!mongoose.isValidObjectId(input.parentId)) throw fail(403, "A parent account is required to checkout");
  if (typeof input.shippingAddress !== "string" || input.shippingAddress.trim().length < 3 || input.shippingAddress.length > 2000) throw fail(400, "Provide a shipping address of 3 to 2000 characters");
  if (input.idempotencyKey && (typeof input.idempotencyKey !== "string" || !/^[A-Za-z0-9:_-]{8,128}$/.test(input.idempotencyKey))) throw fail(400, "Idempotency-Key must contain 8 to 128 letters, numbers, colons, hyphens or underscores");
  return { ...input, shippingAddress: input.shippingAddress.trim() };
}

function buildCheckoutItems(cartItems, products) {
  if (!Array.isArray(cartItems) || !cartItems.length || cartItems.length > 100) throw fail(400, "Your cart must contain between 1 and 100 items");
  let totalMinor = 0;
  const stock = new Map();
  const orderItems = [];
  const invoiceItems = [];
  for (const item of cartItems) {
    const product = products.find((entry) => id(entry) === id(item.product));
    if (!product || product.status !== "ACTIVE" || product.availabilityStatus === "OUT_OF_STOCK") throw fail(409, "A cart product is unavailable. Refresh your cart.");
    if (!Number.isSafeInteger(item.quantity) || item.quantity < 1 || item.quantity > 1000) throw fail(400, `Invalid quantity for ${product.name}`);
    const size = String(item.selectedSize || "").trim();
    const color = String(item.selectedColor || "").trim();
    if ((product.sizes?.length && !product.sizes.includes(size)) || (!product.sizes?.length && size)) throw fail(409, `Select an available size for ${product.name}`);
    if ((product.colors?.length && !product.colors.includes(color)) || (!product.colors?.length && color)) throw fail(409, `Select an available color for ${product.name}`);
    const priceMinor = toMinorUnits(product.price);
    const lineMinor = priceMinor * item.quantity;
    totalMinor += lineMinor;
    if (!Number.isSafeInteger(lineMinor) || !Number.isSafeInteger(totalMinor)) throw fail(400, "Order amount exceeds the supported currency range");
    const quantity = (stock.get(id(product)) || 0) + item.quantity;
    if (!Number.isSafeInteger(product.stock) || quantity > product.stock) throw fail(409, `Insufficient stock for ${product.name}`);
    stock.set(id(product), quantity);
    orderItems.push({ product: product._id, quantity: item.quantity, price: priceMinor / 100, priceMinor, selectedSize: size, selectedColor: color });
    invoiceItems.push({ title: product.name, description: `Size: ${size || "N/A"}, Color: ${color || "N/A"}, Qty: ${item.quantity}`, amount: lineMinor / 100 });
  }
  return { stock, orderItems, invoiceItems, totalMinor, totalAmount: totalMinor / 100 };
}

function createCheckoutService(deps = {}) {
  const models = { Product, Cart, Order, Invoice, Parent, ...deps.models };
  const startSession = deps.startSession || (() => mongoose.startSession());
  const invoiceNumber = deps.generateInvoiceNumber || ((command) => require("./invoiceService").generateInvoiceNumber(command));
  const queueNotification = deps.queueNotification || ((...args) => require("./deliveryService").queueNotification(...args));
  return async function checkout(rawInput) {
    const input = checkoutInput(rawInput);
    const session = await startSession();
    let result;
    const previousOrder = async (key) => {
      const order = await models.Order.findOne({ parent: input.parentId, checkoutKey: key }).session(session);
      if (!order) return null;
      if (order.shippingAddress !== input.shippingAddress) throw fail(409, "This checkout key was already used for a different shipping address");
      const invoice = await models.Invoice.findById(order.invoice).session(session);
      if (!invoice) throw fail(409, "The previous checkout needs invoice reconciliation; contact an administrator");
      return { order, invoice, repeated: true };
    };
    try {
      await session.withTransaction(async () => {
        const parent = await models.Parent.findById(input.parentId).session(session);
        if (!parent || parent.isBlocked || parent.status !== "APPROVED") throw fail(403, "This parent account cannot checkout");
        if (input.idempotencyKey) {
          const previous = await previousOrder(input.idempotencyKey);
          if (previous) { result = previous; return; }
        }
        // Product and cart snapshots are read in the same transaction as stock.
        const cart = await models.Cart.findOne({ parent: input.parentId }).session(session);
        if (!cart || !cart.items?.length) {
          if (!input.idempotencyKey && cart?.lastCheckoutKey) {
            const previous = await previousOrder(cart.lastCheckoutKey);
            if (previous) { result = previous; return; }
          }
          throw fail(400, "Your shopping cart is empty");
        }
        const key = input.idempotencyKey || `cart:${cart._id}:${cart.__v || 0}`;
        const existing = await previousOrder(key);
        if (existing) { result = existing; return; }
        const products = await models.Product.find({ _id: { $in: cart.items.map((item) => item.product) } }).session(session);
        const totals = buildCheckoutItems(cart.items, products);
        // Aggregate all size/color rows before reserving a shared product stock.
        for (const [productId, quantity] of totals.stock) {
          const reserved = await models.Product.updateOne({ _id: productId, status: "ACTIVE", availabilityStatus: { $ne: "OUT_OF_STOCK" }, stock: { $gte: quantity } }, { $inc: { stock: -quantity } }, { session });
          if (!reserved.matchedCount) throw fail(409, "Stock changed during checkout. Refresh your cart and try again.");
        }
        const number = await invoiceNumber({ session });
        const dueDate = new Date(); dueDate.setUTCDate(dueDate.getUTCDate() + 7);
        const [invoice] = await models.Invoice.create([{ chargeKey: `store:${input.parentId}:${key}`, invoiceNumber: number, parent: input.parentId, items: totals.invoiceItems, subtotal: totals.totalAmount, discount: 0, totalAmount: totals.totalAmount, amount: totals.totalAmount, dueDate, type: "STORE_ORDER", description: `Store order for ${totals.orderItems.length} item(s)`, paymentStatus: "UNPAID", status: "ACTIVE" }], { session });
        const [order] = await models.Order.create([{ parent: input.parentId, checkoutKey: key, items: totals.orderItems, totalAmount: totals.totalAmount, totalAmountMinor: totals.totalMinor, currency: "AUD", paymentStatus: "PENDING", shippingAddress: input.shippingAddress, status: "PENDING", invoice: invoice._id }], { session });
        const cleared = await models.Cart.updateOne({ _id: cart._id, __v: cart.__v || 0 }, { $set: { items: [], lastCheckoutKey: key }, $inc: { __v: 1 } }, { session });
        if (!cleared.matchedCount) throw fail(409, "Cart changed during checkout. Review it and try again.");
        await queueNotification(`store-order:${order._id}`, { recipientType: "ADMIN", adminId: null, title: "New Store Order", message: `${parent.fullName || "Parent"} placed a store order of $${totals.totalAmount.toFixed(2)}. Invoice ${number}.`, type: "ANNOUNCEMENT", data: { orderId: id(order), invoiceId: id(invoice), parentId: input.parentId } }, session);
        await queueNotification(`store-invoice:${invoice._id}`, { recipientType: "PARENT", parentId: input.parentId, title: "Store order placed", message: `Your order is saved. Invoice ${number} for $${totals.totalAmount.toFixed(2)} is ready.`, type: "INVOICE_CREATED", data: { orderId: id(order), invoiceId: id(invoice), parentId: input.parentId } }, session);
        result = { order, invoice, repeated: false };
      });
      return result;
    } finally { await session.endSession(); }
  };
}

module.exports = { checkout: createCheckoutService(), createCheckoutService, checkoutInput, buildCheckoutItems };
