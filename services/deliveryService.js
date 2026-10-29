const Notification = require("../models/Notification");
const { sendNotification } = require("./notificationService");
const sendEmail = require("../utils/sendEmail");
const queueNotification = (key, payload, session) => {
  const recipientType = payload.recipientType || (payload.adminId || payload.coachId ? "ADMIN" : "PARENT");
  const parent = recipientType === "PARENT" ? payload.parentId || payload.userId || null : null;
  const admin = ["ADMIN", "COACH"].includes(recipientType) ? payload.adminId || payload.coachId || payload.userId || null : null;
  const now = new Date();
  return Notification.updateOne({ idempotencyKey: key }, { $setOnInsert: {
    idempotencyKey: key,
    recipientType,
    parent,
    admin,
    title: payload.title || "Notification",
    message: payload.message || "",
    type: payload.type || "ANNOUNCEMENT",
    data: payload.data || {},
    isRead: false,
    isDeliveryOnly: false,
    deliveryKind: "NOTIFICATION",
    deliveryPayload: payload,
    deliveryStatus: "PENDING",
    deliveryAttempts: 0,
    deliveryNextAttempt: now,
  } }, { upsert: true, session });
};
const queueEmail = (key, payload, session) => Notification.updateOne({ idempotencyKey: `email:${key}` }, { $setOnInsert: {
  idempotencyKey: `email:${key}`,
  recipientType: "ADMIN",
  title: payload.subject || "Email delivery",
  message: payload.text || payload.subject || "Email delivery",
  type: "GENERAL",
  isRead: true,
  isDeliveryOnly: true,
  deliveryKind: "EMAIL",
  deliveryPayload: payload,
  deliveryStatus: "PENDING",
  deliveryAttempts: 0,
  deliveryNextAttempt: new Date(),
} }, { upsert: true, session });
async function processDeliveryJobs({ sendEmailFn = sendEmail, sendNotificationFn = sendNotification } = {}) {
  for (let count = 0; count < 50; count++) {
    const now = new Date();
    const notification = await Notification.findOneAndUpdate({
      deliveryKind: { $in: ["NOTIFICATION", "EMAIL"] },
      $or: [
        { deliveryStatus: "PENDING", deliveryNextAttempt: { $lte: now } },
        { deliveryStatus: "SENDING", deliveryLockedUntil: { $lt: now } },
      ],
    }, { $set: { deliveryStatus: "SENDING", deliveryLockedUntil: new Date(Date.now() + 60000) }, $inc: { deliveryAttempts: 1 } }, { new: true, sort: { deliveryNextAttempt: 1 } });
    if (notification) {
      const attempts = notification.deliveryAttempts;
      try {
        if (notification.deliveryKind === "EMAIL") {
          const payload = notification.deliveryPayload || {};
          if (!await sendEmailFn(payload.to, payload.subject, payload.html)) throw new Error("Email was not accepted for delivery");
        } else {
          await sendNotificationFn({ ...notification.deliveryPayload, idempotencyKey: notification.idempotencyKey, awaitPush: true });
        }
        await Notification.updateOne({ _id: notification._id, deliveryAttempts: attempts }, { $set: { deliveryStatus: "SENT" }, $unset: { deliveryLockedUntil: 1, deliveryLastError: 1 } });
      } catch (error) {
        await Notification.updateOne({ _id: notification._id, deliveryAttempts: attempts }, { $set: { deliveryStatus: attempts >= 8 ? "FAILED" : "PENDING", deliveryNextAttempt: new Date(Date.now() + Math.min(3600000, 30000 * 2 ** attempts)), deliveryLastError: "Delivery failed" }, $unset: { deliveryLockedUntil: 1 } });
      }
      continue;
    }

    if (!notification) break;
  }
}
module.exports = { queueNotification, queueEmail, processDeliveryJobs };
