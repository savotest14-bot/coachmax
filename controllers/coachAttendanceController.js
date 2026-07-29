const Attendance = require("../models/Attendance");
const AttendanceHistory = require("../models/AttendanceHistory");
const AuditLog = require("../models/AuditLog");
const Class = require("../models/Class");
const { sendNotification } = require("../services/notificationService");
const Admin = require("../models/Admin");

// ═══════════════════════════════════════════════
// FEATURE 2 — Attendance with History Tracking
// ═══════════════════════════════════════════════

/**
 * POST /api/coach/attendance/:classId
 * Mark attendance for an entire session.
 * Stores history for every change.
 */
exports.markAttendance = async (req, res) => {
  try {
    const { classId } = req.params;
    const { sessionDate, records } = req.body;
    const coachId = req.admin._id;

    if (!sessionDate || !records || !Array.isArray(records) || records.length === 0) {
      return res.status(400).json({
        success: false,
        message: "sessionDate and records array are required",
      });
    }

    // Normalize date
    const date = new Date(sessionDate);
    date.setUTCHours(0, 0, 0, 0);

    // Find existing attendance
    let attendance = await Attendance.findOne({
      class: classId,
      sessionDate: date,
    });

    const isUpdate = !!attendance;

    if (attendance) {
      // Track history for every changed record
      for (const newRecord of records) {
        const existingRecord = attendance.records.find(
          (r) => r.player.toString() === newRecord.player
        );

        const previousStatus = existingRecord ? existingRecord.status : "NONE";
        const previousComment = existingRecord ? (existingRecord.comment || "") : "";
        const newStatus = newRecord.status || "ABSENT";
        const newComment = newRecord.comment || "";

        // Only log if something changed
        if (previousStatus !== newStatus || previousComment !== newComment) {
          await AttendanceHistory.create({
            attendanceId: attendance._id,
            classId,
            sessionDate: date,
            playerId: newRecord.player,
            previousStatus,
            newStatus,
            previousComment,
            newComment,
            modifiedBy: coachId,
            modificationReason: newRecord.reason || "",
          });
        }
      }

      // Update existing records
      attendance.records = records.map((r) => ({
        player: r.player,
        status: r.status || "ABSENT",
        comment: r.comment || "",
        remarks: r.remarks || "",
        reason: r.reason || "",
        attendanceType: r.attendanceType || "REGULAR",
        markedByParent: false,
        lateArrival: r.status === "LATE",
      }));

      attendance.markedBy = coachId;
      await attendance.save();

      // Audit log
      await AuditLog.create({
        user: coachId,
        userRole: req.admin.role,
        action: "ATTENDANCE_UPDATED",
        entityType: "Attendance",
        entityId: attendance._id,
        ipAddress: req.ip || "",
        deviceInfo: req.headers["user-agent"] || "",
        description: `Attendance updated for class ${classId} on ${date.toISOString().split("T")[0]}`,
      });

      return res.json({
        success: true,
        message: "Attendance updated successfully",
        data: attendance,
      });
    }

    // Create new attendance
    attendance = await Attendance.create({
      class: classId,
      sessionDate: date,
      records: records.map((r) => ({
        player: r.player,
        status: r.status || "ABSENT",
        comment: r.comment || "",
        remarks: r.remarks || "",
        reason: r.reason || "",
        attendanceType: r.attendanceType || "REGULAR",
        markedByParent: false,
        lateArrival: r.status === "LATE",
      })),
      markedBy: coachId,
    });

    // Create initial history entries
    for (const record of records) {
      await AttendanceHistory.create({
        attendanceId: attendance._id,
        classId,
        sessionDate: date,
        playerId: record.player,
        previousStatus: "NONE",
        newStatus: record.status || "ABSENT",
        previousComment: "",
        newComment: record.comment || "",
        modifiedBy: coachId,
      });
    }

    // Audit log
    await AuditLog.create({
      user: coachId,
      userRole: req.admin.role,
      action: "ATTENDANCE_CREATED",
      entityType: "Attendance",
      entityId: attendance._id,
      ipAddress: req.ip || "",
      deviceInfo: req.headers["user-agent"] || "",
      description: `Attendance marked for class ${classId} on ${date.toISOString().split("T")[0]}`,
    });

    // Notify Super Admin
    const superAdmins = await Admin.find({ role: "SUPER_ADMIN" }).select("_id");
    for (const sa of superAdmins) {
      await sendNotification({
        recipientType: "ADMIN",
        adminId: sa._id,
        title: "Attendance Submitted",
        message: `Coach ${req.admin.name} has submitted attendance for ${date.toISOString().split("T")[0]}`,
        type: "ATTENDANCE_SUBMITTED",
        data: { classId, sessionDate: date.toISOString(), coachId: coachId.toString() },
      });
    }

    res.status(201).json({
      success: true,
      message: "Attendance marked successfully",
      data: attendance,
    });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(400).json({
        success: false,
        message: "Attendance already exists for this session",
      });
    }
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * POST /api/coach/attendance/:classId/single
 * Mark or update attendance for a single player.
 */
exports.markSingleAttendance = async (req, res) => {
  try {
    const { classId } = req.params;
    const { sessionDate, playerId, status, comment } = req.body;
    const coachId = req.admin._id;

    if (!sessionDate || !playerId || !status) {
      return res.status(400).json({
        success: false,
        message: "sessionDate, playerId, and status are required",
      });
    }

    const validStatuses = ["PRESENT", "ABSENT", "LATE", "TRIAL"];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        message: `Invalid status. Must be one of: ${validStatuses.join(", ")}`,
      });
    }

    // Normalize date
    const date = new Date(sessionDate);
    date.setUTCHours(0, 0, 0, 0);

    let attendance = await Attendance.findOne({
      class: classId,
      sessionDate: date,
    });

    if (!attendance) {
      attendance = await Attendance.create({
        class: classId,
        sessionDate: date,
        records: [],
        markedBy: coachId,
      });
    }

    // Find existing record for this player
    const existingRecord = attendance.records.find(
      (r) => r.player.toString() === playerId
    );

    const previousStatus = existingRecord ? existingRecord.status : "NONE";
    const previousComment = existingRecord ? (existingRecord.comment || "") : "";

    // Track history
    if (previousStatus !== status || previousComment !== (comment || "")) {
      await AttendanceHistory.create({
        attendanceId: attendance._id,
        classId,
        sessionDate: date,
        playerId,
        previousStatus,
        newStatus: status,
        previousComment,
        newComment: comment || "",
        modifiedBy: coachId,
      });
    }

    if (existingRecord) {
      existingRecord.status = status;
      existingRecord.comment = comment || "";
      existingRecord.lateArrival = status === "LATE";
    } else {
      attendance.records.push({
        player: playerId,
        status,
        comment: comment || "",
        lateArrival: status === "LATE",
      });
    }

    attendance.markedBy = coachId;
    await attendance.save();

    // Audit log
    await AuditLog.create({
      user: coachId,
      userRole: req.admin.role,
      action: "ATTENDANCE_UPDATED",
      entityType: "Attendance",
      entityId: attendance._id,
      ipAddress: req.ip || "",
      deviceInfo: req.headers["user-agent"] || "",
      oldValue: { status: previousStatus, comment: previousComment },
      newValue: { status, comment: comment || "" },
      description: `Single attendance updated for player ${playerId}`,
    });

    res.json({
      success: true,
      message: "Attendance updated successfully",
      data: { classId, sessionDate: date, playerId, status, comment: comment || "" },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * GET /api/coach/attendance/:classId
 * Get attendance records for a class (all sessions).
 */
exports.getAttendanceByClass = async (req, res) => {
  try {
    const { classId } = req.params;
    let { page = 1, limit = 50 } = req.query;

    page = Number(page);
    limit = Number(limit);

    const total = await Attendance.countDocuments({ class: classId });

    const data = await Attendance.find({ class: classId })
      .select("sessionDate records markedBy createdAt updatedAt")
      .populate({
        path: "records.player",
        select: "fullName profileImage isMedicalCondition",
      })
      .populate("markedBy", "name")
      .sort({ sessionDate: -1 })
      .skip((page - 1) * limit)
      .limit(limit);

    res.json({
      success: true,
      totalSessions: total,
      page,
      limit,
      data,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * GET /api/coach/attendance/:classId/date
 * Get attendance for a specific date.
 */
exports.getAttendanceByDate = async (req, res) => {
  try {
    const { classId } = req.params;
    const { date } = req.query;

    if (!date) {
      return res.status(400).json({ success: false, message: "date query parameter is required" });
    }

    const sessionDate = new Date(date);
    sessionDate.setUTCHours(0, 0, 0, 0);

    const attendance = await Attendance.findOne({
      class: classId,
      sessionDate,
    }).populate({
      path: "records.player",
      select: "fullName profileImage email phone isMedicalCondition medicalConditionDetails",
    }).populate("markedBy", "name");

    if (!attendance) {
      return res.json({
        success: true,
        data: null,
        message: "No attendance record found for this date",
      });
    }

    res.json({
      success: true,
      data: attendance,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * GET /api/admin/attendance-history/:classId
 * Super Admin only — View attendance modification history.
 */
exports.getAttendanceHistory = async (req, res) => {
  try {
    const { classId } = req.params;
    let { page = 1, limit = 50, playerId, sessionDate } = req.query;

    page = Number(page);
    limit = Number(limit);

    const query = { classId };

    if (playerId) query.playerId = playerId;
    if (sessionDate) {
      const date = new Date(sessionDate);
      date.setUTCHours(0, 0, 0, 0);
      query.sessionDate = date;
    }

    const total = await AttendanceHistory.countDocuments(query);

    const history = await AttendanceHistory.find(query)
      .populate("playerId", "fullName")
      .populate("modifiedBy", "name role")
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit);

    res.json({
      success: true,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      data: history,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
