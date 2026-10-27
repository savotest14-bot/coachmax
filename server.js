const express = require("express");
if (require.main === module) require("dotenv").config();
const cors = require("cors");
const helmet = require("helmet");
const mongoose = require("mongoose");
const path = require("path");
const { UPLOAD_ROOT } = require("./utils/upload");
const { privateMediaGate, issueMediaLink, signPrivateJson } = require("./middleware/privateMedia");
const auth = require("./middleware/authMiddleware");
const app = express();
app.disable("x-powered-by");
app.set("trust proxy", Number(process.env.TRUST_PROXY_HOPS ?? 0));
app.use(helmet({ crossOriginResourcePolicy: false }));
const configuredOrigins = () => new Set([...(process.env.ALLOWED_ORIGINS || "").split(","), process.env.FRONTEND_URL, process.env.CLIENT_URL, process.env.APP_URL].filter(Boolean).flatMap((value) => { try { return [new URL(value.trim()).origin]; } catch { return []; } }));
app.use(cors({ origin(origin, callback) {
  if (!origin || configuredOrigins().has(origin) || (process.env.NODE_ENV !== "production" && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin))) return callback(null, true);
  return callback(Object.assign(new Error("Origin is not allowed"), { status: 403 }));
}, methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"], allowedHeaders: ["Content-Type", "Authorization", "Idempotency-Key", "ngrok-skip-browser-warning"] }));
app.use(express.json({ limit: "1mb" }));
app.use(signPrivateJson);
app.get("/health/live", (req, res) => res.json({ status: "ok" }));
app.get("/health/ready", (req, res) => res.status(mongoose.connection.readyState === 1 ? 200 : 503).json({ ready: mongoose.connection.readyState === 1 }));
app.get("/api/auth/media-link", auth, issueMediaLink);
app.use("/uploads", privateMediaGate, express.static(UPLOAD_ROOT, { dotfiles: "deny", setHeaders(res) { res.setHeader("X-Content-Type-Options", "nosniff"); } }));
app.use("/public", express.static(path.join(__dirname, "public"), { dotfiles: "deny" }));
app.get("/", (req, res) => res.json({ service: "CoachMax API" }));
app.get(["/swagger.json", "/api-docs"], (req, res) => res.sendFile(path.join(__dirname, "swagger.json")));
app.use("/api/admin", require("./routes/adminRoutes"));
app.use("/api/user", require("./routes/userRoutes"));
app.use("/api/auth", require("./routes/authRoutes"));
app.use("/api/coach", require("./routes/coachRoutes"));
app.use((req, res) => res.status(404).json({ success: false, message: "Endpoint not found" }));
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = err.code === "LIMIT_FILE_SIZE" || err.type === "entity.too.large" ? 413 : err.name === "ValidationError" || err.name === "CastError" || err instanceof TypeError ? 400 : err.code === 11000 ? 409 : err.status || err.statusCode || 500;
  if (status >= 500) console.error("Request failed", { name: err.name, code: err.code });
  return res.status(status).json({ success: false, message: status >= 500 ? "The request could not be completed. Please try again." : err.message, ...(err.code ? { code: err.code } : {}) });
});
async function start() {
  if (!process.env.MONGO_URI || !process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) throw new Error("MONGO_URI and a JWT_SECRET of at least 32 characters are required");
  if (process.env.NODE_ENV === "production" && !configuredOrigins().size) throw new Error("Set ALLOWED_ORIGINS or a trusted app URL before production startup");
  new Intl.DateTimeFormat("en", { timeZone: require("./utils/dateTime").DEFAULT_TIMEZONE }).format();
  mongoose.set("autoIndex", false);
  let server, socketServer;
  let jobs = [];
  try {
    await require("./config/db")();
    try {
      await require("./services/criticalIndexes").assertCriticalIndexes();
    } catch (indexError) {
      if (process.env.NODE_ENV === "production") throw indexError;
      console.warn("⚠️ [DEV WARNING] Critical indexes check failed (allowed in dev):", indexError.message);
    }
    await require("./config/seedAdmin")();
    server = require("http").createServer(app);
    require("./sockets/chatSocket").initSocket(server);
    socketServer = require("./sockets/chatSocket").getIO();
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(process.env.PORT || 4001, resolve); });
    jobs = require("./services/cronService").initCronJobs();
    console.log("CoachMax API ready");
    let closing;
    const close = () => closing ||= (async () => {
      jobs.forEach((job) => job.stop());
      await require("./sockets/chatSocket").closeSocket();
      if (server.listening) await new Promise((resolve) => server.close(resolve));
      await mongoose.disconnect();
    })();
    process.once("SIGINT", close); process.once("SIGTERM", close);
    return { server, close };
  } catch (error) {
    jobs.forEach((job) => job.stop());
    if (socketServer) await require("./sockets/chatSocket").closeSocket();
    else if (server?.listening) await new Promise((resolve) => server.close(resolve));
    await mongoose.disconnect();
    throw error;
  }
}
if (require.main === module) start().catch((error) => { console.error("Startup failed:", error.message); process.exitCode = 1; });
module.exports = { app, start };
