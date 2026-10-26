const mongoose = require("mongoose");

const ROOM_SCOPES = Object.freeze([
  "DIRECT",
  "CLASS",
  "EVENT_DAY",
  "TEAM",
  "LEAGUE",
  "PROGRAM",
  "GROUP",
]);

const getActor = (req) => {
  if (req?.admin?._id) {
    return { _id: req.admin._id, id: req.admin._id, model: "Admin", role: req.admin.role || "COACH" };
  }
  const parent = req?.parent || req?.user;
  if (parent?._id) return { _id: parent._id, id: parent._id, model: "Parent", role: "PARENT" };
  return null;
};

const normalizeRoomScope = (room) => {
  if (!room) return null;
  if (ROOM_SCOPES.includes(room.scope)) return room.scope;
  if (ROOM_SCOPES.includes(room.scopeType) && room.scopeType !== "DIRECT") return room.scopeType;
  if (room.type === "DIRECT" && room.scopeType === "DIRECT") return "DIRECT";
  if (room.type === "DIRECT") return "DIRECT";
  if (room.eventId) return "EVENT_DAY";
  if (room.leagueId) return "LEAGUE";
  if (room.teamId) return "TEAM";
  if (room.programId) return "PROGRAM";
  if (room.classId) return "CLASS";
  return room.type === "GROUP" ? "GROUP" : null;
};

const roomTermId = (room) => {
  if (!room) return null;
  const term = room.termId || room.term;
  return term?._id ? term._id.toString() : term ? term.toString() : null;
};

const memberKey = (member) => `${member?.refModel || ""}:${member?.user?._id || member?.user || ""}`;

const isRoomMember = (room, actor) => {
  if (!room || !actor?._id) return false;
  const id = actor._id.toString();
  return (room.members || []).some(
    (member) => member.refModel === actor.model && member.user?.toString() === id
  );
};

const displayName = (user) => user?.fullName || user?.name || user?.email || "Unknown user";

const roomContext = (room) => {
  const scope = normalizeRoomScope(room);
  const contextId =
    room?.classId?._id || room?.classId ||
    room?.eventId?._id || room?.eventId ||
    room?.teamId?._id || room?.teamId ||
    room?.leagueId?._id || room?.leagueId ||
    room?.programId?._id || room?.programId || null;
  const context = room?.classId || room?.eventId || room?.teamId || room?.leagueId || room?.programId;
  return {
    scope,
    contextId: contextId ? contextId.toString() : null,
    classId: room?.classId?._id || room?.classId || null,
    eventId: room?.eventId?._id || room?.eventId || null,
    teamId: room?.teamId?._id || room?.teamId || null,
    leagueId: room?.leagueId?._id || room?.leagueId || null,
    programId: room?.programId?._id || room?.programId || null,
    termId: roomTermId(room),
    eventSessionDate: room?.eventSessionDate || null,
    campSessionId: room?.campSessionId?._id || room?.campSessionId || null,
    contextName: context?.name || context?.title || context?.teamName || room?.name || "",
  };
};

const conversationAudience = (room) => {
  if (room?.audience) return room.audience;
  if (room?.audienceType === "PARENTS") {
    const scope = normalizeRoomScope(room);
    if (scope === "EVENT_DAY") return "EVENT_PARENTS";
    if (scope === "TEAM") return "TEAM_PARENTS";
    return "CLASS_PARENTS";
  }
  const scope = normalizeRoomScope(room);
  if (scope === "DIRECT") return "PARENT_COACH";
  if (scope === "EVENT_DAY") return "EVENT_PARENTS";
  if (scope === "TEAM") return "TEAM_PARENTS";
  if (scope === "LEAGUE") return "LEAGUE_PARENTS";
  if (scope === "PROGRAM") return "PROGRAM_PARENTS";
  if (scope === "CLASS") return "CLASS_PARENTS";
  return "CUSTOM";
};

const conversationResponse = (room, { currentUserId, unreadCount = 0, onlineCount = 0, lastMessage = null } = {}) => {
  const plain = typeof room.toObject === "function" ? room.toObject() : room;
  const context = roomContext(plain);
  const members = (plain.members || []).map((member) => ({
    // Keep the legacy nested user shape for older clients while exposing the
    // normalized fields used by the communication centre.
    user: member.user || null,
    refModel: member.refModel || member.model,
    id: member.user?._id || member.user || null,
    model: member.refModel,
    name: displayName(member.user),
    email: member.user?.email || null,
    profileImage: member.user?.profileImage || null,
    role: member.user?.role || member.refModel,
    isCurrentUser: currentUserId ? (member.user?._id || member.user)?.toString() === currentUserId.toString() : false,
  }));
  const effectiveLastMessage = lastMessage || plain.lastMessage || null;
  return {
    ...plain,
    status: plain.isActive === false || plain.entityStatus === "COMPLETED" || plain.termId?.status === "COMPLETED" || plain.eventId?.status === "COMPLETED" ? "ARCHIVED" : "ACTIVE",
    chatStatus: plain.isActive === false || plain.entityStatus === "COMPLETED" || plain.termId?.status === "COMPLETED" || plain.eventId?.status === "COMPLETED" ? "ARCHIVED" : "OPEN",
    scope: context.scope,
    audience: conversationAudience(plain),
    context,
    participantCount: members.length,
    onlineCount,
    unreadCount,
    lastActivityAt: plain.lastActivityAt || effectiveLastMessage?.createdAt || effectiveLastMessage?.timestamp || plain.updatedAt,
    lastMessage: effectiveLastMessage,
    members,
  };
};

const validObjectId = (value) => Boolean(value && mongoose.Types.ObjectId.isValid(value));

module.exports = {
  ROOM_SCOPES,
  getActor,
  normalizeRoomScope,
  roomTermId,
  memberKey,
  isRoomMember,
  conversationAudience,
  conversationResponse,
  validObjectId,
};
