const mongoose = require("mongoose");

const classSchema = new mongoose.Schema(
  {
    name: String,

    term: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Term",
      required: true,
    },
    program: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Program",
      required: true,
    },

    category: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Category",
      required: true,
    },

    dayOfWeek: {
      type: String, // Monday, Tuesday
      required: true,
    },

    startTime: String,
    endTime: String,

    location: String, // Kept for backward compatibility
    venue: String, // Added

    coach: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Admin",
    },
    assistantCoach: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Admin",
    },

    capacity: Number,

    price: {
      type: Number,
      default: 0,
      min: [0, "Price cannot be negative"],
    },

    players: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
      },
    ],

    trainingType: {
      type: String,
      default: "REGULAR",
    },
    sessionDuration: {
      type: Number, // in minutes
      default: 60,
    },
    equipmentRequired: [
      {
        type: String,
      },
    ],
    status: {
      type: String,
      enum: ["ACTIVE", "INACTIVE"],
      default: "ACTIVE",
    },

    // ── Multi-day scheduling (additive, backward-compatible) ──
    scheduleType: {
      type: String,
      enum: ["SINGLE_DAY", "WEEKDAYS", "CUSTOM"],
      default: "SINGLE_DAY",
    },
    schedule: [
      {
        dayOfWeek: { type: String },
        startTime: { type: String },
        endTime: { type: String },
      },
    ],
  },
  { timestamps: true }
);

module.exports = mongoose.model("Class", classSchema);