const mongoose = require("mongoose");

const campSessionSchema = new mongoose.Schema(
  {
    event: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Event",
      required: true,
      index: true,
    },
    // The specific date of the camp session
    sessionDate: {
      type: Date,
      required: true,
    },
    // e.g. "FULL_DAY" or "HALF_DAY" (extensible)
    sessionType: {
      type: String,
      required: true,
      enum: ["FULL_DAY", "HALF_DAY", "CUSTOM"],
      default: "FULL_DAY",
    },
    sessionLabel: {
      type: String,
      default: "Full Day",
    },
    startTime: {
      type: String,
      required: true,
      default: "08:00 AM",
    },
    endTime: {
      type: String,
      required: true,
      default: "04:00 PM",
    },
    fee: {
      type: Number,
      required: true,
      default: 90,
      min: [0, "Fee cannot be negative"],
    },
    capacity: {
      type: Number,
      default: null, // null means inherits event maxParticipants or unlimited
    },
    registeredCount: {
      type: Number,
      default: 0,
      min: [0, "Registered count cannot be negative"],
    },
    isAvailable: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

// Unique session type per date within an event (e.g. at most 1 FULL_DAY and 1 HALF_DAY for Monday 14 Dec)
campSessionSchema.index({ event: 1, sessionDate: 1, sessionType: 1 }, { unique: true });

module.exports = mongoose.model("CampSession", campSessionSchema);
