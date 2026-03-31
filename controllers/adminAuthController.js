const Admin = require("../models/Admin");
const bcrypt = require("bcryptjs");
const generateToken = require("../utils/generateToken");
const User = require("../models/User");
const { getStatusEmailTemplate } = require("../utils/emailTemplates");
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

exports.adminLogin = async (req, res) => {
  try {
    const { email, mobile, password } = req.body;

    if (!password) {
      return res.status(400).json({ message: "Password is required" });
    }

    const admin = await Admin.findOne({
      $or: [{ email }, { mobile }],
    }).select("+password"); // ✅ important

    if (!admin) {
      return res.status(404).json({ message: "Admin not found" });
    }

    const isMatch = await bcrypt.compare(password, admin.password);

    if (!isMatch) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    const token = generateToken(admin._id);

    admin.tokens = admin.tokens || [];
    admin.tokens.push(token);
    admin.tokens = admin.tokens.slice(-5);

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
    // await Admin.findByIdAndUpdate(
    //     req.admin._id,
    //     {
    //         $pull: {
    //             tokens: req.token
    //         }
    //     },
    //     { new: true }
    // );

    await Admin.findByIdAndUpdate(req.admin._id, {
      $set: { tokens: [] }
    });
    res.json({ message: "Logged out successfully" });

  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.getUsers = async (req, res) => {
  try {
    let {
      status,
      page = 1,
      limit = 10,
      search = "",
    } = req.query;

    const validStatus = ["PENDING", "APPROVED", "REJECTED"];

    if (status && !validStatus.includes(status)) {
      return res.status(400).json({
        message: "Invalid status",
      });
    }

    page = Number(page);
    limit = Number(limit);

    const query = {
      role: "PLAYER",
    };

    if (status) {
      query.status = status;
    }

    if (search) {
      query.$or = [
        { fullName: { $regex: search, $options: "i" } },
        { email: { $regex: search, $options: "i" } },
        { phone: { $regex: search, $options: "i" } },
      ];
    }

    const total = await User.countDocuments(query);

    const users = await User.find(query)
      .populate("approvedBy", "name email")
      .populate("rejectedBy", "name email")

      // ✅ IMPORTANT: populate assigned classes
      .populate({
        path: "assignedClasses",
        populate: [
          { path: "term", select: "name year" },
          { path: "coach", select: "fullName email" },
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

exports.updateUserStatus = async (req, res) => {
  try {
    const { userId } = req.params;
    const { status, reason } = req.body;

    // ✅ Validate status
    const validStatus = ["APPROVED", "REJECTED"];

    if (!validStatus.includes(status)) {
      return res.status(400).json({
        message: "Invalid status",
      });
    }

    // ❌ Reject must have reason
    if (status === "REJECTED" && !reason) {
      return res.status(400).json({
        message: "Rejection reason is required",
      });
    }

    const user = await User.findById(userId);

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    user.status = status;

    if (status === "APPROVED") {
      user.rejectReason = null;
      user.approvedBy = req.admin._id;
      user.rejectedBy = null;
      user.approvedAt = new Date();
      user.rejectedAt = null;
    } else {
      user.rejectReason = reason;
      user.rejectedBy = req.admin._id;
      user.approvedBy = null;
      user.rejectedAt = new Date();
      user.approvedAt = null;
    }

    await user.save();

    // 📧 Send Email
    if (user.email) {
      const subject =
        status === "APPROVED"
          ? "🎉 Your CoachMax Account is Approved"
          : "❌ Your CoachMax Application Status";

      const html = getStatusEmailTemplate(user, status, reason);

      sendEmail(user.email, subject, html);
    }

    res.json({
      message: `User ${status.toLowerCase()} successfully`,
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

    const user = await User.findById(userId).session(session);
    const classData = await Class.findById(classId).session(session);

    if (!user) throw new Error("User not found");
    if (!classData) throw new Error("Class not found");

    if (user.status !== "APPROVED") {
      throw new Error("User must be approved");
    }

    // ✅ Validate program & category
    if (
      user.program.toString() !== classData.program.toString() ||
      user.category.toString() !== classData.category.toString()
    ) {
      throw new Error("User not eligible for this class");
    }

    // ✅ Prevent duplicate
    const alreadyAssigned = classData.players.some(
      (id) => id.toString() === userId
    );

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

    if (!user.term) {
      user.term = classData.term;
    }

    await user.save({ session });

    await session.commitTransaction();
    session.endSession();

    res.json({ message: "Class assigned successfully" });

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
      status,
      search = "",
      format = "csv",
      userIds = [], // ✅ only this (array)
      programType,
    } = req.body;

    // -----------------------
    // ✅ Validate status
    // -----------------------
    const validStatus = ["PENDING", "APPROVED", "REJECTED"];
    if (status && !validStatus.includes(status)) {
      return res.status(400).json({ message: "Invalid status" });
    }

    // -----------------------
    // ✅ Validate programType
    // -----------------------
    const validProgramType = [
      "ONE_ON_ONE",
      "DEVELOPMENT",
      "ELITE",
      "GROUP",
    ];

    if (programType && !validProgramType.includes(programType)) {
      return res.status(400).json({ message: "Invalid programType" });
    }

    const query = {};

    // -----------------------
    // ✅ Selected users (single or multiple)
    // -----------------------
    if (userIds && userIds.length > 0) {
      query._id = { $in: userIds };
    }

    // -----------------------
    // ✅ Filters
    // -----------------------
    if (status) {
      query.status = status;
    }

    if (programType) {
      query.programType = programType;
    }

    if (search) {
      query.$or = [
        { fullName: { $regex: search, $options: "i" } },
        { email: { $regex: search, $options: "i" } },
        { phone: { $regex: search, $options: "i" } },
      ];
    }

    // -----------------------
    // ✅ Fetch Users
    // -----------------------
    const users = await User.find(query)
      .populate("approvedBy", "name email")
      .populate("rejectedBy", "name email")
      .select("-password -tokens")
      .sort({ createdAt: -1 });

    if (!users.length) {
      return res.status(404).json({ message: "No users found" });
    }

    // -----------------------
    // 🧾 Format Data
    // -----------------------
    const data = users.map((u) => ({
      Name: u.fullName || "",
      Email: u.email || "",
      Phone: u.phone || "",
      Status: u.status || "",
      ProgramType: u.programType || "",
      SkillLevel: u.skillLevel || "",
      PreferredFoot: u.preferredFoot || "",
      Club: u.club || "",
      DOB: u.dob ? new Date(u.dob).toLocaleDateString() : "",
      ContactName: u.contactName || "",
      MedicalCondition: u.medicalCondition || "",
      Comments: u.comments || "",
      ApprovedBy: u.approvedBy?.name || "",
      RejectedBy: u.rejectedBy?.name || "",
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

    // -----------------------
    // ❌ Invalid format
    // -----------------------
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
    const { name } = req.body;

    if (!name) {
      return res.status(400).json({
        message: "Category name is required",
      });
    }

    const existing = await Category.findOne({ name: name.toUpperCase() });
    if (existing) {
      return res.status(400).json({
        message: "Category already exists",
      });
    }

    const category = await Category.create({
      name: name.toUpperCase(),
    });

    res.json({
      message: "Category created successfully",
      category,
    });

  } catch (err) {
    res.status(500).json({ message: err.message });
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

exports.createTerm = async (req, res) => {
  try {
    const { name, year, startDate, endDate } = req.body;

    const parseDate = (dateStr) => {
      const [day, month, year] = dateStr.split("/").map(Number);
      return new Date(year, month - 1, day);
    };

    const term = await Term.create({
      name,
      year,
      startDate: parseDate(startDate),
      endDate: parseDate(endDate),
    });

    res.json({
      message: "Term created successfully",
      data: term,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.getAllTerms = async (req, res) => {
  try {
    const terms = await Term.find().sort({ startDate: 1 });

    res.json({
      data: terms,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
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
    } = req.body;

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
      "MONDAY","TUESDAY","WEDNESDAY","THURSDAY","FRIDAY","SATURDAY","SUNDAY"
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
    });

    res.json({
      message: "Class created successfully",
      data: classData,
    });

  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.getAllClasses = async (req, res) => {
  try {
    const { term, dayOfWeek, program, category } = req.query;

    let filter = {};

    if (term) filter.term = term;
    if (dayOfWeek) filter.dayOfWeek = dayOfWeek;
    if (program) filter.program = program;
    if (category) filter.category = category;

    const classes = await Class.find(filter)
      .populate("term program category coach")
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
    } = req.body;

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
  const end = new Date(term.endDate);

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

  while (current <= end) {
    if (current.getDay() === targetDay) {
      sessions.push(new Date(current));
    }

    current = new Date(current);
    current.setDate(current.getDate() + 1);
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

    res.json({
      totalSessions: sessions.length,
      sessions,
    });

  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.markAttendance = async (req, res) => {
  try {
    const { classId } = req.params;
    const { sessionDate, records } = req.body;

    // records = [{ player, status }]

    const existing = await Attendance.findOne({
      class: classId,
      sessionDate,
    });

    if (existing) {
      // update existing
      existing.records = records;
      await existing.save();

      return res.json({ message: "Attendance updated" });
    }

    // create new
    const attendance = await Attendance.create({
      class: classId,
      sessionDate,
      records,
    });

    res.json({ message: "Attendance marked", data: attendance });

  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.getAttendanceByClass = async (req, res) => {
  try {
    const data = await Attendance.find({
      class: req.params.classId,
    }).populate("records.player");

    res.json({ data });

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
      name:fullName,
      email,
      mobile:phone,
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
    const coach = await Admin.findOneAndUpdate(
      { _id: req.params.id, role: "COACH" },
      req.body,
      { new: true }
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
    res.status(500).json({ message: err.message });
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
          { path: "program", select: "name" },
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