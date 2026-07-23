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

    trainingSessionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "TrainingSession",
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
        remarks: {
          type: String,
          default: "",
        },
        reason: {
          type: String,
          default: "",
        },
        markedByParent: {
          type: Boolean,
          default: false,
        },
        lateArrival: {
          type: Boolean,
          default: false,
        },
        attendanceType: {
          type: String,
          enum: ["REGULAR", "MAKEUP", "TRIAL"],
          default: "REGULAR",
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

// 🔥 prevent duplicate attendance per session/date
attendanceSchema.index({ class: 1, sessionDate: 1 }, { unique: true });

// prevent duplicate attendance per training session
attendanceSchema.index({ trainingSessionId: 1 }, { unique: true, sparse: true });

module.exports = mongoose.model("Attendance", attendanceSchema);