const { serializeTerm } = require("./dateTime");
const WEEKDAYS = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"];
function weekday(value) {
  const normalized = String(value || "").trim().toUpperCase();
  return WEEKDAYS.includes(normalized) ? normalized : null;
}
function timeMinutes(value) {
  const match = String(value || "").trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i);
  if (!match) return 1440;
  let hours = Number(match[1]);
  const minutes = Number(match[2]);
  const meridiem = match[3]?.toUpperCase();
  if (minutes > 59 || (meridiem ? hours < 1 || hours > 12 : hours > 23)) return 1440;
  if (meridiem === "PM" && hours < 12) hours += 12;
  if (meridiem === "AM" && hours === 12) hours = 0;
  return hours * 60 + minutes;
}
function classOccurrences(classDoc, selectedDay = null) {
  const multiDay = (classDoc.scheduleType && classDoc.scheduleType !== "SINGLE_DAY") || (!classDoc.scheduleType && classDoc.schedule?.length);
  const entries = multiDay && classDoc.schedule?.length ? classDoc.schedule : [classDoc];
  const seen = new Set();
  return entries.flatMap((entry) => {
    const dayOfWeek = weekday(entry.dayOfWeek);
    if (!dayOfWeek || (selectedDay && dayOfWeek !== selectedDay)) return [];
    const startTime = entry.startTime || classDoc.startTime || "";
    const endTime = entry.endTime || classDoc.endTime || "";
    const occurrenceId = `${classDoc._id}:${dayOfWeek}:${timeMinutes(startTime)}:${timeMinutes(endTime)}`;
    if (seen.has(occurrenceId)) return [];
    seen.add(occurrenceId);
    return [{
      occurrenceId,
      classId: classDoc._id,
      className: classDoc.name || "Class",
      dayOfWeek,
      startTime,
      endTime,
      coach: classDoc.coach || null,
      category: classDoc.category || null,
      program: classDoc.program || null,
      term: serializeTerm(classDoc.term),
      playerCount: classDoc.players?.length || 0,
      status: classDoc.status,
    }];
  });
}
function compareOccurrences(a, b) {
  return WEEKDAYS.indexOf(a.dayOfWeek) - WEEKDAYS.indexOf(b.dayOfWeek) ||
    timeMinutes(a.startTime) - timeMinutes(b.startTime) ||
    a.className.localeCompare(b.className) || String(a.classId).localeCompare(String(b.classId));
}
module.exports = { WEEKDAYS, weekday, timeMinutes, classOccurrences, compareOccurrences };
