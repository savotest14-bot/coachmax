const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const fs = require("node:fs/promises");
const path = require("node:path");
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "isolated-integration-test-key-not-a-deployed-credential-123456789";
delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
process.env.FIREBASE_SERVICE_ACCOUNT_PATH = path.join(os.tmpdir(), "coachmax-test-no-firebase.json");
const temporaryRoot = path.resolve(__dirname, "../.test-tmp");
const tempRoot = path.join(temporaryRoot, `security-upload-${process.pid}`);
let testDirectory;
process.env.UPLOAD_ROOT = tempRoot;
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");
const request = require("supertest");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const sharp = require("sharp");
const { app } = require("../server");
const Admin = require("../models/Admin");
const Parent = require("../models/Parent");
const User = require("../models/User");
const Class = require("../models/Class");
const Term = require("../models/Term");
const Program = require("../models/Program");
const Category = require("../models/Category");
const Attendance = require("../models/Attendance");
const History = require("../models/AttendanceHistory");
const MedicalProfile = require("../models/MedicalProfile");
const MedicalRevision = require("../models/MedicalRevision");
const Document = require("../models/Document");
const Invoice = require("../models/Invoice");
const { normalizeRecord } = require("../services/attendanceService");
const { validateContent } = require("../utils/upload");
const { generateClassInvoice, generateInvoiceNumber } = require("../services/invoiceService");
const DeliveryJob = require("../models/DeliveryJob");
const { queueEmail, processDeliveryJobs } = require("../services/deliveryService");
let replica;
let seq = 0;
test.before(async () => {
  await fs.mkdir(temporaryRoot, { recursive: true });
  testDirectory = await fs.mkdtemp(path.join(temporaryRoot, "security-"));
  const dbPath = path.join(testDirectory, "mongo"); await fs.mkdir(dbPath);
  replica = await MongoMemoryReplSet.create({ instanceOpts: [{ dbPath }], replSet: { count: 1, storageEngine: "wiredTiger" } });
  await mongoose.connect(replica.getUri(), { dbName: "coachmax_security_test", autoIndex: false });
  for (const Model of Object.values(mongoose.models)) { await Model.createCollection(); await Model.createIndexes(); }
}, { timeout: 180000 });
test.beforeEach(async () => { for (const Model of Object.values(mongoose.models)) await Model.deleteMany({}); });
test.after(async () => {
  await mongoose.disconnect();
  if (replica) await replica.stop();
  const resolved = path.resolve(tempRoot);
  if (resolved.startsWith(temporaryRoot + path.sep) && path.basename(resolved) === `security-upload-${process.pid}`) await fs.rm(resolved, { force: true, recursive: true });
  if (testDirectory && path.resolve(testDirectory).startsWith(temporaryRoot + path.sep) && path.basename(testDirectory).startsWith("security-")) await fs.rm(testDirectory, { recursive: true, force: true });
});
async function identity(Model, attrs) {
  seq++;
  const doc = await Model.create({ fullName: "Test household", name: "Test coach", email: `account-${seq}@example.invalid`, phone: `0400${String(seq).padStart(6, "0")}`, mobile: `0500${String(seq).padStart(6, "0")}`, emergencyContact: "Emergency", relationship: "Guardian", password: await bcrypt.hash("TestPassword12!", 4), status: "APPROVED", ...attrs });
  const token = jwt.sign({ id: String(doc._id) }, process.env.JWT_SECRET, { expiresIn: "1h" });
  doc.tokens = [token]; await doc.save(); return { doc, token };
}
async function fixture() {
  const admin = await identity(Admin, { role: "SUPER_ADMIN" });
  const coach = await identity(Admin, { role: "COACH" });
  const otherCoach = await identity(Admin, { role: "COACH" });
  const parent = await identity(Parent);
  const category = await Category.create({ name: "Academy" });
  const program = await Program.create({ name: "Development", category: category._id, ageGroup: "U11" });
  const term = await Term.create({ name: "Term 4", year: 2026, startDate: new Date("2026-01-01T00:00:00Z"), endDate: new Date("2026-12-31T00:00:00Z") });
  const players = await User.create([0, 1].map((n) => ({ firstName: "Test", lastName: String(n), fullName: `Player ${n}`, dob: new Date("2015-10-30T00:00:00Z"), parentId: parent.doc._id, playerStatus: "ACTIVE" })));
  const cls = await Class.create({ name: "U11 Development", term: term._id, category: category._id, program: program._id, coach: coach.doc._id, dayOfWeek: "Monday", capacity: 8, price: 85, players: players.map((p) => p._id) });
  return { admin, coach, otherCoach, parent, category, program, term, players, cls };
}
const auth = (person) => ({ Authorization: `Bearer ${person.token}` });
const patch = (f, extra = {}) => ({ sessionDate: "26/10/2026", playerId: String(f.players[0]._id), status: "PRESENT", ...extra });

test("parent cannot mutate admin attendance, fixtures, or read staff rosters", async () => {
  const f = await fixture();
  await request(app).post(`/api/admin/markSingleAttendance/${f.cls._id}`).set(auth(f.parent)).send(patch(f)).expect(403);
  await request(app).post(`/api/admin/fixtures/${new mongoose.Types.ObjectId()}/complete`).set(auth(f.parent)).send({ homeScore: 2, awayScore: 0 }).expect(403);
  await request(app).get("/api/admin/getAllClassesForAssign").set(auth(f.parent)).expect(403);
  assert.equal(await Attendance.countDocuments(), 0);
});
test("assigned coach can update, unrelated coach and nonmember player cannot", async () => {
  const f = await fixture();
  await request(app).post(`/api/coach/attendance/${f.cls._id}/single`).set(auth(f.otherCoach)).send(patch(f)).expect(403);
  await request(app).post(`/api/coach/attendance/${f.cls._id}/single`).set(auth(f.coach)).send(patch(f, { playerId: String(new mongoose.Types.ObjectId()) })).expect(403);
  await request(app).post(`/api/coach/attendance/${f.cls._id}/single`).set(auth(f.coach)).send(patch(f)).expect(200);
  assert.equal(await Attendance.countDocuments(), 1);
});
test("note-only edits and Clear Status preserve note and revision history", async () => {
  const f = await fixture(); const url = `/api/admin/markSingleAttendance/${f.cls._id}`;
  await request(app).post(url).set(auth(f.admin)).send(patch(f, { reason: "Great intensity" })).expect(200);
  await request(app).post(url).set(auth(f.admin)).send(patch(f, { note: "Great session" })).expect(200);
  await request(app).post(url).set(auth(f.admin)).send(patch(f, { status: "NOT_MARKED" })).expect(200);
  const record = (await Attendance.findOne()).records[0];
  assert.equal(record.status, "NOT_MARKED"); assert.equal(record.note, "Great session"); assert.equal(record.reason, "Great session");
  const history = await History.find().sort({ createdAt: 1 }); assert.equal(history.length, 3);
  assert.equal(history[1].previousNote, "Great intensity"); assert.equal(history[1].newNote, "Great session");
});
test("parallel edits on different players preserve both session records", async () => {
  const f = await fixture(); const url = `/api/admin/markSingleAttendance/${f.cls._id}`;
  await request(app).post(url).set(auth(f.admin)).send(patch(f)).expect(200);
  const responses = await Promise.all(f.players.map((player, i) => request(app).post(url).set(auth(f.admin)).send(patch(f, { playerId: String(player._id), note: `Note ${i}` }))));
  assert.deepEqual(responses.map((r) => r.status), [200, 200]);
  assert.deepEqual((await Attendance.findOne()).records.map((r) => r.note).sort(), ["Note 0", "Note 1"]);
});
test("attendance notes on an unmarked player do not invent absence", () => {
  const note = normalizeRecord({ note: "Strong passing" }); assert.equal(note.status, "NOT_MARKED");
  assert.equal(normalizeRecord({ status: "TRIAL" }).attendanceType, "TRIAL");
  assert.throws(() => normalizeRecord({ status: "INVALID" }));
});
test("reset requires an expiring one-use grant and revokes old sessions", async () => {
  const person = await identity(Parent); person.doc.otp = await bcrypt.hash("123456", 4); person.doc.otpExpire = new Date(Date.now() + 60000); await person.doc.save();
  await request(app).post("/api/auth/resetPassword").send({ userId: person.doc._id, role: "PARENT", newPassword: "NewPassword12!" }).expect(400);
  const response = await request(app).post("/api/auth/verifyOtp").send({ userId: person.doc._id, role: "PARENT", otp: "123456" }).expect(200);
  assert.match(response.body.resetToken, /^[a-f0-9]{64}$/);
  const body = { userId: person.doc._id, role: "PARENT", newPassword: "NewPassword12!", resetToken: response.body.resetToken };
  await request(app).post("/api/auth/resetPassword").send(body).expect(200);
  await request(app).post("/api/auth/resetPassword").send(body).expect(400);
  assert.equal((await Parent.findById(person.doc._id)).tokens.length, 0);
});
test("expired reset verification and fifth OTP miss are denied", async () => {
  const person = await identity(Parent); person.doc.otp = await bcrypt.hash("123456", 4); person.doc.otpExpire = new Date(Date.now() - 1); await person.doc.save();
  await request(app).post("/api/auth/verifyOtp").send({ userId: person.doc._id, role: "PARENT", otp: "123456" }).expect(400);
  person.doc.otpExpire = new Date(Date.now() + 60000); person.doc.otpAttempts = 5; await person.doc.save();
  await request(app).post("/api/auth/verifyOtp").send({ userId: person.doc._id, role: "PARENT", otp: "123456" }).expect(400);
});
test("real profile image upload validates content, preserves calendar DOB and protects failed updates", async () => {
  const f = await fixture();
  const image = await sharp({ create: { width: 256, height: 256, channels: 3, background: "blue" } }).png().toBuffer();
  const response = await request(app).put(`/api/admin/updatePlayer/${f.players[0]._id}`).set(auth(f.admin)).field("dob", "30/10/2015").attach("profileImage", image, { filename: "photo.png", contentType: "image/png" }).expect(200);
  assert.equal(response.body.data.dob, "2015-10-30"); assert.match(response.body.data.profileImage, /\.webp$/);
  const previous = response.body.data.profileImage;
  await request(app).put(`/api/admin/updatePlayer/${f.players[0]._id}`).set(auth(f.admin)).attach("profileImage", Buffer.from("this is not a png"), { filename: "photo.png", contentType: "image/png" }).expect(415);
  assert.equal((await User.findById(f.players[0]._id)).profileImage, previous);
  await fs.access(path.join(tempRoot, "profiles", path.basename(previous)));
});
test("private document download requires ownership or a short-lived file-specific link", async () => {
  const f = await fixture(); const outsider = await identity(Parent);
  const filename = "test-proof.pdf"; const relative = `uploads/documents/${filename}`;
  await fs.mkdir(path.join(tempRoot, "documents"), { recursive: true }); await fs.writeFile(path.join(tempRoot, "documents", filename), "%PDF-1.4\n%%EOF");
  await Document.create({ player: f.players[0]._id, documentType: "BIRTH_CERTIFICATE", fileUrl: relative });
  await request(app).get(`/${relative}`).expect(401);
  await request(app).get("/api/auth/media-link").query({ path: relative }).set(auth(outsider)).expect(403);
  const grant = await request(app).get("/api/auth/media-link").query({ path: relative }).set(auth(f.parent)).expect(200);
  await request(app).get(grant.body.url).expect(200);
  await request(app).get(grant.body.url.replace(filename, "other.pdf")).expect(401);
});
test("server rejects SVG, spoofed files and invalid image sizes", async () => {
  await assert.rejects(validateContent(Buffer.from("<svg/>"), "image/svg+xml", "profileImage"), /supported file type/);
  await assert.rejects(validateContent(Buffer.from("%PDF-1.4"), "image/png", "profileImage"), /supported file type/);
  await assert.rejects(validateContent(Buffer.alloc(5 * 1024 * 1024 + 1), "image/png", "profileImage"), /smaller/);
});
test("concurrent billing for different enrollments produces unique invoice numbers", async () => {
  const f = await fixture();
  const numbers = await Promise.all(Array.from({ length: 8 }, () => generateInvoiceNumber())); assert.equal(new Set(numbers).size, 8);
  const bills = await Promise.all(f.players.map((player) => generateClassInvoice({ userId: player._id, classId: f.cls._id })));
  assert.equal(new Set(bills.map((b) => b.invoice.invoiceNumber)).size, 2); assert.equal(await Invoice.countDocuments(), 2);
});

test("staff and parent password changes require current proof and revoke other sessions", async () => {
  for (const Model of [Parent, Admin]) {
    const person = await identity(Model, Model === Admin ? { role: "SUPER_ADMIN" } : {});
    person.doc.tokens.push("other-session"); await person.doc.save();
    await request(app).post("/api/auth/changePassword").set(auth(person)).send({ oldPassword: "wrong", newPassword: "NewPassword12!" }).expect(400);
    await request(app).post("/api/auth/changePassword").set(auth(person)).send({ oldPassword: "TestPassword12!", newPassword: "short" }).expect(400);
    await request(app).post("/api/auth/changePassword").set(auth(person)).send({ oldPassword: "TestPassword12!", newPassword: "NewPassword12!" }).expect(200);
    const saved = await Model.findById(person.doc._id);
    assert.deepEqual([...saved.tokens], [person.token]); assert.equal(await bcrypt.compare("NewPassword12!", saved.password), true);
  }
});

test("class transfer and its additional charge roll back together on billing failure", async () => {
  const f = await fixture(); const player = f.players[0];
  player.assignedClasses = [f.cls._id]; await player.save();
  const target = await Class.create({ name: "U11 Elite", term: f.term._id, category: f.category._id, program: f.program._id, coach: f.coach.doc._id, dayOfWeek: "Monday", price: 120, capacity: 8 });
  // Removing the household emulates an invalid billing dependency, without mocks.
  await Parent.deleteOne({ _id: f.parent.doc._id });
  const payload = { userId: String(player._id), fromClassId: String(f.cls._id), toClassId: String(target._id) };
  await request(app).post("/api/admin/transferClass").set(auth(f.admin)).send(payload).expect(422);
  assert.equal((await Class.findById(f.cls._id)).players.some((id) => String(id) === String(player._id)), true);
  assert.equal((await Class.findById(target._id)).players.length, 0);
  assert.equal(await Invoice.countDocuments(), 0);
  await Parent.create({ ...f.parent.doc.toObject(), _id: f.parent.doc._id });
  await request(app).post("/api/admin/transferClass").set(auth(f.admin)).send(payload).expect(200);
  assert.equal((await Invoice.findOne()).totalAmount, 35);
  assert.equal((await Class.findById(target._id)).players.length, 1);
});

test("durable email delivery retries rejection and keeps intent idempotent", async () => {
  const payload = { to: "test@example.invalid", subject: "Account setup", html: "Use Forgot Password" };
  await queueEmail("test-email", payload); await queueEmail("test-email", payload);
  assert.equal(await DeliveryJob.countDocuments(), 1);
  await processDeliveryJobs({ sendEmailFn: async () => false });
  let job = await DeliveryJob.findOne(); assert.equal(job.status, "PENDING"); assert.equal(job.attempts, 1);
  assert.equal(job.lastError, "Delivery failed");
  await DeliveryJob.updateOne({ _id: job._id }, { nextAttempt: new Date(0) });
  let delivered = 0;
  await processDeliveryJobs({ sendEmailFn: async (to, subject, html) => { assert.equal(to, payload.to); assert.equal(html, payload.html); delivered++; return true; } });
  job = await DeliveryJob.findOne(); assert.equal(job.status, "SENT"); assert.equal(job.attempts, 2);
  await processDeliveryJobs({ sendEmailFn: async () => { delivered++; return true; } });
  assert.equal(delivered, 1);
});

test("unrelated coaches cannot inspect another coach roster, player, note audit or assessments", async () => {
  const f = await fixture();
  await request(app).get(`/api/coach/unique-players/${f.coach.doc._id}`).set(auth(f.otherCoach)).expect(403);
  await request(app).get(`/api/coach/player/${f.players[0]._id}`).set(auth(f.otherCoach)).expect(403);
  await request(app).get(`/api/coach/attendance/${f.cls._id}`).set(auth(f.otherCoach)).expect(403);
  await request(app).get("/api/coach/getClasses").set(auth(f.parent)).expect(403);
  await request(app).post("/api/admin/assessments").set(auth(f.otherCoach)).send({ player: String(f.players[0]._id), overallRating: 4 }).expect(403);
  const note = await require("../models/CoachNote").create({ coach: f.coach.doc._id, player: f.players[0]._id, noteType: "POSITIVE_PERFORMANCE", description: "Great session" });
  await request(app).get(`/api/coach/notes/${note._id}/audit`).set(auth(f.otherCoach)).expect(403);
});

test("expired event completion preserves registration history and the inclusive last day", async () => {
  const f = await fixture(); const Event = require("../models/Event"), Registration = require("../models/EventRegistration");
  const previous = await Event.create({ title: "Finished camp", startDate: new Date("2026-10-20"), endDate: new Date("2026-10-25"), status: "UPCOMING" });
  const lastDay = await Event.create({ title: "Last day camp", startDate: new Date("2026-10-20"), endDate: new Date("2026-10-26"), status: "UPCOMING" });
  const registration = await Registration.create({ user: f.players[0]._id, event: previous._id });
  await require("../services/cronService").completeExpiredEvents(new Date("2026-10-26T00:30:00Z"));
  assert.equal((await Event.findById(previous._id)).status, "COMPLETED");
  assert.equal((await Event.findById(lastDay._id)).status, "UPCOMING");
  assert.ok(await Registration.findById(registration._id)); assert.equal(await Event.countDocuments(), 2);
});

test("term date edits preserve recorded sessions and attendance exports show slash dates", async () => {
  const f = await fixture();
  await request(app).post(`/api/admin/markSingleAttendance/${f.cls._id}`).set(auth(f.admin)).send(patch(f)).expect(200);
  await request(app).put(`/api/admin/updateTerm/${f.term._id}`).set(auth(f.admin)).send({ endDate: "25/10/2026" }).expect(409);
  await request(app).put(`/api/admin/updateTerm/${f.term._id}`).set(auth(f.admin)).send({ name: "Term 4 updated" }).expect(200);
  const csv = await request(app).get("/api/admin/exportClassCSV").query({ classId: String(f.cls._id) }).set(auth(f.admin)).expect(200);
  assert.match(csv.text, /30\/10\/2015/); assert.match(csv.text, /26\/10\/2026/); assert.match(csv.text, /"Payment Status"/);
  assert.match(csv.text, /"TRIAL"/);
});
