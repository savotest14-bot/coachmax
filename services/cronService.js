const cron = require("node-cron");
const Event = require("../models/Event");
const EventRegistration = require("../models/EventRegistration");

const jwt = require("jsonwebtoken");
const Parent = require("../models/Parent");
const Admin = require("../models/Admin");

// Run daily at midnight (0 0 * * *) to delete expired events
const initCronJobs = () => {
  cron.schedule("0 0 * * *", async () => {
    try {
      console.log("⏰ Running expired events cleanup cron job...");
      
      const now = new Date();
      // Find all events where endDate is in the past
      const expiredEvents = await Event.find({ endDate: { $lt: now } }).select("_id");
      
      if (expiredEvents.length > 0) {
        const expiredEventIds = expiredEvents.map((e) => e._id);
        
        // 1. Delete associated event registrations
        const regDeleteResult = await EventRegistration.deleteMany({ event: { $in: expiredEventIds } });
        
        // 2. Delete the events themselves
        const eventDeleteResult = await Event.deleteMany({ _id: { $in: expiredEventIds } });
        
        console.log(`🧹 Successfully cleaned up:`);
        console.log(`   - ${eventDeleteResult.deletedCount} expired events`);
        console.log(`   - ${regDeleteResult.deletedCount} event registrations`);
      } else {
        console.log("No expired events found for cleanup.");
      }
    } catch (error) {
      console.error("❌ Error in expired events cleanup cron job:", error);
    }
  });

  // Run daily at 1:00 AM (0 1 * * *) to clean up expired/invalid tokens
  cron.schedule("0 1 * * *", async () => {
    try {
      console.log("⏰ Running expired tokens cleanup cron job...");
      const secret = process.env.JWT_SECRET;
      
      const processModelTokens = async (Model, modelName) => {
        const users = await Model.find({ tokens: { $exists: true, $not: { $size: 0 } } });
        let totalCleaned = 0;
        
        for (const user of users) {
          const originalCount = user.tokens.length;
          const validTokens = [];
          
          for (const token of user.tokens) {
            try {
              jwt.verify(token, secret);
              validTokens.push(token); // keep valid token
            } catch (err) {
              totalCleaned++;
            }
          }
          
          if (validTokens.length !== originalCount) {
            user.tokens = validTokens;
            await user.save();
          }
        }
        
        console.log(`🧹 Cleaned up ${totalCleaned} invalid/expired tokens for ${modelName}s`);
      };

      await processModelTokens(Admin, "Admin");
      await processModelTokens(Parent, "Parent");
    } catch (error) {
      console.error("❌ Error in expired tokens cleanup cron job:", error);
    }
  });

  console.log("🚀 Cron jobs initialized.");
};

module.exports = { initCronJobs };
