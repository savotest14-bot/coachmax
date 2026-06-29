const jwt = require("jsonwebtoken");
const Admin = require("../models/Admin");
const Parent = require("../models/Parent");

const auth = async (req, res, next) => {
  try {
    const token = req.header("Authorization")?.replace("Bearer ", "");

    if (!token) {
      return res.status(401).json({ message: "No token provided" });
    }

    // 🔐 Verify token
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // 🛡️ Check Admin (Super Admin or Coach)
    const admin = await Admin.findOne({
      _id: decoded.id,
      tokens: token,
    });

    if (admin) {
      req.admin = admin;
      req.role = "ADMIN";
      req.token = token;
      return next();
    }

    // 👤 Check Parent
    const parent = await Parent.findOne({
      _id: decoded.id,
      tokens: token,
    });

    if (parent) {
      // 🚫 Blocked check
      if (parent.isBlocked) {
        return res.status(403).json({
          message: "Your account is blocked. Contact admin.",
        });
      }

      // 🚫 Approval check (if applicable, e.g. status)
      if (parent.status !== "APPROVED") {
        return res.status(403).json({
          message: `Your account is not approved. Status: ${parent.status}`,
        });
      }

      req.user = parent; // Set req.user to Parent for compatibility with auth routes
      req.parent = parent; // Set req.parent for explicit identification
      req.role = "PARENT";
      req.token = token;

      return next();
    }

    return res.status(401).json({ message: "Invalid or expired token" });
  } catch (err) {
    return res.status(401).json({ message: "Unauthorized access" });
  }
};

module.exports = auth;