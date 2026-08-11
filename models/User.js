const mongoose = require("mongoose");

const userSchema = new mongoose.Schema(
  {
    firstName: String,
    lastName: String,
    fullName: String, // Calculated or stored directly

    email: {
      type: String,
      default: null,
    },
    phone: {
      type: String,
      default: null,
    },
    dob: Date,
    gender: {
      type: String,
      enum: ["MALE", "FEMALE", "OTHER"],
    },
    profileImage: String,

    parentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Parent",
      required: true,
    },

    club: String,
    contactName: String,
    relationship: String,
    additionalComments: {
      type: String,
      default: '',
    },
    comments: String,
    jerseyNumber: {
      type: Number,
      default: null,
    },
    paymentStatus: {
      type: String,
      enum: ["TRIAL", "UNPAID", "PAID", "OVER_DUE", "OTHERS"],
      default: "TRIAL",
    },

    category: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Category",
    },

    categories: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Category",
      },
    ],

    programs: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Program",
      },
    ],
    prefferedFoot: {
      type: String,
      enum: ["LEFT", "RIGHT", "BOTH"],
    },
    isMedicalCondition: {
      type: Boolean,
      default: false,
    },
    medicalConditionDetails: {
      type: String,
      default: '',
    },
    term: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Term",
    },

    rating: {
      type: Number,
      min: 1,
      max: 5,
      default: 1,
    },

    isBlocked: {
      type: Boolean,
      default: false,
    },

    hasPendingRequest: {
      type: Boolean,
      default: false,
    },

    assignedClasses: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Class",
      },
    ],

    removedClasses: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Class",
      },
    ],

    joinedDate: {
      type: Date,
      default: Date.now,
    },
    statistics: {
      appearances: {
        type: Number,
        default: 0,
      },
      goals: {
        type: Number,
        default: 0,
      },
      assists: {
        type: Number,
        default: 0,
      },
      cleanSheets: {
        type: Number,
        default: 0,
      },
      yellowCards: {
        type: Number,
        default: 0,
      },
      redCards: {
        type: Number,
        default: 0,
      },
      minutesPlayed: {
        type: Number,
        default: 0,
      },
    },
    attendancePercentage: {
      type: Number,
      min: 0,
      max: 100,
      default: 0,
    },
    playerStatus: {
      type: String,
      enum: ["PENDING_APPROVAL", "ACTIVE", "REJECTED"],
      default: "ACTIVE",
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Admin",
      default: null,
    },
    createdByRole: {
      type: String,
      enum: ["SUPER_ADMIN", "COACH"],
      default: "SUPER_ADMIN",
    },
    temporarySession: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "TrainingSession",
      default: null,
    },
    temporaryClass: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Class",
      default: null,
    },
    temporarySessionDate: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("User", userSchema);