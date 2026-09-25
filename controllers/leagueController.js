const League = require("../models/League");
const Team = require("../models/Team");
const Fixture = require("../models/Fixture");
const MatchEvent = require("../models/MatchEvent");
const Standing = require("../models/Standing");
const PlayerStatistics = require("../models/PlayerStatistics");
const User = require("../models/User");
const Admin = require("../models/Admin");
const {
  generateTeamInvoice,
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
      registrationStartDate,
      registrationEndDate,
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
    const parsedFee =
      fee !== undefined && fee !== null && !isNaN(Number(fee))
        ? Math.max(0, Number(fee))
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
          registrationStartDate: registrationStartDate
            ? parseDateToMidnight(registrationStartDate)
            : null,
          registrationEndDate: registrationEndDate
            ? parseDateToMidnight(registrationEndDate)
            : null,
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

      // 3. Synchronize team model with fee, sessionDates, and numberOfRounds
      if (verifiedTeamIds.length > 0) {
        await Team.updateMany(
          { _id: { $in: verifiedTeamIds } },
          {
            $set: {
              teamFee: parsedFee,
              sessionDates: parsedSessionDates,
              round: norm.numberOfRounds,
            },
          },
          sessionOption
        );
      }

      if (useSession && session) {
        await session.commitTransaction();
        session.endSession();
      }

      // 4. Generate league fee invoices for all UNPAID players across assigned teams
      if (parsedFee > 0 && verifiedTeamIds.length > 0) {
        for (const tId of verifiedTeamIds) {
          try {
            await processLeagueInvoicesForTeam({ leagueId: league._id, teamId: tId });
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

        // Synchronize team model with fee, sessionDates, and numberOfRounds
        await Team.updateMany(
          { _id: { $in: verifiedTeamIds } },
          {
            $set: {
              teamFee: parsedFee,
              sessionDates: parsedSessionDates,
              round: norm.numberOfRounds,
            },
          },
          sessionOption
        );
      }

      if (useSession && session) {
        await session.commitTransaction();
        session.endSession();
      }

      // Generate league fee invoices for all UNPAID players across assigned teams
      if (parsedFee > 0 && verifiedTeamIds.length > 0) {
        for (const tId of verifiedTeamIds) {
          try {
            await processLeagueInvoicesForTeam({ leagueId: league._id, teamId: tId });
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

    const [leagues, total] = await Promise.all([
      League.find(filter)
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

    const existingPlayerMap = new Map();
    (team.players || []).forEach((p) => {
      const pid = p.player ? p.player.toString() : p.toString();
      existingPlayerMap.set(pid, {
        paymentStatus: p.paymentStatus || "TRIAL",
        statistics: p.statistics
          ? {
            appearances: Number(p.statistics.appearances) || 0,
            goals: Number(p.statistics.goals) || 0,
            assists: Number(p.statistics.assists) || 0,
            cleanSheets: Number(p.statistics.cleanSheets) || 0,
            yellowCards: Number(p.statistics.yellowCards) || 0,
            redCards: Number(p.statistics.redCards) || 0,
            minutesPlayed: Number(p.statistics.minutesPlayed) || 0,
          }
          : {
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

    // Update existing players with their passed paymentStatus, or insert new ones
    playerEntries.forEach(({ id, paymentStatus }) => {
      if (existingPlayerMap.has(id)) {
        const existing = existingPlayerMap.get(id);
        existing.paymentStatus = paymentStatus;
      } else {
        existingPlayerMap.set(id, {
          paymentStatus,
          statistics: {
            appearances: 0,
            goals: 0,
            assists: 0,
            cleanSheets: 0,
            yellowCards: 0,
            redCards: 0,
            minutesPlayed: 0,
          },
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
      statistics: data.statistics,
    }));
    await team.save();

    // Generate invoice ONLY if team.teamFee > 0 AND player's paymentStatus is "UNPAID"
    if (team.teamFee > 0) {
      const processedInvoices = new Set();
      for (const { id: pId, paymentStatus } of playerEntries) {
        if (paymentStatus === "UNPAID" && !processedInvoices.has(pId)) {
          processedInvoices.add(pId);
          try {
            await generateTeamInvoice({ userId: pId, teamId });
          } catch (invErr) {
            console.error(`[Team] Failed to generate team invoice for player ${pId}:`, invErr.message);
          }
        }
      }
    }

    res.json({ success: true, message: "Player assigned to team successfully", data: team });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
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
        { player, league: match.league, team },
        { ...statsUpdate, $setOnInsert: { appearances: 0, cleanSheets: 0, minutesPlayed: 0 } },
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
            team: team._id,
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
    const standings = await Standing.find({ league: leagueId })
      .populate("team", "teamName logo")
      .sort({ points: -1, goalDifference: -1, goalsFor: -1 });

    res.json({ success: true, data: standings });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

exports.getLeagueLeaderboard = async (req, res) => {
  try {
    const { leagueId } = req.params;
    const stats = await PlayerStatistics.find({ league: leagueId })
      .populate("player", "fullName firstName lastName profileImage")
      .populate("team", "teamName logo")
      .sort({ goals: -1, assists: -1 });

    res.json({ success: true, data: stats });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

exports.getFixtures = async (req, res) => {
  try {
    const { leagueId } = req.params;
    const fixtures = await Fixture.find({ league: leagueId })
      .populate("homeTeam", "teamName logo")
      .populate("awayTeam", "teamName logo")
      .sort({ kickoffTime: 1 });

    res.json({ success: true, data: fixtures });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

exports.getTeamById = async (req, res) => {
  try {
    const { teamId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(teamId)) {
      return res.status(400).json({ success: false, message: "Invalid Team ID format" });
    }

    const team = await Team.findById(teamId)
      .populate("coach", "name email mobile profileImage")
      .populate("assistantCoach", "name email mobile profileImage")
      .populate("captain", "firstName lastName fullName email profileImage jerseyNumber")
      .populate("viceCaptain", "firstName lastName fullName email profileImage jerseyNumber")
      .populate("players.player", "firstName lastName fullName email phone dob gender profileImage jerseyNumber statistics rating classPaymentStatuses teamPaymentStatuses");

    if (!team) {
      return res.status(404).json({ success: false, message: "Team not found" });
    }

    const teamObj = team.toObject ? team.toObject() : { ...team };
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
        return pObj;
      });
    }

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

exports.unassignPlayerFromTeam = async (req, res) => {
  try {
    const { teamId } = req.params;
    const { playerId, playerIds } = req.body;

    const rawIds = playerId || playerIds;
    if (!rawIds) {
      return res.status(400).json({ success: false, message: "Player ID(s) required" });
    }

    const normalizedIds = (Array.isArray(rawIds) ? rawIds : [rawIds]).map(id => id.toString());

    const isValid = normalizedIds.every(id => mongoose.Types.ObjectId.isValid(id));
    if (!isValid) {
      return res.status(400).json({ success: false, message: "Invalid player ID format" });
    }

    const team = await Team.findById(teamId);
    if (!team) {
      return res.status(404).json({ success: false, message: "Team not found" });
    }

    if (team.captain && normalizedIds.includes(team.captain.toString())) {
      team.captain = null;
    }
    if (team.viceCaptain && normalizedIds.includes(team.viceCaptain.toString())) {
      team.viceCaptain = null;
    }

    const originalLength = team.players.length;
    team.players = team.players.filter((p) => {
      const pid = p.player ? p.player.toString() : p.toString();
      return !normalizedIds.includes(pid);
    });

    await team.save();

    res.json({
      success: true,
      message: `${originalLength - team.players.length} player(s) unassigned from team successfully`,
      data: team,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
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
      select: "teamName logo coach assistantCoach ageGroup teamType players temporaryPlayers statistics",
      populate: [
        { path: "coach", select: "name email mobile profileImage" },
        { path: "assistantCoach", select: "name email mobile profileImage" },
      ],
    });

    if (!league) {
      return res.status(404).json({ success: false, message: "League not found" });
    }

    // 1. Fetch standings for this league
    const standingsDocs = await Standing.find({ league: leagueId })
      .populate({
        path: "team",
        select: "teamName logo coach assistantCoach ageGroup teamType players temporaryPlayers statistics",
        populate: [
          { path: "coach", select: "name email mobile profileImage" },
          { path: "assistantCoach", select: "name email mobile profileImage" },
        ],
      })
      .sort({ points: -1, goalDifference: -1, goalsFor: -1 });

    const standingsMap = {};
    standingsDocs.forEach((s) => {
      if (s.team && s.team._id) {
        standingsMap[s.team._id.toString()] = s;
      }
    });

    // 2. Fetch all fixtures for this league
    const fixtureFilter = { league: leagueId };
    if (round) {
      fixtureFilter.round = Number(round);
    }
    const allFixtures = await Fixture.find(fixtureFilter)
      .populate("homeTeam", "teamName logo")
      .populate("awayTeam", "teamName logo")
      .sort({ round: 1, kickoffTime: 1 });

    // 3. Aggregate all participating teams (union of league.teams and teams in standings/fixtures)
    const teamsMap = new Map();
    (league.teams || []).forEach((t) => {
      if (t && t._id) teamsMap.set(t._id.toString(), t);
    });
    standingsDocs.forEach((s) => {
      if (s.team && s.team._id && !teamsMap.has(s.team._id.toString())) {
        teamsMap.set(s.team._id.toString(), s.team);
      }
    });

    const participatingTeams = Array.from(teamsMap.values()).map((t) => {
      const s = standingsMap[t._id.toString()];
      const tStat = t.statistics || {};
      const record = s && (s.played > 0 || s.points > 0 || s.won > 0 || s.drawn > 0 || s.lost > 0)
        ? s
        : (tStat.played > 0 || tStat.points > 0 || tStat.won > 0 || tStat.drawn > 0 || tStat.lost > 0)
          ? tStat
          : (s || tStat || {
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

    // 4. Ladder / Standings with rank
    const ladderMap = new Map();
    standingsDocs.forEach((s) => {
      if (s.team && s.team._id) {
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
      }
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
      registrationStartDate,
      registrationEndDate,
      status,
      type,
      leagueType,
      competitionScope,
      visibility,
      pointsForWin,
      pointsForDraw,
      allowDraws,
      automaticLadderRecalculation,
    } = req.body;

    if (name) league.name = name.trim();
    if (season) league.season = season.trim();
    if (description !== undefined) league.description = description.trim();
    if (startDate) league.startDate = new Date(startDate);
    if (endDate) league.endDate = new Date(endDate);
    if (registrationStartDate !== undefined) {
      league.registrationStartDate = registrationStartDate ? new Date(registrationStartDate) : null;
    }
    if (registrationEndDate !== undefined) {
      league.registrationEndDate = registrationEndDate ? new Date(registrationEndDate) : null;
    }

    if (status && ["UPCOMING", "ACTIVE", "COMPLETED"].includes(status.toUpperCase())) {
      league.status = status.toUpperCase();
    }

    const rawType = (type || leagueType || competitionScope || "").toUpperCase();
    if (rawType && ["INTERNATIONAL", "NATIONAL", "STATE", "LOCAL", "OTHERS"].includes(rawType)) {
      league.type = rawType;
    }

    if (visibility && ["PUBLIC", "PRIVATE"].includes(visibility.toUpperCase())) {
      league.visibility = visibility.toUpperCase();
    }

    if (pointsForWin !== undefined) league.pointsForWin = Number(pointsForWin);
    if (pointsForDraw !== undefined) league.pointsForDraw = Number(pointsForDraw);
    if (allowDraws !== undefined) {
      league.allowDraws = Boolean(allowDraws === "true" || allowDraws === true);
    }
    if (automaticLadderRecalculation !== undefined) {
      league.automaticLadderRecalculation = Boolean(
        automaticLadderRecalculation === "true" || automaticLadderRecalculation === true
      );
    }

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

    await league.save();

    return res.status(200).json({
      success: true,
      message: "League updated successfully",
      data: league,
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
    await Team.updateMany(
      { _id: { $in: foundIds } },
      {
        $set: {
          teamFee: league.fee || 0,
          sessionDates: league.sessionDates || [],
          round: league.numberOfRounds || null,
        },
      }
    );

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
      filter: { _id: tId },
      update: { $set: { statistics: teamStats[tId] } },
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
    } = req.body;

    let scoreChanged = false;
    let statusChanged = false;
    let isScheduleModified = false;

    const newHomeScore = homeScore !== undefined
      ? Number(homeScore)
      : score?.homeScore !== undefined
        ? Number(score.homeScore)
        : undefined;

    const newAwayScore = awayScore !== undefined
      ? Number(awayScore)
      : score?.awayScore !== undefined
        ? Number(score.awayScore)
        : undefined;

    if (newHomeScore !== undefined && !isNaN(newHomeScore)) {
      if (match.score.homeScore !== newHomeScore) scoreChanged = true;
      match.score.homeScore = newHomeScore;
    }

    if (newAwayScore !== undefined && !isNaN(newAwayScore)) {
      if (match.score.awayScore !== newAwayScore) scoreChanged = true;
      match.score.awayScore = newAwayScore;
    }

    if (status && ["SCHEDULED", "LIVE", "COMPLETED", "POSTPONED"].includes(status.toUpperCase())) {
      const parsedStatus = status.toUpperCase();
      if (match.status !== parsedStatus) statusChanged = true;
      match.status = parsedStatus;
    } else if (scoreChanged && match.status === "SCHEDULED") {
      match.status = "COMPLETED";
      statusChanged = true;
    }

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

    if (homeTeam && mongoose.Types.ObjectId.isValid(homeTeam)) {
      match.homeTeam = homeTeam;
      isScheduleModified = true;
    }
    if (awayTeam && mongoose.Types.ObjectId.isValid(awayTeam)) {
      match.awayTeam = awayTeam;
      isScheduleModified = true;
    }

    if (req.body.sessionDate) {
      match.sessionDate = parseDateToMidnight(req.body.sessionDate);
      isScheduleModified = true;
    }

    if (isScheduleModified) {
      match.fixtureSource = "MANUAL";
      match.isManuallyModified = true;
    }

    if (matchStatistics && typeof matchStatistics === "object") {
      const existing = match.matchStatistics?.toObject?.() || {};
      match.matchStatistics = {
        ...existing,
        ...matchStatistics,
      };
    }

    await match.save();

    if (scoreChanged || statusChanged || match.status === "COMPLETED") {
      await recalculateLeagueStandings(match.league);
    }

    const updatedMatch = await Fixture.findById(match._id)
      .populate("league", "name season")
      .populate("homeTeam", "teamName logo")
      .populate("awayTeam", "teamName logo");

    return res.status(200).json({
      success: true,
      message: "Fixture updated successfully",
      data: updatedMatch,
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


