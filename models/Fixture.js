const mongoose = require("mongoose");

const fixtureSchema = new mongoose.Schema(
  {
    league: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "League",
      required: true,
    },
    round: {
      type: Number,
      default: 1,
    },
    kickoffTime: {
      type: Date,
      required: true,
    },
    venue: {
      type: String,
      required: true,
    },
    referee: {
      type: String,
      default: "",
    },
    homeTeam: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Team",
      required: true,
    },
    awayTeam: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Team",
      required: true,
    },
    score: {
      homeScore: {
        type: Number,
        default: 0,
      },
      awayScore: {
        type: Number,
        default: 0,
      },
    },
    events: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "MatchEvent",
      },
    ],
    substitutions: [
      {
        playerOut: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
        playerIn: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
        minute: Number,
      },
    ],
    playerRatings: [
      {
        player: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
        rating: { type: Number, min: 1, max: 10 },
      },
    ],
    status: {
      type: String,
      enum: ["SCHEDULED", "LIVE", "COMPLETED", "POSTPONED"],
      default: "SCHEDULED",
    },
    matchStatistics: {
      homePossession: { type: Number, default: 50 },
      awayPossession: { type: Number, default: 50 },
      homeShots: { type: Number, default: 0 },
      awayShots: { type: Number, default: 0 },
      homeShotsOnTarget: { type: Number, default: 0 },
      awayShotsOnTarget: { type: Number, default: 0 },
      homeCorners: { type: Number, default: 0 },
      awayCorners: { type: Number, default: 0 },
      homeFouls: { type: Number, default: 0 },
      awayFouls: { type: Number, default: 0 },
      homeYellowCards: { type: Number, default: 0 },
      awayYellowCards: { type: Number, default: 0 },
      homeRedCards: { type: Number, default: 0 },
      awayRedCards: { type: Number, default: 0 },
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Fixture", fixtureSchema);
