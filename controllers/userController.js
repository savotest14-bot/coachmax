const sendEmail = require("../utils/sendEmail");
const { welcomeEmail, newUserAdminEmail } = require("../utils/emailTemplates");
const User = require("../models/User");
const Parent = require("../models/Parent");
const MedicalProfile = require("../models/MedicalProfile");
const Banner = require("../models/Banner");
const Program = require("../models/Program");
const Category = require("../models/Category");
const Term = require("../models/Term");
const Attendance = require("../models/Attendance");
const Class = require("../models/Class");
const News = require("../models/News");
const Invoice = require("../models/Invoice");
const Fixture = require("../models/Fixture");
const RegistrationRequest = require("../models/RegistrationRequest");
const EventRegistration = require("../models/EventRegistration");
const Notification = require("../models/Notification");
const bcrypt = require("bcryptjs");
const generateToken = require("../utils/generateToken");
const mongoose = require("mongoose");
const { sendNotification } = require("../services/notificationService");

// Helper function to create admin notifications for enrollment requests
const createAdminNotificationForRequest = async ({
  parent,
  player,
  category,
  programs,
  preferredTerm,
  preferredClasses,
  requestType,
}) => {
  try {
    const parentDoc = await Parent.findById(parent).select("fullName");
    const playerDoc = await User.findById(player).select("fullName");
    const categoryDoc = await Category.findById(category).select("name");
    const programDocs = await Program.find({ _id: { $in: programs } }).select("name");
    const termDoc = preferredTerm ? await Term.findById(preferredTerm).select("name") : null;
    const classDocs =
      preferredClasses && preferredClasses.length > 0
        ? await Class.find({ _id: { $in: preferredClasses } }).select("name")
        : [];

    const programNames = programDocs.map((p) => p.name).join(", ");
    const classNames = classDocs.map((c) => c.name).join(", ");

    const message = `New Enrollment Request (${requestType === "ADD_PROGRAM" ? "Add Program" : "New Player"})
Parent: ${parentDoc ? parentDoc.fullName : "N/A"}
Player: ${playerDoc ? playerDoc.fullName : "N/A"}
Category: ${categoryDoc ? categoryDoc.name : "N/A"}
Programs: ${programNames || "N/A"}
Preferred Term: ${termDoc ? termDoc.name : "N/A"}
Preferred Classes: ${classNames || "None"}`;

    await sendNotification({
      recipientType: "ADMIN",
      adminId: null,
      title: "New Enrollment Request 📝",
      message: message,
      type: "ENROLLMENT_REQUEST",
      data: {
        parentId: parent ? String(parent) : "",
        playerId: player ? String(player) : "",
        requestType,
      },
    });
  } catch (err) {
    console.error("Failed to create admin notification:", err.message);
  }
};

// ✅ Parent registration with child
exports.register = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    let {
      fullName,
      email,
      phone,
      password,
      address,
      city,
      state,
      postcode,
      country,
      emergencyContact,
      relationship,
      players,
      fcmToken,
    } = req.body;

    // Parse players if sent as string in multipart/form-data
    if (typeof players === "string") {
      players = JSON.parse(players);
    }

    // Parent validation
    if (
      !fullName ||
      !email ||
      !phone ||
      !password ||
      !emergencyContact ||
      !relationship ||
      !players ||
      !Array.isArray(players) ||
      players.length === 0
    ) {
      return res.status(400).json({
        success: false,
        message: "Required fields missing",
      });
    }

    // Check existing parent
    const existingParent = await Parent.findOne({
      $or: [
        { email: email.toLowerCase() },
        { phone }
      ],
    });

    if (existingParent) {
      return res.status(400).json({
        success: false,
        message: "Parent with this email or phone already exists",
      });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Create Parent
    const parent = await Parent.create(
      [
        {
          fullName,
          email: email.toLowerCase(),
          phone,
          password: hashedPassword,
          address,
          city,
          state,
          postcode,
          country,
          emergencyContact,
          relationship,
          emailVerified: false,
          phoneVerified: false,
          fcmTokens: fcmToken ? [fcmToken] : [],
        },
      ],
      { session }
    );

    const parentId = parent[0]._id;

    const uploadedFiles = req.files || [];
    const createdPlayers = [];
    const pendingNotifications = [];

    for (let i = 0; i < players.length; i++) {
      const player = players[i];

      const {
        firstName,
        lastName,
        email,
        phone,
        dob,
        gender,
        categories,
        programs,
        term,
        preferredTerm,
        preferredClasses,
        club,
        prefferedFoot,
        isMedicalCondition,
        medicalConditionDetails,
        contactName,
        additionalComments,
        comments,
        allergies,
      } = player;

      // Normalize categories to array
      const categoryIds = Array.isArray(categories)
        ? categories
        : (typeof categories === "string"
          ? (categories.startsWith("[") ? JSON.parse(categories) : [categories])
          : (categories ? [categories] : []));

      // Required player validation
      if (
        !firstName ||
        !lastName ||
        !dob ||
        categoryIds.length === 0 ||
        !programs
      ) {
        throw new Error(
          `Required fields missing for player ${firstName || i + 1}`
        );
      }

      // Normalize programs to array
      const programIds = Array.isArray(programs) ? programs : [programs];

      // Validate references
      for (const catId of categoryIds) {
        const categoryData = await Category.findById(catId);
        if (!categoryData) {
          throw new Error(
            `Category not found for ${firstName}`
          );
        }
      }

      // Validate all programs
      for (const progId of programIds) {
        const programData = await Program.findById(progId);
        if (!programData) {
          throw new Error(
            `Program ${progId} not found for ${firstName}`
          );
        }
      }

      const prefTerm = preferredTerm || term || null;
      if (prefTerm) {
        const termData = await Term.findById(prefTerm);
        if (!termData) {
          throw new Error(
            `Term not found for ${firstName}`
          );
        }
      }

      // Parse DOB
      let parsedDob = null;

      if (dob) {
        const parts = dob.split("/");

        if (parts.length === 3) {
          parsedDob = new Date(
            `${parts[2]}-${parts[1]}-${parts[0]}`
          );
        } else {
          parsedDob = new Date(dob);
        }
      }

      // Profile image
      let profileImage = null;

      if (uploadedFiles[i]) {
        profileImage = `uploads/profiles/${uploadedFiles[i].filename}`;
      }

      // Create Player (term = null until admin class assignment)
      const playerDoc = await User.create(
        [
          {
            firstName,
            lastName,
            fullName: `${firstName} ${lastName}`,

            email: email || null,
            phone: phone || null,

            dob: parsedDob,
            gender,

            parentId,
            prefferedFoot,
            isMedicalCondition,
            medicalConditionDetails,
            club,
            contactName,
            relationship,
            additionalComments:
              additionalComments || "",

            comments,

            paymentStatus: "TRIAL",

            categories: categoryIds,
            programs: programIds,
            term: null,

            rating: 1,

            profileImage,

            assignedClasses: [],

            attendancePercentage: 0,
          },
        ],
        { session }
      );

      const playerId = playerDoc[0]._id;

      // Create RegistrationRequest
      const prefClasses = Array.isArray(preferredClasses) ? preferredClasses : [];

      await RegistrationRequest.create(
        [
          {
            parent: parentId,
            player: playerId,
            category: categoryIds[0] || null,
            programs: programIds,
            preferredTerm: prefTerm,
            preferredClasses: prefClasses,
            requestType: "NEW_PLAYER",
            status: "PENDING",
            createdBy: parentId,
          },
        ],
        { session }
      );

      createdPlayers.push(playerDoc[0]);

      pendingNotifications.push({
        parent: parentId,
        player: playerId,
        category: categoryIds[0] || null,
        programs: programIds,
        preferredTerm: prefTerm,
        preferredClasses: prefClasses,
        requestType: "NEW_PLAYER",
      });
    }

    await session.commitTransaction();
    session.endSession();

    // Trigger admin notifications for enrollment requests (non-blocking)
    pendingNotifications.forEach((notifData) => {
      createAdminNotificationForRequest(notifData);
    });

    // Send Emails (non-blocking)
    sendEmail(
      email,
      "Welcome to CoachMax 🎉",
      welcomeEmail(fullName)
    );

    sendEmail(
      process.env.ADMIN_EMAIL,
      "🚨 New Parent & Players Registration",
      newUserAdminEmail(createdPlayers[0])
    );

    return res.status(201).json({
      success: true,
      message:
        "Parent and players registered successfully.",
      data: {
        parent: {
          _id: parentId,
          fullName: parent[0].fullName,
          email: parent[0].email,
          phone: parent[0].phone,
        },
        players: createdPlayers,
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

// ✅ Parent Login
exports.login = async (req, res) => {
  try {
    const { email, phone, password, fcmToken } = req.body;

    if ((!email && !phone) || !password) {
      return res.status(400).json({
        success: false,
        message: "Email/Phone and password are required",
      });
    }

    const query = email ? { email: email.toLowerCase() } : { phone };
    const parent = await Parent.findOne(query);

    if (!parent) {
      return res.status(404).json({ success: false, message: "Parent not found" });
    }

    const isMatch = await bcrypt.compare(password, parent.password);
    if (!isMatch) {
      return res.status(401).json({ success: false, message: "Invalid credentials" });
    }

    if (parent.isBlocked) {
      return res.status(403).json({
        success: false,
        message: "Your account is blocked. Contact admin.",
      });
    }

    const token = generateToken(parent._id);
    parent.tokens = parent.tokens || [];
    parent.tokens.push(token);

    // Push fcmToken uniquely if provided
    if (fcmToken) {
      parent.fcmTokens = parent.fcmTokens || [];
      if (!parent.fcmTokens.includes(fcmToken)) {
        parent.fcmTokens.push(fcmToken);
      }
    }

    await parent.save();

    // Fetch parent's children
    const children = await User.find({ parentId: parent._id })
      .populate("category", "name")
      .populate("programs", "name")
      .populate("term", "name");

    const parentObj = parent.toObject();
    delete parentObj.password;
    delete parentObj.tokens;

    res.json({
      success: true,
      message: "Login successful",
      token,
      parent: parentObj,
      children,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ✅ Parent Logout
exports.logout = async (req, res) => {
  try {
    const token = req.token;
    const { fcmToken } = req.body || {};

    req.parent.tokens = req.parent.tokens.filter((t) => t !== token);
    if (fcmToken && req.parent.fcmTokens) {
      req.parent.fcmTokens = req.parent.fcmTokens.filter((ft) => ft !== fcmToken);
    }

    await req.parent.save();
    res.json({ success: true, message: "Logged out successfully" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ✅ Retrieve Banners
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
    res.status(500).json({ success: false, message: error.message });
  }
};

// ✅ Retrieve Categories
exports.getCategories = async (req, res) => {
  try {
    const { isEvent } = req.query;

    const filter = {};

    if (isEvent === "true") {
      filter.isEvent = true;
    } else if (isEvent === "false" || isEvent === undefined) {
      // Default: only regular categories
      filter.isEvent = false;
    }
    // If isEvent === "all", don't apply any filter

    const categories = await Category.find(filter).sort({ displayOrder: 1 });

    res.json(categories);
  } catch (err) {
    res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};


exports.getAllPrograms = async (req, res) => {
  try {
    const programs = await Program.find({ status: "ACTIVE" });

    res.status(200).json({
      success: true,
      count: programs.length,
      data: programs,
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};
// ✅ Retrieve Programs by Category
exports.getProgramsByCategory = async (req, res) => {
  try {
    const { categoryId } = req.params;
    const programs = await Program.find({ category: categoryId, status: "ACTIVE" });
    res.json(programs);
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ✅ Retrieve Parent's Children
exports.getChildren = async (req, res) => {
  try {
    const children = await User.find({ parentId: req.parent._id })
      .populate("category", "name")
      .populate("programs", "name")
      .populate("term", "name");

    res.json({ success: true, data: children });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ✅ Add Child Profile under Parent
exports.addChild = async (req, res) => {
  try {
    const {
      firstName,
      lastName,
      email,
      phone,
      dob,
      gender,
      category,
      categories,
      programs,
      prefferedFoot,
      isMedicalCondition,
      medicalConditionDetails,
      preferredTerm,
      preferredClasses,
      academy,
      comments,
      allergies,
    } = req.body;

    // Required fields
    if (
      !firstName ||
      !lastName ||
      !dob ||
      !category ||
      !programs
    ) {
      return res.status(400).json({
        success: false,
        message: "Required fields missing",
      });
    }

    // Normalize programs to array
    const programIds = Array.isArray(programs)
      ? programs
      : [programs];

    // Validate category
    const categoryData = await Category.findById(category);
    if (!categoryData) {
      return res.status(404).json({
        success: false,
        message: "Category not found",
      });
    }

    // Validate programs
    for (const programId of programIds) {
      const programData = await Program.findById(programId);

      if (!programData) {
        return res.status(404).json({
          success: false,
          message: `Program ${programId} not found`,
        });
      }
    }

    // Validate preferred term
    const prefTerm = preferredTerm || term || null;

    if (prefTerm) {
      const termData = await Term.findById(prefTerm);

      if (!termData) {
        return res.status(404).json({
          success: false,
          message: "Term not found",
        });
      }
    }

    // Parse DOB
    let parsedDob = null;

    if (dob) {
      const parts = dob.split("/");

      if (parts.length === 3) {
        parsedDob = new Date(
          `${parts[2]}-${parts[1]}-${parts[0]}`
        );
      } else {
        parsedDob = new Date(dob);
      }
    }

    // Profile image
    let profileImage = null;

    if (req.file) {
      profileImage = `uploads/profiles/${req.file.filename}`;
    }

    // Create Player
    const player = await User.create({
      firstName,
      lastName,
      fullName: `${firstName} ${lastName}`,

      email: email || null,
      phone: phone || null,

      dob: parsedDob,
      gender,
      prefferedFoot,
      isMedicalCondition,
      medicalConditionDetails,
      parentId: req.parent._id,

      academy,
      comments,

      category,
      categories: Array.isArray(categories) ? categories : (category ? [category] : []),
      programs: programIds,

      // Player is assigned term by admin after approval
      term: null,

      paymentStatus: "TRIAL",
      rating: 1,

      profileImage,

      assignedClasses: [],
      attendancePercentage: 0,
    });

    // Normalize preferred classes
    const prefClasses = Array.isArray(preferredClasses)
      ? preferredClasses
      : [];

    // Create Registration Request
    const registrationRequest =
      await RegistrationRequest.create({
        parent: req.parent._id,
        player: player._id,
        category,
        programs: programIds,
        preferredTerm: prefTerm,
        preferredClasses: prefClasses,
        requestType: "NEW_PLAYER",
        status: "PENDING",
        createdBy: req.parent._id,
      });

    // Create Medical Profile
    await MedicalProfile.create({
      player: player._id,
      medicalConditions: "",
      allergies: Array.isArray(allergies)
        ? allergies
        : allergies
          ? [allergies]
          : [],
    });

    // Notify Admin (Non-blocking)
    createAdminNotificationForRequest({
      parent: req.parent._id,
      player: player._id,
      category,
      programs: programIds,
      preferredTerm: prefTerm,
      preferredClasses: prefClasses,
      requestType: "NEW_PLAYER",
    });

    return res.status(201).json({
      success: true,
      message:
        "Child added and enrollment request submitted successfully.",
      data: {
        player,
        registrationRequest,
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

// ✅ Request Additional Program or Holiday Program for Existing Player (Parent)
exports.requestAddProgram = async (req, res) => {
  try {
    const { playerId, category, categories, programs, preferredTerm, preferredClasses, requestType } = req.body;

    if (!playerId || (!category && (!categories || categories.length === 0)) || !programs) {
      return res.status(400).json({
        success: false,
        message: "playerId, category/categories, and programs are required",
      });
    }

    const player = await User.findById(playerId);
    if (!player) {
      return res.status(404).json({
        success: false,
        message: "Player not found",
      });
    }

    // Verify parent ownership
    if (player.parentId.toString() !== req.parent._id.toString()) {
      return res.status(403).json({
        success: false,
        message: "You are not authorized to request programs for this player",
      });
    }

    const programIds = Array.isArray(programs) ? programs : [programs];

    const categoryList = Array.isArray(categories)
      ? categories
      : category
        ? Array.isArray(category)
          ? category
          : [category]
        : [];
    const primaryCategory = categoryList[0] || category;

    // Validate Category & Programs
    if (primaryCategory) {
      const categoryDoc = await Category.findById(primaryCategory);
      if (!categoryDoc) {
        return res.status(404).json({
          success: false,
          message: "Category not found",
        });
      }
    }

    for (const progId of programIds) {
      const progDoc = await Program.findById(progId);
      if (!progDoc) {
        return res.status(404).json({
          success: false,
          message: `Program ${progId} not found`,
        });
      }
    }

    const prefTerm = preferredTerm || null;
    if (prefTerm) {
      const termData = await Term.findById(prefTerm);
      if (!termData) {
        return res.status(404).json({
          success: false,
          message: "Term not found",
        });
      }
    }

    const prefClasses = Array.isArray(preferredClasses) ? preferredClasses : [];
    const reqType = requestType || "ADD_PROGRAM";

    // Create RegistrationRequest
    const registrationRequest = await RegistrationRequest.create({
      parent: req.parent._id,
      player: player._id,
      category: primaryCategory,
      programs: programIds,
      preferredTerm: prefTerm,
      preferredClasses: prefClasses,
      requestType: reqType,
      status: "PENDING",
      createdBy: req.parent._id,
    });

    // Update categories on player
    player.categories = player.categories || [];
    for (const catId of categoryList) {
      const catStr = catId.toString();
      if (!player.categories.some((c) => c.toString() === catStr)) {
        player.categories.push(catId);
      }
    }
    if (!player.category && primaryCategory) {
      player.category = primaryCategory;
    }

    // Set hasPendingRequest flag on player so they appear in unallocated list
    player.hasPendingRequest = true;
    await player.save();

    // Create Admin Notification (non-blocking)
    createAdminNotificationForRequest({
      parent: req.parent._id,
      player: player._id,
      category: primaryCategory,
      programs: programIds,
      preferredTerm: prefTerm,
      preferredClasses: prefClasses,
      requestType: reqType,
    });

    return res.status(201).json({
      success: true,
      message: `${reqType === "HOLIDAY_PROGRAM" ? "Holiday program" : "Program addition"} request submitted successfully`,
      data: registrationRequest,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

// ✅ Register specifically for a Holiday Program
exports.registerForHolidayProgram = async (req, res) => {
  req.body.requestType = "HOLIDAY_PROGRAM";
  return exports.requestAddProgram(req, res);
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

  while (current.getUTCDay() !== targetDay) {
    current.setUTCDate(current.getUTCDate() + 1);
  }

  while (current <= end) {
    sessions.push(new Date(current));
    current.setUTCDate(current.getUTCDate() + 7);
  }

  return sessions;
};

// ✅ Fetch Classes with Attendance for Child
exports.getMyClasses = async (req, res) => {
  try {
    // Determine player ID (path param, query param, or default to parent's first child)
    let playerId = req.params.playerId || req.query.playerId;
    if (!playerId) {
      const firstChild = await User.findOne({ parentId: req.parent._id });
      if (!firstChild) {
        return res.status(200).json({
          success: true,
          message: "Classes with attendance fetched successfully",
          overallAttendancePercentage: 0,
          currentMonthCalendar: null,
          data: [],
        });
      }
      playerId = firstChild._id;
    } else {
      // Validate child ownership
      const child = await User.findOne({ _id: playerId, parentId: req.parent._id });
      if (!child) {
        return res.status(403).json({ success: false, message: "Unauthorized child profile" });
      }
    }

    const player = await User.findById(playerId)
      .populate({
        path: "assignedClasses",
        populate: [
          { path: "term", select: "name startDate endDate" },
          { path: "program", select: "name" },
          { path: "category", select: "name" },
          { path: "coach", select: "name email phone" },
        ],
      })
      .select("fullName email assignedClasses");

    if (!player) {
      return res.status(404).json({ success: false, message: "Player not found" });
    }

    const classIds = player.assignedClasses.map((c) => c._id);
    const allAttendance = await Attendance.find({
      class: { $in: classIds },
    }).select("class sessionDate records");

    const attendanceByClass = {};
    allAttendance.forEach((att) => {
      const classId = att.class.toString();
      if (!attendanceByClass[classId]) {
        attendanceByClass[classId] = [];
      }
      attendanceByClass[classId].push(att);
    });

    const result = [];
    const dayNames = ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"];

    for (const cls of player.assignedClasses) {
      if (!cls.term) continue;

      const classAttendance = attendanceByClass[cls._id.toString()] || [];
      const allSessions = generateClassSessions(cls.term, cls);
      const sessions = [];

      let presentCount = 0;
      let missedSessions = 0;

      allSessions.forEach((sessionDate) => {
        const normalizedDate = new Date(sessionDate);
        normalizedDate.setUTCHours(0, 0, 0, 0);

        const attendanceRecord = classAttendance.find((att) => {
          const dbDate = new Date(att.sessionDate);
          dbDate.setUTCHours(0, 0, 0, 0);
          return dbDate.getTime() === normalizedDate.getTime();
        });

        let status = "NOT_MARKED";
        let reason = "";
        let remarks = "";
        let markedByParent = false;

        if (attendanceRecord) {
          const record = attendanceRecord.records.find(
            (r) => r.player.toString() === playerId.toString()
          );
          if (record) {
            status = record.status;
            reason = record.reason || record.remarks || "";
            remarks = record.remarks || "";
            markedByParent = record.markedByParent || false;
          } else {
            status = "ABSENT";
          }
        }

        if (status === "PRESENT") presentCount++;
        else if (status === "ABSENT") missedSessions++;

        sessions.push({
          date: normalizedDate.toISOString().split("T")[0],
          day: dayNames[normalizedDate.getUTCDay()],
          startTime: cls.startTime,
          endTime: cls.endTime,
          status,
          reason,
          remarks,
          markedByParent,
        });
      });

      const totalSessions = allSessions.length;
      const attendancePercentage =
        totalSessions > 0
          ? Number(((presentCount / totalSessions) * 100).toFixed(1))
          : 0;

      result.push({
        classId: cls._id,
        className: cls.name,
        term: cls.term,
        program: cls.program,
        category: cls.category,
        coach: cls.coach,
        attendancePercentage,
        presentCount,
        missedSessions,
        totalSessions,
        sessions,
      });
    }

    // ---------------------------------------------------
    // 1. Overall Attendance Percentage
    // ---------------------------------------------------
    let grandTotalSessions = 0;
    let grandTotalPresent = 0;

    for (const item of result) {
      grandTotalSessions += item.totalSessions;
      grandTotalPresent += item.presentCount;
    }

    const overallAttendancePercentage =
      grandTotalSessions > 0
        ? Number(((grandTotalPresent / grandTotalSessions) * 100).toFixed(1))
        : 0;

    // ---------------------------------------------------
    // 2. Current Month Calendar (All classes data in target/current month)
    // ---------------------------------------------------
    const now = new Date();
    const targetYear = req.query.year ? Number(req.query.year) : now.getUTCFullYear();
    const targetMonth = req.query.month ? Number(req.query.month) : now.getUTCMonth() + 1;

    const monthNames = [
      "January", "February", "March", "April", "May", "June",
      "July", "August", "September", "October", "November", "December"
    ];

    const currentMonthName = monthNames[targetMonth - 1] || "July";
    const currentMonthYearStr = `${currentMonthName} ${targetYear}`;

    const currentMonthEvents = [];
    let currentMonthPresentCount = 0;
    let currentMonthMissedCount = 0;

    for (const item of result) {
      for (const sess of item.sessions) {
        const d = new Date(sess.date);
        const sessYear = d.getUTCFullYear();
        const sessMonth = d.getUTCMonth() + 1;

        if (sessYear === targetYear && sessMonth === targetMonth) {
          if (sess.status === "PRESENT") {
            currentMonthPresentCount++;
          } else if (sess.status === "ABSENT") {
            currentMonthMissedCount++;
          }

          currentMonthEvents.push({
            date: sess.date,
            day: sess.day,
            startTime: sess.startTime,
            endTime: sess.endTime,
            status: sess.status,
            classId: item.classId,
            className: item.className,
            program: item.program,
            category: item.category,
            coach: item.coach,
            term: item.term,
          });
        }
      }
    }

    currentMonthEvents.sort((a, b) => new Date(a.date) - new Date(b.date));

    const totalCurrentMonthSessions = currentMonthEvents.length;
    const currentMonthAttendancePercentage =
      totalCurrentMonthSessions > 0
        ? Number(((currentMonthPresentCount / totalCurrentMonthSessions) * 100).toFixed(1))
        : 0;

    // Group current month events by date
    const daysMap = {};
    currentMonthEvents.forEach((evt) => {
      if (!daysMap[evt.date]) {
        daysMap[evt.date] = {
          date: evt.date,
          day: evt.day,
          classes: [],
        };
      }
      daysMap[evt.date].classes.push({
        classId: evt.classId,
        className: evt.className,
        startTime: evt.startTime,
        endTime: evt.endTime,
        status: evt.status,
        program: evt.program,
        category: evt.category,
        coach: evt.coach,
        term: evt.term,
      });
    });

    const currentMonthCalendar = {
      month: currentMonthName,
      year: targetYear,
      monthNumber: targetMonth,
      monthYear: currentMonthYearStr,
      attendancePercentage: currentMonthAttendancePercentage,
      totalSessions: totalCurrentMonthSessions,
      presentCount: currentMonthPresentCount,
      missedSessions: currentMonthMissedCount,
      days: Object.values(daysMap).sort((a, b) => new Date(a.date) - new Date(b.date)),
      events: currentMonthEvents,
    };

    return res.status(200).json({
      success: true,
      message: "Classes with attendance fetched successfully",
      overallAttendancePercentage,
      currentMonthCalendar,
      data: result,
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Something went wrong" });
  }
};

// ✅ Fetch Attendance for Child by Class ID
exports.getMyAttendanceByClass = async (req, res) => {
  try {
    let playerId = req.query.playerId;
    if (!playerId) {
      const firstChild = await User.findOne({ parentId: req.parent._id });
      if (!firstChild) {
        return res.status(400).json({ success: false, message: "No children profiles found" });
      }
      playerId = firstChild._id;
    } else {
      // Validate ownership
      const child = await User.findOne({ _id: playerId, parentId: req.parent._id });
      if (!child) {
        return res.status(403).json({ success: false, message: "Unauthorized child profile" });
      }
    }

    const { classId } = req.params;
    const cls = await Class.findById(classId).populate({
      path: "term",
      select: "startDate endDate",
    });

    if (!cls) {
      return res.status(404).json({ success: false, message: "Class not found" });
    }

    const allSessions = generateClassSessions(cls.term, cls);
    const sessionDates = allSessions.map((d) => new Date(d).toISOString().split("T")[0]);

    const attendanceData = await Attendance.find({ class: classId }).select("sessionDate records");
    const attendanceMap = {};

    attendanceData.forEach((att) => {
      const date = new Date(att.sessionDate).toISOString().split("T")[0];
      const record = att.records.find((r) => r.player.toString() === playerId.toString());
      if (record) {
        attendanceMap[date] = record.status;
      }
    });

    let presentCount = 0;
    let missedSessions = 0;

    const sessions = sessionDates.map((date) => {
      let status = attendanceMap[date] || "NOT_MARKED";
      if (status === "PRESENT") presentCount++;
      else if (status === "ABSENT") missedSessions++;

      return { date, status };
    });

    const totalSessions = sessionDates.length;
    const attendancePercentage =
      totalSessions > 0
        ? Number(((presentCount / totalSessions) * 100).toFixed(1))
        : 0;

    res.json({
      success: true,
      data: {
        classId,
        totalSessions,
        presentCount,
        missedSessions,
        attendancePercentage,
        sessions,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ✅ Parent Dashboard Overview
exports.getDashboard = async (req, res) => {
  try {
    const parentId = req.parent._id;

    // 1. Fetch children
    const children = await User.find({ parentId }).select("_id fullName assignedClasses goals assists appearances");
    const childIds = children.map((c) => c._id);

    // 2. Upcoming training session (first child's next weekly class)
    let upcomingTraining = null;
    const classes = await Class.find({ players: { $in: childIds } })
      .populate("term", "startDate endDate")
      .populate("coach", "name email");

    if (classes.length > 0) {
      // Pick first class
      const cls = classes[0];
      const nextSessions = generateClassSessions(cls.term, cls).filter((d) => d >= new Date());
      if (nextSessions.length > 0) {
        upcomingTraining = {
          classId: cls._id,
          className: cls.name,
          date: nextSessions[0].toISOString().split("T")[0],
          dayOfWeek: cls.dayOfWeek,
          startTime: cls.startTime,
          endTime: cls.endTime,
          venue: cls.venue || cls.location,
          coach: cls.coach?.name || "N/A",
        };
      }
    }

    // 3. Next match (Fixtures involving teams where our children belong)
    const teams = await mongoose.model("Team").find({ players: { $in: childIds } }).select("_id");
    const teamIds = teams.map((t) => t._id);
    const nextMatchDoc = await Fixture.findOne({
      $or: [{ homeTeam: { $in: teamIds } }, { awayTeam: { $in: teamIds } }],
      kickoffTime: { $gte: new Date() },
    })
      .populate("homeTeam", "teamName logo")
      .populate("awayTeam", "teamName logo")
      .sort({ kickoffTime: 1 });

    let nextMatch = null;
    if (nextMatchDoc) {
      nextMatch = {
        fixtureId: nextMatchDoc._id,
        homeTeam: nextMatchDoc.homeTeam.teamName,
        awayTeam: nextMatchDoc.awayTeam.teamName,
        venue: nextMatchDoc.venue,
        kickoffTime: nextMatchDoc.kickoffTime,
      };
    }

    // 4. Combined Stats
    let totalGoals = 0;
    let totalAssists = 0;
    let totalAppearances = 0;
    children.forEach((c) => {
      totalGoals += c.goals || 0;
      totalAssists += c.assists || 0;
      totalAppearances += c.appearances || 0;
    });

    // 5. Outstanding Payments (Invoices pending)
    const unpaidInvoices = await Invoice.find({ parent: parentId, status: { $in: ["PENDING", "OVERDUE"] } });
    const outstandingPayments = unpaidInvoices.reduce((sum, inv) => sum + inv.amount, 0);

    // 6. Latest News (Featured news)
    const latestNews = await News.find()
      .sort({ publishedAt: -1 })
      .limit(3)
      .populate("publishedBy", "name");

    res.json({
      success: true,
      data: {
        upcomingTraining,
        nextMatch,
        stats: {
          goals: totalGoals,
          assists: totalAssists,
          appearances: totalAppearances,
        },
        outstandingPayments,
        latestNews,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
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

exports.getPlayerProfile = async (req, res) => {
  try {
    const { playerId } = req.params;

    const player = await User.findById(playerId)
      .populate(
        "parentId",
        "fullName email phone address city state postcode country emergencyContact relationship"
      )
      .populate("category", "name")
      .populate("programs", "name")
      .populate("term", "name")
      .populate("assignedClasses", "title classDate startTime endTime");

    if (!player) {
      return res.status(404).json({
        success: false,
        message: "Player not found",
      });
    }

    const medicalProfile = await MedicalProfile.findOne({
      player: player._id,
    });

    // Calculate age
    let age = null;

    if (player.dob) {
      const today = new Date();
      age = today.getFullYear() - player.dob.getFullYear();

      const month = today.getMonth() - player.dob.getMonth();

      if (
        month < 0 ||
        (month === 0 && today.getDate() < player.dob.getDate())
      ) {
        age--;
      }
    }

    return res.status(200).json({
      success: true,
      data: {
        _id: player._id,

        firstName: player.firstName,
        lastName: player.lastName,
        fullName: player.fullName,

        profileImage: player.profileImage,

        age,
        dob: player.dob,
        joinedDate: player.joinedDate,

        email: player.email,
        phone: player.phone,

        gender: player.gender,

        club: player.club,
        academy: player.academy,
        school: player.school,

        skillLevel: player.skillLevel,

        category: player.category,
        programs: player.programs,
        term: player.term,

        nationality: player.nationality,

        paymentStatus: player.paymentStatus,
        rating: player.rating,

        attendancePercentage: player.attendancePercentage,

        statistics: player.statistics,

        medicalProfile,

        additionalComments: player.additionalComments,
        comments: player.comments,

        parent: player.parentId,

        assignedClasses: player.assignedClasses,
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

exports.getClasses = async (req, res) => {
  try {
    const { category, program, term } = req.query;

    const query = {};

    if (category) query.category = category;
    if (program) query.program = program;
    if (term) query.term = term;

    const classes = await Class.find(query)
      .populate("category", "name")
      .populate("program", "name")
      .populate("term", "name")
      .populate("coach", "fullName email phone")
      .sort({
        dayOfWeek: 1,
        startTime: 1,
      });

    return res.status(200).json({
      success: true,
      count: classes.length,
      data: classes,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

// ✅ Parent Mark Player Absent for Class Session
exports.markPlayerAbsent = async (req, res) => {
  try {
    const parentId = req.parent._id;
    const { playerId, classId, sessionDate, reason } = req.body;

    if (!playerId || !classId || !sessionDate) {
      return res.status(400).json({
        success: false,
        message: "playerId, classId, and sessionDate are required",
      });
    }

    if (!reason || !reason.trim()) {
      return res.status(400).json({
        success: false,
        message: "Reason for absence is required",
      });
    }

    // 1. Validate Parent ownership of Child Profile
    const childDoc = await User.findOne({ _id: playerId, parentId });
    if (!childDoc) {
      return res.status(403).json({
        success: false,
        message: "Unauthorized child profile",
      });
    }

    // 2. Validate Class & Enrollment
    const classDoc = await Class.findById(classId).populate("term");
    if (!classDoc) {
      return res.status(404).json({
        success: false,
        message: "Class not found",
      });
    }

    const isAssigned =
      childDoc.assignedClasses &&
      childDoc.assignedClasses.some((c) => c.toString() === classId.toString());
    if (!isAssigned) {
      return res.status(400).json({
        success: false,
        message: "Player is not enrolled in this class",
      });
    }

    // 3. Date & Session Timing Validation (Today or Future sessions only)
    const targetDate = new Date(sessionDate);
    if (isNaN(targetDate.getTime())) {
      return res.status(400).json({
        success: false,
        message: "Invalid sessionDate format",
      });
    }

    targetDate.setUTCHours(0, 0, 0, 0);

    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);

    if (targetDate.getTime() < today.getTime()) {
      return res.status(400).json({
        success: false,
        message:
          "Cannot mark absent for past class sessions. You can only mark absent for today's session or future upcoming sessions.",
      });
    }

    // Check if session date falls within Term range and matches day of week
    if (classDoc.term) {
      const termStart = new Date(classDoc.term.startDate);
      termStart.setUTCHours(0, 0, 0, 0);
      const termEnd = new Date(classDoc.term.endDate);
      termEnd.setUTCHours(23, 59, 59, 999);

      if (targetDate < termStart || targetDate > termEnd) {
        return res.status(400).json({
          success: false,
          message: `Session date is outside of Term dates (${classDoc.term.name})`,
        });
      }

      if (classDoc.dayOfWeek) {
        const dayNames = [
          "SUNDAY",
          "MONDAY",
          "TUESDAY",
          "WEDNESDAY",
          "THURSDAY",
          "FRIDAY",
          "SATURDAY",
        ];
        const sessionDay = dayNames[targetDate.getUTCDay()];
        if (sessionDay !== classDoc.dayOfWeek.toUpperCase()) {
          return res.status(400).json({
            success: false,
            message: `Selected date is a ${sessionDay}, but this class runs on ${classDoc.dayOfWeek}`,
          });
        }
      }
    }

    // 4. Find or Create Attendance Document
    let attendanceDoc = await Attendance.findOne({
      class: classId,
      sessionDate: targetDate,
    });

    if (!attendanceDoc) {
      attendanceDoc = new Attendance({
        class: classId,
        sessionDate: targetDate,
        records: [],
      });
    }

    // Check if record for this player already exists
    const recordIndex = attendanceDoc.records.findIndex(
      (r) => r.player.toString() === playerId.toString()
    );

    if (recordIndex >= 0) {
      attendanceDoc.records[recordIndex].status = "ABSENT";
      attendanceDoc.records[recordIndex].remarks = reason.trim();
      attendanceDoc.records[recordIndex].reason = reason.trim();
      attendanceDoc.records[recordIndex].markedByParent = true;
    } else {
      attendanceDoc.records.push({
        player: playerId,
        status: "ABSENT",
        remarks: reason.trim(),
        reason: reason.trim(),
        markedByParent: true,
      });
    }

    await attendanceDoc.save();

    // 5. Send Notification to Admin & Assigned Coach
    try {
      const formattedDateStr = targetDate.toISOString().split("T")[0];
      const notifData = {
        parentId: String(req.parent._id),
        playerId: String(playerId),
        classId: String(classId),
        sessionDate: formattedDateStr,
        reason: reason.trim(),
      };

      await sendNotification({
        recipientType: "ADMIN",
        adminId: null,
        title: "Player Absence Notice 😷",
        message: `${req.parent.fullName} marked ${childDoc.fullName} ABSENT for class "${classDoc.name}" on ${formattedDateStr}. Reason: ${reason.trim()}`,
        type: "ATTENDANCE_ALERT",
        data: notifData,
      });

      if (classDoc.coach) {
        await sendNotification({
          recipientType: "COACH",
          coachId: classDoc.coach,
          title: "Player Absence Notice 😷",
          message: `${req.parent.fullName} marked ${childDoc.fullName} ABSENT for class "${classDoc.name}" on ${formattedDateStr}. Reason: ${reason.trim()}`,
          type: "ATTENDANCE_ALERT",
          data: notifData,
        });
      }
    } catch (notifErr) {
      console.error("Absence notice notification error:", notifErr.message);
    }

    return res.status(200).json({
      success: true,
      message: "Player marked as absent for the class session successfully",
      data: {
        playerId,
        classId,
        sessionDate: targetDate.toISOString().split("T")[0],
        status: "ABSENT",
        reason: reason.trim(),
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

// ✅ Get all programs & registrations for a parent's player(s)
exports.getPlayerPrograms = async (req, res) => {
  try {
    const parentId = req.parent ? req.parent._id : req.user ? req.user._id : null;
    const { playerId } = req.params;

    if (!parentId) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized access",
      });
    }

    let players = [];

    if (playerId) {
      const player = await User.findById(playerId);
      if (!player) {
        return res.status(404).json({
          success: false,
          message: "Player not found",
        });
      }

      if (player.parentId.toString() !== parentId.toString()) {
        return res.status(403).json({
          success: false,
          message: "You are not authorized to view programs for this player",
        });
      }
      players = [player];
    } else {
      players = await User.find({ parentId });
    }

    const playerIds = players.map((p) => p._id);

    // Fetch full player data with populated programs & classes
    const fullPlayers = await User.find({ _id: { $in: playerIds } })
      .populate({
        path: "programs",
        populate: { path: "category", select: "name description" },
      })
      .populate("category", "name")
      .populate("categories", "name")
      .populate({
        path: "assignedClasses",
        populate: [
          { path: "program", select: "name description fees ageGroup" },
          { path: "category", select: "name" },
          { path: "term", select: "name startDate endDate" },
          { path: "coach", select: "fullName email phone" },
        ],
      });

    // Fetch all RegistrationRequests for these players
    const registrationRequests = await RegistrationRequest.find({
      player: { $in: playerIds },
    })
      .populate("category", "name")
      .populate("programs", "name description fees ageGroup")
      .populate("preferredTerm", "name startDate endDate")
      .populate("preferredClasses", "name dayOfWeek startTime endTime venue location")
      .sort({ createdAt: -1 });

    // Fetch EventRegistrations for these players
    const eventRegistrations = await EventRegistration.find({
      user: { $in: playerIds },
      status: "REGISTERED",
    })
      .populate("event")
      .sort({ createdAt: -1 });

    // Format output
    const results = fullPlayers.map((player) => {
      const pIdStr = player._id.toString();

      const pRequests = registrationRequests.filter(
        (r) => r.player.toString() === pIdStr
      );

      const pEvents = eventRegistrations.filter(
        (e) => e.user.toString() === pIdStr
      );

      return {
        player: {
          _id: player._id,
          firstName: player.firstName,
          lastName: player.lastName,
          fullName: player.fullName,
          profileImage: player.profileImage,
          category: player.category,
          categories: player.categories,
          hasPendingRequest: player.hasPendingRequest,
        },
        enrolledPrograms: player.programs || [],
        assignedClasses: player.assignedClasses || [],
        registrationRequests: pRequests,
        eventRegistrations: pEvents,
      };
    });

    return res.status(200).json({
      success: true,
      count: results.length,
      data: playerId ? results[0] : results,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};