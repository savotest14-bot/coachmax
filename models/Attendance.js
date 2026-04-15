const mongoose = require("mongoose");

const attendanceSchema = new mongoose.Schema(
  {
    class: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Class",
      required: true,
    },

    sessionDate: {
      type: Date,
      required: true,
    },

    records: [
      {
        player: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "User",
          required: true,
        },
        status: {
          type: String,
          enum: ["PRESENT", "ABSENT", "LATE"],
          default: "ABSENT",
        },
      },
    ],

    markedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Admin",
    },
  },
  { timestamps: true }
);

// 🔥 prevent duplicate attendance per session
attendanceSchema.index({ class: 1, sessionDate: 1 }, { unique: true });

module.exports = mongoose.model("Attendance", attendanceSchema);