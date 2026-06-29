const mongoose = require("mongoose");

const medicalProfileSchema = new mongoose.Schema(
  {
    player: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
    },
    injuries: [
      {
        type: String,
      },
    ],
    allergies: [
      {
        type: String,
      },
    ],
    medications: [
      {
        type: String,
      },
    ],
    medicalConditions: {
      type: String,
      default: "",
    },
    doctorName: {
      type: String,
      default: "",
    },
    emergencyContact: {
      type: String,
      default: "",
    },
    insuranceDetails: {
      type: String,
      default: "",
    },
    notes: {
      type: String,
      default: "",
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("MedicalProfile", medicalProfileSchema);
