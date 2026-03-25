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
      enum: ["REGISTERED", "CANCELLED"],
      default: "REGISTERED",
    },
  },
  { timestamps: true }
);

// prevent duplicate registration
eventRegistrationSchema.index({ user: 1, event: 1 }, { unique: true });

module.exports = mongoose.model(
  "EventRegistration",
  eventRegistrationSchema
);