const League = require("../models/League");
const Team = require("../models/Team");
const Fixture = require("../models/Fixture");
const MatchEvent = require("../models/MatchEvent");
const Standing = require("../models/Standing");
const PlayerStatistics = require("../models/PlayerStatistics");
const User = require("../models/User");
const Admin = require("../models/Admin");
const { generateTeamInvoice } = require("../services/invoiceService");
const mongoose = require("mongoose");
const fs = require("fs");
const path = require("path");

// ✅ Create League (Admin only)
exports.createLeague = async (req, res) => {
  try {
    const {
      name,
      season,
      description,
      startDate,
      endDate,
      type,
      leagueType,
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

    const rawType = (type || leagueType || "").toUpperCase();
    const VALID_TYPES = ["INTERNATIONAL", "NATIONAL", "STATE", "LOCAL", "OTHERS"];
    const parsedType = VALID_TYPES.includes(rawType) ? rawType : "LOCAL";

    const logo = req.file
      ? `/uploads/leaguelogos/${req.file.filename}`
      : "";

    const league = await League.create({
      name: name.trim(),
      season: season.trim(),
      logo,
      description: description || "",
      startDate,
      endDate,
      type: parsedType,
    });

    return res.status(201).json({
      success: true,
      message: "League created successfully",
      data: league,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message,
    });
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

// ✅ Create Team (Admin only)
exports.createTeam = async (req, res) => {
  try {
    const {
      teamName,
      coach,
      assistantCoach,
      ageGroup,
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

    const parsedType = teamType && ["INTERNAL", "EXTERNAL"].includes(teamType.toUpperCase())
      ? teamType.toUpperCase()
      : "INTERNAL";

    const parsedFee = fee !== undefined ? Number(fee) : teamFee !== undefined ? Number(teamFee) : 0;
    if (isNaN(parsedFee) || parsedFee < 0) {
      return res.status(400).json({ success: false, message: "Team fee must be a non-negative number" });
    }

    const logo = req.file ? `uploads/teamlogos/${req.file.filename}` : "";

    const team = await Team.create({
      teamName: teamName.trim(),
      logo,
      coach: coach || null,
      assistantCoach: assistantCoach || null,
      ageGroup: ageGroup || "",
      teamType: parsedType,
      teamFee: parsedFee,
      term: term || null,
      dayOfWeek: dayOfWeek || "",
      startTime: startTime || "",
      endTime: endTime || "",
      venue: venue || "",
      location: location || venue || "",
      scheduleType: scheduleType || "SINGLE_DAY",
      schedule: schedule || [],
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

// ✅ Assign player to Team (Admin only)
exports.assignPlayerToTeam = async (req, res) => {
  try {
    const { teamId } = req.params;
    const { playerId, playerIds } = req.body;

    // Support both playerId (string or array) and playerIds (string or array)
    const rawIds = playerId || playerIds;
    if (!rawIds) {
      return res.status(400).json({ success: false, message: "Player ID(s) required" });
    }

    const normalizedIds = Array.isArray(rawIds) ? rawIds : [rawIds];

    // Validate ObjectIds
    const isValid = normalizedIds.every(id => mongoose.Types.ObjectId.isValid(id));
    if (!isValid) {
      return res.status(400).json({ success: false, message: "Invalid player ID format" });
    }

    const team = await Team.findById(teamId);
    if (!team) {
      return res.status(404).json({ success: false, message: "Team not found" });
    }

    // Verify all players exist
    const uniqueIds = [...new Set(normalizedIds)];
    const existingPlayersCount = await User.countDocuments({ _id: { $in: uniqueIds } });
    if (existingPlayersCount !== uniqueIds.length) {
      return res.status(404).json({ success: false, message: "One or more players not found" });
    }

    const existingPlayerMap = new Map();
    (team.players || []).forEach((p) => {
      const pid = p.player ? p.player.toString() : p.toString();
      existingPlayerMap.set(pid, p.paymentStatus || "TRIAL");
    });

    uniqueIds.forEach((pid) => {
      if (!existingPlayerMap.has(pid)) {
        existingPlayerMap.set(pid, "TRIAL");
      }
    });

    if (existingPlayerMap.size > 20) {
      return res.status(400).json({
        success: false,
        message: `Cannot assign players. A team cannot exceed 20 players. Currently has ${existingPlayerMap.size} players.`,
      });
    }

    team.players = Array.from(existingPlayerMap.entries()).map(([pId, status]) => ({
      player: pId,
      paymentStatus: status,
    }));
    await team.save();

    // Automatically generate team fee invoice for assigned players if team fee > 0
    if (team.teamFee > 0) {
      for (const pId of uniqueIds) {
        try {
          await generateTeamInvoice({ userId: pId, teamId });
        } catch (invErr) {
          console.error(`[Team] Failed to generate team invoice for player ${pId}:`, invErr.message);
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
    // Get all assigned player IDs and their associated team details
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

    // Get all unblocked players
    const allPlayers = await User.find({
      isBlocked: false,
    })
      .populate("category", "name")
      .populate("programs", "name")
      .populate("term", "name")
      .select(
        "firstName lastName fullName profileImage category programs term phone email"
      );

    // Add isAssigned flag and assignedTeam details
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

// ✅ Create Fixture (Admin only)
exports.createFixture = async (req, res) => {
  try {
    const {
      league,
      kickoffTime,
      venue,
      referee,
      homeTeam,
      awayTeam,
    } = req.body;

    if (!league || !kickoffTime || !venue || !homeTeam || !awayTeam) {
      return res.status(400).json({
        success: false,
        message:
          "League, kickoff time, venue, home team and away team are required.",
      });
    }

    if (
      !mongoose.Types.ObjectId.isValid(league) ||
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
      League.findById(league),
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
      league,
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

    const fixture = await Fixture.create({
      league,
      kickoffTime: new Date(kickoffTime),
      venue: venue.trim(),
      referee: referee || "",
      homeTeam,
      awayTeam,
      status: "SCHEDULED",
    });

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

// ✅ Record Match Event & Update Stats (Admin/Coach only)
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

    // Link event to match
    match.events.push(event._id);

    // Update match scores if GOAL
    if (eventType === "GOAL") {
      if (match.homeTeam.toString() === team) {
        match.score.homeScore += 1;
      } else if (match.awayTeam.toString() === team) {
        match.score.awayScore += 1;
      }
    }

    await match.save();

    // Increment player level totals and league totals
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

      // Upsert league player statistics
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

// ✅ Complete Match & Update Standings (Admin/Coach only)
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
// ✅ Fetch Standings Table
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

// ✅ Fetch Top Scorers / Leaderboards
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

// ✅ Fetch Fixtures
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

// ✅ Get Team Details By ID
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

// ✅ Unassign player from Team (Admin only)
exports.unassignPlayerFromTeam = async (req, res) => {
  try {
    const { teamId } = req.params;
    const { playerId, playerIds } = req.body;

    const rawIds = playerId || playerIds;
    if (!rawIds) {
      return res.status(400).json({ success: false, message: "Player ID(s) required" });
    }

    const normalizedIds = (Array.isArray(rawIds) ? rawIds : [rawIds]).map(id => id.toString());

    // Validate ObjectIds
    const isValid = normalizedIds.every(id => mongoose.Types.ObjectId.isValid(id));
    if (!isValid) {
      return res.status(400).json({ success: false, message: "Invalid player ID format" });
    }

    const team = await Team.findById(teamId);
    if (!team) {
      return res.status(404).json({ success: false, message: "Team not found" });
    }

    // Clean up captain/viceCaptain if they are being removed
    if (team.captain && normalizedIds.includes(team.captain.toString())) {
      team.captain = null;
    }
    if (team.viceCaptain && normalizedIds.includes(team.viceCaptain.toString())) {
      team.viceCaptain = null;
    }

    // Filter out the players
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

// ✅ Update Team Details (Admin only)
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

    // Update Team Name and check duplicate
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

    // Update Team Type
    if (teamType !== undefined) {
      const upperType = teamType.toUpperCase();
      if (!["INTERNAL", "EXTERNAL"].includes(upperType)) {
        return res.status(400).json({ success: false, message: "Invalid teamType. Must be INTERNAL or EXTERNAL" });
      }
      team.teamType = upperType;
    }

    // Update Team Fee
    const providedFee = fee !== undefined ? fee : teamFee;
    if (providedFee !== undefined) {
      const numFee = Number(providedFee);
      if (isNaN(numFee) || numFee < 0) {
        return res.status(400).json({ success: false, message: "Team fee must be a non-negative number" });
      }
      team.teamFee = numFee;
    }

    // Update Logo if a new file is uploaded
    if (req.file) {
      // Try to delete old logo from disk if it exists
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

    // Validate and update Coach
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

    // Validate and update Assistant Coach
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

    // Update Age Group
    if (ageGroup !== undefined) {
      team.ageGroup = ageGroup || "";
    }

    // Validate and update Captain
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

    // Validate and update Vice Captain
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

    // Validate and update Players array
    if (players !== undefined) {
      const playerIds = Array.isArray(players) ? players : [players];
      if (playerIds.length > 20) {
        return res.status(400).json({ success: false, message: "A team cannot have more than 20 players" });
      }

      // Validate ObjectIds
      const isValid = playerIds.every(id => mongoose.Types.ObjectId.isValid(id));
      if (!isValid) {
        return res.status(400).json({ success: false, message: "Invalid player ID format inside players array" });
      }

      // Verify all players exist
      const existingPlayersCount = await User.countDocuments({ _id: { $in: playerIds } });
      if (existingPlayersCount !== playerIds.length) {
        return res.status(400).json({ success: false, message: "One or more players in the array do not exist" });
      }

      const existingMap = new Map();
      (team.players || []).forEach((p) => {
        const pid = p.player ? p.player.toString() : p.toString();
        existingMap.set(pid, p.paymentStatus || "TRIAL");
      });

      team.players = playerIds.map((id) => ({
        player: id,
        paymentStatus: existingMap.get(id.toString()) || "TRIAL",
      }));
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

// ✅ Delete Team Permanently (Admin only)
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

    // Delete team logo from disk
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

// ✅ Add Team Temporary Player(s) (Single or Bulk)
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

    // Parse req.body or req.body.players if sent as JSON string (common in multipart form-data)
    let parsedBody = req.body;
    if (typeof req.body.players === "string") {
      try {
        parsedBody = JSON.parse(req.body.players);
      } catch (e) {
        // keep as string
      }
    } else if (typeof req.body === "string") {
      try {
        parsedBody = JSON.parse(req.body);
      } catch (e) {
        // keep as string
      }
    }

    // Support single object, array in body, or body.players array
    const rawList = Array.isArray(parsedBody)
      ? parsedBody
      : Array.isArray(parsedBody.players)
        ? parsedBody.players
        : [parsedBody];

    if (!rawList.length || !rawList[0].name) {
      return res.status(400).json({ success: false, message: "At least one temporary player object with a 'name' is required" });
    }

    // Process uploaded files array (req.files) or single file (req.file)
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

// ✅ Get All Temporary Players for a Team
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

// ✅ Update Team Temporary Player
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

// ✅ Delete Team Temporary Player
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

    // Unlink image file if exists
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
