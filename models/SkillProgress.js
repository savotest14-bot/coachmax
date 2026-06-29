const mongoose = require("mongoose");

const skillProgressSchema = new mongoose.Schema(
  {
    player: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    skillName: {
      type: String,
      required: true,
    },
    previousScore: {
      type: Number,
      required: true,
    },
    currentScore: {
      type: Number,
      required: true,
    },
    improvement: {
      type: Number,
      required: true,
    },
    coach: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Admin",
      required: true,
    },
    assessmentDate: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("SkillProgress", skillProgressSchema);
