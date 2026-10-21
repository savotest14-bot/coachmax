const mongoose = require("mongoose");

const eventRegistrationSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    event: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Event",
      required: true,
    },
    status: {
      type: String,
      enum: ["REGISTERED", "CANCELLED", "PENDING"],
      default: "REGISTERED",
    },
    // Selected camp sessions if Holiday Camp
    selectedSessions: [
      {
        session: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "CampSession",
        },
        sessionDate: Date,
        sessionType: String,
        fee: Number,
        startTime: String,
        endTime: String,
      },
    ],
    totalAmount: {
      type: Number,
      default: 0,
    },
    paymentStatus: {
      type: String,
      enum: [
        "UNPAID",
        "PAYMENT_PENDING",
        "PAID",
        "FAILED",
        "REFUNDED",
        "HANDSHAKE",
        "TRIAL",
        "TBC",
        "EXTRA",
        "SUBSTITUTE",
        "OVER_DUE",
        "APPROVED",
      ],
      default: "UNPAID",
    },
    invoice: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Invoice",
    },
  },
  { timestamps: true }
);

eventRegistrationSchema.index({ user: 1, event: 1 }, { unique: true });

module.exports = mongoose.model(
  "EventRegistration",
  eventRegistrationSchema
);