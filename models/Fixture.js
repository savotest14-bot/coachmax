const mongoose = require("mongoose");

const fixtureSchema = new mongoose.Schema(
  {
    league: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "League",
      required: true,
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
  },
  { timestamps: true }
);

module.exports = mongoose.model("Fixture", fixtureSchema);
