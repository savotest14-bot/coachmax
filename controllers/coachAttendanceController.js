const Attendance = require("../models/Attendance");
const AttendanceHistory = require("../models/AttendanceHistory");
const AuditLog = require("../models/AuditLog");
const Class = require("../models/Class");
const { sendNotification } = require("../services/notificationService");
const Admin = require("../models/Admin");
const { dateOnlyStartUtc } = require("../utils/dateTime");

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

    const date = dateOnlyStartUtc(sessionDate, "sessionDate");

    let attendance = await Attendance.findOne({
      class: classId,
      sessionDate: date,
    });

    const isUpdate = !!attendance;

    if (attendance) {
      for (const newRecord of records) {
        const existingRecord = attendance.records.find(
          (r) => r.player.toString() === newRecord.player
        );

        const previousStatus = existingRecord ? existingRecord.status : "NONE";
        const previousComment = existingRecord ? (existingRecord.comment || "") : "";
        const newStatus = newRecord.status || "ABSENT";
        const newComment = newRecord.comment || "";

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

exports.markSingleAttendance = async (req, res) => {
  try {
    const { classId } = req.params;
    const { sessionDate, playerId, status, comment, reason, remarks } = req.body;
    const coachId = req.admin._id;
    const trimmedReason = reason !== undefined ? String(reason).trim() : (remarks !== undefined ? String(remarks).trim() : undefined);

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

    const date = dateOnlyStartUtc(sessionDate, "sessionDate");

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

    const existingRecord = attendance.records.find(
      (r) => r.player.toString() === playerId
    );

    const previousStatus = existingRecord ? existingRecord.status : "NONE";
    const previousComment = existingRecord ? (existingRecord.comment || "") : "";

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
      if (trimmedReason !== undefined) {
        existingRecord.reason = trimmedReason;
        existingRecord.remarks = trimmedReason;
      }
      existingRecord.lateArrival = status === "LATE";
    } else {
      attendance.records.push({
        player: playerId,
        status,
        comment: comment || "",
        reason: trimmedReason || "",
        remarks: trimmedReason || "",
        lateArrival: status === "LATE",
      });
    }

    attendance.markedBy = coachId;
    await attendance.save();

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

exports.getAttendanceByDate = async (req, res) => {
  try {
    const { classId } = req.params;
    const { date } = req.query;

    if (!date) {
      return res.status(400).json({ success: false, message: "date query parameter is required" });
    }

    const sessionDate = dateOnlyStartUtc(date, "date");

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

exports.getAttendanceHistory = async (req, res) => {
  try {
    const { classId } = req.params;
    let { page = 1, limit = 50, playerId, sessionDate } = req.query;

    page = Number(page);
    limit = Number(limit);

    const query = { classId };

    if (playerId) query.playerId = playerId;
    if (sessionDate) {
      const date = dateOnlyStartUtc(sessionDate, "sessionDate");
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

exports.markTeamAttendance = async (req, res) => {
  try {
    const { teamId } = req.params;
    const { sessionDate, records, leagueId } = req.body;
    const coachId = req.admin ? req.admin._id : null;

    if (!sessionDate || !records || !Array.isArray(records) || records.length === 0) {
      return res.status(400).json({
        success: false,
        message: "sessionDate and records array are required",
      });
    }

    const date = dateOnlyStartUtc(sessionDate, "sessionDate");

    const filter = { team: teamId, sessionDate: date };
    if (leagueId) filter.league = leagueId;

    let attendance = await Attendance.findOne(filter);
    if (!attendance && leagueId) {
      attendance = await Attendance.findOne({ team: teamId, sessionDate: date, league: null });
      if (attendance) attendance.league = leagueId;
    }

    const notMarkedPlayerIds = records
      .filter((r) => r.status === "NOT_MARKED")
      .map((r) => r.player.toString());

    const activeRecords = records.filter(
      (r) => r.status && r.status !== "NOT_MARKED"
    );

    if (attendance) {
      if (leagueId && !attendance.league) {
        attendance.league = leagueId;
      }

      if (notMarkedPlayerIds.length > 0) {
        await AttendanceHistory.deleteMany({
          $or: [
            { attendanceId: attendance._id, playerId: { $in: notMarkedPlayerIds } },
            { teamId, sessionDate: date, playerId: { $in: notMarkedPlayerIds }, ...(leagueId ? { leagueId } : {}) },
          ],
        });
      }

      for (const newRecord of activeRecords) {
        const existingRecord = attendance.records.find(
          (r) => r.player.toString() === newRecord.player.toString()
        );

        const previousStatus = existingRecord ? existingRecord.status : "NONE";
        const previousComment = existingRecord ? (existingRecord.comment || "") : "";
        const newStatus = newRecord.status || "ABSENT";
        const newComment = newRecord.comment || "";

        if (previousStatus !== newStatus || previousComment !== newComment) {
          await AttendanceHistory.create({
            attendanceId: attendance._id,
            teamId,
            leagueId: leagueId || attendance.league || null,
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

      attendance.records = activeRecords.map((r) => ({
        player: r.player,
        status: r.status || "ABSENT",
        comment: r.comment || "",
        remarks: r.remarks || "",
        reason: r.reason || "",
        attendanceType: r.attendanceType || "REGULAR",
        markedByParent: false,
        lateArrival: r.status === "LATE",
      }));

      if (attendance.records.length === 0) {
        await Attendance.deleteOne({ _id: attendance._id });
        await AttendanceHistory.deleteMany({ attendanceId: attendance._id });

        return res.json({
          success: true,
          message: "Team attendance deleted as all records are NOT_MARKED",
          data: null,
        });
      }

      attendance.markedBy = coachId;
      await attendance.save();

      if (coachId) {
        await AuditLog.create({
          user: coachId,
          userRole: req.admin ? req.admin.role : "COACH",
          action: "ATTENDANCE_UPDATED",
          entityType: "Attendance",
          entityId: attendance._id,
          ipAddress: req.ip || "",
          deviceInfo: req.headers ? (req.headers["user-agent"] || "") : "",
          description: `Team attendance updated for team ${teamId} on ${date.toISOString().split("T")[0]}`,
        });
      }

      return res.json({
        success: true,
        message: "Team attendance updated successfully",
        data: attendance,
      });
    }

    if (activeRecords.length === 0) {
      return res.json({
        success: true,
        message: "No attendance records to create (all NOT_MARKED)",
        data: null,
      });
    }

    try {
      attendance = await Attendance.create({
        team: teamId,
        league: leagueId || null,
        sessionDate: date,
        records: activeRecords.map((r) => ({
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
    } catch (createErr) {
      if (createErr.code === 11000) {
        attendance = (await Attendance.findOne(filter)) || (await Attendance.findOne({ team: teamId, sessionDate: date }));
        if (attendance) {
          if (leagueId && !attendance.league) attendance.league = leagueId;
          attendance.records = activeRecords.map((r) => ({
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
          return res.json({
            success: true,
            message: "Team attendance updated successfully",
            data: attendance,
          });
        }
      }
      throw createErr;
    }

    for (const record of activeRecords) {
      await AttendanceHistory.create({
        attendanceId: attendance._id,
        teamId,
        leagueId: leagueId || null,
        sessionDate: date,
        playerId: record.player,
        previousStatus: "NONE",
        newStatus: record.status || "ABSENT",
        previousComment: "",
        newComment: record.comment || "",
        modifiedBy: coachId,
      });
    }

    if (coachId) {
      await AuditLog.create({
        user: coachId,
        userRole: req.admin ? req.admin.role : "COACH",
        action: "ATTENDANCE_CREATED",
        entityType: "Attendance",
        entityId: attendance._id,
        ipAddress: req.ip || "",
        deviceInfo: req.headers ? (req.headers["user-agent"] || "") : "",
        description: `Team attendance marked for team ${teamId} on ${date.toISOString().split("T")[0]}`,
      });
    }

    res.status(201).json({
      success: true,
      message: "Team attendance marked successfully",
      data: attendance,
    });
  } catch (err) {
    if (err.code === 11000) {
      try {
        const date = dateOnlyStartUtc(req.body.sessionDate, "sessionDate");
        const { leagueId, records = [] } = req.body;
        const filter = { team: req.params.teamId, sessionDate: date };
        if (leagueId) filter.league = leagueId;

        const existing = (await Attendance.findOne(filter)) || (await Attendance.findOne({ team: req.params.teamId, sessionDate: date }));
        if (existing) {
          if (leagueId && !existing.league) existing.league = leagueId;
          const activeRecords = records.filter((r) => r.status && r.status !== "NOT_MARKED");
          existing.records = activeRecords.map((r) => ({
            player: r.player,
            status: r.status || "ABSENT",
            comment: r.comment || "",
            remarks: r.remarks || "",
            reason: r.reason || "",
            attendanceType: r.attendanceType || "REGULAR",
            markedByParent: false,
            lateArrival: r.status === "LATE",
          }));
          existing.markedBy = req.admin ? req.admin._id : null;
          await existing.save();

          return res.json({
            success: true,
            message: "Team attendance updated successfully",
            data: existing,
          });
        }
      } catch (retryErr) {
        return res.status(500).json({ success: false, message: retryErr.message });
      }
    }
    res.status(500).json({ success: false, message: err.message });
  }
};

exports.markSingleTeamAttendance = async (req, res) => {
  try {
    const { teamId } = req.params;
    const { sessionDate, playerId, status, comment, reason, remarks, leagueId } = req.body;
    const coachId = req.admin ? req.admin._id : null;
    const trimmedReason = reason !== undefined ? String(reason).trim() : (remarks !== undefined ? String(remarks).trim() : undefined);

    if (!sessionDate || !playerId || !status) {
      return res.status(400).json({
        success: false,
        message: "sessionDate, playerId, and status are required",
      });
    }

    const validStatuses = ["PRESENT", "ABSENT", "LATE", "TRIAL", "NOT_MARKED"];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        message: `Invalid status. Must be one of: ${validStatuses.join(", ")}`,
      });
    }

    const date = dateOnlyStartUtc(sessionDate, "sessionDate");

    const filter = { team: teamId, sessionDate: date };
    if (leagueId) filter.league = leagueId;

    let attendance = await Attendance.findOne(filter);
    if (!attendance && leagueId) {
      attendance = await Attendance.findOne({ team: teamId, sessionDate: date, league: null });
      if (attendance) attendance.league = leagueId;
    }

    // If status is NOT_MARKED
    if (status === "NOT_MARKED") {
      if (!attendance) {
        return res.json({
          success: true,
          message: "Attendance marked as NOT_MARKED (no record existed)",
          data: { teamId, sessionDate: date, playerId, status: "NOT_MARKED", leagueId: leagueId || null },
        });
      }

      // Remove the player's record from attendance.records
      attendance.records = (attendance.records || []).filter(
        (r) => r.player.toString() !== playerId.toString()
      );

      // Delete attendance history records for this player in this session
      await AttendanceHistory.deleteMany({
        $or: [
          { attendanceId: attendance._id, playerId },
          { teamId, sessionDate: date, playerId, ...(leagueId ? { leagueId } : {}) },
        ],
      });

      // If no records remain, delete the entire attendance document and any remaining history
      if (attendance.records.length === 0) {
        await Attendance.deleteOne({ _id: attendance._id });
        await AttendanceHistory.deleteMany({ attendanceId: attendance._id });

        return res.json({
          success: true,
          message: "Attendance record removed and document deleted as no records remain",
          data: { teamId, sessionDate: date, playerId, status: "NOT_MARKED", leagueId: attendance.league, deleted: true },
        });
      }

      // If other records remain, save the document
      attendance.markedBy = coachId;
      await attendance.save();

      return res.json({
        success: true,
        message: "Player attendance unmarked successfully",
        data: { teamId, sessionDate: date, playerId, status: "NOT_MARKED", leagueId: attendance.league },
      });
    }

    // Normal statuses: PRESENT, ABSENT, LATE, TRIAL
    if (!attendance) {
      try {
        attendance = await Attendance.create({
          team: teamId,
          league: leagueId || null,
          sessionDate: date,
          records: [],
          markedBy: coachId,
        });
      } catch (createErr) {
        if (createErr.code === 11000) {
          attendance = (await Attendance.findOne(filter)) || (await Attendance.findOne({ team: teamId, sessionDate: date }));
          if (attendance && leagueId && !attendance.league) {
            attendance.league = leagueId;
          }
        } else {
          throw createErr;
        }
      }
    } else if (leagueId && !attendance.league) {
      attendance.league = leagueId;
    }

    const existingRecord = attendance.records.find(
      (r) => r.player.toString() === playerId
    );

    const previousStatus = existingRecord ? existingRecord.status : "NONE";
    const previousComment = existingRecord ? (existingRecord.comment || "") : "";

    if (previousStatus !== status || previousComment !== (comment || "")) {
      await AttendanceHistory.create({
        attendanceId: attendance._id,
        teamId,
        leagueId: leagueId || attendance.league || null,
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
      if (trimmedReason !== undefined) {
        existingRecord.reason = trimmedReason;
        existingRecord.remarks = trimmedReason;
      }
      existingRecord.lateArrival = status === "LATE";
    } else {
      attendance.records.push({
        player: playerId,
        status,
        comment: comment || "",
        reason: trimmedReason || "",
        remarks: trimmedReason || "",
        lateArrival: status === "LATE",
      });
    }

    attendance.markedBy = coachId;
    await attendance.save();

    res.json({
      success: true,
      message: "Team attendance updated successfully",
      data: { teamId, sessionDate: date, playerId, status, comment: comment || "", leagueId: attendance.league },
    });
  } catch (err) {
    if (err.code === 11000) {
      try {
        const date = dateOnlyStartUtc(req.body.sessionDate, "sessionDate");
        const { leagueId, playerId, status, comment } = req.body;
        const filter = { team: req.params.teamId, sessionDate: date };
        if (leagueId) filter.league = leagueId;

        const existing = (await Attendance.findOne(filter)) || (await Attendance.findOne({ team: req.params.teamId, sessionDate: date }));
        if (existing) {
          if (leagueId && !existing.league) existing.league = leagueId;
          const rec = existing.records.find((r) => r.player.toString() === playerId.toString());
          if (rec) {
            rec.status = status;
            rec.comment = comment || "";
            if (trimmedReason !== undefined) {
              rec.reason = trimmedReason;
              rec.remarks = trimmedReason;
            }
            rec.lateArrival = status === "LATE";
          } else {
            existing.records.push({
              player: playerId,
              status,
              comment: comment || "",
              reason: trimmedReason || "",
              remarks: trimmedReason || "",
              lateArrival: status === "LATE",
            });
          }
          existing.markedBy = req.admin ? req.admin._id : null;
          await existing.save();

          return res.json({
            success: true,
            message: "Team attendance updated successfully",
            data: { teamId: req.params.teamId, sessionDate: date, playerId, status, comment: comment || "", leagueId: existing.league },
          });
        }
      } catch (retryErr) {
        return res.status(500).json({ success: false, message: retryErr.message });
      }
    }
    res.status(500).json({ success: false, message: err.message });
  }
};

exports.getAttendanceByTeam = async (req, res) => {
  try {
    const { teamId } = req.params;
    let { page = 1, limit = 50, leagueId } = req.query;

    page = Number(page);
    limit = Number(limit);

    const filter = { team: teamId };
    if (leagueId) filter.league = leagueId;

    const total = await Attendance.countDocuments(filter);

    const data = await Attendance.find(filter)
      .select("sessionDate records markedBy league createdAt updatedAt")
      .populate({
        path: "records.player",
        select: "fullName profileImage isMedicalCondition",
      })
      .populate("markedBy", "name")
      .populate("league", "name season")
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

exports.getAttendanceByTeamDate = async (req, res) => {
  try {
    const { teamId } = req.params;
    const { date, leagueId } = req.query;

    if (!date) {
      return res.status(400).json({ success: false, message: "date query parameter is required" });
    }

    const sessionDate = dateOnlyStartUtc(date, "date");

    const query = {
      team: teamId,
      sessionDate,
    };
    if (leagueId) query.league = leagueId;

    const attendance = await Attendance.findOne(query).populate({
      path: "records.player",
      select: "fullName profileImage email phone isMedicalCondition medicalConditionDetails",
    }).populate("markedBy", "name")
      .populate("league", "name season");

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

exports.getTeamAttendanceHistory = async (req, res) => {
  try {
    const { teamId } = req.params;
    let { page = 1, limit = 50, playerId, sessionDate, leagueId } = req.query;

    page = Number(page);
    limit = Number(limit);

    const query = { teamId };

    if (playerId) query.playerId = playerId;
    if (leagueId) query.leagueId = leagueId;
    if (sessionDate) {
      const date = dateOnlyStartUtc(sessionDate, "sessionDate");
      query.sessionDate = date;
    }

    const total = await AttendanceHistory.countDocuments(query);

    const history = await AttendanceHistory.find(query)
      .populate("playerId", "fullName")
      .populate("modifiedBy", "name role")
      .populate("leagueId", "name season")
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
