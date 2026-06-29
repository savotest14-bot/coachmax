const TrainingSession = require("../models/TrainingSession");
const Class = require("../models/Class");
const User = require("../models/User");

// ✅ Create training session (Admin/Coach only)
exports.createTrainingSession = async (req, res) => {
  try {
    const { classId, date, title, objectives, notes, completionStatus } = req.body;

    if (!classId || !date || !title) {
      return res.status(400).json({ success: false, message: "classId, date, and title are required" });
    }

    const cls = await Class.findById(classId);
    if (!cls) {
      return res.status(404).json({ success: false, message: "Class not found" });
    }

    const normalizedDate = new Date(date);
    normalizedDate.setUTCHours(0, 0, 0, 0);

    let sessionAttachments = [];
    if (req.files) {
      sessionAttachments = req.files.map((file) => `uploads/training/${file.filename}`);
    } else if (req.file) {
      sessionAttachments = [`uploads/training/${req.file.filename}`];
    }

    const session = await TrainingSession.create({
      class: classId,
      coach: req.admin._id,
      date: normalizedDate,
      title,
      objectives,
      notes,
      attachments: sessionAttachments,
      completionStatus,
    });

    res.status(201).json({
      success: true,
      message: "Training session created successfully",
      data: session,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ✅ Get sessions list for a class (Parent, Coach, Admin)
exports.getClassTrainingSessions = async (req, res) => {
  try {
    const { classId } = req.params;

    const cls = await Class.findById(classId);
    if (!cls) {
      return res.status(404).json({ success: false, message: "Class not found" });
    }

    // Verify parent's children enrollment in class
    if (req.role === "PARENT") {
      const childCount = await User.countDocuments({
        parentId: req.parent._id,
        assignedClasses: classId,
      });
      if (childCount === 0) {
        return res.status(403).json({ success: false, message: "Unauthorized class session access" });
      }
    }

    const sessions = await TrainingSession.find({ class: classId })
      .populate("coach", "name email")
      .sort({ date: -1 });

    res.json({ success: true, data: sessions });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ✅ Update training session (Admin/Coach only)
exports.updateTrainingSession = async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { title, objectives, notes, completionStatus } = req.body;

    const session = await TrainingSession.findById(sessionId);
    if (!session) {
      return res.status(404).json({ success: false, message: "Training session not found" });
    }

    if (title !== undefined) session.title = title;
    if (objectives !== undefined) session.objectives = objectives;
    if (notes !== undefined) session.notes = notes;
    if (completionStatus !== undefined) session.completionStatus = completionStatus;

    if (req.files) {
      const paths = req.files.map((file) => `uploads/training/${file.filename}`);
      session.attachments = [...session.attachments, ...paths];
    }

    await session.save();

    res.json({
      success: true,
      message: "Training session updated successfully",
      data: session,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
