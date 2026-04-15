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
const Attendance = require("../models/Attendance");
const Class = require("../models/Class");

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


const generateClassSessions = (term, classObj) => {
  const sessions = [];

  // ✅ normalize start & end to UTC midnight
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

  // ✅ move to correct weekday
  while (current.getUTCDay() !== targetDay) {
    current.setUTCDate(current.getUTCDate() + 1);
  }

  // ✅ weekly loop
  while (current <= end) {
    sessions.push(new Date(current));

    current.setUTCDate(current.getUTCDate() + 7);
  }

  return sessions;
};


// exports.getMyClasses = async (req, res) => {
//   try {
//     const userId = req.user._id;

//     const user = await User.findById(userId)
//       .populate({
//         path: "assignedClasses",
//         populate: [
//           { path: "term", select: "name startDate endDate" },
//           { path: "program", select: "name" },
//           { path: "category", select: "name" },
//           { path: "coach", select: "name email phone" },
//         ],
//       })
//       .select("fullName email assignedClasses");

//     if (!user) {
//       return res.status(404).json({
//         success: false,
//         message: "User not found",
//       });
//     }

//     // ✅ Day name mapping
//     const dayNames = [
//       "SUNDAY",
//       "MONDAY",
//       "TUESDAY",
//       "WEDNESDAY",
//       "THURSDAY",
//       "FRIDAY",
//       "SATURDAY",
//     ];

//     const result = [];

//     for (const cls of user.assignedClasses) {
//       const allSessions = generateClassSessions(cls.term, cls);

//       const sessions = allSessions.map((d) => {
//         const date = new Date(d);

//         return {
//           date: date.toISOString().split("T")[0], // ✅ YYYY-MM-DD
//           day: dayNames[date.getUTCDay()],        // ✅ MONDAY
//           startTime: cls.startTime,               // ✅ class time
//           endTime: cls.endTime,                   // ✅ class time
//         };
//       });

//       result.push({
//         classId: cls._id,
//         className: cls.name,
//         term: cls.term,
//         program: cls.program,
//         category: cls.category,
//         coach: cls.coach,

//         totalSessions: sessions.length,
//         sessions,
//       });
//     }

//     res.json({
//       success: true,
//       message: "Classes fetched successfully",
//       data: result,
//     });

//   } catch (error) {
//     console.error(error);
//     res.status(500).json({
//       success: false,
//       message: error.message,
//     });
//   }
// };

exports.getMyAttendanceByClass = async (req, res) => {
  try {
    const userId = req.user._id;
    const { classId } = req.params;

    // ✅ get class with term
    const cls = await Class.findById(classId)
      .populate({
        path: "term",
        select: "startDate endDate",
      });

    if (!cls) {
      return res.status(404).json({
        message: "Class not found",
      });
    }

    // ✅ 1. generate all sessions
    const allSessions = generateClassSessions(cls.term, cls);

    const sessionDates = allSessions.map((d) =>
      new Date(d).toISOString().split("T")[0]
    );

    // ✅ 2. get attendance for this class
    const attendanceData = await Attendance.find({
      class: classId,
    }).select("sessionDate records");

    // ✅ 3. convert attendance to map
    const attendanceMap = {};

    attendanceData.forEach((att) => {
      const date = new Date(att.sessionDate)
        .toISOString()
        .split("T")[0];

      const record = att.records.find(
        (r) => r.player.toString() === userId.toString()
      );

      if (record) {
        attendanceMap[date] = record.status;
      }
    });

    // ✅ 4. calculate stats
    let presentCount = 0;
    let missedSessions = 0;

    const sessions = sessionDates.map((date) => {
      let status = attendanceMap[date] || "NOT_MARKED";

      if (status === "PRESENT") presentCount++;
      else if (status === "ABSENT") missedSessions++;

      return {
        date,
        status,
      };
    });

    const totalSessions = sessionDates.length;

    const attendancePercentage =
      totalSessions > 0
        ? Number(
          ((presentCount / totalSessions) * 100).toFixed(1)
        )
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
    res.status(500).json({ message: err.message });
  }
};

exports.getMyClasses = async (req, res) => {
  try {
    const userId = req.user._id;

    const user = await User.findById(userId)
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

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    const classIds = user.assignedClasses.map((c) => c._id);

    // fetch all attendance
    const allAttendance = await Attendance.find({
      class: { $in: classIds },
    }).select("class sessionDate records");

    // group attendance by class
    const attendanceByClass = {};

    allAttendance.forEach((att) => {
      const classId = att.class.toString();

      if (!attendanceByClass[classId]) {
        attendanceByClass[classId] = [];
      }

      attendanceByClass[classId].push(att);
    });

    const result = [];

    for (const cls of user.assignedClasses) {
      const classAttendance =
        attendanceByClass[cls._id.toString()] || [];

      // ✅ generate ALL sessions
      const allSessions = generateClassSessions(cls.term, cls);

      const sessions = [];

      let presentCount = 0;
      let missedSessions = 0;

      const dayNames = [
        "SUNDAY",
        "MONDAY",
        "TUESDAY",
        "WEDNESDAY",
        "THURSDAY",
        "FRIDAY",
        "SATURDAY",
      ];

      allSessions.forEach((sessionDate) => {
        const normalizedDate = new Date(sessionDate);
        normalizedDate.setUTCHours(0, 0, 0, 0);

        // ✅ match attendance safely
        const attendanceRecord = classAttendance.find((att) => {
          const dbDate = new Date(att.sessionDate);
          dbDate.setUTCHours(0, 0, 0, 0);

          return dbDate.getTime() === normalizedDate.getTime();
        });

        let status = "NOT_MARKED"; // ✅ FIXED

        if (attendanceRecord) {
          const record = attendanceRecord.records.find(
            (r) => r.player.toString() === userId.toString()
          );

          if (record) {
            status = record.status; // PRESENT / ABSENT / LATE
          } else {
            status = "ABSENT"; // session marked but player missing
          }
        }

        if (status === "PRESENT") presentCount++;
        else if (status === "ABSENT") missedSessions++;

        // sessions.push({
        //   date: normalizedDate.toISOString().split("T")[0],
        //   status,
        // });
        sessions.push({
          date: normalizedDate.toISOString().split("T")[0],
          day: dayNames[normalizedDate.getUTCDay()], // ✅ added
          startTime: cls.startTime,                  // ✅ added
          endTime: cls.endTime,                      // ✅ added
          status,
        });
      });

      const totalSessions = allSessions.length;

      const attendancePercentage =
        totalSessions > 0
          ? Number(
            ((presentCount / totalSessions) * 100).toFixed(1)
          )
          : 0;

      result.push({
        classId: cls._id,
        className: cls.name,
        term: cls.term,
        program: cls.program,
        category: cls.category,
        coach: cls.coach,

        // ✅ attendance data
        attendancePercentage,
        presentCount,
        missedSessions,
        totalSessions,
        sessions,
      });
    }

    return res.status(200).json({
      success: true,
      message: "Classes with attendance fetched successfully",
      data: result,
    });

  } catch (error) {
    console.error(error);
    return res.status(500).json({
      success: false,
      message: "Something went wrong",
    });
  }
};