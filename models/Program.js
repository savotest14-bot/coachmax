const mongoose = require("mongoose");

const programSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
    },
    category: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Category",
      required: true,
    },
    description: {
      type: String,
      default: "",
    },
    duration: {
      type: String,
      default: "",
    },
    ageGroup: {
      type: String,
      default: "",
    },
    capacity: {
      type: Number,
      default: 0,
    },
    fees: {
      type: Number,
      default: 0,
    },
    registrationFee: {
      type: Number,
      default: 0,
    },
    uniformIncluded: {
      type: Boolean,
      default: false,
    },
    trainingDays: [
      {
        type: String,
      },
    ],
    coaches: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Admin",
      },
    ],
    status: {
      type: String,
      enum: ["ACTIVE", "INACTIVE"],
      default: "ACTIVE",
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Program", programSchema);