const mongoose = require("mongoose");

const registrationRequestSchema = new mongoose.Schema(
  {
    parent: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Parent",
      required: true,
    },
    player: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    category: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Category",
      required: true,
    },
    programs: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Program",
        required: true,
      },
    ],
    preferredTerm: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Term",
      default: null,
    },
    preferredClasses: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Class",
      },
    ],
    requestType: {
      type: String,
      enum: ["NEW_PLAYER", "ADD_PROGRAM"],
      required: true,
    },
    status: {
      type: String,
      enum: ["PENDING", "COMPLETED"],
      default: "PENDING",
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Parent",
    },
    assignedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Admin",
      default: null,
    },
    assignedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("RegistrationRequest", registrationRequestSchema);
