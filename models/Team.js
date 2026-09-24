const mongoose = require("mongoose");
const teamTemporaryPlayerSchema = require("./TeamTemporaryPlayer");

const teamSchema = new mongoose.Schema(
  {
    teamName: {
      type: String,
      required: true,
    },
    logo: {
      type: String,
      default: "",
    },
    coach: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Admin",
    },
    assistantCoach: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Admin",
    },
    ageGroup: {
      type: String,
      default: "",
    },
    captain: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    viceCaptain: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    players: [
      {
        player: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "User",
        },
        paymentStatus: {
          type: String,
          enum: ["TRIAL", "UNPAID", "PAID", "OVER_DUE", "EXTRA", "SUBSTITUTE", "TBC", "HANDSHAKE"],
          default: "UNPAID",
        },
        statistics: {
          appearances: { type: Number, default: 0 },
          goals: { type: Number, default: 0 },
          assists: { type: Number, default: 0 },
          cleanSheets: { type: Number, default: 0 },
          yellowCards: { type: Number, default: 0 },
          redCards: { type: Number, default: 0 },
          minutesPlayed: { type: Number, default: 0 },
        },
      },
    ],
    teamType: {
      type: String,
      enum: ["INTERNAL", "EXTERNAL"],
      default: "INTERNAL",
    },
    teamFee: {
      type: Number,
      default: 0,
      min: 0,
    },
    term: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Term",
    },
    dayOfWeek: {
      type: String,
    },
    startTime: String,
    endTime: String,
    venue: String,
    location: String,
    scheduleType: {
      type: String,
      enum: ["SINGLE_DAY", "WEEKDAYS", "CUSTOM"],
      default: "SINGLE_DAY",
    },
    schedule: [
      {
        dayOfWeek: { type: String },
        startTime: { type: String },
        endTime: { type: String },
      },
    ],
    round: {
      type: Number,
      default: null,
    },
    sessionDates: [
      {
        type: Date,
      },
    ],
    temporaryPlayers: [teamTemporaryPlayerSchema],
    statistics: {
      played: { type: Number, default: 0 },
      won: { type: Number, default: 0 },
      drawn: { type: Number, default: 0 },
      lost: { type: Number, default: 0 },
      goalsFor: { type: Number, default: 0 },
      goalsAgainst: { type: Number, default: 0 },
      goalDifference: { type: Number, default: 0 },
      points: { type: Number, default: 0 },
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Team", teamSchema);
