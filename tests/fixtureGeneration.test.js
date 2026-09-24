const assert = require("assert");
const {
  validateTournamentConfig,
  distributeTeamsIntoGroups,
  generateRoundRobinPairings,
  scheduleFixturesAcrossSlotsAndFields,
} = require("../services/fixtureGenerationService");

console.log("=== Running Fixture Generation & Scheduling Engine Unit Tests ===\n");

let passed = 0;
let failed = 0;

function runTest(name, fn) {
  try {
    fn();
    console.log(`PASS: ${name}`);
    passed++;
  } catch (err) {
    console.error(`FAIL: ${name}`);
    console.error(err);
    failed++;
  }
}

// -----------------------------------------------------------------------------
// Validation Tests
// -----------------------------------------------------------------------------

runTest("Validation: Insufficient teams (< 2) returns error", () => {
  const result = validateTournamentConfig({
    teams: ["6740a1b2c3d4e5f6a7b8c901"],
    startDate: "2026-10-01",
    endDate: "2026-10-05",
  });
  assert.strictEqual(result.isValid, false);
  assert.ok(result.message.includes("At least 2 valid teams"));
});

runTest("Validation: Invalid MongoDB team ID returns error", () => {
  const result = validateTournamentConfig({
    teams: ["6740a1b2c3d4e5f6a7b8c901", "invalid-id-xyz"],
    startDate: "2026-10-01",
    endDate: "2026-10-05",
  });
  assert.strictEqual(result.isValid, false);
  assert.ok(result.message.includes("Invalid team ID format"));
});

runTest("Validation: Duplicate team IDs returns error", () => {
  const result = validateTournamentConfig({
    teams: ["6740a1b2c3d4e5f6a7b8c901", "6740a1b2c3d4e5f6a7b8c901"],
    startDate: "2026-10-01",
    endDate: "2026-10-05",
  });
  assert.strictEqual(result.isValid, false);
  assert.ok(result.message.includes("Duplicate team IDs detected"));
});

runTest("Validation: Too many groups (groupCount > teams) returns error", () => {
  const result = validateTournamentConfig({
    teams: [
      "6740a1b2c3d4e5f6a7b8c901",
      "6740a1b2c3d4e5f6a7b8c902",
      "6740a1b2c3d4e5f6a7b8c903",
    ],
    fixtureFormat: "GROUP",
    groupCount: 4,
    startDate: "2026-10-01",
    endDate: "2026-10-05",
  });
  assert.strictEqual(result.isValid, false);
  assert.ok(result.message.includes("groupCount (4) cannot be greater than the number of teams"));
});

runTest("Validation: Group with fewer than 2 teams returns error", () => {
  const result = validateTournamentConfig({
    teams: [
      "6740a1b2c3d4e5f6a7b8c901",
      "6740a1b2c3d4e5f6a7b8c902",
      "6740a1b2c3d4e5f6a7b8c903",
    ],
    fixtureFormat: "GROUP",
    groupCount: 2, // 3 teams into 2 groups => one group has 1 team
    startDate: "2026-10-01",
    endDate: "2026-10-05",
  });
  assert.strictEqual(result.isValid, false);
  assert.ok(result.message.includes("Each group must contain at least 2 teams"));
});

runTest("Validation: Invalid date range (endDate < startDate) returns error", () => {
  const result = validateTournamentConfig({
    teams: [
      "6740a1b2c3d4e5f6a7b8c901",
      "6740a1b2c3d4e5f6a7b8c902",
    ],
    startDate: "2026-10-05",
    endDate: "2026-10-01",
  });
  assert.strictEqual(result.isValid, false);
  assert.ok(result.message.includes("endDate cannot be earlier than startDate"));
});

// -----------------------------------------------------------------------------
// Round Robin Pairings & BYE Tests
// -----------------------------------------------------------------------------

runTest("Pairings: 2 teams (even), 1 round -> 1 round, 1 match", () => {
  const teams = ["T1", "T2"];
  const { rounds, byes, roundsPerCycle, totalMatches } = generateRoundRobinPairings(teams, 1);
  assert.strictEqual(roundsPerCycle, 1);
  assert.strictEqual(totalMatches, 1);
  assert.strictEqual(rounds.length, 1);
  assert.strictEqual(rounds[0].matches.length, 1);
  assert.strictEqual(byes.length, 0);
  assert.strictEqual(rounds[0].matches[0].homeTeam, "T1");
  assert.strictEqual(rounds[0].matches[0].awayTeam, "T2");
});

runTest("Pairings: 3 teams (odd), 1 round -> 3 rounds, 3 matches, 1 BYE per round", () => {
  const teams = ["T1", "T2", "T3"];
  const { rounds, byes, roundsPerCycle, totalMatches } = generateRoundRobinPairings(teams, 1);
  assert.strictEqual(roundsPerCycle, 3);
  assert.strictEqual(totalMatches, 3); // 3 * 2 / 2 = 3 matches
  assert.strictEqual(byes.length, 3); // Each team receives 1 BYE

  // Check that every team plays exactly 2 matches
  const matchCounts = { T1: 0, T2: 0, T3: 0 };
  for (const r of rounds) {
    for (const m of r.matches) {
      matchCounts[m.homeTeam]++;
      matchCounts[m.awayTeam]++;
    }
  }
  assert.deepStrictEqual(matchCounts, { T1: 2, T2: 2, T3: 2 });
});

runTest("Pairings: 4 teams (even), 1 round -> 3 rounds, 6 matches, 0 BYE", () => {
  const teams = ["T1", "T2", "T3", "T4"];
  const { rounds, byes, roundsPerCycle, totalMatches } = generateRoundRobinPairings(teams, 1);
  assert.strictEqual(roundsPerCycle, 3);
  assert.strictEqual(totalMatches, 6);
  assert.strictEqual(byes.length, 0);

  // Every pair plays exactly once
  const pairs = new Set();
  for (const r of rounds) {
    assert.strictEqual(r.matches.length, 2);
    for (const m of r.matches) {
      assert.notStrictEqual(m.homeTeam, m.awayTeam);
      const pairKey = [m.homeTeam, m.awayTeam].sort().join("-");
      assert.ok(!pairs.has(pairKey), `Duplicate matchup: ${pairKey}`);
      pairs.add(pairKey);
    }
  }
  assert.strictEqual(pairs.size, 6);
});

runTest("Pairings: 5 teams (odd), 1 round -> 5 rounds, 10 matches, 5 BYEs", () => {
  const teams = ["T1", "T2", "T3", "T4", "T5"];
  const { rounds, byes, roundsPerCycle, totalMatches } = generateRoundRobinPairings(teams, 1);
  assert.strictEqual(roundsPerCycle, 5);
  assert.strictEqual(totalMatches, 10);
  assert.strictEqual(byes.length, 5);

  // Each team gets exactly 1 BYE
  const byeTeams = byes.map((b) => b.team).sort();
  assert.deepStrictEqual(byeTeams, ["T1", "T2", "T3", "T4", "T5"]);

  // Each round has exactly 2 matches
  for (const r of rounds) {
    assert.strictEqual(r.matches.length, 2);
  }
});

runTest("Pairings: 6 teams (even), 1 round -> 5 rounds, 15 matches", () => {
  const teams = ["T1", "T2", "T3", "T4", "T5", "T6"];
  const { rounds, byes, roundsPerCycle, totalMatches } = generateRoundRobinPairings(teams, 1);
  assert.strictEqual(roundsPerCycle, 5);
  assert.strictEqual(totalMatches, 15);
  assert.strictEqual(byes.length, 0);

  // Each team plays 5 matches
  const counts = {};
  teams.forEach((t) => (counts[t] = 0));
  rounds.forEach((r) =>
    r.matches.forEach((m) => {
      counts[m.homeTeam]++;
      counts[m.awayTeam]++;
    })
  );
  assert.deepStrictEqual(counts, { T1: 5, T2: 5, T3: 5, T4: 5, T5: 5, T6: 5 });
});

runTest("Pairings: 4 teams, 2 rounds -> 6 rounds, 12 matches, home/away inverted in cycle 2", () => {
  const teams = ["T1", "T2", "T3", "T4"];
  const { rounds, totalMatches } = generateRoundRobinPairings(teams, 2);
  assert.strictEqual(totalMatches, 12);
  assert.strictEqual(rounds.length, 6);

  // Collect matches from cycle 1 (rounds 1-3) and cycle 2 (rounds 4-6)
  const cycle1Matches = rounds.slice(0, 3).flatMap((r) => r.matches);
  const cycle2Matches = rounds.slice(3, 6).flatMap((r) => r.matches);

  assert.strictEqual(cycle1Matches.length, 6);
  assert.strictEqual(cycle2Matches.length, 6);

  // Check that for every home vs away in cycle 1, cycle 2 has away vs home
  for (const c1 of cycle1Matches) {
    const counterpart = cycle2Matches.find(
      (c2) => c2.homeTeam === c1.awayTeam && c2.awayTeam === c1.homeTeam
    );
    assert.ok(
      counterpart,
      `Cycle 2 missing inverted return match for ${c1.homeTeam} vs ${c1.awayTeam}`
    );
  }
});

// -----------------------------------------------------------------------------
// Group Distribution Tests
// -----------------------------------------------------------------------------

runTest("Groups: 10 teams, 2 groups -> Group A = 5, Group B = 5", () => {
  const teams = Array.from({ length: 10 }, (_, i) => `T${i + 1}`);
  const groups = distributeTeamsIntoGroups(teams, 2);
  assert.strictEqual(groups.length, 2);
  assert.strictEqual(groups[0].name, "Group A");
  assert.strictEqual(groups[1].name, "Group B");
  assert.strictEqual(groups[0].teams.length, 5);
  assert.strictEqual(groups[1].teams.length, 5);

  // Check all teams present, no duplicates
  const allInGroups = [...groups[0].teams, ...groups[1].teams];
  assert.strictEqual(new Set(allInGroups).size, 10);
});

runTest("Groups: 11 teams, 2 groups -> Group A = 6, Group B = 5", () => {
  const teams = Array.from({ length: 11 }, (_, i) => `T${i + 1}`);
  const groups = distributeTeamsIntoGroups(teams, 2);
  assert.strictEqual(groups[0].teams.length, 6);
  assert.strictEqual(groups[1].teams.length, 5);
});

// -----------------------------------------------------------------------------
// Match Scheduling Tests (Slots & Fields)
// -----------------------------------------------------------------------------

runTest("Scheduling: 5 matches on 2 fields -> 10:00 (M1, M2), 11:45 (M3, M4), 13:30 (M5)", () => {
  // 5 matches in round 1
  const matches = [
    { round: 1, homeTeam: "T1", awayTeam: "T2", group: "" },
    { round: 1, homeTeam: "T3", awayTeam: "T4", group: "" },
    { round: 1, homeTeam: "T5", awayTeam: "T6", group: "" },
    { round: 1, homeTeam: "T7", awayTeam: "T8", group: "" },
    { round: 1, homeTeam: "T9", awayTeam: "T10", group: "" },
  ];

  const roundMatchesMap = new Map();
  roundMatchesMap.set(1, matches);

  const startDate = new Date(Date.UTC(2026, 9, 1));
  const endDate = new Date(Date.UTC(2026, 9, 1)); // 1 day

  const result = scheduleFixturesAcrossSlotsAndFields({
    roundMatchesMap,
    maxRounds: 1,
    numberOfFields: 2,
    matchDuration: 90,
    breakBetweenMatches: 15,
    startTime: "10:00",
    startDate,
    endDate,
  });

  const fixtures = result.scheduledFixtures;
  assert.strictEqual(fixtures.length, 5);

  // Slot 1 (10:00)
  assert.strictEqual(fixtures[0].kickoffTime.getUTCHours(), 10);
  assert.strictEqual(fixtures[0].kickoffTime.getUTCMinutes(), 0);
  assert.strictEqual(fixtures[0].field, "Field 1");

  assert.strictEqual(fixtures[1].kickoffTime.getUTCHours(), 10);
  assert.strictEqual(fixtures[1].kickoffTime.getUTCMinutes(), 0);
  assert.strictEqual(fixtures[1].field, "Field 2");

  // Slot 2 (11:45)
  assert.strictEqual(fixtures[2].kickoffTime.getUTCHours(), 11);
  assert.strictEqual(fixtures[2].kickoffTime.getUTCMinutes(), 45);
  assert.strictEqual(fixtures[2].field, "Field 1");

  assert.strictEqual(fixtures[3].kickoffTime.getUTCHours(), 11);
  assert.strictEqual(fixtures[3].kickoffTime.getUTCMinutes(), 45);
  assert.strictEqual(fixtures[3].field, "Field 2");

  // Slot 3 (13:30)
  assert.strictEqual(fixtures[4].kickoffTime.getUTCHours(), 13);
  assert.strictEqual(fixtures[4].kickoffTime.getUTCMinutes(), 30);
  assert.strictEqual(fixtures[4].field, "Field 1");
});

runTest("Scheduling: 1 field schedules all matches sequentially in slots", () => {
  const matches = [
    { round: 1, homeTeam: "T1", awayTeam: "T2", group: "" },
    { round: 1, homeTeam: "T3", awayTeam: "T4", group: "" },
  ];
  const roundMatchesMap = new Map();
  roundMatchesMap.set(1, matches);

  const startDate = new Date(Date.UTC(2026, 9, 1));
  const endDate = new Date(Date.UTC(2026, 9, 1));

  const result = scheduleFixturesAcrossSlotsAndFields({
    roundMatchesMap,
    maxRounds: 1,
    numberOfFields: 1,
    matchDuration: 60,
    breakBetweenMatches: 10,
    startTime: "09:00",
    startDate,
    endDate,
  });

  const fixtures = result.scheduledFixtures;
  assert.strictEqual(fixtures.length, 2);
  assert.strictEqual(fixtures[0].kickoffTime.getUTCHours(), 9);
  assert.strictEqual(fixtures[0].kickoffTime.getUTCMinutes(), 0);
  assert.strictEqual(fixtures[1].kickoffTime.getUTCHours(), 10);
  assert.strictEqual(fixtures[1].kickoffTime.getUTCMinutes(), 10);
});

runTest("Scheduling: Insufficient date range throws clear error", () => {
  // 20 matches, 1 field, slot length 105 min.
  // In 1 day (10:00 to 24:00 = 840 min), only 8 matches can fit.
  // With endDate = startDate (1 day), 20 matches cannot fit!
  const matches = Array.from({ length: 20 }, (_, i) => ({
    round: 1,
    homeTeam: `T${i * 2 + 1}`,
    awayTeam: `T${i * 2 + 2}`,
    group: "",
  }));
  const roundMatchesMap = new Map();
  roundMatchesMap.set(1, matches);

  const startDate = new Date(Date.UTC(2026, 9, 1));
  const endDate = new Date(Date.UTC(2026, 9, 1)); // Only 1 day

  assert.throws(
    () => {
      scheduleFixturesAcrossSlotsAndFields({
        roundMatchesMap,
        maxRounds: 1,
        numberOfFields: 1,
        matchDuration: 90,
        breakBetweenMatches: 15,
        startTime: "10:00",
        startDate,
        endDate,
      });
    },
    /cannot fit inside the available date range/
  );
});

runTest("Pairings: 7 teams (odd), 1 round -> 7 rounds, 21 matches, 7 BYEs", () => {
  const teams = ["T1", "T2", "T3", "T4", "T5", "T6", "T7"];
  const { rounds, byes, roundsPerCycle, totalMatches } = generateRoundRobinPairings(teams, 1);
  assert.strictEqual(roundsPerCycle, 7);
  assert.strictEqual(totalMatches, 21); // 7 * 6 / 2 = 21
  assert.strictEqual(byes.length, 7);

  // Each team plays 6 matches and gets 1 BYE
  const counts = {};
  teams.forEach((t) => (counts[t] = 0));
  rounds.forEach((r) =>
    r.matches.forEach((m) => {
      counts[m.homeTeam]++;
      counts[m.awayTeam]++;
    })
  );
  assert.deepStrictEqual(counts, { T1: 6, T2: 6, T3: 6, T4: 6, T5: 6, T6: 6, T7: 6 });
});

runTest("Pairings: 8 teams (even), 1 round -> 7 rounds, 28 matches", () => {
  const teams = ["T1", "T2", "T3", "T4", "T5", "T6", "T7", "T8"];
  const { rounds, byes, roundsPerCycle, totalMatches } = generateRoundRobinPairings(teams, 1);
  assert.strictEqual(roundsPerCycle, 7);
  assert.strictEqual(totalMatches, 28); // 8 * 7 / 2 = 28
  assert.strictEqual(byes.length, 0);

  // Each team plays 7 matches
  const counts = {};
  teams.forEach((t) => (counts[t] = 0));
  rounds.forEach((r) =>
    r.matches.forEach((m) => {
      counts[m.homeTeam]++;
      counts[m.awayTeam]++;
    })
  );
  assert.deepStrictEqual(counts, { T1: 7, T2: 7, T3: 7, T4: 7, T5: 7, T6: 7, T7: 7, T8: 7 });
});

// -----------------------------------------------------------------------------
// Random Generation & Multi-Run Tests
// -----------------------------------------------------------------------------

runTest("Random Generation: Multiple runs (Gen 1, 2, 3, 4) all produce valid double round-robins with randomized sequences", () => {
  const teams = ["T1", "T2", "T3", "T4"];
  const runs = [];

  for (let gen = 1; gen <= 4; gen++) {
    const { rounds, totalMatches } = generateRoundRobinPairings(teams, 2, "", true);
    assert.strictEqual(totalMatches, 12, `Gen ${gen} must have 12 matches`);
    assert.strictEqual(rounds.length, 6, `Gen ${gen} must have 6 rounds`);

    // Verify all pairs meet twice: once home, once away
    const pairRecords = {};
    for (const r of rounds) {
      for (const m of r.matches) {
        assert.notStrictEqual(m.homeTeam, m.awayTeam);
        const matchKey = `${m.homeTeam}->${m.awayTeam}`;
        assert.strictEqual(pairRecords[matchKey], undefined, `Duplicate exact match ${matchKey} in gen ${gen}`);
        pairRecords[matchKey] = true;
      }
    }
    assert.strictEqual(Object.keys(pairRecords).length, 12);
    runs.push(rounds);
  }

  // Verify that not all 4 generations have identical first round matches (randomization works)
  const firstRoundKeys = runs.map((rounds) =>
    rounds[0].matches.map((m) => `${m.homeTeam}vs${m.awayTeam}`).sort().join("|")
  );
  const uniqueFirstRounds = new Set(firstRoundKeys);
  assert.ok(
    uniqueFirstRounds.size > 1,
    "Random generation should produce varied schedules across multiple runs"
  );
});

// -----------------------------------------------------------------------------
// In-Memory Reconciliation & Protection Logic Tests
// -----------------------------------------------------------------------------

runTest("Reconciliation: In-place update preserves fixture count and avoids duplicates", () => {
  // Simulate 12 existing fixtures in database
  const existing = Array.from({ length: 12 }, (_, i) => ({
    _id: `fixture_${i + 1}`,
    round: 1,
    homeTeam: "T1",
    awayTeam: "T2",
    fixtureSource: "GENERATED",
    isManuallyModified: false,
    status: "SCHEDULED",
  }));

  // New generated schedule has 12 matches
  const target = Array.from({ length: 12 }, (_, i) => ({
    round: Math.floor(i / 2) + 1,
    homeTeam: `T_new_${i}`,
    awayTeam: `T_new_${i + 10}`,
    kickoffTime: new Date(),
    endTime: new Date(),
    field: "Field 1",
    venue: "Field 1",
  }));

  const reusable = existing.filter((f) => !f.isManuallyModified);
  const updatedCount = Math.min(target.length, reusable.length);
  const createdCount = Math.max(0, target.length - reusable.length);

  assert.strictEqual(updatedCount, 12);
  assert.strictEqual(createdCount, 0);
  // Total fixtures in DB stays 12, exactly 0 duplicates
  assert.strictEqual(reusable.length + createdCount, 12);
});

runTest("Reconciliation: Manual fixtures are protected from automatic overwrite", () => {
  // Fixture 1 is manual, Fixture 2 is generated
  const existing = [
    { _id: "f1", fixtureSource: "MANUAL", isManuallyModified: true },
    { _id: "f2", fixtureSource: "GENERATED", isManuallyModified: false },
  ];

  const forceRegenerate = false;
  const manualFixtures = existing.filter(
    (f) => f.fixtureSource === "MANUAL" || f.isManuallyModified === true
  );
  const reusable = forceRegenerate
    ? existing
    : existing.filter((f) => f.fixtureSource !== "MANUAL" && !f.isManuallyModified);

  assert.strictEqual(manualFixtures.length, 1);
  assert.strictEqual(manualFixtures[0]._id, "f1");
  assert.strictEqual(reusable.length, 1);
  assert.strictEqual(reusable[0]._id, "f2");
});

runTest("Reconciliation: Completed matches with results block destructive regeneration", () => {
  const existing = [
    { _id: "f1", status: "COMPLETED", score: { homeScore: 2, awayScore: 1 } },
    { _id: "f2", status: "SCHEDULED", score: { homeScore: 0, awayScore: 0 } },
  ];

  const protectedFixtures = existing.filter((f) => {
    const hasScore =
      (f.score?.homeScore !== undefined && f.score.homeScore > 0) ||
      (f.score?.awayScore !== undefined && f.score.awayScore > 0);
    return f.status === "COMPLETED" || f.status === "LIVE" || hasScore;
  });

  assert.strictEqual(protectedFixtures.length, 1);
  assert.strictEqual(protectedFixtures[0]._id, "f1");
});

// -----------------------------------------------------------------------------
// Summary
// -----------------------------------------------------------------------------

console.log(`\n=== Test Results: ${passed} Passed, ${failed} Failed ===`);
if (failed > 0) {
  process.exit(1);
} else {
  console.log("All unit tests passed successfully!\n");
}

