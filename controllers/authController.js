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
const Class = require("../models/Class");
const Attendance = require("../models/Attendance");


exports.forgotPassword = async (req, res) => {
  try {
    const { email, role } = req.body;

    if (!email || !role) {
      return res.status(400).json({
        message: "Email and role required",
      });
    }

    const Model = role === "ADMIN" ? Admin : Parent;

    const user = await Model.findOne({ email: email });

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

    if (!data) {
      return res.status(404).json({
        success: false,
        message: "User profile not found",
      });
    }

    data = data.toObject();

    // Remove sensitive fields
    delete data.password;
    delete data.tokens;
    delete data.otp;
    delete data.otpExpire;

    let players = [];
    let unpaidInvoiceCount = 0;
    let coachStats = {};

    if (req.role === "ADMIN" && data.role === "COACH") {
      const assignedClasses = await Class.find({
        $or: [{ coach: data._id }, { assistantCoach: data._id }],
        status: "ACTIVE",
      })
        .populate("term", "startDate endDate")
        .select("players term dayOfWeek");

      const assignedClassesCount = assignedClasses.length;

      const playerIdsSet = new Set();
      const classIds = [];
      const now = new Date();
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

      let sessionsToBeDeliveredCount = 0;
      let sessionsToBeDeliveredThisMonthCount = 0;

      const dayMap = {
        SUNDAY: 0,
        MONDAY: 1,
        TUESDAY: 2,
        WEDNESDAY: 3,
        THURSDAY: 4,
        FRIDAY: 5,
        SATURDAY: 6,
      };

      assignedClasses.forEach((cls) => {
        classIds.push(cls._id);
        (cls.players || []).forEach((pId) => {
          if (pId) playerIdsSet.add(pId.toString());
        });

        if (cls.term && cls.term.startDate && cls.term.endDate) {
          const start = new Date(cls.term.startDate);
          start.setUTCHours(0, 0, 0, 0);
          const end = new Date(cls.term.endDate);
          end.setUTCHours(0, 0, 0, 0);

          // Determine which days to iterate over
          const scheduleType = cls.scheduleType || "SINGLE_DAY";
          const schedule = cls.schedule || [];
          let daysToCount = [];

          if ((scheduleType === "WEEKDAYS" || scheduleType === "CUSTOM") && schedule.length > 0) {
            daysToCount = schedule.map((e) => dayMap[(e.dayOfWeek || "").toUpperCase()]).filter((d) => d !== undefined);
          } else if (cls.dayOfWeek) {
            const td = dayMap[cls.dayOfWeek.toUpperCase()];
            if (td !== undefined) daysToCount = [td];
          }

          for (const targetDay of daysToCount) {
            let current = new Date(start);
            while (current.getUTCDay() !== targetDay) {
              current.setUTCDate(current.getUTCDate() + 1);
            }
            while (current <= end) {
              sessionsToBeDeliveredCount++;
              if (current >= startOfMonth && current <= endOfMonth) {
                sessionsToBeDeliveredThisMonthCount++;
              }
              current.setUTCDate(current.getUTCDate() + 7);
            }
          }
        }
      });

      const uniquePlayersCount = playerIdsSet.size;

      let overallAttendancePercentage = 0;
      if (classIds.length > 0) {
        const attendances = await Attendance.find({
          class: { $in: classIds },
        }).select("records");

        let totalRecords = 0;
        let presentRecords = 0;

        attendances.forEach((att) => {
          (att.records || []).forEach((r) => {
            totalRecords++;
            if (r.status === "PRESENT" || r.status === "LATE") {
              presentRecords++;
            }
          });
        });

        overallAttendancePercentage =
          totalRecords > 0
            ? Number(((presentRecords / totalRecords) * 100).toFixed(2))
            : 0;
      }

      // Temporary players created by this coach this month
      const temporaryPlayersThisMonthCount = await User.countDocuments({
        createdBy: data._id,
        createdAt: { $gte: startOfMonth },
      });

      coachStats = {
        assignedClassesCount,
        uniquePlayersCount,
        overallAttendancePercentage,
        temporaryPlayersThisMonthCount,
        temporaryPlayersCreatedThisMonth: temporaryPlayersThisMonthCount,
        sessionsToBeDeliveredCount,
        sessionsToBeDelivered: sessionsToBeDeliveredCount,
        sessionsToBeDeliveredThisMonthCount,
        sessionsToBeDeliveredThisMonth: sessionsToBeDeliveredThisMonthCount,
      };
    } else if (req.role !== "ADMIN") {
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
        ...(data.role === "COACH" ? coachStats : {}),
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

    if (!currentUser) {
      return res.status(404).json({
        success: false,
        message: "User profile not found.",
      });
    }

    // Support single file upload from req.file or req.files (e.g. from uploads.any())
    const uploadedFile = req.file || (req.files && req.files.length > 0 ? req.files[0] : null);

    if (uploadedFile) {
      const folderName = uploadedFile.destination ? path.basename(uploadedFile.destination) : "profiles";
      const imagePath = `uploads/${folderName}/${uploadedFile.filename}`;

      updateFields.profileImage = imagePath;

      // Delete old profile image if exists
      const oldImage = currentUser.profileImage;
      if (oldImage) {
        const oldPath = path.resolve(oldImage);
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
    } else if (req.body.profileImage !== undefined || req.body.profile !== undefined) {
      updateFields.profileImage = req.body.profileImage !== undefined ? req.body.profileImage : req.body.profile;
    }

    if (req.role === "ADMIN") {
      // Support both `name` and `fullName` for Admin/Coach
      if (req.body.name !== undefined) updateFields.name = req.body.name;
      if (req.body.fullName !== undefined) updateFields.name = req.body.fullName;

      // Support both `mobile` and `phone` for Admin/Coach
      if (req.body.mobile !== undefined) updateFields.mobile = req.body.mobile;
      if (req.body.phone !== undefined) updateFields.mobile = req.body.phone;

      if (req.body.email !== undefined) updateFields.email = req.body.email;
    } else {
      if (req.body.fullName !== undefined) updateFields.fullName = req.body.fullName;
      if (req.body.name !== undefined && req.body.fullName === undefined) updateFields.fullName = req.body.name;
      if (req.body.phone !== undefined) updateFields.phone = req.body.phone;
      if (req.body.mobile !== undefined && req.body.phone === undefined) updateFields.phone = req.body.mobile;
      if (req.body.address !== undefined) updateFields.address = req.body.address;
      if (req.body.city !== undefined) updateFields.city = req.body.city;
      if (req.body.state !== undefined) updateFields.state = req.body.state;
      if (req.body.postcode !== undefined) updateFields.postcode = req.body.postcode;
      if (req.body.country !== undefined) updateFields.country = req.body.country;
      if (req.body.emergencyContact !== undefined) updateFields.emergencyContact = req.body.emergencyContact;
      if (req.body.relationship !== undefined) updateFields.relationship = req.body.relationship;

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

    // Check for duplicate mobile number across both Admin and Parent models
    const newMobile = updateFields.mobile || updateFields.phone;
    if (newMobile) {
      const currentMobile = currentUser.mobile || currentUser.phone;
      if (newMobile !== currentMobile) {
        const existingAdmin = await Admin.findOne({
          mobile: newMobile,
          _id: { $ne: currentUser._id },
        });
        const existingParent = await Parent.findOne({
          phone: newMobile,
          _id: { $ne: currentUser._id },
        });

        if (existingAdmin || existingParent) {
          return res.status(400).json({
            success: false,
            message: "Mobile number is already registered by another user.",
          });
        }
      }
    }

    // Check for duplicate email across both Admin and Parent models
    if (updateFields.email) {
      const currentEmail = currentUser.email;
      if (updateFields.email.toLowerCase() !== (currentEmail ? currentEmail.toLowerCase() : "")) {
        const existingAdminEmail = await Admin.findOne({
          email: updateFields.email,
          _id: { $ne: currentUser._id },
        });
        const existingParentEmail = await Parent.findOne({
          email: updateFields.email.toLowerCase(),
          _id: { $ne: currentUser._id },
        });

        if (existingAdminEmail || existingParentEmail) {
          return res.status(400).json({
            success: false,
            message: "Email is already registered by another user.",
          });
        }
      }
    }

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
    if (error.code === 11000) {
      const isMobile = error.keyPattern && (error.keyPattern.mobile || error.keyPattern.phone);
      return res.status(400).json({
        success: false,
        message: isMobile ? "Mobile number is already registered by another user." : "Email is already registered by another user.",
      });
    }
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
      updateFields.fullName = `${req.body.firstName || child.firstName} ${req.body.lastName || child.lastName
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
            fs.unlink(oldPath, () => { });
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