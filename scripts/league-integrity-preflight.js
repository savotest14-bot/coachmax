#!/usr/bin/env node
// Offline only: never loads .env, opens a database or changes source records.
// node scripts/league-integrity-preflight.js path/to/staging-export.json
// Input: { teams: [...], fixtures: [...], leagues: [...] } (JSON or mongoexport IDs).
const fs = require("node:fs");
const { normalizeTeamName } = require("../utils/leagueIntegrity");
const id = (value) => String(value?._id?.$oid || value?._id || value?.$oid || value || "");

function preflight({ teams = [], fixtures = [], leagues = [] }) {
  const issues = [];
  const teamKeys = new Map();
  const teamMap = new Map(teams.map((team) => [id(team), team]));
  const leagueMap = new Map(leagues.map((league) => [id(league), league]));
  const roundKeys = new Map();
  const teamUpdates = [], fixtureUpdates = [];
  for (const team of teams) {
    const normalizedName = normalizeTeamName(team.teamName);
    if (!id(team.term) || !normalizedName) issues.push({ type: "TEAM_SCOPE_MISSING", team: id(team) });
    const key = `${id(team.term)}:${normalizedName}`;
    if (teamKeys.has(key)) issues.push({ type: "DUPLICATE_TEAM_NAME_IN_TERM", teams: [teamKeys.get(key), id(team)], term: id(team.term) });
    teamKeys.set(key, id(team));
    if (team.normalizedName !== normalizedName) teamUpdates.push({ updateOne: { filter: { _id: id(team) }, update: { $set: { normalizedName } } } });
  }
  for (const fixture of fixtures) {
    const participants = [id(fixture.homeTeam), id(fixture.awayTeam)];
    const league = leagueMap.get(id(fixture.league));
    if (!league) issues.push({ type: "MISSING_LEAGUE", fixture: id(fixture) });
    for (const participant of participants) {
      const key = `${id(fixture.league)}:${fixture.round}:${participant}`;
      if (roundKeys.has(key)) issues.push({ type: "TEAM_REPEATED_IN_ROUND", team: participant, fixtures: [roundKeys.get(key), id(fixture)], round: fixture.round });
      roundKeys.set(key, id(fixture));
      const team = teamMap.get(participant);
      if (!team) issues.push({ type: "MISSING_TEAM", fixture: id(fixture), team: participant });
      else if (league && id(league.term) !== id(team.term)) issues.push({ type: "CROSS_TERM_REFERENCE", fixture: id(fixture), team: participant });
      if (league && !(league.teams || []).some((teamId) => id(teamId) === participant)) issues.push({ type: "UNENROLLED_TEAM", fixture: id(fixture), team: participant });
    }
    if (JSON.stringify((fixture.participants || []).map(id)) !== JSON.stringify(participants)) fixtureUpdates.push({ updateOne: { filter: { _id: id(fixture) }, update: { $set: { participants } } } });
  }
  return { migration: "league-integrity-v1", mode: "OFFLINE_DRY_RUN", canApply: issues.length === 0, counts: { teams: teams.length, fixtures: fixtures.length, leagues: leagues.length, teamUpdates: teamUpdates.length, fixtureUpdates: fixtureUpdates.length }, issues, teamUpdates, fixtureUpdates, requiredIndexes: ["team_term_normalized_name", "fixture_team_once_per_round"], deployment: "Resolve every issue in a restored staging database. Convert string IDs in this plan to ObjectIds. Backfill in bounded idempotent batches before explicitly building indexes. Keep backups and original IDs; do not shift dates or delete historical records." };
}

if (require.main === module) {
  const input = process.argv[2];
  if (!input) { console.error("Usage: node scripts/league-integrity-preflight.js exported-data.json"); process.exitCode = 1; }
  else {
    const report = preflight(JSON.parse(fs.readFileSync(input, "utf8")));
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    if (!report.canApply) process.exitCode = 2;
  }
}
module.exports = { preflight };
