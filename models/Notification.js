const mongoose = require("mongoose");

const notificationSchema = new mongoose.Schema(
  {
    idempotencyKey: { type: String },
    recipientType: {
      type: String,
      enum: ["ADMIN", "COACH", "PARENT", "ALL"],
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
        "TEMPORARY_PLAYER_ADDED",
        "ATTENDANCE_SUBMITTED",
        "MEDICAL_ALERT",
        "PARENT_MESSAGE",
        "CLASS_BROADCAST",
        "COACH_ASSIGNMENT",
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
    isDeliveryOnly: { type: Boolean, default: false },
    // Transactional delivery outbox metadata. Keeping it on notifications
    // avoids a separate collection for the notification delivery queue.
    deliveryKind: { type: String, enum: ["NOTIFICATION", "EMAIL"], default: "NOTIFICATION" },
    deliveryPayload: { type: mongoose.Schema.Types.Mixed },
    deliveryStatus: { type: String, enum: ["PENDING", "SENDING", "SENT", "FAILED"] },
    deliveryAttempts: { type: Number, default: 0 },
    deliveryNextAttempt: Date,
    deliveryLockedUntil: Date,
    deliveryLastError: String,
  },
  { timestamps: true }
);

// Outbox-only delivery records must not leak into user notification lists.
notificationSchema.pre(["find", "findOne", "countDocuments"], function excludeDeliveryOnlyRecords() {
  this.where({ isDeliveryOnly: { $ne: true } });
});

notificationSchema.index({ idempotencyKey: 1 }, { unique: true, partialFilterExpression: { idempotencyKey: { $type: "string" } } });
module.exports = mongoose.model("Notification", notificationSchema);
