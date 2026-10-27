#!/usr/bin/env node
/** Explicit database migration. Never loads dotenv, application config, workers or delivery code.
 * Dry run: node scripts/migrate-integrity.js --uri-env INTEGRITY_MIGRATION_URI --database restored_coachmax
 * Apply also requires --apply --actor <operator> --backup-reference <restore-tested-backup>
 * --confirm-backup --maintenance-confirmed. All runtime writers must be stopped.
 */
const mongoose = require("mongoose");
// Prevent model compilation from auto-creating collections during a dry run.
// Only explicit migration apply may create collections or indexes.
mongoose.set("autoIndex", false);
mongoose.set("autoCreate", false);
const { randomUUID } = require("node:crypto");
const { normalizeTeamName } = require("../utils/leagueIntegrity");
const { preflight } = require("./league-integrity-preflight");
const { criticalIndexRequirements, inspectCriticalIndexes, createCriticalIndexes, assertCriticalIndexes } = require("../services/criticalIndexes");
const MIGRATION = "league-integrity-v1";
const inputError = (message) => Object.assign(new Error(message), { code: "MIGRATION_INPUT" });

function validateApply(options) {
  if (!options.apply) return;
  if (!String(options.actor || "").trim() || String(options.actor).length > 200) throw inputError("Apply requires an explicit operator identity via --actor.");
  if (!String(options.backupReference || "").trim() || String(options.backupReference).length > 300 || options.confirmBackup !== true) throw inputError("Apply requires --backup-reference and --confirm-backup for a tested restore.");
  if (options.maintenanceConfirmed !== true) throw inputError("Apply requires --maintenance-confirmed after stopping every application writer.");
}

function parseOptions(args, environment = process.env) {
  const output = { apply: false, batchSize: 250, confirmBackup: false, maintenanceConfirmed: false, dropObsoleteTeamNameIndexes: false };
  const flags = { "--apply": "apply", "--confirm-backup": "confirmBackup", "--maintenance-confirmed": "maintenanceConfirmed", "--drop-obsolete-team-name-indexes": "dropObsoleteTeamNameIndexes" };
  const values = { "--uri": "uri", "--uri-env": "uriEnvironment", "--database": "database", "--actor": "actor", "--backup-reference": "backupReference", "--batch-size": "batchSize" };
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flags[flag]) output[flags[flag]] = true;
    else if (values[flag]) {
      if (!args[index + 1] || args[index + 1].startsWith("--")) throw inputError(`A value is required for ${flag}.`);
      output[values[flag]] = args[++index];
    } else throw inputError("Unknown migration option. See the usage comment in scripts/migrate-integrity.js.");
  }
  if (output.uri && output.uriEnvironment) throw inputError("Choose --uri or --uri-env, not both.");
  if (output.uriEnvironment) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(output.uriEnvironment)) throw inputError("--uri-env must name an explicit environment variable.");
    output.uri = environment[output.uriEnvironment];
  }
  if (!output.uri || !/^mongodb(?:\+srv)?:\/\//.test(output.uri)) throw inputError("Provide an explicit MongoDB URI with --uri or --uri-env. Application MONGO_URI is never selected automatically.");
  if (!/^[A-Za-z0-9_-]{1,63}$/.test(output.database || "") || ["admin", "config", "local"].includes(output.database.toLowerCase())) throw inputError("--database must explicitly select an application database, not admin/config/local.");
  output.batchSize = Number(output.batchSize);
  if (!Number.isInteger(output.batchSize) || output.batchSize < 1 || output.batchSize > 1000) throw inputError("--batch-size must be an integer from 1 to 1000.");
  validateApply(output);
  return output;
}

async function duplicateIndexIssues(connection) {
  const issues = [];
  for (const requirement of criticalIndexRequirements().filter((index) => index.options.unique && !["Team", "Fixture", "Counter"].includes(index.model))) {
    const match = { ...(requirement.options.partialFilterExpression || {}) };
    if (requirement.options.sparse) Object.assign(match, { $or: Object.keys(requirement.key).map((field) => ({ [field]: { $exists: true } })) });
    const group = Object.fromEntries(Object.keys(requirement.key).map((field, index) => [`key${index}`, `$${field}`]));
    const duplicates = await connection.db.collection(requirement.collection).aggregate([{ $match: match }, { $group: { _id: group, count: { $sum: 1 }, firstId: { $first: "$_id" } } }, { $match: { count: { $gt: 1 } } }, { $limit: 1001 }, { $project: { _id: 0, count: 1, firstId: 1 } }], { allowDiskUse: true }).toArray();
    for (const duplicate of duplicates) issues.push({ type: "UNIQUE_INDEX_CONFLICT", collection: requirement.collection, key: requirement.key, firstId: String(duplicate.firstId), count: duplicate.count });
  }
  return issues;
}

async function inspectMigration(connection) {
  const Team = require("../models/Team"), Fixture = require("../models/Fixture"), League = require("../models/League"), Term = require("../models/Term");
  const [teams, fixtures, leagues, terms] = await Promise.all([
    connection.db.collection(Team.collection.collectionName).find({}, { projection: { teamName: 1, term: 1, normalizedName: 1 } }).toArray(),
    connection.db.collection(Fixture.collection.collectionName).find({}, { projection: { league: 1, round: 1, homeTeam: 1, awayTeam: 1, participants: 1, field: 1, kickoffTime: 1, endTime: 1 } }).toArray(),
    connection.db.collection(League.collection.collectionName).find({}, { projection: { term: 1, teams: 1, numberOfFields: 1, matchDuration: 1 } }).toArray(),
    connection.db.collection(Term.collection.collectionName).find({}, { projection: { _id: 1 } }).toArray(),
  ]);
  const report = preflight({ teams, fixtures, leagues });
  const termIds = new Set(terms.map((term) => String(term._id)));
  const leagueMap = new Map(leagues.map((league) => [String(league._id), league]));
  for (const row of [...teams.map((team) => ({ ...team, kind: "TEAM" })), ...leagues.map((league) => ({ ...league, kind: "LEAGUE" }))]) if (!mongoose.isValidObjectId(row.term) || !termIds.has(String(row.term))) report.issues.push({ type: `${row.kind}_TERM_NEEDS_REVIEW`, entity: String(row._id) });
  const fieldBookings = new Map();
  for (const fixture of fixtures) {
    const league = leagueMap.get(String(fixture.league));
    const kickoff = new Date(fixture.kickoffTime);
    const end = fixture.endTime ? new Date(fixture.endTime) : new Date(kickoff.getTime() + Number(league?.matchDuration || 90) * 60000);
    const field = /^Field ([1-9]\d*)$/.exec(String(fixture.field || ""));
    if (!Number.isInteger(fixture.round) || fixture.round < 1 || Number.isNaN(kickoff.getTime()) || Number.isNaN(end.getTime()) || end <= kickoff || !field || Number(field[1]) > Number(league?.numberOfFields || 1)) report.issues.push({ type: "FIXTURE_SCHEDULE_NEEDS_REVIEW", fixture: String(fixture._id) });
    else {
      const key = `${fixture.league}:${fixture.field}`;
      if (!fieldBookings.has(key)) fieldBookings.set(key, []);
      fieldBookings.get(key).push({ id: String(fixture._id), kickoff, end });
    }
  }
  for (const bookings of fieldBookings.values()) {
    bookings.sort((a, b) => a.kickoff - b.kickoff);
    let latest;
    for (const booking of bookings) {
      if (latest && booking.kickoff < latest.end) report.issues.push({ type: "OVERLAPPING_FIELD_BOOKINGS", fixtures: [latest.id, booking.id] });
      if (!latest || booking.end > latest.end) latest = booking;
    }
  }
  report.issues.push(...await duplicateIndexIssues(connection));
  const indexState = await inspectCriticalIndexes({ connection });
  report.canApply = report.issues.length === 0;
  return { teams, fixtures, report, indexState };
}

const beforeValue = (row, field) => Object.prototype.hasOwnProperty.call(row, field) ? row[field] : { $exists: false };

async function backfillBatches(connection, collection, changes, { batchSize, actor, backupReference, runId }) {
  for (let offset = 0; offset < changes.length; offset += batchSize) {
    const batch = changes.slice(offset, offset + batchSize);
    const session = await connection.startSession();
    try {
      await session.withTransaction(async () => {
        await connection.db.collection("integritymigrationchanges").bulkWrite(batch.map((change) => ({ updateOne: { filter: { _id: `${MIGRATION}:${collection}:${change.id}` }, update: { $setOnInsert: { migration: MIGRATION, collection, entity: change.id, before: change.before, after: change.after, actor, backupReference, runId, recordedAt: new Date() } }, upsert: true } })), { session });
        const result = await connection.db.collection(collection).bulkWrite(batch.map((change) => ({ updateOne: { filter: change.filter, update: { $set: change.after } } })), { session, ordered: true });
        if (result.matchedCount !== batch.length) throw inputError("Records changed during migration. Keep writers stopped, inspect the audit trail and rerun a dry run.");
      });
    } finally { await session.endSession(); }
  }
}

async function runIntegrityMigration({ connection = mongoose.connection, apply = false, actor, backupReference, confirmBackup = false, maintenanceConfirmed = false, batchSize = 250, dropObsoleteTeamNameIndexes = false } = {}) {
  const options = { apply, actor, backupReference, confirmBackup, maintenanceConfirmed, batchSize, dropObsoleteTeamNameIndexes };
  validateApply(options);
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1000) throw inputError("Batch size must be an integer from 1 to 1000.");
  const state = await inspectMigration(connection);
  const obsolete = state.indexState.obsoleteTeamNameIndexes;
  if (obsolete.length && !dropObsoleteTeamNameIndexes) state.report.issues.push({ type: "OBSOLETE_GLOBAL_TEAM_NAME_INDEX", indexes: obsolete, action: "Review and explicitly allow --drop-obsolete-team-name-indexes after the scoped index is built." });
  const output = { migration: MIGRATION, mode: apply ? "APPLY" : "DRY_RUN", canApply: state.report.issues.length === 0, applied: false, counts: state.report.counts, issues: state.report.issues, indexes: state.indexState };
  if (!apply || !output.canApply) return output;
  const runId = randomUUID();
  const runs = connection.db.collection("integritymigrationruns");
  await runs.updateOne({ _id: MIGRATION }, { $set: { status: "APPLYING", actor, backupReference, runId, startedAt: new Date() }, $inc: { attempts: 1 } }, { upsert: true });
  try {
    const teamCollection = require("../models/Team").collection.collectionName;
    const fixtureCollection = require("../models/Fixture").collection.collectionName;
    const teamChanges = state.teams.filter((team) => team.normalizedName !== normalizeTeamName(team.teamName)).map((team) => ({ id: team._id, before: { hadNormalizedName: Object.prototype.hasOwnProperty.call(team, "normalizedName"), normalizedName: team.normalizedName ?? null }, after: { normalizedName: normalizeTeamName(team.teamName) }, filter: { _id: team._id, teamName: team.teamName, term: team.term, normalizedName: beforeValue(team, "normalizedName") } }));
    const fixtureChanges = state.fixtures.filter((fixture) => JSON.stringify((fixture.participants || []).map(String)) !== JSON.stringify([String(fixture.homeTeam), String(fixture.awayTeam)])).map((fixture) => ({ id: fixture._id, before: { hadParticipants: Object.prototype.hasOwnProperty.call(fixture, "participants"), participants: fixture.participants ?? null }, after: { participants: [fixture.homeTeam, fixture.awayTeam] }, filter: { _id: fixture._id, league: fixture.league, round: fixture.round, homeTeam: fixture.homeTeam, awayTeam: fixture.awayTeam, participants: beforeValue(fixture, "participants") } }));
    await backfillBatches(connection, teamCollection, teamChanges, { ...options, runId });
    await backfillBatches(connection, fixtureCollection, fixtureChanges, { ...options, runId });
    await createCriticalIndexes({ connection });
    if (dropObsoleteTeamNameIndexes) for (const index of obsolete) await connection.db.collection(teamCollection).dropIndex(index.name);
    output.indexes = await assertCriticalIndexes({ connection });
    output.applied = true;
    output.changed = { teams: teamChanges.length, fixtures: fixtureChanges.length };
    await runs.updateOne({ _id: MIGRATION, runId }, { $set: { status: "COMPLETE", completedAt: new Date(), changed: output.changed } });
    return output;
  } catch (error) {
    await runs.updateOne({ _id: MIGRATION, runId }, { $set: { status: "FAILED", failedAt: new Date(), failureCode: String(error.code || error.name) } });
    throw error;
  }
}

async function main(args = process.argv.slice(2), environment = process.env) {
  const options = parseOptions(args, environment);
  mongoose.set("autoIndex", false);
  await mongoose.connect(options.uri, { dbName: options.database, autoIndex: false, serverSelectionTimeoutMS: 15000 });
  try { return await runIntegrityMigration(options); }
  finally { await mongoose.disconnect(); }
}

if (require.main === module) main().then((report) => { process.stdout.write(JSON.stringify(report, null, 2) + "\n"); if (!report.canApply) process.exitCode = 2; }).catch((error) => {
  // Driver errors can embed connection strings. Only our own input messages are safe to print.
  console.error(error.code === "MIGRATION_INPUT" ? error.message : `Integrity migration failed (${String(error.code || error.name)}). Review the migration run record and database diagnostics securely.`);
  process.exitCode = 1;
});
module.exports = { MIGRATION, validateApply, parseOptions, duplicateIndexIssues, inspectMigration, runIntegrityMigration, main };
