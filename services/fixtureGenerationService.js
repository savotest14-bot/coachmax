const mongoose = require("mongoose");
const Fixture = require("../models/Fixture");
const Standing = require("../models/Standing");
const League = require("../models/League");
const Team = require("../models/Team");

/**
 * Parses any date format (YYYY-MM-DD, DD-MM-YYYY, ISO) to a Date at UTC midnight.
 */
function parseDateToMidnight(input) {
  if (!input) return null;
  if (input instanceof Date && !isNaN(input.getTime())) {
    const d = new Date(input);
    d.setUTCHours(0, 0, 0, 0);
    return d;
  }
  const str = String(input).trim();
  // Check DD-MM-YYYY or DD/MM/YYYY
  const dmyMatch = str.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (dmyMatch) {
    const day = parseInt(dmyMatch[1], 10);
    const month = parseInt(dmyMatch[2], 10);
    const year = parseInt(dmyMatch[3], 10);
    return new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
  }
  // Check YYYY-MM-DD
  const ymdMatch = str.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (ymdMatch) {
    const year = parseInt(ymdMatch[1], 10);
    const month = parseInt(ymdMatch[2], 10);
    const day = parseInt(ymdMatch[3], 10);
    return new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
  }
  const parsed = new Date(str);
  if (!isNaN(parsed.getTime())) {
    parsed.setUTCHours(0, 0, 0, 0);
    return parsed;
  }
  return null;
}

/**
 * Validates tournament and scheduling configuration.
 */
function validateTournamentConfig(params) {
  const {
    teams,
    fixtureFormat = "ROUND_ROBIN",
    groupCount = 1,
    numberOfRounds = 1,
    matchDuration = 90,
    breakBetweenMatches = 15,
    numberOfFields = 1,
    startTime = "10:00",
    startDate,
    endDate,
  } = params;

  // 1. Teams validation
  if (!Array.isArray(teams) || teams.length < 2) {
    return {
      isValid: false,
      message: "At least 2 valid teams are required to generate league fixtures.",
    };
  }

  const rawIds = teams.map((id) => (id ? id.toString().trim() : ""));
  const invalidId = rawIds.find((id) => !mongoose.Types.ObjectId.isValid(id));
  if (invalidId) {
    return {
      isValid: false,
      message: `Invalid team ID format: "${invalidId}". All team IDs must be valid MongoDB ObjectIds.`,
    };
  }

  const uniqueIds = new Set(rawIds);
  if (uniqueIds.size !== rawIds.length) {
    return {
      isValid: false,
      message: "Duplicate team IDs detected in league team selection.",
    };
  }

  // 2. Format validation
  const validFormats = ["ROUND_ROBIN", "GROUP", "KNOCKOUT"];
  const parsedFormat = (fixtureFormat || "ROUND_ROBIN").toString().toUpperCase().trim();
  if (!validFormats.includes(parsedFormat)) {
    return {
      isValid: false,
      message: `Invalid fixtureFormat "${fixtureFormat}". Supported formats are: ${validFormats.join(", ")}.`,
    };
  }

  // 3. Group count validation
  const parsedGroupCount = groupCount !== undefined && groupCount !== null ? parseInt(groupCount, 10) : 1;
  if (isNaN(parsedGroupCount) || parsedGroupCount < 1) {
    return {
      isValid: false,
      message: "groupCount must be at least 1.",
    };
  }

  if (parsedFormat === "GROUP") {
    if (parsedGroupCount > rawIds.length) {
      return {
        isValid: false,
        message: `groupCount (${parsedGroupCount}) cannot be greater than the number of teams (${rawIds.length}).`,
      };
    }
    if (parsedGroupCount > 1 && rawIds.length < parsedGroupCount * 2) {
      return {
        isValid: false,
        message: `Each group must contain at least 2 teams. For ${parsedGroupCount} groups, at least ${parsedGroupCount * 2} teams are required, but received ${rawIds.length}.`,
      };
    }
  }

  // 4. Number of rounds
  const parsedNumberOfRounds =
    numberOfRounds !== undefined && numberOfRounds !== null ? parseInt(numberOfRounds, 10) : 1;
  if (isNaN(parsedNumberOfRounds) || parsedNumberOfRounds < 1) {
    return {
      isValid: false,
      message: "numberOfRounds must be at least 1.",
    };
  }

  // 5. Match duration
  const parsedMatchDuration =
    matchDuration !== undefined && matchDuration !== null ? Number(matchDuration) : 90;
  if (isNaN(parsedMatchDuration) || parsedMatchDuration <= 0) {
    return {
      isValid: false,
      message: "matchDuration must be greater than 0 minutes.",
    };
  }

  // 6. Break between matches
  const parsedBreak =
    breakBetweenMatches !== undefined && breakBetweenMatches !== null ? Number(breakBetweenMatches) : 15;
  if (isNaN(parsedBreak) || parsedBreak < 0) {
    return {
      isValid: false,
      message: "breakBetweenMatches must be 0 or greater.",
    };
  }

  // 7. Number of fields
  const parsedFields =
    numberOfFields !== undefined && numberOfFields !== null ? parseInt(numberOfFields, 10) : 1;
  if (isNaN(parsedFields) || parsedFields < 1) {
    return {
      isValid: false,
      message: "numberOfFields must be at least 1.",
    };
  }

  // 8. Start time validation (HH:mm)
  const timeRegex = /^([01]\d|2[0-3]):[0-5]\d$/;
  const parsedStartTime = (startTime || "10:00").toString().trim();
  if (!timeRegex.test(parsedStartTime)) {
    return {
      isValid: false,
      message: `Invalid startTime "${startTime}". Must be in 24-hour HH:mm format (e.g. "10:00" or "14:30").`,
    };
  }

  // 9. Dates validation
  const parsedStartDate = parseDateToMidnight(startDate);
  const parsedEndDate = parseDateToMidnight(endDate);
  if (!parsedStartDate || !parsedEndDate) {
    return {
      isValid: false,
      message: "Valid startDate and endDate are required.",
    };
  }
  if (parsedEndDate < parsedStartDate) {
    return {
      isValid: false,
      message: "endDate cannot be earlier than startDate.",
    };
  }

  return {
    isValid: true,
    normalized: {
      teamIds: rawIds,
      fixtureFormat: parsedFormat,
      groupCount: parsedFormat === "ROUND_ROBIN" ? 1 : parsedGroupCount,
      numberOfRounds: parsedNumberOfRounds,
      matchDuration: parsedMatchDuration,
      breakBetweenMatches: parsedBreak,
      numberOfFields: parsedFields,
      startTime: parsedStartTime,
      startDate: parsedStartDate,
      endDate: parsedEndDate,
    },
  };
}

/**
 * Fisher-Yates array shuffle.
 */
function shuffleArray(array) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Deterministically distributes teams into groups, with optional randomization.
 */
function distributeTeamsIntoGroups(teamIds, groupCount, randomize = false) {
  const workingTeams = randomize ? shuffleArray(teamIds) : [...teamIds];

  if (groupCount <= 1) {
    return [{ name: "Group A", teams: workingTeams }];
  }

  const groups = Array.from({ length: groupCount }, (_, i) => ({
    name: `Group ${String.fromCharCode(65 + i)}`,
    teams: [],
  }));

  for (let i = 0; i < workingTeams.length; i++) {
    groups[i % groupCount].teams.push(workingTeams[i]);
  }

  return groups;
}

/**
 * Standard circle / Berger algorithm to generate round-robin pairings for a list of teams.
 * Supports even and odd team counts (virtual BYE).
 * For multiple cycles (numberOfRounds >= 2), inverts home and away in even cycles (cycle 2, 4...).
 * Supports optional schedule randomization while strictly preserving tournament validity.
 */
function generateRoundRobinPairings(teamIds, numberOfRounds = 1, groupName = "", randomize = false) {
  const n = teamIds.length;
  if (n < 2) {
    return { rounds: [], byes: [], roundsPerCycle: 0, totalMatches: 0 };
  }

  const workingTeams = randomize ? shuffleArray(teamIds) : [...teamIds];
  const isOdd = n % 2 !== 0;
  // If odd, append null as a sentinel for BYE
  const circle = isOdd ? [...workingTeams, null] : [...workingTeams];
  const m = circle.length;
  const roundsPerCycle = m - 1;
  const matchesPerRound = m / 2;

  const rounds = [];
  const byes = [];
  let totalMatches = 0;

  // 1. Generate Base Cycle (Cycle 0)
  const baseRounds = [];
  const baseByes = [];

  let fixed = circle[0];
  let rotating = circle.slice(1);

  for (let r = 0; r < roundsPerCycle; r++) {
    const currentRoundList = [fixed, ...rotating];
    let matchesInThisRound = [];

    for (let p = 0; p < matchesPerRound; p++) {
      const team1 = currentRoundList[p];
      const team2 = currentRoundList[m - 1 - p];

      if (team1 === null) {
        if (team2 !== null) {
          baseByes.push({ roundInCycle: r + 1, team: team2 });
        }
        continue;
      }
      if (team2 === null) {
        baseByes.push({ roundInCycle: r + 1, team: team1 });
        continue;
      }

      // Determine home and away.
      // Balance home/away across rounds:
      let homeTeam;
      let awayTeam;
      if (p === 0) {
        if (r % 2 === 0) {
          homeTeam = team1;
          awayTeam = team2;
        } else {
          homeTeam = team2;
          awayTeam = team1;
        }
      } else {
        if ((p + r) % 2 === 0) {
          homeTeam = team1;
          awayTeam = team2;
        } else {
          homeTeam = team2;
          awayTeam = team1;
        }
      }

      // When randomized, randomly flip initial home/away in cycle 0
      if (randomize && Math.random() < 0.5) {
        const temp = homeTeam;
        homeTeam = awayTeam;
        awayTeam = temp;
      }

      matchesInThisRound.push({
        homeTeam,
        awayTeam,
        group: groupName,
      });
    }

    if (randomize) {
      matchesInThisRound = shuffleArray(matchesInThisRound);
    }

    baseRounds.push(matchesInThisRound);

    // Rotate: shift last element of rotating to front
    rotating = [rotating[rotating.length - 1], ...rotating.slice(0, rotating.length - 1)];
  }

  // 2. Expand across numberOfRounds cycles
  // In return cycles (odd cycle index, i.e. cycle 1, 3...), invert home and away
  for (let cycle = 0; cycle < numberOfRounds; cycle++) {
    for (let r = 0; r < roundsPerCycle; r++) {
      const overallRoundNumber = cycle * roundsPerCycle + r + 1;
      const baseMatches = baseRounds[r];
      const matchesInThisRound = baseMatches.map((m) => {
        if (cycle % 2 === 1) {
          return {
            round: overallRoundNumber,
            homeTeam: m.awayTeam,
            awayTeam: m.homeTeam,
            group: m.group,
            cycle: cycle + 1,
          };
        } else {
          return {
            round: overallRoundNumber,
            homeTeam: m.homeTeam,
            awayTeam: m.awayTeam,
            group: m.group,
            cycle: cycle + 1,
          };
        }
      });

      rounds.push({
        roundNumber: overallRoundNumber,
        group: groupName,
        matches: matchesInThisRound,
      });

      totalMatches += matchesInThisRound.length;

      const byeForThisRound = baseByes.find((b) => b.roundInCycle === r + 1);
      if (byeForThisRound) {
        byes.push({
          round: overallRoundNumber,
          team: byeForThisRound.team,
          group: groupName,
        });
      }
    }
  }

  return { rounds, byes, roundsPerCycle, totalMatches };
}

/**
 * Schedules logical fixtures across available date range, daily time slots, and fields.
 */
function scheduleFixturesAcrossSlotsAndFields(params) {
  const {
    roundMatchesMap, // Map of roundNumber -> Array of matches across all groups
    maxRounds,
    numberOfFields,
    matchDuration,
    breakBetweenMatches,
    startTime,
    startDate,
    endDate,
    venueName = "",
  } = params;

  const [startHour, startMinute] = startTime.split(":").map(Number);
  const slotDurationMinutes = matchDuration + breakBetweenMatches;

  // Calculate available calendar days
  const msPerDay = 24 * 60 * 60 * 1000;
  const totalDays = Math.round((endDate.getTime() - startDate.getTime()) / msPerDay) + 1;

  // Calculate max slots that can fit on any single day from startTime until 23:59:59
  // A match must finish before midnight on that day.
  const minutesFromStartOfDay = startHour * 60 + startMinute;
  const minutesUntilMidnight = 24 * 60 - minutesFromStartOfDay;
  // Last match starts at slot S, ends at S + matchDuration <= minutesUntilMidnight
  const maxSlotsPerDay = Math.max(
    1,
    Math.floor((minutesUntilMidnight - matchDuration) / slotDurationMinutes) + 1
  );

  const scheduledFixtures = [];

  // Determine day distribution strategy:
  // If totalDays >= maxRounds: each round starts on its own day starting at startTime.
  // If totalDays < maxRounds: pack rounds sequentially across available days.
  const spreadOneRoundPerDay = totalDays >= maxRounds;

  let currentDayIndex = 0;
  let currentSlotIndex = 0;

  for (let r = 1; r <= maxRounds; r++) {
    const matchesInRound = roundMatchesMap.get(r) || [];
    if (matchesInRound.length === 0) continue;

    if (spreadOneRoundPerDay) {
      // Round r starts on day (r - 1)
      currentDayIndex = r - 1;
      currentSlotIndex = 0;
    }

    // Schedule matches in this round.
    // Within a round, all matches have distinct teams (per group).
    // Matches can run concurrently on up to `numberOfFields` fields.
    let matchIdx = 0;
    while (matchIdx < matchesInRound.length) {
      // If current slot doesn't fit on current day, advance day
      if (currentSlotIndex >= maxSlotsPerDay) {
        currentDayIndex++;
        currentSlotIndex = 0;
      }

      // Check if currentDayIndex exceeds totalDays
      if (currentDayIndex >= totalDays) {
        throw new Error(
          `Generated fixtures cannot fit inside the available date range (${totalDays} day${
            totalDays > 1 ? "s" : ""
          } between ${startDate.toISOString().slice(0, 10)} and ${endDate
            .toISOString()
            .slice(
              0,
              10
            )}). Total match slots required exceed the capacity across ${numberOfFields} field(s) with match duration ${matchDuration}m and break ${breakBetweenMatches}m.`
        );
      }

      const matchDate = new Date(startDate.getTime() + currentDayIndex * msPerDay);
      const slotStartMinutes = minutesFromStartOfDay + currentSlotIndex * slotDurationMinutes;
      const slotHour = Math.floor(slotStartMinutes / 60);
      const slotMin = slotStartMinutes % 60;

      const kickoffTime = new Date(
        Date.UTC(
          matchDate.getUTCFullYear(),
          matchDate.getUTCMonth(),
          matchDate.getUTCDate(),
          slotHour,
          slotMin,
          0,
          0
        )
      );

      const endTime = new Date(kickoffTime.getTime() + matchDuration * 60 * 1000);

      // Assign up to numberOfFields matches to this time slot
      for (let f = 1; f <= numberOfFields && matchIdx < matchesInRound.length; f++) {
        const match = matchesInRound[matchIdx];
        const fieldName = `Field ${f}`;
        const venueDisplay = venueName ? `${venueName} (${fieldName})` : fieldName;

        scheduledFixtures.push({
          round: match.round,
          group: match.group || "",
          homeTeam: match.homeTeam,
          awayTeam: match.awayTeam,
          kickoffTime,
          endTime,
          field: fieldName,
          venue: venueDisplay,
          status: "SCHEDULED",
        });

        matchIdx++;
      }

      // Advance to next slot
      currentSlotIndex++;
    }
  }

  return {
    scheduledFixtures,
    totalRounds: maxRounds,
    daysUsed: currentDayIndex + 1,
  };
}

/**
 * High-level orchestrator: generates, validates, schedules, and persists all fixtures & standings.
 */
async function generateAndSaveLeagueFixtures({ league, teams, config = {}, session = null }) {
  const {
    fixtureFormat = "ROUND_ROBIN",
    groupCount = 1,
    numberOfRounds = 1,
    matchDuration = 90,
    breakBetweenMatches = 15,
    numberOfFields = 1,
    startTime = "10:00",
    startDate,
    endDate,
    venue = "",
  } = config;

  // 1. Validate configuration
  const validation = validateTournamentConfig({
    teams,
    fixtureFormat,
    groupCount,
    numberOfRounds,
    matchDuration,
    breakBetweenMatches,
    numberOfFields,
    startTime,
    startDate: startDate || league.startDate,
    endDate: endDate || league.endDate,
  });

  if (!validation.isValid) {
    const error = new Error(validation.message);
    error.statusCode = 400;
    throw error;
  }

  const norm = validation.normalized;

  // 2. Distribute teams into groups
  const groups = distributeTeamsIntoGroups(norm.teamIds, norm.groupCount);

  // 3. Generate round-robin pairings for each group
  const roundMatchesMap = new Map();
  let maxRounds = 0;
  const allByes = [];

  for (const group of groups) {
    const groupPairings = generateRoundRobinPairings(
      group.teams,
      norm.numberOfRounds,
      norm.groupCount > 1 ? group.name : ""
    );

    allByes.push(...groupPairings.byes);

    for (const roundData of groupPairings.rounds) {
      const rNum = roundData.roundNumber;
      if (!roundMatchesMap.has(rNum)) {
        roundMatchesMap.set(rNum, []);
      }
      roundMatchesMap.get(rNum).push(...roundData.matches);
      if (rNum > maxRounds) maxRounds = rNum;
    }
  }

  // 4. Schedule fixtures across fields, slots, and calendar dates
  const schedulingResult = scheduleFixturesAcrossSlotsAndFields({
    roundMatchesMap,
    maxRounds,
    numberOfFields: norm.numberOfFields,
    matchDuration: norm.matchDuration,
    breakBetweenMatches: norm.breakBetweenMatches,
    startTime: norm.startTime,
    startDate: norm.startDate,
    endDate: norm.endDate,
    venueName: venue || league.name || "",
  });

  const fixtureDocsToCreate = schedulingResult.scheduledFixtures.map((f) => ({
    ...f,
    league: league._id,
  }));

  // 5. Batch insert fixtures
  const insertOptions = session ? { session } : {};
  const createdFixtures = await Fixture.insertMany(fixtureDocsToCreate, insertOptions);

  // 6. Initialize Standings for all participating teams
  const standingOps = [];
  for (const group of groups) {
    for (const tId of group.teams) {
      standingOps.push({
        updateOne: {
          filter: { league: league._id, team: tId },
          update: {
            $setOnInsert: {
              league: league._id,
              team: tId,
              group: norm.groupCount > 1 ? group.name : "",
              played: 0,
              won: 0,
              drawn: 0,
              lost: 0,
              goalsFor: 0,
              goalsAgainst: 0,
              goalDifference: 0,
              points: 0,
            },
          },
          upsert: true,
        },
      });
    }
  }

  if (standingOps.length > 0) {
    await Standing.bulkWrite(standingOps, insertOptions);
  }

  // 7. Update League document with groups and fixtureGenerated flag
  league.groups = groups.map((g) => ({
    name: g.name,
    teams: g.teams,
  }));
  league.fixtureGenerated = true;
  league.fixtureFormat = norm.fixtureFormat;
  league.groupCount = norm.groupCount;
  league.numberOfRounds = norm.numberOfRounds;
  league.matchDuration = norm.matchDuration;
  league.breakBetweenMatches = norm.breakBetweenMatches;
  league.numberOfFields = norm.numberOfFields;
  league.startTime = norm.startTime;

  if (session) {
    await league.save({ session });
  } else {
    await league.save();
  }

  return {
    groupsCreated: groups.length,
    groups: league.groups,
    teamsCount: norm.teamIds.length,
    roundsCreated: schedulingResult.totalRounds,
    fixturesCreated: createdFixtures.length,
    fixtures: createdFixtures,
    byes: allByes,
    daysUsed: schedulingResult.daysUsed,
  };
}

/**
 * Reconciles and updates an existing league's fixture schedule.
 * - Randomizes team pairings, round sequence, and home/away matches.
 * - Updates existing fixture records in-place without creating duplicate records.
 * - Preserves existing manual modifications (unless forceRegenerate is true).
 * - PROTECTS completed match results (throws error if completed matches would be damaged).
 */
async function reconcileAndSaveLeagueFixtures({
  league,
  teams,
  config = {},
  randomize = true,
  forceRegenerate = false,
  session = null,
}) {
  const {
    fixtureFormat = league.fixtureFormat || "ROUND_ROBIN",
    groupCount = league.groupCount || 1,
    numberOfRounds = league.numberOfRounds || 1,
    matchDuration = league.matchDuration || 90,
    breakBetweenMatches = league.breakBetweenMatches !== undefined ? league.breakBetweenMatches : 15,
    numberOfFields = league.numberOfFields || 1,
    startTime = league.startTime || "10:00",
    startDate = league.startDate,
    endDate = league.endDate,
    venue = "",
  } = config;

  const targetTeams = teams || league.teams || [];

  // 1. Validate tournament configuration
  const validation = validateTournamentConfig({
    teams: targetTeams,
    fixtureFormat,
    groupCount,
    numberOfRounds,
    matchDuration,
    breakBetweenMatches,
    numberOfFields,
    startTime,
    startDate,
    endDate,
  });

  if (!validation.isValid) {
    const error = new Error(validation.message);
    error.statusCode = 400;
    throw error;
  }

  const norm = validation.normalized;

  const selectedRound =
    config.round !== undefined && config.round !== null && config.round !== ""
      ? parseInt(config.round, 10)
      : (config.targetRound !== undefined && config.targetRound !== null && config.targetRound !== ""
          ? parseInt(config.targetRound, 10)
          : null);

  // 2. Fetch all existing fixtures for this league
  const existingFixtures = await Fixture.find({ league: league._id }).sort({
    round: 1,
    kickoffTime: 1,
    _id: 1,
  });

  // 3. Safety check: Protect any completed or in-progress fixtures
  const protectedFixtures = existingFixtures.filter((f) => {
    if (selectedRound !== null && f.round !== selectedRound) return false;
    const hasScore =
      (f.score?.homeScore !== undefined && f.score.homeScore > 0) ||
      (f.score?.awayScore !== undefined && f.score.awayScore > 0);
    const hasEvents = Array.isArray(f.events) && f.events.length > 0;
    const hasRatings = Array.isArray(f.playerRatings) && f.playerRatings.length > 0;
    const hasSubs = Array.isArray(f.substitutions) && f.substitutions.length > 0;
    const isLiveOrDone = f.status === "COMPLETED" || f.status === "LIVE";
    return isLiveOrDone || hasScore || hasEvents || hasRatings || hasSubs;
  });

  if (protectedFixtures.length > 0) {
    const err = new Error(
      "Fixture regeneration cannot continue because completed matches would be affected."
    );
    err.statusCode = 400;
    err.protectedFixtures = protectedFixtures.length;
    throw err;
  }

  // 4. Distinguish manual vs reusable generated fixtures (scoped to selectedRound if specified)
  const scopedExisting = selectedRound !== null
    ? existingFixtures.filter((f) => f.round === selectedRound)
    : existingFixtures;

  let manualFixtures = [];
  let reusableFixtures = [];

  if (forceRegenerate) {
    reusableFixtures = [...scopedExisting];
  } else {
    manualFixtures = scopedExisting.filter(
      (f) => f.fixtureSource === "MANUAL" || f.isManuallyModified === true
    );
    reusableFixtures = scopedExisting.filter(
      (f) => f.fixtureSource !== "MANUAL" && !f.isManuallyModified
    );
  }

  // 5. Generate new randomized schedule
  const groups = distributeTeamsIntoGroups(norm.teamIds, norm.groupCount, randomize);
  const roundMatchesMap = new Map();
  let maxRounds = 0;
  const allByes = [];

  for (const group of groups) {
    const groupPairings = generateRoundRobinPairings(
      group.teams,
      norm.numberOfRounds,
      norm.groupCount > 1 ? group.name : "",
      randomize
    );

    allByes.push(...groupPairings.byes);

    for (const roundData of groupPairings.rounds) {
      const rNum = roundData.roundNumber;
      if (!roundMatchesMap.has(rNum)) {
        roundMatchesMap.set(rNum, []);
      }
      roundMatchesMap.get(rNum).push(...roundData.matches);
      if (rNum > maxRounds) maxRounds = rNum;
    }
  }

  const schedulingResult = scheduleFixturesAcrossSlotsAndFields({
    roundMatchesMap,
    maxRounds,
    numberOfFields: norm.numberOfFields,
    matchDuration: norm.matchDuration,
    breakBetweenMatches: norm.breakBetweenMatches,
    startTime: norm.startTime,
    startDate: norm.startDate,
    endDate: norm.endDate,
    venueName: venue || league.name || "",
  });

  const targetScheduledFixtures = selectedRound !== null
    ? schedulingResult.scheduledFixtures.filter((f) => f.round === selectedRound)
    : schedulingResult.scheduledFixtures;
  const totalTargetCount = targetScheduledFixtures.length;
  const reusableCount = reusableFixtures.length;

  const updateCount = Math.min(totalTargetCount, reusableCount);
  const createdCount = Math.max(0, totalTargetCount - reusableCount);
  const deleteCount = Math.max(0, reusableCount - totalTargetCount);

  const bulkOps = [];
  const sessionOption = session ? { session } : {};

  // 6. Update existing reusable fixtures in place
  for (let i = 0; i < updateCount; i++) {
    const existing = reusableFixtures[i];
    const target = targetScheduledFixtures[i];

    bulkOps.push({
      updateOne: {
        filter: { _id: existing._id },
        update: {
          $set: {
            round: target.round,
            group: target.group || "",
            homeTeam: target.homeTeam,
            awayTeam: target.awayTeam,
            kickoffTime: target.kickoffTime,
            endTime: target.endTime,
            field: target.field,
            venue: target.venue,
            status: "SCHEDULED",
            fixtureSource: "GENERATED",
            isManuallyModified: false,
          },
        },
      },
    });
  }

  // 7. Delete excess fixtures if fewer are now needed
  if (deleteCount > 0) {
    const excessIds = reusableFixtures.slice(totalTargetCount).map((f) => f._id);
    bulkOps.push({
      deleteMany: {
        filter: { _id: { $in: excessIds } },
      },
    });
  }

  if (bulkOps.length > 0) {
    await Fixture.bulkWrite(bulkOps, sessionOption);
  }

  // 8. Create new fixtures if more are needed
  if (createdCount > 0) {
    const newDocs = targetScheduledFixtures.slice(reusableCount).map((f) => ({
      ...f,
      league: league._id,
      fixtureSource: "GENERATED",
      isManuallyModified: false,
      status: "SCHEDULED",
    }));
    await Fixture.insertMany(newDocs, sessionOption);
  }

  // 9. Initialize / update standings for all participating teams
  const standingOps = [];
  for (const group of groups) {
    for (const tId of group.teams) {
      standingOps.push({
        updateOne: {
          filter: { league: league._id, team: tId },
          update: {
            $setOnInsert: {
              league: league._id,
              team: tId,
              group: norm.groupCount > 1 ? group.name : "",
              played: 0,
              won: 0,
              drawn: 0,
              lost: 0,
              goalsFor: 0,
              goalsAgainst: 0,
              goalDifference: 0,
              points: 0,
            },
          },
          upsert: true,
        },
      });
    }
  }

  if (standingOps.length > 0) {
    await Standing.bulkWrite(standingOps, sessionOption);
  }

  // 10. Update League document
  league.groups = groups.map((g) => ({
    name: g.name,
    teams: g.teams,
  }));
  league.fixtureGenerated = true;
  league.fixtureFormat = norm.fixtureFormat;
  league.groupCount = norm.groupCount;
  league.numberOfRounds = norm.numberOfRounds;
  league.matchDuration = norm.matchDuration;
  league.breakBetweenMatches = norm.breakBetweenMatches;
  league.numberOfFields = norm.numberOfFields;
  league.startTime = norm.startTime;

  if (session) {
    await league.save({ session });
  } else {
    await league.save();
  }

  // Fetch final updated fixtures to return
  const finalFixtures = await Fixture.find({ league: league._id })
    .sort({ round: 1, kickoffTime: 1 })
    .populate("homeTeam", "teamName logo")
    .populate("awayTeam", "teamName logo");

  return {
    leagueId: league._id,
    teams: norm.teamIds.length,
    rounds: schedulingResult.totalRounds,
    round: selectedRound,
    fixtures: finalFixtures.length,
    created: createdCount,
    updated: updateCount,
    deleted: deleteCount,
    manualFixturesPreserved: manualFixtures.length,
    fixturesList: finalFixtures,
    byes: allByes,
    daysUsed: schedulingResult.daysUsed,
  };
}

module.exports = {
  parseDateToMidnight,
  validateTournamentConfig,
  distributeTeamsIntoGroups,
  generateRoundRobinPairings,
  scheduleFixturesAcrossSlotsAndFields,
  generateAndSaveLeagueFixtures,
  reconcileAndSaveLeagueFixtures,
};

