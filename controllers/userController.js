const sendEmail = require("../utils/sendEmail");
const {
  welcomeEmail,
  newUserAdminEmail,
} = require("../utils/emailTemplates");
const User = require("../models/User");
const bcrypt = require("bcryptjs");
const generateToken = require("../utils/generateToken");
const Banner = require("../models/Banner");

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
      programType,
    } = req.body;
    if (
      !fullName ||
      !phone ||
      !password ||
      !preferredFoot ||
      !skillLevel ||
      !programType
    ) {
      return res.status(400).json({
        message: "Required fields missing",
      });
    }

    const validPrograms = ["ONE_ON_ONE", "DEVELOPMENT", "ELITE", "GROUP"];

    if (!validPrograms.includes(programType)) {
      return res.status(400).json({
        message: "Invalid program type",
      });
    }

    if (skillLevel < 1 || skillLevel > 5) {
      return res.status(400).json({
        message: "Skill level must be between 1 and 5",
      });
    }

    const validFoot = ["LEFT", "RIGHT", "AMBIDEXTROUS"];
    if (!validFoot.includes(preferredFoot)) {
      return res.status(400).json({
        message: "Invalid preferred foot",
      });
    }

    const existingUser = await User.findOne({
      $or: [{ email }, { phone }],
    });

    if (existingUser) {
      return res.status(400).json({
        message: "User already exists",
      });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const user = await User.create({
      fullName,
      email,
      password: hashedPassword,
      phone,
      dob,
      club,
      contactName,
      preferredFoot,
      skillLevel,
      medicalCondition,
      comments,
      programType,
    });

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