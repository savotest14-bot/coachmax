const Admin = require("../models/Admin");
const bcrypt = require("bcryptjs");
const generateToken = require("../utils/generateToken");
const User = require("../models/User");
const sendEmail = require("../utils/sendEmail");
const Banner = require("../models/Banner");
const fs = require("fs");
const path = require("path");
const ExcelJS = require("exceljs");
const Category = require("../models/Category");
const mongoose = require("mongoose");
const Program = require("../models/Program");
const Term = require("../models/Term");
const Class = require("../models/Class");
const Attendance = require("../models/Attendance");
const { Parser } = require("json2csv");
const Parent = require("../models/Parent");
const ChatRoom = require("../models/ChatRoom");
const RegistrationRequest = require("../models/RegistrationRequest");
const Invoice = require("../models/Invoice");
const Payment = require("../models/Payment");
const Event = require("../models/Event");
const EventRegistration = require("../models/EventRegistration");
const Order = require("../models/Order");
const Product = require("../models/Product");
const News = require("../models/News");
const AttendanceHistory = require("../models/AttendanceHistory");
const CoachNote = require("../models/CoachNote");
const TrainingSession = require("../models/TrainingSession");
const Message = require("../models/Message");
const AuditLog = require("../models/AuditLog");
const { generateClassInvoice, generateTransferInvoice } = require("../services/invoiceService");

exports.adminLogin = async (req, res) => {
  try {
    const { email, mobile, password, fcmToken } = req.body;

    if (!password) {
      return res.status(400).json({ message: "Password is required" });
    }

    const admin = await Admin.findOne({
      $or: [{ email }, { mobile }],
    }).select("+password"); // ✅ important

    if (!admin) {
      return res.status(404).json({ message: "Admin not found" });
    }

    if (admin.role === "COACH" && admin.isActive === false) {
      return res.status(403).json({ message: "Coach is inactive and cannot log in" });
    }

    const isMatch = await bcrypt.compare(password, admin.password);

    if (!isMatch) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    const token = generateToken(admin._id);

    admin.tokens = admin.tokens || [];
    admin.tokens.push(token);
    admin.tokens = admin.tokens.slice(-5);

    // Push fcmToken uniquely if provided
    if (fcmToken) {
      admin.fcmTokens = admin.fcmTokens || [];
      if (!admin.fcmTokens.includes(fcmToken)) {
        admin.fcmTokens.push(fcmToken);
      }
    }

    await admin.save();

    // remove sensitive fields
    const adminObj = admin.toObject();
    delete adminObj.password;
    delete adminObj.tokens;

    res.json({
      success: true,
      token,
      admin: adminObj,
    });

  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.logout = async (req, res) => {
  try {
    const { fcmToken } = req.body || {};

    const updateQuery = {
      $set: { tokens: [] }
    };

    if (fcmToken) {
      updateQuery.$pull = { fcmTokens: fcmToken };
    }

    await Admin.findByIdAndUpdate(req.admin._id, updateQuery);
    res.json({ message: "Logged out successfully" });

  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.getUsers = async (req, res) => {
  try {
    let {
      paymentStatus,
      category,
      program,
      unallocated,
      page = 1,
      limit = 10,
      search = "",
    } = req.query;

    const validPaymentStatus = ["TRIAL", "UNPAID", "PAID", "OVER_DUE"];

    if (paymentStatus && !validPaymentStatus.includes(paymentStatus)) {
      return res.status(400).json({
        message: "Invalid paymentStatus",
      });
    }

    page = Number(page);
    limit = Number(limit);

    const andConditions = [{ parentId: { $exists: true } }];

    if (paymentStatus) andConditions.push({ paymentStatus });
    if (category) {
      andConditions.push({ $or: [{ category }, { categories: category }] });
    }
    if (program) andConditions.push({ programs: program });

    if (unallocated === "true") {
      const pendingPlayerIds = await RegistrationRequest.find({ status: "PENDING" }).distinct("player");
      andConditions.push({
        $or: [
          { assignedClasses: { $exists: false } },
          { assignedClasses: { $size: 0 } },
          { hasPendingRequest: true },
          { _id: { $in: pendingPlayerIds } },
        ],
      });
    }

    if (search) {
      const searchCriteria = [
        { fullName: { $regex: search, $options: "i" } },
        { firstName: { $regex: search, $options: "i" } },
        { lastName: { $regex: search, $options: "i" } },
      ];
      andConditions.push({ $or: searchCriteria });
    }

    const query = andConditions.length === 1 ? andConditions[0] : { $and: andConditions };

    const total = await User.countDocuments(query);

    const users = await User.find(query)
      .populate("parentId", "fullName email phone address city state postcode country emergencyContact relationship")
      .populate("category", "name")
      .populate("categories", "name")
      .populate("programs", "name")
      .populate({
        path: "assignedClasses",
        populate: [
          { path: "term", select: "name year" },
          { path: "coach", select: "fullName email" },
          { path: "program", select: "name" },
          { path: "category", select: "name" },
        ],
      })
      .select("-password -tokens")
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit);
    res.json({
      success: true,
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
      users,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.updatePaymentStatus = async (req, res) => {
  try {
    const userId = req.params.userId;
    const { paymentStatus } = req.body;

    if (!userId) {
      return res.status(400).json({
        success: false,
        message: "userId is required",
      });
    }

    const validStatus = ["TRIAL", "UNPAID", "PAID", "OVER_DUE", "OTHERS"];

    if (!paymentStatus || !validStatus.includes(paymentStatus)) {
      return res.status(400).json({
        success: false,
        message: `Invalid or missing paymentStatus. Must be one of: ${validStatus.join(", ")}`,
      });
    }

    const user = await User.findById(userId);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "Player not found",
      });
    }

    user.paymentStatus = paymentStatus;
    await user.save();

    res.status(200).json({
      success: true,
      message: `Payment status updated to ${paymentStatus} successfully`,
      data: user,
    });

  } catch (err) {
    res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

exports.updatePlayerRating = async (req, res) => {
  try {
    const { userId } = req.params;
    const { rating } = req.body;

    if (rating === undefined || rating < 1 || rating > 5) {
      return res.status(400).json({
        message: "Rating must be between 1 and 5",
      });
    }

    const user = await User.findById(userId);

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    user.rating = rating;
    await user.save();

    res.json({
      message: "Player rating updated successfully",
      data: { rating: user.rating },
    });

  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.assignClassToUser = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { userId } = req.params;
    const { classId } = req.body;
    console.log("Assigning class to user:", userId);
    console.log("Class ID:", classId);
    const user = await User.findById(userId).session(session);
    const classData = await Class.findById(classId).session(session);

    if (!user) throw new Error("User not found");
    if (!classData) throw new Error("Class not found");

    // ✅ Validate program & category
    const userProgramIds = (user.programs || []).map(p => p.toString());
    if (
      !userProgramIds.includes(classData.program.toString()) ||
      user.category.toString() !== classData.category.toString()
    ) {
      throw new Error("User not eligible for this class");
    }

    // ✅ Prevent duplicate
    const alreadyAssigned = classData.players.some(
      (id) => id.toString() === userId
    );
    console.log("Already assigned:", alreadyAssigned);
    if (alreadyAssigned) {
      throw new Error("User already assigned");
    }

    // ✅ Capacity safe update
    const updatedClass = await Class.findOneAndUpdate(
      {
        _id: classId,
        $expr: {
          $lt: [{ $size: "$players" }, "$capacity"],
        },
      },
      {
        $addToSet: { players: userId },
      },
      { new: true, session }
    );

    if (!updatedClass) {
      throw new Error("Class is full");
    }

    // ✅ Update user
    if (!user.assignedClasses.some(id => id.toString() === classId)) {
      user.assignedClasses.push(classId);
    }

    if (user.removedClasses) {
      user.removedClasses = user.removedClasses.filter(id => id.toString() !== classId.toString());
    }

    if (!user.term) {
      user.term = classData.term;
    }

    await user.save({ session });

    await session.commitTransaction();
    session.endSession();

    // ✅ Automatic Invoice Generation on Class Assignment
    try {
      await generateClassInvoice({ userId, classId });
    } catch (invErr) {
      console.error("Auto invoice generation error in assignClassToUser:", invErr.message);
    }

    res.json({ message: "Class assigned successfully" });

  } catch (err) {
    await session.abortTransaction();
    session.endSession();

    res.status(400).json({ message: err.message });
  }
};

exports.removeClassFromUser = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const userId = req.params?.userId || req.params?.playerId || req.body?.userId || req.body?.playerId;
    const classId = req.params?.classId || req.body?.classId;

    if (!userId || !classId) {
      throw new Error("Both userId/playerId and classId are required");
    }

    const user = await User.findById(userId).session(session);
    const classData = await Class.findById(classId).session(session);

    if (!user) throw new Error("Player not found");
    if (!classData) throw new Error("Class not found");

    // Remove classId from user.assignedClasses
    user.assignedClasses = (user.assignedClasses || []).filter(
      (c) => c.toString() !== classId.toString()
    );

    // Add classId to user.removedClasses for attendance history tracking
    user.removedClasses = user.removedClasses || [];
    if (!user.removedClasses.some((c) => c.toString() === classId.toString())) {
      user.removedClasses.push(classId);
    }

    // Remove userId from classData.players
    classData.players = (classData.players || []).filter(
      (p) => p.toString() !== userId.toString()
    );

    await user.save({ session });
    await classData.save({ session });

    await session.commitTransaction();
    session.endSession();

    res.status(200).json({
      success: true,
      message: "Player removed from class successfully",
      data: {
        userId,
        classId,
        assignedClasses: user.assignedClasses,
        removedClasses: user.removedClasses,
      },
    });
  } catch (err) {
    await session.abortTransaction();
    session.endSession();

    res.status(400).json({
      success: false,
      message: err.message,
    });
  }
};

// ✅ Transfer Player from One Class to Another Class (Admin)
exports.transferPlayerClass = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const userId = req.params?.userId || req.params?.playerId || req.body?.userId || req.body?.playerId;
    const { fromClassId, toClassId } = req.body;

    if (!userId || !fromClassId || !toClassId) {
      return res.status(400).json({
        success: false,
        message: "userId/playerId, fromClassId, and toClassId are required",
      });
    }

    if (fromClassId.toString() === toClassId.toString()) {
      return res.status(400).json({
        success: false,
        message: "fromClassId and toClassId cannot be the same class",
      });
    }

    const user = await User.findById(userId).session(session);
    const fromClass = await Class.findById(fromClassId).session(session);
    const toClass = await Class.findById(toClassId).session(session);

    if (!user) {
      return res.status(404).json({ success: false, message: "Player not found" });
    }
    if (!fromClass) {
      return res.status(404).json({ success: false, message: "Previous class (fromClass) not found" });
    }
    if (!toClass) {
      return res.status(404).json({ success: false, message: "Target class (toClass) not found" });
    }

    // Check if player is currently in fromClass
    const isAssigned = (user.assignedClasses || []).some(
      (c) => c.toString() === fromClassId.toString()
    );

    if (!isAssigned) {
      return res.status(400).json({
        success: false,
        message: "Player is not currently assigned to the specified fromClass",
      });
    }

    // Check capacity for toClass if capacity is defined
    if (toClass.capacity && toClass.players.length >= toClass.capacity) {
      return res.status(400).json({
        success: false,
        message: "Target class is at maximum capacity",
      });
    }

    // 1. Remove fromClassId from user.assignedClasses
    user.assignedClasses = (user.assignedClasses || []).filter(
      (c) => c.toString() !== fromClassId.toString()
    );

    // 2. Add fromClassId to user.removedClasses
    user.removedClasses = user.removedClasses || [];
    if (!user.removedClasses.some((c) => c.toString() === fromClassId.toString())) {
      user.removedClasses.push(fromClassId);
    }

    // 3. Add toClassId to user.assignedClasses
    if (!user.assignedClasses.some((c) => c.toString() === toClassId.toString())) {
      user.assignedClasses.push(toClassId);
    }

    // 4. Remove toClassId from user.removedClasses if previously removed
    user.removedClasses = user.removedClasses.filter(
      (c) => c.toString() !== toClassId.toString()
    );

    // 5. Remove userId from fromClass.players roster
    fromClass.players = (fromClass.players || []).filter(
      (p) => p.toString() !== userId.toString()
    );

    // 6. Add userId to toClass.players roster
    if (!toClass.players.some((p) => p.toString() === userId.toString())) {
      toClass.players.push(userId);
    }

    await user.save({ session });
    await fromClass.save({ session });
    await toClass.save({ session });

    await session.commitTransaction();
    session.endSession();

    // 7. Auto Invoice Generation if new class price > previous class price
    let transferInvoiceResult = { invoice: null, priceDiff: 0, invoiceGenerated: false };
    try {
      transferInvoiceResult = await generateTransferInvoice({
        userId,
        fromClass,
        toClass,
      });
    } catch (invErr) {
      console.error("Auto transfer invoice error:", invErr.message);
    }

    return res.status(200).json({
      success: true,
      message: transferInvoiceResult.invoiceGenerated
        ? `Player transferred successfully. Invoice #${transferInvoiceResult.invoice.invoiceNumber} generated for price difference ($${transferInvoiceResult.priceDiff}).`
        : "Player transferred to new class successfully. No invoice required.",
      data: {
        player: user,
        fromClass: { _id: fromClass._id, name: fromClass.name, price: fromClass.price },
        toClass: { _id: toClass._id, name: toClass.name, price: toClass.price },
        priceDifference: transferInvoiceResult.priceDiff,
        invoiceGenerated: transferInvoiceResult.invoiceGenerated,
        invoice: transferInvoiceResult.invoice,
      },
    });

  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

exports.assignCoachToClass = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { classId } = req.params;
    const { coachId } = req.body;

    const classData = await Class.findById(classId).session(session);
    const coach = await Admin.findById(coachId).session(session);

    if (!classData) throw new Error("Class not found");
    if (!coach) throw new Error("Coach not found");

    // ✅ Optional: check role
    if (coach.role !== "COACH") {
      throw new Error("User is not a coach");
    }

    if (coach.isActive === false) {
      throw new Error("Coach is inactive and cannot be assigned to class");
    }

    // ✅ Assign coach (overwrite or prevent duplicate)
    classData.coach = coachId;

    await classData.save({ session });

    await session.commitTransaction();
    session.endSession();

    res.json({
      message: "Coach assigned successfully",
      data: classData,
    });

  } catch (err) {
    await session.abortTransaction();
    session.endSession();

    res.status(400).json({ message: err.message });
  }
};

exports.createBanner = async (req, res) => {
  try {
    const { title, subtitle, link } = req.body;

    let bannerImg = null;

    if (req.file) {
      bannerImg = `uploads/bannerImg/${req.file.filename}`;
    }

    const banner = await Banner.create({
      title,
      subtitle,
      link,
      image: bannerImg,
      createdBy: req.admin?._id,
    });

    res.status(201).json({
      success: true,
      message: "Banner created successfully",
      data: banner,
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

// UPDATE
exports.updateBanner = async (req, res) => {
  try {
    const { id } = req.params;

    const banner = await Banner.findById(id);
    if (!banner) {
      return res.status(404).json({
        success: false,
        message: "Banner not found",
      });
    }

    // delete old image if new one uploaded
    if (req.file && banner.image) {
      const oldPath = path.join(__dirname, "..", banner.image);

      if (fs.existsSync(oldPath)) {
        fs.unlink(oldPath, (err) => {
          if (err) console.log("Error deleting file:", err);
        });
      }
    }

    const updated = await Banner.findByIdAndUpdate(
      id,
      {
        ...req.body,
        ...(req.file && { image: `uploads/bannerImg/${req.file.filename}` }),
      },
      { new: true }
    );

    res.json({
      success: true,
      message: "Banner updated successfully",
      data: updated,
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

// DELETE
exports.deleteBanner = async (req, res) => {
  try {
    const { id } = req.params;

    const banner = await Banner.findById(id);
    if (!banner) {
      return res.status(404).json({
        success: false,
        message: "Banner not found",
      });
    }

    // delete image safely
    if (banner.image) {
      const filePath = path.join(__dirname, "..", banner.image);

      if (fs.existsSync(filePath)) {
        fs.unlink(filePath, (err) => {
          if (err) console.log("File delete error:", err);
        });
      }
    }

    await Banner.findByIdAndDelete(id);

    res.json({
      success: true,
      message: "Banner deleted successfully",
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

// GET ALL
exports.getAllBanners = async (req, res) => {
  try {
    const { page = 1, limit = 10, isActive } = req.query;

    const filter = {};
    if (isActive !== undefined) {
      filter.isActive = isActive;
    }

    const banners = await Banner.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(Number(limit));

    const total = await Banner.countDocuments(filter);

    res.json({
      success: true,
      total,
      page: Number(page),
      data: banners,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// TOGGLE ACTIVE
exports.toggleBannerStatus = async (req, res) => {
  try {
    const { id } = req.params;

    const banner = await Banner.findById(id);

    banner.isActive = !banner.isActive;
    await banner.save();

    res.json({
      success: true,
      message: "Banner status updated",
      data: banner,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.exportUsers = async (req, res) => {
  try {
    let {
      paymentStatus,
      search = "",
      format = "csv",
      userIds = [],
    } = req.body;

    // Validate paymentStatus
    const validPaymentStatus = ["TRIAL", "UNPAID", "PAID", "OVER_DUE"];
    if (paymentStatus && !validPaymentStatus.includes(paymentStatus)) {
      return res.status(400).json({ message: "Invalid paymentStatus" });
    }

    const query = {};

    // Selected users (single or multiple)
    if (userIds && userIds.length > 0) {
      query._id = { $in: userIds };
    }

    // Filters
    if (paymentStatus) {
      query.paymentStatus = paymentStatus;
    }

    if (search) {
      query.$or = [
        { fullName: { $regex: search, $options: "i" } },
        { email: { $regex: search, $options: "i" } },
        { phone: { $regex: search, $options: "i" } },
      ];
    }

    // Fetch Users
    const users = await User.find(query)
      .select("-password -tokens")
      .sort({ createdAt: -1 });

    if (!users.length) {
      return res.status(404).json({ message: "No users found" });
    }

    // Format Data
    const data = users.map((u) => ({
      Name: u.fullName || "",
      Email: u.email || "",
      Phone: u.phone || "",
      PaymentStatus: u.paymentStatus || "",
      SkillLevel: u.skillLevel || "",
      Rating: u.rating || 1,
      Club: u.club || "",
      DOB: u.dob ? new Date(u.dob).toLocaleDateString() : "",
      ContactName: u.contactName || "",
      Comments: u.comments || "",
      CreatedAt: new Date(u.createdAt).toLocaleString(),
    }));

    // ================= CSV =================
    if (format === "csv") {
      const csv = [
        Object.keys(data[0]).join(","),
        ...data.map((row) =>
          Object.values(row)
            .map((val) => `"${val}"`)
            .join(",")
        ),
      ].join("\n");

      res.header("Content-Type", "text/csv");
      res.attachment("users.csv");
      return res.send(csv);
    }

    // ================= EXCEL =================
    if (format === "excel") {
      const workbook = new ExcelJS.Workbook();
      const worksheet = workbook.addWorksheet("Users");

      worksheet.columns = Object.keys(data[0]).map((key) => ({
        header: key,
        key: key,
        width: 25,
      }));

      data.forEach((row) => {
        worksheet.addRow(row);
      });

      worksheet.getRow(1).font = { bold: true };

      res.header(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      );
      res.attachment("users.xlsx");

      await workbook.xlsx.write(res);
      return res.end();
    }

    // ❌ Invalid format
    return res.status(400).json({
      message: "Invalid format (csv/excel)",
    });

  } catch (err) {
    res.status(500).json({
      message: err.message,
    });
  }
};


exports.createCategory = async (req, res) => {
  try {
    const { name, isEvent } = req.body;

    if (!name) {
      return res.status(400).json({
        message: "Category name is required",
      });
    }

    const existing = await Category.findOne({
      name: name.toUpperCase(),
    });

    if (existing) {
      return res.status(400).json({
        message: "Category already exists",
      });
    }

    const categoryData = {
      name: name.toUpperCase(),
    };

    if (isEvent === true) {
      categoryData.isEvent = true;
    }

    const category = await Category.create(categoryData);

    res.json({
      message: "Category created successfully",
      category,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

/**
 * PUT /api/admin/updateCategory/:id
 * Update category name only.
 */
exports.updateCategory = async (req, res) => {
  try {
    const { id } = req.params;
    const { name } = req.body;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid category ID",
      });
    }

    if (!name || !name.trim()) {
      return res.status(400).json({
        success: false,
        message: "Category name is required",
      });
    }

    const category = await Category.findById(id);
    if (!category) {
      return res.status(404).json({
        success: false,
        message: "Category not found",
      });
    }

    // Check for duplicate name (excluding current category)
    const existing = await Category.findOne({
      name: name.toUpperCase(),
      _id: { $ne: id },
    });

    if (existing) {
      return res.status(400).json({
        success: false,
        message: "A category with this name already exists",
      });
    }

    category.name = name.toUpperCase();
    await category.save();

    res.json({
      success: true,
      message: "Category updated successfully",
      category,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * DELETE /api/admin/deleteCategory/:id
 * Delete category if it is not connected to any Class, Program, User, or RegistrationRequest.
 */
exports.deletecatCategory = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid category ID",
      });
    }

    const category = await Category.findById(id);
    if (!category) {
      return res.status(404).json({
        success: false,
        message: "Category not found",
      });
    }

    // Check references across connected entities in parallel
    const [
      classCount,
      programCount,
      userCount,
      registrationRequestCount,
    ] = await Promise.all([
      Class.countDocuments({ category: id }),
      Program.countDocuments({ category: id }),
      User.countDocuments({
        $or: [{ category: id }, { categories: id }],
      }),
      RegistrationRequest.countDocuments({
        $or: [{ category: id }, { preferredCategories: id }],
      }),
    ]);

    const totalUsage =
      classCount + programCount + userCount + registrationRequestCount;

    if (totalUsage > 0) {
      const connections = [];
      if (classCount > 0) connections.push(`${classCount} class(es)`);
      if (programCount > 0) connections.push(`${programCount} program(s)`);
      if (userCount > 0) connections.push(`${userCount} player(s)`);
      if (registrationRequestCount > 0)
        connections.push(`${registrationRequestCount} registration request(s)`);

      return res.status(400).json({
        success: false,
        message: `Cannot delete category as it is currently connected to: ${connections.join(", ")}`,
        data: {
          classCount,
          programCount,
          userCount,
          registrationRequestCount,
        },
      });
    }

    await Category.findByIdAndDelete(id);

    return res.status(200).json({
      success: true,
      message: "Category deleted successfully",
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};


exports.createProgram = async (req, res) => {
  try {
    const { name, category } = req.body;

    if (!name || !category) {
      return res.status(400).json({
        message: "Name and category are required",
      });
    }

    if (!mongoose.Types.ObjectId.isValid(category)) {
      return res.status(400).json({
        message: "Invalid category ID",
      });
    }

    const categoryData = await Category.findById(category);
    if (!categoryData) {
      return res.status(400).json({
        message: "Category not found",
      });
    }

    const existing = await Program.findOne({
      name: name,
      category: category,
    });

    if (existing) {
      return res.status(400).json({
        message: "Program already exists in this category",
      });
    }

    const program = await Program.create({
      name,
      category,
    });

    res.json({
      message: "Program created successfully",
      program,
    });

  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

/**
 * PUT /api/admin/updateProgram/:id
 * Update program name only.
 */
exports.updateProgram = async (req, res) => {
  try {
    const { id } = req.params;
    const { name } = req.body;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid program ID",
      });
    }

    if (!name || !name.trim()) {
      return res.status(400).json({
        success: false,
        message: "Program name is required",
      });
    }

    const program = await Program.findById(id);
    if (!program) {
      return res.status(404).json({
        success: false,
        message: "Program not found",
      });
    }

    // Check for duplicate name within the same category
    const existing = await Program.findOne({
      name: name,
      category: program.category,
      _id: { $ne: id },
    });

    if (existing) {
      return res.status(400).json({
        success: false,
        message: "A program with this name already exists in this category",
      });
    }

    program.name = name;
    await program.save();

    res.json({
      success: true,
      message: "Program updated successfully",
      program,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * DELETE /api/admin/deleteProgram/:id
 * Delete program if it is not connected to any Class, User, or RegistrationRequest.
 */
exports.deleteProgram = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid program ID",
      });
    }

    const program = await Program.findById(id);
    if (!program) {
      return res.status(404).json({
        success: false,
        message: "Program not found",
      });
    }

    // Check references across connected entities in parallel
    const [
      classCount,
      userCount,
      registrationRequestCount,
    ] = await Promise.all([
      Class.countDocuments({ program: id }),
      User.countDocuments({ programs: id }),
      RegistrationRequest.countDocuments({ preferredPrograms: id }),
    ]);

    const totalUsage = classCount + userCount + registrationRequestCount;

    if (totalUsage > 0) {
      const connections = [];
      if (classCount > 0) connections.push(`${classCount} class(es)`);
      if (userCount > 0) connections.push(`${userCount} player(s)`);
      if (registrationRequestCount > 0)
        connections.push(`${registrationRequestCount} registration request(s)`);

      return res.status(400).json({
        success: false,
        message: `Cannot delete program as it is currently connected to: ${connections.join(", ")}`,
        data: {
          classCount,
          userCount,
          registrationRequestCount,
        },
      });
    }

    await Program.findByIdAndDelete(id);

    return res.status(200).json({
      success: true,
      message: "Program deleted successfully",
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

exports.createTerm = async (req, res) => {
  try {
    const { name, year, startDate, endDate, isEvent } = req.body;

    const parseDate = (dateStr) => {
      const [day, month, year] = dateStr.split("/").map(Number);
      return new Date(year, month - 1, day);
    };

    const termData = {
      name,
      year,
      startDate: parseDate(startDate),
      endDate: parseDate(endDate),
    };

    // Only set if provided, otherwise schema default (false) will be used
    if (isEvent === true) {
      termData.isEvent = true;
    }

    const term = await Term.create(termData);

    res.json({
      message: "Term created successfully",
      data: term,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

/**
 * DELETE /api/admin/deleteTerm/:id
 * Delete a Term only if it is NOT connected to any Class, User, or RegistrationRequest.
 */
exports.deleteTerm = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid term ID",
      });
    }

    const term = await Term.findById(id);
    if (!term) {
      return res.status(404).json({
        success: false,
        message: "Term not found",
      });
    }

    // Check references across connected entities in parallel
    const [
      classCount,
      userCount,
      registrationRequestCount,
    ] = await Promise.all([
      Class.countDocuments({ term: id }),
      User.countDocuments({ term: id }),
      RegistrationRequest.countDocuments({ preferredTerm: id }),
    ]);

    const totalUsage = classCount + userCount + registrationRequestCount;

    if (totalUsage > 0) {
      const connections = [];
      if (classCount > 0) connections.push(`${classCount} class(es)`);
      if (userCount > 0) connections.push(`${userCount} player(s)`);
      if (registrationRequestCount > 0)
        connections.push(`${registrationRequestCount} registration request(s)`);

      return res.status(400).json({
        success: false,
        message: `Cannot delete term as it is currently connected to: ${connections.join(", ")}`,
        data: {
          classCount,
          userCount,
          registrationRequestCount,
        },
      });
    }

    await Term.findByIdAndDelete(id);

    return res.status(200).json({
      success: true,
      message: "Term deleted successfully",
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

exports.getAllTerms = async (req, res) => {
  try {
    const { isEvent, year } = req.query;

    const filter = {};

    // Event filter
    if (isEvent === "true") {
      filter.isEvent = true;
    } else if (isEvent === "false" || isEvent === undefined) {
      filter.isEvent = false;
    }
    // If isEvent === "all", don't apply event filter

    // Year filter
    if (year) {
      filter.year = Number(year);
    }

    const terms = await Term.find(filter).sort({
      year: 1,
      startDate: 1,
    });

    res.json({
      data: terms,
    });
  } catch (err) {
    res.status(500).json({
      message: err.message,
    });
  }
};

exports.getTermById = async (req, res) => {
  try {
    const term = await Term.findById(req.params.id);

    if (!term) {
      return res.status(404).json({ message: "Term not found" });
    }

    res.json({ data: term });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.updateTerm = async (req, res) => {
  try {
    const { name, year, startDate, endDate } = req.body;

    const parseDate = (dateStr) => {
      if (!dateStr) return undefined;

      // Handle dd/mm/yyyy
      if (dateStr.includes("/")) {
        const [day, month, year] = dateStr.split("/").map(Number);
        return new Date(year, month - 1, day);
      }

      // Handle ISO format
      return new Date(dateStr);
    };

    const updatedData = {
      name,
      year,
    };

    if (startDate) updatedData.startDate = parseDate(startDate);
    if (endDate) updatedData.endDate = parseDate(endDate);

    // ✅ Validate dates
    if (
      updatedData.startDate &&
      updatedData.endDate &&
      updatedData.startDate > updatedData.endDate
    ) {
      return res.status(400).json({
        message: "Start date cannot be after end date",
      });
    }

    const term = await Term.findByIdAndUpdate(
      req.params.id,
      updatedData,
      { new: true, runValidators: true }
    );

    if (!term) {
      return res.status(404).json({ message: "Term not found" });
    }

    res.json({
      message: "Term updated successfully",
      data: term,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};


exports.createClass = async (req, res) => {
  try {
    const {
      name,
      term,
      program,
      category,
      dayOfWeek,
      startTime,
      endTime,
      location,
      coach,
      capacity,
      price,
    } = req.body;

    if (price !== undefined && price !== null) {
      const numPrice = Number(price);
      if (isNaN(numPrice) || numPrice < 0) {
        return res.status(400).json({
          message: "Price must be a non-negative number",
        });
      }
    }

    if (
      !term ||
      !program ||
      !category ||
      !dayOfWeek ||
      !startTime ||
      !endTime ||
      !location ||
      !coach ||
      !capacity
    ) {
      return res.status(400).json({
        message: "Required fields missing",
      });
    }

    const termData = await Term.findById(term);
    if (!termData) throw new Error("Term not found");

    const programData = await Program.findById(program);
    if (!programData) throw new Error("Program not found");

    if (programData.category.toString() !== category.toString()) {
      return res.status(400).json({
        message: "Program does not belong to category",
      });
    }

    const validDays = [
      "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"
    ];

    const day = dayOfWeek.toUpperCase();

    if (!validDays.includes(day)) {
      return res.status(400).json({ message: "Invalid day" });
    }

    const toMinutes = (t) => {
      const [h, m] = t.split(":").map(Number);
      return h * 60 + m;
    };

    if (toMinutes(startTime) >= toMinutes(endTime)) {
      return res.status(400).json({
        message: "Start time must be before end time",
      });
    }

    const coachData = await Admin.findById(coach);
    if (!coachData) {
      return res.status(400).json({ message: "Coach not found" });
    }
    if (coachData.role !== "COACH") {
      return res.status(400).json({ message: "Assigned user is not a coach" });
    }
    if (coachData.isActive === false) {
      return res.status(400).json({ message: "Coach is inactive and cannot be assigned to classes" });
    }

    // ✅ Overlapping check
    const overlap = await Class.findOne({
      coach,
      term,
      dayOfWeek: day,
      startTime: { $lt: endTime },
      endTime: { $gt: startTime },
    });

    if (overlap) {
      return res.status(400).json({
        message: "Coach already has overlapping class",
      });
    }

    const classData = await Class.create({
      name,
      term,
      program,
      category,
      dayOfWeek: day,
      startTime,
      endTime,
      location,
      coach,
      capacity,
      price: price !== undefined && price !== null ? Number(price) : 0,
    });

    res.json({
      message: "Class created successfully",
      data: classData,
    });

  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

/**
 * DELETE /api/admin/deleteClass/:id or DELETE /api/admin/class/:id
 * Permanently deletes a Class and cascades deletion across all related models:
 * - Unassigns and removes classId from all users (assignedClasses, removedClasses, temporaryClass)
 * - Deletes all Attendance records for this class
 * - Deletes all AttendanceHistory records for this class
 * - Deletes all CoachNotes for this class
 * - Deletes all TrainingSessions for this class
 * - Deletes all associated ChatRooms and their Messages (including attachment files on disk)
 * - Removes classId from RegistrationRequests' preferredClasses
 * - Preserves Invoices for billing/financial history
 * - Deletes the Class document itself
 * - Logs AuditLog for admin action tracking
 */
exports.deleteClassPermanently = async (req, res) => {
  try {
    const { id } = req.params;
    const adminId = req.admin ? req.admin._id : null;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid class ID",
      });
    }

    const cls = await Class.findById(id);
    if (!cls) {
      return res.status(404).json({
        success: false,
        message: "Class not found",
      });
    }

    // 1. Find all ChatRooms for this class to clean up messages and attachments
    const chatRooms = await ChatRoom.find({ classId: id });
    const chatRoomIds = chatRooms.map((r) => r._id);

    if (chatRoomIds.length > 0) {
      const messages = await Message.find({ room: { $in: chatRoomIds } });
      messages.forEach((msg) => {
        if (msg.attachments && Array.isArray(msg.attachments)) {
          msg.attachments.forEach((att) => {
            if (att.url && att.url.startsWith("/uploads/")) {
              const filePath = path.join(__dirname, "..", att.url);
              if (fs.existsSync(filePath)) {
                try {
                  fs.unlinkSync(filePath);
                } catch (e) { }
              }
            }
          });
        }
      });

      await Message.deleteMany({ room: { $in: chatRoomIds } });
      await ChatRoom.deleteMany({ classId: id });
    }

    // 2. Clean up references in User (Player) documents
    await User.updateMany(
      { $or: [{ assignedClasses: id }, { removedClasses: id }, { temporaryClass: id }] },
      {
        $pull: { assignedClasses: id, removedClasses: id },
        $unset: { temporaryClass: 1 },
      }
    );

    // 3. Clean up references in RegistrationRequest documents
    await RegistrationRequest.updateMany(
      { preferredClasses: id },
      { $pull: { preferredClasses: id } }
    );

    // 4. Delete Attendance & AttendanceHistory
    const attendanceDeleteResult = await Attendance.deleteMany({ class: id });
    const attendanceHistoryDeleteResult = await AttendanceHistory.deleteMany({ classId: id });

    // 5. Delete CoachNotes
    const coachNotesDeleteResult = await CoachNote.deleteMany({ classId: id });

    // 6. Delete TrainingSessions
    const trainingSessionsDeleteResult = await TrainingSession.deleteMany({
      $or: [{ class: id }, { classId: id }],
    });

    // 7. Delete the Class document itself (Invoices are preserved for billing history)
    await Class.findByIdAndDelete(id);

    // 8. Audit log
    if (adminId) {
      await AuditLog.create({
        user: adminId,
        userRole: req.admin?.role || "SUPER_ADMIN",
        action: "CLASS_DELETED_PERMANENTLY",
        entityType: "Class",
        entityId: id,
        ipAddress: req.ip || "",
        deviceInfo: req.headers["user-agent"] || "",
        description: `Permanently deleted class '${cls.name}' (${id}) while preserving invoice records.`,
      });
    }

    return res.status(200).json({
      success: true,
      message: `Class '${cls.name}' and related class data deleted permanently (Invoices preserved)`,
      data: {
        classId: id,
        className: cls.name,
        attendanceDeletedCount: attendanceDeleteResult.deletedCount || 0,
        attendanceHistoryDeletedCount: attendanceHistoryDeleteResult.deletedCount || 0,
        coachNotesDeletedCount: coachNotesDeleteResult.deletedCount || 0,
        trainingSessionsDeletedCount: trainingSessionsDeleteResult.deletedCount || 0,
        chatRoomsDeletedCount: chatRooms.length,
      },
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

exports.getAllClasses = async (req, res) => {
  try {
    let {
      termId,
      day,
      programId,
      categoryId,
      search = "",
      page = 1,
      limit = 20,
    } = req.query;

    page = Number(page) || 1;
    limit = Number(limit) || 20;

    let filter = {};

    const selectedTerm = termId;
    const selectedDay = day;
    const selectedProgram = programId;
    const selectedCategory = categoryId;

    if (selectedTerm) filter.term = selectedTerm;
    if (selectedDay) {
      filter.dayOfWeek = { $regex: new RegExp(`^${selectedDay}$`, "i") };
    }
    if (selectedProgram) filter.program = selectedProgram;
    if (selectedCategory) filter.category = selectedCategory;
    if (search) {
      filter.name = { $regex: search, $options: "i" };
    }

    const total = await Class.countDocuments(filter);

    const classes = await Class.find(filter)
      .populate("term program category coach assistantCoach")
      .sort({ dayOfWeek: 1, startTime: 1 })
      .skip((page - 1) * limit)
      .limit(limit);

    res.json({
      success: true,
      message: "Classes fetched successfully",
      totalClasses: total,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      data: classes,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.getAllClassesForAssign = async (req, res) => {
  try {
    const { term, dayOfWeek, program, category } = req.query;

    let filter = {};

    if (term) filter.term = term;
    if (dayOfWeek) filter.dayOfWeek = dayOfWeek;
    if (program) filter.program = program;
    if (category) filter.category = category;

    const classes = await Class.find(filter)
      .select("-players") // ✅ EXCLUDE players field
      .sort({ dayOfWeek: 1, startTime: 1 });

    res.json({ data: classes });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.getClassById = async (req, res) => {
  try {
    const classData = await Class.findById(req.params.id)
      .populate("term program category coach players");

    if (!classData) {
      return res.status(404).json({ message: "Class not found" });
    }

    res.json({ data: classData });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.updateClass = async (req, res) => {
  try {
    const {
      name,
      term,
      program,
      category,
      dayOfWeek,
      startTime,
      endTime,
      location,
      coach,
      capacity,
      price,
    } = req.body;

    if (price !== undefined && price !== null) {
      const numPrice = Number(price);
      if (isNaN(numPrice) || numPrice < 0) {
        return res.status(400).json({
          message: "Price must be a non-negative number",
        });
      }
    }

    const updatedData = {};

    // ✅ Assign only provided fields
    if (name) updatedData.name = name;
    if (location) updatedData.location = location;

    // ✅ Validate ObjectIds (only if provided)
    if (term) {
      if (!mongoose.Types.ObjectId.isValid(term)) {
        return res.status(400).json({ message: "Invalid term ID" });
      }
      const termData = await Term.findById(term);
      if (!termData) {
        return res.status(400).json({ message: "Term not found" });
      }
      updatedData.term = term;
    }

    if (program) {
      if (!mongoose.Types.ObjectId.isValid(program)) {
        return res.status(400).json({ message: "Invalid program ID" });
      }
      const programData = await Program.findById(program);
      if (!programData) {
        return res.status(400).json({ message: "Program not found" });
      }
      updatedData.program = program;

      // If category also provided, validate relation
      if (category) {
        if (programData.category.toString() !== category) {
          return res.status(400).json({
            message: "Program does not belong to selected category",
          });
        }
      }
    }

    if (category) {
      if (!mongoose.Types.ObjectId.isValid(category)) {
        return res.status(400).json({ message: "Invalid category ID" });
      }
      const categoryData = await Category.findById(category);
      if (!categoryData) {
        return res.status(400).json({ message: "Category not found" });
      }
      updatedData.category = category;
    }

    if (coach) {
      if (!mongoose.Types.ObjectId.isValid(coach)) {
        return res.status(400).json({ message: "Invalid coach ID" });
      }
      const coachData = await Admin.findById(coach);
      if (!coachData) {
        return res.status(400).json({ message: "Coach not found" });
      }
      if (coachData.role !== "COACH") {
        return res.status(400).json({ message: "Assigned user is not a coach" });
      }
      if (coachData.isActive === false) {
        return res.status(400).json({ message: "Coach is inactive and cannot be assigned to classes" });
      }
      updatedData.coach = coach;
    }

    // ✅ Day validation
    if (dayOfWeek) {
      const validDays = [
        "MONDAY",
        "TUESDAY",
        "WEDNESDAY",
        "THURSDAY",
        "FRIDAY",
        "SATURDAY",
        "SUNDAY",
      ];

      if (!validDays.includes(dayOfWeek)) {
        return res.status(400).json({
          message: "Invalid day of week",
        });
      }

      updatedData.dayOfWeek = dayOfWeek;
    }

    // ✅ Time validation
    const timeRegex = /^([01]\d|2[0-3]):([0-5]\d)$/;

    if (startTime) {
      if (!timeRegex.test(startTime)) {
        return res.status(400).json({
          message: "Start time must be HH:mm format",
        });
      }
      updatedData.startTime = startTime;
    }

    if (endTime) {
      if (!timeRegex.test(endTime)) {
        return res.status(400).json({
          message: "End time must be HH:mm format",
        });
      }
      updatedData.endTime = endTime;
    }

    // ✅ Validate time logic if both present
    if (startTime && endTime) {
      const toMinutes = (t) => {
        const [h, m] = t.split(":").map(Number);
        return h * 60 + m;
      };

      if (toMinutes(startTime) >= toMinutes(endTime)) {
        return res.status(400).json({
          message: "Start time must be before end time",
        });
      }
    }

    // ✅ Capacity validation
    if (capacity !== undefined) {
      if (capacity < 1 || capacity > 200) {
        return res.status(400).json({
          message: "Capacity must be between 1 and 200",
        });
      }
      updatedData.capacity = capacity;
    }

    // ✅ Price validation
    if (price !== undefined && price !== null) {
      updatedData.price = Number(price);
    }

    // ✅ Prevent coach conflict (if relevant fields updated)
    if (coach || dayOfWeek || startTime || endTime) {
      const existing = await Class.findOne({
        _id: { $ne: req.params.id },
        coach: coach || undefined,
        dayOfWeek: dayOfWeek || undefined,
        startTime: startTime || undefined,
        endTime: endTime || undefined,
      });

      if (existing) {
        return res.status(400).json({
          message: "Coach already has a class at this time",
        });
      }
    }

    const classData = await Class.findByIdAndUpdate(
      req.params.id,
      updatedData,
      { new: true, runValidators: true }
    );

    if (!classData) {
      return res.status(404).json({ message: "Class not found" });
    }

    res.json({
      message: "Class updated successfully",
      data: classData,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.getCurrentYearTerms = async (req, res) => {
  try {
    const currentYear = new Date().getFullYear();

    const terms = await Term.find({ year: currentYear }).sort({
      startDate: 1,
    });

    res.json({
      message: "Current year terms fetched successfully",
      count: terms.length,
      data: terms,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.getClassesByTerm = async (req, res) => {
  try {
    const { termId } = req.params;

    // ✅ Validate ID
    if (!mongoose.Types.ObjectId.isValid(termId)) {
      return res.status(400).json({ message: "Invalid term ID" });
    }

    // ✅ Check term exists
    const term = await Term.findById(termId);
    if (!term) {
      return res.status(404).json({ message: "Term not found" });
    }

    const classes = await Class.find({ term: termId })
      .populate("program", "name")
      .populate("category", "name")
      .populate("coach", "fullName")
      .sort({ dayOfWeek: 1, startTime: 1 });

    res.json({
      message: "Classes fetched successfully",
      term: term.name,
      count: classes.length,
      data: classes,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

const generateClassSessions = (term, classObj) => {
  const sessions = [];

  const start = new Date(term.startDate);
  start.setUTCHours(0, 0, 0, 0);

  const end = new Date(term.endDate);
  end.setUTCHours(0, 0, 0, 0);

  const dayMap = {
    SUNDAY: 0,
    MONDAY: 1,
    TUESDAY: 2,
    WEDNESDAY: 3,
    THURSDAY: 4,
    FRIDAY: 5,
    SATURDAY: 6,
  };

  const targetDay = dayMap[classObj.dayOfWeek];

  let current = new Date(start);

  // move to correct weekday (UTC)
  while (current.getUTCDay() !== targetDay) {
    current.setUTCDate(current.getUTCDate() + 1);
  }

  // weekly loop
  while (current <= end) {
    sessions.push(new Date(current));

    current.setUTCDate(current.getUTCDate() + 7);
  }

  return sessions;
};

exports.getClassSessions = async (req, res) => {
  try {
    const classData = await Class.findById(req.params.classId).populate("term");

    if (!classData) {
      return res.status(404).json({ message: "Class not found" });
    }

    const sessions = generateClassSessions(classData.term, classData);

    // ✅ Convert to UI format
    const formatted = sessions.map((date) => ({
      fullDate: date,
      day: date.getUTCDate(),
      month: date.getUTCMonth() + 1,
      year: date.getUTCFullYear(),
    }));

    // ✅ Group by month (VERY IMPORTANT)
    const grouped = {};

    formatted.forEach((s) => {
      const key = `${s.month}-${s.year}`;

      if (!grouped[key]) {
        grouped[key] = [];
      }

      grouped[key].push(s.day);
    });

    res.json({
      totalSessions: sessions.length,
      sessions: formatted,
      groupedByMonth: grouped,
    });

  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.markAttendance = async (req, res) => {
  try {
    const { classId } = req.params;
    const { sessionDate, records } = req.body;

    if (!sessionDate || !records?.length) {
      return res.status(400).json({
        message: "sessionDate and records are required",
      });
    }

    // ✅ normalize date (important)
    const date = new Date(sessionDate);
    date.setUTCHours(0, 0, 0, 0);

    let attendance = await Attendance.findOne({
      class: classId,
      sessionDate: date,
    });

    if (attendance) {
      attendance.records = records;
      attendance.markedBy = req.user?.id;

      await attendance.save();

      return res.json({
        message: "Attendance updated",
        data: attendance,
      });
    }

    attendance = await Attendance.create({
      class: classId,
      sessionDate: date,
      records,
      markedBy: req.user?.id,
    });

    res.json({
      message: "Attendance marked",
      data: attendance,
    });

  } catch (err) {
    if (err.code === 11000) {
      return res.status(400).json({
        message: "Attendance already exists",
      });
    }

    res.status(500).json({ message: err.message });
  }
};

exports.markSingleAttendance = async (req, res) => {
  try {
    const { classId } = req.params;
    const { sessionDate, playerId, status } = req.body;

    if (!sessionDate || !playerId || !status) {
      return res.status(400).json({
        message: "sessionDate, playerId and status are required",
      });
    }

    // ✅ normalize date (VERY IMPORTANT)
    const date = new Date(sessionDate);
    date.setUTCHours(0, 0, 0, 0);

    // ✅ find existing attendance for that session
    let attendance = await Attendance.findOne({
      class: classId,
      sessionDate: date,
    });

    // ✅ if not exists → create
    if (!attendance) {
      attendance = await Attendance.create({
        class: classId,
        sessionDate: date,
        records: [],
        markedBy: req.user?.id,
      });
    }

    // ✅ find player record
    const existingRecord = attendance.records.find(
      (r) => r.player.toString() === playerId
    );

    if (existingRecord) {
      // 🔁 update existing
      existingRecord.status = status;
    } else {
      // ➕ add new
      attendance.records.push({
        player: playerId,
        status,
      });
    }

    await attendance.save();

    res.json({
      message: "Attendance updated successfully",
      data: {
        classId,
        sessionDate: date,
        playerId,
        status,
      },
    });

  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};


exports.getAttendanceByClass = async (req, res) => {
  try {
    const { classId } = req.params;

    const data = await Attendance.find({ class: classId })
      .select("sessionDate records")
      .populate({
        path: "records.player",
        select: "fullName profile email phone",
      })
      .sort({ sessionDate: 1 });

    const attendanceMap = {};

    data.forEach((att) => {
      const date = att.sessionDate.toISOString().split("T")[0];

      attendanceMap[date] = {};

      att.records.forEach((r) => {
        const player = r.player;

        attendanceMap[date][player._id] = {
          status: r.status,
          fullName: player.fullName,
          profile: player.profile,
          email: player.email,
          phone: player.phone,
        };
      });
    });

    res.json({
      attendanceMap,
      totalSessions: data.length,
    });

  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};


exports.getAttendanceByDate = async (req, res) => {
  try {
    const { classId } = req.params;
    const { date } = req.query;

    if (!date) {
      return res.status(400).json({
        message: "date is required",
      });
    }

    const sessionDate = new Date(date);
    sessionDate.setUTCHours(0, 0, 0, 0);

    const attendance = await Attendance.findOne({
      class: classId,
      sessionDate,
    }).populate({
      path: "records.player",
      select: "fullName profile email phone",
    });

    // ✅ If no attendance → return empty structure
    if (!attendance) {
      return res.json({
        sessionDate,
        records: [],
        attendanceMap: {},
      });
    }

    // ✅ Transform data for UI
    const attendanceMap = {};

    attendance.records.forEach((r) => {
      const player = r.player;

      attendanceMap[player._id] = {
        status: r.status,
        fullName: player.fullName,
        profile: player.profile,
        email: player.email,
        phone: player.phone,
      };
    });

    res.json({
      sessionDate: attendance.sessionDate,
      attendanceMap,
      totalPlayers: attendance.records.length,
    });

  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.createCoach = async (req, res) => {
  try {
    const { fullName, email, phone, password } = req.body;

    if (!fullName || !email || !phone || !password) {
      return res.status(400).json({
        message: "All fields are required",
      });
    }

    const existing = await Admin.findOne({
      $or: [{ email }, { phone }],
    });

    if (existing) {
      return res.status(400).json({
        message: "Email or phone already exists",
      });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const coach = await Admin.create({
      name: fullName,
      email,
      mobile: phone,
      password: hashedPassword,
      role: "COACH",
    });

    res.json({
      message: "Coach created successfully",
      data: coach,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.getAllCoaches = async (req, res) => {
  try {
    const coaches = await Admin.find({ role: "COACH" })
      .select("-password")
      .sort({ createdAt: -1 });

    res.json({ data: coaches });

  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.getCoachById = async (req, res) => {
  try {
    const coach = await Admin.findOne({
      _id: req.params.id,
      role: "COACH",
    }).select("-password");

    if (!coach) {
      return res.status(404).json({
        message: "Coach not found",
      });
    }

    res.json({ data: coach });

  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.updateCoach = async (req, res) => {
  try {
    const coachId = req.params.id;
    const newMobile = req.body.mobile || req.body.phone;
    const newEmail = req.body.email;

    if (newMobile) {
      const existingAdminMobile = await Admin.findOne({
        mobile: newMobile,
        _id: { $ne: coachId },
      });
      const existingParentMobile = await Parent.findOne({
        phone: newMobile,
      });

      if (existingAdminMobile || existingParentMobile) {
        return res.status(400).json({
          message: "Mobile number is already registered by another user.",
        });
      }
    }

    if (newEmail) {
      const existingAdminEmail = await Admin.findOne({
        email: newEmail.toLowerCase(),
        _id: { $ne: coachId },
      });
      const existingParentEmail = await Parent.findOne({
        email: newEmail.toLowerCase(),
      });

      if (existingAdminEmail || existingParentEmail) {
        return res.status(400).json({
          message: "Email is already registered by another user.",
        });
      }
    }

    const coach = await Admin.findOneAndUpdate(
      { _id: coachId, role: "COACH" },
      req.body,
      { new: true, runValidators: true }
    ).select("-password");

    if (!coach) {
      return res.status(404).json({
        message: "Coach not found",
      });
    }

    res.json({
      message: "Coach updated successfully",
      data: coach,
    });

  } catch (err) {
    if (err.code === 11000) {
      return res.status(400).json({
        message: "Email or mobile number is already registered by another user.",
      });
    }
    res.status(500).json({ message: err.message });
  }
};

exports.toggleCoachActiveStatus = async (req, res) => {
  try {
    const coachId = req.params.id;

    const coach = await Admin.findOne({
      _id: coachId,
      role: "COACH",
    });

    if (!coach) {
      return res.status(404).json({
        message: "Coach not found",
      });
    }

    // Toggle status: true -> false, false -> true
    coach.isActive = !coach.isActive;

    await coach.save();

    return res.json({
      success: true,
      message: `Coach status updated to ${coach.isActive ? "ACTIVE" : "INACTIVE"
        }`,
      data: {
        _id: coach._id,
        name: coach.name,
        email: coach.email,
        role: coach.role,
        isActive: coach.isActive,
      },
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

exports.changeCoachPassword = async (req, res) => {
  try {
    const coachId = req.params.id;
    const { password } = req.body;

    if (!password) {
      return res.status(400).json({
        message: "Password is required",
      });
    }

    const coach = await Admin.findOne({ _id: coachId, role: "COACH" });
    if (!coach) {
      return res.status(404).json({
        message: "Coach not found",
      });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    coach.password = hashedPassword;
    await coach.save();

    res.json({
      success: true,
      message: "Coach password updated successfully",
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};



exports.getClassPlayers = async (req, res) => {
  try {
    const { classId } = req.params;

    const classData = await Class.findById(classId)
      .populate({
        path: "players",
        select: "-password -tokens",
        populate: [
          { path: "category", select: "name" },
          { path: "programs", select: "name" },
        ],
      })
      .populate("coach", "fullName email")
      .populate("term", "name year");

    if (!classData) {
      return res.status(404).json({
        message: "Class not found",
      });
    }

    res.json({
      class: {
        _id: classData._id,
        dayOfWeek: classData.dayOfWeek,
        startTime: classData.startTime,
        endTime: classData.endTime,
        location: classData.location,
        coach: classData.coach,
        term: classData.term,
      },
      totalPlayers: classData.players.length,
      players: classData.players,
    });

  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.getCoachClassesWithSessions = async (req, res) => {
  try {
    // const coachId = req.user._id;
    const coachId = req.params.coachId;

    // ✅ fetch classes assigned to coach
    const classes = await Class.find({ coach: coachId })
      .populate("term", "name startDate endDate")
      .populate("program", "name")
      .populate("category", "name")
      .populate("players", "fullName profile")
      .sort({ createdAt: -1 });

    const result = [];

    for (const cls of classes) {
      // ✅ generate sessions
      const sessions = generateClassSessions(cls.term, cls);

      // ✅ format sessions for UI
      const formattedSessions = sessions.map((date) => {
        const d = new Date(date);

        return {
          date: d.toISOString().split("T")[0], // ✅ consistent
          day: d.getUTCDate(),
          month: d.getUTCMonth() + 1,
          year: d.getUTCFullYear(),
        };
      });

      result.push({
        classId: cls._id,
        className: cls.name,
        dayOfWeek: cls.dayOfWeek,
        startTime: cls.startTime,
        endTime: cls.endTime,
        location: cls.location,

        term: cls.term,
        program: cls.program,
        category: cls.category,

        totalPlayers: cls.players.length,
        players: cls.players,

        totalSessions: formattedSessions.length,
        sessions: formattedSessions,
      });
    }

    res.json({
      success: true,
      message: "Coach classes with sessions fetched",
      totalClasses: result.length,
      data: result,
    });

  } catch (err) {
    res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

exports.getClassFiltersWithTimeSlots = async (req, res) => {
  try {
    const { categoryId, programId, day, termId, term } = req.query;
    const selectedTerm = termId || term;

    // ✅ base query
    const query = {};
    if (categoryId) query.category = categoryId;
    if (programId) query.program = programId;
    if (day) query.dayOfWeek = day;
    if (selectedTerm) query.term = selectedTerm;

    const classes = await Class.find(query)
      .populate("category", "name")
      .populate("program", "name")
      .populate("term", "name year startDate endDate");

    // ✅ categories
    const categories = [...new Map(
      classes.filter(c => c.category).map(c => [c.category._id.toString(), c.category])
    ).values()];

    // ✅ programs
    const programs = [...new Map(
      classes.filter(c => c.program).map(c => [c.program._id.toString(), c.program])
    ).values()];

    // ✅ terms
    const terms = [...new Map(
      classes.filter(c => c.term).map(c => [c.term._id.toString(), c.term])
    ).values()];

    // ✅ days
    const days = [...new Set(classes.map(c => c.dayOfWeek).filter(Boolean))];

    // ✅ time slots (only if day is selected)
    let timeSlots = [];

    if (day) {
      timeSlots = classes.map((c) => ({
        classId: c._id,
        startTime: c.startTime,
        endTime: c.endTime,
      }));
    }

    res.json({
      terms,
      categories,
      programs,
      days,
      timeSlots, // 👈 added here
    });

  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.getClassFullTable = async (req, res) => {
  try {
    const { classId } = req.query;

    const cls = await Class.findById(classId)
      .populate("term")
      .populate("coach", "name")
      .populate({
        path: "players",
        select:
          "fullName email dob phone contactName paymentStatus isMedicalCondition medicalConditionDetails rating prefferedFoot parentId profileImage",
        populate: {
          path: "parentId",
          select: "fullName email phone profileImage", // choose the fields you need
        },
      });

    if (!cls) {
      return res.status(404).json({ message: "Class not found" });
    }

    // ✅ 1. Generate sessions
    const allSessions = generateClassSessions(cls.term, cls);

    const sessionDates = allSessions.map((d) =>
      new Date(d).toISOString().split("T")[0]
    );

    // ✅ 2. Fetch attendance
    const attendanceData = await Attendance.find({
      class: classId,
    }).select("sessionDate records");

    // ✅ 3. Convert attendance to map
    const attendanceMap = {};

    attendanceData.forEach((att) => {
      const date = new Date(att.sessionDate)
        .toISOString()
        .split("T")[0];

      attendanceMap[date] = {};

      att.records.forEach((r) => {
        attendanceMap[date][r.player.toString()] = r.status;
      });
    });

    // ✅ 4. Build player rows
    const players = cls.players.map((player) => {
      const attendance = {};

      sessionDates.forEach((date) => {
        attendance[date] =
          attendanceMap[date]?.[player._id] || "NOT_MARKED";
      });

      return {
        playerId: player._id,
        name: player.fullName,
        email: player.email,
        dob: player.dob,
        phone: player.phone,
        profileImage: player.profileImage,
        guardian: player.contactName,
        isMedicalCondition: player.isMedicalCondition,
        medicalConditionDetails: player.medicalConditionDetails,
        rating: player.rating,
        prefferedFoot: player.prefferedFoot,
        paymentStatus: player.paymentStatus,
        // Parent details
        parent: player.parentId
          ? {
            id: player.parentId._id,
            name: player.parentId.fullName,
            email: player.parentId.email,
            phone: player.parentId.phone,
            profileImage: player.parentId.profileImage,
          }
          : null,
        attendance,
      };
    });

    // ✅ 5. Check if broadcast chatroom is present
    const broadcastRoom = await ChatRoom.findOne({
      classId: classId,
      type: "BROADCAST",
    }).select("_id");

    res.json({
      classId: cls._id,
      className: cls.name,
      coach: cls.coach ? { _id: cls.coach._id, name: cls.coach.name } : null,
      broadcastChatRoomId: broadcastRoom ? broadcastRoom._id : null,
      broadcastRoomId: broadcastRoom ? broadcastRoom._id : null,
      totalSessions: sessionDates.length,
      sessions: sessionDates,
      players,
    });

  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.exportClassCSV = async (req, res) => {
  const { classId } = req.query;

  const cls = await Class.findById(classId)
    .populate("term")
    .populate(
      "players",
      "fullName email dob phone contactName paymentStatus"
    );

  if (!cls) {
    return res.status(404).json({ message: "Class not found" });
  }

  // ✅ 1. Generate sessions
  const allSessions = generateClassSessions(cls.term, cls);

  const sessionDates = allSessions.map(
    (d) => new Date(d).toISOString().split("T")[0]
  );

  // ✅ 2. Fetch attendance
  const attendanceData = await Attendance.find({
    class: classId,
  }).select("sessionDate records");

  // ✅ 3. Build attendance map
  const attendanceMap = {};

  attendanceData.forEach((att) => {
    const date = new Date(att.sessionDate)
      .toISOString()
      .split("T")[0];

    attendanceMap[date] = {};

    att.records.forEach((r) => {
      attendanceMap[date][r.player.toString()] = r.status;
    });
  });

  // ✅ 4. Prepare CSV rows
  const rows = cls.players.map((player) => {
    const row = {
      Name: player.fullName,
      Email: player.email,
      DOB: player.dob ? new Date(player.dob).toISOString().split("T")[0] : "",
      Phone: player.phone,
      Guardian: player.contactName,
      paymentStatus: player.paymentStatus
    };

    // Add session columns
    sessionDates.forEach((date) => {
      const status =
        attendanceMap[date]?.[player._id] || "NOT_MARKED";

      let symbol = "";
      if (status === "PRESENT") symbol = "✔";
      else if (status === "ABSENT") symbol = "✘";
      else symbol = "";

      row[date] = symbol;
    });

    return row;
  });

  // ✅ 5. CSV fields (order matters)
  const fields = [
    "Name",
    "Email",
    "DOB",
    "Phone",
    "Guardian",
    "Payment Status",
    ...sessionDates,
  ];

  const parser = new Parser({ fields });
  const csv = parser.parse(rows);

  // ✅ 6. Send as downloadable file
  res.header("Content-Type", "text/csv");
  res.attachment(`class-${cls.name}-attendance.csv`);
  res.send(csv);
};


exports.getMyRole = async (req, res) => {
  try {
    // Admin or Coach
    if (req.admin) {
      return res.status(200).json({
        success: true,
        data: {
          role: req.admin.role, // SUPER_ADMIN or COACH
        },
      });
    }

    // Parent
    if (req.parent) {
      return res.status(200).json({
        success: true,
        data: {
          role: "PARENT",
        },
      });
    }

    return res.status(401).json({
      success: false,
      message: "Unauthorized",
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

exports.getPlayerDetails = async (req, res) => {
  try {
    const { playerId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(playerId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid player ID",
      });
    }

    const player = await User.findById(playerId)
      .populate({
        path: "parentId",
        select: "-password -tokens -otp -otpExpire -__v",
      })
      .populate("category", "name")
      .populate("programs", "name")
      .populate("term", "name")
      .populate("assignedClasses", "name")
      .lean();

    if (!player) {
      return res.status(404).json({
        success: false,
        message: "Player not found",
      });
    }

    const parentId = player.parentId?._id;
    const otherPlayers = parentId
      ? await User.find({
        parentId: parentId,
        _id: { $ne: player._id },
      })
        .select("_id fullName")
        .lean()
      : [];

    // Fetch per-day attendance records for this player
    const attendanceRecords = await Attendance.find({
      "records.player": playerId,
    })
      .populate("class", "name dayOfWeek startTime endTime")
      .sort({ sessionDate: -1 })
      .lean();

    // Map to per-day attendance format
    const perDayAttendance = attendanceRecords.map((att) => {
      const playerRecord = att.records.find(
        (r) => r.player && r.player.toString() === playerId.toString()
      );
      return {
        attendanceId: att._id,
        class: att.class,
        sessionDate: att.sessionDate,
        status: playerRecord?.status || "NOT_MARKED",
        comment: playerRecord?.comment || "",
        remarks: playerRecord?.remarks || "",
        reason: playerRecord?.reason || "",
        markedByParent: playerRecord?.markedByParent || false,
        lateArrival: playerRecord?.lateArrival || false,
        attendanceType: playerRecord?.attendanceType || "REGULAR",
      };
    });

    // Calculate overall attendance metrics
    const totalSessions = perDayAttendance.length;
    const presentCount = perDayAttendance.filter((a) => a.status === "PRESENT").length;
    const absentCount = perDayAttendance.filter((a) => a.status === "ABSENT").length;
    const lateCount = perDayAttendance.filter((a) => a.status === "LATE").length;
    const trialCount = perDayAttendance.filter((a) => a.status === "TRIAL").length;
    const attendedCount = presentCount + lateCount;

    const overallAttendancePercentage =
      totalSessions > 0
        ? Number(((attendedCount / totalSessions) * 100).toFixed(2))
        : 0;

    const overallAttendance = {
      totalSessions,
      presentCount,
      absentCount,
      lateCount,
      trialCount,
      attendedCount,
      percentage: overallAttendancePercentage,
    };

    return res.status(200).json({
      success: true,
      message: "Player details fetched successfully.",
      data: {
        player,
        parent: player.parentId || null,
        otherPlayers,
        perDayAttendance,
        overallAttendance,
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

/**
 * @desc Preview Clone Term - Fetch classes and players to clone, check duplicate class existence
 * @route POST /api/admin/cloneTerm/preview
 * @access Private/Admin
 */
exports.previewCloneTerm = async (req, res) => {
  try {
    const { sourceTermId, targetTermId } = req.body;

    if (!sourceTermId || !targetTermId) {
      return res.status(400).json({
        success: false,
        message: "sourceTermId and targetTermId are required.",
      });
    }

    if (!mongoose.Types.ObjectId.isValid(sourceTermId) || !mongoose.Types.ObjectId.isValid(targetTermId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid sourceTermId or targetTermId format.",
      });
    }

    if (sourceTermId === targetTermId) {
      return res.status(400).json({
        success: false,
        message: "Source term and target term cannot be the same.",
      });
    }

    const sourceTerm = await Term.findById(sourceTermId);
    if (!sourceTerm) {
      return res.status(404).json({
        success: false,
        message: "Source term not found.",
      });
    }

    const targetTerm = await Term.findById(targetTermId);
    if (!targetTerm) {
      return res.status(404).json({
        success: false,
        message: "Target term not found.",
      });
    }

    // Fetch source classes with populated category, program, coach, players
    const sourceClasses = await Class.find({ term: sourceTermId })
      .populate("category", "name")
      .populate("program", "name")
      .populate("coach", "fullName name")
      .populate("players", "firstName lastName fullName");

    // Fetch existing target classes to check for duplicate class existence
    const targetClasses = await Class.find({ term: targetTermId });

    const classesPreview = sourceClasses.map((cls) => {
      // Check if duplicate class exists in target term
      const alreadyExists = targetClasses.some((tCls) => {
        const sameName = tCls.name === cls.name;
        const sameCategory = String(tCls.category) === String(cls.category?._id || cls.category);
        const sameProgram = String(tCls.program) === String(cls.program?._id || cls.program);
        const sameDay = tCls.dayOfWeek === cls.dayOfWeek;
        const sameStartTime = tCls.startTime === cls.startTime;
        return sameName && sameCategory && sameProgram && sameDay && sameStartTime;
      });

      const playersList = (cls.players || []).map((player) => {
        const playerName =
          player.fullName ||
          [player.firstName, player.lastName].filter(Boolean).join(" ") ||
          "Unknown Player";
        return {
          _id: player._id,
          name: playerName,
          selected: true,
        };
      });

      return {
        classId: cls._id,
        name: cls.name,
        category: cls.category?.name || "",
        program: cls.program?.name || "",
        coach: cls.coach?.fullName || cls.coach?.name || "",
        playerCount: playersList.length,
        alreadyExists,
        players: playersList,
      };
    });

    return res.status(200).json({
      success: true,
      sourceTerm: {
        _id: sourceTerm._id,
        name: sourceTerm.name,
      },
      targetTerm: {
        _id: targetTerm._id,
        name: targetTerm.name,
      },
      classes: classesPreview,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

/**
 * @desc Clone Term - Perform selective clone of classes and players within a transaction
 * @route POST /api/admin/cloneTerm
 * @access Private/Admin
 */
exports.cloneTerm = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { sourceTermId, targetTermId, classes } = req.body;

    if (!sourceTermId || !targetTermId) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({
        success: false,
        message: "sourceTermId and targetTermId are required.",
      });
    }

    if (!mongoose.Types.ObjectId.isValid(sourceTermId) || !mongoose.Types.ObjectId.isValid(targetTermId)) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({
        success: false,
        message: "Invalid sourceTermId or targetTermId format.",
      });
    }

    if (sourceTermId === targetTermId) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({
        success: false,
        message: "Source term and target term cannot be the same.",
      });
    }

    const sourceTerm = await Term.findById(sourceTermId).session(session);
    if (!sourceTerm) {
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json({
        success: false,
        message: "Source term not found.",
      });
    }

    const targetTerm = await Term.findById(targetTermId).session(session);
    if (!targetTerm) {
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json({
        success: false,
        message: "Target term not found.",
      });
    }

    const selectedClasses = Array.isArray(classes) ? classes : [];
    let classesSelected = selectedClasses.length;
    let classesCloned = 0;
    let classesSkipped = 0;
    let playersSelected = 0;
    let playersCopied = 0;

    for (const item of selectedClasses) {
      const { classId, players: playerIds } = item;
      const playerList = Array.isArray(playerIds) ? playerIds : [];
      playersSelected += playerList.length;

      if (!classId || !mongoose.Types.ObjectId.isValid(classId)) {
        classesSkipped++;
        continue;
      }

      const sourceClass = await Class.findById(classId).session(session);
      if (!sourceClass || String(sourceClass.term) !== String(sourceTermId)) {
        classesSkipped++;
        continue;
      }

      // Check duplicate in target term
      const existingClass = await Class.findOne({
        term: targetTermId,
        name: sourceClass.name,
        category: sourceClass.category,
        program: sourceClass.program,
        dayOfWeek: sourceClass.dayOfWeek,
        startTime: sourceClass.startTime,
      }).session(session);

      if (existingClass) {
        classesSkipped++;
        continue;
      }

      // Filter player IDs to ensure they belonged to the original class
      const validPlayerIds = playerList.filter((pId) =>
        sourceClass.players.some((spId) => String(spId) === String(pId))
      );

      // Create new class document copying fields, ignoring _id, createdAt, updatedAt, attendance
      const classObject = sourceClass.toObject();
      delete classObject._id;
      delete classObject.createdAt;
      delete classObject.updatedAt;

      classObject.term = targetTermId;
      classObject.players = validPlayerIds;

      const [newClass] = await Class.create([classObject], { session });
      classesCloned++;
      playersCopied += validPlayerIds.length;

      // Update users / players
      for (const playerId of validPlayerIds) {
        const user = await User.findById(playerId).session(session);
        if (user) {
          const updateData = {
            $addToSet: { assignedClasses: newClass._id },
          };

          if (user.term && String(user.term) === String(sourceTermId)) {
            updateData.$set = { term: targetTermId };
          }

          await User.updateOne({ _id: playerId }, updateData, { session });
        }
      }
    }

    await session.commitTransaction();
    session.endSession();

    return res.status(200).json({
      success: true,
      message: "Term cloned successfully.",
      summary: {
        classesSelected,
        classesCloned,
        classesSkipped,
        playersSelected,
        playersCopied,
        attendanceCopied: false,
      },
    });
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

// ✅ Comprehensive Admin Dashboard Overview API
exports.getAdminDashboardOverview = async (req, res) => {
  try {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    // Get pending registration request player IDs for unallocated calculation
    const pendingRequestPlayerIds = await RegistrationRequest.find({ status: "PENDING" }).distinct("player");

    // Execute queries in parallel using Promise.all for maximum performance
    const [
      totalPlayers,
      activePlayers,
      pendingPlayers,
      blockedPlayers,
      unallocatedPlayersCount,
      playersTrial,
      playersUnpaid,
      playersPaid,
      playersOverdue,
      playersOthers,

      totalParents,
      approvedParents,
      pendingParents,
      blockedParents,

      totalCoaches,
      activeCoaches,
      superAdmins,

      totalClasses,
      classCapacityAggregate,
      classRosterAggregate,
      totalPrograms,
      totalCategories,
      totalTerms,
      activeTerms,

      totalRequests,
      pendingRequests,
      completedRequests,
      requestTypesAggregate,

      totalEvents,
      upcomingEvents,
      ongoingEvents,
      completedEvents,
      totalEventRegistrations,

      totalInvoices,
      paidInvoices,
      unpaidInvoices,
      pendingPaymentApprovals,
      rejectedPayments,
      todaysCollectionsAgg,
      monthlyCollectionsAgg,
      totalRevenueAgg,
      outstandingAmountAgg,

      totalProducts,
      totalOrders,
      ordersByStatusAgg,
      storeRevenueAgg,

      totalNews,
      featuredNews,
      rawNewsCategories,

      recentRegistrationRequests,
      recentPendingPayments,
      recentPlayers,
      recentTemporaryPlayers,
    ] = await Promise.all([
      // 1. Players
      User.countDocuments({ parentId: { $exists: true } }),
      User.countDocuments({ parentId: { $exists: true }, playerStatus: "ACTIVE" }),
      User.countDocuments({ parentId: { $exists: true }, playerStatus: "PENDING_APPROVAL" }),
      User.countDocuments({ parentId: { $exists: true }, isBlocked: true }),
      User.countDocuments({
        parentId: { $exists: true },
        isBlocked: false,
        $or: [
          { assignedClasses: { $exists: false } },
          { assignedClasses: { $size: 0 } },
          { assignedClasses: null },
          { hasPendingRequest: true },
          { _id: { $in: pendingRequestPlayerIds } },
        ],
      }),
      User.countDocuments({ parentId: { $exists: true }, paymentStatus: "TRIAL" }),
      User.countDocuments({ parentId: { $exists: true }, paymentStatus: "UNPAID" }),
      User.countDocuments({ parentId: { $exists: true }, paymentStatus: "PAID" }),
      User.countDocuments({ parentId: { $exists: true }, paymentStatus: "OVER_DUE" }),
      User.countDocuments({ parentId: { $exists: true }, paymentStatus: "OTHERS" }),

      // 2. Parents
      Parent.countDocuments({}),
      Parent.countDocuments({ status: "APPROVED" }),
      Parent.countDocuments({ status: "PENDING" }),
      Parent.countDocuments({ isBlocked: true }),

      // 3. Coaches & Admins
      Admin.countDocuments({ role: "COACH" }),
      Admin.countDocuments({ role: "COACH", status: "ACTIVE" }),
      Admin.countDocuments({ role: "SUPER_ADMIN" }),

      // 4. Classes, Programs & Terms
      Class.countDocuments({}),
      Class.aggregate([{ $group: { _id: null, total: { $sum: "$capacity" } } }]),
      Class.aggregate([{ $project: { count: { $size: { $ifNull: ["$players", []] } } } }, { $group: { _id: null, total: { $sum: "$count" } } }]),
      Program.countDocuments({ status: "ACTIVE" }),
      Category.countDocuments({}),
      Term.countDocuments({}),
      Term.countDocuments({ startDate: { $lte: new Date() }, endDate: { $gte: new Date() } }),

      // 5. Registration Requests
      RegistrationRequest.countDocuments({}),
      RegistrationRequest.countDocuments({ status: "PENDING" }),
      RegistrationRequest.countDocuments({ status: "COMPLETED" }),
      RegistrationRequest.aggregate([{ $group: { _id: "$requestType", count: { $sum: 1 } } }]),

      // 6. Events & Registrations
      Event.countDocuments({}),
      Event.countDocuments({ status: "UPCOMING" }),
      Event.countDocuments({ status: "ONGOING" }),
      Event.countDocuments({ status: "COMPLETED" }),
      EventRegistration.countDocuments({ status: "REGISTERED" }),

      // 7. Financials, Invoices & Payments
      Invoice.countDocuments({ status: "ACTIVE" }),
      Invoice.countDocuments({ status: "ACTIVE", paymentStatus: "PAID" }),
      Invoice.countDocuments({ status: "ACTIVE", paymentStatus: { $ne: "PAID" } }),
      Payment.countDocuments({ status: "PENDING" }),
      Payment.countDocuments({ status: "REJECTED" }),
      Payment.aggregate([{ $match: { status: "APPROVED", approvedAt: { $gte: startOfToday } } }, { $group: { _id: null, total: { $sum: "$amount" } } }]),
      Payment.aggregate([{ $match: { status: "APPROVED", approvedAt: { $gte: startOfMonth } } }, { $group: { _id: null, total: { $sum: "$amount" } } }]),
      Payment.aggregate([{ $match: { status: "APPROVED" } }, { $group: { _id: null, total: { $sum: "$amount" } } }]),
      Invoice.aggregate([{ $match: { status: "ACTIVE", paymentStatus: { $ne: "PAID" } } }, { $group: { _id: null, total: { $sum: { $cond: [{ $gt: ["$totalAmount", 0] }, "$totalAmount", { $ifNull: ["$amount", 0] }] } } } }]),

      // 8. Store & Merchandise
      Product.countDocuments({}),
      Order.countDocuments({}),
      Order.aggregate([{ $group: { _id: "$orderStatus", count: { $sum: 1 } } }]),
      Order.aggregate([{ $match: { orderStatus: "COMPLETED" } }, { $group: { _id: null, total: { $sum: "$totalAmount" } } }]),

      // 9. Announcements / News
      News.countDocuments({}),
      News.countDocuments({ featured: true }),
      News.distinct("category"),

      // 10. Recent Activity Lists (Limit 5 each)
      RegistrationRequest.find({ status: "PENDING" })
        .populate("parent", "fullName email phone")
        .populate("player", "fullName email phone paymentStatus")
        .populate("category", "name")
        .populate("programs", "name")
        .sort({ createdAt: -1 })
        .limit(5),

      Payment.find({ status: "PENDING" })
        .populate("parent", "fullName email phone")
        .populate("invoice", "invoiceNumber type totalAmount")
        .sort({ createdAt: -1 })
        .limit(5),

      User.find({ parentId: { $exists: true } })
        .populate("parentId", "fullName email phone")
        .populate("category", "name")
        .select("firstName lastName fullName email phone paymentStatus playerStatus createdAt")
        .sort({ createdAt: -1 })
        .limit(5),

      User.find({ parentId: { $exists: true }, createdByRole: "COACH" })
        .populate("parentId", "fullName email phone")
        .populate("createdBy", "name email")
        .select("firstName lastName fullName email phone playerStatus temporarySessionDate createdAt")
        .sort({ createdAt: -1 })
        .limit(5),
    ]);

    // Format request types breakdown map
    const requestTypesBreakdown = {};
    (requestTypesAggregate || []).forEach((item) => {
      if (item._id) requestTypesBreakdown[item._id] = item.count;
    });

    // Format order status breakdown map
    const orderStatusBreakdown = {};
    (ordersByStatusAgg || []).forEach((item) => {
      if (item._id) orderStatusBreakdown[item._id] = item.count;
    });

    const responseData = {
      players: {
        total: totalPlayers,
        active: activePlayers,
        pendingApproval: pendingPlayers,
        unallocated: unallocatedPlayersCount,
        allocated: Math.max(0, totalPlayers - unallocatedPlayersCount),
        blocked: blockedPlayers,
        paymentStatusBreakdown: {
          TRIAL: playersTrial,
          UNPAID: playersUnpaid,
          PAID: playersPaid,
          OVER_DUE: playersOverdue,
          OTHERS: playersOthers,
        },
      },
      parents: {
        total: totalParents,
        approved: approvedParents,
        pending: pendingParents,
        blocked: blockedParents,
      },
      staff: {
        totalCoaches,
        activeCoaches,
        superAdmins,
      },
      academics: {
        totalClasses,
        totalCapacity: classCapacityAggregate.length > 0 ? classCapacityAggregate[0].total : 0,
        enrolledSlots: classRosterAggregate.length > 0 ? classRosterAggregate[0].total : 0,
        totalActivePrograms: totalPrograms,
        totalCategories,
        totalTerms,
        activeTermsCount: activeTerms,
      },
      registrationRequests: {
        total: totalRequests,
        pending: pendingRequests,
        completed: completedRequests,
        byType: requestTypesBreakdown,
      },
      events: {
        total: totalEvents,
        upcoming: upcomingEvents,
        ongoing: ongoingEvents,
        completed: completedEvents,
        totalRegistrations: totalEventRegistrations,
      },
      financials: {
        totalInvoices,
        paidInvoices,
        unpaidInvoices,
        totalRevenue: totalRevenueAgg.length > 0 ? totalRevenueAgg[0].total : 0,
        todaysCollections: todaysCollectionsAgg.length > 0 ? todaysCollectionsAgg[0].total : 0,
        monthlyCollections: monthlyCollectionsAgg.length > 0 ? monthlyCollectionsAgg[0].total : 0,
        outstandingAmount: outstandingAmountAgg.length > 0 ? outstandingAmountAgg[0].total : 0,
        pendingPaymentApprovals,
        rejectedPayments,
      },
      store: {
        totalProducts,
        totalOrders,
        byStatus: orderStatusBreakdown,
        storeRevenue: storeRevenueAgg.length > 0 ? storeRevenueAgg[0].total : 0,
      },
      announcements: {
        totalNews,
        featured: featuredNews,
        categoriesCount: (rawNewsCategories || []).filter(Boolean).length,
      },
      recentActivity: {
        pendingRequests: recentRegistrationRequests,
        pendingPayments: recentPendingPayments,
        recentPlayers,
        recentTemporaryPlayers,
      },
    };

    return res.status(200).json({
      success: true,
      data: responseData,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};
