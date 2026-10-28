const Term = require("../models/Term");
const { normalizeTeamName, entityId, escapeRegex, domainError, assertTeamLeagueScope, validateFixtureSchedule, PLAYER_STAT_KEYS, contributionDeltas } = require("../utils/leagueIntegrity");
const League = require("../models/League");
const Team = require("../models/Team");
const Fixture = require("../models/Fixture");
const MatchEvent = require("../models/MatchEvent");
const Standing = require("../models/Standing");
const PlayerStatistics = require("../models/PlayerStatistics");
const User = require("../models/User");
const Admin = require("../models/Admin");
const Category = require("../models/Category");
const Program = require("../models/Program");
const Parent = require("../models/Parent");
const {
  generateTeamInvoice,
  generateLeagueInvoice,
  processLeagueInvoicesForTeam,
} = require("../services/invoiceService");
const { activateAssignedPlayers } = require("../services/activateAssignedPlayers");
const {
  validateTournamentConfig,
  generateAndSaveLeagueFixtures,
  reconcileAndSaveLeagueFixtures,
  parseDateToMidnight,
} = require("../services/fixtureGenerationService");
const mongoose = require("mongoose");
const fs = require("fs");
const { UPLOAD_ROOT } = require("../utils/upload");
const path = require("path");
const { dateOnly, dateOnlyStartUtc, todayDateOnly, DEFAULT_TIMEZONE } = require("../utils/dateTime");
const {
  normalizePaymentStatus,
  comparePlayersByPaymentStatus,
} = require("../utils/paymentStatus");

const activeLeagueGenerationLocks = new Set();

exports.updateLeagueTeamStatus = async (req, res) => {
  try {
    const { leagueId, teamId } = req.params;
    if (![leagueId, teamId].every(mongoose.Types.ObjectId.isValid)) throw domainError("Invalid league or team ID.");
    if (!["ACTIVE", "INACTIVE"].includes(req.body.status)) throw domainError("Status must be ACTIVE or INACTIVE.");
    const league = await League.findById(leagueId);
    if (!league || league.archivedAt || !(league.teams || []).some((team) => entityId(team) === teamId)) throw domainError("Team enrollment not found.", 404);
    const updated = await Team.updateOne({ _id: teamId, "leagues.league": leagueId }, { $set: { "leagues.$.status": req.body.status === "ACTIVE" ? "ACTIVE" : "WITHDRAWN" } });
    if (!updated.matchedCount) throw domainError("Team enrollment not found.", 404);
    return res.json({ success: true, message: "Team status updated." });
  } catch (error) { return res.status(error.statusCode || 500).json({ success: false, message: error.message }); }
};

const syncTeamsLeagueData = async ({
  teamIds,
  leagueId,
  teamFee = 0,
  round = null,
  sessionDates = [],
  groups = [],
  status = "ACTIVE",
  sessionOption = {},
}) => {
  if (!teamIds || teamIds.length === 0) return;

  const validIds = teamIds.map((id) => id.toString());

  // 2. Map teams to groups if tournament groups exist
  const teamGroupMap = {};
  if (Array.isArray(groups)) {
    for (const g of groups) {
      if (Array.isArray(g.teams)) {
        for (const t of g.teams) {
          const tKey = (t?._id || t).toString();
          teamGroupMap[tKey] = g.name || "";
        }
      }
    }
  }

  // 3. Push new league subdocument to each team
  for (const tId of validIds) {
    const existingTeam = await Team.findById(tId, null, sessionOption).select("players leagues").lean();
    const defaultPlayers = Array.isArray(existingTeam?.players)
      ? existingTeam.players.map((p) => {
        const rawStatus = (p.paymentStatus || "UNPAID").toString().toUpperCase().trim();
        return {
          player: p.player,
          paymentStatus: rawStatus || "UNPAID",
          status: "ACTIVE",
        };
      })
      : [];

    const previousEntry = existingTeam?.leagues?.find((entry) => entityId(entry.league) === entityId(leagueId));
    const entry = {
      league: leagueId,
      teamFee: teamFee !== undefined && teamFee !== null ? Number(teamFee) : 0,
      round: round != null ? Number(round) : null,
      sessionDates: Array.isArray(sessionDates) ? sessionDates : [],
      group: teamGroupMap[tId] || "",
      status: previousEntry?.status || status || "ACTIVE",
      enrolledAt: previousEntry?.enrolledAt || new Date(),
      players: previousEntry?.players || defaultPlayers,
      statistics: previousEntry?.statistics || {
        played: 0,
        won: 0,
        drawn: 0,
        lost: 0,
        goalsFor: 0,
        goalsAgainst: 0,
        goalDifference: 0,
        points: 0,
      },
    };

    if (previousEntry) {
      await Team.updateOne({ _id: tId, "leagues.league": leagueId }, { $set: { "leagues.$": entry } }, sessionOption);
    } else {
      await Team.updateOne({ _id: tId, "leagues.league": { $ne: leagueId } }, { $push: { leagues: entry } }, sessionOption);
    }
  }
};

exports.createLeague = async (req, res) => {
  let session = null;
  let useSession = false;
  let createdLeagueId = null;
  try {
    const {
      name,
      season,
      description,
      startDate,
      endDate,
      // registrationStartDate,
      // registrationEndDate,
      status,
      type,
      leagueType,
      competitionScope,
      visibility,
      pointsForWin,
      pointsForDraw,
      allowDraws,
      automaticLadderRecalculation,
      teams,
      venue,
      term,
      // Generation mode
      generationType,
      // Tournament & Scheduling configuration
      fixtureFormat,
      groupCount,
      numberOfRounds,
      matchDuration,
      breakBetweenMatches,
      numberOfFields,
      startTime,
      // League Fee and Session Dates
      fee,
      sessionDates
    } = req.body;

    if (!name || !season || !startDate || !endDate) {
      return res.status(400).json({
        success: false,
        message: "Name, season, start date and end date are required.",
      });
    }

    const existingLeague = await League.findOne({
      name: name.trim(),
      season: season.trim(),
    });

    if (existingLeague) {
      return res.status(409).json({
        success: false,
        message: "League already exists for this season.",
      });
    }

    // Determine generation mode (AUTOMATIC vs MANUAL)
    const isAutoGenerate =
      generationType === "AUTOMATIC";

    // Parse fee safely (number, default 0, min 0)
    const rawFee =
      req.body.fee !== undefined
        ? req.body.fee
        : req.body.teamFee !== undefined
          ? req.body.teamFee
          : req.body.leagueFee;

    const parsedFee =
      rawFee !== undefined && rawFee !== null && !isNaN(Number(rawFee))
        ? Math.max(0, Number(rawFee))
        : 0;

    // Parse sessionDates safely (supports array, JSON string from multipart/form-data, or comma-separated)
    let rawSessionDates = sessionDates || [];

    if (typeof rawSessionDates === "string") {
      try {
        rawSessionDates = JSON.parse(rawSessionDates);
      } catch (e) {
        rawSessionDates = rawSessionDates
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
      }
    }

    let parsedSessionDates = [];
    if (Array.isArray(rawSessionDates)) {
      parsedSessionDates = rawSessionDates
        .map((d) => parseDateToMidnight(d))
        .filter(Boolean);
    }

    // Determine number of rounds (supports numberOfRounds or round or matching sessionDates length)
    const rawRounds = numberOfRounds;
    let totalRounds = rawRounds
      ? Math.max(1, parseInt(rawRounds, 10))
      : parsedSessionDates.length > 0
        ? parsedSessionDates.length
        : 1;

    // If sessionDates are provided according to numberOfRounds, sync length
    if (parsedSessionDates.length > 0 && totalRounds) {
      parsedSessionDates = parsedSessionDates.slice(0, totalRounds);
    }

    // Parse teams safely (supports array, JSON string from multipart/form-data, or comma-separated)
    let rawTeams = teams || req.body.teamIds || req.body.teams;
    if (typeof rawTeams === "string") {
      try {
        rawTeams = JSON.parse(rawTeams);
      } catch (e) {
        rawTeams = rawTeams
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
      }
    }
    if (Array.isArray(rawTeams)) {
      rawTeams = rawTeams
        .map((t) => {
          if (t && typeof t === "object") {
            return (t.teamId || t.team || t._id || t.id || "").toString().trim();
          }
          return (t || "").toString().trim();
        })
        .filter(Boolean);
    }

    let norm = null;
    let verifiedTeamIds = [];

    if (isAutoGenerate) {
      // Ensure effective dates encompass explicit sessionDates if provided
      let effectiveStartDate = startDate;
      let effectiveEndDate = endDate;
      if (parsedSessionDates.length > 0) {
        const minSessionDate = parsedSessionDates[0];
        const maxSessionDate = parsedSessionDates[parsedSessionDates.length - 1];
        const pStart = parseDateToMidnight(startDate);
        const pEnd = parseDateToMidnight(endDate);
        if (pStart && minSessionDate < pStart) {
          effectiveStartDate = minSessionDate;
        }
        if (pEnd && maxSessionDate > pEnd) {
          effectiveEndDate = maxSessionDate;
        }
      }

      // Validate tournament and scheduling configuration (requires >= 2 teams)
      const validation = validateTournamentConfig({
        teams: rawTeams,
        fixtureFormat,
        groupCount,
        numberOfRounds: totalRounds,
        matchDuration,
        breakBetweenMatches,
        numberOfFields,
        startTime,
        startDate: effectiveStartDate,
        endDate: effectiveEndDate,
      });

      if (!validation.isValid) {
        return res.status(400).json({
          success: false,
          message: validation.message,
        });
      }

      norm = validation.normalized;
      norm.sessionDates = parsedSessionDates;
      norm.fee = parsedFee;
      norm.numberOfRounds = totalRounds;
      verifiedTeamIds = norm.teamIds;

      // Verify all selected teams exist in the database
      const existingTeamsCount = await Team.countDocuments({
        _id: { $in: verifiedTeamIds },
      });
      if (existingTeamsCount !== verifiedTeamIds.length) {
        return res.status(404).json({
          success: false,
          message: "One or more selected teams do not exist in the database.",
        });
      }
    } else {
      // Manual mode: validate dates and sanitize any provided teams without requiring minimum 2 teams
      let effectiveStartDate = parseDateToMidnight(startDate);
      let effectiveEndDate = parseDateToMidnight(endDate);
      if (!effectiveStartDate || !effectiveEndDate) {
        return res.status(400).json({
          success: false,
          message: "Valid start date and end date are required.",
        });
      }
      if (parsedSessionDates.length > 0) {
        const minSessionDate = parsedSessionDates[0];
        const maxSessionDate = parsedSessionDates[parsedSessionDates.length - 1];
        if (minSessionDate < effectiveStartDate) {
          effectiveStartDate = minSessionDate;
        }
        if (maxSessionDate > effectiveEndDate) {
          effectiveEndDate = maxSessionDate;
        }
      }
      if (effectiveEndDate < effectiveStartDate) {
        return res.status(400).json({
          success: false,
          message: "End date cannot be earlier than start date.",
        });
      }

      if (Array.isArray(rawTeams) && rawTeams.length > 0) {
        const rawIds = rawTeams.map((id) => (id ? id.toString().trim() : "")).filter(Boolean);
        const invalidId = rawIds.find((id) => !mongoose.Types.ObjectId.isValid(id));
        if (invalidId) {
          return res.status(400).json({
            success: false,
            message: `Invalid team ID format: "${invalidId}".`,
          });
        }
        verifiedTeamIds = [...new Set(rawIds)];
        const existingCount = await Team.countDocuments({ _id: { $in: verifiedTeamIds } });
        if (existingCount !== verifiedTeamIds.length) {
          return res.status(404).json({
            success: false,
            message: "One or more selected teams do not exist in the database.",
          });
        }
      }

      const validFormats = ["ROUND_ROBIN", "GROUP", "KNOCKOUT"];
      const parsedFmt = (fixtureFormat || "ROUND_ROBIN").toString().toUpperCase().trim();

      norm = {
        teamIds: verifiedTeamIds,
        fixtureFormat: validFormats.includes(parsedFmt) ? parsedFmt : "ROUND_ROBIN",
        groupCount: groupCount ? Math.max(1, parseInt(groupCount, 10)) : 1,
        numberOfRounds: totalRounds,
        fee: parsedFee,
        sessionDates: parsedSessionDates,
        matchDuration: matchDuration ? Math.max(1, parseInt(matchDuration, 10)) : 90,
        breakBetweenMatches:
          breakBetweenMatches !== undefined ? Math.max(0, parseInt(breakBetweenMatches, 10)) : 15,
        numberOfFields: numberOfFields ? Math.max(1, parseInt(numberOfFields, 10)) : 1,
        startTime: startTime && typeof startTime === "string" ? startTime.trim() : "10:00",
        startDate: effectiveStartDate,
        endDate: effectiveEndDate,
      };
    }

    if (!mongoose.Types.ObjectId.isValid(term) || !await Term.exists({ _id: term })) throw domainError("Select a valid term for this league.");
    const scopeTeams = await Team.find({ _id: { $in: verifiedTeamIds } });
    assertTeamLeagueScope({ term }, scopeTeams, false);
    const rawType = (type || leagueType || competitionScope || "").toUpperCase();
    const VALID_TYPES = ["INTERNATIONAL", "NATIONAL", "STATE", "LOCAL", "OTHERS"];
    const parsedType = VALID_TYPES.includes(rawType) ? rawType : "LOCAL";

    const parsedStatus =
      status && ["UPCOMING", "ACTIVE", "COMPLETED"].includes(status.toUpperCase())
        ? status.toUpperCase()
        : "ACTIVE";

    const parsedVisibility =
      visibility && ["PUBLIC", "PRIVATE"].includes(visibility.toUpperCase())
        ? visibility.toUpperCase()
        : "PUBLIC";

    const logo = req.file ? `/uploads/leaguelogos/${req.file.filename}` : "";

    // Attempt to start MongoDB transaction if supported
    try {
      session = await mongoose.startSession();
      session.startTransaction();
      useSession = true;
    } catch (sessionErr) {
      useSession = false;
      session = null;
    }

    const sessionOption = useSession ? { session } : {};

    // 1. Create League document
    const [league] = await League.create(
      [
        {
          name: name.trim(),
          season: season.trim(),
          logo,
          description: description || "",
          startDate: norm.startDate,
          endDate: norm.endDate,
          // registrationStartDate: registrationStartDate
          //   ? parseDateToMidnight(registrationStartDate)
          //   : null,
          // registrationEndDate: registrationEndDate
          //   ? parseDateToMidnight(registrationEndDate)
          //   : null,
          term,
          status: parsedStatus,
          type: parsedType,
          visibility: parsedVisibility,
          pointsForWin: pointsForWin !== undefined ? Number(pointsForWin) : 3,
          pointsForDraw: pointsForDraw !== undefined ? Number(pointsForDraw) : 1,
          allowDraws:
            allowDraws !== undefined
              ? Boolean(allowDraws === "true" || allowDraws === true)
              : true,
          automaticLadderRecalculation:
            automaticLadderRecalculation !== undefined
              ? Boolean(
                automaticLadderRecalculation === "true" ||
                automaticLadderRecalculation === true
              )
              : true,
          teams: norm.teamIds,
          fixtureFormat: norm.fixtureFormat,
          groupCount: norm.groupCount,
          numberOfRounds: norm.numberOfRounds,
          fee: norm.fee,
          sessionDates: norm.sessionDates,
          matchDuration: norm.matchDuration,
          breakBetweenMatches: norm.breakBetweenMatches,
          numberOfFields: norm.numberOfFields,
          startTime: norm.startTime,
          fixtureGenerated: isAutoGenerate,
          generationType: isAutoGenerate ? "AUTOMATIC" : "MANUAL",
          groups: [],
        },
      ],
      sessionOption
    );

    createdLeagueId = league._id;

    if (isAutoGenerate) {
      // 2. Automatically generate and schedule fixtures & standings
      const fixtureResult = await generateAndSaveLeagueFixtures({
        league,
        teams: norm.teamIds,
        config: {
          fixtureFormat: norm.fixtureFormat,
          groupCount: norm.groupCount,
          numberOfRounds: norm.numberOfRounds,
          matchDuration: norm.matchDuration,
          breakBetweenMatches: norm.breakBetweenMatches,
          numberOfFields: norm.numberOfFields,
          startTime: norm.startTime,
          startDate: norm.startDate,
          endDate: norm.endDate,
          sessionDates: parsedSessionDates,
          venue: venue || "",
        },
        session: useSession ? session : null,
      });

      // 3. Synchronize team model with leagues subdocument (league, teamFee, round, sessionDates, group, status, enrolledAt)
      if (verifiedTeamIds.length > 0) {
        await syncTeamsLeagueData({
          teamIds: verifiedTeamIds,
          leagueId: league._id,
          teamFee: parsedFee,
          round: norm.numberOfRounds,
          sessionDates: parsedSessionDates,
          groups: fixtureResult ? fixtureResult.groups : (league.groups || []),
          status: "ACTIVE",
          sessionOption,
        });
      }

      if (useSession && session) {
        await session.commitTransaction();
        session.endSession();
      }

      // 4. Generate league fee invoices for all UNPAID players across assigned teams
      if (verifiedTeamIds.length > 0) {
        for (const tId of verifiedTeamIds) {
          try {
            await processLeagueInvoicesForTeam({
              leagueId: league._id,
              teamId: tId,
              amount: parsedFee > 0 ? parsedFee : undefined,
            });
          } catch (invErr) {
            console.error(`[League] Error processing invoices for team ${tId}:`, invErr.message);
          }
        }
      }

      return res.status(201).json({
        success: true,
        message: "League and fixtures created successfully",
        data: {
          league,
          groupsCreated: fixtureResult.groupsCreated,
          groups: fixtureResult.groups,
          teamsCount: fixtureResult.teamsCount,
          roundsCreated: fixtureResult.roundsCreated,
          fixturesCreated: fixtureResult.fixturesCreated,
          fixtures: fixtureResult.fixtures,
          byes: fixtureResult.byes,
          daysUsed: fixtureResult.daysUsed,
        },
      });
    } else {
      // Manual Mode: initialize standings for provided teams (if any), no fixtures generated yet
      if (verifiedTeamIds.length > 0) {
        const standingOps = verifiedTeamIds.map((tId) => ({
          updateOne: {
            filter: { league: league._id, team: tId },
            update: {
              $setOnInsert: {
                league: league._id,
                team: tId,
                group: "",
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
        }));
        await Standing.bulkWrite(standingOps, sessionOption);

        // Synchronize team model with leagues subdocument (league, teamFee, round, sessionDates, group, status, enrolledAt)
        await syncTeamsLeagueData({
          teamIds: verifiedTeamIds,
          leagueId: league._id,
          teamFee: parsedFee,
          round: norm.numberOfRounds,
          sessionDates: parsedSessionDates,
          groups: league.groups || [],
          status: "ACTIVE",
          sessionOption,
        });
      }

      if (useSession && session) {
        await session.commitTransaction();
        session.endSession();
      }

      // Generate league fee invoices for all UNPAID players across assigned teams
      if (verifiedTeamIds.length > 0) {
        for (const tId of verifiedTeamIds) {
          try {
            await processLeagueInvoicesForTeam({
              leagueId: league._id,
              teamId: tId,
              amount: parsedFee > 0 ? parsedFee : undefined,
            });
          } catch (invErr) {
            console.error(`[League] Error processing invoices for team ${tId}:`, invErr.message);
          }
        }
      }

      return res.status(201).json({
        success: true,
        message:
          "League created successfully in manual mode. You can now add fixtures manually or generate them automatically.",
        data: {
          league,
          fixtures: [],
          teamsCount: verifiedTeamIds.length,
          roundsCreated: 0,
          fixturesCreated: 0,
          byes: [],
          daysUsed: 0,
        },
      });
    }
  } catch (err) {
    if (useSession && session) {
      try {
        await session.abortTransaction();
        session.endSession();
      } catch (abortErr) {
        console.error("[League] Error aborting transaction:", abortErr.message);
      }
    } else if (createdLeagueId) {
      // Standalone cleanup fallback to guarantee consistency
      try {
        await League.findByIdAndDelete(createdLeagueId);
        await Fixture.deleteMany({ league: createdLeagueId });
        await Standing.deleteMany({ league: createdLeagueId });
      } catch (cleanupErr) {
        console.error("[League] Cleanup error after failure:", cleanupErr.message);
      }
    }

    const statusCode = err.statusCode || (err.message.includes("cannot fit") ? 400 : 500);

    return res.status(statusCode).json({
      success: false,
      message: err.code === 11000 ? "This team name already exists in the selected term, or a team is already scheduled in this round." : err.name === "VersionError" ? "This match changed while you were editing. Refresh and try again." : err.message,
    });
  }
};

exports.cloneLeague = async (req, res) => {
  let session = null;
  let useSession = false;
  let createdLeagueId = null;

  try {
    const sourceLeagueId = req.params.leagueId || req.body.leagueId || req.body.sourceLeagueId;

    if (!sourceLeagueId || !mongoose.Types.ObjectId.isValid(sourceLeagueId)) {
      return res.status(400).json({ success: false, message: "Valid source League ID is required" });
    }

    const sourceLeague = await League.findById(sourceLeagueId).populate({
      path: "teams",
      select: "teamName logo coach assistantCoach ageGroup teamType term dayOfWeek startTime endTime venue location scheduleType schedule captain viceCaptain players",
    });

    if (!sourceLeague) {
      return res.status(404).json({ success: false, message: "Source league not found" });
    }

    try {
      session = await mongoose.startSession();
      session.startTransaction();
      useSession = true;
    } catch (sessionErr) {
      useSession = false;
      session = null;
    }
    const sessionOption = useSession && session ? { session } : {};

    const {
      name,
      season,
      startDate,
      endDate,
      description,
      status,
      type,
      term,
      fee,
      numberOfRounds,
      groupCount,
      fixtureFormat,
      matchDuration,
      breakBetweenMatches,
      numberOfFields,
      startTime,
      pointsForWin,
      pointsForDraw,
      allowDraws,
      automaticLadderRecalculation,
      registrationStartDate,
      registrationEndDate,
      visibility,
      duplicateTeams,
    } = req.body;

    const newLogo = req.file ? `/uploads/leaguelogos/${req.file.filename}` : (sourceLeague.logo || "");
    const newName = name && name.trim() ? name.trim() : `${sourceLeague.name} (Copy)`;
    const newSeason = season && season.trim() ? season.trim() : sourceLeague.season;
    const newStartDate = parseDateToMidnight(startDate || sourceLeague.startDate);
    const newEndDate = parseDateToMidnight(endDate || sourceLeague.endDate);
    if (!newStartDate || !newEndDate || newEndDate < newStartDate) throw domainError("Valid ordered league dates are required.");
    const targetTerm = term || sourceLeague.term;
    if (!mongoose.Types.ObjectId.isValid(entityId(targetTerm)) || !await Term.exists({ _id: targetTerm })) throw domainError("Select a valid target term.");
    const newFee = fee !== undefined && fee !== null && !isNaN(Number(fee)) ? Number(fee) : (sourceLeague.fee || 0);

    const sourceTeams = (sourceLeague.teams || []).filter((t) => t && t._id);
    let assignedTeamIds = [];
    let newGroups = [];

    const shouldDuplicateTeams = duplicateTeams === true || duplicateTeams === "true" || entityId(targetTerm) !== entityId(sourceLeague.term);

    if (shouldDuplicateTeams && sourceTeams.length > 0) {
      const oldToNewMap = {};
      const newTeamDocs = [];

      for (const t of sourceTeams) {
        const clonedPlayers = (t.players || []).map((p) => ({
          player: p.player?._id || p.player,
          paymentStatus: "UNPAID",
        }));

        newTeamDocs.push({
          teamName: t.teamName,
          logo: t.logo || "",
          coach: t.coach,
          assistantCoach: t.assistantCoach,
          ageGroup: t.ageGroup || "",
          teamType: t.teamType || "INTERNAL",
          term: targetTerm,
          normalizedName: normalizeTeamName(t.teamName),
          dayOfWeek: t.dayOfWeek,
          startTime: t.startTime,
          endTime: t.endTime,
          venue: t.venue,
          location: t.location,
          scheduleType: t.scheduleType || "SINGLE_DAY",
          schedule: t.schedule || [],
          captain: t.captain,
          viceCaptain: t.viceCaptain,
          players: clonedPlayers,
          leagues: [],
        });
      }

      const createdTeams = await Team.insertMany(newTeamDocs, sessionOption);
      for (let i = 0; i < sourceTeams.length; i++) {
        oldToNewMap[sourceTeams[i]._id.toString()] = createdTeams[i]._id;
      }

      assignedTeamIds = createdTeams.map((t) => t._id);

      newGroups = (sourceLeague.groups || []).map((g) => ({
        name: g.name,
        teams: (g.teams || []).map((tId) => oldToNewMap[(tId?._id || tId).toString()] || tId),
      }));
    } else {
      assignedTeamIds = sourceTeams.map((t) => t._id);

      newGroups = (sourceLeague.groups || []).map((g) => ({
        name: g.name,
        teams: Array.isArray(g.teams) ? [...g.teams] : [],
      }));
    }

    const clonedLeague = new League({
      name: newName,
      season: newSeason,
      logo: newLogo,
      description: description !== undefined ? description : (sourceLeague.description || ""),
      startDate: newStartDate,
      endDate: newEndDate,
      status: status || "UPCOMING",
      type: type || sourceLeague.type || "LOCAL",
      term: targetTerm,
      registrationStartDate: registrationStartDate ? new Date(registrationStartDate) : sourceLeague.registrationStartDate,
      registrationEndDate: registrationEndDate ? new Date(registrationEndDate) : sourceLeague.registrationEndDate,
      visibility: visibility || sourceLeague.visibility || "PUBLIC",
      pointsForWin: pointsForWin !== undefined ? Number(pointsForWin) : sourceLeague.pointsForWin,
      pointsForDraw: pointsForDraw !== undefined ? Number(pointsForDraw) : sourceLeague.pointsForDraw,
      allowDraws: allowDraws !== undefined ? Boolean(allowDraws) : sourceLeague.allowDraws,
      automaticLadderRecalculation:
        automaticLadderRecalculation !== undefined ? Boolean(automaticLadderRecalculation) : sourceLeague.automaticLadderRecalculation,
      teams: assignedTeamIds,
      fixtureFormat: fixtureFormat || sourceLeague.fixtureFormat || "ROUND_ROBIN",
      groupCount: groupCount !== undefined ? Math.max(1, Number(groupCount)) : (sourceLeague.groupCount || 1),
      numberOfRounds: numberOfRounds !== undefined ? Math.max(1, Number(numberOfRounds)) : (sourceLeague.numberOfRounds || 1),
      fee: newFee,
      sessionDates: req.body.sessionDates || sourceLeague.sessionDates || [],
      matchDuration: matchDuration !== undefined ? Math.max(1, Number(matchDuration)) : (sourceLeague.matchDuration || 90),
      breakBetweenMatches:
        breakBetweenMatches !== undefined ? Math.max(0, Number(breakBetweenMatches)) : (sourceLeague.breakBetweenMatches || 15),
      numberOfFields: numberOfFields !== undefined ? Math.max(1, Number(numberOfFields)) : (sourceLeague.numberOfFields || 1),
      startTime: startTime || sourceLeague.startTime || "10:00",
      fixtureGenerated: false, // ⚠️ NO fixtures are cloned!
      generationType: sourceLeague.generationType || "MANUAL",
      groups: newGroups,
    });

    await clonedLeague.save(sessionOption);
    createdLeagueId = clonedLeague._id;

    if (assignedTeamIds.length > 0) {
      // Initialize fresh standings (0 games, 0 points) for all enrolled teams
      const standingOps = assignedTeamIds.map((tId) => ({
        updateOne: {
          filter: { league: clonedLeague._id, team: tId },
          update: {
            $setOnInsert: {
              league: clonedLeague._id,
              team: tId,
              group: "",
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
      }));
      await Standing.bulkWrite(standingOps, sessionOption);

      // Synchronize team model with new league enrollment & default players
      await syncTeamsLeagueData({
        teamIds: assignedTeamIds,
        leagueId: clonedLeague._id,
        teamFee: newFee,
        round: clonedLeague.numberOfRounds || null,
        sessionDates: clonedLeague.sessionDates || [],
        groups: clonedLeague.groups || [],
        status: "ACTIVE",
        sessionOption,
      });
    }

    if (useSession && session) {
      await session.commitTransaction();
      session.endSession();
    }

    // Process fee invoices if applicable
    if (newFee > 0 && assignedTeamIds.length > 0) {
      for (const tId of assignedTeamIds) {
        try {
          await processLeagueInvoicesForTeam({
            leagueId: clonedLeague._id,
            teamId: tId,
            amount: newFee,
          });
        } catch (invErr) {
          console.error(`[League Clone] Error processing invoices for team ${tId}:`, invErr.message);
        }
      }
    }

    const populatedLeague = await League.findById(clonedLeague._id).populate({
      path: "teams",
      select: "teamName logo coach assistantCoach ageGroup players leagues",
    });

    return res.status(201).json({
      success: true,
      message: "League cloned successfully with teams and players (without fixtures)",
      data: {
        league: populatedLeague,
        sourceLeagueId: sourceLeague._id,
        sourceLeagueName: sourceLeague.name,
        teamsCount: assignedTeamIds.length,
        fixturesCount: 0,
        duplicateTeams: shouldDuplicateTeams,
      },
    });
  } catch (err) {
    if (useSession && session) {
      try {
        await session.abortTransaction();
        session.endSession();
      } catch (abortErr) {
        console.error("[League Clone] Error aborting transaction:", abortErr.message);
      }
    } else if (createdLeagueId) {
      try {
        await League.findByIdAndDelete(createdLeagueId);
        await Standing.deleteMany({ league: createdLeagueId });
      } catch (cleanupErr) {
        console.error("[League Clone] Cleanup error after failure:", cleanupErr.message);
      }
    }

    return res.status(err.statusCode || (err.code === 11000 || err.name === "VersionError" ? 409 : err.name === "ValidationError" || err.name === "CastError" ? 400 : 500)).json({
      success: false,
      message: err.code === 11000 ? "This team name already exists in the selected term, or a team is already scheduled in this round." : err.name === "VersionError" ? "This match changed while you were editing. Refresh and try again." : err.message,
    });
  }
};

exports.generateRandomFixtures = async (req, res) => {
  const { leagueId } = req.params;

  if (!mongoose.Types.ObjectId.isValid(leagueId)) {
    return res.status(400).json({ success: false, message: "Invalid League ID format" });
  }

  const leagueKey = leagueId.toString();
  if (activeLeagueGenerationLocks.has(leagueKey)) {
    return res.status(409).json({
      success: false,
      message: "Fixture generation is already in progress for this league. Please wait.",
    });
  }

  activeLeagueGenerationLocks.add(leagueKey);

  let session = null;
  let useSession = false;

  try {
    const league = await League.findById(leagueId);
    if (!league) {
      return res.status(404).json({ success: false, message: "League not found" });
    }

    if (!Array.isArray(league.teams) || league.teams.length < 2) {
      return res.status(400).json({
        success: false,
        message: "League must contain at least 2 teams to generate fixtures.",
      });
    }

    const {
      forceRegenerate = false,
      round,
      targetRound,
      fixtureFormat,
      groupCount,
      numberOfRounds,
      matchDuration,
      breakBetweenMatches,
      numberOfFields,
      startTime,
      startDate,
      endDate,
      venue,
    } = req.body || {};

    const config = {
      fixtureFormat: fixtureFormat || league.fixtureFormat || "ROUND_ROBIN",
      groupCount: groupCount !== undefined ? groupCount : (league.groupCount || 1),
      numberOfRounds: numberOfRounds !== undefined ? numberOfRounds : (league.numberOfRounds || 1),
      matchDuration: matchDuration !== undefined ? matchDuration : (league.matchDuration || 90),
      breakBetweenMatches:
        breakBetweenMatches !== undefined
          ? breakBetweenMatches
          : league.breakBetweenMatches !== undefined
            ? league.breakBetweenMatches
            : 15,
      numberOfFields:
        numberOfFields !== undefined ? numberOfFields : (league.numberOfFields || 1),
      startTime: startTime || league.startTime || "10:00",
      startDate: startDate || league.startDate,
      endDate: endDate || league.endDate,
      venue: venue || league.name || "",
      round: round !== undefined ? round : targetRound,
    };

    try {
      session = await mongoose.startSession();
      session.startTransaction();
      useSession = true;
    } catch (sessionErr) {
      useSession = false;
      session = null;
    }

    const result = await reconcileAndSaveLeagueFixtures({
      league,
      teams: league.teams,
      config,
      randomize: true,
      forceRegenerate: Boolean(forceRegenerate === "true" || forceRegenerate === true),
      session: useSession ? session : null,
    });

    // Update league generationType to AUTOMATIC after successful generation
    if (league.generationType !== "AUTOMATIC") {
      league.generationType = "AUTOMATIC";
      league.fixtureGenerated = true;
      if (useSession && session) {
        await league.save({ session });
      } else {
        await league.save();
      }
    }

    if (useSession && session) {
      await session.commitTransaction();
      session.endSession();
    }

    return res.status(200).json({
      success: true,
      message: result.round
        ? `Random fixtures for Round ${result.round} generated successfully`
        : "Random fixtures generated successfully",
      data: {
        leagueId: league._id,
        teams: result.teams,
        rounds: result.rounds,
        round: result.round || null,
        fixtures: result.fixtures,
        created: result.created,
        updated: result.updated,
        deleted: result.deleted,
        manualFixturesPreserved: result.manualFixturesPreserved,
        byes: result.byes,
        daysUsed: result.daysUsed,
      },
    });
  } catch (err) {
    if (useSession && session) {
      try {
        await session.abortTransaction();
        session.endSession();
      } catch (abortErr) {
        console.error("[League] Abort error in generateRandomFixtures:", abortErr.message);
      }
    }

    const statusCode = err.statusCode || (err.message.includes("cannot fit") ? 400 : 500);

    return res.status(statusCode).json({
      success: false,
      message: err.code === 11000 ? "This team name already exists in the selected term, or a team is already scheduled in this round." : err.name === "VersionError" ? "This match changed while you were editing. Refresh and try again." : err.message,
      ...(err.protectedFixtures ? { protectedFixtures: err.protectedFixtures } : {}),
    });
  } finally {
    activeLeagueGenerationLocks.delete(leagueKey);
  }
};


exports.getAllLeagues = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 10));
    const search = req.query.search?.trim() || "";
    const type = (req.query.type || req.query.leagueType || "")?.trim().toUpperCase();
    const status = req.query.status?.trim().toUpperCase();
    const term = req.query.term || req.query.termId;

    const skip = (page - 1) * limit;

    const filter = { archivedAt: null };

    if (search) {
      filter.$or = [
        {
          name: {
            $regex: search,
            $options: "i",
          },
        },
        {
          season: {
            $regex: search,
            $options: "i",
          },
        },
      ];
    }

    if (type && ["INTERNATIONAL", "NATIONAL", "STATE", "LOCAL", "OTHERS"].includes(type)) {
      filter.type = type;
    }

    if (status && status !== "ALL") {
      if (["UPCOMING", "ACTIVE", "COMPLETED"].includes(status)) {
        filter.status = status;
      }
    }

    if (term && term !== "ALL") {
      if (mongoose.Types.ObjectId.isValid(term)) {
        filter.term = term;
      }
    }

    const [leagues, total] = await Promise.all([
      League.find(filter)
        .populate("term", "name year startDate endDate status")
        .populate({
          path: "teams",
          populate: [
            {
              path: "players.player",
              select: "firstName lastName fullName email phone profileImage jerseyNumber position role gender dob",
            },
            {
              path: "coach",
              select: "name fullName email phone",
            },
            {
              path: "captain",
              select: "firstName lastName fullName email phone profileImage jerseyNumber",
            },
            {
              path: "viceCaptain",
              select: "firstName lastName fullName email phone profileImage jerseyNumber",
            },
          ],
        })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit),

      League.countDocuments(filter),
    ]);

    leagues.forEach((l) => {
      if (Array.isArray(l.teams)) {
        l.teams = l.teams.filter(Boolean);
        l.teams.forEach((team) => {
          if (Array.isArray(team.players)) {
            team.players = team.players
              .map((entry) => {
                const rawEntry = typeof entry.toObject === "function" ? entry.toObject() : entry;
                return {
                  ...rawEntry,
                  paymentStatus: normalizePaymentStatus(entry.paymentStatus, "UNPAID"),
                };
              })
              .sort(comparePlayersByPaymentStatus);
          }
        });
      }
    });

    return res.status(200).json({
      success: true,
      message: "Leagues fetched successfully",
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
        hasNextPage: page < Math.ceil(total / limit),
        hasPreviousPage: page > 1,
      },
      data: leagues,
    });
  } catch (error) {
    return res.status(error.statusCode || (error.code === 11000 || error.name === "VersionError" ? 409 : error.name === "ValidationError" || error.name === "CastError" ? 400 : 500)).json({
      success: false,
      message: error.message,
    });
  }
};

const parseDateString = (input) => {
  if (!input) return null;
  const str = String(input).trim();
  // Check DD-MM-YYYY or DD/MM/YYYY
  const dmyMatch = str.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (dmyMatch) {
    const day = parseInt(dmyMatch[1], 10);
    const month = parseInt(dmyMatch[2], 10);
    const year = parseInt(dmyMatch[3], 10);
    return dateOnlyStartUtc(`${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`);
  }
  // Check YYYY-MM-DD
  const ymdMatch = str.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (ymdMatch) {
    const year = parseInt(ymdMatch[1], 10);
    const month = parseInt(ymdMatch[2], 10);
    const day = parseInt(ymdMatch[3], 10);
    return dateOnlyStartUtc(`${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`);
  }
  try {
    const normalized = dateOnly(str, "date");
    return normalized ? dateOnlyStartUtc(normalized, "date") : null;
  } catch (error) {
    return null;
  }
};

const extractRawDates = (body) => {
  let raw = body.date !== undefined ? body.date : (body.dates !== undefined ? body.dates : body.sessionDates);
  if (raw === undefined || raw === null || raw === "") return [];
  if (typeof raw === "string") {
    raw = raw.trim();
    if (raw.startsWith("[") && raw.endsWith("]")) {
      try {
        raw = JSON.parse(raw);
      } catch (e) {
        raw = raw.slice(1, -1).split(",").map(s => s.trim().replace(/^['"]|['"]$/g, ""));
      }
    } else if (raw.includes(",")) {
      raw = raw.split(",").map(s => s.trim());
    } else {
      raw = [raw];
    }
  }
  if (!Array.isArray(raw)) raw = [raw];
  return raw;
};

const parseRoundAndDates = (body) => {
  const rawDates = extractRawDates(body);
  let parsedDates = rawDates.map(parseDateString);
  if (parsedDates.some((date) => !date)) throw domainError("Every session date must be valid.");

  let parsedRound = body.round !== undefined && body.round !== null && String(body.round).trim() !== ""
    ? Math.max(1, parseInt(body.round, 10))
    : null;

  if (parsedRound !== null && (!Number.isInteger(parsedRound) || parsedRound < 1)) throw domainError("Round count must be a positive integer.");
  if (parsedRound && parsedDates.length > 0) {
    if (parsedDates.length > parsedRound) {
      parsedDates = parsedDates.slice(0, parsedRound);
    }
  } else if (!parsedRound && parsedDates.length > 0) {
    parsedRound = parsedDates.length;
  }

  return {
    round: parsedRound,
    sessionDates: parsedDates,
    hasRoundsOrDates: parsedRound !== null || parsedDates.length > 0,
  };
};


exports.createTeam = async (req, res) => {
  let created = false;
  try {
    const {
      teamName,
      coach,
      assistantCoach,
      ageGroup,
      teamType,
      term,
      dayOfWeek,
      startTime,
      endTime,
      venue,
      location,
      scheduleType,
      schedule,
      players,
    } = req.body;

    if (!teamName) {
      return res.status(400).json({
        success: false,
        message: "Team name is required",
      });
    }

    if (!String(teamName).trim() || !mongoose.Types.ObjectId.isValid(term) || !await Term.exists({ _id: term })) throw domainError("A valid term and team name are required.");
    const normalizedName = normalizeTeamName(teamName);
    const existingTeam = await Team.findOne({ term, $or: [{ normalizedName }, { teamName: { $regex: `^${escapeRegex(String(teamName).trim())}$`, $options: "i" } }] });

    if (existingTeam) {
      return res.status(409).json({
        success: false,
        message: "Team already exists",
      });
    }

    const parsedType =
      teamType &&
        ["INTERNAL", "EXTERNAL"].includes(teamType.toUpperCase())
        ? teamType.toUpperCase()
        : "INTERNAL";

    const logo = req.file
      ? `uploads/teamlogos/${req.file.filename}`
      : "";

    // Parse players
    let parsedPlayers = [];

    if (players) {
      let rawPlayers = players;

      if (typeof rawPlayers === "string") {
        try {
          rawPlayers = JSON.parse(rawPlayers);
        } catch (e) {
          rawPlayers = [];
        }
      }

      if (Array.isArray(rawPlayers)) {
        parsedPlayers = rawPlayers.map((p) => {
          const pid = p && p.player ? p.player : p;

          const status =
            p && p.paymentStatus
              ? p.paymentStatus
              : "UNPAID";

          const stats =
            p && p.statistics
              ? {
                appearances:
                  Number(p.statistics.appearances) || 0,
                goals:
                  Number(p.statistics.goals) || 0,
                assists:
                  Number(p.statistics.assists) || 0,
                cleanSheets:
                  Number(p.statistics.cleanSheets) || 0,
                yellowCards:
                  Number(p.statistics.yellowCards) || 0,
                redCards:
                  Number(p.statistics.redCards) || 0,
                minutesPlayed:
                  Number(p.statistics.minutesPlayed) || 0,
              }
              : {
                appearances: 0,
                goals: 0,
                assists: 0,
                cleanSheets: 0,
                yellowCards: 0,
                redCards: 0,
                minutesPlayed: 0,
              };

          return {
            player: pid,
            paymentStatus: status,
            statistics: stats,
          };
        });
      }
    }

    if (parsedPlayers.length > 20 || new Set(parsedPlayers.map((p) => entityId(p.player))).size !== parsedPlayers.length || parsedPlayers.some((p) => !mongoose.Types.ObjectId.isValid(p.player))) throw domainError("Select up to 20 distinct valid players.");
    if (await User.countDocuments({ _id: { $in: parsedPlayers.map((p) => p.player) } }) !== parsedPlayers.length) throw domainError("One or more selected players do not exist.");
    const team = await Team.create({
      teamName: String(teamName).trim().replace(/\s+/g, " "),
      normalizedName,
      logo,

      coach: coach || null,
      assistantCoach: assistantCoach || null,

      ageGroup: ageGroup || "",

      teamType: parsedType,

      term,
      round: parseRoundAndDates(req.body).round,
      sessionDates: parseRoundAndDates(req.body).sessionDates,
      teamFee: Number(req.body.fee ?? req.body.teamFee ?? 0),

      dayOfWeek: dayOfWeek || "",
      startTime: startTime || "",
      endTime: endTime || "",

      venue: venue || "",
      location: location || venue || "",

      scheduleType: scheduleType || "CUSTOM",
      schedule: schedule || [],

      players: parsedPlayers,
    });

    created = true;
    return res.status(201).json({
      success: true,
      message: "Team created successfully",
      data: team,
    });
  } catch (err) {
    return res.status(err.statusCode || (err.code === 11000 || err.name === "VersionError" ? 409 : err.name === "ValidationError" || err.name === "CastError" ? 400 : 500)).json({
      success: false,
      message: err.code === 11000 ? "This team name already exists in the selected term, or a team is already scheduled in this round." : err.name === "VersionError" ? "This match changed while you were editing. Refresh and try again." : err.message,
    });
  } finally {
    if (req.file && !created) await safeRemoveTeamLogo(`uploads/teamlogos/${req.file.filename}`);
  }
};


exports.getAllTeams = async (req, res) => {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 10;
    const search = req.query.search?.trim() || "";

    const skip = (page - 1) * limit;

    const filter = { archivedAt: null };

    if (search) {
      const coaches = await Admin.find({ name: { $regex: escapeRegex(search), $options: "i" } }).distinct("_id");
      filter.$or = ["teamName", "ageGroup", "teamType"].map((key) => ({ [key]: { $regex: escapeRegex(search), $options: "i" } }));
      filter.$or.push({ coach: { $in: coaches } }, { assistantCoach: { $in: coaches } });
    }

    if (req.query.teamType && ["INTERNAL", "EXTERNAL"].includes(req.query.teamType.toUpperCase())) {
      filter.teamType = req.query.teamType.toUpperCase();
    }

    if (req.query.termId || req.query.term) {
      filter.term = req.query.termId || req.query.term;
      if (!mongoose.Types.ObjectId.isValid(filter.term)) throw domainError("Invalid term ID.");
    }

    const [teams, total] = await Promise.all([
      Team.find(filter)
        .populate("term", "name year startDate endDate")
        .populate("coach", "name email profileImage")
        .populate("assistantCoach", "name email profileImage")
        .populate("captain", "name email profileImage")
        .populate("viceCaptain", "name email profileImage")
        .populate("players.player", "fullName email profileImage")
        .sort({ createdAt: -1, _id: -1 })
        .skip(skip)
        .limit(limit),

      Team.countDocuments(filter),
    ]);

    return res.status(200).json({
      success: true,
      message: "Teams fetched successfully",
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
        hasNextPage: page < Math.ceil(total / limit),
        hasPreviousPage: page > 1,
      },
      data: teams,
    });
  } catch (error) {
    return res.status(error.statusCode || (error.code === 11000 || error.name === "VersionError" ? 409 : error.name === "ValidationError" || error.name === "CastError" ? 400 : 500)).json({
      success: false,
      message: error.message,
    });
  }
};

exports.assignPlayerToTeam = async (req, res) => {
  let session;
  try {
    const { teamId } = req.params;
    const leagueId = req.params.leagueId || req.body.leagueId || req.body.league || req.query.leagueId;
    if (!mongoose.Types.ObjectId.isValid(teamId) || (leagueId && !mongoose.Types.ObjectId.isValid(leagueId))) throw domainError("Invalid team or league ID.");
    let players = req.body.players;
    if (typeof players === "string") { try { players = JSON.parse(players); } catch { throw domainError("Invalid players JSON."); } }
    if (!Array.isArray(players) || !players.length) throw domainError("Select at least one player.");
    const allowedStatuses = ["TRIAL", "UNPAID", "PAID", "OVER_DUE", "EXTRA", "SUBSTITUTE", "TBC", "HANDSHAKE"];
    const entries = players.map((row) => ({ player: entityId(row.playerId || row.player || row._id || row), paymentStatus: typeof row === "object" ? String(row.paymentStatus || "TRIAL").toUpperCase() : "TRIAL" }));
    if (entries.some((row) => !mongoose.Types.ObjectId.isValid(row.player) || !allowedStatuses.includes(row.paymentStatus)) || new Set(entries.map((row) => row.player)).size !== entries.length) throw domainError("Players must be distinct valid IDs with valid payment statuses.");
    session = await mongoose.startSession(); session.startTransaction();
    if (leagueId) await League.updateOne({ _id: leagueId }, { $inc: { schedulingRevision: 1 } }, { session });
    // Reading and saving the same Team in the transaction serializes roster capacity changes.
    const team = await Team.findById(teamId).session(session);
    if (!team || team.archivedAt) throw domainError("Team not found.", 404);
    if (await User.countDocuments({ _id: { $in: entries.map((row) => row.player) }, isBlocked: { $ne: true } }).session(session) !== entries.length) throw domainError("One or more selected players is unavailable.");
    let enrollment;
    if (leagueId) {
      const league = await League.findById(leagueId).session(session);
      if (!league || league.archivedAt) throw domainError("League not found.", 404);
      assertTeamLeagueScope(league, [team]);
      enrollment = team.leagues.find((row) => entityId(row.league) === leagueId);
      if (!enrollment) throw domainError("Enroll the team before assigning league players.", 409);
    }
    const base = new Map((team.players || []).map((row) => [entityId(row.player), row.toObject ? row.toObject() : row]));
    for (const row of entries) {
      if (!base.has(row.player)) base.set(row.player, { ...row, paymentStatus: leagueId ? "TRIAL" : row.paymentStatus });
      else if (!leagueId) base.get(row.player).paymentStatus = row.paymentStatus;
    }
    if (base.size > 20) throw domainError("A team cannot have more than 20 players.", 409);
    team.players = [...base.values()];
    if (enrollment) {
      const roster = new Map((enrollment.players || []).map((row) => [entityId(row.player), row.toObject ? row.toObject() : row]));
      for (const row of entries) roster.set(row.player, { ...(roster.get(row.player) || {}), ...row, status: roster.get(row.player)?.status || "ACTIVE" });
      enrollment.players = [...roster.values()];
    }
    await team.save({ session });
    await activateAssignedPlayers(entries.map((row) => row.player), { session, assignedBy: req.admin?._id });
    if (enrollment?.teamFee > 0) for (const row of entries) if (row.paymentStatus === "UNPAID") await generateLeagueInvoice({ userId: row.player, leagueId, teamId, amount: enrollment.teamFee, session });
    await session.commitTransaction();
    return res.json({ success: true, message: "Players assigned successfully.", data: await Team.findById(teamId).populate("players.player", "fullName profileImage").populate("leagues.players.player", "fullName profileImage") });
  } catch (error) {
    if (session?.inTransaction()) await session.abortTransaction();
    return res.status(error.statusCode || ([11000, 112, 251].includes(error.code) ? 409 : 500)).json({ success: false, message: error.message });
  } finally { if (session) await session.endSession(); }
};

exports.getAvailablePlayers = async (req, res) => {
  try {
    let termId = req.query.termId;
    if (req.query.teamId) {
      if (!mongoose.Types.ObjectId.isValid(req.query.teamId)) throw domainError("Invalid team ID.");
      const contextTeam = await Team.findById(req.query.teamId).select("term");
      if (!contextTeam) throw domainError("Team not found.", 404);
      termId = contextTeam.term;
    }
    if (termId && !mongoose.Types.ObjectId.isValid(termId)) throw domainError("Invalid term ID.");
    const teams = await Team.find({ archivedAt: null, ...(termId ? { term: termId } : {}) }, "players teamName term");

    const playerTeamMap = {};
    teams.forEach((team) => {
      if (team.players && Array.isArray(team.players)) {
        team.players.forEach((p) => {
          const pid = p.player ? p.player.toString() : p.toString();
          playerTeamMap[pid] = {
            _id: team._id,
            teamName: team.teamName,
          };
        });
      }
    });

    const allPlayers = await User.find({
      isBlocked: false,
    })
      .populate("category", "name")
      .populate("programs", "name")
      .populate("term", "name")
      .select(
        "firstName lastName fullName profileImage category programs term phone email"
      );

    const enrichedPlayers = allPlayers.map((player) => {
      const playerObj = player.toObject();
      const teamInfo = playerTeamMap[player._id.toString()] || null;
      playerObj.isAssigned = !!teamInfo;
      playerObj.assignedTeam = teamInfo;
      return playerObj;
    });

    return res.status(200).json({
      success: true,
      count: enrichedPlayers.length,
      data: enrichedPlayers,
    });
  } catch (err) {
    return res.status(err.statusCode || (err.code === 11000 || err.name === "VersionError" ? 409 : err.name === "ValidationError" || err.name === "CastError" ? 400 : 500)).json({
      success: false,
      message: err.code === 11000 ? "This team name already exists in the selected term, or a team is already scheduled in this round." : err.name === "VersionError" ? "This match changed while you were editing. Refresh and try again." : err.message,
    });
  }
};

exports.createFixture = async (req, res) => {
  let session;
  try {
    session = await mongoose.startSession();
    session.startTransaction();
    const leagueId = req.params?.leagueId || req.body.league;
    if (req.params?.leagueId && req.body.league && entityId(req.body.league) !== leagueId) throw domainError("League in URL and request must match.");
    const homeTeam = entityId(req.body.homeTeam), awayTeam = entityId(req.body.awayTeam);
    if (![leagueId, homeTeam, awayTeam].every(mongoose.Types.ObjectId.isValid)) throw domainError("Invalid league or team ID.");
    if (homeTeam === awayTeam) throw domainError("Home and away teams must differ.");
    await League.updateOne({ _id: leagueId, archivedAt: null }, { $inc: { schedulingRevision: 1 } }, { session });
    const [league, home, away] = await Promise.all([League.findById(leagueId).session(session), Team.findById(homeTeam).session(session), Team.findById(awayTeam).session(session)]);
    if (!league || league.archivedAt) throw domainError("League not found.", 404);
    if (!home || !away) throw domainError("Team not found.", 404);
    assertTeamLeagueScope(league, [home, away]);
    const timing = validateFixtureSchedule(league, { ...req.body, round: req.body.round ?? 1 });
    const conflict = await Fixture.exists({ league: leagueId, round: timing.round, $or: [{ homeTeam: { $in: [homeTeam, awayTeam] } }, { awayTeam: { $in: [homeTeam, awayTeam] } }] }).session(session);
    if (conflict) throw domainError("A selected team is already scheduled in this round.", 409);
    const fieldConflict = await Fixture.exists({ league: leagueId, field: timing.field, kickoffTime: { $lt: timing.endTime }, endTime: { $gt: timing.kickoffTime } }).session(session);
    if (fieldConflict) throw domainError("This field is already booked at that time.", 409);
    const sessionDate = parseDateToMidnight(req.body.sessionDate || league.sessionDates?.[timing.round - 1] || todayDateOnly(DEFAULT_TIMEZONE, timing.kickoffTime));
    if (!sessionDate) throw domainError("Invalid session date.");
    const [fixture] = await Fixture.create([{ league: leagueId, ...timing, sessionDate, venue: String(req.body.venue || league.venue || league.name).trim(), group: String(req.body.group || "").trim(), referee: String(req.body.referee || "").trim(), homeTeam, awayTeam, participants: [homeTeam, awayTeam], status: "SCHEDULED", fixtureSource: "MANUAL", isManuallyModified: true }], { session });
    await session.commitTransaction();
    const data = await Fixture.findById(fixture._id).populate("league", "name season").populate("homeTeam", "teamName logo").populate("awayTeam", "teamName logo");
    return res.status(201).json({ success: true, message: "Fixture created successfully.", data });
  } catch (err) { if (session?.inTransaction()) await session.abortTransaction(); return res.status(err.statusCode || ([11000, 112, 251].includes(err.code) ? 409 : err.name === "ValidationError" ? 400 : 500)).json({ success: false, message: err.code === 11000 ? "A selected team is already scheduled in this round." : err.message }); } finally { if (session) await session.endSession(); }
};

exports.recordMatchEvent = async (req, res) => {
  let session;
  try {
    const { matchId } = req.params;
    const { player, team, eventType, minute, details } = req.body;
    if (![matchId, player, team].every(mongoose.Types.ObjectId.isValid) || !["GOAL", "ASSIST", "YELLOW_CARD", "RED_CARD", "SUBSTITUTION"].includes(eventType) || !Number.isInteger(Number(minute)) || Number(minute) < 0) throw domainError("Valid match, player, team, event type and minute are required.");
    session = await mongoose.startSession(); session.startTransaction();
    const match = await Fixture.findById(matchId).session(session);
    if (!match) throw domainError("Match not found.", 404);
    if (req.params.leagueId && entityId(match.league) !== req.params.leagueId) throw domainError("Fixture does not belong to the specified league.", 404);
    if (match.status === "COMPLETED") throw domainError("Correct completed results through the result editor.", 409);
    if (![entityId(match.homeTeam), entityId(match.awayTeam)].includes(team)) throw domainError("Event team must participate in this match.");
    const teamDoc = await Team.findById(team).session(session);
    if (!teamDoc || !checkPlayerBelongsToTeam(player, teamDoc)) throw domainError("Event player must belong to its team.");
    await League.updateOne({ _id: match.league, archivedAt: null }, { $inc: { schedulingRevision: 1 } }, { session });
    if (eventType === "ASSIST") {
      const goal = match.goals.id(req.body.goalId);
      if (!goal || entityId(goal.team) !== team || entityId(goal.scorer) === player) throw domainError("Select a goal by this team and a different player before recording an assist.");
      goal.assist = player;
    }
    if (eventType === "GOAL") {
      match.goals.push({ team, scorer: player, minute: Number(minute) });
      const scoreKey = entityId(match.homeTeam) === team ? "homeScore" : "awayScore";
      match.score[scoreKey] = Number(match.score[scoreKey] || 0) + 1;
    }
    let performance = match.resultPlayers.find((row) => entityId(row.player) === player);
    if (!performance) { match.resultPlayers.push({ player, team, appearances: 1 }); performance = match.resultPlayers[match.resultPlayers.length - 1]; }
    if (eventType === "YELLOW_CARD") performance.yellowCards += 1;
    if (eventType === "RED_CARD") performance.redCards += 1;
    const [event] = await MatchEvent.create([{ match: matchId, player, team, eventType, minute: Number(minute), details: typeof details === "string" ? details : "" }], { session });
    match.events.push(event._id);
    match.status = "LIVE";
    await match.save({ session });
    // Aggregate player/standing effects are applied exactly once by final-result deltas.
    await session.commitTransaction();
    return res.status(201).json({ success: true, message: "Match event recorded.", data: event });
  } catch (error) {
    if (session?.inTransaction()) await session.abortTransaction();
    return res.status(error.statusCode || ([11000, 112, 251].includes(error.code) || error.name === "VersionError" ? 409 : 500)).json({ success: false, message: error.message });
  } finally { if (session) await session.endSession(); }
};

exports.completeMatch = async (req, res) => {
  // All result writes use the same correction-aware transactional implementation.
  req.body = { ...req.body, status: "COMPLETED", finalize: true };
  return exports.updateFixture(req, res);
};

exports.updatePlayerStatistics = async (req, res) => {
  try {
    for (const key of PLAYER_STAT_KEYS) if (req.body[key] !== undefined && (!Number.isInteger(Number(req.body[key])) || Number(req.body[key]) < 0)) throw domainError(`${key} must be a non-negative integer.`);
    const { playerId } = req.params;

    const {
      appearances,
      goals,
      assists,
      cleanSheets,
      yellowCards,
      redCards,
      minutesPlayed,
    } = req.body;

    const player = await User.findById(playerId);

    if (!player) {
      return res.status(404).json({
        success: false,
        message: "Player not found.",
      });
    }

    const updateData = {};

    if (appearances !== undefined)
      updateData["statistics.appearances"] = appearances;

    if (goals !== undefined)
      updateData["statistics.goals"] = goals;

    if (assists !== undefined)
      updateData["statistics.assists"] = assists;

    if (cleanSheets !== undefined)
      updateData["statistics.cleanSheets"] = cleanSheets;

    if (yellowCards !== undefined)
      updateData["statistics.yellowCards"] = yellowCards;

    if (redCards !== undefined)
      updateData["statistics.redCards"] = redCards;

    if (minutesPlayed !== undefined)
      updateData["statistics.minutesPlayed"] = minutesPlayed;

    const updatedPlayer = await User.findByIdAndUpdate(
      playerId,
      {
        $set: updateData,
      },
      {
        new: true,
        runValidators: true,
      }
    );

    return res.status(200).json({
      success: true,
      message: "Player statistics updated successfully.",
      data: updatedPlayer.statistics,
    });
  } catch (error) {
    return res.status(error.statusCode || (error.code === 11000 || error.name === "VersionError" ? 409 : error.name === "ValidationError" || error.name === "CastError" ? 400 : 500)).json({
      success: false,
      message: error.message,
    });
  }
};
exports.getLeagueStandings = async (req, res) => {
  try {
    const { leagueId } = req.params;
    const league = await League.findById(leagueId).select("teams");
    const validTeamIds = league && Array.isArray(league.teams) ? league.teams.map((t) => t.toString()) : [];

    const standings = await Standing.find({ league: leagueId, team: { $in: validTeamIds } })
      .populate("team", "teamName logo")
      .sort({ points: -1, goalDifference: -1, goalsFor: -1 });

    const filtered = standings.filter((s) => s.team && s.team._id);

    res.json({ success: true, data: filtered });
  } catch (err) {
    res.status(err.statusCode || (err.code === 11000 || err.name === "VersionError" ? 409 : err.name === "ValidationError" || err.name === "CastError" ? 400 : 500)).json({ success: false, message: err.message });
  }
};

exports.getLeagueLeaderboard = async (req, res) => {
  try {
    const { leagueId } = req.params;
    const league = await League.findById(leagueId).select("teams");
    const validTeamIds = league && Array.isArray(league.teams) ? league.teams.map((t) => t.toString()) : [];

    const stats = await PlayerStatistics.find({ league: leagueId, team: { $in: validTeamIds } })
      .populate("player", "fullName firstName lastName profileImage")
      .populate("team", "teamName logo")
      .sort({ goals: -1, assists: -1 });

    const filtered = stats.filter((s) => s.player && s.team && s.team._id);

    res.json({ success: true, data: filtered });
  } catch (err) {
    res.status(err.statusCode || (err.code === 11000 || err.name === "VersionError" ? 409 : err.name === "ValidationError" || err.name === "CastError" ? 400 : 500)).json({ success: false, message: err.message });
  }
};

exports.getFixtures = async (req, res) => {
  try {
    const { leagueId } = req.params;
    const league = await League.findById(leagueId).select("teams");
    const validTeamIds = new Set(
      league && Array.isArray(league.teams) ? league.teams.map((t) => t.toString()) : []
    );

    const fixtures = await Fixture.find({ league: leagueId })
      .populate("homeTeam", "teamName logo")
      .populate("awayTeam", "teamName logo")
      .populate("goals.scorer", "firstName lastName fullName profileImage")
      .populate("goals.assist", "firstName lastName fullName profileImage")
      .populate("goals.team", "teamName logo")
      .sort({ kickoffTime: 1 });

    const filtered = fixtures.filter((f) => {
      if (!f.homeTeam || !f.awayTeam) return false;
      if (f.status !== "COMPLETED") {
        return (
          validTeamIds.has(f.homeTeam._id.toString()) &&
          validTeamIds.has(f.awayTeam._id.toString())
        );
      }
      return true;
    });

    res.json({ success: true, data: filtered });
  } catch (err) {
    res.status(err.statusCode || (err.code === 11000 || err.name === "VersionError" ? 409 : err.name === "ValidationError" || err.name === "CastError" ? 400 : 500)).json({ success: false, message: err.message });
  }
};

exports.getTeamById = async (req, res) => {
  try {
    const teamId = req.params?.teamId || req.query?.teamId || req.body?.teamId;

    if (!teamId || !mongoose.Types.ObjectId.isValid(teamId)) {
      return res.status(400).json({ success: false, message: "Invalid Team ID format" });
    }

    const team = await Team.findById(teamId)
      .populate("coach", "name fullName email mobile phone profileImage role")
      .populate("assistantCoach", "name fullName email mobile phone profileImage role")
      .populate("captain", "firstName lastName fullName email mobile phone profileImage jerseyNumber")
      .populate("viceCaptain", "firstName lastName fullName email mobile phone profileImage jerseyNumber")
      .populate("term", "name startDate endDate year status")
      .populate({
        path: "players.player",
        select: "firstName lastName fullName email phone dob gender profileImage jerseyNumber statistics rating classPaymentStatuses teamPaymentStatuses parentId",
        populate: {
          path: "parentId",
          select: "fullName email phone mobile profileImage emergencyContact relationship",
        },
      })
      .populate({
        path: "leagues.league",
        select: "name season logo description startDate endDate status type competitionScope visibility fee numberOfRounds fixtureFormat sessionDates venue pointsForWin pointsForDraw allowDraws",
      })
      .populate({
        path: "leagues.players.player",
        select: "firstName lastName fullName email phone dob gender profileImage jerseyNumber statistics rating parentId",
        populate: {
          path: "parentId",
          select: "fullName email phone mobile profileImage emergencyContact relationship",
        },
      });

    if (!team) {
      return res.status(404).json({ success: false, message: "Team not found" });
    }

    const teamObj = team.toObject ? team.toObject() : { ...team };

    // Format leagues with full detail and per-league metrics
    const rawLeagues = Array.isArray(teamObj.leagues) ? teamObj.leagues : [];
    let activeLeaguesCount = 0;
    let completedLeaguesCount = 0;
    let withdrawnLeaguesCount = 0;

    const formattedLeagues = rawLeagues.map((lEntry) => {
      const leagueDoc = lEntry.league && typeof lEntry.league === "object" ? lEntry.league : null;
      const leagueId = leagueDoc ? leagueDoc._id : lEntry.league;
      const status = (lEntry.status || "ACTIVE").toUpperCase().trim();

      if (status === "ACTIVE") activeLeaguesCount++;
      else if (status === "COMPLETED") completedLeaguesCount++;
      else if (status === "WITHDRAWN") withdrawnLeaguesCount++;

      const leaguePlayers = Array.isArray(lEntry.players) ? lEntry.players : [];
      let paidCount = 0;
      let unpaidCount = 0;
      let trialCount = 0;

      const formattedLeaguePlayers = leaguePlayers.map((lp) => {
        const pDoc = lp.player && typeof lp.player === "object" ? { ...lp.player } : { _id: lp.player };
        const pFullName = pDoc.fullName || `${pDoc.firstName || ""} ${pDoc.lastName || ""}`.trim();
        const payStatus = (lp.paymentStatus || "UNPAID").toUpperCase().trim();
        const pStatus = (lp.status || "ACTIVE").toUpperCase().trim();

        if (payStatus === "PAID") paidCount++;
        else if (payStatus === "UNPAID") unpaidCount++;
        else if (payStatus === "TRIAL") trialCount++;

        return {
          ...pDoc,
          player: pDoc,
          playerId: pDoc._id,
          fullName: pFullName,
          paymentStatus: payStatus,
          status: pStatus,
        };
      });

      const stats = {
        played: Number(lEntry.statistics?.played) || 0,
        won: Number(lEntry.statistics?.won) || 0,
        drawn: Number(lEntry.statistics?.drawn) || 0,
        lost: Number(lEntry.statistics?.lost) || 0,
        goalsFor: Number(lEntry.statistics?.goalsFor) || 0,
        goalsAgainst: Number(lEntry.statistics?.goalsAgainst) || 0,
        goalDifference: Number(lEntry.statistics?.goalDifference) || 0,
        points: Number(lEntry.statistics?.points) || 0,
      };

      return {
        _id: lEntry._id,
        league: leagueDoc || leagueId,
        leagueId: leagueId,
        leagueName: leagueDoc?.name || "",
        leagueSeason: leagueDoc?.season || "",
        leagueStatus: leagueDoc?.status || "",
        status: status, // Enrollment status: ACTIVE, COMPLETED, WITHDRAWN
        teamFee: Number(lEntry.teamFee !== undefined ? lEntry.teamFee : (leagueDoc?.fee || 0)),
        round: lEntry.round != null ? lEntry.round : (leagueDoc?.numberOfRounds || null),
        sessionDates: Array.isArray(lEntry.sessionDates) ? lEntry.sessionDates : (leagueDoc?.sessionDates || []),
        group: lEntry.group || "",
        enrolledAt: lEntry.enrolledAt,
        statistics: stats,
        totalPlayers: formattedLeaguePlayers.length,
        playersCount: formattedLeaguePlayers.length,
        paidPlayersCount: paidCount,
        unpaidPlayersCount: unpaidCount,
        trialPlayersCount: trialCount,
        players: formattedLeaguePlayers,
      };
    });

    teamObj.leagues = formattedLeagues;
    teamObj.totalLeagues = formattedLeagues.length;
    teamObj.activeLeagues = activeLeaguesCount;
    teamObj.completedLeagues = completedLeaguesCount;
    teamObj.withdrawnLeagues = withdrawnLeaguesCount;

    teamObj.leaguesSummary = {
      totalLeagues: formattedLeagues.length,
      activeLeagues: activeLeaguesCount,
      completedLeagues: completedLeaguesCount,
      withdrawnLeagues: withdrawnLeaguesCount,
      leagues: formattedLeagues.map((l) => ({
        leagueId: l.leagueId,
        leagueName: l.leagueName,
        season: l.leagueSeason,
        status: l.status,
        leagueStatus: l.leagueStatus,
        teamFee: l.teamFee,
        playersCount: l.playersCount,
        points: l.statistics.points,
      })),
    };

    // Calculate aggregated statistics across all leagues
    const aggregatedLeagueStatistics = formattedLeagues.reduce(
      (acc, l) => {
        const s = l.statistics || {};
        acc.played += Number(s.played) || 0;
        acc.won += Number(s.won) || 0;
        acc.drawn += Number(s.drawn) || 0;
        acc.lost += Number(s.lost) || 0;
        acc.goalsFor += Number(s.goalsFor) || 0;
        acc.goalsAgainst += Number(s.goalsAgainst) || 0;
        acc.goalDifference += Number(s.goalDifference) || 0;
        acc.points += Number(s.points) || 0;
        return acc;
      },
      { played: 0, won: 0, drawn: 0, lost: 0, goalsFor: 0, goalsAgainst: 0, goalDifference: 0, points: 0 }
    );
    teamObj.aggregatedLeagueStatistics = aggregatedLeagueStatistics;

    if (!teamObj.statistics || teamObj.statistics.played === 0) {
      if (aggregatedLeagueStatistics.played > 0) {
        teamObj.statistics = aggregatedLeagueStatistics;
      } else {
        teamObj.statistics = teamObj.statistics || {
          played: 0,
          won: 0,
          drawn: 0,
          lost: 0,
          goalsFor: 0,
          goalsAgainst: 0,
          goalDifference: 0,
          points: 0,
        };
      }
    }

    // Format master team players (preserving existing format & attaching league enrollment data)
    if (teamObj.players && Array.isArray(teamObj.players)) {
      teamObj.players = teamObj.players.map((item) => {
        const pObj = item.player && typeof item.player === "object" ? { ...item.player } : { _id: item.player };
        pObj.paymentStatus = item.paymentStatus || "TRIAL";
        const playerStats = item.statistics ? {
          appearances: Number(item.statistics.appearances) || 0,
          goals: Number(item.statistics.goals) || 0,
          assists: Number(item.statistics.assists) || 0,
          cleanSheets: Number(item.statistics.cleanSheets) || 0,
          yellowCards: Number(item.statistics.yellowCards) || 0,
          redCards: Number(item.statistics.redCards) || 0,
          minutesPlayed: Number(item.statistics.minutesPlayed) || 0,
        } : (pObj.statistics || {
          appearances: 0,
          goals: 0,
          assists: 0,
          cleanSheets: 0,
          yellowCards: 0,
          redCards: 0,
          minutesPlayed: 0,
        });
        pObj.statistics = playerStats;
        pObj.teamStatistics = playerStats;

        // Attach which leagues this player is part of
        const pIdStr = pObj._id ? pObj._id.toString() : "";
        pObj.leagues = formattedLeagues.map((fl) => {
          const matched = (fl.players || []).find((lp) => (lp._id || lp.playerId)?.toString() === pIdStr);
          return {
            leagueId: fl.leagueId,
            leagueName: fl.leagueName,
            isEnrolled: !!matched,
            paymentStatus: matched ? matched.paymentStatus : null,
            status: matched ? matched.status : null,
          };
        });

        return pObj;
      });
    }

    teamObj.totalPlayers = Array.isArray(teamObj.players) ? teamObj.players.length : 0;

    return res.status(200).json({
      success: true,
      message: "Team details fetched successfully",
      data: teamObj,
    });
  } catch (err) {
    return res.status(err.statusCode || (err.code === 11000 || err.name === "VersionError" ? 409 : err.name === "ValidationError" || err.name === "CastError" ? 400 : 500)).json({
      success: false,
      message: err.code === 11000 ? "This team name already exists in the selected term, or a team is already scheduled in this round." : err.name === "VersionError" ? "This match changed while you were editing. Refresh and try again." : err.message,
    });
  }
};

exports.getTeamPlayers = async (req, res) => {
  try {
    const teamId = req.params.teamId || req.query.teamId;

    if (teamId) {
      if (!mongoose.Types.ObjectId.isValid(teamId)) {
        return res.status(400).json({ success: false, message: "Invalid Team ID format" });
      }

      const team = await Team.findById(teamId)
        .populate("coach", "name fullName email mobile profileImage")
        .populate("assistantCoach", "name fullName email mobile profileImage")
        .populate("captain", "firstName lastName fullName email profileImage jerseyNumber")
        .populate("viceCaptain", "firstName lastName fullName email profileImage jerseyNumber")
        .populate({
          path: "players.player",
          select: "-password -tokens",
          populate: [
            { path: "category", select: "name" },
            { path: "programs", select: "name" },
            { path: "parentId", select: "name fullName email phone mobile" },
          ],
        });

      if (!team) {
        return res.status(404).json({ success: false, message: "Team not found" });
      }

      const captainId = team.captain ? (team.captain._id ? team.captain._id.toString() : team.captain.toString()) : null;
      const viceCaptainId = team.viceCaptain ? (team.viceCaptain._id ? team.viceCaptain._id.toString() : team.viceCaptain.toString()) : null;

      const formattedPlayers = (team.players || [])
        .filter((item) => item && item.player)
        .map((item) => {
          const p = item.player;
          const pObj = p.toObject ? p.toObject() : { ...p };
          const pIdStr = pObj._id ? pObj._id.toString() : "";

          const fullName = pObj.fullName || `${pObj.firstName || ""} ${pObj.lastName || ""}`.trim();

          return {
            _id: pObj._id,
            firstName: pObj.firstName || "",
            lastName: pObj.lastName || "",
            fullName: fullName,
            profileImage: pObj.profileImage || "",
            email: pObj.email || "",
            phone: pObj.phone || "",
            dob: pObj.dob || null,
            gender: pObj.gender || "",
            jerseyNumber: pObj.jerseyNumber !== undefined && pObj.jerseyNumber !== null ? pObj.jerseyNumber : null,
            paymentStatus: item.paymentStatus || "TRIAL",
            isCaptain: captainId === pIdStr,
            isViceCaptain: viceCaptainId === pIdStr,
            isTemporary: false,
            statistics: item.statistics || {
              appearances: 0,
              goals: 0,
              assists: 0,
              cleanSheets: 0,
              yellowCards: 0,
              redCards: 0,
              minutesPlayed: 0,
            },
            category: pObj.category || null,
            programs: pObj.programs || [],
            parentId: pObj.parentId || null,
            rating: pObj.rating || null,
            club: pObj.club || "",
          };
        });

      const formattedTemporaryPlayers = (team.temporaryPlayers || []).map((tp) => ({
        _id: tp._id,
        name: tp.name || "",
        fullName: tp.name || "",
        jerseyNumber: tp.jerseyNumber !== undefined && tp.jerseyNumber !== null ? tp.jerseyNumber : null,
        profileImage: tp.profileImage || "",
        position: tp.position || "",
        isTemporary: true,
        statistics: tp.statistics || {
          appearances: 0,
          goals: 0,
          assists: 0,
          cleanSheets: 0,
          yellowCards: 0,
          redCards: 0,
          minutesPlayed: 0,
        },
      }));

      return res.status(200).json({
        success: true,
        team: {
          _id: team._id,
          teamName: team.teamName,
          logo: team.logo || "",
          ageGroup: team.ageGroup || "",
          coach: team.coach || null,
          assistantCoach: team.assistantCoach || null,
          captain: team.captain || null,
          viceCaptain: team.viceCaptain || null,
          teamType: team.teamType || "INTERNAL",
        },
        totalPlayers: formattedPlayers.length,
        totalTemporaryPlayers: formattedTemporaryPlayers.length,
        players: formattedPlayers,
        temporaryPlayers: formattedTemporaryPlayers,
      });
    }

    // If no teamId provided, fetch all players across all teams
    const teams = await Team.find({})
      .populate("coach", "name fullName email mobile profileImage")
      .populate("captain", "firstName lastName fullName email profileImage jerseyNumber")
      .populate("viceCaptain", "firstName lastName fullName email profileImage jerseyNumber")
      .populate({
        path: "players.player",
        select: "-password -tokens",
        populate: [
          { path: "category", select: "name" },
          { path: "programs", select: "name" },
        ],
      });

    const allTeamPlayers = [];
    for (const team of teams) {
      const captainId = team.captain ? (team.captain._id ? team.captain._id.toString() : team.captain.toString()) : null;
      const viceCaptainId = team.viceCaptain ? (team.viceCaptain._id ? team.viceCaptain._id.toString() : team.viceCaptain.toString()) : null;

      (team.players || []).forEach((item) => {
        if (!item || !item.player) return;
        const p = item.player;
        const pObj = p.toObject ? p.toObject() : { ...p };
        const pIdStr = pObj._id ? pObj._id.toString() : "";
        const fullName = pObj.fullName || `${pObj.firstName || ""} ${pObj.lastName || ""}`.trim();

        allTeamPlayers.push({
          _id: pObj._id,
          firstName: pObj.firstName || "",
          lastName: pObj.lastName || "",
          fullName: fullName,
          profileImage: pObj.profileImage || "",
          email: pObj.email || "",
          phone: pObj.phone || "",
          dob: pObj.dob || null,
          gender: pObj.gender || "",
          jerseyNumber: pObj.jerseyNumber !== undefined && pObj.jerseyNumber !== null ? pObj.jerseyNumber : null,
          paymentStatus: item.paymentStatus || "TRIAL",
          isCaptain: captainId === pIdStr,
          isViceCaptain: viceCaptainId === pIdStr,
          isTemporary: false,
          team: {
            _id: team._id,
            teamName: team.teamName,
            logo: team.logo || "",
            ageGroup: team.ageGroup || "",
          },
          statistics: item.statistics || {
            appearances: 0,
            goals: 0,
            assists: 0,
            cleanSheets: 0,
            yellowCards: 0,
            redCards: 0,
            minutesPlayed: 0,
          },
          category: pObj.category || null,
          rating: pObj.rating || null,
        });
      });
    }

    return res.status(200).json({
      success: true,
      totalTeams: teams.length,
      totalPlayers: allTeamPlayers.length,
      players: allTeamPlayers,
    });
  } catch (err) {
    return res.status(err.statusCode || (err.code === 11000 || err.name === "VersionError" ? 409 : err.name === "ValidationError" || err.name === "CastError" ? 400 : 500)).json({
      success: false,
      message: err.code === 11000 ? "This team name already exists in the selected term, or a team is already scheduled in this round." : err.name === "VersionError" ? "This match changed while you were editing. Refresh and try again." : err.message,
    });
  }
};

exports.unassignPlayerFromTeam = async (req, res) => {
  try {
    const { teamId } = req.params;
    let rawIds = req.body?.playerId || req.body?.playerIds || req.body?.players || req.query?.playerId || req.query?.playerIds;

    if (!rawIds) {
      return res.status(400).json({ success: false, message: "Player ID(s) required" });
    }

    if (typeof rawIds === "string") {
      try {
        const parsed = JSON.parse(rawIds);
        rawIds = parsed;
      } catch (e) {
        // rawIds is a single string ID
      }
    }

    const idList = Array.isArray(rawIds) ? rawIds : [rawIds];
    const normalizedIds = idList
      .map((item) => {
        if (item && typeof item === "object") {
          return (item.playerId || item.player || item._id || item.id || "").toString().trim();
        }
        return (item || "").toString().trim();
      })
      .filter(Boolean);

    if (normalizedIds.length === 0) {
      return res.status(400).json({ success: false, message: "Player ID(s) required" });
    }

    const isValid = normalizedIds.every((id) => mongoose.Types.ObjectId.isValid(id));
    if (!isValid) {
      return res.status(400).json({ success: false, message: "Invalid player ID format" });
    }

    const team = await Team.findById(teamId);
    if (!team) {
      return res.status(404).json({ success: false, message: "Team not found" });
    }

    const leagueId = req.body?.leagueId || req.body?.league || req.query?.leagueId || req.query?.league || req.params?.leagueId;

    if (leagueId) {
      if (!mongoose.Types.ObjectId.isValid(leagueId)) {
        return res.status(400).json({ success: false, message: "Invalid League ID format" });
      }

      if (!Array.isArray(team.leagues)) {
        team.leagues = [];
      }

      const leagueEntry = team.leagues.find(
        (l) => (l.league?._id || l.league)?.toString() === leagueId.toString()
      );

      if (!leagueEntry) {
        return res.status(404).json({ success: false, message: "League not found in team leagues" });
      }

      if (!Array.isArray(leagueEntry.players)) {
        leagueEntry.players = [];
      }

      const originalLeaguePlayersLength = leagueEntry.players.length;
      leagueEntry.players = leagueEntry.players.filter((p) => {
        const pid = (p.player?._id || p.player || p)?.toString();
        return !normalizedIds.includes(pid);
      });

      team.markModified("leagues");
      await team.save();

      const updatedTeam = await Team.findById(teamId)
        .populate("players.player", "firstName lastName fullName email mobile profileImage")
        .populate("leagues.players.player", "firstName lastName fullName email mobile profileImage");

      return res.json({
        success: true,
        message: `${originalLeaguePlayersLength - leagueEntry.players.length} player(s) unassigned from league successfully`,
        data: updatedTeam || team,
      });
    }

    // Previous behavior when no leagueId is provided (unassign from master team)
    if (team.captain && normalizedIds.includes(team.captain.toString())) {
      team.captain = null;
    }
    if (team.viceCaptain && normalizedIds.includes(team.viceCaptain.toString())) {
      team.viceCaptain = null;
    }

    const originalLength = (team.players || []).length;
    team.players = (team.players || []).filter((p) => {
      const pid = (p.player?._id || p.player || p)?.toString();
      return !normalizedIds.includes(pid);
    });

    // Also remove from any enrolled leagues to prevent dangling references
    if (Array.isArray(team.leagues)) {
      team.leagues.forEach((l) => {
        if (Array.isArray(l.players)) {
          l.players = l.players.filter((p) => {
            const pid = (p.player?._id || p.player || p)?.toString();
            return !normalizedIds.includes(pid);
          });
        }
      });
      team.markModified("leagues");
    }

    await team.save();

    const updatedTeam = await Team.findById(teamId)
      .populate("players.player", "firstName lastName fullName email mobile profileImage")
      .populate("leagues.players.player", "firstName lastName fullName email mobile profileImage");

    return res.json({
      success: true,
      message: `${originalLength - team.players.length} player(s) unassigned from team successfully`,
      data: updatedTeam || team,
    });
  } catch (err) {
    return res.status(err.statusCode || (err.code === 11000 || err.name === "VersionError" ? 409 : err.name === "ValidationError" || err.name === "CastError" ? 400 : 500)).json({ success: false, message: err.message });
  }
};

exports.updateTeam = async (req, res) => {
  let previousLogo = null;
  let logoSaved = false;
  try {
    const { teamId } = req.params;
    const {
      teamName,
      coach,
      assistantCoach,
      ageGroup,
      captain,
      viceCaptain,
      players,
      teamType,
      teamFee,
      fee,
      term,
      dayOfWeek,
      startTime,
      endTime,
      venue,
      location,
      scheduleType,
      schedule,
    } = req.body;

    if (!mongoose.Types.ObjectId.isValid(teamId)) {
      return res.status(400).json({ success: false, message: "Invalid Team ID format" });
    }

    const team = await Team.findById(teamId);
    if (!team) {
      return res.status(404).json({ success: false, message: "Team not found" });
    }

    if (team.archivedAt) throw domainError("Archived teams cannot be modified.", 409);
    if (term !== undefined && entityId(term) !== entityId(team.term)) throw domainError("A team belongs to one term. Clone it to create an independent team in another term.", 409);
    if (dayOfWeek !== undefined) team.dayOfWeek = dayOfWeek;
    if (startTime !== undefined) team.startTime = startTime;
    if (endTime !== undefined) team.endTime = endTime;
    if (venue !== undefined) team.venue = venue;
    if (location !== undefined) team.location = location;
    if (scheduleType !== undefined) team.scheduleType = scheduleType;
    if (schedule !== undefined) team.schedule = schedule;

    if (
      req.body.round !== undefined ||
      req.body.date !== undefined ||
      req.body.dates !== undefined ||
      req.body.sessionDates !== undefined
    ) {
      const { round: parsedRound, sessionDates: parsedDates, hasRoundsOrDates } = parseRoundAndDates(req.body);
      if (hasRoundsOrDates) {
        if (req.body.round !== undefined) team.round = parsedRound;
        if (req.body.date !== undefined || req.body.dates !== undefined || req.body.sessionDates !== undefined) {
          team.sessionDates = parsedDates;
        }
      }
    }

    if (teamName !== undefined) {
      const trimmedName = teamName.trim();
      if (!trimmedName) {
        return res.status(400).json({ success: false, message: "Team name cannot be empty" });
      }

      const duplicateTeam = await Team.findOne({
        _id: { $ne: teamId },
        term: team.term,
        $or: [{ normalizedName: normalizeTeamName(trimmedName) }, { teamName: { $regex: `^${escapeRegex(trimmedName)}$`, $options: "i" } }],
      });
      if (duplicateTeam) {
        return res.status(409).json({ success: false, message: "Another team already exists with this name" });
      }
      team.teamName = trimmedName;
    }

    if (teamType !== undefined) {
      const upperType = teamType.toUpperCase();
      if (!["INTERNAL", "EXTERNAL"].includes(upperType)) {
        return res.status(400).json({ success: false, message: "Invalid teamType. Must be INTERNAL or EXTERNAL" });
      }
      team.teamType = upperType;
    }

    const providedFee = fee !== undefined ? fee : teamFee;
    if (providedFee !== undefined) {
      const numFee = Number(providedFee);
      if (isNaN(numFee) || numFee < 0) {
        return res.status(400).json({ success: false, message: "Team fee must be a non-negative number" });
      }
      team.teamFee = numFee;
    }

    if (req.file) {
      previousLogo = team.logo;
      team.logo = `uploads/teamlogos/${req.file.filename}`;
    }

    if (coach !== undefined) {
      if (coach) {
        if (!mongoose.Types.ObjectId.isValid(coach)) {
          return res.status(400).json({ success: false, message: "Invalid Coach ID format" });
        }
        const coachDoc = await Admin.findById(coach);
        if (!coachDoc || coachDoc.role !== "COACH") {
          return res.status(400).json({ success: false, message: "Coach not found or invalid role" });
        }
        team.coach = coach;
      } else {
        team.coach = null;
      }
    }

    if (assistantCoach !== undefined) {
      if (assistantCoach) {
        if (!mongoose.Types.ObjectId.isValid(assistantCoach)) {
          return res.status(400).json({ success: false, message: "Invalid Assistant Coach ID format" });
        }
        const assistantCoachDoc = await Admin.findById(assistantCoach);
        if (!assistantCoachDoc || assistantCoachDoc.role !== "COACH") {
          return res.status(400).json({ success: false, message: "Assistant Coach not found or invalid role" });
        }
        team.assistantCoach = assistantCoach;
      } else {
        team.assistantCoach = null;
      }
    }

    if (ageGroup !== undefined) {
      team.ageGroup = ageGroup || "";
    }

    if (captain !== undefined) {
      if (captain) {
        if (!mongoose.Types.ObjectId.isValid(captain)) {
          return res.status(400).json({ success: false, message: "Invalid Captain ID format" });
        }
        const captainDoc = await User.findById(captain);
        if (!captainDoc) {
          return res.status(400).json({ success: false, message: "Captain player not found" });
        }
        team.captain = captain;
      } else {
        team.captain = null;
      }
    }

    if (viceCaptain !== undefined) {
      if (viceCaptain) {
        if (!mongoose.Types.ObjectId.isValid(viceCaptain)) {
          return res.status(400).json({ success: false, message: "Invalid Vice Captain ID format" });
        }
        const viceCaptainDoc = await User.findById(viceCaptain);
        if (!viceCaptainDoc) {
          return res.status(400).json({ success: false, message: "Vice Captain player not found" });
        }
        team.viceCaptain = viceCaptain;
      } else {
        team.viceCaptain = null;
      }
    }
    if (players !== undefined) {
      let rawPlayerList = players;
      if (typeof rawPlayerList === "string") {
        try {
          rawPlayerList = JSON.parse(rawPlayerList);
        } catch (e) {
          rawPlayerList = [];
        }
      }
      const playerList = Array.isArray(rawPlayerList) ? rawPlayerList : [rawPlayerList];
      if (playerList.length > 20) {
        return res.status(400).json({ success: false, message: "A team cannot have more than 20 players" });
      }

      const playerIds = playerList.map(item => item && item.player ? item.player : item);
      const isValid = playerIds.every(id => mongoose.Types.ObjectId.isValid(id));
      if (!isValid) {
        return res.status(400).json({ success: false, message: "Invalid player ID format inside players array" });
      }

      const existingPlayersCount = await User.countDocuments({ _id: { $in: playerIds } });
      if (existingPlayersCount !== playerIds.length) {
        return res.status(400).json({ success: false, message: "One or more players in the array do not exist" });
      }

      const existingMap = new Map();
      (team.players || []).forEach((p) => {
        const pid = p.player ? p.player.toString() : p.toString();
        existingMap.set(pid, {
          paymentStatus: p.paymentStatus || "TRIAL",
          statistics: p.statistics ? {
            appearances: Number(p.statistics.appearances) || 0,
            goals: Number(p.statistics.goals) || 0,
            assists: Number(p.statistics.assists) || 0,
            cleanSheets: Number(p.statistics.cleanSheets) || 0,
            yellowCards: Number(p.statistics.yellowCards) || 0,
            redCards: Number(p.statistics.redCards) || 0,
            minutesPlayed: Number(p.statistics.minutesPlayed) || 0,
          } : {
            appearances: 0,
            goals: 0,
            assists: 0,
            cleanSheets: 0,
            yellowCards: 0,
            redCards: 0,
            minutesPlayed: 0,
          },
        });
      });

      team.players = playerList.map((item) => {
        const id = item && item.player ? item.player : item;
        const idStr = id.toString();
        const prev = existingMap.get(idStr);
        const paymentStatus = (item && item.paymentStatus) || prev?.paymentStatus || "TRIAL";
        const stats = (item && item.statistics) ? {
          appearances: Number(item.statistics.appearances) || 0,
          goals: Number(item.statistics.goals) || 0,
          assists: Number(item.statistics.assists) || 0,
          cleanSheets: Number(item.statistics.cleanSheets) || 0,
          yellowCards: Number(item.statistics.yellowCards) || 0,
          redCards: Number(item.statistics.redCards) || 0,
          minutesPlayed: Number(item.statistics.minutesPlayed) || 0,
        } : (prev?.statistics || {
          appearances: 0,
          goals: 0,
          assists: 0,
          cleanSheets: 0,
          yellowCards: 0,
          redCards: 0,
          minutesPlayed: 0,
        });

        return {
          player: id,
          paymentStatus,
          statistics: stats,
        };
      });
    }

    await team.save();
    logoSaved = true;
    if (previousLogo && previousLogo !== team.logo) await safeRemoveTeamLogo(previousLogo);

    return res.status(200).json({
      success: true,
      message: "Team updated successfully",
      data: team,
    });
  } catch (err) {
    return res.status(err.statusCode || (err.code === 11000 || err.name === "VersionError" ? 409 : err.name === "ValidationError" || err.name === "CastError" ? 400 : 500)).json({
      success: false,
      message: err.code === 11000 ? "This team name already exists in the selected term, or a team is already scheduled in this round." : err.name === "VersionError" ? "This match changed while you were editing. Refresh and try again." : err.message,
    });
  } finally {
    if (req.file && !logoSaved) await safeRemoveTeamLogo(`uploads/teamlogos/${req.file.filename}`);
  }
};

exports.deleteTeam = async (req, res) => {
  try {
    const { teamId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(teamId)) throw domainError("Invalid team ID.");
    const team = await Team.findById(teamId);
    if (!team) throw domainError("Team not found.", 404);
    if (!team.archivedAt) { team.archivedAt = new Date(); await team.save(); }
    return res.status(200).json({ success: true, message: "Team archived. Historical matches, attendance, payments and league references are preserved." });
  } catch (err) { return res.status(err.statusCode || 500).json({ success: false, message: err.message }); }
};

exports.createTeamTemporaryPlayers = async (req, res) => {
  try {
    const { teamId } = req.params;
    const adminId = req.admin?._id || null;

    if (!mongoose.Types.ObjectId.isValid(teamId)) {
      return res.status(400).json({ success: false, message: "Invalid Team ID format" });
    }

    const team = await Team.findById(teamId);
    if (!team) {
      return res.status(404).json({ success: false, message: "Team not found" });
    }

    let parsedBody = req.body;
    if (typeof req.body.players === "string") {
      try {
        parsedBody = JSON.parse(req.body.players);
      } catch (e) {
      }
    } else if (typeof req.body === "string") {
      try {
        parsedBody = JSON.parse(req.body);
      } catch (e) {
      }
    }

    const rawList = Array.isArray(parsedBody)
      ? parsedBody
      : Array.isArray(parsedBody.players)
        ? parsedBody.players
        : [parsedBody];

    if (!rawList.length || !rawList[0].name) {
      return res.status(400).json({ success: false, message: "At least one temporary player object with a 'name' is required" });
    }

    const uploadedFiles = Array.isArray(req.files)
      ? req.files
      : req.file
        ? [req.file]
        : [];

    const newTemporaryPlayers = [];

    rawList.forEach((p, index) => {
      let imagePath = "";
      if (uploadedFiles[index]) {
        imagePath = `uploads/profiles/${uploadedFiles[index].filename}`;
      } else if (uploadedFiles[0] && rawList.length === 1) {
        imagePath = `uploads/profiles/${uploadedFiles[0].filename}`;
      } else {
        imagePath = (p.profileImage || req.body.profileImage || "").trim();
      }

      const tempPlayerDoc = {
        name: (p.name || "").trim(),
        jerseyNumber: p.jerseyNumber !== undefined ? (Number(p.jerseyNumber) || null) : null,
        profileImage: imagePath,
        position: (p.position || req.body.position || "").trim(),
        statistics: {
          appearances: Number(p.statistics?.appearances || p.appearances || 0),
          goals: Number(p.statistics?.goals || p.goals || 0),
          assists: Number(p.statistics?.assists || p.assists || 0),
          cleanSheets: Number(p.statistics?.cleanSheets || p.cleanSheets || 0),
          yellowCards: Number(p.statistics?.yellowCards || p.yellowCards || 0),
          redCards: Number(p.statistics?.redCards || p.redCards || 0),
          minutesPlayed: Number(p.statistics?.minutesPlayed || p.minutesPlayed || 0),
        },
        createdBy: adminId,
      };

      team.temporaryPlayers.push(tempPlayerDoc);
      newTemporaryPlayers.push(team.temporaryPlayers[team.temporaryPlayers.length - 1]);
    });

    await team.save();

    return res.status(201).json({
      success: true,
      message: `${newTemporaryPlayers.length} temporary player(s) added successfully`,
      data: newTemporaryPlayers,
    });
  } catch (err) {
    return res.status(err.statusCode || (err.code === 11000 || err.name === "VersionError" ? 409 : err.name === "ValidationError" || err.name === "CastError" ? 400 : 500)).json({ success: false, message: err.message });
  }
};

exports.getTeamTemporaryPlayers = async (req, res) => {
  try {
    const { teamId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(teamId)) {
      return res.status(400).json({ success: false, message: "Invalid Team ID format" });
    }

    const team = await Team.findById(teamId).select("temporaryPlayers");
    if (!team) {
      return res.status(404).json({ success: false, message: "Team not found" });
    }

    return res.status(200).json({
      success: true,
      count: (team.temporaryPlayers || []).length,
      data: team.temporaryPlayers || [],
    });
  } catch (err) {
    return res.status(err.statusCode || (err.code === 11000 || err.name === "VersionError" ? 409 : err.name === "ValidationError" || err.name === "CastError" ? 400 : 500)).json({ success: false, message: err.message });
  }
};

exports.updateTeamTemporaryPlayer = async (req, res) => {
  try {
    const { teamId, tempPlayerId } = req.params;
    const { name, jerseyNumber, profileImage, position, statistics } = req.body;

    if (!mongoose.Types.ObjectId.isValid(teamId) || !mongoose.Types.ObjectId.isValid(tempPlayerId)) {
      return res.status(400).json({ success: false, message: "Invalid ID format" });
    }

    const team = await Team.findById(teamId);
    if (!team) {
      return res.status(404).json({ success: false, message: "Team not found" });
    }

    const tempPlayer = team.temporaryPlayers.id(tempPlayerId);
    if (!tempPlayer) {
      return res.status(404).json({ success: false, message: "Temporary player not found for this team" });
    }

    if (name !== undefined) {
      const trimmed = name.trim();
      if (!trimmed) {
        return res.status(400).json({ success: false, message: "Name cannot be empty" });
      }
      tempPlayer.name = trimmed;
    }

    if (jerseyNumber !== undefined) {
      tempPlayer.jerseyNumber = jerseyNumber !== null ? (Number(jerseyNumber) || null) : null;
    }

    if (req.file) {
      if (tempPlayer.profileImage) {
        const oldPath = path.join(__dirname, "..", tempPlayer.profileImage);
        fs.unlink(oldPath, (err) => {
          if (err && err.code !== "ENOENT") {
            console.error("Failed to delete old temporary player profile image:", err);
          }
        });
      }
      tempPlayer.profileImage = `uploads/profiles/${req.file.filename}`;
    } else if (profileImage !== undefined) {
      const trimmed = profileImage ? profileImage.trim() : "";
      if (tempPlayer.profileImage && tempPlayer.profileImage !== trimmed) {
        const oldPath = path.join(__dirname, "..", tempPlayer.profileImage);
        fs.unlink(oldPath, (err) => {
          if (err && err.code !== "ENOENT") {
            console.error("Failed to delete old temporary player profile image:", err);
          }
        });
      }
      tempPlayer.profileImage = trimmed;
    }

    if (position !== undefined) {
      tempPlayer.position = position ? position.trim() : "";
    }

    if (statistics && typeof statistics === "object") {
      tempPlayer.statistics = {
        appearances: statistics.appearances !== undefined ? Number(statistics.appearances) : tempPlayer.statistics.appearances,
        goals: statistics.goals !== undefined ? Number(statistics.goals) : tempPlayer.statistics.goals,
        assists: statistics.assists !== undefined ? Number(statistics.assists) : tempPlayer.statistics.assists,
        cleanSheets: statistics.cleanSheets !== undefined ? Number(statistics.cleanSheets) : tempPlayer.statistics.cleanSheets,
        yellowCards: statistics.yellowCards !== undefined ? Number(statistics.yellowCards) : tempPlayer.statistics.yellowCards,
        redCards: statistics.redCards !== undefined ? Number(statistics.redCards) : tempPlayer.statistics.redCards,
        minutesPlayed: statistics.minutesPlayed !== undefined ? Number(statistics.minutesPlayed) : tempPlayer.statistics.minutesPlayed,
      };
    }

    await team.save();

    return res.status(200).json({
      success: true,
      message: "Temporary player updated successfully",
      data: tempPlayer,
    });
  } catch (err) {
    return res.status(err.statusCode || (err.code === 11000 || err.name === "VersionError" ? 409 : err.name === "ValidationError" || err.name === "CastError" ? 400 : 500)).json({ success: false, message: err.message });
  }
};

exports.deleteTeamTemporaryPlayer = async (req, res) => {
  try {
    const { teamId, tempPlayerId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(teamId) || !mongoose.Types.ObjectId.isValid(tempPlayerId)) {
      return res.status(400).json({ success: false, message: "Invalid ID format" });
    }

    const team = await Team.findById(teamId);
    if (!team) {
      return res.status(404).json({ success: false, message: "Team not found" });
    }

    const tempPlayer = team.temporaryPlayers.id(tempPlayerId);
    if (!tempPlayer) {
      return res.status(404).json({ success: false, message: "Temporary player not found for this team" });
    }

    if (tempPlayer.profileImage) {
      const oldPath = path.join(__dirname, "..", tempPlayer.profileImage);
      fs.unlink(oldPath, (err) => {
        if (err && err.code !== "ENOENT") {
          console.error("Failed to delete temporary player profile image on deletion:", err);
        }
      });
    }

    team.temporaryPlayers.pull({ _id: tempPlayerId });
    await team.save();

    return res.status(200).json({
      success: true,
      message: "Temporary player deleted successfully",
    });
  } catch (err) {
    return res.status(err.statusCode || (err.code === 11000 || err.name === "VersionError" ? 409 : err.name === "ValidationError" || err.name === "CastError" ? 400 : 500)).json({ success: false, message: err.message });
  }
};

exports.getAdminLeagueData = async (req, res) => {
  try {
    const { leagueId } = req.params;
    const { tab, round } = req.query;

    if (!mongoose.Types.ObjectId.isValid(leagueId)) {
      return res.status(400).json({ success: false, message: "Invalid League ID format" });
    }

    const league = await League.findById(leagueId).populate("term", "name year startDate endDate").populate({
      path: "teams",
      select: "teamName logo coach assistantCoach ageGroup teamType players leagues temporaryPlayers statistics",
      populate: [
        { path: "coach", select: "name email mobile profileImage" },
        { path: "assistantCoach", select: "name email mobile profileImage" },
      ],
    });

    if (!league) {
      return res.status(404).json({ success: false, message: "League not found" });
    }

    // Filter out any teams that were deleted from DB (where populate yielded null)
    league.teams = (league.teams || []).filter((t) => t && t._id);
    const enrolledTeamIds = league.teams.map((t) => t._id.toString());
    const enrolledTeamIdSet = new Set(enrolledTeamIds);

    // 1. Fetch standings for this league ONLY for currently enrolled teams
    const standingsDocs = await Standing.find({
      league: leagueId,
      team: { $in: enrolledTeamIds },
    })
      .populate({
        path: "team",
        select: "teamName logo coach assistantCoach ageGroup teamType players leagues temporaryPlayers statistics",
        populate: [
          { path: "coach", select: "name email mobile profileImage" },
          { path: "assistantCoach", select: "name email mobile profileImage" },
        ],
      })
      .sort({ points: -1, goalDifference: -1, goalsFor: -1 });

    const activeStandingsDocs = standingsDocs.filter((s) => s.team && s.team._id);

    const standingsMap = {};
    activeStandingsDocs.forEach((s) => {
      standingsMap[s.team._id.toString()] = s;
    });

    // 2. Fetch all fixtures for this league
    const fixtureFilter = { league: leagueId };
    if (round) {
      fixtureFilter.round = Number(round);
    }
    const rawFixtures = await Fixture.find(fixtureFilter)
      .populate("homeTeam", "teamName logo")
      .populate("awayTeam", "teamName logo")
      .populate("goals.scorer", "firstName lastName fullName profileImage")
      .populate("goals.assist", "firstName lastName fullName profileImage")
      .populate("goals.team", "teamName logo")
      .sort({ round: 1, kickoffTime: 1 });

    const allFixtures = rawFixtures.filter((fix) => {
      if (!fix.homeTeam || !fix.awayTeam) return false;
      if (fix.status !== "COMPLETED") {
        return (
          enrolledTeamIdSet.has(fix.homeTeam._id.toString()) &&
          enrolledTeamIdSet.has(fix.awayTeam._id.toString())
        );
      }
      return true;
    });

    // 3. Participating teams: strictly the enrolled teams of the league
    const participatingTeams = league.teams.map((t) => {
      const s = standingsMap[t._id.toString()];
      const leagueEntry = Array.isArray(t.leagues)
        ? t.leagues.find((l) => l.league && l.league.toString() === leagueId.toString())
        : null;
      const leagueStat = leagueEntry?.statistics;
      const record = s || leagueStat || { played: 0, won: 0, drawn: 0, lost: 0, goalsFor: 0, goalsAgainst: 0, goalDifference: 0, points: 0 };

      const playersCount =
        (Array.isArray(t.players) ? t.players.length : 0) +
        (Array.isArray(t.temporaryPlayers) ? t.temporaryPlayers.length : 0);

      return {
        _id: t._id,
        teamName: t.teamName,
        logo: t.logo || "",
        ageGroup: t.ageGroup || "",
        teamType: t.teamType || "INTERNAL",
        coach: t.coach
          ? {
            _id: t.coach._id,
            name: t.coach.name,
            email: t.coach.email,
            mobile: t.coach.mobile,
            profileImage: t.coach.profileImage,
          }
          : null,
        assistantCoach: t.assistantCoach
          ? {
            _id: t.assistantCoach._id,
            name: t.assistantCoach.name,
            email: t.assistantCoach.email,
          }
          : null,
        playersCount,
        status: leagueEntry?.status === "WITHDRAWN" ? "INACTIVE" : leagueEntry?.status || "ACTIVE",
        record: {
          played: record.played || 0,
          won: record.won || 0,
          drawn: record.drawn || 0,
          lost: record.lost || 0,
          goalsFor: record.goalsFor || 0,
          goalsAgainst: record.goalsAgainst || 0,
          goalDifference: record.goalDifference || 0,
          points: record.points || 0,
        },
      };
    });

    // 4. Ladder / Standings with rank strictly for enrolled teams
    const ladderMap = new Map();
    activeStandingsDocs.forEach((s) => {
      ladderMap.set(s.team._id.toString(), {
        standingId: s._id,
        team: {
          _id: s.team._id,
          teamName: s.team.teamName || "Unknown Team",
          logo: s.team.logo || "",
        },
        played: s.played || 0,
        won: s.won || 0,
        drawn: s.drawn || 0,
        lost: s.lost || 0,
        goalsFor: s.goalsFor || 0,
        goalsAgainst: s.goalsAgainst || 0,
        goalDifference: s.goalDifference || 0,
        points: s.points || 0,
      });
    });

    // Ensure all participating teams are included in the ladder table
    participatingTeams.forEach((pt) => {
      if (!ladderMap.has(pt._id.toString())) {
        ladderMap.set(pt._id.toString(), {
          standingId: null,
          team: {
            _id: pt._id,
            teamName: pt.teamName,
            logo: pt.logo,
          },
          played: pt.record.played || 0,
          won: pt.record.won || 0,
          drawn: pt.record.drawn || 0,
          lost: pt.record.lost || 0,
          goalsFor: pt.record.goalsFor || 0,
          goalsAgainst: pt.record.goalsAgainst || 0,
          goalDifference: pt.record.goalDifference || 0,
          points: pt.record.points || 0,
        });
      }
    });

    const ladder = Array.from(ladderMap.values())
      .sort((a, b) => b.points - a.points || b.goalDifference - a.goalDifference || b.goalsFor - a.goalsFor)
      .map((item, index) => ({
        rank: index + 1,
        ...item,
      }));

    // 5. Schedule grouped by round
    const roundsMap = {};
    allFixtures.forEach((fix) => {
      const r = fix.round || 1;
      if (!roundsMap[r]) {
        roundsMap[r] = {
          round: r,
          roundName: `Round ${r}`,
          matches: [],
        };
      }

      const formattedGoals = Array.isArray(fix.goals)
        ? fix.goals.map((g) => {
          const teamIdStr = (g.team?._id || g.team)?.toString() || "";
          let teamName = g.team?.teamName || "";
          if (!teamName) {
            if (fix.homeTeam && (fix.homeTeam._id.toString() === teamIdStr)) {
              teamName = fix.homeTeam.teamName;
            } else if (fix.awayTeam && (fix.awayTeam._id.toString() === teamIdStr)) {
              teamName = fix.awayTeam.teamName;
            }
          }

          return {
            _id: g._id,
            teamId: teamIdStr,
            teamName,
            scorer: g.scorer
              ? {
                _id: g.scorer._id,
                firstName: g.scorer.firstName || "",
                lastName: g.scorer.lastName || "",
                fullName: g.scorer.fullName || [g.scorer.firstName, g.scorer.lastName].filter(Boolean).join(" "),
                profileImage: g.scorer.profileImage || "",
              }
              : null,
            assist: g.assist
              ? {
                _id: g.assist._id,
                firstName: g.assist.firstName || "",
                lastName: g.assist.lastName || "",
                fullName: g.assist.fullName || [g.assist.firstName, g.assist.lastName].filter(Boolean).join(" "),
                profileImage: g.assist.profileImage || "",
              }
              : null,
            minute: g.minute !== undefined ? Number(g.minute) : 0,
          };
        })
        : [];

      roundsMap[r].matches.push({
        _id: fix._id,
        version: fix.__v,
        round: r,
        kickoffTime: fix.kickoffTime,
        venue: fix.venue,
        referee: fix.referee,
        status: fix.status,
        homeTeam: fix.homeTeam
          ? { _id: fix.homeTeam._id, teamName: fix.homeTeam.teamName, logo: fix.homeTeam.logo }
          : null,
        awayTeam: fix.awayTeam
          ? { _id: fix.awayTeam._id, teamName: fix.awayTeam.teamName, logo: fix.awayTeam.logo }
          : null,
        score: fix.score || { homeScore: 0, awayScore: 0 },
        goals: formattedGoals,
        matchStatistics: fix.matchStatistics || {},
        field: fix.field || "Field 1",
        endTime: fix.endTime || null,
        group: fix.group || "",
        fixtureSource: fix.fixtureSource || "GENERATED",
        isManuallyModified: !!fix.isManuallyModified,
      });
    });
    const scheduleByRound = Object.values(roundsMap).sort((a, b) => a.round - b.round);

    // 6. League Statistics (KPIs, Results Distribution, Top Scorers)
    const completedFixtures = allFixtures.filter((f) => f.status === "COMPLETED");
    const totalTeams = participatingTeams.length;
    const totalMatches = allFixtures.length;
    const matchesPlayed = completedFixtures.length;
    const goalsScored = completedFixtures.reduce(
      (sum, f) => sum + (f.score?.homeScore || 0) + (f.score?.awayScore || 0),
      0
    );
    const avgGoalsPerMatch = matchesPlayed > 0 ? parseFloat((goalsScored / matchesPlayed).toFixed(1)) : 0;

    // Team vs Goals
    const teamGoalsMap = {};
    participatingTeams.forEach((t) => {
      teamGoalsMap[t._id.toString()] = {
        teamId: t._id,
        teamName: t.teamName,
        logo: t.logo,
        goals: 0,
      };
    });
    completedFixtures.forEach((f) => {
      const hId = f.homeTeam?._id?.toString();
      const aId = f.awayTeam?._id?.toString();
      if (hId && teamGoalsMap[hId]) teamGoalsMap[hId].goals += f.score?.homeScore || 0;
      if (aId && teamGoalsMap[aId]) teamGoalsMap[aId].goals += f.score?.awayScore || 0;
    });
    const teamVsGoals = Object.values(teamGoalsMap).sort((a, b) => b.goals - a.goals);
    const topScoringTeams = teamVsGoals.slice(0, 5);

    // Results Distribution (Decisive Wins > 1 goal, Competitive Games == 1 goal, Draws)
    let decisiveWins = 0;
    let draws = 0;
    let competitiveGames = 0;
    completedFixtures.forEach((f) => {
      const diff = Math.abs((f.score?.homeScore || 0) - (f.score?.awayScore || 0));
      if (diff === 0) draws++;
      else if (diff === 1) competitiveGames++;
      else decisiveWins++;
    });

    const resultsDistribution = {
      decisiveWins,
      draws,
      competitiveGames,
      totalCompleted: matchesPlayed,
    };

    // Compute Player Leaderboards from completed fixtures & player statistics
    const playerTelemetryMap = {};

    completedFixtures.forEach((f) => {
      if (Array.isArray(f.goals)) {
        f.goals.forEach((g) => {
          // Scorer
          if (g.scorer && g.scorer._id) {
            const pId = g.scorer._id.toString();
            const teamIdStr = (g.team?._id || g.team)?.toString() || "";
            const teamNameStr = g.team?.teamName || (f.homeTeam?._id?.toString() === teamIdStr ? f.homeTeam?.teamName : f.awayTeam?.teamName) || "Team";
            const teamLogoStr = g.team?.logo || (f.homeTeam?._id?.toString() === teamIdStr ? f.homeTeam?.logo : f.awayTeam?.logo) || "";

            if (!playerTelemetryMap[pId]) {
              playerTelemetryMap[pId] = {
                playerId: pId,
                playerName: g.scorer.fullName || [g.scorer.firstName, g.scorer.lastName].filter(Boolean).join(" ") || "Player",
                profileImage: g.scorer.profileImage || "",
                teamId: teamIdStr,
                teamName: teamNameStr,
                teamLogo: teamLogoStr,
                goals: 0,
                assists: 0,
                appearances: 0,
                totalPoints: 0,
              };
            }
            playerTelemetryMap[pId].goals += 1;
            playerTelemetryMap[pId].totalPoints += 1;
          }

          // Assist
          if (g.assist && g.assist._id) {
            const pId = g.assist._id.toString();
            const teamIdStr = (g.team?._id || g.team)?.toString() || "";
            const teamNameStr = g.team?.teamName || (f.homeTeam?._id?.toString() === teamIdStr ? f.homeTeam?.teamName : f.awayTeam?.teamName) || "Team";
            const teamLogoStr = g.team?.logo || (f.homeTeam?._id?.toString() === teamIdStr ? f.homeTeam?.logo : f.awayTeam?.logo) || "";

            if (!playerTelemetryMap[pId]) {
              playerTelemetryMap[pId] = {
                playerId: pId,
                playerName: g.assist.fullName || [g.assist.firstName, g.assist.lastName].filter(Boolean).join(" ") || "Player",
                profileImage: g.assist.profileImage || "",
                teamId: teamIdStr,
                teamName: teamNameStr,
                teamLogo: teamLogoStr,
                goals: 0,
                assists: 0,
                appearances: 0,
                totalPoints: 0,
              };
            }
            playerTelemetryMap[pId].assists += 1;
            playerTelemetryMap[pId].totalPoints += 1;
          }
        });
      }
    });

    try {
      const dbPlayerStats = await PlayerStatistics.find({ league: leagueId })
        .populate("player", "fullName firstName lastName profileImage")
        .populate("team", "teamName logo");

      dbPlayerStats.forEach((ps) => {
        if (!ps.player || !ps.player._id) return;
        const pId = ps.player._id.toString();
        if (!playerTelemetryMap[pId]) {
          playerTelemetryMap[pId] = {
            playerId: pId,
            playerName: ps.player.fullName || [ps.player.firstName, ps.player.lastName].filter(Boolean).join(" ") || "Player",
            profileImage: ps.player.profileImage || "",
            teamId: ps.team?._id?.toString() || "",
            teamName: ps.team?.teamName || "Team",
            teamLogo: ps.team?.logo || "",
            goals: ps.goals || 0,
            assists: ps.assists || 0,
            appearances: ps.appearances || 0,
            totalPoints: (ps.goals || 0) + (ps.assists || 0),
          };
        } else {
          playerTelemetryMap[pId].goals = ps.goals || 0;
          playerTelemetryMap[pId].assists = ps.assists || 0;
          playerTelemetryMap[pId].appearances = Math.max(playerTelemetryMap[pId].appearances, ps.appearances || 0);
          playerTelemetryMap[pId].totalPoints = playerTelemetryMap[pId].goals + playerTelemetryMap[pId].assists;
        }
      });
    } catch (e) { throw e; }

    const allPlayerStatsList = Object.values(playerTelemetryMap);

    const topScorers = [...allPlayerStatsList]
      .filter((p) => p.goals > 0)
      .sort((a, b) => b.goals - a.goals || b.assists - a.assists)
      .slice(0, 10);

    const topAssists = [...allPlayerStatsList]
      .filter((p) => p.assists > 0)
      .sort((a, b) => b.assists - a.assists || b.goals - a.goals)
      .slice(0, 10);

    const topPerformers = [...allPlayerStatsList]
      .filter((p) => p.totalPoints > 0)
      .sort((a, b) => b.totalPoints - a.totalPoints || b.goals - a.goals)
      .slice(0, 10);

    // 7. Visual Analytics & Trends (Graphs)
    // Goals Per Round Trend
    const roundGoalsMap = {};
    completedFixtures.forEach((f) => {
      const r = f.round || 1;
      const g = (f.score?.homeScore || 0) + (f.score?.awayScore || 0);
      roundGoalsMap[r] = (roundGoalsMap[r] || 0) + g;
    });
    const goalsPerRoundTrend = Object.keys(roundGoalsMap)
      .map((r) => ({
        round: Number(r),
        roundLabel: `Round ${r}`,
        totalGoals: roundGoalsMap[r],
      }))
      .sort((a, b) => a.round - b.round);

    // Points Progression across Rounds
    const sortedRounds = Array.from(new Set(allFixtures.map((f) => f.round || 1))).sort((a, b) => a - b);
    const cumulativePoints = {};
    participatingTeams.forEach((t) => {
      cumulativePoints[t._id.toString()] = 0;
    });

    const pointsProgression = participatingTeams.map((t) => ({
      teamId: t._id,
      teamName: t.teamName,
      logo: t.logo,
      progression: [],
    }));

    const winPts = league.pointsForWin ?? 3;
    const drawPts = league.pointsForDraw ?? 1;

    sortedRounds.forEach((r) => {
      const roundMatches = completedFixtures.filter((f) => (f.round || 1) === r);
      roundMatches.forEach((f) => {
        const hId = f.homeTeam?._id?.toString();
        const aId = f.awayTeam?._id?.toString();
        const hs = f.score?.homeScore || 0;
        const as = f.score?.awayScore || 0;

        if (hs > as) {
          if (cumulativePoints[hId] !== undefined) cumulativePoints[hId] += winPts;
        } else if (as > hs) {
          if (cumulativePoints[aId] !== undefined) cumulativePoints[aId] += winPts;
        } else {
          if (cumulativePoints[hId] !== undefined) cumulativePoints[hId] += drawPts;
          if (cumulativePoints[aId] !== undefined) cumulativePoints[aId] += drawPts;
        }
      });

      pointsProgression.forEach((p) => {
        p.progression.push({
          round: r,
          roundLabel: `R${r}`,
          points: cumulativePoints[p.teamId.toString()] || 0,
        });
      });
    });

    // Team Win Efficiency Index
    const teamWinEfficiency = participatingTeams
      .map((t) => {
        const p = t.record.played;
        const w = t.record.won;
        return {
          teamId: t._id,
          teamName: t.teamName,
          logo: t.logo,
          played: p,
          won: w,
          winEfficiency: p > 0 ? Math.round((w / p) * 100) : 0,
        };
      })
      .sort((a, b) => b.winEfficiency - a.winEfficiency);

    // Consolidated full response
    const fullData = {
      league: {
        _id: league._id,
        name: league.name,
        season: league.season,
        term: league.term,
        venue: league.venue,
        fee: league.fee,
        teams: league.teams.map((team) => ({ _id: team._id, teamName: team.teamName, logo: team.logo })),
        sessionDates: (league.sessionDates || []).map((date) => dateOnly(date)),
        logo: league.logo,
        description: league.description,
        type: league.type,
        status: league.status,
        startDate: dateOnly(league.startDate),
        endDate: dateOnly(league.endDate),
        registrationStartDate: dateOnly(league.registrationStartDate),
        registrationEndDate: dateOnly(league.registrationEndDate),
        visibility: league.visibility,
        pointsForWin: league.pointsForWin,
        pointsForDraw: league.pointsForDraw,
        allowDraws: league.allowDraws,
        automaticLadderRecalculation: league.automaticLadderRecalculation,
        fixtureFormat: league.fixtureFormat || "ROUND_ROBIN",
        numberOfRounds: league.numberOfRounds || 1,
        matchDuration: league.matchDuration || 90,
        breakBetweenMatches: league.breakBetweenMatches ?? 15,
        numberOfFields: league.numberOfFields || 1,
        startTime: league.startTime || "10:00",
        fixtureGenerated: !!league.fixtureGenerated,
        generationType: league.generationType || "MANUAL",
        groupCount: league.groupCount || 1,
        groups: league.groups || [],
      },
      kpis: {
        totalTeams,
        totalMatches,
        matchesPlayed,
        goalsScored,
        avgGoalsPerMatch,
      },
      ladder,
      schedule: scheduleByRound,
      fixtures: allFixtures,
      teams: participatingTeams,
      teamManagement: participatingTeams,
      stats: {
        totalTeams,
        totalMatches,
        matchesPlayed,
        goalsScored,
        avgGoalsPerMatch,
        teamVsGoals,
        resultsDistribution,
        topScoringTeams,
        topScorers,
        topAssists,
        topPerformers,
      },
      graphs: {
        pointsProgression,
        goalsPerRoundTrend,
        teamWinEfficiency,
      },
      details: {
        _id: league._id,
        name: league.name,
        season: league.season,
        term: league.term,
        venue: league.venue,
        fee: league.fee,
        teams: league.teams.map((team) => ({ _id: team._id, teamName: team.teamName, logo: team.logo })),
        sessionDates: (league.sessionDates || []).map((date) => dateOnly(date)),
        logo: league.logo,
        description: league.description,
        type: league.type,
        status: league.status,
        startDate: dateOnly(league.startDate),
        endDate: dateOnly(league.endDate),
        registrationStartDate: dateOnly(league.registrationStartDate),
        registrationEndDate: dateOnly(league.registrationEndDate),
        visibility: league.visibility,
        pointsForWin: league.pointsForWin,
        pointsForDraw: league.pointsForDraw,
        allowDraws: league.allowDraws,
        automaticLadderRecalculation: league.automaticLadderRecalculation,
      },
    };

    const normalizedTab = tab ? tab.toLowerCase().replace(/[-_]/g, "") : null;
    const tabMapping = {
      ladder: fullData.ladder,
      schedule: fullData.schedule,
      teams: fullData.teams,
      stats: fullData.stats,
      graphs: fullData.graphs,
      details: fullData.details,
      teammanagement: fullData.teamManagement,
    };

    if (normalizedTab && tabMapping[normalizedTab]) {
      return res.status(200).json({
        success: true,
        message: `League ${tab} data fetched successfully`,
        data: tabMapping[normalizedTab],
      });
    }

    return res.status(200).json({
      success: true,
      message: "League data fetched successfully",
      data: fullData,
    });
  } catch (err) {
    return res.status(err.statusCode || (err.code === 11000 || err.name === "VersionError" ? 409 : err.name === "ValidationError" || err.name === "CastError" ? 400 : 500)).json({ success: false, message: err.message });
  }
};

exports.updateLeague = async (req, res) => {
  let session;
  let saved = false;
  let oldLogo;
  try {
    const { leagueId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(leagueId)) throw domainError("Invalid league ID.");
    session = await mongoose.startSession();
    session.startTransaction();
    await League.updateOne({ _id: leagueId }, { $inc: { schedulingRevision: 1 } }, { session });
    const league = await League.findById(leagueId).session(session);
    if (!league || league.archivedAt) throw domainError("League not found.", 404);
    const body = req.body;
    if (body.term !== undefined && entityId(body.term) !== entityId(league.term)) throw domainError("League term cannot change. Clone this league into the target term.", 409);
    for (const key of ["name", "season", "description", "venue"]) if (body[key] !== undefined) league[key] = String(body[key]).trim();
    if (!league.name || !league.season) throw domainError("Name and season are required.");
    if (await League.exists({ _id: { $ne: leagueId }, name: league.name, season: league.season }).session(session)) throw domainError("League already exists for this season.", 409);
    for (const key of ["startDate", "endDate", "registrationStartDate", "registrationEndDate"]) if (body[key] !== undefined) {
      league[key] = body[key] ? parseDateToMidnight(body[key]) : null;
      if (body[key] && !league[key]) throw domainError(`Invalid ${key}.`);
    }
    if (!league.startDate || !league.endDate || league.endDate < league.startDate) throw domainError("Valid ordered start and end dates are required.");
    if (league.registrationStartDate && league.registrationEndDate && league.registrationEndDate < league.registrationStartDate) throw domainError("Registration end must follow registration start.");
    for (const key of ["numberOfRounds", "groupCount", "numberOfFields", "matchDuration"]) if (body[key] !== undefined) {
      if (!Number.isInteger(Number(body[key])) || Number(body[key]) < 1) throw domainError(`${key} must be a positive integer.`);
      league[key] = Number(body[key]);
    }
    for (const key of ["fee", "pointsForWin", "pointsForDraw", "breakBetweenMatches"]) if (body[key] !== undefined) {
      if (!Number.isFinite(Number(body[key])) || Number(body[key]) < 0) throw domainError(`${key} must be non-negative.`);
      league[key] = Number(body[key]);
    }
    for (const key of ["allowDraws", "automaticLadderRecalculation"]) if (body[key] !== undefined) {
      if (![true, false, "true", "false"].includes(body[key])) throw domainError(`${key} must be boolean.`);
      league[key] = body[key] === true || body[key] === "true";
    }
    const enums = { status: ["UPCOMING", "ACTIVE", "COMPLETED"], visibility: ["PUBLIC", "PRIVATE"], fixtureFormat: ["ROUND_ROBIN", "GROUP", "KNOCKOUT"], generationType: ["AUTOMATIC", "MANUAL"] };
    for (const [key, choices] of Object.entries(enums)) if (body[key] !== undefined) {
      const value = String(body[key]).toUpperCase();
      if (!choices.includes(value)) throw domainError(`Invalid ${key}.`);
      league[key] = value;
    }
    const type = body.type || body.leagueType || body.competitionScope;
    if (type !== undefined) {
      if (!["INTERNATIONAL", "NATIONAL", "STATE", "LOCAL", "OTHERS"].includes(String(type).toUpperCase())) throw domainError("Invalid league type.");
      league.type = String(type).toUpperCase();
    }
    if (body.startTime !== undefined) {
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(body.startTime)) throw domainError("Start time must use HH:mm.");
      league.startTime = body.startTime;
    }
    const parseArray = (value, field) => {
      try { const parsed = typeof value === "string" ? JSON.parse(value) : value; if (!Array.isArray(parsed)) throw new Error(); return parsed; }
      catch { throw domainError(`${field} must be an array.`); }
    };
    if (body.sessionDates !== undefined) {
      league.sessionDates = parseArray(body.sessionDates, "sessionDates").map((value) => { const date = parseDateToMidnight(value); if (!date) throw domainError("Every session date must be valid."); return date; });
    }
    if (league.sessionDates.length && league.sessionDates.length !== league.numberOfRounds) throw domainError("Provide exactly one session date per round.");
    if (league.sessionDates.some((date) => date < league.startDate || date > league.endDate)) throw domainError("Session dates must stay within league dates.");
    const previousIds = (league.teams || []).map(entityId);
    if (body.teams !== undefined) {
      const ids = parseArray(body.teams, "teams").map(entityId);
      if (ids.some((id) => !mongoose.Types.ObjectId.isValid(id)) || new Set(ids).size !== ids.length) throw domainError("Every team ID must be valid and distinct.");
      const teams = await Team.find({ _id: { $in: ids } }).session(session);
      if (teams.length !== ids.length) throw domainError("Selected team not found.");
      assertTeamLeagueScope(league, teams, false);
      league.teams = ids;
    }
    const nextIds = (league.teams || []).map(entityId);
    const removed = previousIds.filter((id) => !nextIds.includes(id));
    if (removed.length && await Fixture.exists({ league: leagueId, $or: [{ homeTeam: { $in: removed } }, { awayTeam: { $in: removed } }] }).session(session)) throw domainError("Cannot remove teams referenced by fixtures. Historical matches must be preserved.", 409);
    if (body.groups !== undefined) league.groups = parseArray(body.groups, "groups");
    const grouped = new Set();
    for (const group of league.groups || []) for (const team of group.teams || []) {
      if (!nextIds.includes(entityId(team)) || grouped.has(entityId(team))) throw domainError("Groups must contain enrolled teams once only.");
      grouped.add(entityId(team));
    }
    if (await Fixture.exists({ league: leagueId, round: { $gt: league.numberOfRounds } }).session(session)) throw domainError("Round count cannot exclude existing fixtures.", 409);
    if (await Fixture.exists({ league: leagueId, field: { $nin: Array.from({ length: league.numberOfFields }, (_, i) => `Field ${i + 1}`) } }).session(session)) throw domainError("Field count cannot exclude existing fixtures. Update fixtures first.", 409);
    if (req.file) { oldLogo = league.logo; league.logo = `/uploads/leaguelogos/${req.file.filename}`; }
    await league.save({ session });
    await syncTeamsLeagueData({ teamIds: league.teams, leagueId, teamFee: league.fee, round: league.numberOfRounds, sessionDates: league.sessionDates, groups: league.groups, sessionOption: { session } });
    if (removed.length) {
      await Team.updateMany({ _id: { $in: removed } }, { $pull: { leagues: { league: leagueId } } }, { session });
      await Standing.deleteMany({ league: leagueId, team: { $in: removed }, played: 0 }, { session });
    }
    for (const teamId of nextIds.filter((id) => !previousIds.includes(id))) {
      await Standing.updateOne({ league: leagueId, team: teamId }, { $setOnInsert: { played: 0 } }, { upsert: true, session });
      if (league.fee > 0) await processLeagueInvoicesForTeam({ leagueId, teamId, session });
    }
    if (league.automaticLadderRecalculation) await recalculateLeagueStandings(leagueId, session);
    await session.commitTransaction();
    saved = true;
    if (oldLogo) await safeRemoveLeagueLogo(oldLogo);
    const data = await League.findById(leagueId).populate("teams", "teamName logo");
    return res.json({ success: true, message: "League updated successfully.", data });
  } catch (error) {
    if (session?.inTransaction()) await session.abortTransaction();
    return res.status(error.statusCode || ([11000, 112, 251].includes(error.code) ? 409 : error.name === "ValidationError" ? 400 : 500)).json({ success: false, message: error.message });
  } finally {
    if (session) await session.endSession();
    if (req.file && !saved) await safeRemoveLeagueLogo(`/uploads/leaguelogos/${req.file.filename}`);
  }
};

exports.addTeamToLeague = async (req, res) => {
  let session;
  try {
    const { leagueId } = req.params;
    const ids = [...new Set([req.body.teamId, ...(Array.isArray(req.body.teamIds) ? req.body.teamIds : [])].filter(Boolean).map(entityId))];
    if (!mongoose.Types.ObjectId.isValid(leagueId) || !ids.length || ids.some((id) => !mongoose.Types.ObjectId.isValid(id))) throw domainError("Select valid league and team IDs.");
    session = await mongoose.startSession(); session.startTransaction();
    await League.updateOne({ _id: leagueId }, { $inc: { schedulingRevision: 1 } }, { session });
    const league = await League.findById(leagueId).session(session);
    if (!league || league.archivedAt) throw domainError("League not found.", 404);
    const teams = await Team.find({ _id: { $in: ids } }).session(session);
    if (teams.length !== ids.length) throw domainError("Every selected team must exist.", 404);
    assertTeamLeagueScope(league, teams, false);
    const newIds = ids.filter((id) => !league.teams.some((team) => entityId(team) === id));
    league.teams = [...league.teams, ...newIds];
    await league.save({ session });
    await syncTeamsLeagueData({ teamIds: ids, leagueId, teamFee: league.fee, round: league.numberOfRounds, sessionDates: league.sessionDates, groups: league.groups, sessionOption: { session } });
    const assignedPlayerIds = teams.flatMap((team) => (team.players || []).map((entry) => entry.player?._id || entry.player).filter(Boolean));
    await activateAssignedPlayers(assignedPlayerIds, { session, assignedBy: req.admin?._id });
    for (const teamId of ids) {
      await Standing.updateOne({ league: leagueId, team: teamId }, { $setOnInsert: { played: 0 } }, { upsert: true, session });
      if (newIds.includes(teamId) && league.fee > 0) await processLeagueInvoicesForTeam({ leagueId, teamId, session });
    }
    await session.commitTransaction();
    return res.json({ success: true, message: "Teams enrolled successfully.", data: await League.findById(leagueId).populate("teams", "teamName logo") });
  } catch (error) {
    if (session?.inTransaction()) await session.abortTransaction();
    return res.status(error.statusCode || ([11000, 112, 251].includes(error.code) ? 409 : 500)).json({ success: false, message: error.message });
  } finally { if (session) await session.endSession(); }
};

exports.removeTeamFromLeague = async (req, res) => {
  let session;
  try {
    const { leagueId, teamId } = req.params;
    if (![leagueId, teamId].every(mongoose.Types.ObjectId.isValid)) throw domainError("Invalid league or team ID.");
    session = await mongoose.startSession(); session.startTransaction();
    await League.updateOne({ _id: leagueId }, { $inc: { schedulingRevision: 1 } }, { session });
    const league = await League.findById(leagueId).session(session);
    if (!league || league.archivedAt || !league.teams.some((team) => entityId(team) === teamId)) throw domainError("Team enrollment not found.", 404);
    if (await Fixture.exists({ league: leagueId, $or: [{ homeTeam: teamId }, { awayTeam: teamId }] }).session(session)) throw domainError("Cannot remove teams referenced by fixtures. Historical matches must be preserved.", 409);
    league.teams = league.teams.filter((team) => entityId(team) !== teamId);
    for (const group of league.groups || []) group.teams = group.teams.filter((team) => entityId(team) !== teamId);
    await league.save({ session });
    await Team.updateOne({ _id: teamId }, { $pull: { leagues: { league: leagueId } } }, { session });
    await Standing.deleteOne({ league: leagueId, team: teamId, played: 0 }, { session });
    await session.commitTransaction();
    return res.json({ success: true, message: "Team removed from league." });
  } catch (error) {
    if (session?.inTransaction()) await session.abortTransaction();
    return res.status(error.statusCode || ([112, 251].includes(error.code) ? 409 : 500)).json({ success: false, message: error.message });
  } finally { if (session) await session.endSession(); }
};

const recalculateLeagueStandings = async (leagueId, session = null) => {
  const league = await League.findById(leagueId).session(session);
  if (!league) return null;

  const pointsForWin = league.pointsForWin !== undefined ? Number(league.pointsForWin) : 3;
  const pointsForDraw = league.pointsForDraw !== undefined ? Number(league.pointsForDraw) : 1;

  const fixtureTeamsHome = await Fixture.find({ league: leagueId }).session(session).distinct("homeTeam");
  const fixtureTeamsAway = await Fixture.find({ league: leagueId }).session(session).distinct("awayTeam");
  const combinedTeamIds = new Set([
    ...(league.teams || []).map((t) => t.toString()),
    ...fixtureTeamsHome.map((t) => t.toString()),
    ...fixtureTeamsAway.map((t) => t.toString()),
  ]);

  const teamStats = {};
  combinedTeamIds.forEach((tId) => {
    teamStats[tId] = {
      played: 0,
      won: 0,
      drawn: 0,
      lost: 0,
      goalsFor: 0,
      goalsAgainst: 0,
      goalDifference: 0,
      points: 0,
    };
  });

  const completedFixtures = await Fixture.find({
    league: leagueId,
    status: "COMPLETED",
  }).session(session);

  completedFixtures.forEach((fix) => {
    const hId = fix.homeTeam?.toString();
    const aId = fix.awayTeam?.toString();
    const hs = Number(fix.score?.homeScore || 0);
    const as = Number(fix.score?.awayScore || 0);

    if (hId) {
      if (!teamStats[hId]) {
        teamStats[hId] = { played: 0, won: 0, drawn: 0, lost: 0, goalsFor: 0, goalsAgainst: 0, goalDifference: 0, points: 0 };
      }
      teamStats[hId].played += 1;
      teamStats[hId].goalsFor += hs;
      teamStats[hId].goalsAgainst += as;
      teamStats[hId].goalDifference = teamStats[hId].goalsFor - teamStats[hId].goalsAgainst;

      if (hs > as) {
        teamStats[hId].won += 1;
        teamStats[hId].points += pointsForWin;
      } else if (hs === as) {
        teamStats[hId].drawn += 1;
        teamStats[hId].points += pointsForDraw;
      } else {
        teamStats[hId].lost += 1;
      }
    }

    if (aId) {
      if (!teamStats[aId]) {
        teamStats[aId] = { played: 0, won: 0, drawn: 0, lost: 0, goalsFor: 0, goalsAgainst: 0, goalDifference: 0, points: 0 };
      }
      teamStats[aId].played += 1;
      teamStats[aId].goalsFor += as;
      teamStats[aId].goalsAgainst += hs;
      teamStats[aId].goalDifference = teamStats[aId].goalsFor - teamStats[aId].goalsAgainst;

      if (as > hs) {
        teamStats[aId].won += 1;
        teamStats[aId].points += pointsForWin;
      } else if (hs === as) {
        teamStats[aId].drawn += 1;
        teamStats[aId].points += pointsForDraw;
      } else {
        teamStats[aId].lost += 1;
      }
    }
  });

  const bulkOps = Object.keys(teamStats).map((tId) => ({
    updateOne: {
      filter: { league: leagueId, team: tId },
      update: { $set: teamStats[tId] },
      upsert: true,
    },
  }));

  if (bulkOps.length > 0) {
    await Standing.bulkWrite(bulkOps, session ? { session } : {});
  }

  const teamBulkOps = Object.keys(teamStats).map((tId) => ({
    updateOne: {
      filter: { _id: tId, "leagues.league": leagueId },
      update: { $set: { "leagues.$.statistics": teamStats[tId] } },
    },
  }));
  if (teamBulkOps.length > 0) {
    await Team.bulkWrite(teamBulkOps, session ? { session } : {});
  }

  return teamStats;
};

exports.recalculateLadder = async (req, res) => {
  let session;
  try {
    const { leagueId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(leagueId)) {
      return res.status(400).json({ success: false, message: "Invalid League ID format" });
    }

    const league = await League.findById(leagueId);
    if (!league) {
      return res.status(404).json({ success: false, message: "League not found" });
    }

    session = await mongoose.startSession(); session.startTransaction();
    await League.updateOne({ _id: leagueId }, { $inc: { schedulingRevision: 1 } }, { session });
    const teamStats = await recalculateLeagueStandings(leagueId, session);
    await session.commitTransaction();

    return res.status(200).json({
      success: true,
      message: "League ladder and statistics recalculated successfully",
      data: teamStats,
    });
  } catch (err) {
    if (session?.inTransaction()) await session.abortTransaction();
    return res.status(err.statusCode || (err.code === 11000 || err.name === "VersionError" ? 409 : err.name === "ValidationError" || err.name === "CastError" ? 400 : 500)).json({ success: false, message: err.message });
  } finally { if (session) await session.endSession(); }
};

// Helper: Calculate team contribution for a match
const calculateMatchTeamContribution = (gf, ga, leagueDoc) => {
  const pointsForWin = leagueDoc?.pointsForWin !== undefined ? Number(leagueDoc.pointsForWin) : 3;
  const pointsForDraw = (leagueDoc?.allowDraws !== false && leagueDoc?.pointsForDraw !== undefined)
    ? Number(leagueDoc.pointsForDraw)
    : (leagueDoc?.allowDraws === false ? 0 : 1);

  let won = 0;
  let drawn = 0;
  let lost = 0;
  let points = 0;

  if (gf > ga) {
    won = 1;
    points = pointsForWin;
  } else if (gf < ga) {
    lost = 1;
    points = 0;
  } else {
    if (leagueDoc?.allowDraws !== false) {
      drawn = 1;
      points = pointsForDraw;
    }
  }

  return {
    played: 1,
    won,
    drawn,
    lost,
    goalsFor: gf,
    goalsAgainst: ga,
    goalDifference: gf - ga,
    points,
  };
};

const getZeroTeamContribution = () => ({
  played: 0,
  won: 0,
  drawn: 0,
  lost: 0,
  goalsFor: 0,
  goalsAgainst: 0,
  goalDifference: 0,
  points: 0,
});

const checkPlayerBelongsToTeam = (playerId, teamDoc) => {
  if (!playerId || !teamDoc) return false;
  const pStr = playerId.toString();
  if (Array.isArray(teamDoc.players) && teamDoc.players.some((p) => (p.player?._id || p.player)?.toString() === pStr)) {
    return true;
  }
  if (Array.isArray(teamDoc.leagues) && teamDoc.leagues.some((l) =>
    Array.isArray(l.players) && l.players.some((p) => (p.player?._id || p.player)?.toString() === pStr)
  )) {
    return true;
  }
  if ((teamDoc.captain?._id || teamDoc.captain)?.toString() === pStr) return true;
  if ((teamDoc.viceCaptain?._id || teamDoc.viceCaptain)?.toString() === pStr) return true;
  return false;
};

exports.updateFixture = async (req, res) => {
  try {
    const matchId = req.params.fixtureId || req.params.matchId;

    if (!mongoose.Types.ObjectId.isValid(matchId)) {
      return res.status(400).json({ success: false, message: "Invalid Match ID format" });
    }

    const match = await Fixture.findById(matchId);
    if (!match) {
      return res.status(404).json({ success: false, message: "Fixture not found" });
    }

    if (req.params.leagueId && entityId(match.league) !== req.params.leagueId) throw domainError("Fixture does not belong to the specified league.", 404);
    if (req.body.league && entityId(req.body.league) !== entityId(match.league)) throw domainError("Fixture league cannot change.");
    if (req.body.version !== undefined && Number(req.body.version) !== match.__v) throw domainError("This match has changed. Refresh before saving.", 409);

    // 1. Capture OLD state (league must NEVER change)
    const oldLeague = match.league;
    const oldHomeTeam = match.homeTeam;
    const oldAwayTeam = match.awayTeam;
    const oldHomeScore = Number(match.score?.homeScore ?? 0);
    const oldAwayScore = Number(match.score?.awayScore ?? 0);
    const oldStatus = match.status || "SCHEDULED";
    const oldGoals = Array.isArray(match.goals)
      ? match.goals.map((g) => ({
        _id: g._id,
        team: (g.team?._id || g.team)?.toString(),
        scorer: (g.scorer?._id || g.scorer)?.toString(),
        assist: (g.assist?._id || g.assist)?.toString() || null,
        minute: g.minute !== undefined ? Number(g.minute) : 0,
      }))
      : [];

    const {
      homeScore,
      awayScore,
      score,
      status,
      round,
      kickoffTime,
      endTime,
      venue,
      field,
      group,
      referee,
      homeTeam,
      awayTeam,
      matchStatistics,
      goals,
      players,
      playerStatuses,
    } = req.body;

    let isScheduleModified = false;

    // 2. Resolve NEW scores
    const newHomeScore = homeScore !== undefined
      ? Number(homeScore)
      : score?.homeScore !== undefined
        ? Number(score.homeScore)
        : oldHomeScore;

    const newAwayScore = awayScore !== undefined
      ? Number(awayScore)
      : score?.awayScore !== undefined
        ? Number(score.awayScore)
        : oldAwayScore;

    if (!Number.isInteger(newHomeScore) || newHomeScore < 0 || !Number.isInteger(newAwayScore) || newAwayScore < 0) {
      return res.status(400).json({ success: false, message: "Scores must be non-negative numbers" });
    }

    const scoreChanged = newHomeScore !== oldHomeScore || newAwayScore !== oldAwayScore;

    // Score submission finalizes even a 0-0 result; explicit LIVE remains a draft.
    const hasResult = homeScore != null || awayScore != null || score?.homeScore != null || score?.awayScore != null;
    if (status && !["SCHEDULED", "LIVE", "COMPLETED", "POSTPONED"].includes(String(status).toUpperCase())) throw domainError("Invalid fixture status.");
    const newStatus = req.body.finalize === true ? "COMPLETED" : status ? String(status).toUpperCase() : hasResult ? "COMPLETED" : oldStatus;
    const newHomeTeam = homeTeam !== undefined ? entityId(homeTeam) : entityId(oldHomeTeam);
    const newAwayTeam = awayTeam !== undefined ? entityId(awayTeam) : entityId(oldAwayTeam);
    if (![newHomeTeam, newAwayTeam].every(mongoose.Types.ObjectId.isValid)) throw domainError("Invalid team ID.");
    if (["COMPLETED", "LIVE"].includes(oldStatus) && (newHomeTeam !== entityId(oldHomeTeam) || newAwayTeam !== entityId(oldAwayTeam))) throw domainError("Teams cannot change after a match starts. Correct the result or create a separate fixture.", 409);
    if (newHomeTeam.toString() === newAwayTeam.toString()) {
      return res.status(400).json({ success: false, message: "Home team and away team cannot be the same" });
    }

    const [leagueDoc, homeTeamDoc, awayTeamDoc] = await Promise.all([
      League.findById(oldLeague),
      Team.findById(newHomeTeam),
      Team.findById(newAwayTeam),
    ]);

    if (!leagueDoc) {
      return res.status(404).json({ success: false, message: "Associated league not found" });
    }
    if (!homeTeamDoc || !awayTeamDoc) {
      return res.status(404).json({ success: false, message: "One or both teams not found" });
    }

    if (leagueDoc.archivedAt) throw domainError("Archived league cannot be modified.", 409);
    assertTeamLeagueScope(leagueDoc, [homeTeamDoc, awayTeamDoc]);
    const timing = validateFixtureSchedule(leagueDoc, { round: round ?? match.round, kickoffTime: kickoffTime || match.kickoffTime, endTime: endTime || (kickoffTime ? null : match.endTime), field: field || match.field || "Field 1" });
    const conflict = await Fixture.exists({ _id: { $ne: matchId }, league: oldLeague, round: timing.round, $or: [{ homeTeam: { $in: [newHomeTeam, newAwayTeam] } }, { awayTeam: { $in: [newHomeTeam, newAwayTeam] } }] });
    if (conflict) throw domainError("A selected team is already scheduled in this round.", 409);
    if (await Fixture.exists({ _id: { $ne: matchId }, league: oldLeague, field: timing.field, kickoffTime: { $lt: timing.endTime }, endTime: { $gt: timing.kickoffTime } })) throw domainError("This field is already booked at that time.", 409);
    if (newStatus === "COMPLETED" && !leagueDoc.allowDraws && newHomeScore === newAwayScore) throw domainError("Draws are disabled for this league.");
    if (Array.isArray(players || playerStatuses)) {
      for (const item of players || playerStatuses) {
        const targetId = entityId(item.teamId || item.team);
        if (targetId && ![newHomeTeam, newAwayTeam].includes(targetId)) throw domainError("Player changes must target a participating team.");
        const pId = entityId(item.playerId || item.player);
        const rosterTeam = targetId === newHomeTeam ? homeTeamDoc : targetId === newAwayTeam ? awayTeamDoc : null;
        if (!mongoose.Types.ObjectId.isValid(pId) || !(rosterTeam ? checkPlayerBelongsToTeam(pId, rosterTeam) : checkPlayerBelongsToTeam(pId, homeTeamDoc) || checkPlayerBelongsToTeam(pId, awayTeamDoc))) throw domainError("Player must belong to a participating team.");
      }
    }
    // 5. Validate goals
    const goalsProvided = goals !== undefined;
    let effectiveNewGoals = oldGoals;

    if (goalsProvided) {
      if (!Array.isArray(goals)) {
        return res.status(400).json({ success: false, message: "Goals must be an array" });
      }

      const homeTeamStr = newHomeTeam.toString();
      const awayTeamStr = newAwayTeam.toString();
      const validatedGoals = [];

      for (let i = 0; i < goals.length; i++) {
        const g = goals[i];
        const gTeamId = (g.teamId || g.team)?.toString();
        const scorerId = (g.scorerId || g.scorer?._id || g.scorer)?.toString();
        const rawAssist = g.assistId !== undefined ? g.assistId : (g.assist?._id || g.assist);
        const assistId = (rawAssist && String(rawAssist).trim().length > 0) ? String(rawAssist).trim() : null;
        const minute = Number(g.minute);

        if (!gTeamId || (gTeamId !== homeTeamStr && gTeamId !== awayTeamStr)) {
          return res.status(400).json({
            success: false,
            message: `Goal at index ${i}: Invalid team. Must be either home team (${homeTeamStr}) or away team (${awayTeamStr})`,
          });
        }

        if (isNaN(minute) || minute < 0) {
          return res.status(400).json({
            success: false,
            message: `Goal at index ${i}: Minute must be a non-negative number`,
          });
        }

        if (!scorerId || !mongoose.Types.ObjectId.isValid(scorerId)) {
          return res.status(400).json({
            success: false,
            message: `Goal at index ${i}: Invalid or missing scorer ID`,
          });
        }

        const scoringTeamDoc = gTeamId === homeTeamStr ? homeTeamDoc : awayTeamDoc;
        if (!checkPlayerBelongsToTeam(scorerId, scoringTeamDoc)) {
          return res.status(400).json({
            success: false,
            message: `Goal at index ${i}: Scorer ${scorerId} does not belong to team ${gTeamId}`,
          });
        }

        if (assistId) {
          if (!mongoose.Types.ObjectId.isValid(assistId)) {
            return res.status(400).json({
              success: false,
              message: `Goal at index ${i}: Invalid assist ID`,
            });
          }
          if (!checkPlayerBelongsToTeam(assistId, scoringTeamDoc)) {
            return res.status(400).json({
              success: false,
              message: `Goal at index ${i}: Assist ${assistId} does not belong to team ${gTeamId}`,
            });
          }
        }

        validatedGoals.push({
          team: gTeamId,
          scorer: scorerId,
          assist: assistId || null,
          minute,
        });
      }

      // Check goal counts against score when status is COMPLETED
      if (newStatus === "COMPLETED") {
        const homeGoalsCount = validatedGoals.filter((g) => g.team === homeTeamStr).length;
        const awayGoalsCount = validatedGoals.filter((g) => g.team === awayTeamStr).length;

        if (homeGoalsCount !== newHomeScore || awayGoalsCount !== newAwayScore) {
          return res.status(400).json({
            success: false,
            message: `Goal count does not match the score. Expected home: ${newHomeScore} (got ${homeGoalsCount}), away: ${newAwayScore} (got ${awayGoalsCount})`,
          });
        }
      }

      effectiveNewGoals = validatedGoals;
    }

    const oldResultPlayers = (match.resultPlayers || []).map((row) => row.toObject ? row.toObject() : row);
    const metricPlayers = req.body.resultPlayers !== undefined ? req.body.resultPlayers : Array.isArray(players) && players.some((row) => [...PLAYER_STAT_KEYS, "rating", "cleanSheet"].some((key) => row[key] !== undefined)) ? players : undefined;
    let newResultPlayers = oldResultPlayers;
    if (metricPlayers !== undefined) {
      if (!Array.isArray(metricPlayers)) throw domainError("Result players must be an array.");
      const seen = new Set();
      newResultPlayers = metricPlayers.map((row) => {
        const player = entityId(row.playerId || row.player);
        if (seen.has(player)) throw domainError("Each player may appear only once in a result.");
        seen.add(player);
        const team = checkPlayerBelongsToTeam(player, homeTeamDoc) ? newHomeTeam : checkPlayerBelongsToTeam(player, awayTeamDoc) ? newAwayTeam : null;
        if (!mongoose.Types.ObjectId.isValid(player) || !team) throw domainError("Result player must belong to a participating team.");
        const stats = Object.fromEntries(PLAYER_STAT_KEYS.map((key) => [key, Number(key === "appearances" ? row[key] ?? 1 : key === "cleanSheets" ? row[key] ?? (row.cleanSheet ? 1 : 0) : row[key] ?? 0)]));
        if (Object.values(stats).some((value) => !Number.isInteger(value) || value < 0) || stats.appearances > 1 || stats.cleanSheets > 1) throw domainError("Player result statistics must be non-negative integers; appearances and clean sheets must be 0 or 1.");
        return { player, team, ...stats };
      });
    }
    // 6. Calculate Team Contributions (OLD vs NEW)
    const oldTeamContribs = {};
    if (oldStatus === "COMPLETED") {
      oldTeamContribs[oldHomeTeam.toString()] = calculateMatchTeamContribution(oldHomeScore, oldAwayScore, leagueDoc);
      oldTeamContribs[oldAwayTeam.toString()] = calculateMatchTeamContribution(oldAwayScore, oldHomeScore, leagueDoc);
    }

    const newTeamContribs = {};
    if (newStatus === "COMPLETED") {
      newTeamContribs[newHomeTeam.toString()] = calculateMatchTeamContribution(newHomeScore, newAwayScore, leagueDoc);
      newTeamContribs[newAwayTeam.toString()] = calculateMatchTeamContribution(newAwayScore, newHomeScore, leagueDoc);
    }

    const allAffectedTeamIds = new Set([
      ...Object.keys(oldTeamContribs),
      ...Object.keys(newTeamContribs),
    ]);

    const teamDeltas = {};
    for (const tId of allAffectedTeamIds) {
      const o = oldTeamContribs[tId] || getZeroTeamContribution();
      const n = newTeamContribs[tId] || getZeroTeamContribution();
      teamDeltas[tId] = {
        played: n.played - o.played,
        won: n.won - o.won,
        drawn: n.drawn - o.drawn,
        lost: n.lost - o.lost,
        goalsFor: n.goalsFor - o.goalsFor,
        goalsAgainst: n.goalsAgainst - o.goalsAgainst,
        goalDifference: n.goalDifference - o.goalDifference,
        points: n.points - o.points,
      };
    }

    const playerDeltas = contributionDeltas({ status: oldStatus, goals: oldGoals, resultPlayers: oldResultPlayers }, { status: newStatus, goals: effectiveNewGoals, resultPlayers: newResultPlayers });

    // 8. Execute updates within a MongoDB session/transaction if supported
    let session = null;
    let useSession = false;
    try {
      session = await mongoose.startSession();
      session.startTransaction();
      useSession = true;
    } catch (sessionErr) {
      if (session) await session.endSession();
      throw domainError("Match changes require a transactional database connection.", 503);
    }
    const sessionOption = useSession ? { session } : {};

    try {
      await League.updateOne({ _id: oldLeague }, { $inc: { schedulingRevision: 1 } }, sessionOption);
      if (await Fixture.exists({ _id: { $ne: matchId }, league: oldLeague, round: timing.round, $or: [{ homeTeam: { $in: [newHomeTeam, newAwayTeam] } }, { awayTeam: { $in: [newHomeTeam, newAwayTeam] } }] }).session(session)) throw domainError("A selected team is already scheduled in this round.", 409);
      if (await Fixture.exists({ _id: { $ne: matchId }, league: oldLeague, field: timing.field, kickoffTime: { $lt: timing.endTime }, endTime: { $gt: timing.kickoffTime } }).session(session)) throw domainError("This field is already booked at that time.", 409);
      // A. Update Fixture fields
      match.score.homeScore = newHomeScore;
      match.score.awayScore = newAwayScore;
      match.status = newStatus;
      match.resultPlayers = newResultPlayers;
      match.homeTeam = newHomeTeam;
      match.awayTeam = newAwayTeam;
      match.participants = [newHomeTeam, newAwayTeam];
      match.round = timing.round;
      match.kickoffTime = timing.kickoffTime;
      match.endTime = timing.endTime;
      match.field = timing.field;

      if (round !== undefined && !isNaN(Number(round))) {
        match.round = Math.max(1, parseInt(round, 10));
        isScheduleModified = true;
      }
      if (kickoffTime) {
        match.kickoffTime = new Date(kickoffTime);
        isScheduleModified = true;
      }
      if (endTime !== undefined) {
        match.endTime = timing.endTime;
        isScheduleModified = true;
      }
      if (venue) {
        match.venue = venue.trim();
        isScheduleModified = true;
      }
      if (field !== undefined) {
        match.field = String(field).trim();
        isScheduleModified = true;
      }
      if (group !== undefined) {
        match.group = String(group).trim();
        isScheduleModified = true;
      }
      if (referee !== undefined) match.referee = referee.trim();

      if (req.body.sessionDate) {
        match.sessionDate = parseDateToMidnight(req.body.sessionDate);
        if (!match.sessionDate) throw domainError("Invalid session date.");
        isScheduleModified = true;
      }
      if (isScheduleModified) {
        match.fixtureSource = "MANUAL";
        match.isManuallyModified = true;
      }

      // Merge matchStatistics without erasing omitted fields
      if (matchStatistics && typeof matchStatistics === "object") {
        const existingStats = match.matchStatistics?.toObject ? match.matchStatistics.toObject() : (match.matchStatistics || {});
        match.matchStatistics = {
          ...existingStats,
          ...matchStatistics,
        };
      }

      if (goalsProvided) {
        match.goals = effectiveNewGoals;
      }

      await match.save(sessionOption);

      // B. Update Team League Statistics using DELTA ($inc)
      for (const tId of allAffectedTeamIds) {
        const delta = teamDeltas[tId];
        const hasDelta = Object.values(delta).some((v) => v !== 0);
        if (!hasDelta) continue;

        const teamWithLeague = await Team.findOne({ _id: tId, "leagues.league": oldLeague }).session(session || null);
        if (teamWithLeague) {
          await Team.updateOne(
            { _id: tId, "leagues.league": oldLeague },
            {
              $inc: {
                "leagues.$.statistics.played": delta.played,
                "leagues.$.statistics.won": delta.won,
                "leagues.$.statistics.drawn": delta.drawn,
                "leagues.$.statistics.lost": delta.lost,
                "leagues.$.statistics.goalsFor": delta.goalsFor,
                "leagues.$.statistics.goalsAgainst": delta.goalsAgainst,
                "leagues.$.statistics.goalDifference": delta.goalDifference,
                "leagues.$.statistics.points": delta.points,
              },
            },
            sessionOption
          );
        } else {
          // If team not yet enrolled, push league entry with initial delta
          await Team.updateOne(
            { _id: tId },
            {
              $push: {
                leagues: {
                  league: oldLeague,
                  status: "ACTIVE",
                  statistics: {
                    played: Math.max(0, delta.played),
                    won: Math.max(0, delta.won),
                    drawn: Math.max(0, delta.drawn),
                    lost: Math.max(0, delta.lost),
                    goalsFor: Math.max(0, delta.goalsFor),
                    goalsAgainst: Math.max(0, delta.goalsAgainst),
                    goalDifference: delta.goalDifference,
                    points: Math.max(0, delta.points),
                  },
                },
              },
            },
            sessionOption
          );
        }

        // Also atomically update Standing for this league
        await Standing.findOneAndUpdate(
          { league: oldLeague, team: tId },
          {
            $inc: {
              played: delta.played,
              won: delta.won,
              drawn: delta.drawn,
              lost: delta.lost,
              goalsFor: delta.goalsFor,
              goalsAgainst: delta.goalsAgainst,
              goalDifference: delta.goalDifference,
              points: delta.points,
            },
            $setOnInsert: { group: match.group || "" },
          },
          { upsert: true, new: true, ...sessionOption }
        );
      }

      // C. Update User Global Statistics using DELTA ($inc) via bulkWrite
      const userBulkOps = [];
      for (const [pId, delta] of Object.entries(playerDeltas)) {
        const inc = {};
        for (const key of PLAYER_STAT_KEYS) if (delta[key]) inc[`statistics.${key}`] = delta[key];

        if (Object.keys(inc).length > 0) {
          userBulkOps.push({
            updateOne: {
              filter: { _id: pId },
              update: { $inc: inc },
            },
          });
        }
      }
      if (userBulkOps.length > 0) {
        await User.bulkWrite(userBulkOps, sessionOption);
      }

      // D. Update PlayerStatistics (league-specific) using DELTA
      const playerStatsOps = [];
      for (const [pId, delta] of Object.entries(playerDeltas)) {
        const inc = {};
        for (const key of PLAYER_STAT_KEYS) if (delta[key]) inc[key] = delta[key];

        if (Object.keys(inc).length > 0) {
          const goalMatch = effectiveNewGoals.find((g) => g.scorer === pId || g.assist === pId)
            || oldGoals.find((g) => g.scorer === pId || g.assist === pId);
          const pTeamId = newResultPlayers.find((row) => entityId(row.player) === pId)?.team || oldResultPlayers.find((row) => entityId(row.player) === pId)?.team || goalMatch?.team || newHomeTeam;

          playerStatsOps.push({
            updateOne: {
              filter: { player: pId, league: oldLeague },
              update: {
                $inc: inc,
                $set: { team: pTeamId },
                $setOnInsert: Object.fromEntries(PLAYER_STAT_KEYS.filter((key) => !Object.prototype.hasOwnProperty.call(inc, key)).map((key) => [key, 0])),
              },
              upsert: true,
            },
          });
        }
      }
      if (playerStatsOps.length > 0) {
        await PlayerStatistics.bulkWrite(playerStatsOps, sessionOption);
      }

      // E. Update league-specific player status/paymentStatus if provided
      const incomingPlayerStatuses = players || playerStatuses;
      if (Array.isArray(incomingPlayerStatuses)) {
        for (const item of incomingPlayerStatuses) {
          const pId = item.playerId || item.player;
          const pStatus = item.status;
          const pPaymentStatus = item.paymentStatus;
          const targetTeamId = item.teamId || item.team;

          if (pId && mongoose.Types.ObjectId.isValid(pId)) {
            const teamFilter = targetTeamId
              ? { _id: targetTeamId, "leagues.league": oldLeague }
              : { _id: { $in: [newHomeTeam, newAwayTeam] }, "leagues.league": oldLeague };

            const teamsToUpdate = await Team.find(teamFilter).session(session || null);
            for (const tDoc of teamsToUpdate) {
              const lEntry = tDoc.leagues.find((l) => l.league.toString() === oldLeague.toString());
              if (lEntry) {
                if (!Array.isArray(lEntry.players)) lEntry.players = [];
                const existingP = lEntry.players.find((p) => (p.player?._id || p.player)?.toString() === pId.toString());
                if (existingP) {
                  if (pStatus) existingP.status = pStatus;
                  if (pPaymentStatus) existingP.paymentStatus = pPaymentStatus;
                } else {
                  lEntry.players.push({
                    player: pId,
                    paymentStatus: pPaymentStatus || "UNPAID",
                    status: pStatus || "ACTIVE",
                  });
                }
                await tDoc.save(sessionOption);
              }
            }
          }
        }
      }

      if (useSession && session) {
        await session.commitTransaction();
      }
    } catch (txErr) {
      if (useSession && session) {
        try {
          await session.abortTransaction();
        } catch (abortErr) {
          console.error("Failed to abort transaction in updateFixture:", abortErr.message);
        }
      }
      throw txErr;
    } finally {
      if (session) {
        session.endSession();
      }
    }

    // 9. Fetch populated updated fixture
    const updatedMatch = await Fixture.findById(match._id)
      .populate("league", "name season")
      .populate("homeTeam", "teamName logo")
      .populate("awayTeam", "teamName logo")
      .populate("goals.scorer", "firstName lastName fullName profileImage")
      .populate("goals.assist", "firstName lastName fullName profileImage")
      .populate("goals.team", "teamName logo");

    const formattedMatch = updatedMatch.toObject();
    formattedMatch.goals = Array.isArray(formattedMatch.goals)
      ? formattedMatch.goals.map((g) => {
        const teamIdStr = (g.team?._id || g.team)?.toString() || "";
        let teamName = g.team?.teamName || "";
        if (!teamName) {
          if (formattedMatch.homeTeam && formattedMatch.homeTeam._id.toString() === teamIdStr) {
            teamName = formattedMatch.homeTeam.teamName;
          } else if (formattedMatch.awayTeam && formattedMatch.awayTeam._id.toString() === teamIdStr) {
            teamName = formattedMatch.awayTeam.teamName;
          }
        }

        return {
          _id: g._id,
          teamId: teamIdStr,
          teamName,
          scorer: g.scorer
            ? {
              _id: g.scorer._id,
              firstName: g.scorer.firstName || "",
              lastName: g.scorer.lastName || "",
              fullName: g.scorer.fullName || [g.scorer.firstName, g.scorer.lastName].filter(Boolean).join(" "),
              profileImage: g.scorer.profileImage || "",
            }
            : null,
          assist: g.assist
            ? {
              _id: g.assist._id,
              firstName: g.assist.firstName || "",
              lastName: g.assist.lastName || "",
              fullName: g.assist.fullName || [g.assist.firstName, g.assist.lastName].filter(Boolean).join(" "),
              profileImage: g.assist.profileImage || "",
            }
            : null,
          minute: g.minute !== undefined ? Number(g.minute) : 0,
        };
      })
      : [];

    return res.status(200).json({
      success: true,
      message: "Fixture updated successfully",
      data: formattedMatch,
    });
  } catch (err) {
    return res.status(err.statusCode || ([11000, 112, 251].includes(err.code) || err.name === "VersionError" ? 409 : err.name === "ValidationError" || err.name === "CastError" ? 400 : 500)).json({ success: false, message: err.code === 11000 ? "A selected team is already scheduled in this round." : err.name === "VersionError" ? "This match changed while you were editing. Refresh and try again." : err.message });
  }
};

const hasRecordedMatchActivity = (match) => ["LIVE", "COMPLETED"].includes(match.status) || match.events?.length || match.goals?.length || match.playerRatings?.length || match.resultPlayers?.length || Number(match.score?.homeScore || 0) > 0 || Number(match.score?.awayScore || 0) > 0;

exports.deleteFixture = async (req, res) => {
  let session;
  try {
    const matchId = req.params.fixtureId || req.params.matchId;
    if (!mongoose.Types.ObjectId.isValid(matchId)) throw domainError("Invalid fixture ID.");
    const preview = await Fixture.findById(matchId).select("league");
    if (!preview || (req.params.leagueId && entityId(preview.league) !== req.params.leagueId)) throw domainError("Fixture not found in the selected league.", 404);
    session = await mongoose.startSession(); session.startTransaction();
    await League.updateOne({ _id: preview.league }, { $inc: { schedulingRevision: 1 } }, { session });
    const match = await Fixture.findById(matchId).session(session);
    if (!match) throw domainError("Fixture not found.", 404);
    if (hasRecordedMatchActivity(match) || await MatchEvent.exists({ match: matchId }).session(session)) throw domainError("Matches with recorded activity must be preserved. Correct their result instead.", 409);
    await Fixture.deleteOne({ _id: matchId }, { session });
    await session.commitTransaction();
    return res.json({ success: true, message: "Unplayed fixture deleted." });
  } catch (error) {
    if (session?.inTransaction()) await session.abortTransaction();
    return res.status(error.statusCode || ([112, 251].includes(error.code) ? 409 : 500)).json({ success: false, message: error.message });
  } finally { if (session) await session.endSession(); }
};

exports.deleteRoundFixtures = async (req, res) => {
  let session;
  try {
    const leagueId = req.params.leagueId || req.body.leagueId || req.query.leagueId;
    const round = Number(req.params.round || req.body.round || req.query.round);
    if (!mongoose.Types.ObjectId.isValid(leagueId) || !Number.isInteger(round) || round < 1) throw domainError("Valid league ID and positive integer round are required.");
    session = await mongoose.startSession(); session.startTransaction();
    if (!(await League.updateOne({ _id: leagueId }, { $inc: { schedulingRevision: 1 } }, { session })).matchedCount) throw domainError("League not found.", 404);
    const fixtures = await Fixture.find({ league: leagueId, round }).session(session);
    if (!fixtures.length) throw domainError("No fixtures found in this round.", 404);
    const fixtureIds = fixtures.map((fixture) => fixture._id);
    if (fixtures.some(hasRecordedMatchActivity) || await MatchEvent.exists({ match: { $in: fixtureIds } }).session(session)) throw domainError("This round contains recorded activity. Historical matches must be preserved.", 409);
    await Fixture.deleteMany({ _id: { $in: fixtureIds } }, { session });
    await session.commitTransaction();
    return res.json({ success: true, message: "Unplayed round fixtures deleted.", data: { leagueId, round, deletedCount: fixtureIds.length } });
  } catch (error) {
    if (session?.inTransaction()) await session.abortTransaction();
    return res.status(error.statusCode || ([112, 251].includes(error.code) ? 409 : 500)).json({ success: false, message: error.message });
  } finally { if (session) await session.endSession(); }
};

exports.updateTeamStatistics = async (req, res) => {
  try {
    const { teamId } = req.params;
    const {
      played,
      won,
      drawn,
      lost,
      goalsFor,
      goalsAgainst,
      goalDifference,
      points,
    } = req.body;

    if (!mongoose.Types.ObjectId.isValid(teamId)) {
      return res.status(400).json({ success: false, message: "Invalid Team ID format" });
    }

    const team = await Team.findById(teamId);
    if (!team) {
      return res.status(404).json({ success: false, message: "Team not found" });
    }

    team.statistics = mergedTeamStatistics(team.statistics, req.body);

    await team.save();

    return res.status(200).json({
      success: true,
      message: "Team statistics updated successfully",
      data: {
        teamId: team._id,
        teamName: team.teamName,
        statistics: team.statistics,
      },
    });
  } catch (err) {
    return res.status(err.statusCode || (err.code === 11000 || err.name === "VersionError" ? 409 : err.name === "ValidationError" || err.name === "CastError" ? 400 : 500)).json({ success: false, message: err.message });
  }
};

exports.updateTeamPlayerStatistics = async (req, res) => {
  try {
    for (const key of PLAYER_STAT_KEYS) if (req.body[key] !== undefined && (!Number.isInteger(Number(req.body[key])) || Number(req.body[key]) < 0)) throw domainError(`${key} must be a non-negative integer.`);
    const { teamId, playerId } = req.params;
    const {
      appearances,
      goals,
      assists,
      cleanSheets,
      yellowCards,
      redCards,
      minutesPlayed,
    } = req.body;

    if (!mongoose.Types.ObjectId.isValid(teamId) || !mongoose.Types.ObjectId.isValid(playerId)) {
      return res.status(400).json({ success: false, message: "Invalid team ID or player ID format" });
    }

    const team = await Team.findById(teamId);
    if (!team) {
      return res.status(404).json({ success: false, message: "Team not found" });
    }

    const playerEntry = (team.players || []).find(
      (p) => (p.player?._id || p.player || "").toString() === playerId.toString()
    );

    if (!playerEntry) {
      return res.status(404).json({ success: false, message: "Player not found in this team" });
    }

    if (!playerEntry.statistics) {
      playerEntry.statistics = {
        appearances: 0,
        goals: 0,
        assists: 0,
        cleanSheets: 0,
        yellowCards: 0,
        redCards: 0,
        minutesPlayed: 0,
      };
    }

    if (appearances !== undefined) playerEntry.statistics.appearances = Number(appearances);
    if (goals !== undefined) playerEntry.statistics.goals = Number(goals);
    if (assists !== undefined) playerEntry.statistics.assists = Number(assists);
    if (cleanSheets !== undefined) playerEntry.statistics.cleanSheets = Number(cleanSheets);
    if (yellowCards !== undefined) playerEntry.statistics.yellowCards = Number(yellowCards);
    if (redCards !== undefined) playerEntry.statistics.redCards = Number(redCards);
    if (minutesPlayed !== undefined) playerEntry.statistics.minutesPlayed = Number(minutesPlayed);

    await team.save();

    return res.status(200).json({
      success: true,
      message: "Player statistics updated successfully in team",
      data: {
        teamId: team._id,
        playerId,
        statistics: playerEntry.statistics,
      },
    });
  } catch (error) {
    return res.status(error.statusCode || (error.code === 11000 || error.name === "VersionError" ? 409 : error.name === "ValidationError" || error.name === "CastError" ? 400 : 500)).json({ success: false, message: error.message });
  }
};

exports.getTeamPlayerStatistics = async (req, res) => {
  try {
    const { teamId, playerId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(teamId) || !mongoose.Types.ObjectId.isValid(playerId)) {
      return res.status(400).json({ success: false, message: "Invalid team ID or player ID format" });
    }

    const team = await Team.findById(teamId).populate("players.player", "fullName email profileImage jerseyNumber statistics");
    if (!team) {
      return res.status(404).json({ success: false, message: "Team not found" });
    }

    const playerEntry = (team.players || []).find(
      (p) => (p.player?._id || p.player || "").toString() === playerId.toString()
    );

    if (!playerEntry) {
      return res.status(404).json({ success: false, message: "Player not found in this team" });
    }

    const playerDoc = playerEntry.player && typeof playerEntry.player === "object" ? playerEntry.player : null;

    return res.status(200).json({
      success: true,
      data: {
        teamId: team._id,
        playerId,
        player: playerDoc,
        teamStatistics: playerEntry.statistics || {
          appearances: 0,
          goals: 0,
          assists: 0,
          cleanSheets: 0,
          yellowCards: 0,
          redCards: 0,
          minutesPlayed: 0,
        },
        overallStatistics: playerDoc?.statistics || null,
      },
    });
  } catch (error) {
    return res.status(error.statusCode || (error.code === 11000 || error.name === "VersionError" ? 409 : error.name === "ValidationError" || error.name === "CastError" ? 400 : 500)).json({ success: false, message: error.message });
  }
};

function mergedTeamStatistics(previous, input, league = {}) {
  const stats = {};
  for (const key of ["played", "won", "drawn", "lost", "goalsFor", "goalsAgainst"]) {
    stats[key] = Number(input[key] ?? previous?.[key] ?? 0);
    if (!Number.isInteger(stats[key]) || stats[key] < 0) throw domainError(`${key} must be a non-negative integer.`);
  }
  if (input.played === undefined && ["won", "drawn", "lost"].some((key) => input[key] !== undefined)) stats.played = stats.won + stats.drawn + stats.lost;
  if (stats.played !== stats.won + stats.drawn + stats.lost) throw domainError("Played must equal wins plus draws plus losses.");
  stats.goalDifference = stats.goalsFor - stats.goalsAgainst;
  if (input.goalDifference !== undefined && Number(input.goalDifference) !== stats.goalDifference) throw domainError("Goal difference must equal goals for minus goals against.");
  stats.points = Number(input.points ?? stats.won * Number(league.pointsForWin ?? 3) + stats.drawn * Number(league.pointsForDraw ?? 1));
  if (!Number.isFinite(stats.points) || stats.points < 0) throw domainError("Points must be non-negative.");
  return stats;
}

exports.updateLeagueTeamStatistics = async (req, res) => {
  let session;
  try {
    const { leagueId, teamId } = req.params;
    if (![leagueId, teamId].every(mongoose.Types.ObjectId.isValid)) throw domainError("Invalid league or team ID.");
    session = await mongoose.startSession(); session.startTransaction();
    await League.updateOne({ _id: leagueId }, { $inc: { schedulingRevision: 1 } }, { session });
    const league = await League.findById(leagueId).session(session);
    const team = await Team.findById(teamId).session(session);
    if (!league || league.archivedAt || !team) throw domainError("League or team not found.", 404);
    assertTeamLeagueScope(league, [team]);
    const standing = await Standing.findOne({ league: leagueId, team: teamId }).session(session);
    const stats = mergedTeamStatistics(standing, req.body, league);
    const enrollment = team.leagues.find((row) => entityId(row.league) === leagueId);
    if (!enrollment) throw domainError("Team enrollment not found.", 404);
    enrollment.statistics = stats;
    await team.save({ session });
    await Standing.updateOne({ league: leagueId, team: teamId }, { $set: stats }, { upsert: true, session });
    await session.commitTransaction();
    return res.json({ success: true, message: "League team statistics updated.", data: { leagueId, teamId, teamName: team.teamName, standing: stats } });
  } catch (error) {
    if (session?.inTransaction()) await session.abortTransaction();
    return res.status(error.statusCode || ([112, 251].includes(error.code) ? 409 : 500)).json({ success: false, message: error.message });
  } finally { if (session) await session.endSession(); }
};

exports.deleteLeague = async (req, res) => {
  try {
    const { leagueId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(leagueId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid League ID format",
      });
    }

    const league = await League.findById(leagueId);
    if (!league) {
      return res.status(404).json({
        success: false,
        message: "League not found",
      });
    }

    league.archivedAt = league.archivedAt || new Date();
    await league.save();
    return res.status(200).json({ success: true, message: "League archived. Fixtures, results, enrollment and payment history are preserved.", data: { archivedLeagueId: leagueId } });
  } catch (err) {
    return res.status(err.statusCode || (err.code === 11000 || err.name === "VersionError" ? 409 : err.name === "ValidationError" || err.name === "CastError" ? 400 : 500)).json({
      success: false,
      message: err.code === 11000 ? "This team name already exists in the selected term, or a team is already scheduled in this round." : err.name === "VersionError" ? "This match changed while you were editing. Refresh and try again." : err.message,
    });
  }
};




async function safeRemoveLogo(relativePath, folder, Model) {
  const storedPath = String(relativePath).replace(/^[/\\]+/, "").replace(/\\/g, "/");
  if (!storedPath.startsWith(`uploads/${folder}/`)) return;
  const filename = storedPath.slice(`uploads/${folder}/`.length);
  if (!filename || filename !== path.basename(filename)) return;
  const base = path.resolve(UPLOAD_ROOT, folder);
  const target = path.resolve(base, filename);
  if (!target.startsWith(base + path.sep)) return;
  try {
    // Cloning may share an immutable asset. Retain it while any current or
    // archived record still references that asset.
    if (await Model.exists({ logo: { $in: [storedPath, `/${storedPath}`, String(relativePath)] } })) return;
    await fs.promises.unlink(target);
  } catch (error) { if (error.code !== "ENOENT") console.error("Unable to remove unused logo:", error.code || error.name); }
}
async function safeRemoveTeamLogo(relativePath) { return safeRemoveLogo(relativePath, "teamlogos", Team); }
async function safeRemoveLeagueLogo(relativePath) { return safeRemoveLogo(relativePath, "leaguelogos", League); }
