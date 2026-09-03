const mongoose = require("mongoose");

const attendanceHistorySchema = new mongoose.Schema(
  {
    attendanceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Attendance",
      required: true,
    },
    classId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Class",
    },
    teamId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Team",
    },
    sessionDate: {
      type: Date,
      required: true,
    },
    playerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    previousStatus: {
      type: String,
      enum: ["PRESENT", "ABSENT", "LATE", "TRIAL", "NONE"],
      default: "NONE",
    },
    newStatus: {
      type: String,
      enum: ["PRESENT", "ABSENT", "LATE", "TRIAL"],
      required: true,
    },
    previousComment: {
      type: String,
      default: "",
    },
    newComment: {
      type: String,
      default: "",
    },
    modifiedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Admin",
      required: true,
    },
    modificationReason: {
      type: String,
      default: "",
    },
  },
  { timestamps: true }
);

// Index for efficient querying
attendanceHistorySchema.index({ attendanceId: 1, playerId: 1 });
attendanceHistorySchema.index({ classId: 1, sessionDate: 1 });
attendanceHistorySchema.index({ teamId: 1, sessionDate: 1 });
attendanceHistorySchema.index({ modifiedBy: 1 });

module.exports = mongoose.model("AttendanceHistory", attendanceHistorySchema);
