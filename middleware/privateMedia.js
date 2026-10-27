const jwt = require("jsonwebtoken");
const auth = require("./authMiddleware");
const Document = require("../models/Document");
const Payment = require("../models/Payment");
const User = require("../models/User");
const Class = require("../models/Class");
const Message = require("../models/Message");
const ChatRoom = require("../models/ChatRoom");
const Training = require("../models/TrainingSession");
const privatePattern = /^uploads\/(documents|payment-screenshots|training|chat)\/[a-zA-Z0-9._-]+$/;
const privateFolders = new Set(["documents", "payment-screenshots", "training", "chat"]);
const publicFolders = new Set(["profiles", "teamlogos", "leaguelogos", "bannerimg", "eventimg", "images", "bank-details"]);
const canonicalMediaPath = (value) => {
  if (typeof value !== "string") return null;
  const clean = value.replace(/^\//, "").split("?")[0];
  return privatePattern.test(clean) && !clean.includes("..") ? clean : null;
};
async function canReadMedia(req, relative) {
  if (["SUPER_ADMIN", "ADMIN"].includes(req.admin?.role)) return true;
  if (!req.parent && !req.admin) return false;
  if (relative.startsWith("uploads/documents/")) {
    const doc = await Document.findOne({ fileUrl: relative }).select("player");
    if (!doc) return false;
    if (req.parent) return !!await User.exists({ _id: doc.player, parentId: req.parent._id });
    return !!await Class.exists({ players: doc.player, $or: [{ coach: req.admin._id }, { assistantCoach: req.admin._id }] });
  }
  if (relative.startsWith("uploads/payment-screenshots/")) return !!req.parent && !!await Payment.exists({ paymentScreenshot: relative, parent: req.parent._id });
  if (relative.startsWith("uploads/chat/")) {
    // Forwarded attachments can legitimately appear in more than one room.
    // Authorize against any matching room this identity belongs to.
    const rooms = await Message.find({ "attachments.url": relative }).distinct("room");
    return !!rooms.length && !!await ChatRoom.exists({ _id: { $in: rooms }, members: { $elemMatch: { refModel: req.parent ? "Parent" : "Admin", user: req.parent?._id || req.admin._id } } });
  }
  const training = await Training.findOne({ attachments: relative }).select("class coach");
  if (!training) return false;
  if (req.admin) return !!await Class.exists({ _id: training.class, $or: [{ coach: req.admin._id }, { assistantCoach: req.admin._id }] });
  const children = await User.find({ parentId: req.parent._id }).distinct("_id");
  return !!await Class.exists({ _id: training.class, players: { $in: children } });
}
function signMedia(relative) {
  return `/${relative}?access=${jwt.sign({ purpose: "media", path: relative }, process.env.JWT_SECRET, { expiresIn: "5m" })}`;
}
async function issueMediaLink(req, res, next) {
  try {
    const relative = canonicalMediaPath(req.query.path);
    if (!relative || !await canReadMedia(req, relative)) return res.status(403).json({ success: false, message: "File access denied" });
    return res.json({ success: true, url: signMedia(relative), expiresIn: 300 });
  } catch (error) { return next(error); }
}
function privateMediaGate(req, res, next) {
  // express.static decodes URL escapes and Windows paths are case-insensitive.
  // Classify the decoded folder before allowing any public static fallback.
  let decoded;
  try { decoded = decodeURIComponent(req.path); }
  catch { return res.status(400).json({ success: false, message: "Invalid file path" }); }
  if (decoded.includes("\\") || decoded.includes("\0") || decoded.includes("%") || decoded.includes(":") || decoded.split("/").some((part) => part === "." || part === "..")) {
    return res.status(403).json({ success: false, message: "File access denied" });
  }
  const segments = decoded.split("/").filter(Boolean);
  const folder = String(segments[0] || "").toLowerCase();
  if (!privateFolders.has(folder)) return publicFolders.has(folder) ? next() : res.status(403).json({ success: false, message: "File access denied" });
  const relative = canonicalMediaPath(`uploads/${[folder, ...segments.slice(1)].join("/")}`);
  if (!relative) return res.status(403).json({ success: false, message: "File access denied" });
  if (req.query.access) {
    try {
      const grant = jwt.verify(String(req.query.access), process.env.JWT_SECRET);
      if (grant.purpose !== "media" || grant.path !== relative) throw new Error("Invalid file grant");
      res.setHeader("Cache-Control", "private, no-store");
      if (!/\.(webp|png|jpe?g|gif)$/i.test(relative)) res.setHeader("Content-Disposition", "attachment");
      return next();
    } catch { return res.status(401).json({ success: false, message: "File link expired; reopen the record to refresh it" }); }
  }
  return auth(req, res, async (error) => {
    if (error) return next(error);
    try {
      if (!await canReadMedia(req, relative)) return res.status(403).json({ success: false, message: "File access denied" });
      res.setHeader("Cache-Control", "private, no-store");
      if (!/\.(webp|png|jpe?g|gif)$/i.test(relative)) res.setHeader("Content-Disposition", "attachment");
      return next();
    } catch (failure) { return next(failure); }
  });
}
// Sign only files this identity may read, so existing image/link clients can
// display private media without placing their session bearer token in URLs.
function signPrivateJson(req, res, next) {
  const original = res.json.bind(res);
  res.json = (body) => {
    if (!req.authenticated || res.statusCode >= 400) return original(body);
    const data = JSON.parse(JSON.stringify(body));
    const paths = new Set();
    const visit = (value) => { if (!value || typeof value !== "object") return; for (const item of Object.values(value)) { const relative = canonicalMediaPath(item); if (relative) paths.add(relative); else if (item && typeof item === "object") visit(item); } };
    visit(data);
    if (!paths.size) return original(data);
    Promise.all([...paths].map(async (relative) => [relative, await canReadMedia(req, relative) ? signMedia(relative) : null])).then((entries) => {
      const urls = new Map(entries);
      const replace = (value) => { for (const [key, item] of Object.entries(value)) { const relative = canonicalMediaPath(item); if (relative) value[key] = urls.get(relative); else if (item && typeof item === "object") replace(item); } };
      replace(data); original(data);
    }).catch(next);
    return res;
  };
  return next();
}
module.exports = { canonicalMediaPath, canReadMedia, signMedia, privateMediaGate, issueMediaLink, signPrivateJson };
