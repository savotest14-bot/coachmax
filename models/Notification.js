const mongoose = require("mongoose");

const notificationSchema = new mongoose.Schema(
  {
    recipientType: {
      type: String,
      enum: ["ADMIN", "PARENT", "ALL"],
      required: true,
      default: "PARENT",
    },
    parent: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Parent",
      default: null,
    },
    admin: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Admin",
      default: null,
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
        "GENERAL",
      ],
      default: "ANNOUNCEMENT",
    },
    isRead: {
      type: Boolean,
      default: false,
    },
    readAt: {
      type: Date,
      default: null,
    },
    data: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Notification", notificationSchema);
