const fs = require("fs");
const path = require("path");
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
let closeSessionResources = async () => {};

const onlineUsersMap = new Map();

const { saveValidatedBuffer, signatureType, UPLOAD_ROOT } = require('../utils/upload');
const { canonicalMediaPath, canReadMedia, signMedia } = require('../middleware/privateMedia');
const saveSocketAttachment = async (att, socket, newUploads) => {
  if (!att || typeof att !== 'object') throw new Error('Invalid attachment');
  if (att.url && !att.buffer && !att.fileData && !att.base64) {
    const relative=canonicalMediaPath(att.url);
    const identity={admin:socket.refModel==='Admin'?socket.user:null,parent:socket.refModel==='Parent'?socket.user:null};
    if(!relative || !relative.startsWith('uploads/chat/') || !await canReadMedia(identity,relative))throw new Error('Attachment access denied');
    return {fileType:att.fileType || 'FILE',url:relative};
  }
  const raw=att.buffer || att.fileData || att.base64;
  if (typeof raw === 'string' && raw.length > 70*1024*1024) throw new Error('Attachment is too large');
  const buffer=Buffer.isBuffer(raw)?raw:typeof raw==='string'?Buffer.from(raw.replace(/^data:.*?;base64,/,''),'base64'):null;
  if(!buffer || !buffer.length || buffer.length>50*1024*1024)throw new Error('Invalid attachment size');
  const mime=signatureType(buffer);if(!mime)throw new Error('Unsupported attachment type');
  const file=await saveValidatedBuffer(buffer,mime,'file');
  newUploads.push({ path: file.path, url: 'uploads/chat/'+file.filename });
  return {fileType:file.mimetype.startsWith('image/')?'IMAGE':file.mimetype.startsWith('video/')?'VIDEO':file.mimetype.startsWith('audio/')?'AUDIO':'FILE',url:'uploads/chat/'+file.filename};
};

const sessionFailure = () => Object.assign(new Error("Session expired or revoked. Please sign in again."), { code: "SESSION_REVOKED" });
async function authenticateSocket(socket, token = socket.sessionToken) {
  if (typeof token !== "string" || !token) throw sessionFailure();
  let decoded;
  try { decoded = jwt.verify(token, process.env.JWT_SECRET); } catch { throw sessionFailure(); }
  if (!decoded.id || (socket.userId && String(decoded.id) !== socket.userId)) throw sessionFailure();
  let user, refModel;
  if (!socket.refModel || socket.refModel === "Admin") {
    user = await Admin.findOne({ _id: decoded.id, tokens: token, isActive: { $ne: false } });
    if (user && ["SUPER_ADMIN", "COACH"].includes(user.role)) refModel = "Admin";
    else user = null;
  }
  if (!user && (!socket.refModel || socket.refModel === "Parent")) {
    user = await Parent.findOne({ _id: decoded.id, tokens: token, isBlocked: { $ne: true }, status: "APPROVED" });
    if (user) refModel = "Parent";
  }
  if (!user) throw sessionFailure();
  socket.sessionToken = token;
  socket.user = user;
  socket.userId = String(user._id);
  socket.refModel = refModel;
  socket.role = refModel === "Parent" ? "PARENT" : user.role;
  socket.tokenExpiresAt = Number(decoded.exp || 0) * 1000;
  if (socket.connected && socket.role !== "SUPER_ADMIN") await socket.leave("admin_channel");
  return user;
}

function revokeSocket(socket) {
  if (!socket.connected) return;
  socket.emit("session_revoked", { success: false, code: "SESSION_REVOKED", message: sessionFailure().message });
  socket.disconnect(true);
}

async function removeUnpersistedUploads(uploads) {
  const base = path.resolve(UPLOAD_ROOT, "chat");
  for (const upload of uploads) {
    const target = path.resolve(upload.path);
    if (!target.startsWith(base + path.sep)) continue;
    try {
      // A lost database response can follow a committed Message.create. Never
      // remove an attachment referenced by any persisted or forwarded message.
      if (await Message.exists({ "attachments.url": { $in: [upload.url, `/${upload.url}`] } })) continue;
      await fs.promises.unlink(target);
    } catch (error) { if (error.code !== "ENOENT") console.error("Unable to clean unused socket attachment:", error.code || error.name); }
  }
}

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
const initSocket = (server, { sessionCheckIntervalMs = 15000 } = {}) => {
  io = new Server(server, {
    maxHttpBufferSize: 70 * 1024 * 1024,
    cors: {
      origin(origin, callback) {
        const allowed=new Set([...(process.env.ALLOWED_ORIGINS||'').split(','),process.env.FRONTEND_URL,process.env.CLIENT_URL,process.env.APP_URL].filter(Boolean).map(value=>{try{return new URL(value.trim()).origin}catch{return ''}}));
        callback(null,!origin || allowed.has(origin) || (process.env.NODE_ENV!=='production' && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)));
      },
      methods: ["GET", "POST"],
    },
  });

  // Socket Authentication Middleware
  io.use(async (socket, next) => {
    try {
      const token =
        socket.handshake.auth?.token ||
        socket.handshake.headers?.authorization?.replace("Bearer ", "");

      await authenticateSocket(socket, token);
      return next();
    } catch (err) {
      return next(sessionFailure());
    }
  });

  // Change streams revoke idle connections promptly after logout, password
  // reset or account blocking. Per-packet checks and a periodic fallback remain
  // authoritative if a stream is temporarily unavailable.
  const watchers = [];
  const resources = new Map();
  for (const [Model, refModel] of [[Admin, "Admin"], [Parent, "Parent"]]) {
    const watcher = Model.watch([{ $match: { operationType: { $in: ["update", "replace", "delete"] } } }]);
    watcher.on("change", (change) => {
      if (change.operationType === "update" && !Object.keys(change.updateDescription?.updatedFields || {}).concat(change.updateDescription?.removedFields || []).some((key) => /^(tokens(?:\.|$)|isActive$|isBlocked$|status$|role$)/.test(key))) return;
      for (const socket of io?.sockets.sockets.values() || []) if (socket.refModel === refModel && socket.userId === String(change.documentKey?._id)) authenticateSocket(socket).catch(() => revokeSocket(socket));
    });
    watcher.on("error", () => { watcher.close().catch(() => {}); });
    watchers.push(watcher);
  }
  const cleanupSessions = async () => {
    for (const clear of resources.values()) clear();
    resources.clear();
    await Promise.all(watchers.map((watcher) => watcher.close().catch(() => {})));
  };
  closeSessionResources = cleanupSessions;
  server.once("close", () => { cleanupSessions().catch(() => {}); });

  //  Connection Handler
  io.on("connection", async (socket) => {
    const userIdStr = socket.userId;
    socket.use(async (packet, next) => {
      try { await authenticateSocket(socket); return next(); }
      catch {
        const callback = packet[packet.length - 1];
        if (typeof callback === "function") callback({ success: false, code: "SESSION_REVOKED", message: sessionFailure().message });
        revokeSocket(socket);
      }
    });
    const interval = setInterval(() => { authenticateSocket(socket).catch(() => revokeSocket(socket)); }, Math.max(100, Number(sessionCheckIntervalMs) || 15000));
    interval.unref?.();
    let expiryTimer;
    const expire = () => {
      if (!socket.tokenExpiresAt || !socket.connected) return;
      const remaining = socket.tokenExpiresAt - Date.now();
      if (remaining <= 0) revokeSocket(socket);
      else { expiryTimer = setTimeout(expire, Math.min(remaining, 2147483647)); expiryTimer.unref?.(); }
    };
    if (socket.tokenExpiresAt) { expiryTimer = setTimeout(expire, Math.max(0, Math.min(socket.tokenExpiresAt - Date.now(), 2147483647))); expiryTimer.unref?.(); }
    resources.set(socket.id, () => { clearInterval(interval); clearTimeout(expiryTimer); });
    console.log(`⚡ Socket connected: ${socket.id} (User: ${userIdStr}, Role: ${socket.role})`);

    // ─────────────────────────────────────────────
    //  Online / Offline Status Tracking
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
    ChatRoom.find({ members: { $elemMatch: { user: userIdStr, refModel: socket.refModel } } }).select("_id").then((rooms) => {
      if (socket.connected) rooms.forEach((room) => socket.join(`room_${room._id}`));
    }).catch(() => {});

    // Broadcast online status to all connected sockets
    io.emit("user_status_change", {
      userId: userIdStr,
      role: socket.role,
      isOnline: true,
      lastSeen: new Date(),
    });

    // Auto-deliver unread messages for this user (Single Tick ➔ Double Gray Tick)
    authenticateSocket(socket).then(() => { if (socket.connected) return autoDeliverUnreadMessages(userIdStr, socket.refModel); }).catch(() => revokeSocket(socket));

    // Join admin channel and send initial badges if admin
    if (socket.role === "SUPER_ADMIN" || socket.role === "ADMIN") {
      socket.join("admin_channel");
      try {
        const { calculateSidebarBadges } = require("../controllers/adminAuthController");
        if (typeof calculateSidebarBadges === "function") {
          calculateSidebarBadges().then((badges) => {
            socket.emit("sidebar_badges_update", badges);
          }).catch((err) => {
            console.error("Failed to send initial sidebar badges:", err.message);
          });
        }
      } catch (e) {}
    }

    // Explicit request from client to fetch sidebar badges via socket
    socket.on("get_sidebar_badges", async (callback) => {
      try {
        if (socket.role !== "SUPER_ADMIN") {
          if (typeof callback === "function") callback({ success: false, message: "Administrator role required." });
          return;
        }
        const { calculateSidebarBadges } = require("../controllers/adminAuthController");
        const badges = await calculateSidebarBadges();
        if (typeof callback === "function") {
          callback({ success: true, data: badges });
        } else {
          socket.emit("sidebar_badges_update", badges);
        }
      } catch (err) {
        if (typeof callback === "function") {
          callback({ success: false, message: err.message });
        }
      }
    });

    // ─────────────────────────────────────────────
    //  Check User Online / Offline Status
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
    //  Join Chat Room
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

        const isMember = room.members.some(
          (member) => member.refModel === socket.refModel && member.user.toString() === userIdStr
        );
        if (!isMember && socket.role !== "SUPER_ADMIN") {
          if (callback) callback({ success: false, message: "Access denied. You are not a member of this chat room." });
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
    //  Leave Chat Room
    // ─────────────────────────────────────────────
    socket.on("leave_room", (data) => {
      const { roomId } = typeof data === "string" ? { roomId: data } : data;
      if (roomId) {
        socket.leave(`room_${roomId}`);
      }
    });

    // ─────────────────────────────────────────────
    // Real-Time Send Message (Single/Double/Blue Ticks + Attachment Upload)
    // ─────────────────────────────────────────────
    socket.on("send_message", async (data, callback) => {
      const newUploads = [];
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

        const isMember = room.members.some(
          (member) => member.refModel === socket.refModel && member.user.toString() === userIdStr
        );
        if (!isMember && socket.role !== "SUPER_ADMIN") {
          if (callback) callback({ success: false, message: "Access denied. You are not a member of this chat room." });
          return;
        }

        if (typeof text !== 'undefined' && (typeof text !== 'string' || text.length > 10000)) throw new Error('Message is too long');
        if (attachments && (!Array.isArray(attachments) || attachments.length>5)) throw new Error('Maximum five attachments per message');
        // Process & Save Attachments (Buffer / Base64 / File object / Pre-uploaded URL)
        let processedAttachments = [];
        if (attachments && Array.isArray(attachments) && attachments.length > 0) {
          for (const att of attachments) {
            const saved = await saveSocketAttachment(att, socket, newUploads);
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

        populatedMsg.attachments = (populatedMsg.attachments || []).map(att=>({...att,url:canonicalMediaPath(att.url)?signMedia(canonicalMediaPath(att.url)):att.url}));
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

        // Update room timestamp and lastMessage
        const senderName = socket.user?.fullName || socket.user?.name || "User";
        room.lastMessage = {
          text: text || (processedAttachments.length > 0 ? "Attachment" : ""),
          sender: userIdStr,
          senderModel: socket.refModel,
          senderName,
          timestamp: new Date(),
          type: processedAttachments.length > 0 ? "ATTACHMENT" : "TEXT",
        };
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
        await removeUnpersistedUploads(newUploads);
        if (callback) callback({ success: false, message: err.message });
      }
    });

    // ─────────────────────────────────────────────
    //  Typing Indicator
    // ─────────────────────────────────────────────
    socket.on("typing", async (data) => {
      const { roomId, isTyping } = data || {};
      if (roomId) {
        try {
          const room = await ChatRoom.findById(roomId).select("members");
          const isMember = room?.members?.some(
            (member) => member.refModel === socket.refModel && member.user.toString() === userIdStr
          );
          if (!room || (!isMember && socket.role !== "SUPER_ADMIN")) return;
        } catch (e) {
          return;
        }
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
    //  Mark Read (Double Blue Tick)
    // ─────────────────────────────────────────────
    socket.on("mark_read", async (data, callback) => {
      try {
        const { roomId } = data || {};
        if (!roomId) return;

        const room = await ChatRoom.findById(roomId).select("members");
        if (!room) {
          if (callback) callback({ success: false, message: "Room not found" });
          return;
        }
        const isMember = room.members.some(
          (member) => member.refModel === socket.refModel && member.user.toString() === userIdStr
        );
        if (!isMember && socket.role !== "SUPER_ADMIN") {
          if (callback) callback({ success: false, message: "Access denied. You are not a member of this chat room." });
          return;
        }

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
    //  Full Class Broadcast (Coach ➔ All Class Parents)
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

        if (socket.role === "COACH") {
          const assigned = classData.coach?.toString() === userIdStr || classData.assistantCoach?.toString() === userIdStr;
          if (!assigned) {
            if (callback) callback({ success: false, message: "Access denied. You are not assigned to this class." });
            return;
          }
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
            scope: "CLASS",
            audience: "CLASS_PARENTS",
            scopeType: "CLASS",
            scopeLabel: `${classData.name} · Class chat`,
            audienceType: "PARENTS",
            recipientCount: parentIds.length,
            entityStatus: classData.status || "ACTIVE",
            classId,
            termId: classData.term || null,
            programId: classData.program || null,
            createdBy: userIdStr,
            participantPlayerIds: classData.players.map((player) => player._id),
            name: `${classData.name} - Class Broadcast`,
            members: [
              { refModel: "Admin", user: userIdStr },
              ...parentIds.map((pid) => ({ refModel: "Parent", user: pid })),
            ],
          });
        } else {
          const existing = broadcastRoom.members.map((member) => `${member.refModel}:${member.user.toString()}`);
          if (!existing.includes(`Admin:${userIdStr}`)) broadcastRoom.members.push({ refModel: "Admin", user: userIdStr });
          for (const parentId of parentIds) {
            if (!existing.includes(`Parent:${parentId}`)) broadcastRoom.members.push({ refModel: "Parent", user: parentId });
          }
          broadcastRoom.scope = broadcastRoom.scope || "CLASS";
          broadcastRoom.audience = broadcastRoom.audience || "CLASS_PARENTS";
          broadcastRoom.scopeType = "CLASS";
          broadcastRoom.scopeLabel = `${classData.name} · Class chat`;
          broadcastRoom.audienceType = "PARENTS";
          broadcastRoom.recipientCount = parentIds.length;
          broadcastRoom.entityStatus = classData.status || "ACTIVE";
          broadcastRoom.termId = broadcastRoom.termId || classData.term || null;
          broadcastRoom.programId = broadcastRoom.programId || classData.program || null;
          broadcastRoom.participantPlayerIds = classData.players.map((player) => player._id);
          await broadcastRoom.save();
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

        // Update broadcast room lastMessage
        const senderName = socket.user?.fullName || socket.user?.name || "Coach";
        broadcastRoom.lastMessage = {
          text: text || "",
          sender: userIdStr,
          senderModel: "Admin",
          senderName,
          timestamp: new Date(),
          type: "TEXT",
        };
        broadcastRoom.updatedAt = new Date();
        broadcastRoom.lastActivityAt = broadcastRoom.updatedAt;
        await broadcastRoom.save();

        if (callback) callback({ success: true, data: populatedMsg });
      } catch (err) {
        if (callback) callback({ success: false, message: err.message });
      }
    });

    // ─────────────────────────────────────────────
    //  Disconnect Handler
    // ─────────────────────────────────────────────
    socket.on("disconnect", () => {
      resources.get(socket.id)?.();
      resources.delete(socket.id);
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
const autoDeliverUnreadMessages = async (userId, refModel) => {
  try {
    const userRooms = await ChatRoom.find({
      members: { $elemMatch: { user: userId, refModel } },
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

async function closeSocket() {
  const instance = io;
  if (!instance) return;
  await closeSessionResources();
  await new Promise((resolve) => instance.close(resolve));
  if (io === instance) io = null;
  onlineUsersMap.clear();
}

/**
 * Broadcast updated sidebar badges to all connected admins
 */
const broadcastSidebarBadges = async () => {
  try {
    if (!io) return;
    const { calculateSidebarBadges } = require("../controllers/adminAuthController");
    if (typeof calculateSidebarBadges === "function") {
      const badges = await calculateSidebarBadges();
      io.to("admin_channel").emit("sidebar_badges_update", badges);
    }
  } catch (err) {
    console.error("broadcastSidebarBadges error:", err.message);
  }
};

module.exports = {
  initSocket,
  getIO,
  isUserOnline,
  getUserLastSeen,
  calculateTickStatus,
  broadcastSidebarBadges,
  closeSocket,
};
