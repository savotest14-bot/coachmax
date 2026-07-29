const admin = require("firebase-admin");
const Notification = require("../models/Notification");
const Parent = require("../models/Parent");
const Admin = require("../models/Admin");
const fs = require("fs");
const path = require("path");

// -------------------------------------------------------------
// Initialize Firebase Admin SDK (Push Notification Setup)
// -------------------------------------------------------------
let isFirebaseInitialized = false;

try {
  const serviceAccountPath =
    process.env.FIREBASE_SERVICE_ACCOUNT_PATH ||
    path.join(__dirname, "../config/serviceAccountKey.json");

  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    isFirebaseInitialized = true;
    console.log("🔥 Firebase Admin initialized from environment JSON");
  } else if (fs.existsSync(serviceAccountPath)) {
    const serviceAccount = require(serviceAccountPath);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    isFirebaseInitialized = true;
    console.log("🔥 Firebase Admin initialized from serviceAccountKey.json");
  } else {
    console.warn(
      "⚠️ Push Notification Warning: No Firebase Service Account key found. DB Notifications will be created, but FCM Push Notifications will be skipped until credentials are provided."
    );
  }
} catch (err) {
  console.error("⚠️ Firebase Admin Initialization Error:", err.message);
}

/**
 * Send FCM Push Notification to device tokens
 */

const sendPushToTokens = async (tokens, payload) => {
  if (!isFirebaseInitialized || !tokens || tokens.length === 0) return;

  const validTokens = [...new Set(tokens.filter(Boolean))];
  if (validTokens.length === 0) return;

  try {
    const messagePayload = {
      notification: {
        title: payload.title,
        body: payload.message,
      },
      data: {
        type: payload.type || "ANNOUNCEMENT",
        notificationId: payload.notificationId ? String(payload.notificationId) : "",
        ...(payload.data
          ? Object.fromEntries(
              Object.entries(payload.data).map(([k, v]) => [k, String(v)])
            )
          : {}),
      },
      tokens: validTokens,
    };

    if (admin.messaging().sendEachForMulticast) {
      const response = await admin.messaging().sendEachForMulticast(messagePayload);
      console.log(`📱 FCM Push sent: ${response.successCount} succeeded, ${response.failureCount} failed.`);
    } else if (admin.messaging().sendMulticast) {
      const response = await admin.messaging().sendMulticast(messagePayload);
      console.log(`📱 FCM Push sent: ${response.successCount} succeeded, ${response.failureCount} failed.`);
    }
  } catch (err) {
    console.error("❌ Failed to send FCM Push Notification:", err.message);
  }
};

/**
 * Create DB Notification + Send Push Notification
 */
const sendNotification = async ({
  recipientType = "PARENT", // "ADMIN" | "COACH" | "PARENT" | "ALL"
  parentId = null,
  adminId = null,
  coachId = null,
  userId = null,
  title,
  message,
  type = "ANNOUNCEMENT",
  data = {},
}) => {
  try {
    let targetParentId = parentId;
    let targetAdminId = adminId || coachId;

    // Fallback if generic userId was passed
    if (!targetParentId && !targetAdminId && userId) {
      if (recipientType === "PARENT") targetParentId = userId;
      else targetAdminId = userId;
    }

    // Auto-detect recipient role if targetAdminId is provided
    let finalRecipientType = recipientType;

    if (targetAdminId) {
      const adminDoc = await Admin.findById(targetAdminId).select("role fcmTokens");
      if (adminDoc) {
        if (adminDoc.role === "COACH") {
          finalRecipientType = "COACH";
        } else if (adminDoc.role === "SUPER_ADMIN" || adminDoc.role === "ADMIN") {
          finalRecipientType = "ADMIN";
        }
      }
    }

    // 1. Create Notification Record in DB
    const notifDoc = await Notification.create({
      recipientType: finalRecipientType,
      parent: targetParentId || null,
      admin: targetAdminId || null,
      title,
      message,
      type,
      data,
    });

    // 2. Collect FCM Tokens for Target Recipients
    let fcmTokens = [];

    if (finalRecipientType === "PARENT") {
      if (targetParentId) {
        const parentDoc = await Parent.findById(targetParentId).select("fcmTokens");
        if (parentDoc && parentDoc.fcmTokens) {
          fcmTokens.push(...parentDoc.fcmTokens);
        }
      } else {
        // Global for all parents
        const parents = await Parent.find({ isBlocked: false }).select("fcmTokens");
        parents.forEach((p) => {
          if (p.fcmTokens) fcmTokens.push(...p.fcmTokens);
        });
      }
    } else if (finalRecipientType === "ADMIN") {
      if (targetAdminId) {
        const adminDoc = await Admin.findById(targetAdminId).select("fcmTokens");
        if (adminDoc && adminDoc.fcmTokens) {
          fcmTokens.push(...adminDoc.fcmTokens);
        }
      } else {
        // Global for Super Admins
        const admins = await Admin.find({ role: { $in: ["SUPER_ADMIN", "ADMIN"] } }).select("fcmTokens");
        admins.forEach((a) => {
          if (a.fcmTokens) fcmTokens.push(...a.fcmTokens);
        });
      }
    } else if (finalRecipientType === "COACH") {
      if (targetAdminId) {
        const coachDoc = await Admin.findById(targetAdminId).select("fcmTokens");
        if (coachDoc && coachDoc.fcmTokens) {
          fcmTokens.push(...coachDoc.fcmTokens);
        }
      } else {
        // Global for all Coaches
        const coaches = await Admin.find({ role: "COACH" }).select("fcmTokens");
        coaches.forEach((c) => {
          if (c.fcmTokens) fcmTokens.push(...c.fcmTokens);
        });
      }
    } else if (finalRecipientType === "ALL") {
      const parents = await Parent.find({ isBlocked: false }).select("fcmTokens");
      const admins = await Admin.find().select("fcmTokens");

      parents.forEach((p) => {
        if (p.fcmTokens) fcmTokens.push(...p.fcmTokens);
      });
      admins.forEach((a) => {
        if (a.fcmTokens) fcmTokens.push(...a.fcmTokens);
      });
    }

    // 3. Dispatch Push Notification (Non-blocking)
    sendPushToTokens(fcmTokens, {
      title,
      message,
      type,
      notificationId: notifDoc._id,
      data,
    }).catch((err) =>
      console.error("Push Notification async error:", err.message)
    );

    return notifDoc;
  } catch (err) {
    console.error("❌ Failed to create notification:", err.message);
    throw err;
  }
};

module.exports = {
  sendNotification,
  sendPushToTokens,
};
