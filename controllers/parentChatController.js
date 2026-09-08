const ChatRoom = require("../models/ChatRoom");
const Message = require("../models/Message");
const Class = require("../models/Class");
const User = require("../models/User");
const AuditLog = require("../models/AuditLog");
const Admin = require("../models/Admin");
const Parent = require("../models/Parent");
const mongoose = require("mongoose");
const fs = require("fs");
const path = require("path");
const { sendNotification } = require("../services/notificationService");
const { getIO, isUserOnline, calculateTickStatus } = require("../sockets/chatSocket");

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

exports.sendClassBroadcast = async (req, res) => {
  try {
    if (!req.admin) {
      return res.status(403).json({
        success: false,
        message: "Access denied. Coach or Admin role required for broadcast.",
      });
    }

    const coachId = req.admin._id;
    const paramClassId = req.params.classId;
    const { text } = req.body;

    if (!text) {
      return res.status(400).json({
        success: false,
        message: "Message text is required",
      });
    }

    let queryClasses = [];

    if (paramClassId && mongoose.Types.ObjectId.isValid(paramClassId)) {
      queryClasses = [paramClassId];
    } else {
      const filter = { status: "ACTIVE" };
      if (req.admin.role === "COACH") {
        filter.$and = filter.$and || [];
        filter.$and.push({
          $or: [
            { coach: coachId },
            { assistantCoach: coachId },
          ]
        });
      }

      const bodyClassId = req.body.classId;
      const bodyTerm = req.body.term;
      const bodyCategory = req.body.category;
      const bodyProgram = req.body.program;
      const bodyDay = req.body.day || req.body.dayOfWeek;

      if (bodyClassId && mongoose.Types.ObjectId.isValid(bodyClassId)) {
        filter._id = bodyClassId;
      }
      if (bodyTerm) {
        filter.term = bodyTerm;
      }
      if (bodyCategory) {
        filter.category = bodyCategory;
      }
      if (bodyProgram) {
        filter.program = bodyProgram;
      }
      if (bodyDay) {
        filter.$and = filter.$and || [];
        filter.$and.push({
          $or: [
            { dayOfWeek: { $regex: new RegExp(`^${bodyDay}$`, "i") } },
            { "schedule.dayOfWeek": { $regex: new RegExp(`^${bodyDay}$`, "i") } },
          ]
        });
      }

      const matchedClasses = await Class.find(filter).select("_id");
      queryClasses = matchedClasses.map(c => c._id);
    }

    if (queryClasses.length === 0) {
      return res.status(404).json({
        success: false,
        message: "No active classes found matching the criteria",
      });
    }

    const classesData = await Class.find({ _id: { $in: queryClasses } })
      .populate({
        path: "players",
        select: "parentId fullName",
        populate: { path: "parentId", select: "_id fullName" },
      });

    let successCount = 0;
    let totalRecipientCount = 0;
    const broadcastRooms = [];
    const messages = [];

    const coachName = req.admin.name || req.admin.fullName || "Coach";

    for (const classData of classesData) {
      const parentIds = [...new Set(
        classData.players
          .filter((p) => p.parentId)
          .map((p) => p.parentId._id.toString())
      )];

      if (parentIds.length === 0) {
        continue;
      }

      let broadcastRoom = await ChatRoom.findOne({
        type: "BROADCAST",
        classId: classData._id,
      });

      if (!broadcastRoom) {
        const members = [
          { refModel: "Admin", user: coachId },
          ...parentIds.map((pid) => ({ refModel: "Parent", user: pid })),
        ];

        broadcastRoom = await ChatRoom.create({
          type: "BROADCAST",
          classId: classData._id,
          name: `${classData.name} - Class Broadcast`,
          members,
        });
      } else {
        const existingMemberIds = broadcastRoom.members.map((m) => m.user.toString());

        for (const pid of parentIds) {
          if (!existingMemberIds.includes(pid)) {
            broadcastRoom.members.push({ refModel: "Parent", user: pid });
          }
        }

        if (!existingMemberIds.includes(coachId.toString())) {
          broadcastRoom.members.push({ refModel: "Admin", user: coachId });
        }

        await broadcastRoom.save();
      }

      const message = await Message.create({
        room: broadcastRoom._id,
        sender: { refModel: "Admin", user: coachId },
        text,
        readReceipts: [{ user: coachId, readAt: new Date() }],
      });

      broadcastRoom.lastMessage = {
        text: text || "",
        sender: coachId,
        senderModel: "Admin",
        senderName: coachName,
        timestamp: new Date(),
        type: "TEXT",
      };
      broadcastRoom.updatedAt = new Date();
      await broadcastRoom.save();
      for (const pid of parentIds) {
        sendNotification({
          recipientType: "PARENT",
          parentId: pid,
          title: "Class Broadcast",
          message: `Coach ${coachName}: ${text.substring(0, 100)}${text.length > 100 ? "..." : ""}`,
          type: "CLASS_BROADCAST",
          data: {
            roomId: broadcastRoom._id.toString(),
            classId: classData._id.toString(),
            messageId: message._id.toString(),
          },
        }).catch((e) => console.error("Broadcast push error:", e.message));
      }

      successCount++;
      totalRecipientCount += parentIds.length;
      broadcastRooms.push(broadcastRoom);
      messages.push(message);
    }

    if (successCount === 0) {
      return res.status(400).json({
        success: false,
        message: "No parents found for any of the matched classes",
      });
    }

    res.status(201).json({
      success: true,
      message: `Broadcast message sent to ${successCount} class(es) successfully`,
      data: {
        broadcastRoomsCount: successCount,
        recipientCount: totalRecipientCount,
        rooms: broadcastRooms,
        messages,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

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

    const lastMsgSenderName = req.admin?.name || req.admin?.fullName || req.parent?.fullName || "User";
    room.lastMessage = {
      text: text || (attachments.length > 0 ? "Attachment" : ""),
      sender: currentUserId,
      senderModel: currentModel,
      senderName: lastMsgSenderName,
      timestamp: new Date(),
      type: attachments.length > 0 ? "ATTACHMENT" : "TEXT",
    };
    room.updatedAt = new Date();
    await room.save();

    const populatedMessage = await Message.findById(message._id)
      .populate("sender.user", "name fullName email profileImage")
      .lean();

    populatedMessage.tickStatus = calculateTickStatus(populatedMessage, currentUserId);

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

    const roomsWithLastMessage = await Promise.all(
      rooms.map(async (room) => {
        const lastMessage = await Message.findOne({ room: room._id })
          .sort({ createdAt: -1 })
          .select("text sender createdAt status readReceipts deliveredTo")
          .lean();

        if (lastMessage) {
          lastMessage.tickStatus = calculateTickStatus(lastMessage, currentUserId);
        }
        const unreadCount = await Message.countDocuments({
          room: room._id,
          "readReceipts.user": { $ne: currentUserId },
        });

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

      try {
        const io = getIO();
        if (io) {
          io.to(`room_${roomId}`).emit("messages_read", {
            roomId,
            readBy: currentUserId.toString(),
            readAt: new Date(),
            messageIds: unreadIds,
            status: "READ", 
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
      data: formattedMessages.reverse(), 
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

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

exports.getClassParents = async (req, res) => {
  try {
    const { classId } = req.params;

    const classData = await Class.findById(classId)
      .populate({
        path: "players",
        select: "fullName parentId",
        populate: {
          path: "parentId",
          select: "fullName email profileImage",
        },
      });

    if (!classData) {
      return res.status(404).json({ success: false, message: "Class not found" });
    }

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

exports.deleteSingleMessage = async (req, res) => {
  try {
    const { messageId } = req.params;
    const adminId = req.admin ? req.admin._id : null;

    if (!mongoose.Types.ObjectId.isValid(messageId)) {
      return res.status(400).json({ success: false, message: "Invalid message ID" });
    }

    const message = await Message.findById(messageId);
    if (!message) {
      return res.status(404).json({ success: false, message: "Message not found" });
    }

    const roomId = message.room;

    if (message.attachments && Array.isArray(message.attachments)) {
      message.attachments.forEach((att) => {
        if (att.url && att.url.startsWith("/uploads/")) {
          const filePath = path.join(__dirname, "..", att.url);
          if (fs.existsSync(filePath)) {
            try {
              fs.unlinkSync(filePath);
            } catch (e) { }
          }
        }
      });
    }

    await Message.findByIdAndDelete(messageId);

    if (adminId) {
      await AuditLog.create({
        user: adminId,
        userRole: req.admin?.role || "SUPER_ADMIN",
        action: "MESSAGE_DELETED",
        entityType: "Message",
        entityId: messageId,
        ipAddress: req.ip || "",
        deviceInfo: req.headers["user-agent"] || "",
        description: `Admin deleted message ${messageId} from room ${roomId}`,
      });
    }

    if (roomId) {
      const remainingLatestMsg = await Message.findOne({ room: roomId }).sort({
        createdAt: -1,
      });

      if (remainingLatestMsg) {
        const senderObj = remainingLatestMsg.sender || {};
        let senderName = "";

        if (senderObj.refModel === "Admin") {
          const adminDoc = await Admin.findById(senderObj.user).select("name");
          senderName = adminDoc ? adminDoc.name : "Admin";
        } else if (senderObj.refModel === "Parent") {
          const parentDoc = await Parent.findById(senderObj.user).select("fullName");
          senderName = parentDoc ? parentDoc.fullName : "Parent";
        }

        await ChatRoom.findByIdAndUpdate(roomId, {
          lastMessage: {
            text: remainingLatestMsg.text || "",
            sender: senderObj.user || null,
            senderModel: senderObj.refModel || "Admin",
            senderName,
            timestamp: remainingLatestMsg.createdAt,
            type:
              remainingLatestMsg.attachments &&
                remainingLatestMsg.attachments.length > 0
                ? "ATTACHMENT"
                : "TEXT",
          },
        });
      } else {
        await ChatRoom.findByIdAndUpdate(roomId, {
          lastMessage: {
            text: "",
            sender: null,
            senderModel: null,
            senderName: "",
            timestamp: null,
            type: "TEXT",
          },
        });
      }

      try {
        const io = getIO();
        if (io) {
          io.to(`room_${roomId}`).emit("message_deleted", { messageId, roomId });
        }
      } catch (sErr) { }
    }

    return res.status(200).json({
      success: true,
      message: "Message deleted permanently",
      data: { messageId, roomId },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

exports.deleteFullChatRoom = async (req, res) => {
  try {
    const { roomId } = req.params;
    const adminId = req.admin ? req.admin._id : null;

    if (!mongoose.Types.ObjectId.isValid(roomId)) {
      return res.status(400).json({ success: false, message: "Invalid chat room ID" });
    }

    const room = await ChatRoom.findById(roomId);
    if (!room) {
      return res.status(404).json({ success: false, message: "Chat room not found" });
    }

    const messages = await Message.find({ room: roomId });

    messages.forEach((msg) => {
      if (msg.attachments && Array.isArray(msg.attachments)) {
        msg.attachments.forEach((att) => {
          if (att.url && att.url.startsWith("/uploads/")) {
            const filePath = path.join(__dirname, "..", att.url);
            if (fs.existsSync(filePath)) {
              try {
                fs.unlinkSync(filePath);
              } catch (e) { }
            }
          }
        });
      }
    });

    const deleteResult = await Message.deleteMany({ room: roomId });

    await ChatRoom.findByIdAndDelete(roomId);

    if (adminId) {
      await AuditLog.create({
        user: adminId,
        userRole: req.admin?.role || "SUPER_ADMIN",
        action: "CHAT_ROOM_DELETED",
        entityType: "ChatRoom",
        entityId: roomId,
        ipAddress: req.ip || "",
        deviceInfo: req.headers["user-agent"] || "",
        description: `Admin deleted chat room ${roomId} and ${deleteResult.deletedCount || 0} message(s)`,
      });
    }
    try {
      const io = getIO();
      if (io) {
        io.to(`room_${roomId}`).emit("chat_room_deleted", { roomId });
      }
    } catch (sErr) { }

    return res.status(200).json({
      success: true,
      message: "Full chat room and all messages deleted permanently",
      data: {
        roomId,
        deletedMessagesCount: deleteResult.deletedCount || 0,
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};
