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
      },
    ],
    teamType: {
      type: String,
      enum: ["INTERNAL", "EXTERNAL"],
      default: "INTERNAL",
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
    // Multiple leagues & per-league attendance sessions
    leagues: [
      {
        league: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "League",
          required: true,
        },
        teamFee: {
          type: Number,
          default: 0,
          min: 0,
        },
        round: {
          type: Number,
          default: null,
        },
        sessionDates: [
          {
            type: Date,
          },
        ],
        group: {
          type: String,
          default: "",
        },
        status: {
          type: String,
          enum: ["ACTIVE", "COMPLETED", "WITHDRAWN"],
          default: "ACTIVE",
        },
        enrolledAt: {
          type: Date,
          default: Date.now,
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
            status: {
              type: String,
              enum: ["ACTIVE", "INACTIVE", "SUSPENDED"],
              default: "ACTIVE",
            },
          },
        ],
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

teamSchema.index({ "leagues.league": 1 });

module.exports = mongoose.model("Team", teamSchema);

