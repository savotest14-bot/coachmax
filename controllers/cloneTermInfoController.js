const mongoose = require("mongoose");
const Term = require("../models/Term");
const Class = require("../models/Class");
const League = require("../models/League");
const Team = require("../models/Team");

// Small, read-only term inventory for the first step of Clone Term.
// The full roster and duplicate checks remain in the clone preview endpoint.
exports.getCloneTermInfo = async (req, res) => {
  try {
    const { termId } = req.params;
    if (!mongoose.isValidObjectId(termId)) {
      return res.status(400).json({ success: false, message: "Invalid term ID." });
    }

    const term = await Term.findById(termId)
      .select("name year startDate endDate status isEvent")
      .lean();
    if (!term) {
      return res.status(404).json({ success: false, message: "Term not found." });
    }

    const [classes, leagues, teams] = await Promise.all([
      Class.find({ term: termId })
        .select("name dayOfWeek startTime endTime players")
        .sort({ name: 1, _id: 1 })
        .lean(),
      League.find({ term: termId })
        .select("name season teams")
        .sort({ name: 1, _id: 1 })
        .lean(),
      Team.find({ term: termId })
        .select("teamName players.player leagues.league")
        .sort({ teamName: 1, _id: 1 })
        .lean(),
    ]);

    const playerIds = new Set();
    classes.forEach((item) => (item.players || []).forEach((id) => {
      if (id) playerIds.add(String(id));
    }));
    teams.forEach((item) => (item.players || []).forEach((entry) => {
      if (entry.player) playerIds.add(String(entry.player));
    }));

    const leagueNamesByTeamId = new Map();
    const leagueNameById = new Map(leagues.map((league) => [String(league._id), league.name]));
    leagues.forEach((league) => (league.teams || []).forEach((teamId) => {
      const key = String(teamId);
      const names = leagueNamesByTeamId.get(key) || [];
      names.push(league.name);
      leagueNamesByTeamId.set(key, names);
    }));
    teams.forEach((team) => (team.leagues || []).forEach((entry) => {
      const name = leagueNameById.get(String(entry.league));
      if (!name) return;
      const key = String(team._id);
      const names = leagueNamesByTeamId.get(key) || [];
      if (!names.includes(name)) names.push(name);
      leagueNamesByTeamId.set(key, names);
    }));

    return res.status(200).json({
      success: true,
      data: {
        term,
        counts: {
          classes: classes.length,
          leagues: leagues.length,
          teams: teams.length,
          players: playerIds.size,
        },
        classes: classes.map((item) => ({
          _id: item._id,
          name: item.name,
          dayOfWeek: item.dayOfWeek,
          startTime: item.startTime,
          endTime: item.endTime,
          playerCount: (item.players || []).length,
        })),
        leagues: leagues.map((item) => ({
          _id: item._id,
          name: item.name,
          season: item.season,
          teamCount: (item.teams || []).length,
        })),
        teams: teams.map((item) => ({
          _id: item._id,
          name: item.teamName,
          playerCount: (item.players || []).length,
          leagueNames: leagueNamesByTeamId.get(String(item._id)) || [],
        })),
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};
