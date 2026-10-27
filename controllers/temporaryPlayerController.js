const User = require("../models/User");
const Term = require("../models/Term");
const MedicalProfile = require("../models/MedicalProfile");
const { normalizeMedicalStatus } = require("../utils/medicalStatus");
const Parent = require("../models/Parent");
const AuditLog = require("../models/AuditLog");
const Class = require("../models/Class");
const RegistrationRequest = require("../models/RegistrationRequest");
const { temporaryPlayerAccessEmail } = require("../utils/emailTemplates");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const mongoose = require("mongoose");
const { dateOnlyToUtc, dateOnly, todayDateOnly, serializeDateOnly, serializeTerm } = require("../utils/dateTime");
let broadcastSidebarBadges = null;
try {
  ({ broadcastSidebarBadges } = require("../sockets/chatSocket"));
} catch (e) {}

// Only operator-configured app domains may receive account links.
const getAppLoginUrl = () => {
  const candidate = process.env.PARENT_APP_URL || process.env.FRONTEND_URL || process.env.CLIENT_URL || process.env.APP_URL;
  if (!candidate) return null;
  try {
    const parsed = new URL(candidate);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) return null;
    if (process.env.NODE_ENV === "production" && parsed.protocol !== "https:") return null;
    return new URL("/signin", parsed.origin).toString();
  } catch { return null; }
};

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
      medicalConditionDetails,
      isMedicalCondition,
      allergies,
      classId,
      sessionDate,
      preferredTerm,
      preferredClasses,
      prefferedFoot,
      gender,
    } = req.body;

    if (!name || !dob || !parentName || !parentEmail || !parentPhone || !emergencyContact || !classId || !sessionDate) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({
        success: false,
        message: "name, dob, parentName, parentEmail, parentPhone, emergencyContact, classId, and sessionDate are required",
      });
    }

    const normalizedParentEmail = String(parentEmail).trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedParentEmail)) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ success: false, message: "Enter a valid parent email address to send the CoachMax sign-in details." });
    }

    const classData = await Class.findById(classId).select("coach assistantCoach category program term venue location status dayOfWeek schedule").session(session);
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

    const medical = normalizeMedicalStatus({ isMedicalCondition, medicalConditionDetails, medicalConditions, allergies });
    const parsedDob = dateOnlyToUtc(dob, "dob");
    const parsedSessionDate = dateOnlyToUtc(sessionDate, "sessionDate");
    const termDoc = await Term.findById(classData.term).session(session);
    if (classData.status !== "ACTIVE" || !termDoc || termDoc.status === "COMPLETED" || dateOnly(parsedSessionDate) < dateOnly(termDoc.startDate) || dateOnly(parsedSessionDate) > dateOnly(termDoc.endDate)) {
      throw Object.assign(new Error("Select an active class session within its term dates"), { statusCode: 409 });
    }
    if (dateOnly(parsedDob) > todayDateOnly() || dateOnly(parsedDob) > dateOnly(parsedSessionDate)) throw Object.assign(new Error("Date of birth cannot be in the future"), { statusCode: 400 });
    if (preferredTerm && String(preferredTerm) !== String(classData.term)) throw Object.assign(new Error("Requested term does not match the selected class"), { statusCode: 400 });
    const desiredClassIds = Array.isArray(preferredClasses) && preferredClasses.length ? preferredClasses : [classId];
    if (!desiredClassIds.some((value) => String(value) === String(classId))) throw Object.assign(new Error("Trial class must be one of the requested classes"), { statusCode: 400 });
    const requestedClasses = await Class.find({ _id: { $in: desiredClassIds }, term: classData.term, status: "ACTIVE" }).session(session);
    if (requestedClasses.length !== new Set(desiredClassIds.map(String)).size) throw Object.assign(new Error("One or more requested classes are unavailable in the selected term"), { statusCode: 400 });
    const emailToUse = normalizedParentEmail;
    const phoneDigits = String(parentPhone).replace(/\D/g, "");
    if (phoneDigits.length < 7 || phoneDigits.length > 15) throw Object.assign(new Error("Enter a valid parent phone number"), { statusCode: 400 });
    const phoneRegex = new RegExp(`^[\\s()+.-]*${phoneDigits.split("").join("[\\s()+.-]*")}[\\s()+.-]*$`);
    const parents = await Parent.find({ $or: [{ email: emailToUse }, { phone: phoneRegex }] }).session(session);
    if (parents.length > 1 || (parents[0] && (String(parents[0].email).trim().toLowerCase() !== emailToUse || String(parents[0].phone).replace(/\D/g, "") !== phoneDigits))) {
      throw Object.assign(new Error("Parent email and phone identify different household details. Ask an administrator to verify and update the parent account first."), { statusCode: 409 });
    }
    let parent = parents[0] || null;
    if (parent?.isBlocked || parent?.status === "REJECTED") throw Object.assign(new Error("This parent account is unavailable; administrator review is required"), { statusCode: 409 });

    let isNewAccount = false;
    const appLoginUrl = getAppLoginUrl();
    if (!appLoginUrl) throw Object.assign(new Error("Parent app URL is not configured. Set PARENT_APP_URL before creating temporary players."), { statusCode: 503 });

    if (!parent) {
      isNewAccount = true;
      // No reusable credential is emailed or stored in a delivery job. The
      // parent chooses a password through the existing one-use OTP grant flow.
      const hashedPassword = await bcrypt.hash(crypto.randomBytes(32).toString("hex"), 12);

      const newParentDocs = await Parent.create(
        [
          {
            fullName: parentName,
            email: emailToUse,
            phone: String(parentPhone).trim(),
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

    const catList = [...new Set(requestedClasses.map((cls) => String(cls.category)))];
    const primaryCat = classData.category;
    const progList = [...new Set(requestedClasses.map((cls) => String(cls.program)))];

    const selectedTerm = preferredTerm || classData.term || null;
    const prefClassList = desiredClassIds;

    const newPlayerDocs = await User.create(
      [
        {
          firstName,
          lastName,
          fullName: name.trim(),
          dob: parsedDob,
          gender: String(gender || "OTHER").toUpperCase(),
          prefferedFoot: prefferedFoot || undefined,
          parentId: parent._id,
          contactName: parentName,
          relationship: "Parent/Guardian",
          isMedicalCondition: medical.isMedicalCondition,
          medicalConditionDetails: medical.medicalConditionDetails,
          playerStatus: "PENDING_APPROVAL",
          createdBy: coachId,
          createdByRole: req.admin.role === "COACH" ? "COACH" : "SUPER_ADMIN",
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
    await MedicalProfile.create([{ player: player._id, medicalConditions: medical.medicalConditions, allergies: medical.allergies, emergencyContact }], { session });

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
          description: `Temporary player "${player.fullName}" added to session on ${dateOnly(parsedSessionDate, "sessionDate")}`,
        },
      ],
      { session }
    );

    const { queueEmail, queueNotification } = require("../services/deliveryService");
    await queueEmail(`temporary-access:${player._id}`, {
      to: parent.email,
      subject: isNewAccount ? "Set up your CoachMax account" : "A temporary player was added to your CoachMax account",
      html: temporaryPlayerAccessEmail({ parentName: parent.fullName || parentName, playerName: player.fullName, email: parent.email, isNewAccount,
        loginUrl: isNewAccount ? new URL("/forgot-password?role=PARENT", appLoginUrl).toString() : appLoginUrl }),
    }, session);
    await queueNotification(`temporary-created:${player._id}`, { recipientType: "ADMIN", adminId: null,
      title: "Temporary Player Added", message: `Coach ${req.admin.name} added temporary player "${player.fullName}" for verification.`, type: "TEMPORARY_PLAYER_ADDED",
      data: { playerId: String(player._id), parentId: String(parent._id), classId: String(classId), coachId: String(coachId) } }, session);
    await session.commitTransaction();
    await session.endSession();

    if (broadcastSidebarBadges) {
      broadcastSidebarBadges().catch(() => {});
    }

    const message = isNewAccount
      ? "Temporary player created. A password-setup email is queued for the parent."
      : "Temporary player created. An account update and sign-in email is queued for the parent.";

    res.status(201).json({
      success: true,
      message,
      emailQueued: true,
      data: {
        player,
        parent: {
          _id: parent._id,
          fullName: parent.fullName,
          email: parent.email,
          phone: parent.phone,
        },
        tempPasswordGenerated: false,
        isNewAccount,
      },
    });
  } catch (err) {
    if (session.inTransaction()) await session.abortTransaction();
    await session.endSession();
    res.status(err.statusCode || (err instanceof TypeError || err.name === "ValidationError" || err.name === "CastError" ? 400 : err.code === 11000 ? 409 : 500)).json({ success: false, message: err.message });
  }
};

exports.getTemporaryPlayers = async (req, res) => {
  try {
    const coachId = req.admin._id;
    let {
      page = 1,
      limit = 20,
      status,
      category,
      program,
      classId,
      search,
    } = req.query;

    page = Math.max(1, parseInt(page, 10) || 1);
    limit = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));

    // Only unapproved temporary players (playerStatus: "PENDING_APPROVAL")
    const unapprovedUserQuery = {
      playerStatus: "PENDING_APPROVAL",
      $or: [
        { temporaryClass: { $ne: null } },
        { temporarySessionDate: { $ne: null } },
        { createdByRole: "COACH" },
      ],
    };

    if (req.admin.role === "COACH") {
      unapprovedUserQuery.createdBy = coachId;
    }
    if (classId) {
      unapprovedUserQuery.temporaryClass = classId;
    }

    const tempUsers = await User.find(unapprovedUserQuery).select(
      "_id parentId category programs temporaryClass createdBy"
    );
    const tempUserIds = tempUsers.map((p) => p._id);

    const reqQuery = {
      requestType: { $in: ["TEMPORARY_PLAYER", "TEMPORARY"] },
      player: { $in: tempUserIds },
      status: status ? status.toUpperCase() : "PENDING",
    };

    if (category) {
      reqQuery.category = category;
    }

    if (program) {
      reqQuery.programs = program;
    }

    if (search) {
      const searchRegex = new RegExp(String(search).slice(0, 150).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      const searchedPlayers = await User.find({
        _id: { $in: tempUserIds },
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
        "firstName lastName fullName email phone dob gender profileImage rating classPaymentStatuses term assignedClasses prefferedFoot isMedicalCondition medicalConditionDetails hasPendingRequest playerStatus temporaryClass temporarySessionDate"
      )
      .populate("category", "name")
      .populate("programs", "name")
      .populate("preferredTerm", "name year startDate endDate")
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
      data: requests.map((request) => {
        const raw = request.toObject();
        if (raw.player) { raw.player.dob = serializeDateOnly(raw.player.dob); raw.player.temporarySessionDate = serializeDateOnly(raw.player.temporarySessionDate); }
        if (raw.preferredTerm) raw.preferredTerm = serializeTerm(raw.preferredTerm);
        return raw;
      }),
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// Compatibility endpoints use the same request-aware command as the queue.
exports.approveTemporaryPlayer = async (req, res) => {
  req.params.playerId = req.params.id;
  req.body.classIds = req.body.classIds || req.body.assignedClasses;
  return require("./registrationRequestController").assignClassesToPlayer(req, res);
};

exports.rejectTemporaryPlayer = async (req, res) => {
  try {
    const request = req.body.registrationRequestId
      ? await RegistrationRequest.findById(req.body.registrationRequestId)
      : await RegistrationRequest.findOne({ player: req.params.id, status: "PENDING", requestType: { $in: ["TEMPORARY_PLAYER", "TEMPORARY"] } });
    if (!request || String(request.player) !== String(req.params.id)) return res.status(404).json({ success: false, message: "Pending temporary-player request not found" });
    req.params.id = String(request._id);
    return require("./registrationRequestController").rejectRegistrationRequest(req, res);
  } catch (error) { return res.status(error.name === "CastError" ? 400 : 500).json({ success: false, message: error.message }); }
};

// Preserve attendance, notes, household and financial history. Older clients
// calling Delete cancel the pending request instead of cascading a player.
exports.deleteTemporaryPlayer = async (req, res) => {
  try {
    const request = await RegistrationRequest.findOne({ $or: [{ _id: req.params.id }, { player: req.params.id }], status: "PENDING", requestType: { $in: ["TEMPORARY_PLAYER", "TEMPORARY"] } });
    if (!request) return res.status(404).json({ success: false, message: "Pending temporary-player request not found" });
    req.params.id = String(request._id);
    req.body.reason = req.body.reason || "Cancelled by administrator";
    return require("./registrationRequestController").rejectRegistrationRequest(req, res);
  } catch (error) { return res.status(error.name === "CastError" ? 400 : 500).json({ success: false, message: error.message }); }
};
