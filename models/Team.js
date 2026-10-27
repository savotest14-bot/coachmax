const { dateOnly } = require("../utils/dateTime");
const mongoose = require("mongoose");
const teamTemporaryPlayerSchema = require("./TeamTemporaryPlayer");
const { normalizeTeamName } = require("../utils/leagueIntegrity");

const teamSchema = new mongoose.Schema(
  {
    teamName: {
      type: String,
      required: true,
    },
    normalizedName: { type: String, required: true },
    archivedAt: { type: Date, default: null },
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
          appearances: { type: Number, min: 0, default: 0 },
          goals: { type: Number, min: 0, default: 0 },
          assists: { type: Number, min: 0, default: 0 },
          cleanSheets: { type: Number, min: 0, default: 0 },
          yellowCards: { type: Number, min: 0, default: 0 },
          redCards: { type: Number, min: 0, default: 0 },
          minutesPlayed: { type: Number, min: 0, default: 0 },
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
      required: true,
    },
    dayOfWeek: {
      type: String,
    },
    round: { type: Number, min: 1 },
    sessionDates: [{ type: Date }],
    teamFee: { type: Number, min: 0, default: 0 },
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

teamSchema.pre("validate", function () { this.normalizedName = normalizeTeamName(this.teamName); });
teamSchema.index({ term: 1, normalizedName: 1 }, { unique: true, name: "team_term_normalized_name", partialFilterExpression: { normalizedName: { $type: "string" }, term: { $type: "objectId" } } });
teamSchema.index({ "leagues.league": 1 });

teamSchema.set("toJSON", { transform: (_doc, result) => {
  if (result.sessionDates) result.sessionDates = result.sessionDates.map((date) => dateOnly(date));
  return result;
} });
module.exports = mongoose.model("Team", teamSchema);

