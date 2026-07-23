const Notification = require("../models/Notification");
const Parent = require("../models/Parent");
const Admin = require("../models/Admin");
const { sendNotification } = require("../services/notificationService");

// =============================================================
// PARENT NOTIFICATION CONTROLLERS
// =============================================================

// ✅ Get Parent Notifications (Paginated + Unread Count)
exports.getParentNotifications = async (req, res) => {
  try {
    const parentId = req.parent._id;
    let { page = 1, limit = 10, isRead } = req.query;

    page = Number(page);
    limit = Number(limit);

    const query = {
      recipientType: { $in: ["PARENT", "ALL"] },
      $or: [{ parent: parentId }, { parent: null }],
    };

    if (isRead !== undefined && isRead !== "") {
      query.isRead = isRead === "true" || isRead === true;
    }

    const [notifications, total, unreadCount] = await Promise.all([
      Notification.find(query)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
      Notification.countDocuments(query),
      Notification.countDocuments({
        ...query,
        isRead: false,
      }),
    ]);

    return res.status(200).json({
      success: true,
      unreadCount,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      data: notifications,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

// ✅ Mark Single Parent Notification as Read
exports.markParentNotificationRead = async (req, res) => {
  try {
    const { notificationId } = req.params;
    const parentId = req.parent._id;

    const notification = await Notification.findOne({
      _id: notificationId,
      recipientType: { $in: ["PARENT", "ALL"] },
      $or: [{ parent: parentId }, { parent: null }],
    });

    if (!notification) {
      return res.status(404).json({
        success: false,
        message: "Notification not found",
      });
    }

    notification.isRead = true;
    notification.readAt = new Date();
    await notification.save();

    return res.status(200).json({
      success: true,
      message: "Notification marked as read",
      data: notification,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

// ✅ Mark All Parent Notifications as Read
exports.markAllParentNotificationsRead = async (req, res) => {
  try {
    const parentId = req.parent._id;

    await Notification.updateMany(
      {
        recipientType: { $in: ["PARENT", "ALL"] },
        $or: [{ parent: parentId }, { parent: null }],
        isRead: false,
      },
      {
        $set: { isRead: true, readAt: new Date() },
      }
    );

    return res.status(200).json({
      success: true,
      message: "All notifications marked as read",
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};


// =============================================================
// ADMIN NOTIFICATION CONTROLLERS
// =============================================================

// ✅ Get Admin Notifications (Paginated + Unread Count)
exports.getAdminNotifications = async (req, res) => {
  try {
    const adminId = req.admin ? req.admin._id : null;
    let { page = 1, limit = 10, isRead } = req.query;

    page = Number(page);
    limit = Number(limit);

    const query = {
      recipientType: { $in: ["ADMIN", "ALL"] },
      $or: [{ admin: adminId }, { admin: null }],
    };

    if (isRead !== undefined && isRead !== "") {
      query.isRead = isRead === "true" || isRead === true;
    }

    const [notifications, total, unreadCount] = await Promise.all([
      Notification.find(query)
        .populate("parent", "fullName email phone")
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
      Notification.countDocuments(query),
      Notification.countDocuments({
        ...query,
        isRead: false,
      }),
    ]);

    return res.status(200).json({
      success: true,
      unreadCount,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      data: notifications,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

// ✅ Mark Single Admin Notification as Read
exports.markAdminNotificationRead = async (req, res) => {
  try {
    const { notificationId } = req.params;
    const adminId = req.admin ? req.admin._id : null;

    const notification = await Notification.findOne({
      _id: notificationId,
      recipientType: { $in: ["ADMIN", "ALL"] },
      $or: [{ admin: adminId }, { admin: null }],
    });

    if (!notification) {
      return res.status(404).json({
        success: false,
        message: "Notification not found",
      });
    }

    notification.isRead = true;
    notification.readAt = new Date();
    await notification.save();

    return res.status(200).json({
      success: true,
      message: "Admin notification marked as read",
      data: notification,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

// ✅ Mark All Admin Notifications as Read
exports.markAllAdminNotificationsRead = async (req, res) => {
  try {
    const adminId = req.admin ? req.admin._id : null;

    await Notification.updateMany(
      {
        recipientType: { $in: ["ADMIN", "ALL"] },
        $or: [{ admin: adminId }, { admin: null }],
        isRead: false,
      },
      {
        $set: { isRead: true, readAt: new Date() },
      }
    );

    return res.status(200).json({
      success: true,
      message: "All admin notifications marked as read",
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

// ✅ Admin Send Custom Push / DB Notification to Parents
exports.sendAdminCustomNotification = async (req, res) => {
  try {
    const { parentId, title, message, type = "ANNOUNCEMENT", data = {} } = req.body;

    if (!title || !message) {
      return res.status(400).json({
        success: false,
        message: "title and message are required",
      });
    }

    // Target specific parent or ALL parents
    const recipientType = "PARENT";

    const notifDoc = await sendNotification({
      recipientType,
      parentId: parentId || null,
      title,
      message,
      type,
      data,
    });

    return res.status(201).json({
      success: true,
      message: parentId
        ? "Notification sent to parent successfully"
        : "Announcement broadcasted to all parents successfully",
      data: notifDoc,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};
