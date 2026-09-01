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
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
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
    temporaryPlayers: [teamTemporaryPlayerSchema],
  },
  { timestamps: true }
);

module.exports = mongoose.model("Team", teamSchema);
