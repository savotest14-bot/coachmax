const { dateOnly, dateOnlyStartUtc, dateOnlyEndUtc, calendarTimestampRange } = require("../utils/dateTime");
async function assertTermHistoryFits(termId, previous, next) {
  if (dateOnly(previous.startDate) === dateOnly(next.startDate) && dateOnly(previous.endDate) === dateOnly(next.endDate)) return;
  const Class = require("../models/Class"), Team = require("../models/Team"), League = require("../models/League");
  const [classes, teams, leagues] = await Promise.all([Class.distinct("_id", { term: termId }), Team.distinct("_id", { term: termId }), League.distinct("_id", { term: termId })]);
  const start = dateOnlyStartUtc(next.startDate), end = dateOnlyEndUtc(next.endDate);
  const attendance = await require("../models/Attendance").exists({ $and: [{ $or: [{ class: { $in: classes } }, { team: { $in: teams } }] }, { $or: [{ sessionDate: { $lt: start } }, { sessionDate: { $gt: end } }] }] });
  const range = calendarTimestampRange(next.startDate, next.endDate);
  const fixture = await require("../models/Fixture").exists({ league: { $in: leagues }, $or: [{ kickoffTime: { $lt: range.$gte } }, { kickoffTime: { $gte: range.$lt } }] });
  if (attendance || fixture) throw Object.assign(new Error("Term dates cannot exclude recorded attendance or scheduled fixtures. Preserve the historical dates and review the affected sessions first."), { status: 409 });
}
module.exports = { assertTermHistoryFits };
