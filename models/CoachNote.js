const mongoose = require("mongoose");

const coachNoteSchema = new mongoose.Schema(
  {
    coach: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Admin",
      required: true,
    },
    player: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    classId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Class",
      default: null,
    },
    noteType: {
      type: String,
      enum: [
        "ARRIVED_LATE",
        "BEHAVIOUR_CONCERN",
        "INJURY",
        "MEDICAL_INCIDENT",
        "POSITIVE_PERFORMANCE",
        "DEVELOPMENT_AREA",
        "PARENT_DISCUSSION",
      ],
      required: true,
    },
    description: {
      type: String,
      required: true,
    },
    isEdited: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true }
);

// Index for efficient querying
coachNoteSchema.index({ player: 1, createdAt: -1 });
coachNoteSchema.index({ coach: 1, createdAt: -1 });
coachNoteSchema.index({ classId: 1 });

module.exports = mongoose.model("CoachNote", coachNoteSchema);
