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
  },
  { timestamps: true }
);

module.exports = mongoose.model("League", leagueSchema);
