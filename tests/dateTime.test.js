const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const dates = require("../utils/dateTime");
const { validatedTermData } = require("../utils/termDates");

test("calendar dates validate leap years and reject impossible or ambiguous input", () => {
  assert.equal(dates.dateOnly("29/02/2024"), "2024-02-29");
  for (const invalid of ["31/02/2026", "2026-02-29", "2026-13-01", "2026-01-00", "10/26/2026", "October 26, 2026", "2026-10-26garbage", "2026-10-26T99:00Z"]) {
    assert.throws(() => dates.dateOnly(invalid), TypeError, invalid);
    assert.equal(dates.isDateOnly(invalid), false);
  }
});

test("legacy and ISO adapters preserve intended calendar day and emit slash display", () => {
  assert.equal(dates.dateOnly("2026-10-26T00:00:00+11:00"), "2026-10-26");
  assert.equal(dates.dateOnlyToUtc("26/10/2026").toISOString(), "2026-10-26T00:00:00.000Z");
  assert.equal(dates.formatDateOnly("2026-10-26", { timeZone: "Pacific/Auckland" }), "26/10/2026");
  assert.equal(dates.weekdayShort("2026-10-26", { timeZone: "Pacific/Auckland" }), "Mon");
  assert.equal(dates.addDateOnlyDays("2024-02-28", 1), "2024-02-29");
  assert.equal(dates.addDateOnlyDays("2026-12-31", 1), "2027-01-01");
});

test("calendar storage and formatting roundtrip in positive/negative and DST timezones", () => {
  const helper = path.resolve(__dirname, "../utils/dateTime.js");
  for (const tz of ["UTC", "Australia/Sydney", "Pacific/Auckland", "America/Los_Angeles", "Asia/Kolkata"]) {
    const result = execFileSync(process.execPath, ["-e", `const d=require(${JSON.stringify(helper)});console.log(JSON.stringify([d.dateOnly(d.dateOnlyToUtc('2026-10-26')),d.formatDateOnly('2026-10-26',{timeZone:process.env.TZ}),d.weekdayShort('2026-10-26',{timeZone:process.env.TZ})]));`], { env: { ...process.env, TZ: tz }, encoding: "utf8" });
    assert.deepEqual(JSON.parse(result), ["2026-10-26", "26/10/2026", "Mon"], tz);
  }
});

test("U classification uses selected term year and whole birth-year filter boundaries", () => {
  assert.equal(dates.ageGroupForYear("2015-10-30", 2026), 11);
  assert.equal(dates.ageGroupForYear("2015-01-01", 2026), 11);
  assert.equal(dates.ageGroupForYear("2015-12-31", 2027), 12);
  assert.deepEqual(dates.parseAgeGroupRange("U6-U8"), { minAge: 6, maxAge: 8 });
  assert.deepEqual(dates.parseAgeGroupRange("U15+"), { minAge: 15, maxAge: 150 });
  const range = dates.ageGroupDobRange(11, 11, 2026);
  assert.equal(range.$gte.toISOString(), "2015-01-01T00:00:00.000Z");
  assert.equal(range.$lt.toISOString(), "2016-01-01T00:00:00.000Z");
  assert.throws(() => dates.ageGroupDobRange(12, 10, 2026), TypeError);
  assert.throws(() => dates.ageGroupContextYear("invalid"), TypeError);
});

test("term create and partial updates validate merged boundaries without local-midnight conversion", () => {
  const current = validatedTermData({ name: " Term 4 ", year: 2026, startDate: "07/10/2026", endDate: "2026-12-09" });
  assert.equal(current.name, "Term 4");
  assert.equal(current.startDate.toISOString(), "2026-10-07T00:00:00.000Z");
  assert.throws(() => validatedTermData({ startDate: "10/12/2026" }, current), /after end date/);
  assert.throws(() => validatedTermData({ endDate: "06/10/2026" }, current), /after end date/);
  assert.throws(() => validatedTermData({ startDate: "31/02/2026" }, current), /valid calendar/);
  assert.throws(() => validatedTermData({ name: " " }, current), /name is required/);
  assert.throws(() => validatedTermData({ startDate: "" }, current), /required/);
  assert.equal(dates.serializeTerm(current).endDate, "2026-12-09");
});

test("wall-clock schedules reject invalid times and nonexistent DST times", () => {
  assert.equal(dates.zonedDateTimeToUtc("2026-10-26", 17, 30, "Australia/Sydney").toISOString(), "2026-10-26T06:30:00.000Z");
  assert.throws(() => dates.zonedDateTimeToUtc("2026-10-26", 24, 0), TypeError);
  assert.throws(() => dates.zonedDateTimeToUtc("2026-10-26", 12, 60), TypeError);
  assert.throws(() => dates.zonedDateTimeToUtc("2026-10-04", 2, 30, "Australia/Sydney"), /does not exist/);
});

test("timestamp ranges include the complete final local day across DST", () => {
  const range = dates.calendarTimestampRange("2026-10-04", "2026-10-04", "Australia/Sydney");
  assert.equal(range.$gte.toISOString(), "2026-10-03T14:00:00.000Z");
  assert.equal(range.$lt.toISOString(), "2026-10-04T13:00:00.000Z");
  assert.equal(dates.todayDateOnly("Australia/Sydney", new Date("2026-10-25T14:00:00Z")), "2026-10-26");
});
