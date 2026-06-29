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
    profileImage: String, // Added

    parentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Parent",
      required: true,
    },

    club: String,
    contactName: String,
    relationship: String,
    skillLevel: {
      type: String,
      enum: ['BEGINNER', 'INTERMEDIATE', 'ADVANCED'],
    },
    group: {
      type: String,
      enum: ['U6', 'U8', 'U10', 'U12', 'U14', 'U16', 'U19', 'SENIOR'],
      required: true,
    },
    additionalComments: {
      type: String,
      default: '',
    },
    medicalConditions: {
      type: String,
      default: '',
    },
    preferredFoot: {
      type: String,
      enum: ["LEFT", "RIGHT", "AMBIDEXTROUS"],
    },
    weakFootRating: {
      type: Number,
      min: 1,
      max: 5,
    },
    dominantPosition: String,
    secondaryPosition: String,
    height: Number, // in cm
    weight: Number, // in kg
    bloodGroup: String,
    nationality: String,
    school: String,
    academy: String,
    comments: String,

    status: {
      type: String,
      enum: ["PENDING", "APPROVED", "REJECTED"],
      default: "PENDING",
    },

    category: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Category",
    },

    program: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Program",
    },

    term: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Term",
    },

    jerseyNumber: {
      type: Number,
      min: 0,
      max: 99,
    },

    rejectReason: {
      type: String,
      default: null,
    },

    approvedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Admin",
      default: null,
    },

    rejectedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Admin",
      default: null,
    },

    approvedAt: {
      type: Date,
      default: null,
    },

    rejectedAt: {
      type: Date,
      default: null,
    },

    isBlocked: {
      type: Boolean,
      default: false,
    },

    adminNote: {
      type: String,
      default: "",
    },

    assignedClasses: [
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
  },
  { timestamps: true }
);

// ✅ Unique jersey per program (if jerseyNumber is present)
userSchema.index(
  { program: 1, jerseyNumber: 1 },
  { unique: true, sparse: true }
);

module.exports = mongoose.model("User", userSchema);