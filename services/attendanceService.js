const mongoose = require("mongoose");
const Attendance = require("../models/Attendance");
const AttendanceHistory = require("../models/AttendanceHistory");
const Class = require("../models/Class");
const Team = require("../models/Team");
const User = require("../models/User");
const AuditLog = require("../models/AuditLog");
const { dateOnlyStartUtc, dateOnlyEndUtc, dateOnly } = require("../utils/dateTime");
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const sid = (value) => String(value?._id || value || "");
function normalizeRecord(input, previous = {}) {
  let status = input.status ?? previous.status ?? "NOT_MARKED";
  const attendanceType = status === "TRIAL" ? "TRIAL" : input.attendanceType ?? previous.attendanceType ?? "REGULAR";
  if (status === "TRIAL") status = "PRESENT";
  if (!["PRESENT", "ABSENT", "LATE", "NOT_MARKED"].includes(status)) fail("Invalid attendance status");
  if (!["REGULAR", "MAKEUP", "TRIAL"].includes(attendanceType)) fail("Invalid attendance type");
  const incomingNote = input.note ?? input.reason ?? input.remarks ?? input.comment;
  if (incomingNote !== undefined && typeof incomingNote !== "string") fail("Attendance note must be text");
  const note = incomingNote === undefined ? (previous.note || previous.reason || previous.remarks || previous.comment || "") : String(incomingNote).trim();
  if (note.length > 2000) fail("Notes must be 2000 characters or fewer");
  const changesStatus = input.status !== undefined && status !== previous.status;
  const parentAbsenceReason = previous.parentAbsenceReason || (previous.markedByParent ? previous.reason || previous.remarks || "" : "");
  return { status, attendanceType, note, reason: note, remarks: note, comment: note, lateArrival: status === "LATE", markedByParent: changesStatus ? false : previous.markedByParent === true, parentAbsenceReason };
}
async function updateAttendance(req, kind, records) {
  if (!req.admin || !["COACH", "ADMIN", "SUPER_ADMIN"].includes(req.admin.role) || req.admin.isActive === false) fail("Active staff access required", 403);
  const resourceId = req.params[`${kind}Id`];
  if (!mongoose.isValidObjectId(resourceId)) fail(`Invalid ${kind} ID`);
  if (!Array.isArray(records) || records.length < 1 || records.length > 500) fail("Supply between 1 and 500 attendance records");
  const ids = records.map((item) => sid(item.player || item.playerId));
  if (ids.some((value) => !mongoose.isValidObjectId(value)) || new Set(ids).size !== ids.length) fail("Each record must have a different valid player ID");
  const date = dateOnlyStartUtc(req.body.sessionDate, "sessionDate");
  if (!date) fail("sessionDate is required");
  const leagueId = req.body.leagueId || null;
  if (leagueId && !mongoose.isValidObjectId(leagueId)) fail("Invalid league ID");
  const session = await mongoose.startSession();
  let result;
  try {
    await session.withTransaction(async () => {
      const resource = await (kind === "class" ? Class : Team).findById(resourceId).populate("term").session(session);
      if (!resource) fail(`${kind} not found`, 404);
      if (req.admin.role === "COACH" && ![resource.coach, resource.assistantCoach].some((value) => sid(value) === sid(req.admin._id))) fail("You are not assigned to this resource", 403);
      if (resource.isArchived || resource.status === "INACTIVE") fail("This resource is not active", 409);
      const dateKey = dateOnly(date);
      if (resource.term?.startDate && (dateKey < dateOnly(resource.term.startDate) || dateKey > dateOnly(resource.term.endDate))) fail("Session date is outside the selected term");
      let roster = (resource.players || []).map((value) => sid(kind === "team" ? value.player || value : value));
      if (kind === "team" && leagueId) {
        const enrollment = (resource.leagues || []).find((item) => sid(item.league) === sid(leagueId));
        if (!enrollment || enrollment.status === "WITHDRAWN") fail("Team is not enrolled in the selected league", 409);
        if (enrollment.players?.length) roster = enrollment.players.filter((item) => item.status !== "INACTIVE").map((item) => sid(item.player));
      }
      const trials = kind === "class" ? await User.find({ _id: { $in: ids }, temporaryClass: resourceId, temporarySessionDate: { $gte: date, $lte: dateOnlyEndUtc(dateKey) }, playerStatus: "PENDING_APPROVAL" }).select("_id").session(session) : [];
      const allowed = new Set([...roster, ...trials.map((item) => sid(item._id))]);
      if (ids.some((value) => !allowed.has(value))) fail("A player is not enrolled in this resource", 403);
      const filter = { [kind]: resourceId, ...(kind === "team" ? { league: leagueId } : {}), sessionDate: { $gte: date, $lte: dateOnlyEndUtc(dateKey) } };
      let attendance = await Attendance.findOne(filter).session(session);
      if (!attendance) [attendance] = await Attendance.create([{ [kind]: resourceId, ...(kind === "team" ? { league: leagueId } : {}), sessionDate: date, records: [], markedBy: req.admin._id }], { session });
      for (let i = 0; i < records.length; i++) {
        const previous = attendance.records.find((item) => sid(item.player) === ids[i]);
        const normalized = normalizeRecord(records[i], previous);
        const oldNote = previous?.note || previous?.reason || previous?.remarks || previous?.comment || "";
        if (!previous || normalized.status !== previous.status || normalized.note !== oldNote || normalized.attendanceType !== previous.attendanceType) {
          await AttendanceHistory.create([{ attendanceId: attendance._id, [`${kind}Id`]: resourceId, leagueId, sessionDate: date, playerId: ids[i], previousStatus: previous?.status || "NONE", newStatus: normalized.status, previousComment: oldNote, newComment: normalized.note, previousNote: oldNote, newNote: normalized.note, modifiedBy: req.admin._id, modificationReason: "Attendance or note updated" }], { session });
        }
        const patch = { ...normalized, ...(!previous || normalized.note !== oldNote ? { noteAuthor: req.admin._id, noteUpdatedAt: new Date() } : {}) };
        if (previous) Object.assign(previous, patch);
        else attendance.records.push({ player: ids[i], ...patch });
      }
      attendance.markedBy = req.admin._id;
      await attendance.save({ session });
      await AuditLog.create([{ user: req.admin._id, userRole: req.admin.role, action: "ATTENDANCE_UPDATED", entityType: "Attendance", entityId: attendance._id, description: `Attendance and notes updated on ${dateKey}`, ipAddress: req.ip || "", deviceInfo: req.headers?.["user-agent"] || "" }], { session });
      result = attendance;
    });
    return result;
  } finally { await session.endSession(); }
}
const handler = (kind, bulk) => async (req, res, next) => {
  try {
    const records = bulk ? req.body.records : [{ ...req.body, player: req.body.playerId }];
    const attendance = await updateAttendance(req, kind, records);
    const record = bulk ? null : attendance.records.find((item) => sid(item.player) === sid(req.body.playerId));
    return res.json({ success: true, message: "Attendance and notes saved", data: bulk ? attendance : { ...record.toObject(), playerId: record.player, [`${kind}Id`]: req.params[`${kind}Id`], sessionDate: dateOnly(attendance.sessionDate), attendanceId: attendance._id } });
  } catch (error) {
    if (error.status || error.statusCode || error instanceof TypeError) return res.status(error.status || error.statusCode || 400).json({ success: false, message: error.message });
    return next(error);
  }
};
module.exports = { normalizeRecord, updateAttendance, markAttendance: handler("class", true), markSingleAttendance: handler("class", false), markTeamAttendance: handler("team", true), markSingleTeamAttendance: handler("team", false) };
