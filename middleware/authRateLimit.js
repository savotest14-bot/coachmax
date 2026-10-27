const { rateLimit } = require("express-rate-limit");
const authRateLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: "draft-8", legacyHeaders: false, message: { success: false, message: "Too many attempts. Please try again later." } });
module.exports = authRateLimit;
