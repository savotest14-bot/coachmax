const Document = require("../models/Document");
const User = require("../models/User");

// ✅ Upload Player Document (Parent only)
exports.uploadDocument = async (req, res) => {
  try {
    const { playerId, documentType } = req.body;

    if (!playerId || !documentType) {
      return res.status(400).json({ success: false, message: "playerId and documentType are required" });
    }

    if (!req.file) {
      return res.status(400).json({ success: false, message: "No document file was uploaded" });
    }

    // Verify parent owns the child
    const child = await User.findOne({ _id: playerId, parentId: req.parent._id });
    if (!child) {
      return res.status(403).json({ success: false, message: "Unauthorized child profile" });
    }

    const fileUrl = `uploads/documents/${req.file.filename}`;

    const doc = await Document.create({
      player: playerId,
      documentType,
      fileUrl,
    });

    res.status(201).json({
      success: true,
      message: "Document uploaded successfully",
      data: doc,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ✅ Fetch Child's Documents (Parent or Admin)
exports.getPlayerDocuments = async (req, res) => {
  try {
    const { playerId } = req.params;

    if (req.role === "PARENT") {
      const child = await User.findOne({ _id: playerId, parentId: req.parent._id });
      if (!child) {
        return res.status(403).json({ success: false, message: "Unauthorized child profile" });
      }
    }

    const docs = await Document.find({ player: playerId }).sort({ uploadedAt: -1 });

    res.json({ success: true, data: docs });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
