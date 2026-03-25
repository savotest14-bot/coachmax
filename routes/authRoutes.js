const express = require("express");
const auth = require("../middleware/authMiddleware");
const { forgotPassword, resendOTP, verifyOtp, resetPassword, getMyProfile, updateMyProfile } = require("../controllers/authController");
const { uploads } = require("../utils/upload");

const router = express.Router();

router.post("/forgotPassword", forgotPassword);

router.post("/resendOtp", resendOTP);

router.post("/verifyOtp", verifyOtp);

router.post("/resetPassword", resetPassword)

router.get("/getMyProfile", auth, getMyProfile)

router.put("/updateMyProfile",auth, uploads.single("profile"), updateMyProfile)

module.exports = router;