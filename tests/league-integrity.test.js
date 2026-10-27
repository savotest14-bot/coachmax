const { test } = require("node:test");
const assert = require("node:assert/strict");
const { normalizeTeamName, escapeRegex, assertTeamLeagueScope, validateFixtureSchedule, assertRoundParticipants, contributionDeltas } = require("../utils/leagueIntegrity");
const { generateRoundRobinRounds, scheduleFixturesAcrossSlotsAndFields, validateTournamentConfig, parseDateToMidnight } = require("../services/fixtureGenerationService");
const { preflight } = require("../scripts/league-integrity-preflight");
const Fixture = require("../models/Fixture");
const Team = require("../models/Team");
const ids = Array.from({ length: 8 }, (_, n) => String(n + 1).padStart(24, "0"));

test("names normalize Unicode/case/spacing while punctuation remains literal", () => {
  assert.equal(normalizeTeamName("  U10   CM ＹＥＬＬＯＷ "), normalizeTeamName("u10 cm yellow"));
  assert.equal(new RegExp(`^${escapeRegex("U10 (A)+")}$`, "i").test("u10 (a)+"), true);
  assert.equal(new RegExp(`^${escapeRegex("U10 (A)+")}$`, "i").test("U10 AAA"), false);
});

test("league enrollment validates immutable term scope and archived availability", () => {
  const league = { term: "term1", teams: ["a", "b"] };
  assert.doesNotThrow(() => assertTeamLeagueScope(league, [{ _id: "a", term: "term1" }]));
  assert.throws(() => assertTeamLeagueScope(league, [{ _id: "a", term: "term2" }]), /term/);
  assert.throws(() => assertTeamLeagueScope(league, [{ _id: "c", term: "term1" }]), /Enroll/);
  assert.throws(() => assertTeamLeagueScope(league, [{ _id: "a", term: "term1", archivedAt: new Date() }]), /unavailable/);
});

test("schedule validation rejects fractional/invalid rounds, invalid dates and unavailable fields", () => {
  const league = { numberOfRounds: 5, numberOfFields: 4, matchDuration: 60 };
  const valid = { round: 1, kickoffTime: "2026-10-26T07:00:00Z", field: "field 3" };
  const value = validateFixtureSchedule(league, valid);
  assert.equal(value.field, "Field 3");
  assert.equal(value.endTime.toISOString(), "2026-10-26T08:00:00.000Z");
  for (const patch of [{ round: 0 }, { round: 1.5 }, { round: 6 }, { kickoffTime: "bad" }, { endTime: "bad" }, { endTime: "2026-10-25" }, { field: "Field 5" }, { field: "Main Stadium" }]) assert.throws(() => validateFixtureSchedule(league, { ...valid, ...patch }));
});

test("participants share one namespace across home/away but may play in another round", () => {
  const fixtures = [{ league: "L", round: 1, homeTeam: "A", awayTeam: "B" }, { league: "L", round: 1, homeTeam: "C", awayTeam: "A" }];
  assert.throws(() => assertRoundParticipants(fixtures), /once per round/);
  fixtures[1].round = 2;
  assert.doesNotThrow(() => assertRoundParticipants(fixtures));
});

test("schema declares race-safe compound multikey participant and scoped name indexes", () => {
  assert.ok(Fixture.schema.indexes().some(([keys, options]) => keys.participants === 1 && keys.league === 1 && keys.round === 1 && options.unique));
  assert.ok(Team.schema.indexes().some(([keys, options]) => keys.normalizedName === 1 && keys.term === 1 && options.unique));
});

test("round robin has no repeated team in any even, odd or repeating round", () => {
  for (const teamIds of [ids, ids.slice(0, 7)]) {
    const rounds = generateRoundRobinRounds(teamIds, 16);
    assert.equal(rounds.rounds.length, 16);
    for (const round of rounds.rounds) {
      assertRoundParticipants(round.matches.map((match) => ({ ...match, league: "L" })));
      assert.equal(round.matches.length, Math.floor(teamIds.length / 2));
    }
    if (teamIds.length % 2) assert.equal(rounds.byes.length, 16);
  }
});

test("generator refuses knockout round-robin substitution and impossible session dates", () => {
  assert.equal(validateTournamentConfig({ teams: ids, fixtureFormat: "KNOCKOUT", startDate: "2026-10-26", endDate: "2026-11-26" }).isValid, false);
  assert.equal(parseDateToMidnight("2026-02-31"), null);
  assert.equal(parseDateToMidnight("29/02/2028").toISOString(), "2028-02-29T00:00:00.000Z");
});

test("slot scheduling rejects matches after midnight or outside configured session range", () => {
  const config = { roundMatchesMap: new Map([[1, [{ round: 1, homeTeam: "A", awayTeam: "B" }]]]), maxRounds: 1, numberOfFields: 1, matchDuration: 90, breakBetweenMatches: 15, startTime: "23:30", startDate: new Date("2026-10-26"), endDate: new Date("2026-10-26") };
  assert.throws(() => scheduleFixturesAcrossSlotsAndFields(config), /midnight/);
  assert.throws(() => scheduleFixturesAcrossSlotsAndFields({ ...config, startTime: "10:00", sessionDates: ["2026-10-27"] }), /date range/);
});

test("result contribution deltas are repeat safe, reverse reopened results and correct player statistics", () => {
  const before = { status: "SCHEDULED", goals: [], resultPlayers: [] };
  const after = { status: "COMPLETED", goals: [{ scorer: "P", assist: "Q" }], resultPlayers: [{ player: "P", goals: 9, appearances: 1, minutesPlayed: 60 }] };
  const delta = contributionDeltas(before, after);
  assert.equal(delta.P.goals, 1); // Goal log is authoritative, never double-count declared totals.
  assert.equal(delta.P.appearances, 1);
  assert.equal(delta.Q.assists, 1);
  assert.deepEqual(contributionDeltas(after, after), {});
  assert.equal(contributionDeltas(after, { ...after, status: "LIVE" }).P.goals, -1);
  assert.equal(contributionDeltas(after, { ...after, resultPlayers: [{ player: "P", appearances: 1, minutesPlayed: 30 }] }).P.minutesPlayed, -30);
});

test("offline preflight reports conflicts and its backfill plan is idempotent", () => {
  const input = { teams: [{ _id: "A", term: "T", teamName: " Yellow " }, { _id: "B", term: "T", teamName: "BLUE" }], leagues: [{ _id: "L", term: "T", teams: ["A", "B"] }], fixtures: [{ _id: "F", league: "L", round: 1, homeTeam: "A", awayTeam: "B" }] };
  const report = preflight(input);
  assert.equal(report.canApply, true);
  assert.equal(report.counts.teamUpdates, 2);
  input.teams.forEach((team) => { team.normalizedName = normalizeTeamName(team.teamName); });
  input.fixtures[0].participants = ["A", "B"];
  assert.equal(preflight(input).counts.fixtureUpdates, 0);
  assert.equal(preflight(input).counts.teamUpdates, 0);
  input.fixtures.push({ _id: "F2", league: "L", round: 1, homeTeam: "B", awayTeam: "A" });
  assert.equal(preflight(input).canApply, false);
  assert.ok(preflight(input).issues.some((issue) => issue.type === "TEAM_REPEATED_IN_ROUND"));
});
