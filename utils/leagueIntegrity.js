// Pure domain rules shared by controllers, generation, tests and migration preflight.
const normalizeTeamName = (name) => String(name || "").normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en");
const entityId = (value) => String(value?._id || value || "");
const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const domainError = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });

function assertTeamLeagueScope(league, teams, requireEnrollment = true) {
  const enrolled = new Set((league.teams || []).map(entityId));
  for (const team of teams) {
    if (!team || team.archivedAt) throw domainError("Selected team is unavailable.");
    if (league.term && entityId(league.term) !== entityId(team.term)) throw domainError("Every team must belong to the league's selected term.");
    if (requireEnrollment && !enrolled.has(entityId(team))) throw domainError("Enroll both teams into this league before scheduling a match.");
  }
}

function validateFixtureSchedule(league, input) {
  const round = Number(input.round);
  if (!Number.isInteger(round) || round < 1 || round > Number(league.numberOfRounds || 1)) throw domainError("Round must be an integer within this league's configured rounds.");
  const kickoffTime = new Date(input.kickoffTime);
  if (Number.isNaN(kickoffTime.getTime())) throw domainError("A valid kickoff date and time is required.");
  const endTime = input.endTime ? new Date(input.endTime) : new Date(kickoffTime.getTime() + Number(league.matchDuration || 90) * 60000);
  if (Number.isNaN(endTime.getTime()) || endTime <= kickoffTime) throw domainError("End time must be after kickoff time.");
  const field = String(input.field || "").trim();
  const number = /^Field\s+(\d+)$/i.exec(field);
  if (!number || Number(number[1]) < 1 || Number(number[1]) > Number(league.numberOfFields || 1)) throw domainError("Select a field configured for this league.");
  return { round, kickoffTime, endTime, field: `Field ${Number(number[1])}` };
}

function assertRoundParticipants(fixtures) {
  const used = new Set();
  for (const fixture of fixtures) {
    for (const team of [fixture.homeTeam, fixture.awayTeam]) {
      const key = `${entityId(fixture.league)}:${fixture.round}:${entityId(team)}`;
      if (used.has(key)) throw domainError("A team can only be scheduled once per round.", 409);
      used.add(key);
    }
  }
}
const PLAYER_STAT_KEYS = ["goals", "assists", "appearances", "minutesPlayed", "cleanSheets", "yellowCards", "redCards"];
function playerContributions(fixture) {
  const result = {};
  if (fixture.status !== "COMPLETED") return result;
  for (const row of fixture.resultPlayers || []) {
    result[entityId(row.player)] = Object.fromEntries(PLAYER_STAT_KEYS.map((key) => [key, Number(row[key] || 0)]));
  }
  if (fixture.goals?.length) {
    for (const value of Object.values(result)) { value.goals = 0; value.assists = 0; }
    for (const goal of fixture.goals) {
      for (const [player, key] of [[goal.scorer, "goals"], [goal.assist, "assists"]]) {
        if (!player) continue;
        const id = entityId(player);
        result[id] ||= Object.fromEntries(PLAYER_STAT_KEYS.map((key) => [key, 0]));
        result[id][key] += 1;
      }
    }
  }
  return result;
}
function contributionDeltas(before, after) {
  const oldStats = playerContributions(before), newStats = playerContributions(after);
  return Object.fromEntries([...new Set([...Object.keys(oldStats), ...Object.keys(newStats)])].map((id) => [id, Object.fromEntries(PLAYER_STAT_KEYS.map((key) => [key, (newStats[id]?.[key] || 0) - (oldStats[id]?.[key] || 0)]))]).filter(([, stats]) => Object.values(stats).some(Boolean)));
}
module.exports = { normalizeTeamName, entityId, escapeRegex, domainError, assertTeamLeagueScope, validateFixtureSchedule, assertRoundParticipants, PLAYER_STAT_KEYS, playerContributions, contributionDeltas };
