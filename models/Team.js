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
    temporaryPlayers: [teamTemporaryPlayerSchema],
  },
  { timestamps: true }
);

module.exports = mongoose.model("Team", teamSchema);
