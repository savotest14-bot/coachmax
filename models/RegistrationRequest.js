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
      required: function () {
        return this.requestType !== "TEMPORARY_PLAYER" && this.requestType !== "TEMPORARY";
      },
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
      enum: ["NEW_PLAYER", "ADD_PROGRAM", "HOLIDAY_PROGRAM", "EVENT_REGISTRATION", "TEMPORARY_PLAYER", "TEMPORARY"],
      required: true,
    },
    status: {
      type: String,
      enum: ["PENDING", "APPROVED", "REJECTED", "CANCELLED", "COMPLETED"],
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
    allocatedClasses: [{ type: mongoose.Schema.Types.ObjectId, ref: "Class" }],
    allocationPaymentStatus: { type: String, default: "" },
    rejectionReason: { type: String, default: "", maxlength: 2000 },
    overrideReason: { type: String, default: "", maxlength: 2000 },
  },
  { timestamps: true }
);

registrationRequestSchema.index({ status: 1, createdAt: -1 });
registrationRequestSchema.index({ player: 1, status: 1 });

module.exports = mongoose.model("RegistrationRequest", registrationRequestSchema);
