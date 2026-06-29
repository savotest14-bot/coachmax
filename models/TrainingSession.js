const mongoose = require("mongoose");

const trainingSessionSchema = new mongoose.Schema(
  {
    class: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Class",
      required: true,
    },
    coach: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Admin",
      required: true,
    },
    date: {
      type: Date,
      required: true,
    },
    title: {
      type: String,
      required: true,
    },
    objectives: {
      type: String,
      default: "",
    },
    notes: {
      type: String,
      default: "",
    },
    attachments: [
      {
        type: String,
      },
    ],
    completionStatus: {
      type: String,
      enum: ["PLANNED", "COMPLETED", "CANCELLED"],
      default: "PLANNED",
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("TrainingSession", trainingSessionSchema);
