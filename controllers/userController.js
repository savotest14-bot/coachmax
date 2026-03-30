const sendEmail = require("../utils/sendEmail");
const {
  welcomeEmail,
  newUserAdminEmail,
} = require("../utils/emailTemplates");
const User = require("../models/User");
const bcrypt = require("bcryptjs");
const generateToken = require("../utils/generateToken");
const Banner = require("../models/Banner");
const Program = require("../models/Program");
const mongoose = require("mongoose");
const Category = require("../models/Category");

exports.register = async (req, res) => {
  try {
    const {
      fullName,
      email,
      password,
      phone,
      dob,
      club,
      contactName,
      preferredFoot,
      skillLevel,
      medicalCondition,
      comments,
      category,
      program,
      jerseyNumber,
    } = req.body;

    if (
      !fullName ||
      !phone ||
      !password ||
      !preferredFoot ||
      !skillLevel ||
      !program ||
      !category
    ) {
      return res.status(400).json({
        message: "Required fields missing",
      });
    }

    // ✅ Validate ObjectIds
    if (!mongoose.Types.ObjectId.isValid(program)) {
      return res.status(400).json({
        message: "Invalid program ID",
      });
    }

    if (!mongoose.Types.ObjectId.isValid(category)) {
      return res.status(400).json({
        message: "Invalid category ID",
      });
    }

    // ✅ Check category exists
    const categoryData = await Category.findById(category);
    if (!categoryData) {
      return res.status(400).json({
        message: "Category not found",
      });
    }

    // ✅ Check program exists
    const programData = await Program.findById(program);
    if (!programData) {
      return res.status(400).json({
        message: "Program not found",
      });
    }

    // 🔥 IMPORTANT: validate program belongs to category
    if (programData.category.toString() !== category) {
      return res.status(400).json({
        message: "Program does not belong to selected category",
      });
    }

    // ✅ Skill validation
    if (skillLevel < 1 || skillLevel > 5) {
      return res.status(400).json({
        message: "Skill level must be between 1 and 5",
      });
    }

    let parsedDob;

    if (dob) {
      const [day, month, year] = dob.split("/");

      parsedDob = new Date(`${year}-${month}-${day}`);

      if (isNaN(parsedDob)) {
        return res.status(400).json({
          message: "Invalid DOB format. Use dd/mm/yyyy",
        });
      }
    }

    // ✅ Preferred foot validation
    const validFoot = ["LEFT", "RIGHT", "AMBIDEXTROUS"];
    if (!validFoot.includes(preferredFoot)) {
      return res.status(400).json({
        message: "Invalid preferred foot",
      });
    }

    // ✅ Jersey validation (optional)
    if (
      jerseyNumber !== undefined &&
      (jerseyNumber < 0 || jerseyNumber > 99)
    ) {
      return res.status(400).json({
        message: "Jersey number must be between 0 and 99",
      });
    }

    // ✅ Check existing user
    const existingUser = await User.findOne({
      $or: [{ email }, { phone }],
    });

    if (existingUser) {
      return res.status(400).json({
        message: "User already exists",
      });
    }

    // ✅ Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // ✅ Create user
    const user = await User.create({
      fullName,
      email,
      password: hashedPassword,
      phone,
      dob: parsedDob,
      club,
      contactName,
      preferredFoot,
      skillLevel,
      medicalCondition,
      comments,
      category, // ✅ save category
      program,
      jerseyNumber: jerseyNumber || undefined,
    });

    // ✅ Emails
    if (email) {
      sendEmail(
        email,
        "Welcome to CoachMax 🎉",
        welcomeEmail(fullName)
      );
    }

    sendEmail(
      process.env.ADMIN_EMAIL,
      "🚨 New Player Registration",
      newUserAdminEmail(user)
    );

    res.json({
      message: "Registered. Waiting for admin approval",
      user,
    });

  } catch (err) {
    // ✅ Handle duplicate jersey
    if (err.code === 11000 && err.keyPattern?.jerseyNumber) {
      return res.status(400).json({
        message: "Jersey number already taken in this program",
      });
    }

    res.status(500).json({ message: err.message });
  }
};

exports.login = async (req, res) => {
  try {
    const { email, phone, password } = req.body;

    if ((!email && !phone) || !password) {
      return res.status(400).json({
        message: "Email/Phone and password required",
      });
    }

    const user = await User.findOne({
      $or: [{ email }, { phone }],
    });

    if (!user) {
      return res.status(404).json({
        message: "User not found",
      });
    }

    const isMatch = await bcrypt.compare(password, user.password);

    if (!isMatch) {
      return res.status(401).json({
        message: "Invalid credentials",
      });
    }

    if (user.status === "PENDING") {
      return res.status(403).json({
        message: "Your account is pending approval",
      });
    }

    if (user.status === "REJECTED") {
      return res.status(403).json({
        message: `Your account was rejected. Reason: ${user.rejectReason || "N/A"}`,
      });
    }

    if (user.isBlocked) {
      return res.status(403).json({
        message: "Your account is blocked. Contact admin.",
      });
    }

    const token = generateToken(user._id);

    user.tokens.push(token);

    await user.save();
    const userObj = user.toObject();
    delete userObj.password;
    delete userObj.tokens;

    res.json({
      message: "Login successful",
      token,
      user: userObj,
    });

  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.logout = async (req, res) => {
  try {
    const token = req.token;

    req.user.tokens = req.user.tokens.filter(t => t !== token);

    await req.user.save();

    res.json({ message: "Logged out" });

  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.getActiveBanners = async (req, res) => {
  try {
    const banners = await Banner.find({ isActive: true })
      .select("title subtitle image link")
      .sort({ createdAt: -1 });

    res.status(200).json({
      success: true,
      count: banners.length,
      data: banners,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

exports.getCategories = async (req, res) => {
  const categories = await Category.find();
  res.json(categories);
};

exports.getProgramsByCategory = async (req, res) => {
  const { categoryId } = req.params;

  const programs = await Program.find({ category: categoryId });

  res.json(programs);
};