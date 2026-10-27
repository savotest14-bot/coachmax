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


const crypto = require("crypto");
const resetModel = (role) => role === "ADMIN" ? Admin : role === "PARENT" ? Parent : null;
const resetHash = (token) => crypto.createHash("sha256").update(String(token)).digest("hex");
const sendResetOtp = async (req, res, next) => {
  try {
    const Model = resetModel(req.body.role);
    const email = String(req.body.email || "").trim().toLowerCase();
    if (!Model || !email || email.length > 254) return res.status(400).json({ success: false, message: "A valid email and role are required" });
    const user = await Model.findOne({ email });
    const userId = user?._id || crypto.randomBytes(12).toString("hex");
    if (user) {
      if (user.otpExpire && Date.now() < user.otpExpire.getTime() - 9 * 60000) return res.status(429).json({ success: false, message: "Please wait before requesting another code" });
      const otp = generateOTP();
      user.otp = await bcrypt.hash(otp, 10); user.otpExpire = new Date(Date.now() + 10 * 60000); user.otpAttempts = 0;
      user.isOtpVerified = false; user.resetTokenHash = undefined; user.resetTokenExpire = undefined;
      await user.save();
      try { await sendEmail(user.email, "CoachMax password reset code", forgotEmail(user, otp)); }
      catch { console.error("Password reset email delivery failed"); }
    }
    return res.json({ success: true, userId, message: "If the account exists, a reset code has been sent" });
  } catch (error) { return next(error); }
};
exports.forgotPassword = sendResetOtp;
exports.resendOTP = sendResetOtp;
exports.verifyOtp = async (req, res, next) => {
  try {
    const { userId, role, otp } = req.body;
    const Model = resetModel(role);
    if (!Model || !/^[a-f0-9]{24}$/i.test(String(userId)) || !/^\d{6}$/.test(String(otp))) return res.status(400).json({ success: false, message: "Invalid or expired reset code" });
    const user = await Model.findOneAndUpdate({ _id: userId, otpExpire: { $gt: new Date() }, otpAttempts: { $lt: 5 }, otp: { $type: "string" } }, { $inc: { otpAttempts: 1 } }, { new: true });
    if (!user?.otp || !await bcrypt.compare(String(otp), user.otp)) return res.status(400).json({ success: false, message: "Invalid or expired reset code" });
    const resetToken = crypto.randomBytes(32).toString("hex");
    const consumed = await Model.updateOne({ _id: user._id, otp: user.otp, otpExpire: { $gt: new Date() } }, { $set: { resetTokenHash: resetHash(resetToken), resetTokenExpire: new Date(Date.now() + 5 * 60000), isOtpVerified: false }, $unset: { otp: 1, otpExpire: 1 } });
    if (!consumed.modifiedCount) return res.status(400).json({ success: false, message: "Reset code has already been used" });
    return res.json({ success: true, userId: user._id, resetToken, message: "Code verified. Reset your password within five minutes." });
  } catch (error) { return next(error); }
};
exports.resetPassword = async (req, res, next) => {
  try {
    const { userId, role, newPassword, resetToken } = req.body;
    const Model = resetModel(role);
    if (!Model || !/^[a-f0-9]{24}$/i.test(String(userId)) || !/^[a-f0-9]{64}$/.test(String(resetToken || "")) || typeof newPassword !== "string" || newPassword.length < 8 || newPassword.length > 128) return res.status(400).json({ success: false, message: "A valid reset token and an 8–128 character password are required" });
    const password = await bcrypt.hash(newPassword, 12);
    const user = await Model.findOneAndUpdate({ _id: userId, resetTokenHash: resetHash(resetToken), resetTokenExpire: { $gt: new Date() } }, { $set: { password, isOtpVerified: false, otpAttempts: 0, tokens: [] }, $unset: { resetTokenHash: 1, resetTokenExpire: 1, otp: 1, otpExpire: 1 } });
    if (!user) return res.status(400).json({ success: false, message: "Invalid, expired or already used reset token" });
    return res.json({ success: true, message: "Password reset. Sign in with your new password." });
  } catch (error) { return next(error); }
};

exports.changePassword = async (req, res, next) => {
  try {
    const { oldPassword, newPassword } = req.body;
    if (typeof oldPassword !== "string" || typeof newPassword !== "string" || newPassword.length < 8 || newPassword.length > 128) return res.status(400).json({ success: false, message: "Current password and an 8–128 character new password are required" });
    const Model = req.admin ? Admin : Parent;
    const account = req.admin || req.parent;
    if (!account || !await bcrypt.compare(oldPassword, account.password)) return res.status(400).json({ success: false, message: "Current password is incorrect" });
    if (oldPassword === newPassword) return res.status(400).json({ success: false, message: "Choose a new password" });
    const password = await bcrypt.hash(newPassword, 12);
    const changed = await Model.updateOne({ _id: account._id, password: account.password, tokens: req.token }, { $set: { password, tokens: [req.token], isOtpVerified: false, otpAttempts: 0 }, $unset: { resetTokenHash: 1, resetTokenExpire: 1, otp: 1, otpExpire: 1 } });
    if (!changed.modifiedCount) return res.status(409).json({ success: false, message: "Account changed. Sign in and try again" });
    return res.json({ success: true, message: "Password changed; other sessions have been signed out" });
  } catch (error) { return next(error); }
};

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
      players = await User.find({ parentId: data._id })
        .populate("category", "name")
        .populate("programs", "name")
        .populate("term", "name")
        .select("-__v");

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
  const replacementFile = req.file || (Array.isArray(req.files) ? req.files[0] : null);
  let committed = false;
  let oldImage;
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

    const uploadedFile = replacementFile;

    if (uploadedFile) {
      const folderName = uploadedFile.destination ? path.basename(uploadedFile.destination) : "profiles";
      const imagePath = `uploads/${folderName}/${uploadedFile.filename}`;

      updateFields.profileImage = imagePath;

      oldImage = currentUser.profileImage;
    } else if (req.body.profileImage !== undefined || req.body.profile !== undefined) {
      const image = req.body.profileImage ?? req.body.profile;
      if (image && image !== currentUser.profileImage) return res.status(400).json({ success: false, message: "Upload a file to change your profile image" });
      oldImage = currentUser.profileImage;
      updateFields.profileImage = image || "";
    }

    if (req.role === "ADMIN") {
      if (req.body.name !== undefined) updateFields.name = req.body.name;
      if (req.body.fullName !== undefined) updateFields.name = req.body.fullName;

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

    Object.keys(updateFields).forEach((key) => {
      if (updateFields[key] === undefined) {
        delete updateFields[key];
      }
    });

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

    if (!updatedUser) throw Object.assign(new Error("User profile not found"), { status: 404 });
    committed = true;
    if (oldImage && oldImage !== updatedUser.profileImage) await require("../utils/upload").removeStoredUpload(oldImage).catch(() => {});

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
  } finally {
    if (!committed && replacementFile?.path) await fs.promises.unlink(replacementFile.path).catch(() => {});
  }
};



exports.updateChild = async (req, res, next) => {
  const mongoose=require('mongoose');
  if(!req.parent){if(req.file?.filename)await require('../utils/upload').removeStoredUpload('uploads/profiles/'+req.file.filename).catch(()=>{});return res.status(403).json({success:false,message:'Parent access required'});}
  if(!mongoose.isValidObjectId(req.params.childId)){if(req.file?.filename)await require('../utils/upload').removeStoredUpload('uploads/profiles/'+req.file.filename).catch(()=>{});return res.status(400).json({success:false,message:'Invalid child ID'});}
  const session=await mongoose.startSession();let updated;let oldImage;
  try {
    await session.withTransaction(async()=>{
      const child=await User.findOne({_id:req.params.childId,parentId:req.parent._id}).session(session);
      if(!child)throw Object.assign(new Error('Child not found'),{status:404});
      for(const key of ['firstName','lastName','email','phone','gender','comments','school','jerseyNumber','prefferedFoot'])if(req.body[key]!==undefined)child[key]=req.body[key];
      child.fullName=[child.firstName,child.lastName].filter(Boolean).join(' ').trim();
      const dates=require('../utils/dateTime');
      if(req.body.dob){child.dob=dates.dateOnlyToUtc(req.body.dob,'Date of birth');if(dates.dateOnly(child.dob)>dates.todayDateOnly())throw Object.assign(new Error('Date of birth cannot be in the future'),{status:400});}
      if(['isMedicalCondition','medicalConditions','medicalConditionDetails','allergies'].some(key=>req.body[key]!==undefined)){
        const MedicalProfile=require('../models/MedicalProfile');const previous=await MedicalProfile.findOne({player:child._id}).session(session);
        const normalized=require('../utils/medicalStatus').normalizeMedicalStatus({isMedicalCondition:req.body.isMedicalCondition ?? child.isMedicalCondition,medicalConditionDetails:req.body.medicalConditionDetails ?? req.body.medicalConditions ?? child.medicalConditionDetails,allergies:req.body.allergies ?? previous?.allergies ?? []});
        await require('../models/MedicalRevision').create([{player:child._id,actor:req.parent._id,actorType:'PARENT',previous:{isMedicalCondition:child.isMedicalCondition,medicalConditionDetails:child.medicalConditionDetails},current:normalized}],{session});
        child.isMedicalCondition=normalized.isMedicalCondition;child.medicalConditionDetails=normalized.medicalConditionDetails;
        await MedicalProfile.updateOne({player:child._id},{$set:{medicalConditions:normalized.medicalConditions,allergies:normalized.allergies}},{upsert:true,session,runValidators:true});
      }
      if(req.file){oldImage=child.profileImage;child.profileImage='uploads/profiles/'+req.file.filename;}
      await child.save({session});updated=child.toObject();updated.dob=dates.dateOnly(child.dob);
    });
    if(oldImage)await require('../utils/upload').removeStoredUpload(oldImage).catch(()=>{});
    return res.json({success:true,message:'Child profile updated',data:updated});
  } catch(error){if(req.file?.path)fs.promises.unlink(req.file.path).catch(()=>{});return next(error);}
  finally{await session.endSession();}
};
