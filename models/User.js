const mongoose = require("mongoose");

const userSchema = new mongoose.Schema(
  {
    fullName: String,
    email: {
      type: String,
      unique: true,
      sparse: true,
    },
    password: String,
    phone: {
      type: String,
      unique: true,
    },
    otp: String,
    otpExpire: Date,
    isOtpVerified: { type: Boolean, default: false },
    dob: Date,
    profile: String,
    club: String,
    contactName: String,

    preferredFoot: {
      type: String,
      enum: ["LEFT", "RIGHT", "AMBIDEXTROUS"],
    },

    skillLevel: {
      type: Number,
      min: 1,
      max: 5,
    },

    medicalCondition: String,
    comments: String,

    status: {
      type: String,
      enum: ["PENDING", "APPROVED", "REJECTED"],
      default: "PENDING",
    },

    tokens: [{ type: String }],

    // ✅ NEW: Category reference
    category: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Category",
      required: function () {
        return this.role === "PLAYER";
      },
    },

    program: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Program",
      required: function () {
        return this.role === "PLAYER";
      },
    },
    role: {
      type: String,
      enum: ["PLAYER", "COACH"],
      default: "PLAYER",
    },
    // ✅ Jersey Number
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

    term: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Term",
    },
  },
  { timestamps: true }
);

// ✅ Unique jersey per program
userSchema.index(
  { program: 1, jerseyNumber: 1 },
  { unique: true, sparse: true }
);

module.exports = mongoose.model("User", userSchema);