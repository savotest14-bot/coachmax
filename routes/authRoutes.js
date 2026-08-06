const express = require("express");
const auth = require("../middleware/authMiddleware");
const { forgotPassword, resendOTP, verifyOtp, resetPassword, getMyProfile, updateMyProfile, updateChild } = require("../controllers/authController");
const { uploads } = require("../utils/upload");
const { getMyRole } = require("../controllers/adminAuthController");

const router = express.Router();

router.post("/forgotPassword", forgotPassword);

router.post("/resendOtp", resendOTP);

router.post("/verifyOtp", verifyOtp);

router.post("/resetPassword", resetPassword);

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