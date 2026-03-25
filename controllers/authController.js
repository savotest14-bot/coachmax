const Admin = require("../models/Admin");
const bcrypt = require("bcryptjs");
const generateToken = require("../utils/generateToken");
const User = require("../models/User");
const { getStatusEmailTemplate, forgotEmail } = require("../utils/emailTemplates");
const sendEmail = require("../utils/sendEmail");
const generateOTP = require("../utils/generateOTP");
const fs = require("fs");
const path = require("path");

exports.forgotPassword = async (req, res) => {
  try {
    const { email, role } = req.body;

    if (!email || !role) {
      return res.status(400).json({
        message: "Email and role required",
      });
    }

    const Model = role === "ADMIN" ? Admin : User;

    const user = await Model.findOne({ email });

    if (!user) {
      return res.status(404).json({
        message: "User not found",
      });
    }

    const otp = generateOTP();

    user.otp = otp;
    user.otpExpire = Date.now() + 10 * 60 * 1000;

    await user.save();
    const html = forgotEmail(user, otp);

    sendEmail(user.email, "Reset Password OTP", html);

    res.json({
      message: "OTP sent to email",
      userId: user._id
    });

  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.resendOTP = async (req, res) => {
  try {
    const { email, role } = req.body;

    if (!email || !role) {
      return res.status(400).json({
        message: "Email and role required",
      });
    }

    const Model = role === "ADMIN" ? Admin : User;

    const user = await Model.findOne({ email });

    if (!user) {
      return res.status(404).json({
        message: "User not found",
      });
    }

    if (user.otpExpire && Date.now() < user.otpExpire - 9 * 60 * 1000) {
      return res.status(429).json({
        message: "Please wait before requesting a new OTP",
      });
    }

    const otp = generateOTP();

    user.otp = otp;
    user.otpExpire = Date.now() + 10 * 60 * 1000;

    await user.save();

    const html = forgotEmail(user, otp);

    sendEmail(user.email, "Resend OTP - Password Reset", html);

    res.json({
      message: "OTP resent successfully",
      userId: user._id
    });

  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.verifyOtp = async (req, res) => {
  try {
    const { userId, role, otp } = req.body;

    if (!userId || !role || !otp) {
      return res.status(400).json({
        message: "Email, role and OTP are required",
      });
    }

    const Model = role === "ADMIN" ? Admin : User;

    const user = await Model.findOne({ _id: userId });

    if (!user) {
      return res.status(404).json({
        message: "User not found",
      });
    }

    if (user.otp !== otp) {
      return res.status(400).json({
        message: "Invalid OTP",
      });
    }

    if (!user.otpExpire || user.otpExpire < Date.now()) {
      return res.status(400).json({
        message: "OTP expired",
      });
    }

    user.isOtpVerified = true;
    await user.save();

    res.json({
      success: true,
      userId: user._id,
      message: "OTP verified successfully",
    });

  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.resetPassword = async (req, res) => {
  try {
    const { userId, role, newPassword } = req.body;

    if (!userId || !role || !newPassword) {
      return res.status(400).json({
        message: "All fields are required",
      });
    }

    const Model = role === "ADMIN" ? Admin : User;

    const user = await Model.findOne({ _id: userId });

    if (!user) {
      return res.status(404).json({
        message: "User not found",
      });
    }

    if (!user.isOtpVerified) {
      return res.status(400).json({
        message: "OTP not verified",
      });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);

    user.password = hashedPassword;
    user.otp = null;
    user.otpExpire = null;
    user.isOtpVerified = false;

    await user.save();

    res.json({
      success: true,
      message: "Password reset successful",
    });

  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.getMyProfile = async (req, res) => {
  try {
    let data;

    if (req.role === "ADMIN") {
      data = req.admin;
    } else {
      data = req.user;
    }

    data = data.toObject();
    delete data.password;
    delete data.tokens;
    delete data.otp;
    delete data.otpExpire;

    res.json({
      success: true,
      role: req.role,
      data,
    });

  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.updateMyProfile = async (req, res) => {
  try {
    let Model;
    let currentUser;

    if (req.role === "ADMIN") {
      Model = require("../models/Admin");
      currentUser = req.admin;
    } else {
      Model = require("../models/User");
      currentUser = req.user;
    }

    let updateFields = {};

    if (req.file) {
       updateFields.profile = `uploads/profile/${req.file.filename}`;

      if (currentUser.profile) {
        const oldPath = path.resolve(currentUser.profile);
        fs.access(oldPath, fs.constants.F_OK, (err) => {
          if (!err) {
            fs.unlink(oldPath, (err) => {
              if (err) console.log("❌ Failed to delete old image:", err.message);
              else console.log("✅ Old image deleted");
            });
          }
        });
      }
    }

    if (req.role === "ADMIN") {
      updateFields = {
        ...updateFields,
        name: req.body.name,
        mobile: req.body.mobile,
      };
    } else {
      updateFields = {
        ...updateFields,
        fullName: req.body.fullName,
        phone: req.body.phone,
        dob: req.body.dob,
        club: req.body.club,
        contactName: req.body.contactName,
        preferredFoot: req.body.preferredFoot,
        skillLevel: req.body.skillLevel,
        medicalCondition: req.body.medicalCondition,
        comments: req.body.comments,
        programType: req.body.programType,
      };
    }

    Object.keys(updateFields).forEach(
      (key) => updateFields[key] === undefined && delete updateFields[key]
    );

    const updated = await Model.findByIdAndUpdate(
      currentUser._id,
      updateFields,
      { new: true }
    ).lean();

    delete updated.password;
    delete updated.tokens;
    delete updated.otp;
    delete updated.otpExpire;

    res.json({
      success: true,
      message: "Profile updated successfully",
      data: updated,
    });

  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

