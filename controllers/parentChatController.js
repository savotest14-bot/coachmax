const ChatRoom = require("../models/ChatRoom");
const Message = require("../models/Message");
const Class = require("../models/Class");
const User = require("../models/User");
const AuditLog = require("../models/AuditLog");
const Admin = require("../models/Admin");
const Parent = require("../models/Parent");
const Team = require("../models/Team");
const League = require("../models/League");
const Event = require("../models/Event");
const EventRegistration = require("../models/EventRegistration");
const CampSession = require("../models/CampSession");
const Term = require("../models/Term");
const mongoose = require("mongoose");
const fs = require("fs");
const path = require("path");
const { sendNotification } = require("../services/notificationService");
const { getIO, isUserOnline, calculateTickStatus } = require("../sockets/chatSocket");
const { dateOnly } = require("../utils/dateTime");
const {
  getActor,
  isRoomMember,
  conversationResponse,
  validObjectId,
} = require("../utils/chatRoom");

/**
 * Resolve the parent audience for one holiday-camp calendar date. A missing
 * campSessionId deliberately means all available sessions on that date;
 * callers may pass a session id only when they explicitly want a full-day or
 * half-day audience.
 */
async function resolveEventDayAudience({ eventId, sessionDate, campSessionId }) {
  const normalizedDate = dateOnly(sessionDate, "sessionDate");
  const event = await Event.findById(eventId)
    .select("_id title status startDate endDate eventType termId")
    .populate("termId", "name year startDate endDate status isEvent");
  if (!event) {
    const error = new Error("Event not found");
    error.statusCode = 404;
    throw error;
  }
  if (event.status === "COMPLETED") {
    const error = new Error("This event has finished and its chat is read-only");
    error.statusCode = 409;
    throw error;
  }
  if (event.termId?.status === "COMPLETED") {
    const error = new Error("This term has finished and its chat is read-only");
    error.statusCode = 409;
    throw error;
  }
  const eventStartDate = event.startDate ? dateOnly(event.startDate, "event.startDate") : null;
  const eventEndDate = event.endDate ? dateOnly(event.endDate, "event.endDate") : null;
  if ((eventStartDate && normalizedDate < eventStartDate) || (eventEndDate && normalizedDate > eventEndDate)) {
    const error = new Error("The selected date is outside this event's schedule");
    error.statusCode = 400;
    throw error;
  }

  const sessionsForDate = await CampSession.find({
    event: eventId,
    sessionDate: {
      $gte: new Date(`${normalizedDate}T00:00:00.000Z`),
      $lte: new Date(`${normalizedDate}T23:59:59.999Z`),
    },
  }).sort({ sessionType: 1 });

  if (sessionsForDate.length === 0) {
    const error = new Error("No camp session is configured for this date");
    error.statusCode = 404;
    throw error;
  }

  let selectedSession = null;
  if (campSessionId) {
    if (!mongoose.Types.ObjectId.isValid(campSessionId)) {
      const error = new Error("campSessionId must be a valid id");
      error.statusCode = 400;
      throw error;
    }
    selectedSession = sessionsForDate.find((session) => session._id.toString() === campSessionId.toString());
    if (!selectedSession) {
      const error = new Error("Selected camp session does not belong to this event date");
      error.statusCode = 400;
      throw error;
    }
    if (selectedSession.isAvailable === false) {
      const error = new Error("The selected camp session is unavailable");
      error.statusCode = 409;
      throw error;
    }
  }

  const availableSessions = sessionsForDate.filter((session) => session.isAvailable !== false);
  const audienceSessions = selectedSession ? [selectedSession] : availableSessions;
  if (audienceSessions.length === 0) {
    const error = new Error("This event date is unavailable");
    error.statusCode = 409;
    throw error;
  }
  const audienceSessionIds = audienceSessions.map((session) => session._id.toString());

  const registrations = await EventRegistration.find({ event: eventId, status: "REGISTERED" })
    .populate({
      path: "user",
      select: "_id parentId",
      populate: { path: "parentId", select: "_id" },
    })
    .lean();

  const parentIds = [...new Set(
    registrations
      .filter((registration) => Array.isArray(registration.selectedSessions))
      .filter((registration) => {
        // Empty selectedSessions is the legacy regular-event shape. For a
        // holiday date, only registrations with an explicit matching session
        // are eligible; this avoids broadcasting to unrelated camp days.
        if (registration.selectedSessions.length === 0) return false;
        return registration.selectedSessions.some((selected) => {
          const selectedDate = selected?.sessionDate ? dateOnly(selected.sessionDate, "selectedSession.sessionDate") : null;
          return selectedDate === normalizedDate && selected?.session && audienceSessionIds.includes(selected.session.toString());
        });
      })
      .map((registration) => registration.user?.parentId?._id || registration.user?.parentId)
      .filter(Boolean)
      .map((parentId) => parentId.toString())
  )];

  return {
    event,
    normalizedDate,
    sessionsForDate,
    selectedSession,
    parentIds,
    participantPlayerIds: registrations
      .filter((registration) => Array.isArray(registration.selectedSessions) && registration.selectedSessions.length > 0)
      .filter((registration) => registration.selectedSessions.some((selected) => {
        const selectedDate = selected?.sessionDate ? dateOnly(selected.sessionDate, "selectedSession.sessionDate") : null;
        return selectedDate === normalizedDate && selected?.session && audienceSessionIds.includes(selected.session.toString());
      }))
      .map((registration) => registration.user?._id)
      .filter(Boolean),
  };
}

exports.previewEventDayBroadcast = async (req, res) => {
  try {
    if (!req.admin) return res.status(403).json({ success: false, message: "Coach or Admin role required for event chat." });
    const { eventId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(eventId)) return res.status(400).json({ success: false, message: "A valid eventId is required" });
    const { sessionDate, campSessionId } = req.query || {};
    if (!sessionDate) return res.status(400).json({ success: false, message: "sessionDate is required (YYYY-MM-DD)" });

    const audience = await resolveEventDayAudience({ eventId, sessionDate, campSessionId: campSessionId || null });
    const sessionLabel = audience.selectedSession?.sessionLabel || (audience.selectedSession ? audience.selectedSession.sessionType : "All sessions");
    const room = await ChatRoom.findOne({
      type: "BROADCAST",
      eventId,
      eventSessionDate: audience.normalizedDate,
      campSessionId: audience.selectedSession?._id || null,
    }).select("_id name scopeType scopeLabel audienceType recipientCount entityStatus").lean();

    return res.json({
      success: true,
      data: {
        eventId,
        eventTitle: audience.event.title,
        eventStatus: audience.event.status,
        sessionDate: audience.normalizedDate,
        sessionLabel,
        sessionCount: audience.selectedSession ? 1 : audience.sessionsForDate.filter((session) => session.isAvailable !== false).length,
        recipientCount: audience.parentIds.length,
        room: room || null,
      },
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
};

exports.startDirectChat = async (req, res) => {
  try {
    const currentUserId = req.admin ? req.admin._id : (req.parent || req.user)?._id;
    const currentModel = req.admin ? "Admin" : "Parent";

    if (!currentUserId) {
      return res.status(401).json({ success: false, message: "Unauthorized access" });
    }

    const { parentId, coachId, adminId, targetUserId, targetModel, classId, teamId, termId, programId } = req.body;

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

    if (!otherModel) otherModel = currentModel === "Admin" ? "Parent" : "Admin";
    if (!["Parent", "Admin"].includes(otherModel) || !validObjectId(otherId)) {
      return res.status(400).json({ success: false, message: "A valid target user and target model are required" });
    }

    const targetExists = otherModel === "Parent"
      ? await Parent.exists({ _id: otherId })
      : await Admin.exists({ _id: otherId, isActive: { $ne: false } });
    if (!targetExists) return res.status(404).json({ success: false, message: "Target user not found" });

    if (!otherId) {
      return res.status(400).json({
        success: false,
        message: currentModel === "Admin" ? "parentId is required" : "coachId or targetUserId is required",
      });
    }

    if (req.admin && req.admin.role === "COACH" && otherModel === "Parent") {
      const children = await User.find({ parentId: otherId }).select("_id");
      const childIds = children.map((c) => c._id);
      let canChatWithParent = false;

      if (teamId && validObjectId(teamId)) {
        const team = await Team.findById(teamId)
          .select("coach assistantCoach players")
          .populate("players.player", "_id");
        const isAssignedCoach = team && (
          team.coach?.toString() === currentUserId.toString() ||
          team.assistantCoach?.toString() === currentUserId.toString()
        );
        const childIdsSet = new Set(childIds.map((id) => id.toString()));
        const parentChildInTeam = (team?.players || []).some((entry) => {
          const playerId = entry.player?._id || entry.player;
          return playerId && childIdsSet.has(playerId.toString());
        });
        canChatWithParent = Boolean(isAssignedCoach && parentChildInTeam);
      } else if (classId && validObjectId(classId)) {
        const targetClass = await Class.findById(classId)
          .select("coach assistantCoach players");
        const isAssignedCoach = targetClass && (
          targetClass.coach?.toString() === currentUserId.toString() ||
          targetClass.assistantCoach?.toString() === currentUserId.toString()
        );
        const childIdsSet = new Set(childIds.map((id) => id.toString()));
        const parentChildInClass = (targetClass?.players || []).some((playerId) =>
          childIdsSet.has((playerId?._id || playerId).toString())
        );
        canChatWithParent = Boolean(isAssignedCoach && parentChildInClass);
      } else {
        const assignedClasses = await Class.find({
          $or: [{ coach: currentUserId }, { assistantCoach: currentUserId }],
          players: { $in: childIds },
        }).select("_id");
        canChatWithParent = assignedClasses.length > 0;
      }

      if (!canChatWithParent) {
        return res.status(403).json({
          success: false,
          message: "Access denied. This parent's child is not in your assigned class or team.",
        });
      }
    }
    let resolvedTermId = validObjectId(termId) ? termId : null;
    let resolvedProgramId = validObjectId(programId) ? programId : null;
    if (classId && validObjectId(classId)) {
      const sourceClass = await Class.findById(classId).select("term program").lean();
      if (sourceClass) {
        resolvedTermId = resolvedTermId || sourceClass.term || null;
        resolvedProgramId = resolvedProgramId || sourceClass.program || null;
      }
    } else if (teamId && validObjectId(teamId)) {
      const sourceTeam = await Team.findById(teamId).select("term").lean();
      if (sourceTeam) resolvedTermId = resolvedTermId || sourceTeam.term || null;
    }

    const roomQuery = {
      type: "DIRECT",
      members: {
        $all: [
          { $elemMatch: { refModel: currentModel, user: currentUserId } },
          { $elemMatch: { refModel: otherModel, user: otherId } },
        ],
      },
    };
    if (classId && validObjectId(classId)) roomQuery.classId = classId;
    if (teamId && validObjectId(teamId)) roomQuery.teamId = teamId;
    if (resolvedTermId) roomQuery.termId = resolvedTermId;
    if (resolvedProgramId) roomQuery.programId = resolvedProgramId;

    let room = await ChatRoom.findOne(roomQuery);

    if (!room) {
      room = await ChatRoom.create({
        type: "DIRECT",
        scope: "DIRECT",
        audience: "PARENT_COACH",
        scopeType: "DIRECT",
        audienceType: "DIRECT",
        scopeLabel: "Direct conversation",
        classId: validObjectId(classId) ? classId : null,
        termId: resolvedTermId,
        programId: resolvedProgramId,
        teamId: validObjectId(teamId) ? teamId : null,
        createdBy: req.admin?._id || null,
        members: [
          { refModel: currentModel, user: currentUserId },
          { refModel: otherModel, user: otherId },
        ],
      });
    }
    const populatedRoom = await ChatRoom.findById(room._id)
      .populate("members.user", "name fullName email phone profileImage role")
      .populate("classId", "name term program category")
      .populate("termId", "name year startDate endDate")
      .populate("programId", "name ageGroup");

    res.json({
      success: true,
      data: conversationResponse(populatedRoom, { currentUserId }),
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

    if (req.admin.role === "COACH") {
      const unauthorizedClass = classesData.find((classData) => {
        const coachIdText = req.admin._id.toString();
        return classData.coach?.toString() !== coachIdText && classData.assistantCoach?.toString() !== coachIdText;
      });
      if (unauthorizedClass) {
        return res.status(403).json({ success: false, message: "Access denied. You are not assigned to this class." });
      }
    }

    let successCount = 0;
    let totalRecipientCount = 0;
    const broadcastRooms = [];
    const messages = [];

    const coachName = req.admin.name || req.admin.fullName || "Coach";

    for (const classData of classesData) {
      if (classData.term) {
        const term = await Term.findById(classData.term).select("status").lean();
        if (term?.status === "COMPLETED") {
          return res.status(409).json({ success: false, message: "This term has finished and its class chat is read-only" });
        }
      }
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
          scope: "CLASS",
          audience: "CLASS_PARENTS",
          scopeType: "CLASS",
          scopeLabel: `${classData.name} · Class chat`,
          audienceType: "PARENTS",
          recipientCount: parentIds.length,
          entityStatus: classData.status || "ACTIVE",
          classId: classData._id,
          termId: classData.term || null,
          programId: classData.program || null,
          createdBy: coachId,
          participantPlayerIds: classData.players.map((player) => player._id),
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

        broadcastRoom.scope = broadcastRoom.scope || "CLASS";
        broadcastRoom.audience = broadcastRoom.audience || "CLASS_PARENTS";
        broadcastRoom.scopeType = "CLASS";
        broadcastRoom.scopeLabel = `${classData.name} · Class chat`;
        broadcastRoom.audienceType = "PARENTS";
        broadcastRoom.recipientCount = parentIds.length;
        broadcastRoom.entityStatus = classData.status || "ACTIVE";
        broadcastRoom.termId = broadcastRoom.termId || classData.term || null;
        broadcastRoom.programId = broadcastRoom.programId || classData.program || null;
        broadcastRoom.participantPlayerIds = classData.players.map((player) => player._id);

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
      broadcastRoom.lastActivityAt = broadcastRoom.updatedAt;
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

/**
 * Send a broadcast to parents whose children are registered for one event day.
 * Event dates are calendar dates, so the YYYY-MM-DD value is preserved instead
 * of being converted through a JavaScript timezone parser.
 */
exports.sendEventDayBroadcast = async (req, res) => {
  try {
    if (!req.admin) {
      return res.status(403).json({ success: false, message: "Access denied. Coach or Admin role required for broadcast." });
    }

    const { eventId } = req.params;
    const { sessionDate, campSessionId, text } = req.body || {};
    if (!mongoose.Types.ObjectId.isValid(eventId)) {
      return res.status(400).json({ success: false, message: "A valid eventId is required" });
    }
    if (!text || !String(text).trim()) {
      return res.status(400).json({ success: false, message: "Message text is required" });
    }
    if (!sessionDate) {
      return res.status(400).json({ success: false, message: "sessionDate is required (YYYY-MM-DD)" });
    }

    const audience = await resolveEventDayAudience({ eventId, sessionDate, campSessionId: campSessionId || null });
    const { event, normalizedDate, selectedSession, parentIds, participantPlayerIds } = audience;

    if (parentIds.length === 0) {
      return res.status(400).json({ success: false, message: "No registered parents found for this event day" });
    }

    const senderId = req.admin._id;
    let room = await ChatRoom.findOne({
      type: "BROADCAST",
      eventId,
      eventSessionDate: normalizedDate,
      campSessionId: selectedSession?._id || null,
    });
    if (!room) {
      room = await ChatRoom.create({
        type: "BROADCAST",
        scope: "EVENT_DAY",
        audience: "EVENT_PARENTS",
        scopeType: "EVENT_DAY",
        scopeLabel: `${event.title} · ${normalizedDate}${selectedSession ? ` · ${selectedSession.sessionLabel || selectedSession.sessionType}` : " · All sessions"}`,
        audienceType: "PARENTS",
        recipientCount: parentIds.length,
        entityStatus: event.termId?.status === "COMPLETED" ? "COMPLETED" : (event.status || "ACTIVE"),
        termId: event.termId?._id || event.termId || null,
        eventId,
        eventSessionDate: normalizedDate,
        campSessionId: selectedSession?._id || null,
        eventSessionType: selectedSession?.sessionType || null,
        createdBy: senderId,
        participantPlayerIds,
        name: `${event.title} · ${normalizedDate}${selectedSession ? ` · ${selectedSession.sessionLabel || selectedSession.sessionType}` : " · All sessions"}`,
        members: [
          { refModel: "Admin", user: senderId },
          ...parentIds.map((parentId) => ({ refModel: "Parent", user: parentId })),
        ],
      });
    } else {
      const existing = room.members.map((member) => `${member.refModel}:${member.user.toString()}`);
      if (!existing.includes(`Admin:${senderId.toString()}`)) room.members.push({ refModel: "Admin", user: senderId });
      for (const parentId of parentIds) {
        if (!existing.includes(`Parent:${parentId}`)) room.members.push({ refModel: "Parent", user: parentId });
      }
      room.scopeType = "EVENT_DAY";
      room.scope = room.scope || "EVENT_DAY";
      room.audience = room.audience || "EVENT_PARENTS";
      room.scopeLabel = `${event.title} · ${normalizedDate}${selectedSession ? ` · ${selectedSession.sessionLabel || selectedSession.sessionType}` : " · All sessions"}`;
      room.audienceType = "PARENTS";
      room.recipientCount = parentIds.length;
      room.entityStatus = event.termId?.status === "COMPLETED" ? "COMPLETED" : (event.status || "ACTIVE");
      room.termId = room.termId || event.termId?._id || event.termId || null;
      room.eventSessionType = selectedSession?.sessionType || null;
      room.participantPlayerIds = participantPlayerIds;
      await room.save();
    }

    const messageText = String(text).trim();
    const message = await Message.create({
      room: room._id,
      sender: { refModel: "Admin", user: senderId },
      text: messageText,
      readReceipts: [{ user: senderId, readAt: new Date() }],
    });
    room.lastMessage = {
      text: messageText,
      sender: senderId,
      senderModel: "Admin",
      senderName: req.admin.name || req.admin.fullName || "Coach",
      timestamp: new Date(),
      type: "TEXT",
    };
    room.updatedAt = new Date();
    room.lastActivityAt = room.updatedAt;
    await room.save();

    // Keep an already-open event-day room in sync without requiring a refresh.
    // The persistent room metadata above remains the source of truth for users
    // who open the day chat later.
    try {
      const io = getIO();
      if (io) {
        const populatedMessage = await Message.findById(message._id)
          .populate("sender.user", "name fullName email profileImage")
          .lean();
        io.to(`room_${room._id}`).emit("new_message", {
          roomId: room._id.toString(),
          message: populatedMessage,
          context: {
            scope: "EVENT_DAY",
            eventId: eventId.toString(),
            sessionDate: normalizedDate,
            campSessionId: selectedSession?._id?.toString() || null,
          },
        });
      }
    } catch (socketError) {
      // A socket delivery failure must not fail a successfully persisted broadcast.
      console.warn("Event day broadcast socket delivery skipped:", socketError.message);
    }

    for (const parentId of parentIds) {
      sendNotification({
        recipientType: "PARENT",
        parentId,
        title: `${event.title} day update`,
        message: `${req.admin.name || req.admin.fullName || "Coach"}: ${messageText.substring(0, 100)}${messageText.length > 100 ? "..." : ""}`,
        type: "EVENT_DAY_BROADCAST",
        data: {
          roomId: room._id.toString(),
          eventId: eventId.toString(),
          sessionDate: normalizedDate,
          campSessionId: selectedSession?._id?.toString() || null,
          messageId: message._id.toString(),
        },
      }).catch((error) => console.error("Event day broadcast notification error:", error.message));
    }

    return res.status(201).json({
      success: true,
      message: `Event day broadcast sent to ${parentIds.length} parent(s)`,
      data: {
        room,
        message,
        recipientCount: parentIds.length,
        eventId,
        sessionDate: normalizedDate,
        campSessionId: selectedSession?._id || null,
        sessionLabel: selectedSession?.sessionLabel || (selectedSession ? selectedSession.sessionType : "All sessions"),
      },
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
};

/** Send a broadcast to every parent with a child currently assigned to a team. */
exports.sendTeamBroadcast = async (req, res) => {
  try {
    if (!req.admin) {
      return res.status(403).json({ success: false, message: "Access denied. Coach or Admin role required for broadcast." });
    }
    const { teamId } = req.params;
    const { text } = req.body || {};
    if (!mongoose.Types.ObjectId.isValid(teamId)) return res.status(400).json({ success: false, message: "A valid teamId is required" });
    if (!text || !String(text).trim()) return res.status(400).json({ success: false, message: "Message text is required" });

    const team = await Team.findById(teamId)
      .select("_id teamName players coach assistantCoach term")
      .populate({ path: "players.player", select: "_id parentId", populate: { path: "parentId", select: "_id" } });
    if (!team) return res.status(404).json({ success: false, message: "Team not found" });

    if (team.term) {
      const term = await Term.findById(team.term).select("status").lean();
      if (term?.status === "COMPLETED") {
        return res.status(409).json({ success: false, message: "This term has finished and its team chat is read-only" });
      }
    }

    if (req.admin.role === "COACH" && team.coach?.toString() !== req.admin._id.toString() && team.assistantCoach?.toString() !== req.admin._id.toString()) {
      return res.status(403).json({ success: false, message: "Access denied. You are not assigned to this team." });
    }

    const parentIds = [...new Set(
      (team.players || [])
        .map((entry) => entry.player?.parentId?._id || entry.player?.parentId)
        .filter(Boolean)
        .map((parentId) => parentId.toString())
    )];
    if (parentIds.length === 0) return res.status(400).json({ success: false, message: "No parents found for players assigned to this team" });

    const senderId = req.admin._id;
    let room = await ChatRoom.findOne({ type: "BROADCAST", teamId });
    if (!room) {
      room = await ChatRoom.create({
        type: "BROADCAST",
        scope: "TEAM",
        audience: "TEAM_PARENTS",
        scopeType: "TEAM",
        scopeLabel: `${team.teamName} · Team chat`,
        audienceType: "TEAM",
        recipientCount: parentIds.length,
        entityStatus: "ACTIVE",
        teamId,
        termId: team.term || null,
        createdBy: senderId,
        participantPlayerIds: (team.players || []).map((entry) => entry.player?._id || entry.player).filter(Boolean),
        name: `${team.teamName} - Team Broadcast`,
        members: [
          { refModel: "Admin", user: senderId },
          ...parentIds.map((parentId) => ({ refModel: "Parent", user: parentId })),
        ],
      });
    } else {
      const existing = room.members.map((member) => `${member.refModel}:${member.user.toString()}`);
      if (!existing.includes(`Admin:${senderId.toString()}`)) room.members.push({ refModel: "Admin", user: senderId });
      for (const parentId of parentIds) {
        if (!existing.includes(`Parent:${parentId}`)) room.members.push({ refModel: "Parent", user: parentId });
      }
      room.scope = room.scope || "TEAM";
      room.audience = room.audience || "TEAM_PARENTS";
      room.scopeType = "TEAM";
      room.scopeLabel = `${team.teamName} · Team chat`;
      room.audienceType = "TEAM";
      room.recipientCount = parentIds.length;
      room.termId = room.termId || team.term || null;
      room.participantPlayerIds = (team.players || []).map((entry) => entry.player?._id || entry.player).filter(Boolean);
      await room.save();
    }

    const messageText = String(text).trim();
    const message = await Message.create({
      room: room._id,
      sender: { refModel: "Admin", user: senderId },
      text: messageText,
      readReceipts: [{ user: senderId, readAt: new Date() }],
    });
    room.lastMessage = {
      text: messageText,
      sender: senderId,
      senderModel: "Admin",
      senderName: req.admin.name || req.admin.fullName || "Coach",
      timestamp: new Date(),
      type: "TEXT",
    };
    room.updatedAt = new Date();
    room.lastActivityAt = room.updatedAt;
    await room.save();

    for (const parentId of parentIds) {
      sendNotification({
        recipientType: "PARENT",
        parentId,
        title: `${team.teamName} team update`,
        message: `${req.admin.name || req.admin.fullName || "Coach"}: ${messageText.substring(0, 100)}${messageText.length > 100 ? "..." : ""}`,
        type: "TEAM_BROADCAST",
        data: { roomId: room._id.toString(), teamId: teamId.toString(), messageId: message._id.toString() },
      }).catch((error) => console.error("Team broadcast notification error:", error.message));
    }

    return res.status(201).json({
      success: true,
      message: `Team broadcast sent to ${parentIds.length} parent(s)`,
      data: { room, message, recipientCount: parentIds.length, teamId },
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

/** Open (or create) the parent chat for a league's registered players. */
exports.openLeagueChat = async (req, res) => {
  try {
    if (!req.admin) {
      return res.status(403).json({ success: false, message: "Coach or Admin role required for league chat." });
    }
    const { leagueId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(leagueId)) {
      return res.status(400).json({ success: false, message: "A valid leagueId is required" });
    }

    const league = await League.findById(leagueId)
      .select("_id name season status term teams")
      .populate("term", "status")
      .lean();
    if (!league) return res.status(404).json({ success: false, message: "League not found" });
    if (league.status === "COMPLETED") {
      return res.status(409).json({ success: false, message: "This league has finished; its chat is read-only." });
    }
    if (league.term?.status === "COMPLETED") {
      return res.status(409).json({ success: false, message: "This league's term has finished; its chat is read-only." });
    }

    const teams = await Team.find({ _id: { $in: league.teams || [] } })
      .select("_id coach assistantCoach players leagues")
      .populate({ path: "players.player", select: "_id parentId", populate: { path: "parentId", select: "_id" } })
      .populate({ path: "leagues.players.player", select: "_id parentId", populate: { path: "parentId", select: "_id" } });

    if (String(req.admin.role || "").toUpperCase() === "COACH" &&
      !teams.some((team) => team.coach?.toString() === req.admin._id.toString() || team.assistantCoach?.toString() === req.admin._id.toString())) {
      return res.status(403).json({ success: false, message: "You are not assigned to a team in this league." });
    }

    const leaguePlayers = [];
    for (const team of teams) {
      const leagueEntry = (team.leagues || []).find((entry) => entry.league?.toString() === leagueId);
      const roster = leagueEntry?.players?.length ? leagueEntry.players : team.players || [];
      for (const entry of roster) {
        if (entry.status && entry.status !== "ACTIVE") continue;
        if (entry.player?._id || entry.player) leaguePlayers.push(entry.player);
      }
    }
    const parentsById = new Map();
    for (const player of leaguePlayers) {
      const parentId = player?.parentId?._id || player?.parentId;
      if (parentId) parentsById.set(parentId.toString(), parentId);
    }
    const parentIds = [...parentsById.values()];
    if (!parentIds.length) {
      return res.status(404).json({ success: false, message: "No registered player parents are available for this league chat." });
    }

    const termId = league.term?._id || league.term || null;
    let room = await ChatRoom.findOne({ type: "BROADCAST", scopeType: "LEAGUE", leagueId, termId });
    if (!room) {
      room = await ChatRoom.create({
        type: "BROADCAST",
        scope: "LEAGUE",
        audience: "LEAGUE_PARENTS",
        scopeType: "LEAGUE",
        scopeLabel: `${league.name} · League chat`,
        audienceType: "LEAGUE",
        recipientCount: parentIds.length,
        entityStatus: "ACTIVE",
        leagueId,
        termId,
        createdBy: req.admin._id,
        participantPlayerIds: leaguePlayers.map((player) => player._id || player),
        name: `${league.name} - League Chat`,
        subtitle: league.season || "League parents",
        members: [
          { refModel: "Admin", user: req.admin._id },
          ...parentIds.map((parentId) => ({ refModel: "Parent", user: parentId })),
        ],
      });
    } else {
      const members = new Set(room.members.map((member) => `${member.refModel}:${member.user.toString()}`));
      for (const parentId of parentIds) {
        if (!members.has(`Parent:${parentId.toString()}`)) room.members.push({ refModel: "Parent", user: parentId });
      }
      if (!members.has(`Admin:${req.admin._id.toString()}`)) room.members.push({ refModel: "Admin", user: req.admin._id });
      room.scope = "LEAGUE";
      room.audience = "LEAGUE_PARENTS";
      room.scopeType = "LEAGUE";
      room.scopeLabel = `${league.name} · League chat`;
      room.audienceType = "LEAGUE";
      room.recipientCount = parentIds.length;
      room.participantPlayerIds = leaguePlayers.map((player) => player._id || player);
      await room.save();
    }

    const populatedRoom = await ChatRoom.findById(room._id)
      .populate("members.user", "name fullName email phone profileImage role")
      .populate("leagueId", "name season logo")
      .populate("termId", "name year startDate endDate status");
    return res.json({ success: true, data: conversationResponse(populatedRoom, { currentUserId: req.admin._id }) });
  } catch (error) {
    console.error("Open league chat error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

/** Open or initialize a class conversation without sending a placeholder message. */
exports.openClassChat = async (req, res) => {
  try {
    if (!req.admin) return res.status(403).json({ success: false, message: "Coach or Admin role required for class chat." });
    const { classId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(classId)) return res.status(400).json({ success: false, message: "A valid classId is required" });
    const classData = await Class.findById(classId)
      .populate("players", "_id parentId fullName")
      .populate("term", "name year status")
      .populate("program", "name ageGroup")
      .populate("category", "name");
    if (!classData) return res.status(404).json({ success: false, message: "Class not found" });
    if (classData.term?.status === "COMPLETED" || classData.status === "COMPLETED") return res.status(409).json({ success: false, message: "This class chat is completed and read-only." });
    if (req.admin.role === "COACH" && classData.coach?.toString() !== req.admin._id.toString() && classData.assistantCoach?.toString() !== req.admin._id.toString()) {
      return res.status(403).json({ success: false, message: "You are not assigned to this class." });
    }
    const parentIds = [...new Set((classData.players || []).map((player) => player.parentId?._id || player.parentId).filter(Boolean).map((id) => id.toString()))];
    if (!parentIds.length) return res.status(404).json({ success: false, message: "No player parents are available for this class chat." });

    const termId = classData.term?._id || classData.term || null;
    let room = await ChatRoom.findOne({ type: "BROADCAST", scopeType: "CLASS", classId: classData._id, termId });
    if (!room) {
      room = await ChatRoom.create({
        type: "BROADCAST", scope: "CLASS", audience: "CLASS_PARENTS", scopeType: "CLASS",
        scopeLabel: `${classData.name} · Class chat`, audienceType: "PARENTS", recipientCount: parentIds.length,
        entityStatus: classData.status || "ACTIVE", classId: classData._id, termId,
        programId: classData.program?._id || classData.program || null, createdBy: req.admin._id,
        participantPlayerIds: (classData.players || []).map((player) => player._id),
        name: `${classData.name} - Class Chat`,
        members: [{ refModel: "Admin", user: req.admin._id }, ...parentIds.map((user) => ({ refModel: "Parent", user }))],
      });
    } else {
      const existing = new Set(room.members.map((member) => `${member.refModel}:${member.user.toString()}`));
      for (const parentId of parentIds) if (!existing.has(`Parent:${parentId}`)) room.members.push({ refModel: "Parent", user: parentId });
      if (!existing.has(`Admin:${req.admin._id}`)) room.members.push({ refModel: "Admin", user: req.admin._id });
      room.scope = "CLASS"; room.audience = "CLASS_PARENTS"; room.scopeType = "CLASS"; room.audienceType = "PARENTS";
      room.scopeLabel = `${classData.name} · Class chat`; room.recipientCount = parentIds.length;
      room.termId = termId;
      room.programId = classData.program?._id || classData.program || null;
      room.participantPlayerIds = (classData.players || []).map((player) => player._id);
      await room.save();
    }
    const populatedRoom = await ChatRoom.findById(room._id)
      .populate("members.user", "name fullName email phone profileImage role")
      .populate("classId", "name term program category")
      .populate("termId", "name year startDate endDate status")
      .populate("programId", "name ageGroup");
    return res.json({ success: true, data: conversationResponse(populatedRoom, { currentUserId: req.admin._id }) });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

/** Open or initialize a team conversation without sending a placeholder message. */
exports.openTeamChat = async (req, res) => {
  try {
    if (!req.admin) return res.status(403).json({ success: false, message: "Coach or Admin role required for team chat." });
    const { teamId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(teamId)) return res.status(400).json({ success: false, message: "A valid teamId is required" });
    const team = await Team.findById(teamId)
      .select("_id teamName logo coach assistantCoach players term")
      .populate({ path: "players.player", select: "_id parentId", populate: { path: "parentId", select: "_id" } })
      .populate("term", "name year status");
    if (!team) return res.status(404).json({ success: false, message: "Team not found" });
    if (team.term?.status === "COMPLETED") return res.status(409).json({ success: false, message: "This team's term has finished; its chat is read-only." });
    if (req.admin.role === "COACH" && team.coach?.toString() !== req.admin._id.toString() && team.assistantCoach?.toString() !== req.admin._id.toString()) {
      return res.status(403).json({ success: false, message: "You are not assigned to this team." });
    }
    const roster = team.players || [];
    const parentIds = [...new Set(roster.map((entry) => entry.player?.parentId?._id || entry.player?.parentId).filter(Boolean).map((id) => id.toString()))];
    if (!parentIds.length) return res.status(404).json({ success: false, message: "No player parents are available for this team chat." });

    const termId = team.term?._id || team.term || null;
    let room = await ChatRoom.findOne({ type: "BROADCAST", scopeType: "TEAM", teamId: team._id, termId });
    if (!room) {
      room = await ChatRoom.create({
        type: "BROADCAST", scope: "TEAM", audience: "TEAM_PARENTS", scopeType: "TEAM",
        scopeLabel: `${team.teamName} · Team chat`, audienceType: "TEAM", recipientCount: parentIds.length,
        entityStatus: "ACTIVE", teamId: team._id, termId,
        createdBy: req.admin._id, participantPlayerIds: roster.map((entry) => entry.player?._id || entry.player).filter(Boolean),
        name: `${team.teamName} - Team Chat`,
        members: [{ refModel: "Admin", user: req.admin._id }, ...parentIds.map((user) => ({ refModel: "Parent", user }))],
      });
    } else {
      const existing = new Set(room.members.map((member) => `${member.refModel}:${member.user.toString()}`));
      for (const parentId of parentIds) if (!existing.has(`Parent:${parentId}`)) room.members.push({ refModel: "Parent", user: parentId });
      if (!existing.has(`Admin:${req.admin._id}`)) room.members.push({ refModel: "Admin", user: req.admin._id });
      room.scope = "TEAM"; room.audience = "TEAM_PARENTS"; room.scopeType = "TEAM"; room.scopeLabel = `${team.teamName} · Team chat`;
      room.audienceType = "TEAM"; room.recipientCount = parentIds.length; room.termId = termId;
      room.participantPlayerIds = roster.map((entry) => entry.player?._id || entry.player).filter(Boolean);
      await room.save();
    }
    const populatedRoom = await ChatRoom.findById(room._id)
      .populate("members.user", "name fullName email phone profileImage role")
      .populate("teamId", "teamName logo")
      .populate("termId", "name year startDate endDate status");
    return res.json({ success: true, data: conversationResponse(populatedRoom, { currentUserId: req.admin._id }) });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

/** Open a chat for the parents registered on one holiday-camp date/session. */
exports.openEventDayChat = async (req, res) => {
  try {
    if (!req.admin) return res.status(403).json({ success: false, message: "Coach or Admin role required for event chat." });
    const { eventId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(eventId)) return res.status(400).json({ success: false, message: "A valid eventId is required" });
    const { sessionDate, campSessionId } = req.body || {};
    if (!sessionDate) return res.status(400).json({ success: false, message: "sessionDate is required (YYYY-MM-DD)" });
    const audience = await resolveEventDayAudience({ eventId, sessionDate, campSessionId: campSessionId || null });
    const { event, normalizedDate, selectedSession, parentIds, participantPlayerIds } = audience;
    if (event.status === "COMPLETED" || event.termId?.status === "COMPLETED") return res.status(409).json({ success: false, message: "This event or term has finished; its chat is read-only." });
    if (!parentIds.length) return res.status(404).json({ success: false, message: "No registered parents are available for this event day chat." });
    const senderId = req.admin._id;
    const roomQuery = { type: "BROADCAST", eventId, eventSessionDate: normalizedDate, campSessionId: selectedSession?._id || null };
    let room = await ChatRoom.findOne(roomQuery);
    const label = `${event.title} · ${normalizedDate}${selectedSession ? ` · ${selectedSession.sessionLabel || selectedSession.sessionType}` : " · All sessions"}`;
    if (!room) {
      room = await ChatRoom.create({
        type: "BROADCAST", scope: "EVENT_DAY", audience: "EVENT_PARENTS", scopeType: "EVENT_DAY", scopeLabel: label,
        audienceType: "PARENTS", recipientCount: parentIds.length, entityStatus: event.status || "ACTIVE",
        termId: event.termId?._id || event.termId || null, eventId, eventSessionDate: normalizedDate,
        campSessionId: selectedSession?._id || null, eventSessionType: selectedSession?.sessionType || null,
        createdBy: senderId, participantPlayerIds,
        name: label, members: [{ refModel: "Admin", user: senderId }, ...parentIds.map((user) => ({ refModel: "Parent", user }))],
      });
    } else {
      const existing = new Set(room.members.map((member) => `${member.refModel}:${member.user.toString()}`));
      for (const parentId of parentIds) if (!existing.has(`Parent:${parentId}`)) room.members.push({ refModel: "Parent", user: parentId });
      if (!existing.has(`Admin:${senderId}`)) room.members.push({ refModel: "Admin", user: senderId });
      room.scope = "EVENT_DAY"; room.audience = "EVENT_PARENTS"; room.scopeType = "EVENT_DAY"; room.scopeLabel = label;
      room.audienceType = "PARENTS"; room.recipientCount = parentIds.length; room.entityStatus = event.status || "ACTIVE";
      room.termId = event.termId?._id || event.termId || null; room.eventSessionType = selectedSession?.sessionType || null;
      room.participantPlayerIds = participantPlayerIds;
      await room.save();
    }
    const populatedRoom = await ChatRoom.findById(room._id)
      .populate("members.user", "name fullName email phone profileImage role")
      .populate("eventId", "title eventType startDate endDate")
      .populate("termId", "name year startDate endDate status");
    return res.json({ success: true, data: conversationResponse(populatedRoom, { currentUserId: senderId }) });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ success: false, message: error.message });
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

    const room = await ChatRoom.findById(roomId)
      .populate("termId", "status")
      .populate("eventId", "status");
    if (!room) {
      return res.status(404).json({ success: false, message: "Chat room not found" });
    }

    const actor = getActor(req);
    if (!isRoomMember(room, actor) && (!req.admin || req.admin.role !== "SUPER_ADMIN")) {
      return res.status(403).json({
        success: false,
        message: "Access denied. You are not a member of this chat room.",
      });
    }
    if (room.isActive === false || room.entityStatus === "COMPLETED" || room.termId?.status === "COMPLETED" || room.eventId?.status === "COMPLETED") {
      return res.status(409).json({ success: false, message: "This chat is closed because its term or event has finished" });
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
    room.lastActivityAt = room.updatedAt;
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

    let { page = 1, limit = 20, scope, search } = req.query;

    page = Number(page);
    limit = Number(limit);

    const query = {
      "members.user": currentUserId,
      "members.refModel": currentModel,
      isActive: { $ne: false },
    };

    if (scope) query.scope = String(scope).toUpperCase();
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

    if (req.admin && req.admin.role === "SUPER_ADMIN") {
      delete query["members.user"];
      delete query["members.refModel"];
    }

    const total = await ChatRoom.countDocuments(query);

    const rooms = await ChatRoom.find(query)
      .populate("members.user", "name fullName email phone profileImage")
      .populate("classId", "name")
      .populate("eventId", "title eventType startDate endDate status")
      .populate("teamId", "teamName logo")
      .populate("leagueId", "name season logo")
      .populate("programId", "name ageGroup")
      .populate("termId", "name year startDate endDate status")
      .sort({ updatedAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit);

    let roomsWithLastMessage = await Promise.all(
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

        return conversationResponse(room, {
          currentUserId,
          lastMessage,
          unreadCount,
          onlineCount: isPartnerOnline ? 1 : 0,
        });
      })
    );

    if (!(req.admin && ["SUPER_ADMIN", "ADMIN"].includes(String(req.admin.role || "").toUpperCase()))) {
      roomsWithLastMessage = roomsWithLastMessage.filter((room) =>
        room.status !== "ARCHIVED" && room.chatStatus !== "ARCHIVED" && room.entityStatus !== "COMPLETED"
      );
    }

    if (search) {
      const needle = String(search).trim().toLowerCase();
      roomsWithLastMessage = roomsWithLastMessage.filter((room) => {
        const values = [room.name, room.scopeLabel, room.context?.contextName, room.lastMessage?.text];
        return values.some((value) => value && String(value).toLowerCase().includes(needle)) ||
          room.members.some((member) => String(member.name || "").toLowerCase().includes(needle));
      });
    }

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

      const isMember = isRoomMember(room, getActor(req));

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
      tickStatus: calculateTickStatus(m, currentUserId),
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
    let { page = 1, limit = 20, search, coachId, scope, type, classId, eventId, teamId, leagueId, termId, status } = req.query;

    page = Math.max(1, Number(page) || 1);
    limit = Math.min(100, Math.max(1, Number(limit) || 20));

    const query = {};

    if (coachId) {
      query["members.user"] = coachId;
      query["members.refModel"] = "Admin";
    }
    if (scope) query.scope = String(scope).toUpperCase();
    else if (type) query.type = String(type).toUpperCase();
    if (classId && validObjectId(classId)) query.classId = classId;
    if (eventId && validObjectId(eventId)) query.eventId = eventId;
    if (teamId && validObjectId(teamId)) query.teamId = teamId;
    if (leagueId && validObjectId(leagueId)) query.leagueId = leagueId;
    if (termId && validObjectId(termId)) query.termId = termId;
    if (status === "ARCHIVED") query.isActive = false;
    else if (status === "ACTIVE") query.isActive = { $ne: false };

    let rooms = await ChatRoom.find(query)
      .populate("members.user", "name fullName email phone profileImage role")
      .populate("classId", "name term program category")
      .populate("eventId", "title eventType status startDate endDate")
      .populate("teamId", "teamName logo term")
      .populate("leagueId", "name season logo status")
      .populate("programId", "name ageGroup")
      .populate("termId", "name year startDate endDate")
      .sort({ lastActivityAt: -1, updatedAt: -1 });

    if (search) {
      const needle = String(search).trim().toLowerCase();
      rooms = rooms.filter((room) => {
        const raw = room.toObject();
        const contextName = raw.classId?.name || raw.eventId?.title || raw.teamId?.teamName || raw.leagueId?.name || raw.programId?.name || "";
        const values = [raw.name, raw.scopeLabel, raw.scopeType, contextName, raw.eventSessionDate, raw.eventSessionType];
        return values.some((value) => value && String(value).toLowerCase().includes(needle)) ||
          (raw.members || []).some((member) => {
            const user = member.user || {};
            return [user.name, user.fullName, user.email, user.phone].some((value) => value && String(value).toLowerCase().includes(needle));
          });
      });
    }

    const total = rooms.length;
    rooms = rooms.slice((page - 1) * limit, page * limit);

    const enrichedRooms = await Promise.all(
      rooms.map(async (room) => {
        const lastMessage = await Message.findOne({ room: room._id })
          .sort({ createdAt: -1 })
          .select("text attachments sender createdAt status readReceipts deliveredTo")
          .lean();

        const messageCount = await Message.countDocuments({ room: room._id });
        const unreadCount = await Message.countDocuments({ room: room._id, "readReceipts.user": { $ne: req.admin?._id } });

        return {
          ...conversationResponse(room, { currentUserId: req.admin?._id, unreadCount, lastMessage }),
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
