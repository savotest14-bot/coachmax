const ChatRoom = require("../models/ChatRoom");
const Message = require("../models/Message");
const Class = require("../models/Class");
const User = require("../models/User");
const AuditLog = require("../models/AuditLog");
const { sendNotification } = require("../services/notificationService");
const { getIO, isUserOnline, calculateTickStatus } = require("../sockets/chatSocket");

// ═══════════════════════════════════════════════
// FEATURE 6 — Parent & Coach Communication
// ═══════════════════════════════════════════════

/**
 * POST /api/coach/chat/direct or /api/user/chat/direct
 * Initiate or retrieve a direct chat room between parent and coach/admin.
 */
exports.startDirectChat = async (req, res) => {
  try {
    const currentUserId = req.admin ? req.admin._id : (req.parent || req.user)?._id;
    const currentModel = req.admin ? "Admin" : "Parent";

    if (!currentUserId) {
      return res.status(401).json({ success: false, message: "Unauthorized access" });
    }

    const { parentId, coachId, adminId, targetUserId, targetModel } = req.body;

    let otherId = targetUserId;
    let otherModel = targetModel;

    if (!otherId) {
      if (currentModel === "Admin") {
        otherId = parentId;
        otherModel = "Parent";
      } else {
        otherId = coachId || adminId;
        otherModel = "Admin";
      }
    }

    if (!otherId) {
      return res.status(400).json({
        success: false,
        message: currentModel === "Admin" ? "parentId is required" : "coachId or targetUserId is required",
      });
    }

    // Verify coach has access to this parent (child in assigned class)
    if (req.admin && req.admin.role === "COACH" && otherModel === "Parent") {
      const children = await User.find({ parentId: otherId }).select("_id");
      const childIds = children.map((c) => c._id);

      const assignedClasses = await Class.find({
        $or: [{ coach: currentUserId }, { assistantCoach: currentUserId }],
        players: { $in: childIds },
      }).select("_id");

      if (assignedClasses.length === 0) {
        return res.status(403).json({
          success: false,
          message: "Access denied. This parent's children are not in your assigned classes.",
        });
      }
    }

    // Find existing direct room
    let room = await ChatRoom.findOne({
      type: "DIRECT",
      members: {
        $all: [
          { $elemMatch: { refModel: currentModel, user: currentUserId } },
          { $elemMatch: { refModel: otherModel, user: otherId } },
        ],
      },
    });

    if (!room) {
      room = await ChatRoom.create({
        type: "DIRECT",
        members: [
          { refModel: currentModel, user: currentUserId },
          { refModel: otherModel, user: otherId },
        ],
      });
    }

    // Populate for response
    const populatedRoom = await ChatRoom.findById(room._id)
      .populate("members.user", "name fullName email phone profileImage");

    res.json({
      success: true,
      data: populatedRoom,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * POST /api/coach/chat/broadcast/:classId
 * Coach sends a broadcast message to all parents in a class.
 */
exports.sendClassBroadcast = async (req, res) => {
  try {
    if (!req.admin) {
      return res.status(403).json({
        success: false,
        message: "Access denied. Coach or Admin role required for broadcast.",
      });
    }

    const coachId = req.admin._id;
    const { classId } = req.params;
    const { text } = req.body;

    if (!text) {
      return res.status(400).json({
        success: false,
        message: "Message text is required",
      });
    }

    // Get class with players and their parents
    const classData = await Class.findById(classId)
      .populate({
        path: "players",
        select: "parentId fullName",
        populate: { path: "parentId", select: "_id fullName" },
      });

    if (!classData) {
      return res.status(404).json({ success: false, message: "Class not found" });
    }

    // Get unique parent IDs
    const parentIds = [...new Set(
      classData.players
        .filter((p) => p.parentId)
        .map((p) => p.parentId._id.toString())
    )];

    if (parentIds.length === 0) {
      return res.status(400).json({
        success: false,
        message: "No parents found for this class",
      });
    }

    // Find or create broadcast room for this class
    let broadcastRoom = await ChatRoom.findOne({
      type: "BROADCAST",
      classId: classId,
    });

    if (!broadcastRoom) {
      const members = [
        { refModel: "Admin", user: coachId },
        ...parentIds.map((pid) => ({ refModel: "Parent", user: pid })),
      ];

      broadcastRoom = await ChatRoom.create({
        type: "BROADCAST",
        classId: classId,
        name: `${classData.name} - Class Broadcast`,
        members,
      });
    } else {
      // Update members to include any new parents
      const existingMemberIds = broadcastRoom.members.map((m) => m.user.toString());

      for (const pid of parentIds) {
        if (!existingMemberIds.includes(pid)) {
          broadcastRoom.members.push({ refModel: "Parent", user: pid });
        }
      }

      // Ensure coach is in members
      if (!existingMemberIds.includes(coachId.toString())) {
        broadcastRoom.members.push({ refModel: "Admin", user: coachId });
      }

      await broadcastRoom.save();
    }

    // Create the broadcast message
    const message = await Message.create({
      room: broadcastRoom._id,
      sender: { refModel: "Admin", user: coachId },
      text,
      readReceipts: [{ user: coachId, readAt: new Date() }],
    });

    // Notify all parents
    const coachName = req.admin.name || req.admin.fullName || "Coach";
    for (const pid of parentIds) {
      sendNotification({
        recipientType: "PARENT",
        parentId: pid,
        title: "Class Broadcast",
        message: `Coach ${coachName}: ${text.substring(0, 100)}${text.length > 100 ? "..." : ""}`,
        type: "CLASS_BROADCAST",
        data: {
          roomId: broadcastRoom._id.toString(),
          classId,
          messageId: message._id.toString(),
        },
      }).catch((e) => console.error("Broadcast push error:", e.message));
    }

    res.status(201).json({
      success: true,
      message: "Broadcast message sent successfully",
      data: {
        room: broadcastRoom,
        message,
        recipientCount: parentIds.length,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * POST /api/coach/chat/message or /api/user/chat/message/send
 * User (Coach/Admin or Parent) sends a message in a chat room.
 */
exports.sendMessage = async (req, res) => {
  try {
    const currentUserId = req.admin ? req.admin._id : (req.parent || req.user)?._id;
    const currentModel = req.admin ? "Admin" : "Parent";

    if (!currentUserId) {
      return res.status(401).json({ success: false, message: "Unauthorized access" });
    }

    const { roomId, text, fileType } = req.body;

    if (!roomId) {
      return res.status(400).json({
        success: false,
        message: "roomId is required",
      });
    }

    const room = await ChatRoom.findById(roomId);
    if (!room) {
      return res.status(404).json({ success: false, message: "Chat room not found" });
    }

    // Verify user is a member of this room (Super Admin bypasses)
    const isMember = room.members.some(
      (m) => m.user.toString() === currentUserId.toString() && m.refModel === currentModel
    );

    if (!isMember && (!req.admin || req.admin.role !== "SUPER_ADMIN")) {
      return res.status(403).json({
        success: false,
        message: "Access denied. You are not a member of this chat room.",
      });
    }

    let attachments = [];
    if (req.file) {
      attachments = [{ fileType: fileType || "FILE", url: `uploads/chat/${req.file.filename}` }];
    }

    // Check if recipient is online for Double Gray Tick (DELIVERED)
    const recipientMembers = room.members.filter(
      (m) => m.user.toString() !== currentUserId.toString()
    );
    let isDelivered = false;

    const deliveredTo = [];
    for (const rm of recipientMembers) {
      if (isUserOnline(rm.user.toString())) {
        isDelivered = true;
        deliveredTo.push({ user: rm.user, deliveredAt: new Date() });
      }
    }

    const message = await Message.create({
      room: roomId,
      sender: { refModel: currentModel, user: currentUserId },
      text: text || "",
      attachments,
      status: isDelivered ? "DELIVERED" : "SENT",
      deliveredTo,
      readReceipts: [{ user: currentUserId, readAt: new Date() }],
    });

    room.updatedAt = new Date();
    await room.save();

    const populatedMessage = await Message.findById(message._id)
      .populate("sender.user", "name fullName email profileImage")
      .lean();

    populatedMessage.tickStatus = calculateTickStatus(populatedMessage, currentUserId);

    // Emit live Socket message if active
    try {
      const io = getIO();
      if (io) {
        io.to(`room_${roomId}`).emit("new_message", {
          roomId,
          message: populatedMessage,
        });
      }
    } catch (e) {
      // Socket silent
    }

    // Send push notifications to offline recipients
    const senderName = req.admin
      ? (req.admin.name || req.admin.fullName || "Coach")
      : ((req.parent || req.user)?.fullName || "Parent");

    for (const rm of recipientMembers) {
      if (!isUserOnline(rm.user.toString())) {
        if (rm.refModel === "Parent") {
          sendNotification({
            recipientType: "PARENT",
            parentId: rm.user,
            title: `New Message from ${senderName} 💬`,
            message: `${text ? text.substring(0, 100) : "Attachment sent"}`,
            type: "PARENT_MESSAGE",
            data: { roomId, messageId: message._id.toString() },
          }).catch((e) => console.error("Push error:", e.message));
        } else if (rm.refModel === "Admin") {
          sendNotification({
            recipientType: "ADMIN",
            adminId: rm.user,
            title: `New Message from ${senderName} 💬`,
            message: `${text ? text.substring(0, 100) : "Attachment sent"}`,
            type: "PARENT_MESSAGE",
            data: { roomId, messageId: message._id.toString() },
          }).catch((e) => console.error("Push error:", e.message));
        }
      }
    }

    res.status(201).json({
      success: true,
      message: "Message sent",
      data: populatedMessage,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * GET /api/coach/chat/rooms or /api/user/chat/rooms
 * User (Coach/Admin or Parent) views their chat rooms.
 */
exports.getMyRooms = async (req, res) => {
  try {
    const currentUserId = req.admin ? req.admin._id : (req.parent || req.user)?._id;
    const currentModel = req.admin ? "Admin" : "Parent";

    if (!currentUserId) {
      return res.status(401).json({ success: false, message: "Unauthorized access" });
    }

    let { page = 1, limit = 20 } = req.query;

    page = Number(page);
    limit = Number(limit);

    const query = {
      "members.user": currentUserId,
      "members.refModel": currentModel,
    };

    // Super Admin can see all rooms if specified
    if (req.admin && req.admin.role === "SUPER_ADMIN") {
      delete query["members.user"];
      delete query["members.refModel"];
    }

    const total = await ChatRoom.countDocuments(query);

    const rooms = await ChatRoom.find(query)
      .populate("members.user", "name fullName email phone profileImage")
      .populate("classId", "name")
      .sort({ updatedAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit);

    // Get last message for each room
    const roomsWithLastMessage = await Promise.all(
      rooms.map(async (room) => {
        const lastMessage = await Message.findOne({ room: room._id })
          .sort({ createdAt: -1 })
          .select("text sender createdAt status readReceipts deliveredTo")
          .lean();

        if (lastMessage) {
          lastMessage.tickStatus = calculateTickStatus(lastMessage, currentUserId);
        }

        // Count unread messages
        const unreadCount = await Message.countDocuments({
          room: room._id,
          "readReceipts.user": { $ne: currentUserId },
        });

        // Online status of recipient
        const partner = room.members.find(
          (m) => m.user?._id?.toString() !== currentUserId.toString()
        );
        const isPartnerOnline = partner ? isUserOnline(partner.user?._id) : false;

        return {
          ...room.toObject(),
          lastMessage,
          unreadCount,
          isPartnerOnline,
        };
      })
    );

    res.json({
      success: true,
      total,
      page,
      limit,
      data: roomsWithLastMessage,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * GET /api/coach/chat/room/:roomId/messages or /api/user/chat/room/:roomId/messages
 * Get messages for a room with pagination. Marks as read (Double Blue Tick).
 */
exports.getRoomMessages = async (req, res) => {
  try {
    const currentUserId = req.admin ? req.admin._id : (req.parent || req.user)?._id;

    if (!currentUserId) {
      return res.status(401).json({ success: false, message: "Unauthorized access" });
    }

    const { roomId } = req.params;
    let { page = 1, limit = 50 } = req.query;

    page = Number(page);
    limit = Number(limit);

    // Verify membership (Super Admin bypasses)
    if (!req.admin || req.admin.role !== "SUPER_ADMIN") {
      const room = await ChatRoom.findById(roomId);
      if (!room) {
        return res.status(404).json({ success: false, message: "Room not found" });
      }

      const isMember = room.members.some(
        (m) => m.user.toString() === currentUserId.toString()
      );

      if (!isMember) {
        return res.status(403).json({
          success: false,
          message: "Access denied. You are not a member of this chat room.",
        });
      }
    }

    const total = await Message.countDocuments({ room: roomId });

    // Mark unread messages as READ (Double Blue Tick)
    const unreadMsgs = await Message.find({
      room: roomId,
      "readReceipts.user": { $ne: currentUserId },
    }).select("_id");

    if (unreadMsgs.length > 0) {
      const unreadIds = unreadMsgs.map((m) => m._id);

      await Message.updateMany(
        { _id: { $in: unreadIds } },
        {
          $set: { status: "READ" },
          $push: { readReceipts: { user: currentUserId, readAt: new Date() } },
        }
      );

      // Socket notification for double blue tick update
      try {
        const io = getIO();
        if (io) {
          io.to(`room_${roomId}`).emit("messages_read", {
            roomId,
            readBy: currentUserId.toString(),
            readAt: new Date(),
            messageIds: unreadIds,
            status: "READ", // Double Blue Tick
          });
        }
      } catch (e) {
        // Socket silent
      }
    }

    const messages = await Message.find({ room: roomId })
      .populate("sender.user", "name fullName email profileImage")
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    // Attach calculated tick status to each message
    const formattedMessages = messages.map((m) => ({
      ...m,
      tickStatus: calculateTickStatus(m, m.sender?.user?._id || m.sender?.user),
    }));

    res.json({
      success: true,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      data: formattedMessages.reverse(), // Return in chronological order
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * GET /api/admin/chat/conversations
 * Super Admin views all coach-parent conversations for safeguarding.
 */
exports.getAllConversations = async (req, res) => {
  try {
    let { page = 1, limit = 20, search, coachId } = req.query;

    page = Number(page);
    limit = Number(limit);

    const query = {};

    if (coachId) {
      query["members.user"] = coachId;
      query["members.refModel"] = "Admin";
    }

    const total = await ChatRoom.countDocuments(query);

    const rooms = await ChatRoom.find(query)
      .populate("members.user", "name fullName email phone")
      .populate("classId", "name")
      .sort({ updatedAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit);

    // Enrich with last message and message count
    const enrichedRooms = await Promise.all(
      rooms.map(async (room) => {
        const lastMessage = await Message.findOne({ room: room._id })
          .sort({ createdAt: -1 })
          .select("text sender createdAt")
          .lean();

        const messageCount = await Message.countDocuments({ room: room._id });

        return {
          ...room.toObject(),
          lastMessage,
          messageCount,
        };
      })
    );

    res.json({
      success: true,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      data: enrichedRooms,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * GET /api/coach/chat/class/:classId/parents
 * Get list of parents in a class that the coach can message.
 * Phone numbers are hidden — only shows names and email.
 */
exports.getClassParents = async (req, res) => {
  try {
    const { classId } = req.params;

    const classData = await Class.findById(classId)
      .populate({
        path: "players",
        select: "fullName parentId",
        populate: {
          path: "parentId",
          select: "fullName email profileImage", // No phone number exposed
        },
      });

    if (!classData) {
      return res.status(404).json({ success: false, message: "Class not found" });
    }

    // Get unique parents
    const parentMap = new Map();
    classData.players.forEach((p) => {
      if (p.parentId && !parentMap.has(p.parentId._id.toString())) {
        parentMap.set(p.parentId._id.toString(), {
          _id: p.parentId._id,
          fullName: p.parentId.fullName,
          email: p.parentId.email,
          profileImage: p.parentId.profileImage,
          children: [],
        });
      }
      if (p.parentId) {
        parentMap.get(p.parentId._id.toString()).children.push({
          _id: p._id,
          fullName: p.fullName,
        });
      }
    });

    res.json({
      success: true,
      data: Array.from(parentMap.values()),
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
