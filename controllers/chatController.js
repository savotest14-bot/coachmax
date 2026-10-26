const ChatRoom = require("../models/ChatRoom");
const Message = require("../models/Message");
const User = require("../models/User");
const Parent = require("../models/Parent");
const Admin = require("../models/Admin");
const {
  getActor,
  isRoomMember,
  conversationResponse,
  normalizeRoomScope,
  validObjectId,
} = require("../utils/chatRoom");

exports.getOrCreateDirectRoom = async (req, res) => {
  try {
    const { targetUserId, targetModel, classId, termId, programId } = req.body;

    if (!targetUserId || !targetModel || !["Parent", "Admin"].includes(targetModel)) {
      return res.status(400).json({ success: false, message: "targetUserId and targetModel are required" });
    }

    if (!validObjectId(targetUserId)) {
      return res.status(400).json({ success: false, message: "targetUserId must be a valid id" });
    }
    const targetExists = targetModel === "Parent"
      ? await Parent.exists({ _id: targetUserId })
      : await Admin.exists({ _id: targetUserId, isActive: { $ne: false } });
    if (!targetExists) return res.status(404).json({ success: false, message: "Target user not found" });

    const currentUserId = req.admin ? req.admin._id : (req.parent || req.user)?._id;
    const currentModel = req.admin ? "Admin" : "Parent";

    if (!currentUserId) {
      return res.status(401).json({ success: false, message: "Unauthorized access" });
    }

    const scopedQuery = {
      type: "DIRECT",
      members: {
        $all: [
          { $elemMatch: { refModel: currentModel, user: currentUserId } },
          { $elemMatch: { refModel: targetModel, user: targetUserId } },
        ],
      },
    };
    if (classId && validObjectId(classId)) scopedQuery.classId = classId;
    if (termId && validObjectId(termId)) scopedQuery.termId = termId;
    if (programId && validObjectId(programId)) scopedQuery.programId = programId;

    let room = await ChatRoom.findOne(scopedQuery);

    if (!room) {
      room = await ChatRoom.create({
        type: "DIRECT",
        scope: "DIRECT",
        audience: "PARENT_COACH",
        scopeType: "DIRECT",
        audienceType: "DIRECT",
        scopeLabel: "Direct conversation",
        classId: validObjectId(classId) ? classId : null,
        termId: validObjectId(termId) ? termId : null,
        programId: validObjectId(programId) ? programId : null,
        createdBy: req.admin?._id || null,
        members: [
          { refModel: currentModel, user: currentUserId },
          { refModel: targetModel, user: targetUserId },
        ],
      });
    }

    const populatedRoom = await ChatRoom.findById(room._id)
      .populate("members.user", "name fullName email phone profileImage role")
      .populate("classId", "name term program category")
      .populate("eventId", "title eventType startDate endDate status")
      .populate("teamId", "teamName logo")
      .populate("leagueId", "name season logo")
      .populate("programId", "name ageGroup")
      .populate("termId", "name year startDate endDate");
    res.json({ success: true, data: conversationResponse(populatedRoom, { currentUserId }) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

exports.sendMessage = async (req, res) => {
  try {
    const { roomId, text, fileType } = req.body;

    if (!roomId) {
      return res.status(400).json({ success: false, message: "roomId is required" });
    }

    const room = await ChatRoom.findById(roomId)
      .populate("termId", "status")
      .populate("eventId", "status");
    if (!room) {
      return res.status(404).json({ success: false, message: "Room not found" });
    }

    const currentUserId = req.admin ? req.admin._id : (req.parent || req.user)?._id;
    const currentModel = req.admin ? "Admin" : "Parent";

    if (!currentUserId) {
      return res.status(401).json({ success: false, message: "Unauthorized access" });
    }

    const actor = getActor(req);
    if (!isRoomMember(room, actor) && actor?.role !== "SUPER_ADMIN") {
      return res.status(403).json({ success: false, message: "Access denied. You are not a member of this chat room." });
    }
    if (room.isActive === false || room.entityStatus === "COMPLETED" || room.termId?.status === "COMPLETED" || room.eventId?.status === "COMPLETED") {
      return res.status(409).json({ success: false, message: "This chat is closed because its term or event has finished" });
    }

    let attachments = [];
    if (req.file) {
      attachments = [{ fileType: fileType || "FILE", url: `uploads/chat/${req.file.filename}` }];
    }

    const message = await Message.create({
      room: roomId,
      sender: { refModel: currentModel, user: currentUserId },
      text: text || "",
      attachments,
      readReceipts: [{ user: currentUserId, readAt: new Date() }],
    });

    const senderName = req.admin?.name || req.admin?.fullName || req.parent?.fullName || "User";
    room.lastMessage = {
      text: text || (attachments.length > 0 ? "Attachment" : ""),
      sender: currentUserId,
      senderModel: currentModel,
      senderName,
      timestamp: new Date(),
      type: attachments.length > 0 ? "ATTACHMENT" : "TEXT",
    };
    room.updatedAt = new Date();
    room.lastActivityAt = room.updatedAt;
    await room.save();

    res.status(201).json({ success: true, message: "Message sent", data: message });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

exports.getRoomMessages = async (req, res) => {
  try {
    const { roomId } = req.params;
    const currentUserId = req.admin ? req.admin._id : (req.parent || req.user)?._id;

    if (!currentUserId) {
      return res.status(401).json({ success: false, message: "Unauthorized access" });
    }

    const room = await ChatRoom.findById(roomId).select("members type scope classId eventId teamId leagueId programId");
    if (!room) return res.status(404).json({ success: false, message: "Room not found" });
    const actor = getActor(req);
    if (!isRoomMember(room, actor) && actor?.role !== "SUPER_ADMIN") {
      return res.status(403).json({ success: false, message: "Access denied. You are not a member of this chat room." });
    }

    const messages = await Message.find({ room: roomId }).sort({ createdAt: 1 });

    await Message.updateMany(
      { room: roomId, "readReceipts.user": { $ne: currentUserId } },
      { $push: { readReceipts: { user: currentUserId, readAt: new Date() } } }
    );

    res.json({ success: true, data: messages });
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

    const { type, scope, search, page = 1, limit = 50 } = req.query;
    const pageNumber = Math.max(1, Number(page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(limit) || 50));
    const selectedType = type;
    const isAdminHistoryViewer = Boolean(
      req.admin && ["SUPER_ADMIN", "ADMIN"].includes(String(req.admin.role || "").toUpperCase())
    );
    const query = isAdminHistoryViewer
      ? {}
      : {
        "members.user": currentUserId,
        "members.refModel": currentModel,
        isActive: { $ne: false },
      };

    if (selectedType) {
      query.type = selectedType.toUpperCase();
    } else if (scope) {
      query.scope = scope.toUpperCase();
    }

    // Parents only see rooms for their children's current terms. Admin history
    // viewers intentionally bypass this filter so completed terms remain
    // available in the admin communication centre.
    if (currentModel === "Parent") {
      const termIds = await User.distinct("term", { parentId: currentUserId, term: { $ne: null } });
      const legacyDirectRoom = {
        termId: null,
        scopeType: "DIRECT",
        classId: null,
        teamId: null,
        eventId: null,
      };
      query.$or = termIds.length
        ? [{ termId: { $in: termIds } }, legacyDirectRoom]
        : [legacyDirectRoom];
    }

    let rooms = await ChatRoom.find(query)
      .populate("members.user", "name fullName email phone profileImage role")
      .populate("classId", "name term program category")
      .populate("eventId", "title eventType startDate endDate")
      .populate("teamId", "teamName logo")
      .populate("leagueId", "name season logo")
      .populate("programId", "name ageGroup")
      .populate("termId", "name year startDate endDate status")
      .sort({ lastActivityAt: -1, updatedAt: -1 });

    // A completed term/event is closed for parents and coaches. Admin history
    // viewers intentionally keep those rooms available for audit and support.
    if (!isAdminHistoryViewer) {
      rooms = rooms.filter((room) => {
        const termStatus = typeof room.termId === "object" ? room.termId?.status : null;
        const eventStatus = typeof room.eventId === "object" ? room.eventId?.status : null;
        return room.isActive !== false && room.entityStatus !== "COMPLETED" && termStatus !== "COMPLETED" && eventStatus !== "COMPLETED";
      });
    }

    if (search) {
      const searchRegex = new RegExp(search, "i");
      rooms = rooms.filter((room) => {
        if (room.name && searchRegex.test(room.name)) {
          return true;
        }
        return room.members.some((member) => {
          if (!member.user || member.user._id.toString() === currentUserId.toString()) {
            return false;
          }
          const user = member.user;
          return (
            (user.name && searchRegex.test(user.name)) ||
            (user.fullName && searchRegex.test(user.fullName)) ||
            (user.email && searchRegex.test(user.email)) ||
            (user.phone && searchRegex.test(user.phone))
          );
        });
      });
    }

    const total = rooms.length;
    const pagedRooms = rooms.slice((pageNumber - 1) * pageSize, pageNumber * pageSize);
    const normalized = await Promise.all(pagedRooms.map(async (room) => {
      const unreadCount = await Message.countDocuments({ room: room._id, "readReceipts.user": { $ne: currentUserId } });
      const lastMessage = await Message.findOne({ room: room._id })
        .sort({ createdAt: -1 })
        .select("text attachments sender createdAt status readReceipts deliveredTo")
        .lean();
      return conversationResponse(room, { currentUserId, unreadCount, lastMessage });
    }));

    res.json({ success: true, total, page: pageNumber, limit: pageSize, totalPages: Math.ceil(total / pageSize), data: normalized });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
