const League = require("../models/League");
const Team = require("../models/Team");
const Fixture = require("../models/Fixture");
const MatchEvent = require("../models/MatchEvent");
const Standing = require("../models/Standing");
const PlayerStatistics = require("../models/PlayerStatistics");
const User = require("../models/User");

// ✅ Create League (Admin only)
exports.createLeague = async (req, res) => {
  try {
    const {
      name,
      season,
      description,
      startDate,
      endDate,
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
    const { teamName, coach, assistantCoach, ageGroup } = req.body;

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

    const logo = req.file ? `uploads/teamlogos/${req.file.filename}` : "";

    const team = await Team.create({
      teamName: teamName.trim(),
      logo,
      coach: coach || null,
      assistantCoach: assistantCoach || null,
      ageGroup: ageGroup || "",
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

    const [teams, total] = await Promise.all([
      Team.find(filter)
        .populate("coach", "name email profileImage")
        .populate("assistantCoach", "name email profileImage")
        .populate("captain", "name email profileImage")
        .populate("viceCaptain", "name email profileImage")
        .populate("players", "name email profileImage")
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
    const { playerId } = req.body;

    const team = await Team.findById(teamId);
    if (!team) {
      return res.status(404).json({ success: false, message: "Team not found" });
    }

    const player = await User.findById(playerId);
    if (!player) {
      return res.status(404).json({ success: false, message: "Player not found" });
    }

    if (!team.players.includes(playerId)) {
      team.players.push(playerId);
      await team.save();
    }

    res.json({ success: true, message: "Player assigned to team successfully", data: team });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
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
