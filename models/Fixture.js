const { dateOnly } = require("../utils/dateTime");
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
    sessionDate: {
      type: Date,
    },
    endTime: {
      type: Date,
    },
    venue: {
      type: String,
      required: true,
    },
    field: {
      type: String,
      default: "",
    },
    group: {
      type: String,
      default: "",
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
    participants: [{ type: mongoose.Schema.Types.ObjectId, ref: "Team" }],
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
    goals: [
      {
        team: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Team",
          required: true,
        },
        scorer: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "User",
          required: true,
        },
        assist: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "User",
          default: null,
        },
        minute: {
          type: Number,
          required: true,
          min: 0,
        },
      },
    ],
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
    resultPlayers: [{
      player: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
      team: { type: mongoose.Schema.Types.ObjectId, ref: "Team", required: true },
      goals: { type: Number, min: 0, default: 0 },
      assists: { type: Number, min: 0, default: 0 },
      appearances: { type: Number, min: 0, max: 1, default: 1 },
      minutesPlayed: { type: Number, min: 0, default: 0 },
      cleanSheets: { type: Number, min: 0, max: 1, default: 0 },
      yellowCards: { type: Number, min: 0, default: 0 },
      redCards: { type: Number, min: 0, default: 0 },
    }],
    status: {
      type: String,
      enum: ["SCHEDULED", "LIVE", "COMPLETED", "POSTPONED"],
      default: "SCHEDULED",
    },
    fixtureSource: {
      type: String,
      enum: ["GENERATED", "MANUAL"],
      default: "GENERATED",
    },
    isManuallyModified: {
      type: Boolean,
      default: false,
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
  { timestamps: true, optimisticConcurrency: true }
);

fixtureSchema.pre("validate", function () {
  this.participants = [this.homeTeam, this.awayTeam];
  if (String(this.homeTeam) === String(this.awayTeam)) this.invalidate("awayTeam", "Home and away teams must differ.");
});
// One array entry per participant makes home/away share the same unique namespace.
// Partial coverage supports a reviewed backfill before this index is enabled on legacy data.
fixtureSchema.index({ league: 1, round: 1, participants: 1 }, { unique: true, name: "fixture_team_once_per_round", partialFilterExpression: { "participants.0": { $exists: true } } });
fixtureSchema.index({ league: 1, field: 1, kickoffTime: 1 });
fixtureSchema.set("toJSON", { transform: (_doc, result) => {
  if (result.sessionDate) result.sessionDate = dateOnly(result.sessionDate);
  return result;
} });
module.exports = mongoose.model("Fixture", fixtureSchema);
