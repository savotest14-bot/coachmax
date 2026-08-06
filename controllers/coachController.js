const Class = require("../models/Class");
const Team = require("../models/Team");
const User = require("../models/User");
const Attendance = require("../models/Attendance");
const CoachNote = require("../models/CoachNote");
const MedicalProfile = require("../models/MedicalProfile");
const Term = require("../models/Term");
const mongoose = require("mongoose");
const Admin = require("../models/Admin");

// ─────────────────────────────────────────────
// Helper: Generate class sessions from term dates
// (reused from adminAuthController logic)
// ─────────────────────────────────────────────
const generateClassSessions = (term, classObj) => {
  const sessions = [];
  const start = new Date(term.startDate);
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(term.endDate);
  end.setUTCHours(0, 0, 0, 0);

  const dayMap = {
    SUNDAY: 0, MONDAY: 1, TUESDAY: 2, WEDNESDAY: 3,
    THURSDAY: 4, FRIDAY: 5, SATURDAY: 6,
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

// ═══════════════════════════════════════════════
// FEATURE 1 — Assigned Classes
// ═══════════════════════════════════════════════

/**
 * GET /api/coach/classes
 * Returns only classes assigned to the authenticated coach.
 * Supports pagination, search, and filtering.
 */
exports.getMyAssignedClasses = async (req, res) => {
  try {
    const coachId = req.admin._id;
    let { page = 1, limit = 20, search = "", day, programId, categoryId } = req.query;

    page = Number(page);
    limit = Number(limit);

    // Build query: coach or assistantCoach
    const query = {
      $or: [{ coach: coachId }, { assistantCoach: coachId }],
      status: "ACTIVE",
    };

    if (day) query.dayOfWeek = day;
    if (programId) query.program = programId;
    if (categoryId) query.category = categoryId;
    if (search) {
      query.name = { $regex: search, $options: "i" };
    }

    const total = await Class.countDocuments(query);

    const classes = await Class.find(query)
      .populate("term", "name startDate endDate year")
      .populate("program", "name ageGroup")
      .populate("category", "name ageRange")
      .populate("coach", "name email mobile")
      .populate("assistantCoach", "name email mobile")
      .populate("players", "fullName profileImage dob isMedicalCondition medicalConditionDetails")
      .sort({ dayOfWeek: 1, startTime: 1 })
      .skip((page - 1) * limit)
      .limit(limit);

    // Build enriched class data with sessions
    const result = [];

    for (const cls of classes) {
      let sessions = [];
      if (cls.term) {
        sessions = generateClassSessions(cls.term, cls);
      }

      const formattedSessions = sessions.map((date) => ({
        date: date.toISOString().split("T")[0],
        day: date.getUTCDate(),
        month: date.getUTCMonth() + 1,
        year: date.getUTCFullYear(),
      }));

      result.push({
        classId: cls._id,
        className: cls.name,
        dayOfWeek: cls.dayOfWeek,
        startTime: cls.startTime,
        endTime: cls.endTime,
        venue: cls.venue || cls.location || "",
        location: cls.location || "",
        sessionDuration: cls.sessionDuration,
        trainingType: cls.trainingType,
        capacity: cls.capacity,
        term: cls.term,
        program: cls.program,
        category: cls.category,
        coach: cls.coach,
        assistantCoach: cls.assistantCoach,
        totalPlayers: cls.players.length,
        players: cls.players,
        totalSessions: formattedSessions.length,
        sessions: formattedSessions,
      });
    }

    res.json({
      success: true,
      message: "Assigned classes fetched successfully",
      totalClasses: total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      data: result,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};


exports.getClassDropdown = async (req, res) => {
  try {
    const adminId = req.admin._id;

    // Fetch latest admin details from DB
    const admin = await Admin.findById(adminId).select("role");

    if (!admin) {
      return res.status(404).json({
        success: false,
        message: "Admin not found",
      });
    }

    let query = {
      status: "ACTIVE",
    };

    // Coach -> only assigned classes
    if (admin.role === "COACH") {
      query.$or = [
        { coach: adminId },
        { assistantCoach: adminId },
      ];
    }

    // Super Admin -> all active classes
    const classes = await Class.find(query)
      .select("_id name")
      .sort({ name: 1 });

    return res.status(200).json({
      success: true,
      message: "Classes fetched successfully",
      data: classes,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};


/**
 * GET /api/coach/classes/:classId
 * Returns detailed class info for a specific assigned class.
 */
exports.getAssignedClassById = async (req, res) => {
  try {
    const { classId } = req.params;

    const cls = await Class.findById(classId)
      .populate("term", "name startDate endDate year")
      .populate("program", "name ageGroup description")
      .populate("category", "name ageRange")
      .populate("coach", "name email mobile")
      .populate("assistantCoach", "name email mobile")
      .populate({
        path: "players",
        select: "fullName profileImage dob gender isMedicalCondition medicalConditionDetails parentId assignedClasses",
        populate: {
          path: "parentId",
          select: "fullName phone email emergencyContact",
        },
      });

    if (!cls) {
      return res.status(404).json({ success: false, message: "Class not found" });
    }

    // Generate sessions
    let sessions = [];
    if (cls.term) {
      sessions = generateClassSessions(cls.term, cls);
    }

    const formattedSessions = sessions.map((date) => ({
      date: date.toISOString().split("T")[0],
      day: date.getUTCDate(),
      month: date.getUTCMonth() + 1,
      year: date.getUTCFullYear(),
    }));

    res.json({
      success: true,
      data: {
        classId: cls._id,
        className: cls.name,
        dayOfWeek: cls.dayOfWeek,
        startTime: cls.startTime,
        endTime: cls.endTime,
        venue: cls.venue || cls.location || "",
        location: cls.location || "",
        sessionDuration: cls.sessionDuration,
        trainingType: cls.trainingType,
        capacity: cls.capacity,
        equipmentRequired: cls.equipmentRequired,
        term: cls.term,
        program: cls.program,
        category: cls.category,
        coach: cls.coach,
        assistantCoach: cls.assistantCoach,
        totalPlayers: cls.players.length,
        players: cls.players,
        totalSessions: formattedSessions.length,
        sessions: formattedSessions,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * GET /api/coach/teams
 * Returns only teams assigned to the authenticated coach.
 */
exports.getMyAssignedTeams = async (req, res) => {
  try {
    const coachId = req.admin._id;
    let { page = 1, limit = 20, search = "" } = req.query;

    page = Number(page);
    limit = Number(limit);

    const query = {
      $or: [{ coach: coachId }, { assistantCoach: coachId }],
    };

    if (search) {
      query.teamName = { $regex: search, $options: "i" };
    }

    const total = await Team.countDocuments(query);

    const teams = await Team.find(query)
      .populate("coach", "name email")
      .populate("assistantCoach", "name email")
      .populate("players", "fullName profileImage dob")
      .populate("captain", "fullName")
      .populate("viceCaptain", "fullName")
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit);

    res.json({
      success: true,
      message: "Assigned teams fetched successfully",
      totalTeams: total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      data: teams,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ═══════════════════════════════════════════════
// FEATURE 3 & 7 — Player Profile & Quick Access
// ═══════════════════════════════════════════════

/**
 * GET /api/coach/player/:playerId/profile
 * Aggregated player profile with medical alerts, attendance, notes, parent info, teams, programs.
 * Coach can only access players in their assigned classes.
 */
exports.getPlayerProfile = async (req, res) => {
  try {
    const coachId = req.admin._id;
    const { playerId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(playerId)) {
      return res.status(400).json({ success: false, message: "Invalid player ID" });
    }

    // Verify player is in one of the coach's assigned classes (SUPER_ADMIN bypasses)
    if (req.admin.role === "COACH") {
      const assignedClasses = await Class.find({
        $or: [{ coach: coachId }, { assistantCoach: coachId }],
        players: playerId,
      }).select("_id");

      if (assignedClasses.length === 0) {
        return res.status(403).json({
          success: false,
          message: "Access denied. Player is not in your assigned classes.",
        });
      }
    }

    // Fetch player with populated fields
    const player = await User.findById(playerId)
      .populate({
        path: "parentId",
        select: "fullName email phone address city state postcode country emergencyContact relationship",
      })
      .populate("category", "name ageRange")
      .populate("programs", "name ageGroup")
      .populate("term", "name year")
      .populate("assignedClasses", "name dayOfWeek startTime endTime venue location")
      .lean();

    if (!player) {
      return res.status(404).json({ success: false, message: "Player not found" });
    }

    // Fetch medical profile if exists
    const medicalProfile = await MedicalProfile.findOne({ player: playerId }).lean();

    // Fetch teams player belongs to
    const teams = await Team.find({ players: playerId })
      .select("teamName ageGroup coach")
      .populate("coach", "name")
      .lean();

    // Fetch attendance history for this player
    const attendanceRecords = await Attendance.find({
      "records.player": playerId,
    })
      .select("class sessionDate records")
      .populate("class", "name dayOfWeek")
      .sort({ sessionDate: -1 })
      .limit(50)
      .lean();

    // Extract player-specific attendance
    const attendanceHistory = attendanceRecords.map((att) => {
      const playerRecord = att.records.find(
        (r) => r.player.toString() === playerId
      );
      return {
        classId: att.class?._id,
        className: att.class?.name,
        sessionDate: att.sessionDate,
        status: playerRecord?.status || "NOT_MARKED",
        comment: playerRecord?.comment || "",
        remarks: playerRecord?.remarks || "",
      };
    });

    // Fetch coach notes for this player (visible to assigned coaches, admin, super admin)
    const coachNotes = await CoachNote.find({ player: playerId })
      .populate("coach", "name")
      .populate("classId", "name")
      .sort({ createdAt: -1 })
      .lean();

    // Calculate current age
    let currentAge = null;
    if (player.dob) {
      const today = new Date();
      const birthDate = new Date(player.dob);
      currentAge = today.getFullYear() - birthDate.getFullYear();
      const monthDiff = today.getMonth() - birthDate.getMonth();
      if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birthDate.getDate())) {
        currentAge--;
      }
    }

    // Build medical alerts (highlighted at top)
    const medicalAlerts = {
      hasMedicalCondition: player.isMedicalCondition || false,
      medicalConditionDetails: player.medicalConditionDetails || "",
      allergies: medicalProfile?.allergies || [],
      injuries: medicalProfile?.injuries || [],
      medications: medicalProfile?.medications || [],
      medicalConditions: medicalProfile?.medicalConditions || "",
      emergencyContact: player.parentId?.emergencyContact || medicalProfile?.emergencyContact || "",
    };

    res.json({
      success: true,
      data: {
        // Medical alerts at top
        medicalAlerts,

        // Player overview
        player: {
          _id: player._id,
          fullName: player.fullName,
          firstName: player.firstName,
          lastName: player.lastName,
          profileImage: player.profileImage,
          dob: player.dob,
          currentAge,
          gender: player.gender,
          club: player.club,
          jerseyNumber: player.jerseyNumber,
          prefferedFoot: player.prefferedFoot,
          rating: player.rating,
          joinedDate: player.joinedDate,
          isMedicalCondition: player.isMedicalCondition,
          medicalConditionDetails: player.medicalConditionDetails,
        },

        // Parent / Guardian info
        parent: player.parentId,

        // Programs, classes, teams
        category: player.category,
        programs: player.programs,
        term: player.term,
        assignedClasses: player.assignedClasses,
        teams,

        // Attendance history
        attendanceHistory,
        attendanceSummary: {
          total: attendanceHistory.length,
          present: attendanceHistory.filter((a) => a.status === "PRESENT").length,
          absent: attendanceHistory.filter((a) => a.status === "ABSENT").length,
          late: attendanceHistory.filter((a) => a.status === "LATE").length,
          trial: attendanceHistory.filter((a) => a.status === "TRIAL").length,
        },

        // Coach notes
        coachNotes,

        // Medical profile (detailed)
        medicalProfile,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * GET /api/coach/classes/:classId/players
 * Returns player list for a specific class with medical alert flags.
 */
exports.getClassPlayers = async (req, res) => {
  try {
    const { classId } = req.params;

    const classData = await Class.findById(classId)
      .populate({
        path: "players",
        select: "fullName profileImage dob gender isMedicalCondition medicalConditionDetails parentId rating",
        populate: {
          path: "parentId",
          select: "fullName phone email emergencyContact",
        },
      })
      .populate("coach", "name email")
      .populate("term", "name year");

    if (!classData) {
      return res.status(404).json({ success: false, message: "Class not found" });
    }

    // Add medical alert flag for each player
    const players = classData.players.map((p) => ({
      _id: p._id,
      fullName: p.fullName,
      profileImage: p.profileImage,
      dob: p.dob,
      gender: p.gender,
      rating: p.rating,
      hasMedicalAlert: p.isMedicalCondition || false,
      medicalConditionDetails: p.medicalConditionDetails || "",
      parent: p.parentId
        ? {
          _id: p.parentId._id,
          fullName: p.parentId.fullName,
          phone: p.parentId.phone,
          email: p.parentId.email,
          emergencyContact: p.parentId.emergencyContact,
        }
        : null,
    }));

    res.json({
      success: true,
      data: {
        classId: classData._id,
        className: classData.name,
        coach: classData.coach,
        term: classData.term,
        totalPlayers: players.length,
        players,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * GET /api/coach/unique-players
 * GET /api/coach/unique-players/:coachId
 * Returns the count and list of unique players across all classes assigned to a coach.
 */
exports.getUniquePlayersByCoach = async (req, res) => {
  try {
    const coachId = req.params.coachId || req.query.coachId || req.admin?._id;
    let { page = 1, limit = 10, search = "" } = req.query;

    page = Number(page);
    limit = Number(limit);

    if (!coachId) {
      return res.status(400).json({
        success: false,
        message: "coachId is required",
      });
    }

    // Find all active classes assigned to this coach (either main or assistant coach)
    const coachClasses = await Class.find({
      $or: [{ coach: coachId }, { assistantCoach: coachId }],
      status: "ACTIVE",
    }).select("players");

    // Extract unique player ObjectIds
    const playerIdsSet = new Set();
    coachClasses.forEach((cls) => {
      (cls.players || []).forEach((pId) => {
        if (pId) playerIdsSet.add(pId.toString());
      });
    });

    const playerIds = Array.from(playerIdsSet);

    // Build query matching unique players for this coach
    const query = {
      _id: { $in: playerIds },
    };

    if (search) {
      const searchCriteria = [
        { fullName: { $regex: search, $options: "i" } },
        { firstName: { $regex: search, $options: "i" } },
        { lastName: { $regex: search, $options: "i" } },
      ];
      query.$or = searchCriteria;
    }

    const total = await User.countDocuments(query);

    const users = await User.find(query)
      .populate("parentId", "fullName email phone address city state postcode country emergencyContact relationship")
      .populate("category", "name")
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
    res.status(500).json({ success: false, message: err.message });
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