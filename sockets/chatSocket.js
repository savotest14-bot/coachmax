const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Server } = require("socket.io");
const jwt = require("jsonwebtoken");
const Admin = require("../models/Admin");
const Parent = require("../models/Parent");
const ChatRoom = require("../models/ChatRoom");
const Message = require("../models/Message");
const Class = require("../models/Class");
const User = require("../models/User");
const { sendNotification } = require("../services/notificationService");

let io = null;

// Track online users: userId -> { socketIds: Set, role, lastSeen }
const onlineUsersMap = new Map();

/**
 * Helper: Save socket attachment (Buffer / Base64 / File object) to disk
 */
const saveSocketAttachment = (att) => {
  if (!att) return null;

  // Already uploaded URL
  if (att.url && !att.buffer && !att.fileData && !att.base64) {
    return {
      fileType: att.fileType || "FILE",
      url: att.url,
    };
  }

  const chatDir = path.join(process.cwd(), "uploads", "chat");
  if (!fs.existsSync(chatDir)) {
    fs.mkdirSync(chatDir, { recursive: true });
  }

  let fileBuffer = null;
  let ext = ".bin";

  if (att.fileName) {
    ext = path.extname(att.fileName) || ".bin";
  } else if (att.fileType === "IMAGE") {
    ext = ".jpg";
  } else if (att.fileType === "VIDEO") {
    ext = ".mp4";
  } else if (att.fileType === "AUDIO") {
    ext = ".mp3";
  }

  if (Buffer.isBuffer(att.buffer || att.fileData)) {
    fileBuffer = att.buffer || att.fileData;
  } else if (typeof att.base64 === "string") {
    const base64Data = att.base64.replace(/^data:.*?;base64,/, "");
    fileBuffer = Buffer.from(base64Data, "base64");
  } else if (typeof att.fileData === "string") {
    const base64Data = att.fileData.replace(/^data:.*?;base64,/, "");
    fileBuffer = Buffer.from(base64Data, "base64");
  }

  if (!fileBuffer) return null;

  const filename = `${crypto.randomUUID()}${ext}`;
  const fullPath = path.join(chatDir, filename);
  fs.writeFileSync(fullPath, fileBuffer);

  let fileType = att.fileType || "FILE";
  if (!att.fileType) {
    if (ext.match(/\.(jpg|jpeg|png|gif|webp)$/i)) fileType = "IMAGE";
    else if (ext.match(/\.(mp4|webm|mov|avi)$/i)) fileType = "VIDEO";
    else if (ext.match(/\.(mp3|wav|ogg|m4a)$/i)) fileType = "AUDIO";
  }

  return {
    fileType,
    url: `uploads/chat/${filename}`,
  };
};

/**
 * Helper: Check if a user is online
 */
const isUserOnline = (userId) => {
  const user = onlineUsersMap.get(userId.toString());
  return user && user.socketIds && user.socketIds.size > 0;
};

/**
 * Helper: Get last seen date for a user
 */
const getUserLastSeen = (userId) => {
  const user = onlineUsersMap.get(userId.toString());
  return user ? user.lastSeen : null;
};

/**
 * Helper: Calculate tick status based on receipts
 */
const calculateTickStatus = (message, senderId) => {
  const senderStr = senderId ? senderId.toString() : "";
  const otherReads = (message.readReceipts || []).filter(
    (r) => r.user.toString() !== senderStr
  );
  if (otherReads.length > 0) return "READ"; // Double Blue Tick

  const otherDelivered = (message.deliveredTo || []).filter(
    (d) => d.user.toString() !== senderStr
  );
  if (otherDelivered.length > 0) return "DELIVERED"; // Double Gray Tick

  return "SENT"; // Single Tick
};

/**
 * Initialize Socket.IO with HTTP Server
 */
const initSocket = (server) => {
  io = new Server(server, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"],
    },
  });

  // 🔐 Socket Authentication Middleware
  io.use(async (socket, next) => {
    try {
      const token =
        socket.handshake.auth?.token ||
        socket.handshake.headers?.authorization?.replace("Bearer ", "");

      if (!token) {
        return next(new Error("Authentication token required"));
      }

      const decoded = jwt.verify(token, process.env.JWT_SECRET);

      // Check Admin / Coach
      const admin = await Admin.findOne({ _id: decoded.id, tokens: token });
      if (admin) {
        socket.user = admin;
        socket.role = admin.role; // SUPER_ADMIN or COACH
        socket.userId = admin._id.toString();
        socket.refModel = "Admin";
        return next();
      }

      // Check Parent
      const parent = await Parent.findOne({ _id: decoded.id, tokens: token });
      if (parent) {
        if (parent.isBlocked) {
          return next(new Error("Account blocked"));
        }
        socket.user = parent;
        socket.role = "PARENT";
        socket.userId = parent._id.toString();
        socket.refModel = "Parent";
        return next();
      }

      return next(new Error("Invalid token"));
    } catch (err) {
      return next(new Error("Unauthorized: " + err.message));
    }
  });

  // 🔌 Connection Handler
  io.on("connection", async (socket) => {
    const userIdStr = socket.userId;
    console.log(`⚡ Socket connected: ${socket.id} (User: ${userIdStr}, Role: ${socket.role})`);

    // ─────────────────────────────────────────────
    // 🟢 Online / Offline Status Tracking
    // ─────────────────────────────────────────────
    if (!onlineUsersMap.has(userIdStr)) {
      onlineUsersMap.set(userIdStr, {
        socketIds: new Set(),
        role: socket.role,
        lastSeen: new Date(),
      });
    }

    const userData = onlineUsersMap.get(userIdStr);
    userData.socketIds.add(socket.id);

    // Join personal notification channel
    socket.join(`user_${userIdStr}`);

    // Auto-join all chat rooms for this user
    try {
      const userRooms = await ChatRoom.find({ "members.user": userIdStr }).select("_id");
      userRooms.forEach((r) => socket.join(`room_${r._id}`));
    } catch (e) {}

    // Broadcast online status to all connected sockets
    io.emit("user_status_change", {
      userId: userIdStr,
      role: socket.role,
      isOnline: true,
      lastSeen: new Date(),
    });

    // Auto-deliver unread messages for this user (Single Tick ➔ Double Gray Tick)
    autoDeliverUnreadMessages(userIdStr);

    // ─────────────────────────────────────────────
    // 1. Check User Online / Offline Status
    // ─────────────────────────────────────────────
    socket.on("check_user_status", (data, callback) => {
      const { targetUserId } = data || {};
      if (!targetUserId) return;

      const online = isUserOnline(targetUserId);
      const lastSeen = getUserLastSeen(targetUserId);

      if (callback) {
        callback({
          success: true,
          targetUserId,
          isOnline: online,
          lastSeen,
        });
      }
    });

    // ─────────────────────────────────────────────
    // 2. Join Chat Room
    // ─────────────────────────────────────────────
    socket.on("join_room", async (data, callback) => {
      try {
        const { roomId } = typeof data === "string" ? { roomId: data } : data;

        if (!roomId) {
          if (callback) callback({ success: false, message: "roomId is required" });
          return;
        }

        const room = await ChatRoom.findById(roomId);
        if (!room) {
          if (callback) callback({ success: false, message: "Room not found" });
          return;
        }

        socket.join(`room_${roomId}`);
        console.log(`👥 Socket ${userIdStr} joined room_${roomId}`);

        if (callback) callback({ success: true, message: `Joined room_${roomId}` });
      } catch (err) {
        if (callback) callback({ success: false, message: err.message });
      }
    });

    // ─────────────────────────────────────────────
    // 3. Leave Chat Room
    // ─────────────────────────────────────────────
    socket.on("leave_room", (data) => {
      const { roomId } = typeof data === "string" ? { roomId: data } : data;
      if (roomId) {
        socket.leave(`room_${roomId}`);
      }
    });

    // ─────────────────────────────────────────────
    // 4. Real-Time Send Message (Single/Double/Blue Ticks + Attachment Upload)
    // ─────────────────────────────────────────────
    socket.on("send_message", async (data, callback) => {
      try {
        const { roomId, text, attachments } = data;

        if (!roomId || (!text && (!attachments || attachments.length === 0))) {
          if (callback) callback({ success: false, message: "roomId and text/attachments required" });
          return;
        }

        const room = await ChatRoom.findById(roomId);
        if (!room) {
          if (callback) callback({ success: false, message: "Room not found" });
          return;
        }

        // Process & Save Attachments (Buffer / Base64 / File object / Pre-uploaded URL)
        let processedAttachments = [];
        if (attachments && Array.isArray(attachments) && attachments.length > 0) {
          for (const att of attachments) {
            const saved = saveSocketAttachment(att);
            if (saved) processedAttachments.push(saved);
          }
        }

        // Create initial message (Status: SENT = Single Tick)
        const messageDoc = await Message.create({
          room: roomId,
          sender: {
            refModel: socket.refModel,
            user: userIdStr,
          },
          text: text || "",
          attachments: processedAttachments,
          status: "SENT",
          readReceipts: [{ user: userIdStr, readAt: new Date() }],
        });

        // Check if any recipient is currently online (Delivered = Double Gray Tick)
        const otherMembers = room.members.filter(
          (m) => m.user.toString() !== userIdStr
        );

        let isDeliveredToAny = false;

        for (const m of otherMembers) {
          const recipientId = m.user.toString();
          if (isUserOnline(recipientId)) {
            isDeliveredToAny = true;
            if (!messageDoc.deliveredTo.some((d) => d.user.toString() === recipientId)) {
              messageDoc.deliveredTo.push({ user: recipientId, deliveredAt: new Date() });
            }
          }
        }

        if (isDeliveredToAny) {
          messageDoc.status = "DELIVERED";
        }

        await messageDoc.save();

        const populatedMsg = await Message.findById(messageDoc._id)
          .populate("sender.user", "name fullName email profileImage")
          .lean();

        populatedMsg.tickStatus = calculateTickStatus(populatedMsg, userIdStr);

        // Emit real-time message to room AND to user channels
        io.to(`room_${roomId}`).emit("new_message", {
          roomId,
          message: populatedMsg,
        });

        otherMembers.forEach((m) => {
          io.to(`user_${m.user}`).emit("new_message", {
            roomId,
            message: populatedMsg,
          });
        });

        // Emit delivery status back to sender
        socket.emit("message_delivered", {
          messageId: messageDoc._id,
          roomId,
          status: populatedMsg.tickStatus,
        });

        // Update room timestamp
        room.updatedAt = new Date();
        await room.save();

        // Send push notifications to offline recipients
        for (const member of otherMembers) {
          const recipientId = member.user.toString();
          if (!isUserOnline(recipientId)) {
            const isRecipientParent = member.refModel === "Parent";
            sendNotification({
              recipientType: isRecipientParent ? "PARENT" : "COACH",
              parentId: isRecipientParent ? member.user : null,
              coachId: !isRecipientParent ? member.user : null,
              title: socket.role === "PARENT" ? "New Message from Parent 💬" : "New Message from Coach 💬",
              message: text ? text.substring(0, 100) : "Attachment sent",
              type: isRecipientParent ? "PARENT_MESSAGE" : "PARENT_MESSAGE",
              data: { roomId, messageId: messageDoc._id.toString() },
            }).catch((e) => console.error("Push error:", e.message));
          }
        }

        if (callback) callback({ success: true, data: populatedMsg });
      } catch (err) {
        if (callback) callback({ success: false, message: err.message });
      }
    });

    // ─────────────────────────────────────────────
    // 5. Typing Indicator
    // ─────────────────────────────────────────────
    socket.on("typing", async (data) => {
      const { roomId, isTyping } = data || {};
      if (roomId) {
        const senderName = socket.user?.fullName || socket.user?.name || "User";
        socket.to(`room_${roomId}`).emit("user_typing", {
          roomId,
          userId: userIdStr,
          userName: senderName,
          isTyping: !!isTyping,
        });

        try {
          const room = await ChatRoom.findById(roomId).select("members");
          if (room) {
            room.members.forEach((m) => {
              if (m.user.toString() !== userIdStr) {
                io.to(`user_${m.user}`).emit("user_typing", {
                  roomId,
                  userId: userIdStr,
                  userName: senderName,
                  isTyping: !!isTyping,
                });
              }
            });
          }
        } catch (e) {}
      }
    });

    // ─────────────────────────────────────────────
    // 6. Mark Read (Double Blue Tick)
    // ─────────────────────────────────────────────
    socket.on("mark_read", async (data, callback) => {
      try {
        const { roomId } = data || {};
        if (!roomId) return;

        // Find unread messages in room
        const unreadMsgs = await Message.find({
          room: roomId,
          "readReceipts.user": { $ne: userIdStr },
        });

        if (unreadMsgs.length > 0) {
          const unreadIds = unreadMsgs.map((m) => m._id);

          await Message.updateMany(
            { _id: { $in: unreadIds } },
            {
              $set: { status: "READ" },
              $push: { readReceipts: { user: userIdStr, readAt: new Date() } },
            }
          );

          // Emit Double Blue Tick status update to room members
          io.to(`room_${roomId}`).emit("messages_read", {
            roomId,
            readBy: userIdStr,
            readAt: new Date(),
            messageIds: unreadIds,
            status: "READ", // Double Blue Tick
          });

          try {
            const room = await ChatRoom.findById(roomId).select("members");
            if (room) {
              room.members.forEach((m) => {
                io.to(`user_${m.user}`).emit("messages_read", {
                  roomId,
                  readBy: userIdStr,
                  readAt: new Date(),
                  messageIds: unreadIds,
                  status: "READ",
                });
              });
            }
          } catch (e) {}
        }

        if (callback) callback({ success: true });
      } catch (err) {
        if (callback) callback({ success: false, message: err.message });
      }
    });

    // ─────────────────────────────────────────────
    // 7. Full Class Broadcast (Coach ➔ All Class Parents)
    // ─────────────────────────────────────────────
    socket.on("send_broadcast", async (data, callback) => {
      try {
        const { classId, text } = data || {};

        if (socket.role === "PARENT") {
          if (callback) callback({ success: false, message: "Coach/Admin role required for broadcast" });
          return;
        }

        if (!classId || !text) {
          if (callback) callback({ success: false, message: "classId and text are required" });
          return;
        }

        const classData = await Class.findById(classId).populate({
          path: "players",
          select: "parentId",
        });

        if (!classData) {
          if (callback) callback({ success: false, message: "Class not found" });
          return;
        }

        const parentIds = [...new Set(
          classData.players
            .filter((p) => p.parentId)
            .map((p) => p.parentId.toString())
        )];

        // Find or create BROADCAST room for class
        let broadcastRoom = await ChatRoom.findOne({
          type: "BROADCAST",
          classId,
        });

        if (!broadcastRoom) {
          broadcastRoom = await ChatRoom.create({
            type: "BROADCAST",
            classId,
            name: `${classData.name} - Class Broadcast`,
            members: [
              { refModel: "Admin", user: userIdStr },
              ...parentIds.map((pid) => ({ refModel: "Parent", user: pid })),
            ],
          });
        }

        const messageDoc = await Message.create({
          room: broadcastRoom._id,
          sender: { refModel: "Admin", user: userIdStr },
          text,
          status: "SENT",
          readReceipts: [{ user: userIdStr, readAt: new Date() }],
        });

        const populatedMsg = await Message.findById(messageDoc._id)
          .populate("sender.user", "name fullName email profileImage")
          .lean();

        populatedMsg.tickStatus = "SENT";

        // Emit live broadcast to room
        io.to(`room_${broadcastRoom._id}`).emit("new_broadcast", {
          classId,
          roomId: broadcastRoom._id,
          message: populatedMsg,
        });

        // Emit instant notification alert to all target parent sockets
        parentIds.forEach((pid) => {
          io.to(`user_${pid}`).emit("new_broadcast_alert", {
            classId,
            className: classData.name,
            message: text,
          });
        });

        if (callback) callback({ success: true, data: populatedMsg });
      } catch (err) {
        if (callback) callback({ success: false, message: err.message });
      }
    });

    // ─────────────────────────────────────────────
    // 🔴 Disconnect Handler
    // ─────────────────────────────────────────────
    socket.on("disconnect", () => {
      console.log(`🔌 Socket disconnected: ${socket.id}`);

      const userTrack = onlineUsersMap.get(userIdStr);
      if (userTrack) {
        userTrack.socketIds.delete(socket.id);
        if (userTrack.socketIds.size === 0) {
          userTrack.lastSeen = new Date();
          // Broadcast offline event
          io.emit("user_status_change", {
            userId: userIdStr,
            role: socket.role,
            isOnline: false,
            lastSeen: userTrack.lastSeen,
          });
        }
      }
    });
  });

  return io;
};

/**
 * Auto-deliver unread messages when a user connects (Updates Single Tick to Double Gray Tick)
 */
const autoDeliverUnreadMessages = async (userId) => {
  try {
    const userRooms = await ChatRoom.find({
      "members.user": userId,
    }).select("_id");

    const roomIds = userRooms.map((r) => r._id);

    const undeliveredMsgs = await Message.find({
      room: { $in: roomIds },
      "sender.user": { $ne: userId },
      "deliveredTo.user": { $ne: userId },
    });

    if (undeliveredMsgs.length > 0) {
      const msgIds = undeliveredMsgs.map((m) => m._id);

      await Message.updateMany(
        { _id: { $in: msgIds } },
        {
          $set: { status: "DELIVERED" },
          $push: { deliveredTo: { user: userId, deliveredAt: new Date() } },
        }
      );

      // Notify senders of delivery
      undeliveredMsgs.forEach((msg) => {
        if (io) {
          io.to(`room_${msg.room}`).emit("message_delivered", {
            messageId: msg._id,
            roomId: msg.room,
            status: "DELIVERED",
          });
        }
      });
    }
  } catch (err) {
    console.error("Auto deliver error:", err.message);
  }
};

/**
 * Get active Socket.IO instance
 */
const getIO = () => {
  if (!io) {
    throw new Error("Socket.io has not been initialized!");
  }
  return io;
};

module.exports = {
  initSocket,
  getIO,
  isUserOnline,
  getUserLastSeen,
  calculateTickStatus,
};
