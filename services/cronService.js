const cron = require("node-cron");
const Event = require("../models/Event");
const jwt = require("jsonwebtoken");
const Parent = require("../models/Parent");
const Admin = require("../models/Admin");
const { DEFAULT_TIMEZONE, todayDateOnly, dateOnlyStartUtc } = require("../utils/dateTime");
const { processDeliveryJobs } = require("./deliveryService");
async function completeExpiredEvents(now = new Date()) {
  // Completion preserves registrations, attendance, invoices and linked media.
  const today = dateOnlyStartUtc(todayDateOnly(DEFAULT_TIMEZONE, now));
  return Event.updateMany({ endDate: { $lt: today }, status: { $ne: "COMPLETED" } }, { $set: { status: "COMPLETED", isRegistrationOpen: false } });
}
function initCronJobs() {
  const jobs = [];
  jobs.push(cron.schedule("0 0 * * *", () => completeExpiredEvents().catch(() => console.error("Event completion job failed")), { timezone: DEFAULT_TIMEZONE, noOverlap: true }));
  jobs.push(cron.schedule("* * * * *", () => processDeliveryJobs().catch(() => console.error("Delivery retry job failed")), { timezone: DEFAULT_TIMEZONE, noOverlap: true }));
  jobs.push(cron.schedule("0 1 * * *", async () => {
    for (const Model of [Admin, Parent]) {
      const cursor = Model.find({ "tokens.0": { $exists: true } }).select("tokens").cursor();
      for await (const user of cursor) {
        const expired = user.tokens.filter((token) => { try { jwt.verify(token, process.env.JWT_SECRET); return false; } catch { return true; } });
        if (expired.length) await Model.updateOne({ _id: user._id }, { $pull: { tokens: { $in: expired } } });
      }
    }
  }, { timezone: DEFAULT_TIMEZONE, noOverlap: true }));
  return jobs;
}
module.exports = { initCronJobs, completeExpiredEvents };
