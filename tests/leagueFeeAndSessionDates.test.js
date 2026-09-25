const assert = require("assert");
const {
  scheduleFixturesAcrossSlotsAndFields,
  parseDateToMidnight,
} = require("../services/fixtureGenerationService");

console.log("=== Testing League Fee and Session Dates Scheduling ===");

// Test 1: Date parsing for DD-MM-YYYY format
const d1 = parseDateToMidnight("26-09-2026");
assert(d1 instanceof Date, "d1 must be a Date");
assert.strictEqual(d1.getUTCDate(), 26);
assert.strictEqual(d1.getUTCMonth(), 8); // 0-indexed: September is 8
assert.strictEqual(d1.getUTCFullYear(), 2026);
console.log("PASS: parseDateToMidnight correctly parses '26-09-2026'");

// Test 2: Scheduling matches across sessionDates according to rounds
const sessionDates = [
  parseDateToMidnight("26-09-2026"),
  parseDateToMidnight("27-09-2026"),
  parseDateToMidnight("30-09-2026"),
];

const roundMatchesMap = new Map();
roundMatchesMap.set(1, [{ round: 1, homeTeam: "A", awayTeam: "B" }]);
roundMatchesMap.set(2, [{ round: 2, homeTeam: "B", awayTeam: "C" }]);
roundMatchesMap.set(3, [{ round: 3, homeTeam: "A", awayTeam: "C" }]);

const result = scheduleFixturesAcrossSlotsAndFields({
  roundMatchesMap,
  maxRounds: 3,
  numberOfFields: 1,
  matchDuration: 90,
  breakBetweenMatches: 15,
  startTime: "10:00",
  startDate: sessionDates[0],
  endDate: sessionDates[2],
  sessionDates,
});

assert.strictEqual(result.scheduledFixtures.length, 3);
assert.strictEqual(result.scheduledFixtures[0].round, 1);
assert.strictEqual(result.scheduledFixtures[0].sessionDate.toISOString(), sessionDates[0].toISOString());

assert.strictEqual(result.scheduledFixtures[1].round, 2);
assert.strictEqual(result.scheduledFixtures[1].sessionDate.toISOString(), sessionDates[1].toISOString());

assert.strictEqual(result.scheduledFixtures[2].round, 3);
assert.strictEqual(result.scheduledFixtures[2].sessionDate.toISOString(), sessionDates[2].toISOString());

console.log("PASS: Fixtures for round 1, 2, 3 scheduled precisely on sessionDates[0], sessionDates[1], sessionDates[2]");

console.log("=== All Tests Passed Successfully ===");
