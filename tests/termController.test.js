const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const dates = require("../utils/dateTime");
const termDates = require("../utils/termDates");

function loadController(models = {}) {
  const sandbox = {
    exports: {}, console, Date, TypeError, Buffer, URL,
    process: { env: {}, cwd: () => path.resolve(__dirname, "..") },
    __dirname: path.resolve(__dirname, "../controllers"),
    require: (name) => name === "../utils/dateTime" ? dates : name === "../utils/termDates" ? termDates : name === "../utils/classSchedule" ? require("../utils/classSchedule") : name === "path" ? path : name === "mongoose" ? { Types: { ObjectId: { isValid: () => true } } } : models[name] || {},
  };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, "../controllers/adminAuthController.js"), "utf8"), sandbox);
  return sandbox.exports;
}
const response = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });

test("create term rejects impossible dates with 400 and zero writes", async () => {
  let writes = 0;
  const controller = loadController({ "../models/Term": { create: async () => { writes++; } } });
  const res = response();
  await controller.createTerm({ body: { name: "Term 1", year: 2027, startDate: "31/02/2027", endDate: "10/03/2027" } }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(writes, 0);
});

test("term create serializes canonical dates instead of server-local instants", async () => {
  let stored;
  const controller = loadController({ "../models/Term": { create: async (data) => { stored = data; return { ...data, _id: "term" }; } } });
  const res = response();
  await controller.createTerm({ body: { name: "Term 1", year: 2027, startDate: "15/01/2027", endDate: "2027-03-31" } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.startDate, "2027-01-15");
  assert.equal(res.body.data.endDate, "2027-03-31");
  assert.equal(stored.startDate.toISOString(), "2027-01-15T00:00:00.000Z");
});

test("one-sided term updates reject reversed merged dates before mutation", async () => {
  let writes = 0;
  const current = { name: "Term 1", year: 2027, startDate: new Date("2027-01-15T00:00:00Z"), endDate: new Date("2027-03-31T00:00:00Z") };
  const controller = loadController({ "../models/Term": { findById: async () => ({ toObject: () => current }), findByIdAndUpdate: async () => { writes++; } } });
  for (const body of [{ startDate: "01/04/2027" }, { endDate: "14/01/2027" }, { startDate: "" }]) {
    const res = response();
    await controller.updateTerm({ params: { id: "term" }, body }, res);
    assert.equal(res.statusCode, 400);
  }
  assert.equal(writes, 0);
});

test("term deletion checks teams, leagues, and termId event dependencies", async () => {
  for (const dependency of ["Team", "League", "Event"]) {
    let deleted = false;
    let eventQuery;
    const models = { "../models/Term": { findById: async () => ({}), findByIdAndDelete: async () => { deleted = true; } } };
    for (const name of ["Class", "User", "RegistrationRequest", "Team", "League", "Event"]) models[`../models/${name}`] = { countDocuments: async (query) => { if (name === "Event") eventQuery = query; return name === dependency ? 1 : 0; } };
    const res = response();
    await loadController(models).deleteTerm({ params: { id: "term" } }, res);
    assert.equal(res.statusCode, 400, dependency);
    assert.equal(deleted, false, dependency);
    assert.equal(eventQuery.termId, "term");
  }
});

test("View All retains term scope and returns Monday-first multi-day occurrences", async () => {
  let query;
  const classes = [
    { _id: "sun", name: "Sunday class", dayOfWeek: "SUNDAY", startTime: "09:00", term: { _id: "term", startDate: "2026-10-01", endDate: "2026-12-09" } },
    { _id: "multi", name: "Multi day", scheduleType: "CUSTOM", dayOfWeek: "MONDAY", schedule: [{ dayOfWeek: "WEDNESDAY", startTime: "17:00", endTime: "18:00" }, { dayOfWeek: "MONDAY", startTime: "17:00", endTime: "18:00" }], term: { _id: "term", startDate: "2026-10-01", endDate: "2026-12-09" } },
  ];
  const chain = { select() { return this; }, populate() { return this; }, lean: async () => classes };
  const controller = loadController({ "../models/Class": { find: (filter) => { query = filter; return chain; } } });
  const res = response();
  await controller.getClassFiltersWithTimeSlots({ query: { day: "ALL", termId: "term" } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(query.term, "term");
  assert.equal(query.$or, undefined);
  assert.deepEqual(Array.from(res.body.timeSlots, (slot) => slot.dayOfWeek), ["MONDAY", "WEDNESDAY", "SUNDAY"]);
  assert.equal(res.body.totalClasses, 2);
  assert.equal(res.body.totalOccurrences, 3);
  assert.equal(new Set(res.body.timeSlots.map((slot) => slot.occurrenceId)).size, 3);
  const dayRes = response();
  await controller.getClassFiltersWithTimeSlots({ query: { day: "WEDNESDAY", termId: "term" } }, dayRes);
  assert.deepEqual(Array.from(dayRes.body.timeSlots, (slot) => slot.dayOfWeek), ["WEDNESDAY"]);
});

test("schedule day rejects arbitrary regular-expression input before reading data", async () => {
  let reads = 0;
  const controller = loadController({ "../models/Class": { find: () => { reads++; } } });
  const res = response();
  await controller.getClassFiltersWithTimeSlots({ query: { day: ".*", termId: "term" } }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(reads, 0);
});
