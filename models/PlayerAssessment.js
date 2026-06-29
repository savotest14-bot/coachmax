const mongoose = require("mongoose");

const playerAssessmentSchema = new mongoose.Schema(
  {
    player: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    coach: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Admin",
      required: true,
    },
    technicalSkills: { type: Number, min: 1, max: 5 },
    tacticalSkills: { type: Number, min: 1, max: 5 },
    physicalSkills: { type: Number, min: 1, max: 5 },
    mentalSkills: { type: Number, min: 1, max: 5 },

    weakFoot: { type: Number, min: 1, max: 5 },
    passing: { type: Number, min: 1, max: 5 },
    shooting: { type: Number, min: 1, max: 5 },
    dribbling: { type: Number, min: 1, max: 5 },
    ballControl: { type: Number, min: 1, max: 5 },
    defending: { type: Number, min: 1, max: 5 },
    pace: { type: Number, min: 1, max: 5 },
    stamina: { type: Number, min: 1, max: 5 },
    confidence: { type: Number, min: 1, max: 5 },
    discipline: { type: Number, min: 1, max: 5 },
    communication: { type: Number, min: 1, max: 5 },

    coachComments: {
      type: String,
      default: "",
    },
    improvementAreas: {
      type: String,
      default: "",
    },
    overallRating: {
      type: Number,
      required: true,
      min: 1,
      max: 5,
    },
    assessmentDate: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("PlayerAssessment", playerAssessmentSchema);
