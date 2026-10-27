const mongoose = require("mongoose");

const attendanceSchema = new mongoose.Schema(
  {
    class: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Class",
    },

    team: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Team",
    },

    league: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "League",
    },

    event: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Event",
    },

    campSession: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "CampSession",
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
          enum: ["PRESENT", "ABSENT", "LATE", "NOT_MARKED"],
          default: "ABSENT",
        },
        comment: {
          type: String,
          default: "",
        },
        note: { type: String, default: "", maxlength: 2000 },
        noteAuthor: { type: mongoose.Schema.Types.ObjectId, ref: "Admin" },
        noteUpdatedAt: Date,
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
        parentAbsenceReason: { type: String, default: "", maxlength: 2000 },
        parentReporter: { type: mongoose.Schema.Types.ObjectId, ref: "Parent" },
        parentReportedAt: Date,
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

attendanceSchema.index(
  { class: 1, sessionDate: 1 },
  { unique: true, partialFilterExpression: { class: { $type: "objectId" } } }
);
attendanceSchema.index(
  { team: 1, league: 1, sessionDate: 1 },
  {
    unique: true,
    partialFilterExpression: {
      team: { $type: "objectId" },
      league: { $type: "objectId" },
    },
  }
);
attendanceSchema.index({ trainingSessionId: 1 }, { unique: true, sparse: true });
attendanceSchema.index({ team: 1, sessionDate: 1 }, { unique: true, partialFilterExpression: { team: { $type: "objectId" }, league: null } });
attendanceSchema.index(
  { event: 1, sessionDate: 1, campSession: 1 },
  {
    unique: true,
    partialFilterExpression: {
      event: { $type: "objectId" },
    },
  }
);

module.exports = mongoose.model("Attendance", attendanceSchema);
