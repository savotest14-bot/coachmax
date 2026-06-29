const mongoose = require("mongoose");

const matchEventSchema = new mongoose.Schema(
  {
    match: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Fixture",
      required: true,
    },
    player: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    team: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Team",
      required: true,
    },
    eventType: {
      type: String,
      enum: ["GOAL", "ASSIST", "YELLOW_CARD", "RED_CARD", "SUBSTITUTION"],
      required: true,
    },
    minute: {
      type: Number,
      required: true,
    },
    details: {
      type: String,
      default: "",
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("MatchEvent", matchEventSchema);
