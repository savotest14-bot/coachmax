const test = require("node:test");
const assert = require("node:assert/strict");
const { classOccurrences, compareOccurrences, timeMinutes } = require("../utils/classSchedule");
test("multi-day schedules retain day/time occurrences and deduplicate identical rows", () => {
  const slots = classOccurrences({ _id: "class", name: "U8", scheduleType: "CUSTOM", schedule: [
    { dayOfWeek: "Wednesday", startTime: "5:30 PM", endTime: "6:30 PM" },
    { dayOfWeek: "Monday", startTime: "17:30", endTime: "18:30" },
    { dayOfWeek: "Wednesday", startTime: "5:30 PM", endTime: "6:30 PM" },
  ] }).sort(compareOccurrences);
  assert.equal(slots.length, 2);
  assert.deepEqual(slots.map((slot) => slot.dayOfWeek), ["MONDAY", "WEDNESDAY"]);
  assert.notEqual(slots[0].occurrenceId, slots[1].occurrenceId);
  assert.equal(classOccurrences({ _id: "single", dayOfWeek: "TUESDAY", scheduleType: "SINGLE_DAY", schedule: [{ dayOfWeek: "MONDAY" }] })[0].dayOfWeek, "TUESDAY");
});
test("schedule sorting uses numeric time and stable name order", () => {
  const slots = [
    ...classOccurrences({ _id: "b", name: "Beta", dayOfWeek: "Monday", startTime: "5:30 PM" }),
    ...classOccurrences({ _id: "a", name: "Alpha", dayOfWeek: "Monday", startTime: "17:30" }),
    ...classOccurrences({ _id: "c", name: "Early", dayOfWeek: "Monday", startTime: "9:00 AM" }),
  ].sort(compareOccurrences);
  assert.deepEqual(slots.map((slot) => slot.className), ["Early", "Alpha", "Beta"]);
  assert.equal(timeMinutes("12:00 AM"), 0);
  assert.equal(timeMinutes("12:00 PM"), 720);
  assert.equal(timeMinutes("25:60"), 1440);
});
