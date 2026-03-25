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

    // ✅ Validate status
    const validStatus = ["PENDING", "APPROVED", "REJECTED"];

    if (status && !validStatus.includes(status)) {
      return res.status(400).json({
        message: "Invalid status",
      });
    }

    page = Number(page);
    limit = Number(limit);

    const query = {};

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