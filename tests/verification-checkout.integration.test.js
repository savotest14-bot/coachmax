const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
// Never read application .env or configured credentials, never deliver jobs.
delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
process.env.FIREBASE_SERVICE_ACCOUNT_PATH = path.join(os.tmpdir(), "coachmax-test-no-firebase-credentials.json");
process.env.JWT_SECRET = "isolated-verification-review-signing-key-not-for-deployment-123456789";
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");
const User = require("../models/User");
const Parent = require("../models/Parent");
const Class = require("../models/Class");
const Term = require("../models/Term");
const Program = require("../models/Program");
const Category = require("../models/Category");
const RegistrationRequest = require("../models/RegistrationRequest");
const AuditLog = require("../models/AuditLog");
const Invoice = require("../models/Invoice");
const Counter = require("../models/Counter");
const DeliveryJob = require("../models/DeliveryJob");
const Product = require("../models/Product");
const Cart = require("../models/Cart");
const Order = require("../models/Order");
const MedicalProfile = require("../models/MedicalProfile");
const MedicalRevision = require("../models/MedicalRevision");
const { updateMedicalProfile, getMedicalProfile } = require("../controllers/medicalController");
const { reconcileVerification } = require("../scripts/reconcileVerification");
const { getRegistrationRequests } = require("../controllers/registrationRequestController");
const Attendance = require("../models/Attendance");
const AttendanceHistory = require("../models/AttendanceHistory");
const { updateAttendance } = require("../services/attendanceService");
const { getMyClasses } = require("../controllers/userController");
const { generateInvoiceNumber, generateClassInvoice, generateTransferInvoice } = require("../services/invoiceService");
const { todayDateOnly } = require("../utils/dateTime");
const ChatRoom = require("../models/ChatRoom");
const Message = require("../models/Message");
const { canReadMedia } = require("../middleware/privateMedia");
const { enrollPlayer } = require("../services/enrollmentService");
const { checkout, createCheckoutService } = require("../services/checkoutService");
const allModels = [User, Parent, Class, Term, Program, Category, RegistrationRequest, AuditLog, Invoice, Counter, DeliveryJob, Product, Cart, Order, MedicalProfile, MedicalRevision, Attendance, AttendanceHistory, ChatRoom, Message];
let replica;
let testDbPath;
const testTempRoot = path.resolve(__dirname, "../.test-tmp");
let sequence = 0;
const actor = { _id: new mongoose.Types.ObjectId(), role: "SUPER_ADMIN" };

test.before(async () => {
  fs.mkdirSync(testTempRoot, { recursive: true });
  testDbPath = fs.mkdtempSync(path.join(testTempRoot, "verification-checkout-"));
  replica = await MongoMemoryReplSet.create({ instanceOpts: [{ dbPath: testDbPath }], replSet: { count: 1, storageEngine: "wiredTiger" } });
  // URI comes only from this newly-created local replica set.
  await mongoose.connect(replica.getUri(), { dbName: "verification_checkout_test", autoIndex: false });
  for (const Model of allModels) { await Model.createCollection(); await Model.createIndexes(); }
}, { timeout: 180000 });
test.beforeEach(async () => { for (const Model of allModels) await Model.deleteMany({}); });
test.after(async () => {
  await mongoose.disconnect();
  if (replica) await replica.stop();
  if (testDbPath) {
    const target = path.resolve(testDbPath);
    if (!target.startsWith(`${testTempRoot}${path.sep}`)) throw new Error("Refusing to clean up outside the test temporary directory");
    fs.rmSync(target, { recursive: true, force: true });
  }
});

async function parent() {
  sequence += 1;
  return Parent.create({ fullName: `Test household ${sequence}`, email: `parent${sequence}@example.invalid`, phone: `040000${String(sequence).padStart(4, "0")}`, password: "test-hash-no-login", emergencyContact: "0411111111", relationship: "Parent", status: "APPROVED" });
}
async function enrollmentFixture({ twoPlayers = false } = {}) {
  const household = await parent();
  const category = await Category.create({ name: `Academy ${sequence}` });
  const program = await Program.create({ name: "Development", category: category._id, ageGroup: "U12", status: "ACTIVE" });
  const term = await Term.create({ name: "Term 1", year: 2027, startDate: new Date("2027-01-01T00:00:00Z"), endDate: new Date("2099-12-31T00:00:00Z"), status: "UPCOMING" });
  const cls = await Class.create({ name: "U12 Academy", term: term._id, category: category._id, program: program._id, dayOfWeek: "Monday", capacity: 1, price: 100, status: "ACTIVE" });
  const players = await User.create(Array.from({ length: twoPlayers ? 2 : 1 }, (_, index) => ({ fullName: `Player ${index}`, dob: new Date("2015-10-30T00:00:00Z"), gender: "MALE", parentId: household._id, playerStatus: "PENDING_APPROVAL", hasPendingRequest: true })));
  const requests = await RegistrationRequest.create(players.map((player, index) => ({ parent: household._id, player: player._id, category: category._id, programs: [program._id], preferredTerm: term._id, preferredClasses: [cls._id], requestType: index ? "NEW_PLAYER" : "TEMPORARY_PLAYER", status: "PENDING" })));
  const command = (index = 0) => ({ playerId: String(players[index]._id), registrationRequestId: String(requests[index]._id), classIds: [String(cls._id)], paymentStatus: "UNPAID" });
  return { household, category, program, term, cls, players, requests, command };
}

test("real transactions serialize the last class place, one invoice and one request approval", async () => {
  const f = await enrollmentFixture({ twoPlayers: true });
  const outcomes = await Promise.allSettled([enrollPlayer(f.command(0), actor), enrollPlayer(f.command(1), actor)]);
  const accepted = outcomes.filter((outcome) => outcome.status === "fulfilled");
  assert.equal(accepted.length, 1);
  const rejection = outcomes.find((outcome) => outcome.status === "rejected");
  assert.match(rejection.reason.message, /full/);
  assert.equal((await Class.findById(f.cls._id)).players.length, 1);
  assert.equal(await Invoice.countDocuments(), 1);
  assert.equal(await RegistrationRequest.countDocuments({ status: "APPROVED" }), 1);
  assert.equal(await RegistrationRequest.countDocuments({ status: "PENDING" }), 1);
  assert.equal(await User.countDocuments({ playerStatus: "ACTIVE" }), 1);
  assert.equal(await DeliveryJob.countDocuments({ status: "PENDING" }), 2);
});

test("concurrent duplicate allocation converges to one charge and preserves other pending requests", async () => {
  const f = await enrollmentFixture();
  const additional = await RegistrationRequest.create({ parent: f.household._id, player: f.players[0]._id, category: f.category._id, programs: [f.program._id], requestType: "ADD_PROGRAM", status: "PENDING" });
  const outcomes = await Promise.all([enrollPlayer(f.command(), actor), enrollPlayer(f.command(), actor)]);
  assert.equal(outcomes.filter((outcome) => outcome.repeated).length, 1);
  assert.equal(await Invoice.countDocuments(), 1);
  assert.equal((await RegistrationRequest.findById(additional._id)).status, "PENDING");
  const player = await User.findById(f.players[0]._id);
  assert.equal(player.hasPendingRequest, true);
  assert.equal(player.assignedClasses.length, 1);
  assert.equal(player.classPaymentStatuses.length, 1);
  assert.equal(await AuditLog.countDocuments({ action: "PLAYER_ALLOCATED" }), 1);
});

test("unified queue keeps a second pending request for an active player and filters selected-term U groups and medical NO", async () => {
  const f = await enrollmentFixture();
  await enrollPlayer(f.command(), actor);
  const second = await RegistrationRequest.create({ parent: f.household._id, player: f.players[0]._id, category: f.category._id, programs: [f.program._id], preferredTerm: f.term._id, requestType: "ADD_PROGRAM", status: "PENDING" });
  const listed = response();
  await getRegistrationRequests({ query: { term: String(f.term._id), ageGroup: "U11-U12", isMedicalCondition: "false" } }, listed);
  assert.equal(listed.statusCode, 200);
  assert.equal(listed.body.total, 1);
  assert.equal(String(listed.body.data[0]._id), String(second._id));
  assert.equal(listed.body.data[0].player.dob, "2015-10-30");
  const invalidTerm = response(); await getRegistrationRequests({ query: { term: "invalid" } }, invalidTerm);
  assert.equal(invalidTerm.statusCode, 400);
  const missingTerm = response(); await getRegistrationRequests({ query: { term: String(new mongoose.Types.ObjectId()) } }, missingTerm);
  assert.equal(missingTerm.statusCode, 404);
});

async function storeFixture({ twoParents = false } = {}) {
  const parents = [await parent()];
  if (twoParents) parents.push(await parent());
  const product = await Product.create({ name: "Training ball", category: new mongoose.Types.ObjectId(), price: 19.99, stock: 1, status: "ACTIVE", availabilityStatus: "IN_STOCK" });
  await Cart.create(parents.map((household) => ({ parent: household._id, items: [{ product: product._id, quantity: 1 }] })));
  const command = (index = 0) => ({ parentId: String(parents[index]._id), shippingAddress: "10 Example Street", idempotencyKey: `checkout-real-${index}` });
  return { parents, product, command };
}

test("real checkout concurrency cannot sell the last stock unit twice", async () => {
  const f = await storeFixture({ twoParents: true });
  const outcomes = await Promise.allSettled([checkout(f.command(0)), checkout(f.command(1))]);
  assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
  assert.match(outcomes.find((outcome) => outcome.status === "rejected").reason.message, /stock/i);
  assert.equal((await Product.findById(f.product._id)).stock, 0);
  assert.equal(await Order.countDocuments(), 1);
  assert.equal(await Invoice.countDocuments(), 1);
  assert.equal(await Cart.countDocuments({ "items.0": { $exists: true } }), 1);
  assert.equal(await DeliveryJob.countDocuments(), 2);
});

test("real simultaneous checkout retries produce the same order and invoice", async () => {
  const f = await storeFixture();
  const outcomes = await Promise.all([checkout(f.command()), checkout(f.command())]);
  assert.equal(String(outcomes[0].order._id), String(outcomes[1].order._id));
  assert.equal(await Order.countDocuments(), 1);
  assert.equal(await Invoice.countDocuments(), 1);
  assert.equal((await Product.findById(f.product._id)).stock, 0);
  const legacyRetry = await checkout({ ...f.command(), idempotencyKey: undefined });
  assert.equal(legacyRetry.repeated, true);
  assert.equal(String(legacyRetry.order._id), String(outcomes[0].order._id));
});

test("real checkout rolls back stock, invoice, order and cart if outbox write fails", async () => {
  const f = await storeFixture();
  const failedCheckout = createCheckoutService({ queueNotification: async () => { throw new Error("Simulated outbox failure"); } });
  await assert.rejects(failedCheckout(f.command()), /Simulated outbox failure/);
  assert.equal((await Product.findById(f.product._id)).stock, 1);
  assert.equal(await Order.countDocuments(), 0);
  assert.equal(await Invoice.countDocuments(), 0);
  assert.equal((await Cart.findOne({ parent: f.parents[0]._id })).items.length, 1);
  assert.equal(await Counter.countDocuments(), 0);
});

test("real empty-cart rejection ends its session and permits a subsequent valid checkout", async () => {
  const household = await parent();
  await Cart.create({ parent: household._id, items: [] });
  await assert.rejects(checkout({ parentId: String(household._id), shippingAddress: "10 Example Street", idempotencyKey: "empty-cart-real" }), /empty/);
  const product = await Product.create({ name: "Ball", category: new mongoose.Types.ObjectId(), price: 0.1, stock: 3 });
  await Cart.updateOne({ parent: household._id }, { $set: { items: [{ product: product._id, quantity: 3 }] } });
  const result = await checkout({ parentId: String(household._id), shippingAddress: "10 Example Street", idempotencyKey: "valid-cart-real" });
  assert.equal(result.order.totalAmount, 0.3);
  assert.equal(result.order.totalAmountMinor, 30);
  assert.equal(await Order.countDocuments(), 1);
});

const response = () => ({ statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });

test("medical updates atomically synchronize User alerts and restricted profile history; unauthorized households are denied", async () => {
  const household = await parent();
  const player = await User.create({ fullName: "Medical test", parentId: household._id, dob: new Date("2015-10-30T00:00:00Z") });
  const request = { params: { playerId: String(player._id) }, parent: household, role: "PARENT", body: { isMedicalCondition: true, medicalConditions: "Asthma", allergies: ["Peanuts"] } };
  const saved = response(); await updateMedicalProfile(request, saved);
  assert.equal(saved.statusCode, 200);
  assert.equal((await User.findById(player._id)).isMedicalCondition, true);
  assert.match((await User.findById(player._id)).medicalConditionDetails, /Peanuts/);
  assert.equal(await MedicalRevision.countDocuments({ player: player._id }), 1);
  const unsafe = response(); await updateMedicalProfile({ ...request, body: { isMedicalCondition: false } }, unsafe);
  assert.equal(unsafe.statusCode, 400);
  assert.equal((await User.findById(player._id)).isMedicalCondition, true);
  const cleared = response(); await updateMedicalProfile({ ...request, body: { isMedicalCondition: false, medicalConditions: "None", allergies: [] } }, cleared);
  assert.equal(cleared.statusCode, 200);
  assert.equal((await User.findById(player._id)).isMedicalCondition, false);
  const otherHousehold = await parent();
  const denied = response(); await getMedicalProfile({ ...request, parent: otherHousehold }, denied);
  assert.equal(denied.statusCode, 403);
  assert.equal(await MedicalRevision.countDocuments({ player: player._id }), 2);
});

test("verification/medical repair is dry-run by default and only clears unambiguous negative alerts", async () => {
  const household = await parent();
  const negative = await User.create({ fullName: "Legacy none", parentId: household._id, isMedicalCondition: true, medicalConditionDetails: "No medical conditions", playerStatus: "PENDING_APPROVAL", temporaryClass: new mongoose.Types.ObjectId(), createdByRole: "COACH" });
  const known = await User.create({ fullName: "Legacy allergy", parentId: household._id, isMedicalCondition: true, medicalConditionDetails: "None" });
  await MedicalProfile.create({ player: known._id, allergies: ["Peanuts"] });
  const missingAlert = await User.create({ fullName: "Hidden legacy allergy", parentId: household._id, isMedicalCondition: false });
  await MedicalProfile.create({ player: missingAlert._id, allergies: ["Bee stings"] });
  const dry = await reconcileVerification();
  assert.deepEqual(dry.orphanRequests, [String(negative._id)]);
  assert.deepEqual(dry.clearNegativeAlerts, [String(negative._id)]);
  assert.ok(dry.needsReview.includes(String(known._id)));
  assert.deepEqual(dry.setKnownAlerts, [String(missingAlert._id)]);
  assert.equal(await RegistrationRequest.countDocuments(), 0);
  assert.equal((await User.findById(negative._id)).isMedicalCondition, true);
  await reconcileVerification({ apply: true, actorId: String(actor._id) });
  assert.equal(await RegistrationRequest.countDocuments({ player: negative._id }), 1);
  assert.equal((await User.findById(negative._id)).isMedicalCondition, false);
  assert.equal((await User.findById(known._id)).isMedicalCondition, true);
  assert.equal((await User.findById(missingAlert._id)).isMedicalCondition, true);
  await reconcileVerification({ apply: true, actorId: String(actor._id) });
  assert.equal(await RegistrationRequest.countDocuments({ player: negative._id }), 1);
});

test("first-ever concurrent session saves retain two different players", async () => {
  const f = await enrollmentFixture({ twoPlayers: true });
  await Class.updateOne({ _id: f.cls._id }, { $set: { players: f.players.map((player) => player._id) } });
  const req = { admin: actor, params: { classId: String(f.cls._id) }, body: { sessionDate: "2027-01-04" }, headers: {} };
  await Promise.all(f.players.map((player) => updateAttendance(req, "class", [{ player: String(player._id), status: "PRESENT" }])));
  assert.equal(await Attendance.countDocuments(), 1);
  assert.equal((await Attendance.findOne()).records.length, 2);
  assert.equal(await AttendanceHistory.countDocuments(), 2);
});

test("parent class schedules show parent absence reason and never staff-only notes", async () => {
  const f = await enrollmentFixture();
  await Term.updateOne({ _id: f.term._id }, { $set: { endDate: new Date("2027-01-31T00:00:00Z") } });
  await Class.updateOne({ _id: f.cls._id }, { $set: { players: [f.players[0]._id] } });
  await User.updateOne({ _id: f.players[0]._id }, { $set: { assignedClasses: [f.cls._id] } });
  await Attendance.create({ class: f.cls._id, sessionDate: new Date("2027-01-04T00:00:00Z"), records: [{ player: f.players[0]._id, status: "ABSENT", reason: "Sick", markedByParent: true }] });
  await updateAttendance({ admin: actor, params: { classId: String(f.cls._id) }, body: { sessionDate: "2027-01-04" }, headers: {} }, "class", [{ player: String(f.players[0]._id), note: "Private staff observation" }]);
  const result = response();
  await getMyClasses({ parent: f.household, params: {}, query: { playerId: String(f.players[0]._id) } }, result);
  assert.equal(result.statusCode, 200);
  assert.doesNotMatch(JSON.stringify(result.body), /Private staff observation/);
  assert.equal(result.body.data[0].sessions.find((session) => session.date === "2027-01-04").reason, "Sick");
});

test("invoice counter seeds numerically across sequence digit widths and creates distinct transfer charges", async () => {
  const f = await enrollmentFixture();
  const year = Number(todayDateOnly().slice(0, 4));
  await Invoice.create([999999, 1000000].map((suffix) => ({ invoiceNumber: `INV-${year}-${suffix}`, parent: f.household._id, totalAmount: 10, amount: 10, dueDate: new Date("2027-01-01T00:00:00Z"), type: "CUSTOM" })));
  assert.equal(await generateInvoiceNumber(), `INV-${year}-1000001`);
  const ordinary = await generateClassInvoice({ userId: f.players[0]._id, classId: f.cls._id });
  const transfer = await generateTransferInvoice({ userId: f.players[0]._id, fromClass: { _id: new mongoose.Types.ObjectId(), name: "Previous class", price: 25 }, toClass: { ...f.cls.toObject(), price: 100 } });
  assert.notEqual(String(transfer.invoice._id), String(ordinary.invoice._id));
  assert.equal(transfer.priceDiff, 75);
  assert.equal(transfer.invoice.totalAmount, 75);
});

test("fresh concurrent invoice charges initialize one counter without duplicate invoice numbers", async () => {
  const f = await enrollmentFixture({ twoPlayers: true });
  const invoices = await Promise.all(f.players.map((player) => generateClassInvoice({ userId: player._id, classId: f.cls._id })));
  assert.equal(new Set(invoices.map((item) => item.invoice.invoiceNumber)).size, 2);
  assert.equal(await Invoice.countDocuments(), 2);
});

test("requesting a new OTP invalidates every previous reset grant without delivering external email", async () => {
  const household = await parent();
  await Parent.updateOne({ _id: household._id }, { $set: { resetTokenHash: "previous-grant-hash", resetTokenExpire: new Date(Date.now() + 60000) } });
  const nodemailer = require("nodemailer");
  const fakeTransport = test.mock.method(nodemailer, "createTransport", () => ({ sendMail: async () => ({ messageId: "isolated-test" }) }));
  try {
    const { forgotPassword } = require("../controllers/authController");
    const result = response();
    await forgotPassword({ body: { role: "PARENT", email: household.email } }, result, (error) => { throw error; });
    assert.equal(result.statusCode, 200);
    const account = await Parent.findById(household._id).select("+resetTokenHash +resetTokenExpire");
    assert.equal(account.resetTokenHash, undefined);
    assert.equal(account.resetTokenExpire, undefined);
  } finally { fakeTransport.mock.restore(); }
});

test("temporary onboarding queues password setup with no reusable credential and preserves existing household passwords", async () => {
  const f = await enrollmentFixture();
  const previousAppUrl = process.env.PARENT_APP_URL;
  process.env.PARENT_APP_URL = "https://parent.example.invalid";
  try {
    const { createTemporaryPlayer } = require("../controllers/temporaryPlayerController");
    const body = { name: "Temporary trial", dob: "2015-10-30", parentName: "Invited household", parentEmail: "invited@example.invalid", parentPhone: "0400999999", emergencyContact: "0411111111", classId: String(f.cls._id), sessionDate: "2027-01-04", isMedicalCondition: false };
    const result = response();
    await createTemporaryPlayer({ body, admin: { ...actor, name: "Test administrator" }, headers: {} }, result);
    assert.equal(result.statusCode, 201);
    assert.equal(result.body.emailQueued, true);
    assert.equal(result.body.data.tempPasswordGenerated, false);
    const email = await DeliveryJob.findOne({ kind: "EMAIL" });
    assert.ok(email);
    assert.match(email.payload.html, /forgot-password\?role=PARENT/);
    assert.doesNotMatch(email.payload.html, /Temporary password|Password<\/b>/i);
    assert.equal(email.status, "PENDING");
    const existing = response();
    await createTemporaryPlayer({ body: { ...body, name: "Sibling trial", parentEmail: f.household.email, parentPhone: f.household.phone }, admin: actor, headers: {} }, existing);
    assert.equal(existing.statusCode, 201);
    assert.equal((await Parent.findById(f.household._id)).password, f.household.password);
    assert.equal(existing.body.data.isNewAccount, false);
  } finally { if (previousAppUrl === undefined) delete process.env.PARENT_APP_URL; else process.env.PARENT_APP_URL = previousAppUrl; }
});

test("forwarded chat attachments are readable in the authorized destination room only", async () => {
  const sender = await parent(); const recipient = await parent(); const unrelated = await parent();
  const original = await ChatRoom.create({ members: [{ refModel: "Parent", user: sender._id }] });
  const forwarded = await ChatRoom.create({ members: [sender, recipient].map((household) => ({ refModel: "Parent", user: household._id })) });
  const file = "uploads/chat/forwarded-test.pdf";
  await Message.create([original, forwarded].map((room) => ({ room: room._id, sender: { refModel: "Parent", user: sender._id }, attachments: [{ fileType: "FILE", url: file }] })));
  assert.equal(await canReadMedia({ parent: recipient }, file), true);
  assert.equal(await canReadMedia({ parent: unrelated }, file), false);
});
