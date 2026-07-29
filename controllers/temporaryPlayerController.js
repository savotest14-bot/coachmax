const User = require("../models/User");
const Parent = require("../models/Parent");
const AuditLog = require("../models/AuditLog");
const Admin = require("../models/Admin");
const Class = require("../models/Class");
const Attendance = require("../models/Attendance");
const AttendanceHistory = require("../models/AttendanceHistory");
const CoachNote = require("../models/CoachNote");
const ChatRoom = require("../models/ChatRoom");
const Message = require("../models/Message");
const Notification = require("../models/Notification");
const sendEmail = require("../utils/sendEmail");
const { welcomeEmail } = require("../utils/emailTemplates");
const { sendNotification } = require("../services/notificationService");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const mongoose = require("mongoose");

// ═══════════════════════════════════════════════
// FEATURE 4 — Temporary Player Flow (Single User/Parent Architecture)
// ═══════════════════════════════════════════════

/**
 * POST /api/coach/temporary-players
 * Coach creates a temporary player (Parent + User record with playerStatus="PENDING_APPROVAL").
 */
exports.createTemporaryPlayer = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const coachId = req.admin._id;
    const {
      name,
      dob,
      parentName,
      parentEmail,
      parentPhone,
      emergencyContact,
      medicalConditions,
      allergies,
      classId,
      sessionDate,
    } = req.body;

    // Required field validation
    if (!name || !dob || !parentName || !parentPhone || !emergencyContact || !classId || !sessionDate) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({
        success: false,
        message: "name, dob, parentName, parentPhone, emergencyContact, classId, and sessionDate are required",
      });
    }

    // Verify class assignment for coach
    if (req.admin.role === "COACH") {
      const classData = await Class.findById(classId).select("coach assistantCoach").session(session);
      if (!classData) {
        await session.abortTransaction();
        session.endSession();
        return res.status(404).json({ success: false, message: "Class not found" });
      }

      const isAssigned =
        (classData.coach && classData.coach.toString() === coachId.toString()) ||
        (classData.assistantCoach && classData.assistantCoach.toString() === coachId.toString());

      if (!isAssigned) {
        await session.abortTransaction();
        session.endSession();
        return res.status(403).json({
          success: false,
          message: "Access denied. You are not assigned to this class.",
        });
      }
    }

    // 1. Find or create Parent record
    const emailToUse = parentEmail ? parentEmail.toLowerCase() : `temp.${Date.now()}.${Math.floor(Math.random()*1000)}@tempcoachmax.com`;
    let parent = await Parent.findOne({
      $or: [{ phone: parentPhone }, { email: emailToUse }],
    }).session(session);

    let generatedPassword = null;

    if (!parent) {
      // Generate random temporary password
      generatedPassword = crypto.randomBytes(4).toString("hex") + "@1A";
      const hashedPassword = await bcrypt.hash(generatedPassword, 10);

      const newParentDocs = await Parent.create(
        [
          {
            fullName: parentName,
            email: emailToUse,
            phone: parentPhone,
            password: hashedPassword,
            emergencyContact,
            relationship: "Parent/Guardian",
            status: "APPROVED",
          },
        ],
        { session }
      );
      parent = newParentDocs[0];
    }

    // 2. Split player full name
    const nameParts = name.trim().split(" ");
    const firstName = nameParts[0];
    const lastName = nameParts.slice(1).join(" ") || "";

    // Parse date
    const parsedDob = new Date(dob);
    const parsedSessionDate = new Date(sessionDate);
    parsedSessionDate.setUTCHours(0, 0, 0, 0);

    // 3. Create User (Player) record
    const hasMedical = !!(medicalConditions || allergies);
    const medicalDetails = [medicalConditions, allergies ? `Allergies: ${allergies}` : ""].filter(Boolean).join(" | ");

    const newPlayerDocs = await User.create(
      [
        {
          firstName,
          lastName,
          fullName: name.trim(),
          dob: parsedDob,
          parentId: parent._id,
          contactName: parentName,
          relationship: "Parent/Guardian",
          isMedicalCondition: hasMedical,
          medicalConditionDetails: medicalDetails,
          playerStatus: req.admin.role === "SUPER_ADMIN" ? "ACTIVE" : "PENDING_APPROVAL",
          createdBy: coachId,
          createdByRole: req.admin.role,
          temporaryClass: classId,
          temporarySessionDate: parsedSessionDate,
          paymentStatus: "TRIAL",
          assignedClasses: [],
        },
      ],
      { session }
    );

    const player = newPlayerDocs[0];

    // Audit log entry
    await AuditLog.create(
      [
        {
          user: coachId,
          userRole: req.admin.role,
          action: "TEMP_PLAYER_CREATED",
          entityType: "User",
          entityId: player._id,
          ipAddress: req.ip || "",
          deviceInfo: req.headers["user-agent"] || "",
          newValue: {
            playerId: player._id,
            name: player.fullName,
            parentName,
            parentPhone,
            classId,
            sessionDate: parsedSessionDate,
            playerStatus: player.playerStatus,
          },
          description: `Temporary player "${player.fullName}" added to session on ${parsedSessionDate.toISOString().split("T")[0]}`,
        },
      ],
      { session }
    );

    await session.commitTransaction();
    session.endSession();

    // 4. Send email to parent if temporary password was generated (non-blocking)
    if (generatedPassword && parentEmail) {
      sendEmail(
        parentEmail,
        "Welcome to CoachMax — Account Credentials 🎉",
        welcomeEmail(parentName) + `<p style="padding:15px; background:#e9ecef; border-radius:5px;"><b>Temporary Password:</b> ${generatedPassword}</p>`
      ).catch((err) => console.error("Parent temp credential email error:", err.message));
    }

    // 5. Notify Super Admins
    const superAdmins = await Admin.find({ role: "SUPER_ADMIN" }).select("_id");
    for (const sa of superAdmins) {
      await sendNotification({
        recipientType: "ADMIN",
        adminId: sa._id,
        title: "Temporary Player Added 🆕",
        message: `Coach ${req.admin.name} added temporary player "${player.fullName}". Status: ${player.playerStatus}`,
        type: "TEMPORARY_PLAYER_ADDED",
        data: {
          playerId: player._id.toString(),
          parentId: parent._id.toString(),
          classId: String(classId),
          coachId: coachId.toString(),
        },
      });
    }

    res.status(201).json({
      success: true,
      message: `Temporary player created successfully. Status: ${player.playerStatus}`,
      data: {
        player,
        parent: {
          _id: parent._id,
          fullName: parent.fullName,
          email: parent.email,
          phone: parent.phone,
        },
        tempPasswordGenerated: !!generatedPassword,
      },
    });
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * GET /api/coach/temporary-players
 * View temporary/pending players.
 */
exports.getTemporaryPlayers = async (req, res) => {
  try {
    const coachId = req.admin._id;
    let { page = 1, limit = 20, playerStatus = "PENDING_APPROVAL", classId } = req.query;

    page = Number(page);
    limit = Number(limit);

    const query = {};

    if (playerStatus) query.playerStatus = playerStatus;
    if (classId) query.temporaryClass = classId;

    // Coach sees players created by themselves, or assigned to their classes
    if (req.admin.role === "COACH") {
      query.createdBy = coachId;
    }

    const total = await User.countDocuments(query);

    const players = await User.find(query)
      .populate("parentId", "fullName email phone emergencyContact")
      .populate("createdBy", "name email")
      .populate("temporaryClass", "name dayOfWeek startTime endTime venue")
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit);

    res.json({
      success: true,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      data: players,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * PATCH /api/admin/temporary-players/:id/approve
 * Super Admin approves a temporary player (updates playerStatus="ACTIVE").
 */
exports.approveTemporaryPlayer = async (req, res) => {
  try {
    const { id } = req.params;
    const { assignedClasses, category, programs, term } = req.body;
    const adminId = req.admin._id;

    const player = await User.findById(id);

    if (!player) {
      return res.status(404).json({ success: false, message: "Player not found" });
    }

    if (player.playerStatus === "ACTIVE") {
      return res.status(400).json({
        success: false,
        message: "Player is already ACTIVE",
      });
    }

    // Update status to ACTIVE
    player.playerStatus = "ACTIVE";

    // Optional class/program allocations
    if (assignedClasses && Array.isArray(assignedClasses)) {
      player.assignedClasses = assignedClasses;
      // Add player to class rosters
      await Class.updateMany(
        { _id: { $in: assignedClasses } },
        { $addToSet: { players: player._id } }
      );
    }
    if (category) player.category = category;
    if (programs && Array.isArray(programs)) player.programs = programs;
    if (term) player.term = term;

    await player.save();

    // Audit log
    await AuditLog.create({
      user: adminId,
      userRole: req.admin.role,
      action: "TEMP_PLAYER_APPROVED",
      entityType: "User",
      entityId: player._id,
      ipAddress: req.ip || "",
      deviceInfo: req.headers["user-agent"] || "",
      oldValue: { playerStatus: "PENDING_APPROVAL" },
      newValue: { playerStatus: "ACTIVE", assignedClasses, category, programs },
      description: `Temporary player "${player.fullName}" approved by Admin and set to ACTIVE`,
    });

    // Notify coach if created by coach
    if (player.createdBy) {
      await sendNotification({
        recipientType: "ADMIN",
        adminId: player.createdBy,
        title: "Temporary Player Approved ✅",
        message: `Temporary player "${player.fullName}" has been approved by Super Admin and is now ACTIVE.`,
        type: "TEMPORARY_PLAYER_ADDED",
        data: { playerId: player._id.toString() },
      });
    }

    res.json({
      success: true,
      message: "Player approved successfully and activated.",
      data: player,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * PATCH /api/admin/temporary-players/:id/reject
 * Super Admin rejects a temporary player (updates playerStatus="REJECTED").
 */
exports.rejectTemporaryPlayer = async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;
    const adminId = req.admin._id;

    const player = await User.findById(id);

    if (!player) {
      return res.status(404).json({ success: false, message: "Player not found" });
    }

    player.playerStatus = "REJECTED";
    await player.save();

    // Audit log
    await AuditLog.create({
      user: adminId,
      userRole: req.admin.role,
      action: "TEMP_PLAYER_REJECTED",
      entityType: "User",
      entityId: player._id,
      ipAddress: req.ip || "",
      deviceInfo: req.headers["user-agent"] || "",
      oldValue: { playerStatus: player.playerStatus },
      newValue: { playerStatus: "REJECTED", reason: reason || "" },
      description: `Temporary player "${player.fullName}" rejected by Admin`,
    });

    // Notify coach
    if (player.createdBy) {
      await sendNotification({
        recipientType: "ADMIN",
        adminId: player.createdBy,
        title: "Temporary Player Rejected ❌",
        message: `Temporary player "${player.fullName}" was rejected by Super Admin.${reason ? " Reason: " + reason : ""}`,
        type: "TEMPORARY_PLAYER_ADDED",
        data: { playerId: player._id.toString() },
      });
    }

    res.json({
      success: true,
      message: "Player rejected successfully.",
      data: player,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * DELETE /api/admin/temporary-players/:id
 * Super Admin cascade deletes a temporary/rejected player and all associated data.
 */
exports.deleteTemporaryPlayer = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { id } = req.params;
    const adminId = req.admin._id;

    const player = await User.findById(id).session(session);

    if (!player) {
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json({ success: false, message: "Player not found" });
    }

    const parentId = player.parentId;

    // 1. Remove player from Class rosters
    await Class.updateMany(
      { players: player._id },
      { $pull: { players: player._id } },
      { session }
    );

    // 2. Delete Attendance records & history
    await Attendance.updateMany(
      { "records.player": player._id },
      { $pull: { records: { player: player._id } } },
      { session }
    );
    await AttendanceHistory.deleteMany({ playerId: player._id }, { session });

    // 3. Delete Coach Notes
    await CoachNote.deleteMany({ player: player._id }, { session });

    // 4. Delete Player record
    await User.findByIdAndDelete(player._id, { session });

    // 5. Delete Parent if no other children exist
    if (parentId) {
      const remainingChildren = await User.countDocuments({ parentId }).session(session);
      if (remainingChildren === 0) {
        await Parent.findByIdAndDelete(parentId, { session });
      }
    }

    // Audit log
    await AuditLog.create(
      [
        {
          user: adminId,
          userRole: req.admin.role,
          action: "PLAYER_DELETED",
          entityType: "User",
          entityId: player._id,
          ipAddress: req.ip || "",
          deviceInfo: req.headers["user-agent"] || "",
          description: `Player "${player.fullName}" and all associated data cascade deleted by Super Admin`,
        },
      ],
      { session }
    );

    await session.commitTransaction();
    session.endSession();

    res.json({
      success: true,
      message: `Player "${player.fullName}" and all associated data deleted completely.`,
    });
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    res.status(500).json({ success: false, message: err.message });
  }
};
