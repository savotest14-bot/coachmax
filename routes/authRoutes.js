const express = require("express");
const auth = require("../middleware/authMiddleware");
const { forgotPassword, resendOTP, verifyOtp, resetPassword, changePassword, getMyProfile, updateMyProfile, updateChild } = require("../controllers/authController");
const { uploads } = require("../utils/upload");
const { getMyRole } = require("../controllers/adminAuthController");

const router = express.Router();
const resetRateLimit = require("../middleware/authRateLimit");

router.post("/forgotPassword", resetRateLimit, forgotPassword);

router.post("/resendOtp", resetRateLimit, resendOTP);

router.post("/verifyOtp", resetRateLimit, verifyOtp);

router.post("/resetPassword", resetRateLimit, resetPassword);
router.post("/changePassword", auth, resetRateLimit, changePassword);

router.get("/getMyProfile", auth, getMyProfile);

router.put("/updateMyProfile", auth, uploads.any(), updateMyProfile);

router.put(
  "/updateChild/:childId",
  auth,
  uploads.single("profiles"),
  updateChild
);

router.get("/my-role", auth, getMyRole);

module.exports = router;
