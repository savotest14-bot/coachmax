const mongoose = require("mongoose");

const auditLogSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Admin",
      required: true,
    },
    userRole: {
      type: String,
      required: true,
    },
    action: {
      type: String,
      required: true,
      // e.g., ATTENDANCE_UPDATED, NOTE_CREATED, NOTE_UPDATED,
      // TEMP_PLAYER_CREATED, TEMP_PLAYER_APPROVED, TEMP_PLAYER_REJECTED,
      // CHAT_MESSAGE_SENT, COACH_ASSIGNMENT_CHANGED
    },
    entityType: {
      type: String,
      required: true,
      // e.g., Attendance, CoachNote, TemporaryPlayer, Message
    },
    entityId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
    },
    ipAddress: {
      type: String,
      default: "",
    },
    deviceInfo: {
      type: String,
      default: "",
    },
    oldValue: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    newValue: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    description: {
      type: String,
      default: "",
    },
  },
  { timestamps: true }
);

// Index for efficient querying
auditLogSchema.index({ user: 1, createdAt: -1 });
auditLogSchema.index({ entityType: 1, entityId: 1 });
auditLogSchema.index({ action: 1 });

module.exports = mongoose.model("AuditLog", auditLogSchema);
