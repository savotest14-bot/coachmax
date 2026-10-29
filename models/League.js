const { dateOnly } = require("../utils/dateTime");
const mongoose = require("mongoose");

const leagueSchema = new mongoose.Schema(
  {
    schedulingRevision: { type: Number, default: 0 },
    archivedAt: { type: Date, default: null },
    venue: { type: String, default: "" },
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
    term: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Term",
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
    fixtureFormat: {
      type: String,
      enum: ["ROUND_ROBIN", "GROUP", "KNOCKOUT"],
      default: "ROUND_ROBIN",
    },
    groupCount: {
      type: Number,
      default: 1,
      min: 1,
    },
    numberOfRounds: {
      type: Number,
      default: 1,
      min: 1,
    },
    fee: {
      type: Number,
      default: 0,
      min: 0,
    },
    sessionDates: [
      {
        type: Date,
      },
    ],
    matchDuration: {
      type: Number,
      default: 90,
      min: 1,
    },
    breakBetweenMatches: {
      type: Number,
      default: 15,
      min: 0,
    },
    numberOfFields: {
      type: Number,
      default: 1,
      min: 1,
    },
    startTime: {
      type: String,
      default: "10:00",
    },
    fixtureGenerated: {
      type: Boolean,
      default: false,
    },
    generationType: {
      type: String,
      enum: ["AUTOMATIC", "MANUAL"],
      default: "MANUAL",
    },
    groups: [
      {
        name: {
          type: String,
          required: true,
        },
        teams: [
          {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Team",
          },
        ],
      },
    ],
  },
  { timestamps: true }
);

leagueSchema.set("toJSON", { transform: (_doc, result) => {
  if (result.startDate) result.startDate = dateOnly(result.startDate);
  if (result.endDate) result.endDate = dateOnly(result.endDate);
  if (result.registrationStartDate) result.registrationStartDate = dateOnly(result.registrationStartDate);
  if (result.registrationEndDate) result.registrationEndDate = dateOnly(result.registrationEndDate);
  if (result.sessionDates) result.sessionDates = result.sessionDates.map((date) => dateOnly(date));
  return result;
} });
leagueSchema.index({ term: 1, name: 1 });
module.exports = mongoose.model("League", leagueSchema);
