const CoachNote = require("../models/CoachNote");
const AuditLog = require("../models/AuditLog");
const Class = require("../models/Class");
const mongoose = require("mongoose");

exports.createNote = async (req, res) => {
  try {
    const coachId = req.admin._id;
    const { playerId, classId, noteType, description } = req.body;

    if (!playerId || !noteType || !description) {
      return res.status(400).json({
        success: false,
        message: "playerId, noteType, and description are required",
      });
    }

    const validTypes = [
      "ARRIVED_LATE",
      "BEHAVIOUR_CONCERN",
      "INJURY",
      "MEDICAL_INCIDENT",
      "POSITIVE_PERFORMANCE",
      "DEVELOPMENT_AREA",
      "PARENT_DISCUSSION",
    ];

    if (!validTypes.includes(noteType)) {
      return res.status(400).json({
        success: false,
        message: `Invalid noteType. Must be one of: ${validTypes.join(", ")}`,
      });
    }

    if (req.admin.role === "COACH") {
      const assignedClasses = await Class.find({
        $or: [{ coach: coachId }, { assistantCoach: coachId }],
        players: playerId,
      }).select("_id");

      if (assignedClasses.length === 0) {
        return res.status(403).json({
          success: false,
          message: "Access denied. Player is not in your assigned classes.",
        });
      }
    }

    const note = await CoachNote.create({
      coach: coachId,
      player: playerId,
      classId: classId || null,
      noteType,
      description,
      isPersonal: req.body.isPersonal !== undefined ? Boolean(req.body.isPersonal) : false,
    });

    await AuditLog.create({
      user: coachId,
      userRole: req.admin.role,
      action: "NOTE_CREATED",
      entityType: "CoachNote",
      entityId: note._id,
      ipAddress: req.ip || "",
      deviceInfo: req.headers["user-agent"] || "",
      newValue: { noteType, description, playerId, isPersonal: note.isPersonal },
      description: `Coach note created for player ${playerId}`,
    });

    const populatedNote = await CoachNote.findById(note._id)
      .populate("coach", "name")
      .populate("player", "fullName")
      .populate("classId", "name");

    res.status(201).json({
      success: true,
      message: "Note created successfully",
      data: populatedNote,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

exports.updateNote = async (req, res) => {
  try {
    const coachId = req.admin._id;
    const { noteId } = req.params;
    const { noteType, description } = req.body;

    if (!noteType && !description && req.body.isPersonal === undefined) {
      return res.status(400).json({
        success: false,
        message: "At least one of noteType, description, or isPersonal is required to update",
      });
    }

    const note = await CoachNote.findById(noteId);

    if (!note) {
      return res.status(404).json({ success: false, message: "Note not found" });
    }

    if (req.admin.role === "COACH" && note.coach.toString() !== coachId.toString()) {
      return res.status(403).json({
        success: false,
        message: "Access denied. You can only edit your own notes.",
      });
    }

    const oldValue = {
      noteType: note.noteType,
      description: note.description,
      isPersonal: note.isPersonal,
    };

    if (noteType) note.noteType = noteType;
    if (description) note.description = description;
    if (req.body.isPersonal !== undefined) note.isPersonal = Boolean(req.body.isPersonal);
    note.isEdited = true;

    await note.save();

    await AuditLog.create({
      user: coachId,
      userRole: req.admin.role,
      action: "NOTE_UPDATED",
      entityType: "CoachNote",
      entityId: note._id,
      ipAddress: req.ip || "",
      deviceInfo: req.headers["user-agent"] || "",
      oldValue,
      newValue: { noteType: note.noteType, description: note.description, isPersonal: note.isPersonal },
      description: `Coach note updated for player ${note.player}`,
    });

    const populatedNote = await CoachNote.findById(note._id)
      .populate("coach", "name")
      .populate("player", "fullName")
      .populate("classId", "name");

    res.json({
      success: true,
      message: "Note updated successfully. Audit record created.",
      data: populatedNote,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

exports.getNotesByPlayer = async (req, res) => {
  try {
    const coachId = req.admin._id;
    const { playerId } = req.params;
    let { page = 1, limit = 20, noteType, isPersonal } = req.query;

    page = Number(page);
    limit = Number(limit);

    if (!mongoose.Types.ObjectId.isValid(playerId)) {
      return res.status(400).json({ success: false, message: "Invalid player ID" });
    }

    if (req.admin.role === "COACH") {
      const assignedClasses = await Class.find({
        $or: [{ coach: coachId }, { assistantCoach: coachId }],
        players: playerId,
      }).select("_id");

      if (assignedClasses.length === 0) {
        return res.status(403).json({
          success: false,
          message: "Access denied. Player is not in your assigned classes.",
        });
      }
    }

    const query = {
      player: playerId,
      $or: [
        { isPersonal: false },
        { coach: coachId }
      ]
    };
    if (noteType) query.noteType = noteType;
    if (isPersonal !== undefined && isPersonal !== "") {
      query.isPersonal = isPersonal === "true";
    }

    const total = await CoachNote.countDocuments(query);

    const notes = await CoachNote.find(query)
      .populate("coach", "name")
      .populate("classId", "name")
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit);

    res.json({
      success: true,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      data: notes,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

exports.getMyNotes = async (req, res) => {
  try {
    const coachId = req.admin._id;
    let { page = 1, limit = 20, noteType, playerId, isPersonal } = req.query;

    page = Number(page);
    limit = Number(limit);

    const query = {};

    if (req.admin.role === "COACH") {
      query.coach = coachId;
    } else {
      query.$or = [
        { isPersonal: false },
        { coach: coachId }
      ];
    }

    if (noteType) query.noteType = noteType;
    if (playerId) query.player = playerId;
    if (isPersonal !== undefined && isPersonal !== "") {
      query.isPersonal = isPersonal === "true";
    }

    const total = await CoachNote.countDocuments(query);

    const notes = await CoachNote.find(query)
      .populate("coach", "name")
      .populate("player", "fullName profileImage")
      .populate("classId", "name")
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit);

    res.json({
      success: true,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      data: notes,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

exports.getNoteAuditHistory = async (req, res) => {
  try {
    const { noteId } = req.params;

    const auditLogs = await AuditLog.find({
      entityType: "CoachNote",
      entityId: noteId,
    })
      .populate("user", "name role")
      .sort({ createdAt: -1 });

    res.json({
      success: true,
      data: auditLogs,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
