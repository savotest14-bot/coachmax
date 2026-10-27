const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const fs = require("node:fs/promises");
const path = require("node:path");
// Isolated disposable local replica only. Never load application .env or run workers.
delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
process.env.FIREBASE_SERVICE_ACCOUNT_PATH = path.join(os.tmpdir(), "coachmax-league-test-no-firebase.json");
const uploadDirectory = path.resolve(__dirname, `../.test-tmp/league-upload-${process.pid}`);
process.env.UPLOAD_ROOT = uploadDirectory;
const mongoose = require("mongoose");
const { runIntegrityMigration } = require("../scripts/migrate-integrity");
const { assertCriticalIndexes, criticalIndexRequirements } = require("../services/criticalIndexes");
const { MongoMemoryReplSet } = require("mongodb-memory-server");
const Team = require("../models/Team");
const League = require("../models/League");
const Fixture = require("../models/Fixture");
const Term = require("../models/Term");
const User = require("../models/User");
const Standing = require("../models/Standing");
const PlayerStatistics = require("../models/PlayerStatistics");
const MatchEvent = require("../models/MatchEvent");
const controller = require("../controllers/leagueController");
const { reconcileAndSaveLeagueFixtures } = require("../services/fixtureGenerationService");
const models = [Team, League, Fixture, Term, User, Standing, PlayerStatistics, MatchEvent];
let replica;
let testDirectory;
const temporaryRoot = path.resolve(__dirname, "../.test-tmp");
const oid = () => new mongoose.Types.ObjectId();
const response = () => ({ statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });
const call = async (action, params = {}, body = {}, query = {}) => {
  const res = response();
  await controller[action]({ params, body, query, user: { _id: oid(), role: "SUPER_ADMIN" }, admin: { _id: oid(), role: "SUPER_ADMIN" }, role: "SUPER_ADMIN" }, res);
  return res;
};

test.before(async () => {
  await fs.mkdir(temporaryRoot, { recursive: true });
  testDirectory = await fs.mkdtemp(path.join(temporaryRoot, "league-"));
  const dbPath = path.join(testDirectory, "mongo");
  await fs.mkdir(dbPath);
  replica = await MongoMemoryReplSet.create({ instanceOpts: [{ dbPath }], replSet: { count: 1, storageEngine: "wiredTiger" } });
  await mongoose.connect(replica.getUri(), { dbName: "league_fixture_test", autoIndex: false });
  for (const Model of models) { await Model.createCollection(); await Model.createIndexes(); }
}, { timeout: 180000 });
test.beforeEach(async () => { for (const Model of models) await Model.deleteMany({}); });
test.after(async () => {
  await mongoose.disconnect(); if (replica) await replica.stop();
  if (testDirectory && path.resolve(testDirectory).startsWith(temporaryRoot + path.sep) && path.basename(testDirectory).startsWith("league-")) await fs.rm(testDirectory, { recursive: true, force: true });
  if (uploadDirectory.startsWith(temporaryRoot + path.sep) && path.basename(uploadDirectory) === `league-upload-${process.pid}`) await fs.rm(uploadDirectory, { recursive: true, force: true });
});

async function setup(count = 4) {
  const term = await Term.create({ name: "Term 4", year: 2026, startDate: new Date("2026-10-01"), endDate: new Date("2026-12-31") });
  const player = await User.create({ fullName: "Player", parentId: oid(), dob: new Date("2015-10-30") });
  const teams = await Team.create(Array.from({ length: count }, (_, i) => ({ teamName: `Team ${i + 1}`, term: term._id, players: i === 0 ? [{ player: player._id, paymentStatus: "PAID" }] : [] })));
  const league = await League.create({ name: "League", season: "2026", term: term._id, startDate: term.startDate, endDate: term.endDate, numberOfRounds: 5, numberOfFields: 4, matchDuration: 60, teams: teams.map((team) => team._id) });
  await Team.updateMany({ _id: { $in: teams.map((team) => team._id) } }, { $push: { leagues: { league: league._id, teamFee: 0, players: [{ player: player._id, paymentStatus: "PAID" }] } } });
  return { term, teams, league, player };
}
const matchPayload = (f, home = 0, away = 1, patch = {}) => ({ league: String(f.league._id), round: 1, kickoffTime: "2026-10-26T07:00:00.000Z", venue: "Main Stadium", field: "Field 1", homeTeam: String(f.teams[home]._id), awayTeam: String(f.teams[away]._id), ...patch });
const create = (f, payload = matchPayload(f)) => call("createFixture", { leagueId: String(f.league._id) }, payload);

test("real team unique index allows identical names in different terms and rejects same-term concurrent variants", async () => {
  const f = await setup();
  const otherTerm = await Term.create({ name: "Term 3", year: 2026, startDate: f.term.startDate, endDate: f.term.endDate });
  const outcomes = await Promise.allSettled([Team.create({ teamName: " U10 CM YELLOW ", term: f.term._id }), Team.create({ teamName: "u10  cm yellow", term: f.term._id })]);
  assert.equal(outcomes.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(outcomes.find((result) => result.status === "rejected").reason.code, 11000);
  await Team.create({ teamName: "U10 CM YELLOW", term: otherTerm._id });
  const apiDuplicate = await call("createTeam", {}, { teamName: "u10 cm yellow", term: String(f.term._id) });
  assert.equal(apiDuplicate.statusCode, 409);
});

test("real fixture multikey index prevents opposite-side participant races, allows another round", async () => {
  const f = await setup();
  const common = { league: f.league._id, round: 1, kickoffTime: new Date("2026-10-26T07:00:00Z"), venue: "Main Stadium" };
  const outcomes = await Promise.allSettled([Fixture.create({ ...common, homeTeam: f.teams[0]._id, awayTeam: f.teams[1]._id }), Fixture.create({ ...common, homeTeam: f.teams[2]._id, awayTeam: f.teams[0]._id })]);
  assert.equal(outcomes.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(outcomes.find((result) => result.status === "rejected").reason.code, 11000);
  await Fixture.create({ ...common, round: 2, homeTeam: f.teams[0]._id, awayTeam: f.teams[3]._id });
  assert.equal(await Fixture.countDocuments(), 2);
});

test("manual creation rejects cross-term, unenrolled, invalid field/round and wrong URL league without writes", async () => {
  const f = await setup();
  const other = await Team.create({ teamName: "Other term", term: oid() });
  for (const patch of [{ field: "Main Stadium" }, { field: "Field 5" }, { round: 1.5 }, { kickoffTime: "bad" }, { homeTeam: String(other._id) }, { league: String(oid()) }]) {
    const result = await create(f, matchPayload(f, 0, 1, patch));
    assert.equal(result.statusCode, 400, result.body?.message);
  }
  const notEnrolled = await Team.create({ teamName: "Unenrolled", term: f.term._id });
  assert.equal((await create(f, matchPayload(f, 0, 1, { awayTeam: String(notEnrolled._id) }))).statusCode, 400);
  assert.equal(await Fixture.countDocuments(), 0);
});

test("transactional scheduling serializes disjoint teams competing for a field booking", async () => {
  const f = await setup();
  const results = await Promise.all([create(f, matchPayload(f)), create(f, matchPayload(f, 2, 3))]);
  assert.equal(results.filter((result) => result.statusCode === 201).length, 1, JSON.stringify(results.map((result) => result.body)));
  assert.equal(results.find((result) => result.statusCode !== 201).statusCode, 409);
  assert.equal(await Fixture.countDocuments(), 1);
});

test("used team is rejected at another kickoff while a separate field and unused teams succeeds", async () => {
  const f = await setup();
  assert.equal((await create(f)).statusCode, 201);
  assert.equal((await create(f, matchPayload(f, 2, 0, { kickoffTime: "2026-10-27T07:00:00Z", field: "Field 2" }))).statusCode, 409);
  assert.equal((await create(f, matchPayload(f, 2, 3, { field: "Field 2" }))).statusCode, 201);
});

test("Save Final Result completes 0-0 once, corrects statistics and reverses reopened results", async () => {
  const f = await setup();
  const created = await create(f);
  assert.equal(created.statusCode, 201, created.body?.message);
  const matchId = String(created.body.data._id);
  const players = [{ player: String(f.player._id), appearances: 1, minutesPlayed: 60, cleanSheet: true }];
  const done = await call("completeMatch", { matchId }, { homeScore: 0, awayScore: 0, players });
  assert.equal(done.statusCode, 200, done.body?.message);
  assert.equal((await Fixture.findById(matchId)).status, "COMPLETED");
  assert.equal((await Standing.findOne({ league: f.league._id, team: f.teams[0]._id })).drawn, 1);
  assert.equal((await User.findById(f.player._id)).statistics.appearances, 1);
  const repeat = await call("completeMatch", { matchId }, { homeScore: 0, awayScore: 0, players });
  assert.equal(repeat.statusCode, 200, repeat.body?.message);
  assert.equal((await User.findById(f.player._id)).statistics.appearances, 1);
  const corrected = await call("updateFixture", { leagueId: String(f.league._id), fixtureId: matchId }, { homeScore: 1, awayScore: 0, status: "COMPLETED", goals: [{ team: String(f.teams[0]._id), scorer: String(f.player._id), minute: 10 }] });
  assert.equal(corrected.statusCode, 200, corrected.body?.message);
  assert.equal((await Standing.findOne({ league: f.league._id, team: f.teams[0]._id })).points, 3);
  assert.equal((await User.findById(f.player._id)).statistics.goals, 1);
  const reopened = await call("updateFixture", { fixtureId: matchId }, { status: "LIVE" });
  assert.equal(reopened.statusCode, 200, reopened.body?.message);
  assert.equal((await Standing.findOne({ league: f.league._id, team: f.teams[0]._id })).played, 0);
  assert.equal((await User.findById(f.player._id)).statistics.goals, 0);
  assert.equal((await User.findById(f.player._id)).statistics.appearances, 0);
  assert.equal((await PlayerStatistics.findOne({ league: f.league._id, player: f.player._id })).goals, 0);
});

test("nested fixture editing rejects a mismatched league and stale client version", async () => {
  const f = await setup();
  const created = await create(f);
  const fixtureId = String(created.body.data._id);
  assert.equal((await call("updateFixture", { leagueId: String(oid()), fixtureId }, { referee: "X" })).statusCode, 404);
  assert.equal((await call("updateFixture", { fixtureId }, { version: 10, referee: "X" })).statusCode, 409);
  assert.equal((await Fixture.findById(fixtureId)).referee, "");
});

test("concurrent result finalization applies standings and player totals once", async () => {
  const f = await setup();
  const created = await create(f);
  const matchId = String(created.body.data._id);
  const body = { homeScore: 1, awayScore: 0, players: [{ player: String(f.player._id), goals: 1, appearances: 1, minutesPlayed: 60 }] };
  const results = await Promise.all([call("completeMatch", { matchId }, body), call("completeMatch", { matchId }, body)]);
  assert.ok(results.some((result) => result.statusCode === 200), JSON.stringify(results.map((result) => result.body)));
  assert.ok(results.every((result) => [200, 409].includes(result.statusCode)), JSON.stringify(results.map((result) => result.body)));
  assert.equal((await User.findById(f.player._id)).statistics.goals, 1);
  assert.equal((await Standing.findOne({ league: f.league._id, team: f.teams[0]._id })).played, 1);
});

test("team and league archives preserve completed match identities, results and standings", async () => {
  const f = await setup();
  const created = await create(f);
  const matchId = String(created.body.data._id);
  assert.equal((await call("completeMatch", { matchId }, { homeScore: 0, awayScore: 0 })).statusCode, 200);
  assert.equal((await call("deleteFixture", { fixtureId: matchId })).statusCode, 409);
  assert.equal((await call("deleteRoundFixtures", { leagueId: String(f.league._id), round: 1 })).statusCode, 409);
  assert.equal((await call("deleteTeam", { teamId: String(f.teams[0]._id) })).statusCode, 200);
  assert.ok((await Team.findById(f.teams[0]._id)).archivedAt);
  assert.equal((await Fixture.findById(matchId)).status, "COMPLETED");
  assert.equal((await call("deleteLeague", { leagueId: String(f.league._id) })).statusCode, 200);
  assert.ok((await League.findById(f.league._id)).archivedAt);
  assert.equal(await Standing.countDocuments({ league: f.league._id }), 2);
  assert.equal(await Fixture.countDocuments(), 1);
});

test("league config update retains per-league roster, PAID state and correct standings", async () => {
  const f = await setup();
  const created = await create(f);
  assert.equal((await call("completeMatch", { matchId: String(created.body.data._id) }, { homeScore: 0, awayScore: 0 })).statusCode, 200);
  const result = await call("updateLeague", { leagueId: String(f.league._id) }, { description: "Updated", numberOfFields: 4, fee: 0 });
  assert.equal(result.statusCode, 200, result.body?.message);
  const team = await Team.findById(f.teams[0]._id);
  assert.equal(team.leagues[0].players[0].paymentStatus, "PAID");
  assert.equal(team.leagues[0].statistics.played, 1);
  assert.equal(team.leagues[0].statistics.points, 1);
});

test("regeneration preserves manual match participants and rejects overwriting completed results", async () => {
  const f = await setup();
  f.league.numberOfRounds = 1; await f.league.save();
  const created = await create(f);
  const session = await mongoose.startSession();
  let result;
  try {
    await session.withTransaction(async () => { result = await reconcileAndSaveLeagueFixtures({ league: await League.findById(f.league._id).session(session), teams: f.teams.map((team) => String(team._id)), randomize: false, config: { numberOfRounds: 1, numberOfFields: 4, matchDuration: 60 }, session }); });
  } finally { await session.endSession(); }
  const fixtures = await Fixture.find({ league: f.league._id });
  assert.ok(fixtures.some((match) => String(match._id) === String(created.body.data._id)));
  const participants = fixtures.flatMap((match) => [String(match.homeTeam), String(match.awayTeam)]);
  assert.equal(new Set(participants).size, participants.length);
  assert.equal(result.manualFixturesPreserved, 1);
  assert.equal(fixtures.length, 2, "All four teams must be paired once, including the manual match.");
  assert.equal((await call("completeMatch", { matchId: String(created.body.data._id) }, { homeScore: 0, awayScore: 0 })).statusCode, 200);
  const protectedResult = await call("generateRandomFixtures", { leagueId: String(f.league._id) }, { forceRegenerate: true });
  assert.equal(protectedResult.statusCode, 400);
  assert.equal(await Fixture.countDocuments({ league: f.league._id }), 2);
  for (const first of fixtures) for (const second of fixtures) if (String(first._id) !== String(second._id) && first.field === second.field) assert.ok(first.endTime <= second.kickoffTime || second.endTime <= first.kickoffTime);
});


test("match statistics failure rolls back fixture, standings and player changes before retry", async () => {
  const f = await setup();
  const created = await create(f);
  const matchId = String(created.body.data._id);
  const original = User.bulkWrite;
  try {
    User.bulkWrite = async () => { throw new Error("Simulated player-statistics storage failure"); };
    const failed = await call("completeMatch", { matchId }, { homeScore: 1, awayScore: 0, players: [{ player: String(f.player._id), goals: 1, appearances: 1 }] });
    assert.equal(failed.statusCode, 500);
  } finally { User.bulkWrite = original; }
  assert.equal((await Fixture.findById(matchId)).status, "SCHEDULED");
  assert.equal(await Standing.countDocuments(), 0);
  assert.equal(await PlayerStatistics.countDocuments(), 0);
  assert.equal((await User.findById(f.player._id)).statistics.goals, 0);
  assert.equal((await call("completeMatch", { matchId }, { homeScore: 0, awayScore: 0 })).statusCode, 200);
});

test("custom-root logo replacement preserves files shared by cloned teams and removes failed uploads", async () => {
  const f = await setup();
  const folder = path.join(uploadDirectory, "teamlogos");
  await fs.mkdir(folder, { recursive: true });
  const oldName = `shared-${oid()}.webp`, newName = `replacement-${oid()}.webp`, failedName = `failed-${oid()}.webp`;
  await fs.writeFile(path.join(folder, oldName), "old");
  await fs.writeFile(path.join(folder, newName), "new");
  await fs.writeFile(path.join(folder, failedName), "failed");
  const sharedPath = `uploads/teamlogos/${oldName}`;
  await Team.updateMany({ _id: { $in: f.teams.slice(0, 2).map((team) => team._id) } }, { $set: { logo: sharedPath } });
  const result = response();
  await controller.updateTeam({ params: { teamId: String(f.teams[0]._id) }, body: {}, file: { filename: newName, path: path.join(folder, newName) } }, result);
  assert.equal(result.statusCode, 200, result.body?.message);
  assert.equal(await fs.readFile(path.join(folder, oldName), "utf8"), "old", "The other term or cloned team still references this logo.");
  const failed = response();
  await controller.updateTeam({ params: { teamId: String(f.teams[0]._id) }, body: { teamName: f.teams[1].teamName }, file: { filename: failedName, path: path.join(folder, failedName) } }, failed);
  assert.equal(failed.statusCode, 409);
  assert.equal((await Team.findById(f.teams[0]._id)).logo, `uploads/teamlogos/${newName}`);
  assert.equal(await fs.readFile(path.join(folder, newName), "utf8"), "new");
  await assert.rejects(fs.access(path.join(folder, failedName)), { code: "ENOENT" });
});


test("manual league statistics remain scoped and player team statistics persist after reload", async () => {
  const f = await setup();
  const teamId = String(f.teams[0]._id), leagueId = String(f.league._id);
  const changed = await call("updateLeagueTeamStatistics", { leagueId, teamId }, { won: 1, goalsFor: 2 });
  assert.equal(changed.statusCode, 200, changed.body?.message);
  const team = await Team.findById(teamId);
  assert.equal(team.statistics.played, 0, "League-specific updates must not corrupt global team statistics.");
  assert.equal(team.leagues[0].statistics.played, 1);
  assert.equal(team.leagues[0].statistics.points, 3);
  assert.equal((await Standing.findOne({ league: leagueId, team: teamId })).goalDifference, 2);
  assert.equal((await call("updateLeagueTeamStatistics", { leagueId, teamId }, { goalsFor: -1 })).statusCode, 400);
  const unrelated = await Team.create({ teamName: "Unenrolled team", term: f.term._id });
  assert.equal((await call("updateLeagueTeamStatistics", { leagueId, teamId: String(unrelated._id) }, { won: 1 })).statusCode, 400);
  assert.ok(!(await League.findById(leagueId)).teams.some((id) => String(id) === String(unrelated._id)));
  assert.equal((await call("updateTeamPlayerStatistics", { teamId, playerId: String(f.player._id) }, { goals: 2, appearances: 1 })).statusCode, 200);
  assert.equal((await Team.findById(teamId)).players[0].statistics.goals, 2);
});


const applyOptions = { apply: true, actor: "isolated-integration-test", backupReference: "disposable-database-fixture", confirmBackup: true, maintenanceConfirmed: true, batchSize: 1 };

test("production index gate rejects missing safeguards; migration dry run writes nothing and apply backfills repeat safely", async () => {
  const f = await setup();
  const legacyId = oid(), fixtureId = oid();
  await Team.collection.insertOne({ _id: legacyId, teamName: "Legacy Yellow", term: f.term._id });
  await League.updateOne({ _id: f.league._id }, { $push: { teams: legacyId } });
  await Fixture.collection.insertOne({ _id: fixtureId, league: f.league._id, round: 1, homeTeam: legacyId, awayTeam: f.teams[1]._id, field: "Field 1", kickoffTime: new Date("2026-10-26T07:00:00Z"), endTime: new Date("2026-10-26T08:00:00Z"), venue: "Stadium" });
  await assert.rejects(assertCriticalIndexes(), { code: "INTEGRITY_INDEX_GATE" });
  const collectionsBefore = (await mongoose.connection.db.listCollections({}, { nameOnly: true }).toArray()).map((collection) => collection.name).sort();
  const dry = await runIntegrityMigration();
  assert.equal(dry.mode, "DRY_RUN");
  assert.equal(dry.applied, false);
  assert.equal(dry.canApply, true, JSON.stringify(dry.issues));
  assert.equal((await Team.collection.findOne({ _id: legacyId })).normalizedName, undefined);
  assert.equal((await Fixture.collection.findOne({ _id: fixtureId })).participants, undefined);
  assert.deepEqual((await mongoose.connection.db.listCollections({}, { nameOnly: true }).toArray()).map((collection) => collection.name).sort(), collectionsBefore, "Dry run must not create collections or indexes.");
  const applied = await runIntegrityMigration(applyOptions);
  assert.equal(applied.applied, true, JSON.stringify(applied));
  assert.equal(applied.changed.teams, 1);
  assert.equal(applied.changed.fixtures, 1);
  assert.equal((await Team.collection.findOne({ _id: legacyId })).normalizedName, "legacy yellow");
  assert.deepEqual((await Fixture.collection.findOne({ _id: fixtureId })).participants.map(String), [String(legacyId), String(f.teams[1]._id)]);
  assert.equal((await assertCriticalIndexes()).ready, true);
  const firstAuditCount = await mongoose.connection.db.collection("integritymigrationchanges").countDocuments();
  const repeated = await runIntegrityMigration(applyOptions);
  assert.deepEqual(repeated.changed, { teams: 0, fixtures: 0 });
  assert.equal(await mongoose.connection.db.collection("integritymigrationchanges").countDocuments(), firstAuditCount);
  const run = await mongoose.connection.db.collection("integritymigrationruns").findOne({ _id: "league-integrity-v1" });
  assert.equal(run.status, "COMPLETE");
});

test("migration refuses duplicate legacy scopes without partial backfill, and removes global name index only when explicitly approved", async () => {
  const f = await setup();
  const duplicate = oid();
  await Team.collection.insertOne({ _id: duplicate, teamName: "TEAM 1", term: f.term._id });
  const conflict = await runIntegrityMigration(applyOptions);
  assert.equal(conflict.applied, false);
  assert.ok(conflict.issues.some((issue) => issue.type === "DUPLICATE_TEAM_NAME_IN_TERM"));
  assert.equal((await Team.collection.findOne({ _id: duplicate })).normalizedName, undefined);
  await Team.collection.deleteOne({ _id: duplicate });
  await Team.collection.createIndex({ teamName: 1 }, { unique: true, name: "legacy_global_team_name" });
  const blocked = await runIntegrityMigration(applyOptions);
  assert.equal(blocked.applied, false);
  assert.ok(blocked.issues.some((issue) => issue.type === "OBSOLETE_GLOBAL_TEAM_NAME_INDEX"));
  const reviewed = await runIntegrityMigration({ ...applyOptions, dropObsoleteTeamNameIndexes: true });
  assert.equal(reviewed.applied, true);
  assert.ok(!(await Team.collection.indexes()).some((index) => index.name === "legacy_global_team_name"));
  assert.equal((await assertCriticalIndexes()).ready, true);
  assert.ok(criticalIndexRequirements().length > 10);
});
