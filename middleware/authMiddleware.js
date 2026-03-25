// const jwt = require("jsonwebtoken");
// const Admin = require("../models/Admin");

// const auth = async (req, res, next) => {
//     try {
//         const token = req.header("Authorization")?.replace("Bearer ", "");

//         if (!token) {
//             return res.status(401).json({ message: "No token" });
//         }

//         const decoded = jwt.verify(token, process.env.JWT_SECRET);

//         const admin = await Admin.findOne({
//             _id: decoded.id,
//             tokens: token,
//         });

//         if (!admin) {
//             return res.status(401).json({ message: "Invalid token" });
//         }

//         req.admin = admin;
//         req.token = token;

//         next();
//     } catch (err) {
//         res.status(401).json({ message: "Unauthorized" });
//     }
// };

// module.exports = auth;

const jwt = require("jsonwebtoken");
const Admin = require("../models/Admin");
const User = require("../models/User");

const auth = async (req, res, next) => {
  try {
    let token = req.header("Authorization")?.replace("Bearer ", "");

    if (!token) {
      return res.status(401).json({ message: "No token" });
    }

    // 🔐 Verify token
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // 🛡️ Check Admin first
    let admin = await Admin.findOne({
      _id: decoded.id,
      tokens: token,
    });

    if (admin) {
      req.admin = admin;
      req.role = "ADMIN";
      req.token = token;
      return next();
    }

    // 👤 Check User
    let user = await User.findOne({
      _id: decoded.id,
      tokens: token,
    });

    if (user) {
      // 🚫 Blocked check
      if (user.isBlocked) {
        return res.status(403).json({
          message: "Your account is blocked",
        });
      }

      // 🚫 Status check
      if (user.status !== "APPROVED") {
        return res.status(403).json({
          message: "Your account is not approved",
        });
      }

      req.user = user;
      req.role = "USER";
      req.token = token;

      return next();
    }

    return res.status(401).json({ message: "Invalid token" });

  } catch (err) {
    return res.status(401).json({ message: "Unauthorized" });
  }
};

module.exports = auth;