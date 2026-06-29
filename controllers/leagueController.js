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
    const { name, season, logo, description, startDate, endDate } = req.body;
    if (!name || !season || !startDate || !endDate) {
      return res.status(400).json({ success: false, message: "Required fields missing" });
    }

    const league = await League.create({ name, season, logo, description, startDate, endDate });
    res.status(201).json({ success: true, message: "League created successfully", data: league });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ✅ Create Team (Admin only)
exports.createTeam = async (req, res) => {
  try {
    const { teamName, logo, coach, assistantCoach, ageGroup } = req.body;
    if (!teamName) {
      return res.status(400).json({ success: false, message: "teamName is required" });
    }

    const team = await Team.create({ teamName, logo, coach, assistantCoach, ageGroup });
    res.status(201).json({ success: true, message: "Team created successfully", data: team });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
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
    const { league, kickoffTime, venue, referee, homeTeam, awayTeam } = req.body;
    if (!league || !kickoffTime || !venue || !homeTeam || !awayTeam) {
      return res.status(400).json({ success: false, message: "Required fields missing" });
    }

    const fixture = await Fixture.create({
      league,
      kickoffTime,
      venue,
      referee,
      homeTeam,
      awayTeam,
      status: "SCHEDULED",
    });

    res.status(201).json({ success: true, message: "Fixture created successfully", data: fixture });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
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
    const { homeScore, awayScore, playerRatings, minutesPlayedMap, cleanSheetPlayers } = req.body;

    const match = await Fixture.findById(matchId);
    if (!match || match.status === "COMPLETED") {
      return res.status(400).json({ success: false, message: "Match not found or already completed" });
    }

    if (homeScore !== undefined) match.score.homeScore = homeScore;
    if (awayScore !== undefined) match.score.awayScore = awayScore;
    if (playerRatings) match.playerRatings = playerRatings;
    match.status = "COMPLETED";

    await match.save();

    const homeId = match.homeTeam.toString();
    const awayId = match.awayTeam.toString();
    const finalHomeScore = match.score.homeScore;
    const finalAwayScore = match.score.awayScore;

    // Determine results
    let homeWon = 0, homeDrawn = 0, homeLost = 0, homePoints = 0;
    let awayWon = 0, awayDrawn = 0, awayLost = 0, awayPoints = 0;

    if (finalHomeScore > finalAwayScore) {
      homeWon = 1; homePoints = 3;
      awayLost = 1;
    } else if (finalHomeScore < finalAwayScore) {
      awayWon = 1; awayPoints = 3;
      homeLost = 1;
    } else {
      homeDrawn = 1; homePoints = 1;
      awayDrawn = 1; awayPoints = 1;
    }

    // Upsert Standings home team
    await Standing.findOneAndUpdate(
      { league: match.league, team: homeId },
      {
        $inc: {
          played: 1,
          won: homeWon,
          drawn: homeDrawn,
          lost: homeLost,
          goalsFor: finalHomeScore,
          goalsAgainst: finalAwayScore,
          goalDifference: finalHomeScore - finalAwayScore,
          points: homePoints,
        },
      },
      { upsert: true }
    );

    // Upsert Standings away team
    await Standing.findOneAndUpdate(
      { league: match.league, team: awayId },
      {
        $inc: {
          played: 1,
          won: awayWon,
          drawn: awayDrawn,
          lost: awayLost,
          goalsFor: finalAwayScore,
          goalsAgainst: finalHomeScore,
          goalDifference: finalAwayScore - finalHomeScore,
          points: awayPoints,
        },
      },
      { upsert: true }
    );

    // Increment player appearances, ratings and minutes played
    if (minutesPlayedMap) {
      for (const [playerId, mins] of Object.entries(minutesPlayedMap)) {
        await User.findByIdAndUpdate(playerId, { $inc: { appearances: 1, minutesPlayed: mins } });

        const teamId = (await Team.findOne({ players: playerId }))?._id;
        if (teamId) {
          await PlayerStatistics.findOneAndUpdate(
            { player: playerId, league: match.league, team: teamId },
            { $inc: { appearances: 1, minutesPlayed: mins } },
            { upsert: true }
          );
        }
      }
    }

    // Update Clean Sheets
    if (cleanSheetPlayers) {
      for (const playerId of cleanSheetPlayers) {
        await User.findByIdAndUpdate(playerId, { $inc: { cleanSheets: 1 } });
        const teamId = (await Team.findOne({ players: playerId }))?._id;
        if (teamId) {
          await PlayerStatistics.findOneAndUpdate(
            { player: playerId, league: match.league, team: teamId },
            { $inc: { cleanSheets: 1 } },
            { upsert: true }
          );
        }
      }
    }

    res.json({ success: true, message: "Match completed. League tables updated.", data: match });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
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
