const mongoose = require("mongoose");

const teamTemporaryPlayerSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    jerseyNumber: {
      type: Number,
      default: null,
    },
    profileImage: {
      type: String,
      default: "",
    },
    position: {
      type: String,
      default: "",
    },
    statistics: {
      appearances: {
        type: Number,
        default: 0,
      },
      goals: {
        type: Number,
        default: 0,
      },
      assists: {
        type: Number,
        default: 0,
      },
      cleanSheets: {
        type: Number,
        default: 0,
      },
      yellowCards: {
        type: Number,
        default: 0,
      },
      redCards: {
        type: Number,
        default: 0,
      },
      minutesPlayed: {
        type: Number,
        default: 0,
      },
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Admin",
      default: null,
    },
  },
  { timestamps: true }
);

module.exports = teamTemporaryPlayerSchema;
