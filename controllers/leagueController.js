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
const {
  validateTournamentConfig,
  generateAndSaveLeagueFixtures,
  reconcileAndSaveLeagueFixtures,
  parseDateToMidnight,
} = require("../services/fixtureGenerationService");
const mongoose = require("mongoose");
const fs = require("fs");
const path = require("path");

const activeLeagueGenerationLocks = new Set();

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

  // 1. Remove any previous enrollment for this league to prevent duplicate array elements
  await Team.updateMany(
    { _id: { $in: validIds } },
    {
      $pull: {
        leagues: { league: leagueId },
      },
    },
    sessionOption
  );

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

    const entry = {
      league: leagueId,
      teamFee: teamFee !== undefined && teamFee !== null ? Number(teamFee) : 0,
      round: round != null ? Number(round) : null,
      sessionDates: Array.isArray(sessionDates) ? sessionDates : [],
      group: teamGroupMap[tId] || "",
      status: status || "ACTIVE",
      enrolledAt: new Date(),
      players: defaultPlayers,
      statistics: {
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

    await Team.updateOne(
      { _id: tId },
      {
        $push: { leagues: entry },
      },
      sessionOption
    );
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
          term: term || null,
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
      message: err.message,
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

    const newLogo = req.file ? req.file.path.replace(/\\/g, "/") : (req.body.logo || sourceLeague.logo || "");
    const newName = name && name.trim() ? name.trim() : `${sourceLeague.name} (Copy)`;
    const newSeason = season && season.trim() ? season.trim() : sourceLeague.season;
    const newStartDate = startDate ? new Date(startDate) : (sourceLeague.startDate ? new Date(sourceLeague.startDate) : new Date());
    const newEndDate = endDate ? new Date(endDate) : (sourceLeague.endDate ? new Date(sourceLeague.endDate) : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000));
    const newFee = fee !== undefined && fee !== null && !isNaN(Number(fee)) ? Number(fee) : (sourceLeague.fee || 0);

    const sourceTeams = (sourceLeague.teams || []).filter((t) => t && t._id);
    let assignedTeamIds = [];
    let newGroups = [];

    const shouldDuplicateTeams = duplicateTeams === true || duplicateTeams === "true";

    if (shouldDuplicateTeams && sourceTeams.length > 0) {
      const oldToNewMap = {};
      const newTeamDocs = [];

      for (const t of sourceTeams) {
        const clonedPlayers = (t.players || []).map((p) => ({
          player: p.player?._id || p.player,
          paymentStatus: p.paymentStatus || "UNPAID",
        }));

        newTeamDocs.push({
          teamName: t.teamName,
          logo: t.logo || "",
          coach: t.coach,
          assistantCoach: t.assistantCoach,
          ageGroup: t.ageGroup || "",
          teamType: t.teamType || "INTERNAL",
          term: t.term,
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
      term: term || sourceLeague.term,
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

    return res.status(500).json({
      success: false,
      message: err.message,
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
      message: err.message,
      ...(err.protectedFixtures ? { protectedFixtures: err.protectedFixtures } : {}),
    });
  } finally {
    activeLeagueGenerationLocks.delete(leagueKey);
  }
};


exports.getAllLeagues = async (req, res) => {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 10;
    const search = req.query.search?.trim() || "";
    const type = (req.query.type || req.query.leagueType || "")?.trim().toUpperCase();
    const status = req.query.status?.trim().toUpperCase();
    const term = req.query.term || req.query.termId;

    const skip = (page - 1) * limit;

    const filter = {};

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
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

const parseDateString = (input) => {
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
  let parsedDates = rawDates.map(parseDateString).filter(Boolean);

  let parsedRound = body.round !== undefined && body.round !== null && String(body.round).trim() !== ""
    ? Math.max(1, parseInt(body.round, 10))
    : null;

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

// exports.createTeam = async (req, res) => {
//   try {
//     const {
//       teamName,
//       coach,
//       assistantCoach,
//       ageGroup,
//       teamType,
//       teamFee,
//       fee,
//       term,
//       dayOfWeek,
//       startTime,
//       endTime,
//       venue,
//       location,
//       scheduleType,
//       schedule,
//       players,
//     } = req.body;

//     if (!teamName) {
//       return res.status(400).json({
//         success: false,
//         message: "Team name is required",
//       });
//     }

//     const existingTeam = await Team.findOne({
//       teamName: teamName.trim(),
//     });

//     if (existingTeam) {
//       return res.status(409).json({
//         success: false,
//         message: "Team already exists",
//       });
//     }

//     const parsedType = teamType && ["INTERNAL", "EXTERNAL"].includes(teamType.toUpperCase())
//       ? teamType.toUpperCase()
//       : "INTERNAL";

//     const parsedFee = fee !== undefined ? Number(fee) : teamFee !== undefined ? Number(teamFee) : 0;
//     if (isNaN(parsedFee) || parsedFee < 0) {
//       return res.status(400).json({ success: false, message: "Team fee must be a non-negative number" });
//     }

//     const logo = req.file ? `uploads/teamlogos/${req.file.filename}` : "";

//     const { round: parsedRound, sessionDates: parsedDates } = parseRoundAndDates(req.body);

//     let parsedPlayers = [];
//     if (players) {
//       let rawPlayers = players;
//       if (typeof rawPlayers === "string") {
//         try {
//           rawPlayers = JSON.parse(rawPlayers);
//         } catch (e) {
//           rawPlayers = [];
//         }
//       }
//       if (Array.isArray(rawPlayers)) {
//         parsedPlayers = rawPlayers.map((p) => {
//           const pid = p && p.player ? p.player : p;
//           const status = p && p.paymentStatus ? p.paymentStatus : "UNPAID";
//           const stats = p && p.statistics ? {
//             appearances: Number(p.statistics.appearances) || 0,
//             goals: Number(p.statistics.goals) || 0,
//             assists: Number(p.statistics.assists) || 0,
//             cleanSheets: Number(p.statistics.cleanSheets) || 0,
//             yellowCards: Number(p.statistics.yellowCards) || 0,
//             redCards: Number(p.statistics.redCards) || 0,
//             minutesPlayed: Number(p.statistics.minutesPlayed) || 0,
//           } : {
//             appearances: 0,
//             goals: 0,
//             assists: 0,
//             cleanSheets: 0,
//             yellowCards: 0,
//             redCards: 0,
//             minutesPlayed: 0,
//           };
//           return { player: pid, paymentStatus: status, statistics: stats };
//         });
//       }
//     }

//     const team = await Team.create({
//       teamName: teamName.trim(),
//       logo,
//       coach: coach || null,
//       assistantCoach: assistantCoach || null,
//       ageGroup: ageGroup || "",
//       teamType: parsedType,
//       teamFee: parsedFee,
//       term: term || null,
//       dayOfWeek: dayOfWeek || "",
//       startTime: startTime || "",
//       endTime: endTime || "",
//       venue: venue || "",
//       location: location || venue || "",
//       scheduleType: scheduleType || "SINGLE_DAY",
//       schedule: schedule || [],
//       round: parsedRound,
//       sessionDates: parsedDates,
//       players: parsedPlayers,
//     });

//     return res.status(201).json({
//       success: true,
//       message: "Team created successfully",
//       data: team,
//     });
//   } catch (err) {
//     return res.status(500).json({
//       success: false,
//       message: err.message,
//     });
//   }
// };

exports.createTeam = async (req, res) => {
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

    const existingTeam = await Team.findOne({
      teamName: teamName.trim(),
    });

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

    const team = await Team.create({
      teamName: teamName.trim(),
      logo,

      coach: coach || null,
      assistantCoach: assistantCoach || null,

      ageGroup: ageGroup || "",

      teamType: parsedType,

      term: term || null,

      dayOfWeek: dayOfWeek || "",
      startTime: startTime || "",
      endTime: endTime || "",

      venue: venue || "",
      location: location || venue || "",

      scheduleType: scheduleType || "CUSTOM",
      schedule: schedule || [],

      players: parsedPlayers,
    });

    return res.status(201).json({
      success: true,
      message: "Team created successfully",
      data: team,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};


exports.getAllTeams = async (req, res) => {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 10;
    const search = req.query.search?.trim() || "";

    const skip = (page - 1) * limit;

    const filter = {};

    if (search) {
      filter.teamName = {
        $regex: search,
        $options: "i",
      };
    }

    if (req.query.teamType && ["INTERNAL", "EXTERNAL"].includes(req.query.teamType.toUpperCase())) {
      filter.teamType = req.query.teamType.toUpperCase();
    }

    if (req.query.termId || req.query.term) {
      filter.term = req.query.termId || req.query.term;
    }

    const [teams, total] = await Promise.all([
      Team.find(filter)
        .populate("term", "name year startDate endDate")
        .populate("coach", "name email profileImage")
        .populate("assistantCoach", "name email profileImage")
        .populate("captain", "name email profileImage")
        .populate("viceCaptain", "name email profileImage")
        .populate("players.player", "fullName email profileImage")
        .sort({ createdAt: -1 })
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
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

exports.assignPlayerToTeam = async (req, res) => {
  try {
    const { teamId } = req.params;
    const { players } = req.body;

    const VALID_PAYMENT_STATUSES = [
      "TRIAL",
      "UNPAID",
      "PAID",
      "OVER_DUE",
      "EXTRA",
      "SUBSTITUTE",
      "TBC",
      "HANDSHAKE",
    ];

    if (!players) {
      return res.status(400).json({ success: false, message: "players array is required" });
    }

    let rawPlayers = players;
    if (typeof rawPlayers === "string") {
      try {
        rawPlayers = JSON.parse(rawPlayers);
      } catch (e) {
        return res.status(400).json({ success: false, message: "Invalid players JSON format" });
      }
    }

    if (!Array.isArray(rawPlayers) || rawPlayers.length === 0) {
      return res.status(400).json({ success: false, message: "players must be a non-empty array" });
    }

    // Normalize incoming players into a list of { id, paymentStatus }
    const playerEntries = rawPlayers
      .map((item) => {
        if (item && typeof item === "object") {
          const id = (item.playerId || item.player || item._id || "").toString().trim();
          const rawStatus = (item.paymentStatus || "TRIAL")
            .toString()
            .toUpperCase()
            .trim();
          const status = VALID_PAYMENT_STATUSES.includes(rawStatus) ? rawStatus : "TRIAL";
          return { id, paymentStatus: status };
        } else {
          const id = (item || "").toString().trim();
          return { id, paymentStatus: "TRIAL" };
        }
      })
      .filter((entry) => entry.id);

    if (playerEntries.length === 0) {
      return res.status(400).json({ success: false, message: "No valid player(s) provided in players array" });
    }

    const isValid = playerEntries.every((entry) => mongoose.Types.ObjectId.isValid(entry.id));
    if (!isValid) {
      return res.status(400).json({ success: false, message: "Invalid player ID format" });
    }

    const team = await Team.findById(teamId);
    if (!team) {
      return res.status(404).json({ success: false, message: "Team not found" });
    }

    const uniqueIds = [...new Set(playerEntries.map((e) => e.id))];
    const existingPlayersCount = await User.countDocuments({ _id: { $in: uniqueIds } });
    if (existingPlayersCount !== uniqueIds.length) {
      return res.status(404).json({ success: false, message: "One or more players not found" });
    }


    const leagueId =
      req.body?.leagueId ||
      req.body?.league ||
      req.query?.leagueId ||
      req.query?.league ||
      req.params?.leagueId;

    if (leagueId) {
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

      if (!Array.isArray(team.leagues)) {
        team.leagues = [];
      }

      // Find this league inside the team's leagues
      let leagueEntry = team.leagues.find(
        (l) => (l.league?._id || l.league)?.toString() === leagueId.toString()
      );

      // If team is not yet registered in this league,
      // create the league entry using the League fee as initial teamFee.
      if (!leagueEntry) {
        leagueEntry = {
          league: leagueId,
          teamFee: Number(league.fee || 0),
          status: "ACTIVE",
          enrolledAt: new Date(),
          players: [],
          statistics: {
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

        team.leagues.push(leagueEntry);

        leagueEntry = team.leagues[team.leagues.length - 1];
      }

      if (!Array.isArray(leagueEntry.players)) {
        leagueEntry.players = [];
      }

      // ------------------------------------------
      // UPDATE LEAGUE-SPECIFIC PLAYERS
      // ------------------------------------------

      const existingLeaguePlayerMap = new Map();

      leagueEntry.players.forEach((p) => {
        const pid = (p.player?._id || p.player)?.toString();

        if (pid) {
          existingLeaguePlayerMap.set(pid, {
            paymentStatus: p.paymentStatus || "UNPAID",
            status: p.status || "ACTIVE",
          });
        }
      });

      playerEntries.forEach(({ id, paymentStatus }) => {
        if (existingLeaguePlayerMap.has(id)) {
          const existing = existingLeaguePlayerMap.get(id);

          existing.paymentStatus = paymentStatus;
        } else {
          existingLeaguePlayerMap.set(id, {
            paymentStatus,
            status: "ACTIVE",
          });
        }
      });

      leagueEntry.players = Array.from(
        existingLeaguePlayerMap.entries()
      ).map(([pId, data]) => ({
        player: pId,
        paymentStatus: data.paymentStatus,
        status: data.status,
      }));

      team.markModified("leagues");

      // ------------------------------------------
      // ENSURE PLAYERS EXIST IN TEAM.PLAYERS
      // ------------------------------------------

      if (!Array.isArray(team.players)) {
        team.players = [];
      }

      const teamPlayerSet = new Set(
        team.players.map((p) =>
          (p.player?._id || p.player)?.toString()
        )
      );

      playerEntries.forEach(({ id }) => {
        if (!teamPlayerSet.has(id)) {
          team.players.push({
            player: id,
            paymentStatus: "TRIAL",
          });

          teamPlayerSet.add(id);
        }
      });

      if (team.players.length > 20) {
        return res.status(400).json({
          success: false,
          message: `Cannot assign players. A team cannot exceed 20 players. Currently has ${team.players.length} players.`,
        });
      }

      await team.save();

      // ------------------------------------------
      // INVOICE CREATION
      // ------------------------------------------

      // IMPORTANT:
      // Invoice amount MUST come from team.leagues[].teamFee
      const teamFee = Number(leagueEntry.teamFee || 0);

      if (teamFee > 0) {
        const processedInvoices = new Set();

        for (const { id: playerId, paymentStatus } of playerEntries) {
          // Only UNPAID players get an invoice
          if (
            paymentStatus === "UNPAID" &&
            !processedInvoices.has(playerId)
          ) {
            processedInvoices.add(playerId);

            try {
              await generateLeagueInvoice({
                userId: playerId,
                leagueId: leagueId,
                teamId: teamId,
                amount: teamFee,
              });

              console.log(
                `[Team-League] Invoice created for player ${playerId}, amount=${teamFee}, team=${teamId}, league=${leagueId}`
              );
            } catch (invErr) {
              console.error(
                `[Team-League] Failed to generate invoice for player ${playerId}:`,
                invErr.message
              );
            }
          }
        }
      }
    } else {
      // Previous behavior: update team.players paymentStatus directly
      const existingPlayerMap = new Map();
      (team.players || []).forEach((p) => {
        const pid = p.player ? p.player.toString() : p.toString();
        existingPlayerMap.set(pid, {
          paymentStatus: p.paymentStatus || "TRIAL",
        });
      });

      // Update existing players with their passed paymentStatus, or insert new ones
      playerEntries.forEach(({ id, paymentStatus }) => {
        if (existingPlayerMap.has(id)) {
          const existing = existingPlayerMap.get(id);
          existing.paymentStatus = paymentStatus;
        } else {
          existingPlayerMap.set(id, {
            paymentStatus,
          });
        }
      });

      if (existingPlayerMap.size > 20) {
        return res.status(400).json({
          success: false,
          message: `Cannot assign players. A team cannot exceed 20 players. Currently has ${existingPlayerMap.size} players.`,
        });
      }

      team.players = Array.from(existingPlayerMap.entries()).map(([pId, data]) => ({
        player: pId,
        paymentStatus: data.paymentStatus,
      }));

      await team.save();

    }

    const updatedTeam = await Team.findById(teamId)
      .populate("players.player", "firstName lastName fullName email mobile profileImage")
      .populate("leagues.players.player", "firstName lastName fullName email mobile profileImage");

    return res.json({ success: true, message: "Player assigned to team successfully", data: updatedTeam || team });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

exports.getAvailablePlayers = async (req, res) => {
  try {
    const teams = await Team.find({}, "players teamName");

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
    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

exports.createFixture = async (req, res) => {
  try {
    const {
      league,
      kickoffTime,
      venue,
      referee,
      homeTeam,
      awayTeam,
      field,
      endTime,
      group,
    } = req.body;

    const targetLeague = req.params?.leagueId || league;

    if (!targetLeague || !kickoffTime || !venue || !homeTeam || !awayTeam) {
      return res.status(400).json({
        success: false,
        message:
          "League, kickoff time, venue, home team and away team are required.",
      });
    }

    if (
      !mongoose.Types.ObjectId.isValid(targetLeague) ||
      !mongoose.Types.ObjectId.isValid(homeTeam) ||
      !mongoose.Types.ObjectId.isValid(awayTeam)
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid League or Team ID.",
      });
    }

    if (homeTeam === awayTeam) {
      return res.status(400).json({
        success: false,
        message: "Home team and away team cannot be the same.",
      });
    }

    const [leagueExists, homeTeamExists, awayTeamExists] = await Promise.all([
      League.findById(targetLeague),
      Team.findById(homeTeam),
      Team.findById(awayTeam),
    ]);

    if (!leagueExists) {
      return res.status(404).json({
        success: false,
        message: "League not found.",
      });
    }

    if (!homeTeamExists || !awayTeamExists) {
      return res.status(404).json({
        success: false,
        message: "One or both teams not found.",
      });
    }

    const existingFixture = await Fixture.findOne({
      league: targetLeague,
      kickoffTime: new Date(kickoffTime),
      $or: [
        { homeTeam, awayTeam },
        { homeTeam: awayTeam, awayTeam: homeTeam },
      ],
    });

    if (existingFixture) {
      return res.status(409).json({
        success: false,
        message: "Fixture already exists.",
      });
    }

    const roundNumber = req.body.round ? Math.max(1, parseInt(req.body.round, 10)) : 1;

    const explicitSessionDate = req.body.sessionDate ? parseDateToMidnight(req.body.sessionDate) : null;
    const leagueSessionDate =
      leagueExists.sessionDates && Array.isArray(leagueExists.sessionDates) && leagueExists.sessionDates[roundNumber - 1]
        ? leagueExists.sessionDates[roundNumber - 1]
        : null;
    const fixtureSessionDate = explicitSessionDate || leagueSessionDate || parseDateToMidnight(kickoffTime);

    const fixture = await Fixture.create({
      league: targetLeague,
      round: roundNumber,
      kickoffTime: new Date(kickoffTime),
      sessionDate: fixtureSessionDate,
      endTime: endTime ? new Date(endTime) : undefined,
      venue: venue.trim(),
      field: field ? String(field).trim() : "",
      group: group ? String(group).trim() : "",
      referee: referee || "",
      homeTeam,
      awayTeam,
      status: "SCHEDULED",
      fixtureSource: "MANUAL",
      isManuallyModified: true,
    });

    // Auto-enroll teams into the league's teams roster if not already present
    await League.findByIdAndUpdate(targetLeague, {
      $addToSet: { teams: { $each: [homeTeam, awayTeam] } },
    });

    // Synchronize team fee, sessionDates, and round to homeTeam and awayTeam
    await Team.updateMany(
      { _id: { $in: [homeTeam, awayTeam] } },
      {
        $set: {
          teamFee: leagueExists.fee || 0,
          sessionDates: leagueExists.sessionDates || [],
          round: leagueExists.numberOfRounds || null,
        },
      }
    );

    if (leagueExists.fee > 0) {
      for (const tId of [homeTeam, awayTeam]) {
        try {
          await processLeagueInvoicesForTeam({ leagueId: targetLeague, teamId: tId });
        } catch (invErr) {
          console.error(`[League] Error processing invoices for enrolled team ${tId}:`, invErr.message);
        }
      }
    }

    // Ensure initial standings exist for both teams in this league
    await Promise.all([
      Standing.findOneAndUpdate(
        { league, team: homeTeam },
        {
          $setOnInsert: {
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
        { upsert: true, new: true }
      ),
      Standing.findOneAndUpdate(
        { league, team: awayTeam },
        {
          $setOnInsert: {
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
        { upsert: true, new: true }
      ),
    ]);

    const data = await Fixture.findById(fixture._id)
      .populate("league", "name season")
      .populate("homeTeam", "teamName logo")
      .populate("awayTeam", "teamName logo");

    return res.status(201).json({
      success: true,
      message: "Fixture created successfully.",
      data,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

exports.recordMatchEvent = async (req, res) => {
  try {
    const { matchId } = req.params;
    const { player, team, eventType, minute, details } = req.body;

    if (!player || !team || !eventType || minute === undefined) {
      return res.status(400).json({ success: false, message: "Required fields missing" });
    }

    const match = await Fixture.findById(matchId);
    if (!match) {
      return res.status(404).json({ success: false, message: "Match not found" });
    }

    const event = await MatchEvent.create({
      match: matchId,
      player,
      team,
      eventType,
      minute,
      details,
    });

    match.events.push(event._id);

    if (eventType === "GOAL") {
      if (match.homeTeam.toString() === team) {
        match.score.homeScore += 1;
      } else if (match.awayTeam.toString() === team) {
        match.score.awayScore += 1;
      }
    }

    await match.save();

    const playerUpdate = {};
    const statsUpdate = {};

    if (eventType === "GOAL") {
      playerUpdate.$inc = { goals: 1 };
      statsUpdate.$inc = { goals: 1 };
    } else if (eventType === "ASSIST") {
      playerUpdate.$inc = { assists: 1 };
      statsUpdate.$inc = { assists: 1 };
    } else if (eventType === "YELLOW_CARD") {
      playerUpdate.$inc = { yellowCards: 1 };
      statsUpdate.$inc = { yellowCards: 1 };
    } else if (eventType === "RED_CARD") {
      playerUpdate.$inc = { redCards: 1 };
      statsUpdate.$inc = { redCards: 1 };
    }

    if (playerUpdate.$inc) {
      await User.findByIdAndUpdate(player, playerUpdate);

      await PlayerStatistics.findOneAndUpdate(
        { player, league: match.league },
        { ...statsUpdate, $set: { team }, $setOnInsert: { appearances: 0, cleanSheets: 0, minutesPlayed: 0 } },
        { upsert: true, new: true }
      );
    }

    res.status(201).json({ success: true, message: "Match event recorded successfully", data: event });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

exports.completeMatch = async (req, res) => {
  try {
    const { matchId } = req.params;
    const { homeScore, awayScore, players = [] } = req.body;

    const match = await Fixture.findById(matchId);

    if (!match) {
      return res.status(404).json({
        success: false,
        message: "Match not found",
      });
    }

    if (match.status === "COMPLETED") {
      return res.status(400).json({
        success: false,
        message: "Match already completed",
      });
    }

    match.score.homeScore = Number(homeScore);
    match.score.awayScore = Number(awayScore);

    match.playerRatings = players.map((player) => ({
      player: player.player,
      rating: player.rating || 0,
    }));

    match.status = "COMPLETED";

    await match.save();

    const homeGoals = Number(homeScore);
    const awayGoals = Number(awayScore);

    let homeWon = 0,
      homeDrawn = 0,
      homeLost = 0,
      homePoints = 0;

    let awayWon = 0,
      awayDrawn = 0,
      awayLost = 0,
      awayPoints = 0;

    if (homeGoals > awayGoals) {
      homeWon = 1;
      awayLost = 1;
      homePoints = 3;
    } else if (awayGoals > homeGoals) {
      awayWon = 1;
      homeLost = 1;
      awayPoints = 3;
    } else {
      homeDrawn = 1;
      awayDrawn = 1;
      homePoints = 1;
      awayPoints = 1;
    }

    await Standing.findOneAndUpdate(
      {
        league: match.league,
        team: match.homeTeam,
      },
      {
        $inc: {
          played: 1,
          won: homeWon,
          drawn: homeDrawn,
          lost: homeLost,
          goalsFor: homeGoals,
          goalsAgainst: awayGoals,
          goalDifference: homeGoals - awayGoals,
          points: homePoints,
        },
      },
      {
        upsert: true,
        new: true,
      }
    );

    await Standing.findOneAndUpdate(
      {
        league: match.league,
        team: match.awayTeam,
      },
      {
        $inc: {
          played: 1,
          won: awayWon,
          drawn: awayDrawn,
          lost: awayLost,
          goalsFor: awayGoals,
          goalsAgainst: homeGoals,
          goalDifference: awayGoals - homeGoals,
          points: awayPoints,
        },
      },
      {
        upsert: true,
        new: true,
      }
    );

    for (const player of players) {
      const team = await Team.findOne({
        players: player.player,
      });

      await User.findByIdAndUpdate(player.player, {
        $inc: {
          "statistics.appearances": 1,
          "statistics.minutesPlayed": player.minutesPlayed || 0,
          "statistics.goals": player.goals || 0,
          "statistics.assists": player.assists || 0,
          "statistics.cleanSheets": player.cleanSheet ? 1 : 0,
          "statistics.yellowCards": player.yellowCards || 0,
          "statistics.redCards": player.redCards || 0,
        },
      });

      if (team) {
        await PlayerStatistics.findOneAndUpdate(
          {
            player: player.player,
            league: match.league,
          },
          {
            $inc: {
              appearances: 1,
              minutesPlayed: player.minutesPlayed || 0,
              goals: player.goals || 0,
              assists: player.assists || 0,
              cleanSheets: player.cleanSheet ? 1 : 0,
              yellowCards: player.yellowCards || 0,
              redCards: player.redCards || 0,
            },
            $set: {
              team: team._id,
              rating: player.rating || 0,
            },
          },
          {
            upsert: true,
            new: true,
          }
        );
      }
    }

    const completedMatch = await Fixture.findById(match._id)
      .populate("league", "name season")
      .populate("homeTeam", "teamName logo")
      .populate("awayTeam", "teamName logo");

    return res.status(200).json({
      success: true,
      message: "Match completed successfully.",
      data: completedMatch,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};


exports.updatePlayerStatistics = async (req, res) => {
  try {
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
    return res.status(500).json({
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
    res.status(500).json({ success: false, message: err.message });
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
    res.status(500).json({ success: false, message: err.message });
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
    res.status(500).json({ success: false, message: err.message });
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
    return res.status(500).json({
      success: false,
      message: err.message,
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
    return res.status(500).json({
      success: false,
      message: err.message,
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
    return res.status(500).json({ success: false, message: err.message });
  }
};

exports.updateTeam = async (req, res) => {
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

    if (term !== undefined) team.term = term || null;
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
        teamName: { $regex: new RegExp(`^${trimmedName}$`, "i") },
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
      if (team.logo) {
        const oldPath = path.join(__dirname, "..", team.logo);
        fs.unlink(oldPath, (err) => {
          if (err && err.code !== "ENOENT") {
            console.error("Failed to delete old team logo:", err);
          }
        });
      }
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

    return res.status(200).json({
      success: true,
      message: "Team updated successfully",
      data: team,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

exports.deleteTeam = async (req, res) => {
  try {
    const { teamId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(teamId)) {
      return res.status(400).json({ success: false, message: "Invalid Team ID format" });
    }

    const team = await Team.findById(teamId);
    if (!team) {
      return res.status(404).json({ success: false, message: "Team not found" });
    }

    if (team.logo) {
      const logoPath = path.join(__dirname, "..", team.logo);
      fs.unlink(logoPath, (err) => {
        if (err && err.code !== "ENOENT") {
          console.error("Failed to delete team logo on team deletion:", err);
        }
      });
    }

    // 1. Remove team from all leagues (both teams list and groups)
    await League.updateMany(
      { teams: teamId },
      { $pull: { teams: teamId, "groups.$[].teams": teamId } }
    );

    // 2. Remove standings and player statistics associated with this team
    await Standing.deleteMany({ team: teamId });
    await PlayerStatistics.deleteMany({ team: teamId });

    // 3. Remove non-completed fixtures involving this team and clean up events
    const fixturesToDelete = await Fixture.find({
      $or: [{ homeTeam: teamId }, { awayTeam: teamId }],
      status: { $ne: "COMPLETED" },
    }).select("_id");
    const fixtureIds = fixturesToDelete.map((f) => f._id);
    if (fixtureIds.length > 0) {
      await MatchEvent.deleteMany({ match: { $in: fixtureIds } });
      await Fixture.deleteMany({ _id: { $in: fixtureIds } });
    }

    await Team.findByIdAndDelete(teamId);

    return res.status(200).json({
      success: true,
      message: "Team deleted successfully",
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
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
    return res.status(500).json({ success: false, message: err.message });
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
    return res.status(500).json({ success: false, message: err.message });
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
    return res.status(500).json({ success: false, message: err.message });
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
    return res.status(500).json({ success: false, message: err.message });
  }
};

exports.getAdminLeagueData = async (req, res) => {
  try {
    const { leagueId } = req.params;
    const { tab, round } = req.query;

    if (!mongoose.Types.ObjectId.isValid(leagueId)) {
      return res.status(400).json({ success: false, message: "Invalid League ID format" });
    }

    const league = await League.findById(leagueId).populate({
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
      const tStat = t.statistics || {};
      const record = (s && (s.played > 0 || s.points > 0 || s.won > 0 || s.drawn > 0 || s.lost > 0))
        ? s
        : (leagueStat && (leagueStat.played > 0 || leagueStat.points > 0 || leagueStat.won > 0 || leagueStat.drawn > 0 || leagueStat.lost > 0))
          ? leagueStat
          : (tStat.played > 0 || tStat.points > 0 || tStat.won > 0 || tStat.drawn > 0 || tStat.lost > 0)
            ? tStat
            : (s || leagueStat || tStat || {
              played: 0,
              won: 0,
              drawn: 0,
              lost: 0,
              goalsFor: 0,
              goalsAgainst: 0,
              goalDifference: 0,
              points: 0,
            });

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
        status: "ACTIVE",
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
          if ((ps.goals || 0) > playerTelemetryMap[pId].goals) playerTelemetryMap[pId].goals = ps.goals;
          if ((ps.assists || 0) > playerTelemetryMap[pId].assists) playerTelemetryMap[pId].assists = ps.assists;
          playerTelemetryMap[pId].appearances = Math.max(playerTelemetryMap[pId].appearances, ps.appearances || 0);
          playerTelemetryMap[pId].totalPoints = playerTelemetryMap[pId].goals + playerTelemetryMap[pId].assists;
        }
      });
    } catch (e) {}

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

    const winPts = league.pointsForWin || 3;
    const drawPts = league.pointsForDraw || 1;

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
        logo: league.logo,
        description: league.description,
        type: league.type,
        status: league.status,
        startDate: league.startDate,
        endDate: league.endDate,
        registrationStartDate: league.registrationStartDate,
        registrationEndDate: league.registrationEndDate,
        visibility: league.visibility,
        pointsForWin: league.pointsForWin,
        pointsForDraw: league.pointsForDraw,
        allowDraws: league.allowDraws,
        automaticLadderRecalculation: league.automaticLadderRecalculation,
        fixtureFormat: league.fixtureFormat || "ROUND_ROBIN",
        numberOfRounds: league.numberOfRounds || 1,
        matchDuration: league.matchDuration || 90,
        breakBetweenMatches: league.breakBetweenMatches || 15,
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
        logo: league.logo,
        description: league.description,
        type: league.type,
        status: league.status,
        startDate: league.startDate,
        endDate: league.endDate,
        registrationStartDate: league.registrationStartDate,
        registrationEndDate: league.registrationEndDate,
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
    return res.status(500).json({ success: false, message: err.message });
  }
};

exports.updateLeague = async (req, res) => {
  try {
    const { leagueId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(leagueId)) {
      return res.status(400).json({ success: false, message: "Invalid League ID format" });
    }

    const league = await League.findById(leagueId);
    if (!league) {
      return res.status(404).json({ success: false, message: "League not found" });
    }

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
      term,
      fee,
      sessionDates,
      numberOfRounds,
      fixtureFormat,
      groupCount,
      matchDuration,
      breakBetweenMatches,
      numberOfFields,
      startTime,
      generationType,
      groups,
    } = req.body;

    // Validate and update name / season with duplicate check
    const newName = name !== undefined ? name.trim() : league.name;
    const newSeason = season !== undefined ? season.trim() : league.season;

    if (!newName || !newSeason) {
      return res.status(400).json({
        success: false,
        message: "Name and season cannot be empty.",
      });
    }

    if (name !== undefined || season !== undefined) {
      const existingLeague = await League.findOne({
        _id: { $ne: leagueId },
        name: newName,
        season: newSeason,
      });

      if (existingLeague) {
        return res.status(409).json({
          success: false,
          message: "League already exists for this season.",
        });
      }

      league.name = newName;
      league.season = newSeason;
    }

    if (description !== undefined) {
      league.description = description.trim();
    }

    // Dates validation
    let effectiveStartDate = league.startDate;
    let effectiveEndDate = league.endDate;

    if (startDate !== undefined) {
      const parsedStart = parseDateToMidnight(startDate);
      if (!parsedStart) {
        return res.status(400).json({
          success: false,
          message: "Invalid start date format.",
        });
      }
      effectiveStartDate = parsedStart;
      league.startDate = parsedStart;
    }

    if (endDate !== undefined) {
      const parsedEnd = parseDateToMidnight(endDate);
      if (!parsedEnd) {
        return res.status(400).json({
          success: false,
          message: "Invalid end date format.",
        });
      }
      effectiveEndDate = parsedEnd;
      league.endDate = parsedEnd;
    }

    if (effectiveEndDate < effectiveStartDate) {
      return res.status(400).json({
        success: false,
        message: "End date cannot be earlier than start date.",
      });
    }

    // if (registrationStartDate !== undefined) {
    //   league.registrationStartDate = registrationStartDate ? parseDateToMidnight(registrationStartDate) : null;
    // }
    // if (registrationEndDate !== undefined) {
    //   league.registrationEndDate = registrationEndDate ? parseDateToMidnight(registrationEndDate) : null;
    // }

    if (status && ["UPCOMING", "ACTIVE", "COMPLETED"].includes(status.toUpperCase())) {
      league.status = status.toUpperCase();
    }

    const rawType = (type || leagueType || competitionScope || "").toUpperCase();
    const VALID_TYPES = ["INTERNATIONAL", "NATIONAL", "STATE", "LOCAL", "OTHERS"];
    if (rawType && VALID_TYPES.includes(rawType)) {
      league.type = rawType;
    }

    if (visibility && ["PUBLIC", "PRIVATE"].includes(visibility.toUpperCase())) {
      league.visibility = visibility.toUpperCase();
    }

    if (term !== undefined) {
      if (!term || term === "null" || term === "") {
        league.term = null;
      } else if (mongoose.Types.ObjectId.isValid(term)) {
        league.term = term;
      } else {
        return res.status(400).json({
          success: false,
          message: "Invalid Term ID format.",
        });
      }
    }

    // Points and rules
    let pointsChanged = false;
    if (pointsForWin !== undefined && !isNaN(Number(pointsForWin))) {
      const newWinPts = Number(pointsForWin);
      if (league.pointsForWin !== newWinPts) {
        league.pointsForWin = newWinPts;
        pointsChanged = true;
      }
    }

    if (pointsForDraw !== undefined && !isNaN(Number(pointsForDraw))) {
      const newDrawPts = Number(pointsForDraw);
      if (league.pointsForDraw !== newDrawPts) {
        league.pointsForDraw = newDrawPts;
        pointsChanged = true;
      }
    }

    if (allowDraws !== undefined) {
      const newAllowDraws = Boolean(allowDraws === "true" || allowDraws === true);
      if (league.allowDraws !== newAllowDraws) {
        league.allowDraws = newAllowDraws;
        pointsChanged = true;
      }
    }

    if (automaticLadderRecalculation !== undefined) {
      league.automaticLadderRecalculation = Boolean(
        automaticLadderRecalculation === "true" || automaticLadderRecalculation === true
      );
    }

    // Fee
    let feeChanged = false;
    if (fee !== undefined && fee !== null && !isNaN(Number(fee))) {
      const parsedFee = Math.max(0, Number(fee));
      if (league.fee !== parsedFee) {
        league.fee = parsedFee;
        feeChanged = true;
      }
    }

    // Session dates
    let sessionDatesChanged = false;
    let parsedSessionDates = null;
    if (sessionDates !== undefined) {
      let rawSessionDates = sessionDates;
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

      if (Array.isArray(rawSessionDates)) {
        parsedSessionDates = rawSessionDates
          .map((d) => parseDateToMidnight(d))
          .filter(Boolean);
        league.sessionDates = parsedSessionDates;
        sessionDatesChanged = true;
      }
    }

    // Number of rounds
    let roundsChanged = false;
    if (numberOfRounds !== undefined && !isNaN(parseInt(numberOfRounds, 10))) {
      const parsedRounds = Math.max(1, parseInt(numberOfRounds, 10));
      if (league.numberOfRounds !== parsedRounds) {
        league.numberOfRounds = parsedRounds;
        roundsChanged = true;
      }
    } else if (sessionDatesChanged && parsedSessionDates && parsedSessionDates.length > 0) {
      league.numberOfRounds = parsedSessionDates.length;
      roundsChanged = true;
    }

    // Tournament & scheduling configs
    if (fixtureFormat) {
      const validFormats = ["ROUND_ROBIN", "GROUP", "KNOCKOUT"];
      const parsedFmt = fixtureFormat.toString().toUpperCase().trim();
      if (validFormats.includes(parsedFmt)) {
        league.fixtureFormat = parsedFmt;
      }
    }

    if (groupCount !== undefined && !isNaN(parseInt(groupCount, 10))) {
      league.groupCount = Math.max(1, parseInt(groupCount, 10));
    }

    if (matchDuration !== undefined && !isNaN(parseInt(matchDuration, 10))) {
      league.matchDuration = Math.max(1, parseInt(matchDuration, 10));
    }

    if (breakBetweenMatches !== undefined && !isNaN(parseInt(breakBetweenMatches, 10))) {
      league.breakBetweenMatches = Math.max(0, parseInt(breakBetweenMatches, 10));
    }

    if (numberOfFields !== undefined && !isNaN(parseInt(numberOfFields, 10))) {
      league.numberOfFields = Math.max(1, parseInt(numberOfFields, 10));
    }

    if (startTime && typeof startTime === "string") {
      league.startTime = startTime.trim();
    }

    if (generationType) {
      const parsedGen = generationType.toString().toUpperCase().trim();
      if (["AUTOMATIC", "MANUAL"].includes(parsedGen)) {
        league.generationType = parsedGen;
      }
    }

    let groupsChanged = false;
    if (groups !== undefined) {
      let rawGroups = groups;
      if (typeof rawGroups === "string") {
        try {
          rawGroups = JSON.parse(rawGroups);
        } catch (e) {
          rawGroups = [];
        }
      }
      if (Array.isArray(rawGroups)) {
        league.groups = rawGroups;
        groupsChanged = true;
      }
    }

    // Teams
    let teamsChanged = false;
    let verifiedTeamIds = [];
    let removedTeamIds = [];
    let addedTeamIds = [];
    if (teams !== undefined) {
      let rawTeams = teams;
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
        const rawIds = rawTeams.map((id) => (id ? id.toString().trim() : "")).filter(Boolean);
        const invalidId = rawIds.find((id) => !mongoose.Types.ObjectId.isValid(id));
        if (invalidId) {
          return res.status(400).json({
            success: false,
            message: `Invalid team ID format: "${invalidId}".`,
          });
        }
        verifiedTeamIds = [...new Set(rawIds)];

        if (verifiedTeamIds.length > 0) {
          const existingCount = await Team.countDocuments({ _id: { $in: verifiedTeamIds } });
          if (existingCount !== verifiedTeamIds.length) {
            return res.status(404).json({
              success: false,
              message: "One or more selected teams do not exist in the database.",
            });
          }
        }

        const previousTeamIds = (league.teams || []).map((id) => id.toString());
        const currentTeamIds = verifiedTeamIds.map((id) => id.toString());
        removedTeamIds = previousTeamIds.filter((id) => !currentTeamIds.includes(id));
        addedTeamIds = currentTeamIds.filter((id) => !previousTeamIds.includes(id));

        league.teams = verifiedTeamIds;
        teamsChanged = true;

        // Cleanup Standings, PlayerStatistics, and non-completed fixtures for REMOVED teams
        if (removedTeamIds.length > 0) {
          await Standing.deleteMany({ league: league._id, team: { $in: removedTeamIds } });
          await PlayerStatistics.deleteMany({ league: league._id, team: { $in: removedTeamIds } });

          const fixturesToRemove = await Fixture.find({
            league: league._id,
            $or: [
              { homeTeam: { $in: removedTeamIds } },
              { awayTeam: { $in: removedTeamIds } },
            ],
            status: { $ne: "COMPLETED" },
          }).select("_id");
          const fixtureIdsToRemove = fixturesToRemove.map((f) => f._id);
          if (fixtureIdsToRemove.length > 0) {
            await MatchEvent.deleteMany({ match: { $in: fixtureIdsToRemove } });
            await Fixture.deleteMany({ _id: { $in: fixtureIdsToRemove } });
          }

          if (Array.isArray(league.groups)) {
            league.groups.forEach((g) => {
              if (Array.isArray(g.teams)) {
                g.teams = g.teams.filter(
                  (tId) => !removedTeamIds.includes(tId ? tId.toString() : "")
                );
              }
            });
          }
        }

        // Upsert standings for all teams in the league
        if (verifiedTeamIds.length > 0) {
          const standingOps = verifiedTeamIds.map((tId) => ({
            updateOne: {
              filter: { league: league._id, team: tId },
              update: {
                $setOnInsert: {
                  league: league._id,
                  team: tId,
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
          await Standing.bulkWrite(standingOps);
        }

        if (addedTeamIds.length > 0 && league.fee > 0) {
          for (const tId of addedTeamIds) {
            try {
              await processLeagueInvoicesForTeam({ leagueId: league._id, teamId: tId });
            } catch (invErr) {
              console.error(`[League] Error processing invoices for added team ${tId}:`, invErr.message);
            }
          }
        }
      }
    }

    // Logo upload
    if (req.file) {
      if (league.logo && league.logo.startsWith("/uploads/")) {
        const oldLogoPath = path.join(__dirname, "..", league.logo);
        fs.unlink(oldLogoPath, (err) => {
          if (err && err.code !== "ENOENT") {
            console.error("Failed to delete previous league logo:", err);
          }
        });
      }
      league.logo = `/uploads/leaguelogos/${req.file.filename}`;
    }

    // Synchronize enrolled teams with league fee, sessionDates, and numberOfRounds if updated
    const teamsToSync = teamsChanged ? verifiedTeamIds : (league.teams || []);
    if ((teamsChanged || feeChanged || sessionDatesChanged || roundsChanged || groupsChanged) && teamsToSync.length > 0) {
      await syncTeamsLeagueData({
        teamIds: teamsToSync,
        leagueId: league._id,
        teamFee: league.fee || 0,
        round: league.numberOfRounds || null,
        sessionDates: league.sessionDates || [],
        groups: league.groups || [],
        status: "ACTIVE",
      });
    }

    if (teamsChanged && removedTeamIds.length > 0) {
      await Team.updateMany(
        { _id: { $in: removedTeamIds } },
        {
          $pull: {
            leagues: { league: league._id },
          },
        }
      );
    }

    // Recalculate standings if points rules were updated and automatic recalculation is enabled
    if (pointsChanged && league.automaticLadderRecalculation) {
      try {
        await recalculateLeagueStandings(league._id);
      } catch (ladderErr) {
        console.error("[League] Error recalculating standings after league update:", ladderErr.message);
      }
    }

    await league.save();

    const updatedLeague = await League.findById(leagueId).populate("teams", "teamName logo");

    return res.status(200).json({
      success: true,
      message: "League updated successfully",
      data: updatedLeague,
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

exports.addTeamToLeague = async (req, res) => {
  try {
    const { leagueId } = req.params;
    const { teamId, teamIds } = req.body;

    if (!mongoose.Types.ObjectId.isValid(leagueId)) {
      return res.status(400).json({ success: false, message: "Invalid League ID format" });
    }

    const league = await League.findById(leagueId);
    if (!league) {
      return res.status(404).json({ success: false, message: "League not found" });
    }

    const teamsToAdd = [];
    if (teamId) teamsToAdd.push(teamId);
    if (Array.isArray(teamIds)) teamsToAdd.push(...teamIds);

    const validTeamIds = teamsToAdd.filter((id) => mongoose.Types.ObjectId.isValid(id));
    if (validTeamIds.length === 0) {
      return res.status(400).json({ success: false, message: "No valid team ID(s) provided" });
    }

    const existingTeams = await Team.find({ _id: { $in: validTeamIds } });
    if (existingTeams.length === 0) {
      return res.status(404).json({ success: false, message: "Specified teams not found" });
    }

    const foundIds = existingTeams.map((t) => t._id);
    await League.findByIdAndUpdate(leagueId, {
      $addToSet: { teams: { $each: foundIds } },
    });

    // Synchronize enrolled teams with league fee, sessionDates, and numberOfRounds
    await syncTeamsLeagueData({
      teamIds: foundIds,
      leagueId: league._id,
      teamFee: league.fee || 0,
      round: league.numberOfRounds || null,
      sessionDates: league.sessionDates || [],
      groups: league.groups || [],
      status: "ACTIVE",
    });

    // Generate league fee invoices for UNPAID players in newly enrolled teams
    if (league.fee > 0) {
      for (const tId of foundIds) {
        try {
          await processLeagueInvoicesForTeam({ leagueId: league._id, teamId: tId });
        } catch (invErr) {
          console.error(`[League] Error processing invoices for enrolled team ${tId}:`, invErr.message);
        }
      }
    }

    const standingPromises = foundIds.map((tId) =>
      Standing.findOneAndUpdate(
        { league: leagueId, team: tId },
        {
          $setOnInsert: {
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
        { upsert: true, new: true }
      )
    );
    await Promise.all(standingPromises);

    const updatedLeague = await League.findById(leagueId).populate("teams", "teamName logo");

    return res.status(200).json({
      success: true,
      message: "Team(s) enrolled into league successfully",
      data: updatedLeague,
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

exports.removeTeamFromLeague = async (req, res) => {
  try {
    const { leagueId, teamId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(leagueId) || !mongoose.Types.ObjectId.isValid(teamId)) {
      return res.status(400).json({ success: false, message: "Invalid ID format" });
    }

    const league = await League.findById(leagueId);
    if (!league) {
      return res.status(404).json({ success: false, message: "League not found" });
    }

    const fixtureCount = await Fixture.countDocuments({
      league: leagueId,
      $or: [{ homeTeam: teamId }, { awayTeam: teamId }],
      status: "COMPLETED",
    });

    if (fixtureCount > 0) {
      return res.status(400).json({
        success: false,
        message: "Cannot remove team as it already has completed fixtures in this league.",
      });
    }

    await League.findByIdAndUpdate(leagueId, {
      $pull: { teams: teamId },
    });

    await Team.findByIdAndUpdate(teamId, {
      $pull: { leagues: { league: leagueId } },
    });

    await Standing.deleteOne({ league: leagueId, team: teamId, played: 0 });

    return res.status(200).json({
      success: true,
      message: "Team removed from league successfully",
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

const recalculateLeagueStandings = async (leagueId) => {
  const league = await League.findById(leagueId);
  if (!league) return null;

  const pointsForWin = league.pointsForWin !== undefined ? Number(league.pointsForWin) : 3;
  const pointsForDraw = league.pointsForDraw !== undefined ? Number(league.pointsForDraw) : 1;

  const fixtureTeamsHome = await Fixture.find({ league: leagueId }).distinct("homeTeam");
  const fixtureTeamsAway = await Fixture.find({ league: leagueId }).distinct("awayTeam");
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
  });

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
    await Standing.bulkWrite(bulkOps);
  }

  const teamBulkOps = Object.keys(teamStats).map((tId) => ({
    updateOne: {
      filter: { _id: tId, "leagues.league": leagueId },
      update: { $set: { "leagues.$.statistics": teamStats[tId] } },
    },
  }));
  if (teamBulkOps.length > 0) {
    await Team.bulkWrite(teamBulkOps);
  }

  return teamStats;
};

exports.recalculateLadder = async (req, res) => {
  try {
    const { leagueId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(leagueId)) {
      return res.status(400).json({ success: false, message: "Invalid League ID format" });
    }

    const league = await League.findById(leagueId);
    if (!league) {
      return res.status(404).json({ success: false, message: "League not found" });
    }

    const teamStats = await recalculateLeagueStandings(leagueId);

    return res.status(200).json({
      success: true,
      message: "League ladder and statistics recalculated successfully",
      data: teamStats,
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
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

    if (isNaN(newHomeScore) || newHomeScore < 0 || isNaN(newAwayScore) || newAwayScore < 0) {
      return res.status(400).json({ success: false, message: "Scores must be non-negative numbers" });
    }

    const scoreChanged = newHomeScore !== oldHomeScore || newAwayScore !== oldAwayScore;

    // 3. Resolve NEW status
    let newStatus = oldStatus;
    if (status && ["SCHEDULED", "LIVE", "COMPLETED", "POSTPONED"].includes(status.toUpperCase())) {
      newStatus = status.toUpperCase();
    } else if (scoreChanged && oldStatus === "SCHEDULED") {
      newStatus = "COMPLETED";
    }

    // 4. Resolve and validate NEW teams
    const newHomeTeam = (homeTeam && mongoose.Types.ObjectId.isValid(homeTeam)) ? homeTeam : oldHomeTeam;
    const newAwayTeam = (awayTeam && mongoose.Types.ObjectId.isValid(awayTeam)) ? awayTeam : oldAwayTeam;

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

    // 7. Calculate Global Player Goal & Assist Contributions (OLD vs NEW)
    const oldPlayerGoals = {};
    const oldPlayerAssists = {};
    if (oldStatus === "COMPLETED") {
      for (const g of oldGoals) {
        if (g.scorer) {
          const s = g.scorer.toString();
          oldPlayerGoals[s] = (oldPlayerGoals[s] || 0) + 1;
        }
        if (g.assist) {
          const a = g.assist.toString();
          oldPlayerAssists[a] = (oldPlayerAssists[a] || 0) + 1;
        }
      }
    }

    const newPlayerGoals = {};
    const newPlayerAssists = {};
    if (newStatus === "COMPLETED") {
      for (const g of effectiveNewGoals) {
        if (g.scorer) {
          const s = g.scorer.toString();
          newPlayerGoals[s] = (newPlayerGoals[s] || 0) + 1;
        }
        if (g.assist) {
          const a = g.assist.toString();
          newPlayerAssists[a] = (newPlayerAssists[a] || 0) + 1;
        }
      }
    }

    const allAffectedPlayerIds = new Set([
      ...Object.keys(oldPlayerGoals),
      ...Object.keys(newPlayerGoals),
      ...Object.keys(oldPlayerAssists),
      ...Object.keys(newPlayerAssists),
    ]);

    const playerDeltas = {};
    for (const pId of allAffectedPlayerIds) {
      const gDelta = (newPlayerGoals[pId] || 0) - (oldPlayerGoals[pId] || 0);
      const aDelta = (newPlayerAssists[pId] || 0) - (oldPlayerAssists[pId] || 0);
      if (gDelta !== 0 || aDelta !== 0) {
        playerDeltas[pId] = { goals: gDelta, assists: aDelta };
      }
    }

    // 8. Execute updates within a MongoDB session/transaction if supported
    let session = null;
    let useSession = false;
    try {
      session = await mongoose.startSession();
      session.startTransaction();
      useSession = true;
    } catch (sessionErr) {
      useSession = false;
      session = null;
    }
    const sessionOption = useSession ? { session } : {};

    try {
      // A. Update Fixture fields
      match.score.homeScore = newHomeScore;
      match.score.awayScore = newAwayScore;
      match.status = newStatus;
      match.homeTeam = newHomeTeam;
      match.awayTeam = newAwayTeam;

      if (round !== undefined && !isNaN(Number(round))) {
        match.round = Math.max(1, parseInt(round, 10));
        isScheduleModified = true;
      }
      if (kickoffTime) {
        match.kickoffTime = new Date(kickoffTime);
        isScheduleModified = true;
      }
      if (endTime !== undefined) {
        match.endTime = new Date(endTime);
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
        if (delta.goals !== 0) inc["statistics.goals"] = delta.goals;
        if (delta.assists !== 0) inc["statistics.assists"] = delta.assists;

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
        if (delta.goals !== 0) inc["goals"] = delta.goals;
        if (delta.assists !== 0) inc["assists"] = delta.assists;

        if (Object.keys(inc).length > 0) {
          const goalMatch = effectiveNewGoals.find((g) => g.scorer === pId || g.assist === pId)
            || oldGoals.find((g) => g.scorer === pId || g.assist === pId);
          const pTeamId = goalMatch?.team || newHomeTeam;

          playerStatsOps.push({
            updateOne: {
              filter: { player: pId, league: oldLeague },
              update: {
                $inc: inc,
                $set: { team: pTeamId },
                $setOnInsert: { appearances: 0, cleanSheets: 0, minutesPlayed: 0, yellowCards: 0, redCards: 0 },
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
    return res.status(500).json({ success: false, message: err.message });
  }
};

exports.deleteFixture = async (req, res) => {
  try {
    const matchId = req.params.fixtureId || req.params.matchId;

    if (!mongoose.Types.ObjectId.isValid(matchId)) {
      return res.status(400).json({ success: false, message: "Invalid Match ID format" });
    }

    const match = await Fixture.findById(matchId);
    if (!match) {
      return res.status(404).json({ success: false, message: "Fixture not found" });
    }

    const leagueId = match.league;
    const wasCompleted = match.status === "COMPLETED";

    await Fixture.findByIdAndDelete(matchId);

    if (wasCompleted) {
      await recalculateLeagueStandings(leagueId);
    }

    return res.status(200).json({
      success: true,
      message: "Fixture deleted successfully",
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

exports.deleteRoundFixtures = async (req, res) => {
  try {
    const leagueId = req.params.leagueId || req.body.leagueId || req.query.leagueId;
    const round = req.params.round || req.body.round || req.query.round;

    if (!leagueId || !mongoose.Types.ObjectId.isValid(leagueId)) {
      return res.status(400).json({ success: false, message: "Valid League ID is required" });
    }

    const roundNum = Number(round);
    if (!round || isNaN(roundNum) || roundNum < 1) {
      return res.status(400).json({ success: false, message: "A valid positive round number is required" });
    }

    const league = await League.findById(leagueId);
    if (!league) {
      return res.status(404).json({ success: false, message: "League not found" });
    }

    const fixtures = await Fixture.find({ league: leagueId, round: roundNum });
    if (!fixtures || fixtures.length === 0) {
      return res.status(404).json({
        success: false,
        message: `No fixtures found for round ${roundNum} in this league`,
      });
    }

    const fixtureIds = fixtures.map((f) => f._id);
    const wasAnyCompleted = fixtures.some((f) => f.status === "COMPLETED");

    await Promise.all([
      Fixture.deleteMany({ _id: { $in: fixtureIds } }),
      MatchEvent.deleteMany({ match: { $in: fixtureIds } }),
    ]);

    if (wasAnyCompleted) {
      await recalculateLeagueStandings(leagueId);
    }

    return res.status(200).json({
      success: true,
      message: `Round ${roundNum} fixtures deleted successfully (${fixtures.length} fixture${fixtures.length > 1 ? "s" : ""} removed)`,
      data: {
        leagueId,
        round: roundNum,
        deletedCount: fixtures.length,
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
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

    if (!team.statistics) {
      team.statistics = {
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

    if (played !== undefined) team.statistics.played = Number(played);
    if (won !== undefined) team.statistics.won = Number(won);
    if (drawn !== undefined) team.statistics.drawn = Number(drawn);
    if (lost !== undefined) team.statistics.lost = Number(lost);
    if (goalsFor !== undefined) team.statistics.goalsFor = Number(goalsFor);
    if (goalsAgainst !== undefined) team.statistics.goalsAgainst = Number(goalsAgainst);

    if (goalDifference !== undefined) {
      team.statistics.goalDifference = Number(goalDifference);
    } else if (goalsFor !== undefined || goalsAgainst !== undefined) {
      team.statistics.goalDifference = team.statistics.goalsFor - team.statistics.goalsAgainst;
    }

    if (points !== undefined) team.statistics.points = Number(points);

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
    return res.status(500).json({ success: false, message: err.message });
  }
};

exports.updateTeamPlayerStatistics = async (req, res) => {
  try {
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
    return res.status(500).json({ success: false, message: error.message });
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
    return res.status(500).json({ success: false, message: error.message });
  }
};

exports.updateLeagueTeamStatistics = async (req, res) => {
  try {
    const { leagueId, teamId } = req.params;
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

    if (!mongoose.Types.ObjectId.isValid(leagueId) || !mongoose.Types.ObjectId.isValid(teamId)) {
      return res.status(400).json({ success: false, message: "Invalid ID format" });
    }

    const [league, team] = await Promise.all([
      League.findById(leagueId),
      Team.findById(teamId),
    ]);

    if (!league) {
      return res.status(404).json({ success: false, message: "League not found" });
    }
    if (!team) {
      return res.status(404).json({ success: false, message: "Team not found" });
    }

    await League.findByIdAndUpdate(leagueId, {
      $addToSet: { teams: teamId },
    });

    const updateFields = {};
    if (played !== undefined) updateFields.played = Number(played);
    if (won !== undefined) updateFields.won = Number(won);
    if (drawn !== undefined) updateFields.drawn = Number(drawn);
    if (lost !== undefined) updateFields.lost = Number(lost);
    if (goalsFor !== undefined) updateFields.goalsFor = Number(goalsFor);
    if (goalsAgainst !== undefined) updateFields.goalsAgainst = Number(goalsAgainst);

    const gf = updateFields.goalsFor !== undefined ? updateFields.goalsFor : 0;
    const ga = updateFields.goalsAgainst !== undefined ? updateFields.goalsAgainst : 0;
    updateFields.goalDifference = goalDifference !== undefined ? Number(goalDifference) : gf - ga;

    if (points !== undefined) {
      updateFields.points = Number(points);
    } else if (won !== undefined || drawn !== undefined) {
      const winPts = league.pointsForWin !== undefined ? Number(league.pointsForWin) : 3;
      const drawPts = league.pointsForDraw !== undefined ? Number(league.pointsForDraw) : 1;
      updateFields.points = (Number(won || 0) * winPts) + (Number(drawn || 0) * drawPts);
    }

    const standing = await Standing.findOneAndUpdate(
      { league: leagueId, team: teamId },
      { $set: updateFields },
      { upsert: true, new: true }
    );

    if (!team.statistics) team.statistics = {};
    Object.assign(team.statistics, updateFields);
    await team.save();

    return res.status(200).json({
      success: true,
      message: "League team statistics updated successfully",
      data: {
        leagueId,
        teamId,
        teamName: team.teamName,
        standing,
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
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

    // 1. Find all fixture IDs for this league to delete their associated match events
    const fixtures = await Fixture.find({ league: leagueId }).select("_id");
    const fixtureIds = fixtures.map((f) => f._id);

    if (fixtureIds.length > 0) {
      await MatchEvent.deleteMany({ match: { $in: fixtureIds } });
    }

    // 2. Delete all fixtures belonging to this league
    const fixtureDeleteResult = await Fixture.deleteMany({ league: leagueId });

    // 3. Delete standings and player statistics associated with this league
    await Standing.deleteMany({ league: leagueId });
    await PlayerStatistics.deleteMany({ league: leagueId });

    // 4. Remove league logo file if stored locally
    if (league.logo) {
      const logoPath = path.join(__dirname, "..", league.logo);
      fs.unlink(logoPath, (err) => {
        if (err && err.code !== "ENOENT") {
          console.error("Failed to delete league logo on league deletion:", err);
        }
      });
    }

    // 5. Clean up league enrollment from all associated teams
    await Team.updateMany(
      { "leagues.league": leagueId },
      { $pull: { leagues: { league: leagueId } } }
    );

    // 6. Delete the league document
    await League.findByIdAndDelete(leagueId);

    return res.status(200).json({
      success: true,
      message: "League and its associated fixtures deleted successfully",
      data: {
        deletedLeagueId: leagueId,
        fixturesDeleted: fixtureDeleteResult.deletedCount || 0,
      },
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};



