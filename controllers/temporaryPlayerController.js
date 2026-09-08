const User = require("../models/User");
const Parent = require("../models/Parent");
const AuditLog = require("../models/AuditLog");
const Admin = require("../models/Admin");
const Class = require("../models/Class");
const RegistrationRequest = require("../models/RegistrationRequest");
const Attendance = require("../models/Attendance");
const AttendanceHistory = require("../models/AttendanceHistory");
const CoachNote = require("../models/CoachNote");
const ChatRoom = require("../models/ChatRoom");
const Message = require("../models/Message");
const Notification = require("../models/Notification");
const sendEmail = require("../utils/sendEmail");
const { welcomeEmail } = require("../utils/emailTemplates");
const { sendNotification } = require("../services/notificationService");
const { generateClassInvoice } = require("../services/invoiceService");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const mongoose = require("mongoose");

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
      category,
      categories,
      programs,
      preferredTerm,
      preferredClasses,
      prefferedFoot,
      gender,
    } = req.body;

    if (!name || !dob || !parentName || !parentPhone || !emergencyContact || !classId || !sessionDate) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({
        success: false,
        message: "name, dob, parentName, parentPhone, emergencyContact, classId, and sessionDate are required",
      });
    }

    const classData = await Class.findById(classId).select("coach assistantCoach category program term venue location").session(session);
    if (!classData) {
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json({ success: false, message: "Class not found" });
    }

    if (req.admin.role === "COACH") {
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

    const emailToUse = parentEmail ? parentEmail.toLowerCase() : `temp.${Date.now()}.${Math.floor(Math.random() * 1000)}@tempcoachmax.com`;
    let parent = await Parent.findOne({
      $or: [{ phone: parentPhone }, { email: emailToUse }],
    }).session(session);

    let generatedPassword = null;

    if (!parent) {
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

    const nameParts = name.trim().split(" ");
    const firstName = nameParts[0];
    const lastName = nameParts.slice(1).join(" ") || "";

    const parsedDob = new Date(dob);
    const parsedSessionDate = new Date(sessionDate);
    parsedSessionDate.setUTCHours(0, 0, 0, 0);

    const catList = Array.isArray(categories)
      ? categories
      : category
        ? Array.isArray(category)
          ? category
          : [category]
        : classData.category
          ? [classData.category]
          : [];
    const primaryCat = catList[0] || classData.category || null;

    const progList = Array.isArray(programs)
      ? programs
      : programs
        ? [programs]
        : classData.program
          ? [classData.program]
          : [];

    const selectedTerm = preferredTerm || classData.term || null;
    const prefClassList = Array.isArray(preferredClasses)
      ? preferredClasses
      : [classId];

    const hasMedical = !!(medicalConditions || allergies);
    const medicalDetails = [medicalConditions, allergies ? `Allergies: ${allergies}` : ""].filter(Boolean).join(" | ");

    const newPlayerDocs = await User.create(
      [
        {
          firstName,
          lastName,
          fullName: name.trim(),
          dob: parsedDob,
          gender: gender || "OTHER",
          prefferedFoot: prefferedFoot || undefined,
          parentId: parent._id,
          contactName: parentName,
          relationship: "Parent/Guardian",
          isMedicalCondition: hasMedical,
          medicalConditionDetails: medicalDetails,
          playerStatus: req.admin.role === "SUPER_ADMIN" ? "ACTIVE" : "PENDING_APPROVAL",
          createdBy: coachId,
          createdByRole: req.admin.role,
          category: primaryCat,
          categories: catList,
          programs: progList,
          term: null,
          hasPendingRequest: true,
          temporaryClass: classId,
          temporarySessionDate: parsedSessionDate,
          classPaymentStatuses: [],
          assignedClasses: [],
        },
      ],
      { session }
    );

    const player = newPlayerDocs[0];

    await RegistrationRequest.create(
      [
        {
          parent: parent._id,
          player: player._id,
          category: primaryCat,
          programs: progList,
          preferredTerm: selectedTerm,
          preferredClasses: prefClassList,
          requestType: "TEMPORARY_PLAYER",
          status: "PENDING",
          createdBy: coachId,
        },
      ],
      { session }
    );

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
    if (generatedPassword && parentEmail) {
      sendEmail(
        parentEmail,
        "Welcome to CoachMax — Account Credentials 🎉",
        welcomeEmail(parentName) + `<p style="padding:15px; background:#e9ecef; border-radius:5px;"><b>Temporary Password:</b> ${generatedPassword}</p>`
      ).catch((err) => console.error("Parent temp credential email error:", err.message));
    }

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

exports.getTemporaryPlayers = async (req, res) => {
  try {
    const coachId = req.admin._id;
    let {
      page = 1,
      limit = 20,
      status,
      requestType,
      category,
      program,
      classId,
      search,
    } = req.query;

    page = Number(page) || 1;
    limit = Number(limit) || 20;

    const playerQuery = {};
    if (req.admin.role === "COACH") {
      playerQuery.createdBy = coachId;
    }
    if (classId) {
      playerQuery.temporaryClass = classId;
    }

    const matchingPlayers = await User.find(playerQuery).select("_id parentId category programs temporaryClass createdBy");
    const matchingPlayerIds = matchingPlayers.map((p) => p._id);

    for (const tu of matchingPlayers) {
      const existingReq = await RegistrationRequest.findOne({ player: tu._id });
      if (!existingReq && tu.parentId) {
        await RegistrationRequest.create({
          parent: tu.parentId,
          player: tu._id,
          category: tu.category || null,
          programs: tu.programs || [],
          preferredClasses: tu.temporaryClass ? [tu.temporaryClass] : [],
          requestType: "TEMPORARY_PLAYER",
          status: "PENDING",
          createdBy: tu.createdBy || coachId,
        });
      }
    }

    const reqQuery = {
      $or: [
        { requestType: { $in: ["TEMPORARY_PLAYER", "TEMPORARY"] } },
        { player: { $in: matchingPlayerIds } },
      ],
    };

    if (status) {
      reqQuery.status = status.toUpperCase();
    } else {
      reqQuery.status = "PENDING";
    }

    if (requestType) {
      reqQuery.requestType = requestType;
    }

    if (category) {
      reqQuery.category = category;
    }

    if (program) {
      reqQuery.programs = program;
    }

    if (search) {
      const searchRegex = new RegExp(search, "i");
      const searchedPlayers = await User.find({
        $or: [
          { fullName: searchRegex },
          { firstName: searchRegex },
          { lastName: searchRegex },
          { email: searchRegex },
          { phone: searchRegex },
        ],
      }).select("_id");
      const searchedPlayerIds = searchedPlayers.map((p) => p._id);

      const searchedParents = await Parent.find({
        fullName: searchRegex,
      }).select("_id");
      const searchedParentIds = searchedParents.map((p) => p._id);

      const searchConditions = [
        { player: { $in: searchedPlayerIds } },
        { parent: { $in: searchedParentIds } },
      ];

      if (reqQuery.$and) {
        reqQuery.$and.push({ $or: searchConditions });
      } else {
        reqQuery.$and = [{ $or: searchConditions }];
      }
    }

    const total = await RegistrationRequest.countDocuments(reqQuery);

    const requests = await RegistrationRequest.find(reqQuery)
      .populate("parent", "fullName email phone address city")
      .populate(
        "player",
        "firstName lastName fullName email phone dob gender profileImage rating classPaymentStatuses term assignedClasses prefferedFoot isMedicalCondition medicalConditionDetails hasPendingRequest"
      )
      .populate("category", "name")
      .populate("programs", "name")
      .populate("preferredTerm", "name startDate endDate")
      .populate("preferredClasses", "name dayOfWeek startTime endTime venue location")
      .populate("assignedBy", "name email")
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit);

    return res.status(200).json({
      success: true,
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
      data: requests,
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

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

    player.playerStatus = "ACTIVE";

    if (assignedClasses && Array.isArray(assignedClasses)) {
      player.assignedClasses = assignedClasses;
      await Class.updateMany(
        { _id: { $in: assignedClasses } },
        { $addToSet: { players: player._id } }
      );
    }
    if (category) {
      player.category = category;
      player.categories = player.categories || [];
      const catStr = category.toString();
      if (!player.categories.some((c) => c.toString() === catStr)) {
        player.categories.push(category);
      }
    }
    if (programs && Array.isArray(programs)) player.programs = programs;
    if (term) player.term = term;

    await player.save();

    if (assignedClasses && Array.isArray(assignedClasses)) {
      try {
        for (const clsId of assignedClasses) {
          await generateClassInvoice({ userId: player._id, classId: clsId });
        }
      } catch (invErr) {
        console.error("Auto invoice generation error in approveTemporaryPlayer:", invErr.message);
      }
    }

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

    if (player.createdBy) {
      await sendNotification({
        recipientType: "ADMIN",
        adminId: player.createdBy,
        title: "Temporary Player Approved",
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

    await Class.updateMany(
      { players: player._id },
      { $pull: { players: player._id } },
      { session }
    );

    await Attendance.updateMany(
      { "records.player": player._id },
      { $pull: { records: { player: player._id } } },
      { session }
    );
    await AttendanceHistory.deleteMany({ playerId: player._id }, { session });

    await CoachNote.deleteMany({ player: player._id }, { session });

    await User.findByIdAndDelete(player._id, { session });

    if (parentId) {
      const remainingChildren = await User.countDocuments({ parentId }).session(session);
      if (remainingChildren === 0) {
        await Parent.findByIdAndDelete(parentId, { session });
      }
    }
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
