const Admin = require("../models/Admin");
const Parent = require("../models/Parent");
const bcrypt = require("bcryptjs");
const generateToken = require("../utils/generateToken");
const { forgotEmail } = require("../utils/emailTemplates");
const sendEmail = require("../utils/sendEmail");
const generateOTP = require("../utils/generateOTP");
const fs = require("fs");
const path = require("path");
const User = require("../models/User");
const Invoice = require("../models/Invoice");


exports.forgotPassword = async (req, res) => {
  try {
    const { email, role } = req.body;

    if (!email || !role) {
      return res.status(400).json({
        message: "Email and role required",
      });
    }

    const Model = role === "ADMIN" ? Admin : Parent;
    const user = await Model.findOne({ email: email.toLowerCase() });

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
      otp: otp,
      userId: user._id,
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

    const Model = role === "ADMIN" ? Admin : Parent;
    const user = await Model.findOne({ email: email.toLowerCase() });

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
      otp: otp,
      userId: user._id,
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
        message: "User ID, role and OTP are required",
      });
    }

    const Model = role === "ADMIN" ? Admin : Parent;
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

    const Model = role === "ADMIN" ? Admin : Parent;
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

// exports.getMyProfile = async (req, res) => {
//   try {
//     let data = req.role === "ADMIN" ? req.admin : req.user;

//     data = data.toObject();

//     // Remove sensitive fields
//     delete data.password;
//     delete data.tokens;
//     delete data.otp;
//     delete data.otpExpire;

//     let players = [];

//     // If logged in user is a Parent, fetch players
//     if (req.role !== "ADMIN") {
//       players = await User.find({ parentId: data._id })
//         .populate("category", "name")
//         .populate("programs", "name")
//         .populate("term", "name")
//         .select("-__v");
//     }

//     res.json({
//       success: true,
//       role: req.role,
//       data: {
//         ...data,
//         players,
//       },
//     });
//   } catch (err) {
//     res.status(500).json({
//       success: false,
//       message: err.message,
//     });
//   }
// };



exports.getMyProfile = async (req, res) => {
  try {
    let data = req.role === "ADMIN" ? req.admin : req.parent;

    data = data.toObject();

    // Remove sensitive fields
    delete data.password;
    delete data.tokens;
    delete data.otp;
    delete data.otpExpire;

    let players = [];
    let unpaidInvoiceCount = 0;

    if (req.role !== "ADMIN") {
      // Get parent's players
      players = await User.find({ parentId: data._id })
        .populate("category", "name")
        .populate("programs", "name")
        .populate("term", "name")
        .select("-__v");

      // Count unpaid invoices
      unpaidInvoiceCount = await Invoice.countDocuments({
        parent: data._id,
        status: "ACTIVE",
        paymentStatus: {
          $in: ["UNPAID", "PAYMENT_PENDING", "REJECTED"],
        },
      });
    }

    return res.json({
      success: true,
      role: req.role,
      data: {
        ...data,
        players,
        unpaidInvoiceCount,
      },
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

exports.updateMyProfile = async (req, res) => {
  try {
    let Model;
    let currentUser;
    let updateFields = {};

    if (req.role === "ADMIN") {
      Model = Admin;
      currentUser = req.admin;
    } else {
      Model = Parent;
      currentUser = req.parent;
    }

    // Upload new profile image
    if (req.file) {
      const imagePath = `uploads/profiles/${req.file.filename}`;
      updateFields.profileImage = imagePath;

      // Delete old profile image
      if (currentUser.profileImage) {
        const oldPath = path.resolve(currentUser.profileImage);

        fs.access(oldPath, fs.constants.F_OK, (err) => {
          if (!err) {
            fs.unlink(oldPath, (err) => {
              if (err) {
                console.log("Failed to delete old image:", err.message);
              }
            });
          }
        });
      }
    }

    if (req.role === "ADMIN") {
      updateFields.name = req.body.name;
      updateFields.mobile = req.body.mobile;
    } else {
      updateFields.fullName = req.body.fullName;
      updateFields.phone = req.body.phone;
      updateFields.address = req.body.address;
      updateFields.city = req.body.city;
      updateFields.state = req.body.state;
      updateFields.postcode = req.body.postcode;
      updateFields.country = req.body.country;
      updateFields.emergencyContact = req.body.emergencyContact;
      updateFields.relationship = req.body.relationship;

      if (req.body.notificationSettings) {
        updateFields.notificationSettings =
          typeof req.body.notificationSettings === "string"
            ? JSON.parse(req.body.notificationSettings)
            : req.body.notificationSettings;
      }
    }

    // Remove undefined values
    Object.keys(updateFields).forEach((key) => {
      if (updateFields[key] === undefined) {
        delete updateFields[key];
      }
    });

    const updatedUser = await Model.findByIdAndUpdate(
      currentUser._id,
      updateFields,
      {
        new: true,
        runValidators: true,
      }
    ).lean();

    delete updatedUser.password;
    delete updatedUser.tokens;
    delete updatedUser.otp;
    delete updatedUser.otpExpire;

    return res.status(200).json({
      success: true,
      message: "Profile updated successfully.",
      data: updatedUser,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};


exports.updateChild = async (req, res) => {
  try {
    const { childId } = req.params;

    // Ensure child belongs to logged-in parent
    const child = await User.findOne({
      _id: childId,
      parentId: req.parent._id,
    });

    if (!child) {
      return res.status(404).json({
        success: false,
        message: "Child not found.",
      });
    }

    const updateFields = {};

    if (req.body.firstName !== undefined)
      updateFields.firstName = req.body.firstName;

    if (req.body.lastName !== undefined)
      updateFields.lastName = req.body.lastName;

    if (
      req.body.firstName !== undefined ||
      req.body.lastName !== undefined
    ) {
      updateFields.fullName = `${req.body.firstName || child.firstName} ${
        req.body.lastName || child.lastName
      }`;
    }

    if (req.body.email !== undefined)
      updateFields.email = req.body.email || null;

    if (req.body.phone !== undefined)
      updateFields.phone = req.body.phone || null;

    if (req.body.gender !== undefined)
      updateFields.gender = req.body.gender;

    if (req.body.comments !== undefined)
      updateFields.comments = req.body.comments;

    if (req.body.jerseyNumber !== undefined)
      updateFields.jerseyNumber = req.body.jerseyNumber;

    if (req.body.prefferedFoot !== undefined)
      updateFields.prefferedFoot = req.body.prefferedFoot;

    if (req.body.isMedicalCondition !== undefined)
      updateFields.isMedicalCondition = req.body.isMedicalCondition;

    if (req.body.medicalConditionDetails !== undefined)
      updateFields.medicalConditionDetails = req.body.medicalConditionDetails;

    // Parse DOB
    if (req.body.dob) {
      const parts = req.body.dob.split("/");

      if (parts.length === 3) {
        updateFields.dob = new Date(
          `${parts[2]}-${parts[1]}-${parts[0]}`
        );
      } else {
        updateFields.dob = new Date(req.body.dob);
      }
    }

    // Profile Image
    if (req.file) {
      updateFields.profileImage = `uploads/profiles/${req.file.filename}`;

      if (child.profileImage) {
        const oldPath = path.resolve(child.profileImage);

        fs.access(oldPath, fs.constants.F_OK, (err) => {
          if (!err) {
            fs.unlink(oldPath, () => {});
          }
        });
      }
    }

    const updatedChild = await User.findByIdAndUpdate(
      childId,
      updateFields,
      {
        new: true,
        runValidators: true,
      }
    );

    return res.status(200).json({
      success: true,
      message: "Child updated successfully.",
      data: updatedChild,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};