const mongoose = require("mongoose");

const notificationSchema = new mongoose.Schema(
  {
    parent: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Parent",
    },
    admin: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Admin",
    },
    title: {
      type: String,
      required: true,
    },
    message: {
      type: String,
      required: true,
    },
    type: {
      type: String,
      enum: [
        "ANNOUNCEMENT",
        "PAYMENT_REMINDER",
        "ATTENDANCE_ALERT",
        "MATCH_REMINDER",
        "TRAINING_REMINDER",
        "EVENT_REMINDER",
        "ENROLLMENT_REQUEST",
        "PLAYER_ALLOCATED",
        "INVOICE_CREATED",
        "PAYMENT_SUBMITTED",
        "PAYMENT_APPROVED",
        "PAYMENT_REJECTED",
        "ORDER_PAID",
      ],
      default: "ANNOUNCEMENT",
    },
    isRead: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Notification", notificationSchema);
