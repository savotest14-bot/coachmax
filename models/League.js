const mongoose = require("mongoose");

const leagueSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
    },
    season: {
      type: String,
      required: true,
    },
    logo: {
      type: String,
      default: "",
    },
    description: {
      type: String,
      default: "",
    },
    startDate: {
      type: Date,
      required: true,
    },
    endDate: {
      type: Date,
      required: true,
    },
    status: {
      type: String,
      enum: ["UPCOMING", "ACTIVE", "COMPLETED"],
      default: "ACTIVE",
    },
    type: {
      type: String,
      enum: ["INTERNATIONAL", "NATIONAL", "STATE", "LOCAL", "OTHERS"],
      default: "LOCAL",
    },
    registrationStartDate: {
      type: Date,
      default: null,
    },
    registrationEndDate: {
      type: Date,
      default: null,
    },
    visibility: {
      type: String,
      enum: ["PUBLIC", "PRIVATE"],
      default: "PUBLIC",
    },
    pointsForWin: {
      type: Number,
      default: 3,
    },
    pointsForDraw: {
      type: Number,
      default: 1,
    },
    allowDraws: {
      type: Boolean,
      default: true,
    },
    automaticLadderRecalculation: {
      type: Boolean,
      default: true,
    },
    teams: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Team",
      },
    ],
  },
  { timestamps: true }
);

module.exports = mongoose.model("League", leagueSchema);
