const DeliveryJob = require("../models/DeliveryJob");
const { sendNotification } = require("./notificationService");
const sendEmail = require("../utils/sendEmail");
const queueNotification = (key, payload, session) => DeliveryJob.updateOne({ key }, { $setOnInsert: { key, payload, status: "PENDING", nextAttempt: new Date() } }, { upsert: true, session });
const queueEmail = (key, payload, session) => DeliveryJob.updateOne({ key }, { $setOnInsert: { key, kind: "EMAIL", payload, status: "PENDING", nextAttempt: new Date() } }, { upsert: true, session });
async function processDeliveryJobs({ sendEmailFn = sendEmail, sendNotificationFn = sendNotification } = {}) {
  for (let count = 0; count < 50; count++) {
    const now = new Date();
    const job = await DeliveryJob.findOneAndUpdate({ $or: [{ status: "PENDING", nextAttempt: { $lte: now } }, { status: "SENDING", lockedUntil: { $lt: now } }] }, { $set: { status: "SENDING", lockedUntil: new Date(Date.now() + 60000) }, $inc: { attempts: 1 } }, { new: true, sort: { nextAttempt: 1 } });
    if (!job) break;
    try {
      if (job.kind === "EMAIL") {
        if (!await sendEmailFn(job.payload.to, job.payload.subject, job.payload.html)) throw new Error("Email was not accepted for delivery");
      } else {
        await sendNotificationFn({ ...job.payload, idempotencyKey: job.key, awaitPush: true });
      }
      await DeliveryJob.updateOne({ _id: job._id, attempts: job.attempts }, { $set: { status: "SENT" }, $unset: { lockedUntil: 1, lastError: 1 } });
    } catch (error) {
      await DeliveryJob.updateOne({ _id: job._id, attempts: job.attempts }, { $set: { status: job.attempts >= 8 ? "FAILED" : "PENDING", nextAttempt: new Date(Date.now() + Math.min(3600000, 30000 * 2 ** job.attempts)), lastError: "Delivery failed" }, $unset: { lockedUntil: 1 } });
    }
  }
}
module.exports = { queueNotification, queueEmail, processDeliveryJobs };
