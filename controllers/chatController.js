const ChatRoom = require("../models/ChatRoom");
const Message = require("../models/Message");

// ✅ Create or Get Direct Chat Room
exports.getOrCreateDirectRoom = async (req, res) => {
  try {
    const { targetUserId, targetModel } = req.body; // e.g. Admin/Parent ID

    if (!targetUserId || !targetModel) {
      return res.status(400).json({ success: false, message: "targetUserId and targetModel are required" });
    }

    const currentUserId = req.admin ? req.admin._id : (req.parent || req.user)?._id;
    const currentModel = req.admin ? "Admin" : "Parent";

    if (!currentUserId) {
      return res.status(401).json({ success: false, message: "Unauthorized access" });
    }

    // Try finding existing direct room with these exact two members
    let room = await ChatRoom.findOne({
      type: "DIRECT",
      members: {
        $all: [
          { $elemMatch: { refModel: currentModel, user: currentUserId } },
          { $elemMatch: { refModel: targetModel, user: targetUserId } },
        ],
      },
    });

    if (!room) {
      room = await ChatRoom.create({
        type: "DIRECT",
        members: [
          { refModel: currentModel, user: currentUserId },
          { refModel: targetModel, user: targetUserId },
        ],
      });
    }

    res.json({ success: true, data: room });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ✅ Send Message
exports.sendMessage = async (req, res) => {
  try {
    const { roomId, text, fileType } = req.body;

    if (!roomId) {
      return res.status(400).json({ success: false, message: "roomId is required" });
    }

    const room = await ChatRoom.findById(roomId);
    if (!room) {
      return res.status(404).json({ success: false, message: "Room not found" });
    }

    const currentUserId = req.admin ? req.admin._id : (req.parent || req.user)?._id;
    const currentModel = req.admin ? "Admin" : "Parent";

    if (!currentUserId) {
      return res.status(401).json({ success: false, message: "Unauthorized access" });
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

    res.status(201).json({ success: true, message: "Message sent", data: message });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ✅ Fetch Room Messages & Mark Read
exports.getRoomMessages = async (req, res) => {
  try {
    const { roomId } = req.params;
    const currentUserId = req.admin ? req.admin._id : (req.parent || req.user)?._id;

    if (!currentUserId) {
      return res.status(401).json({ success: false, message: "Unauthorized access" });
    }

    const messages = await Message.find({ room: roomId }).sort({ createdAt: 1 });

    // Mark other unread messages as read
    await Message.updateMany(
      { room: roomId, "readReceipts.user": { $ne: currentUserId } },
      { $push: { readReceipts: { user: currentUserId, readAt: new Date() } } }
    );

    res.json({ success: true, data: messages });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ✅ Fetch Chat Rooms list
exports.getMyRooms = async (req, res) => {
  try {
    const currentUserId = req.admin ? req.admin._id : (req.parent || req.user)?._id;
    const currentModel = req.admin ? "Admin" : "Parent";

    if (!currentUserId) {
      return res.status(401).json({ success: false, message: "Unauthorized access" });
    }

    const rooms = await ChatRoom.find({
      "members.user": currentUserId,
      "members.refModel": currentModel,
    }).populate("members.user", "name fullName email phone");

    res.json({ success: true, data: rooms });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
