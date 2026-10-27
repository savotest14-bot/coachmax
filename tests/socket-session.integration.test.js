const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const http = require("node:http");
const os = require("node:os");
const jwt = require("jsonwebtoken");
const { io: clientIO } = require("socket.io-client");
const { MongoMemoryReplSet } = require("mongodb-memory-server");
const mongoose = require("mongoose");
const sharp = require("sharp");

// Local disposable database, local HTTP listener, generated credentials and media only.
// Never load application .env, delivery workers or externally configured services.
const temporaryRoot = path.resolve(__dirname, "../.test-tmp");
const uploadRoot = path.join(temporaryRoot, `socket-uploads-${process.pid}`);
process.env.UPLOAD_ROOT = uploadRoot;
process.env.JWT_SECRET = "isolated-socket-test-secret-which-is-never-used-for-real-accounts";
delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
process.env.FIREBASE_SERVICE_ACCOUNT_PATH = path.join(os.tmpdir(), "coachmax-socket-test-no-firebase.json");
mongoose.set("autoIndex", false);
mongoose.set("autoCreate", false);
const Admin = require("../models/Admin");
const Parent = require("../models/Parent");
const ChatRoom = require("../models/ChatRoom");
const Message = require("../models/Message");
const Notification = require("../models/Notification");
const { initSocket, closeSocket, isUserOnline } = require("../sockets/chatSocket");
let replica, server, socketServer, baseUrl, databaseDirectory;
let sequence = 0;
const clients = new Set();

test.before(async () => {
  await fs.mkdir(temporaryRoot, { recursive: true });
  databaseDirectory = await fs.mkdtemp(path.join(temporaryRoot, "socket-database-"));
  const dbPath = path.join(databaseDirectory, "mongo");
  await fs.mkdir(dbPath);
  replica = await MongoMemoryReplSet.create({ instanceOpts: [{ dbPath }], replSet: { count: 1, storageEngine: "wiredTiger" } });
  await mongoose.connect(replica.getUri(), { dbName: "socket_session_test", autoIndex: false, autoCreate: false });
  for (const Model of [Admin, Parent, ChatRoom, Message, Notification]) { await Model.createCollection(); await Model.createIndexes(); }
  server = http.createServer((_request, response) => response.end("isolated socket test"));
  socketServer = initSocket(server, { sessionCheckIntervalMs: 100 });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}, { timeout: 180000 });

test.beforeEach(async () => {
  for (const socket of clients) socket.disconnect();
  clients.clear();
  socketServer.disconnectSockets(true);
  for (const Model of [Admin, Parent, ChatRoom, Message, Notification]) await Model.deleteMany({});
});
test.after(async () => {
  for (const socket of clients) socket.disconnect();
  await closeSocket();
  await mongoose.disconnect();
  if (replica) await replica.stop();
  if (databaseDirectory && databaseDirectory.startsWith(temporaryRoot + path.sep) && path.basename(databaseDirectory).startsWith("socket-database-")) await fs.rm(databaseDirectory, { recursive: true, force: true });
  if (uploadRoot.startsWith(temporaryRoot + path.sep) && path.basename(uploadRoot) === `socket-uploads-${process.pid}`) await fs.rm(uploadRoot, { recursive: true, force: true });
});

const eventually = async (predicate, timeout = 2500) => {
  const deadline = Date.now() + timeout;
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for socket state.");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

async function account(model = Admin, expiresIn = "10m") {
  sequence += 1;
  const identity = model === Admin
    ? await Admin.create({ name: `Coach ${sequence}`, email: `coach${sequence}@example.invalid`, mobile: `040000${String(sequence).padStart(4, "0")}`, password: "not-a-real-login-hash", role: "COACH" })
    : await Parent.create({ fullName: `Parent ${sequence}`, email: `parent${sequence}@example.invalid`, phone: `050000${String(sequence).padStart(4, "0")}`, password: "not-a-real-login-hash", status: "APPROVED", emergencyContact: "0411111111", relationship: "Parent" });
  const token = jwt.sign({ id: String(identity._id) }, process.env.JWT_SECRET, { expiresIn });
  await model.updateOne({ _id: identity._id }, { $set: { tokens: [token] } });
  return { identity, token, model, refModel: model === Admin ? "Admin" : "Parent" };
}

async function connect(token) {
  const socket = clientIO(baseUrl, { auth: { token }, transports: ["websocket"], reconnection: false, forceNew: true, autoConnect: false });
  clients.add(socket);
  await new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("connect_error", reject); socket.connect(); });
  return socket;
}
const emit = (socket, name, data) => socket.timeout(2500).emitWithAck(name, data);
const ownRoom = (user) => ChatRoom.create({ type: "DIRECT", members: [{ refModel: user.refModel, user: user.identity._id }] });

test("live sockets validate membership and cannot access administrator sidebar data", async () => {
  const owner = await account(), unrelated = await account();
  const room = await ownRoom(owner);
  const socket = await connect(unrelated.token);
  assert.equal((await emit(socket, "join_room", { roomId: String(room._id) })).success, false);
  assert.equal((await emit(socket, "send_message", { roomId: String(room._id), text: "Denied" })).success, false);
  assert.equal((await emit(socket, "mark_read", { roomId: String(room._id) })).success, false);
  const badges = await socket.timeout(2500).emitWithAck("get_sidebar_badges");
  assert.equal(badges.success, false);
  assert.equal(await Message.countDocuments(), 0);
});

test("logout or password-reset token revocation disconnects an established socket and prevents further writes", async () => {
  const user = await account();
  const room = await ownRoom(user);
  const socket = await connect(user.token);
  assert.equal((await emit(socket, "send_message", { roomId: String(room._id), text: "Before revocation" })).success, true);
  await Admin.updateOne({ _id: user.identity._id }, { $set: { tokens: [] } });
  const attempted = socket.connected ? emit(socket, "send_message", { roomId: String(room._id), text: "After revocation" }).catch(() => null) : Promise.resolve(null);
  await eventually(() => !socket.connected);
  const result = await attempted;
  if (result) assert.equal(result.success, false);
  assert.equal(await Message.countDocuments(), 1);
  assert.equal(isUserOnline(user.identity._id), false);
  await assert.rejects(connect(user.token), /Session expired or revoked/);
});

test("inactive staff and blocked/unapproved parents lose idle socket access without sending another packet", async () => {
  for (const [model, patch] of [[Admin, { isActive: false }], [Parent, { isBlocked: true }], [Parent, { status: "REJECTED" }]]) {
    const user = await account(model);
    const socket = await connect(user.token);
    await model.updateOne({ _id: user.identity._id }, { $set: patch });
    await eventually(() => !socket.connected);
    assert.equal(isUserOnline(user.identity._id), false);
  }
});

test("JWT expiry disconnects an idle established socket even while its token remains stored", async () => {
  const user = await account(Admin, "2s");
  const socket = await connect(user.token);
  await eventually(() => !socket.connected, 3500);
  assert.ok((await Admin.findById(user.identity._id)).tokens.includes(user.token));
  assert.equal(isUserOnline(user.identity._id), false);
});

test("failed socket sends remove only newly uploaded files while preserving forwarded and committed attachments", async () => {
  const user = await account();
  const room = await ownRoom(user);
  const socket = await connect(user.token);
  const image = await sharp({ create: { width: 2, height: 2, channels: 4, background: "#123456" } }).png().toBuffer();
  const saved = await emit(socket, "send_message", { roomId: String(room._id), attachments: [{ buffer: image }] });
  assert.equal(saved.success, true);
  const sharedUrl = saved.data.attachments[0].url;
  const directory = path.join(uploadRoot, "chat");
  const originalFiles = await fs.readdir(directory);
  const originalCreate = Message.create;
  try {
    Message.create = async () => { throw new Error("Simulated message database rejection"); };
    const failed = await emit(socket, "send_message", { roomId: String(room._id), attachments: [{ url: sharedUrl, fileType: "IMAGE" }, { buffer: image }] });
    assert.equal(failed.success, false);
    assert.deepEqual(await fs.readdir(directory), originalFiles);
    assert.equal(await Message.countDocuments(), 1);
    Message.create = async (...args) => { await originalCreate.apply(Message, args); throw new Error("Simulated lost response after commit"); };
    const unknown = await emit(socket, "send_message", { roomId: String(room._id), attachments: [{ buffer: image }] });
    assert.equal(unknown.success, false);
    assert.equal(await Message.countDocuments(), 2);
    assert.equal((await fs.readdir(directory)).length, originalFiles.length + 1, "A persisted message must keep its file even if the response was lost.");
  } finally { Message.create = originalCreate; }
  const beforeInvalid = await fs.readdir(directory);
  const invalid = await emit(socket, "send_message", { roomId: String(room._id), attachments: [{ buffer: image }, { buffer: Buffer.from("<svg>unsafe</svg>") }] });
  assert.equal(invalid.success, false);
  assert.deepEqual(await fs.readdir(directory), beforeInvalid);
});
