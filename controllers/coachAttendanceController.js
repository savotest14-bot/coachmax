const Attendance = require("../models/Attendance");
const AttendanceHistory = require("../models/AttendanceHistory");
const AuditLog = require("../models/AuditLog");
const Class = require("../models/Class");
const { sendNotification } = require("../services/notificationService");
const Admin = require("../models/Admin");
const { dateOnlyStartUtc } = require("../utils/dateTime");

exports.markAttendance = require('../services/attendanceService').markAttendance;

exports.markSingleAttendance = require('../services/attendanceService').markSingleAttendance;

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

exports.markTeamAttendance = require('../services/attendanceService').markTeamAttendance;

exports.markSingleTeamAttendance = require('../services/attendanceService').markSingleTeamAttendance;

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
