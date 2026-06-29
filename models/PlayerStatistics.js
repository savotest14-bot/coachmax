const mongoose = require("mongoose");

const playerStatisticsSchema = new mongoose.Schema(
  {
    player: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    league: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "League",
      required: true,
    },
    team: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Team",
      required: true,
    },
    goals: { type: Number, default: 0 },
    assists: { type: Number, default: 0 },
    appearances: { type: Number, default: 0 },
    cleanSheets: { type: Number, default: 0 },
    yellowCards: { type: Number, default: 0 },
    redCards: { type: Number, default: 0 },
    minutesPlayed: { type: Number, default: 0 },
  },
  { timestamps: true }
);

playerStatisticsSchema.index({ player: 1, league: 1 }, { unique: true });

module.exports = mongoose.model("PlayerStatistics", playerStatisticsSchema);
