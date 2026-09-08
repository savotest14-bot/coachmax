const express = require("express");
const auth = require("../middleware/authMiddleware");
const { isCoach } = require("../middleware/isCoach");
const { uploads } = require("../utils/upload");

const {
  getCoachDashboard,
  getMyAssignedClasses,
  getAssignedClassById,
  getMyAssignedTeams,
  getPlayerProfile,
  getClassPlayers,
  getUniquePlayersByCoach,
  getPlayerDetails,
  getClassDropdown,
} = require("../controllers/coachController");

const {
  markAttendance,
  markSingleAttendance,
  getAttendanceByClass,
  getAttendanceByDate,
  markTeamAttendance,
  markSingleTeamAttendance,
  getAttendanceByTeam,
  getAttendanceByTeamDate,
} = require("../controllers/coachAttendanceController");

const {
  createTemporaryPlayer,
  getTemporaryPlayers,
} = require("../controllers/temporaryPlayerController");

const {
  createNote,
  updateNote,
  getNotesByPlayer,
  getMyNotes,
  getNoteAuditHistory,
} = require("../controllers/coachNoteController");
const {
  startDirectChat,
  sendClassBroadcast,
  sendMessage,
  getRoomMessages,
  getClassParents,
  deleteSingleMessage,
  deleteFullChatRoom,
} = require("../controllers/parentChatController");

const {
  getAdminNotifications,
  markAdminNotificationRead,
  markAllAdminNotificationsRead,
  saveAdminFcmToken,
} = require("../controllers/notificationController");
const { getMyRooms } = require("../controllers/chatController");

const router = express.Router();

// ─── Dashboard ──────────────────────────────
router.get("/dashboard", auth, isCoach, getCoachDashboard);

//  Assigned Classes & Teams ─────
router.get("/classes", auth, isCoach, getMyAssignedClasses);
router.get("/classes/:classId", auth, isCoach, getAssignedClassById);
router.get("/getClasses", auth, getClassDropdown)
router.get("/classes/:classId/players", auth, isCoach, getClassPlayers);
router.get("/teams", auth, isCoach, getMyAssignedTeams);
router.get("/unique-players", auth, isCoach, getUniquePlayersByCoach);
router.get("/unique-players/:coachId", auth, isCoach, getUniquePlayersByCoach);

// Attendance ───────────────────
router.post("/attendance/:classId", auth, isCoach, markAttendance);
router.post("/attendance/:classId/single", auth, isCoach, markSingleAttendance);
router.get("/attendance/:classId", auth, isCoach, getAttendanceByClass);
router.get("/attendance/:classId/date", auth, isCoach, getAttendanceByDate);

// ─── Team Attendance ──────────────────────────
router.post("/team-attendance/:teamId", auth, isCoach, markTeamAttendance);
router.post("/team-attendance/:teamId/single", auth, isCoach, markSingleTeamAttendance);
router.get("/team-attendance/:teamId", auth, isCoach, getAttendanceByTeam);
router.get("/team-attendance/:teamId/date", auth, isCoach, getAttendanceByTeamDate);

//  Player Profile / Quick Access ─
router.get("/player/:playerId/profile", auth, isCoach, getPlayerProfile);

//  Temporary Players ───────────
router.post("/temporary-players", auth, isCoach, createTemporaryPlayer);
router.get("/temporary-players", auth, isCoach, getTemporaryPlayers);

//  Coach Notes ─────────────────
router.post("/notes", auth, isCoach, createNote);
router.put("/notes/:noteId", auth, isCoach, updateNote);
router.get("/notes", auth, isCoach, getMyNotes);
router.get("/notes/player/:playerId", auth, isCoach, getNotesByPlayer);
router.get("/notes/:noteId/audit", auth, isCoach, getNoteAuditHistory);

//  Parent Communication ────────
router.post("/chat/direct", auth, startDirectChat);
router.post("/chat/broadcast/:classId", auth, sendClassBroadcast);
router.post("/chat/message", auth, uploads.single("file"), sendMessage);
router.get("/chat/rooms", auth, getMyRooms);
router.get("/chat/room/:roomId/messages", auth, getRoomMessages);
router.get("/chat/class/:classId/parents", auth, getClassParents);
router.delete("/chat/message/:messageId", auth, isCoach, deleteSingleMessage);
router.delete("/chat/room/:roomId", auth, isCoach, deleteFullChatRoom);

//  Coach Notifications ─────────
router.get("/notifications", auth, isCoach, getAdminNotifications);
router.patch("/notifications/read-all", auth, isCoach, markAllAdminNotificationsRead);
router.patch("/notifications/:notificationId/read", auth, isCoach, markAdminNotificationRead);
router.post("/fcm-token", auth, isCoach, saveAdminFcmToken);

router.get(
  "/player/:playerId",
  auth,
  isCoach,
  getPlayerDetails
);

module.exports = router;
