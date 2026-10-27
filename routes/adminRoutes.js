const express = require("express");
const {
  adminLogin,
  logout,
  updatePaymentStatus,
  getUsers,
  getPlayerStats,
  createBanner,
  updateBanner,
  deleteBanner,
  getAllBanners,
  toggleBannerStatus,
  exportUsers,
  createCategory,
  updateCategory,
  deletecatCategory,
  createProgram,
  updateProgram,
  deleteProgram,
  assignClassToUser,
  createTerm,
  deleteTerm,
  getAllTerms,
  getTermById,
  updateTerm,
  previewCloneTerm,
  cloneTerm,
  getAdminDashboardOverview,
  createClass,
  deleteClassPermanently,
  getAllClasses,
  getClassById,
  updateClass,
  duplicateClass,
  getCurrentYearTerms,
  getClassesByTerm,
  markAttendance,
  getAttendanceByClass,
  getClassSessions,
  getTeamSessions,
  getTeamFullTable,
  exportTeamCSV,
  createCoach,
  getAllCoaches,
  getCoachById,
  getCoachDetail,
  updateCoach,
  getClassPlayers,
  markSingleAttendance,
  getAttendanceByDate,
  assignCoachToClass,
  getCoachClassesWithSessions,
  getClassFullTable,
  getClassFiltersWithTimeSlots,
  exportClassCSV,
  getAllClassesForAssign,
  updatePlayerRating,
  removeClassFromUser,
  transferPlayerClass,
  getPlayerDetails,
  updatePlayer,
  changeCoachPassword,
  toggleCoachActiveStatus,
  getTermEarningsReport,
  getSidebarBadges,
} = require("../controllers/adminAuthController");

const {
  getAttendanceHistory,
  markTeamAttendance,
  markSingleTeamAttendance,
  getAttendanceByTeam,
  getAttendanceByTeamDate,
  getTeamAttendanceHistory,
} = require("../controllers/coachAttendanceController");

const {
  getAdminNotifications,
  markAdminNotificationRead,
  markAllAdminNotificationsRead,
  saveAdminFcmToken,
  sendAdminCustomNotification,
} = require("../controllers/notificationController");

const {
  createAssessment,
} = require("../controllers/assessmentController");

const {
  getUniquePlayersByCoach,
} = require("../controllers/coachController");

const {
  createTrainingSession,
  updateTrainingSession,
} = require("../controllers/trainingController");

const {
  createLeague,
  createTeam,
  assignPlayerToTeam,
  createFixture,
  recordMatchEvent,
  completeMatch,
  getAllTeams,
  getAllLeagues,
  updatePlayerStatistics,
  getAvailablePlayers,
  getTeamById,
  getTeamPlayers,
  unassignPlayerFromTeam,
  updateTeam,
  deleteTeam,
  createTeamTemporaryPlayers,
  getTeamTemporaryPlayers,
  updateTeamTemporaryPlayer,
  deleteTeamTemporaryPlayer,
  getAdminLeagueData,
  updateLeague,
  deleteLeague,
  addTeamToLeague,
  removeTeamFromLeague,
  updateFixture,
  deleteFixture,
  deleteRoundFixtures,
  updateTeamStatistics,
  updateTeamPlayerStatistics,
  getTeamPlayerStatistics,
  updateLeagueTeamStatistics,
  updateLeagueTeamStatus,
  recalculateLadder,
  generateRandomFixtures,
} = require("../controllers/leagueController");

const {
  createCategory: createStoreCategory,
  createProduct,
  updateProduct,
  deleteProduct,
  getProductById,
  getAdminProducts,
  getAllCategories: getStoreCategories,
  updateCategory: updateStoreCategory,
  deleteCategory: deleteStoreCategory,
  getAllOrders,
  getOrderById,
  updateOrderStatus,
} = require("../controllers/storeController");

const {
  createNews,
  getAllNews,
  getNewsById,
  updateNews,
  deleteNews,
  getNewsCategories,
} = require("../controllers/newsController");

const {
  sendEventDayBroadcast,
  previewEventDayBroadcast,
  sendTeamBroadcast,
  deleteSingleMessage,
  deleteFullChatRoom,
} = require("../controllers/parentChatController");

const {
  createInvoice,
  getAdminInvoices,
  getAdminInvoiceById,
  updateInvoice,
  deleteInvoice,
} = require("../controllers/invoiceController");

const {
  getAdminPayments,
  getAdminPaymentById,
  approvePayment,
  rejectPayment,
  getPaymentDashboardStats,
  getPaymentSettings,
  updatePaymentSettings,
} = require("../controllers/paymentController");

const {
  createBankDetails,
  updateBankDetails,
  getAllBankDetails,
  upsertBankDetails,
} = require("../controllers/bankDetailsController");

const auth = require("../middleware/authMiddleware");
const isAdmin = require("../middleware/isAdmin");
const { requireStaff, requireClassAccess, requireTeamAccess, requireEventAccess, requirePlayerAccess, requireTrainingAccess } = require("../middleware/staffAccess");
const { uploads } = require("../utils/upload");
const {
  createEvent,
  getAllEventsForAdmin,
  updateEventStatus,
  updateEvent,
  deleteEvent,
  removeEventRegistration,
  getEventParticipants,
  getEventDetailsAdmin,
  exportEventParticipants,
  configureCampSessions,
  toggleCampDateAvailability,
  updateCampDayNote,
  getEventAttendanceGrid,
  markEventSingleAttendance,
  markEventBulkAttendance,
  getEventRegistrationDetails,
  updateEventRegistrationPaymentStatus,
} = require("../controllers/eventController");

const {
  getRegistrationRequests,
  getUnallocatedPlayers,
  assignClassesToPlayer,
  getPlayersByCategoryAndProgram,
  rejectRegistrationRequest,
} = require("../controllers/registrationRequestController");

const router = express.Router();
router.post("/login", require("../middleware/authRateLimit"), adminLogin);
router.use(auth, requireStaff);

// Registration Requests & Enrollment Workflow (Admin)
router.get("/registration-requests", auth, isAdmin, getRegistrationRequests);
router.get("/unallocated-players", auth, isAdmin, getUnallocatedPlayers);
router.get("/players/search", auth, isAdmin, getPlayersByCategoryAndProgram);
router.patch("/player/:playerId/assign-classes", auth, isAdmin, assignClassesToPlayer);
router.patch("/registration-requests/:id/reject", auth, isAdmin, rejectRegistrationRequest);
router.get("/sidebar-badges", auth, isAdmin, getSidebarBadges);


// Administrative Auth & Players Mod
router.post("/logout", auth, logout);
router.get("/getUsers", auth, isAdmin, getUsers);
router.get("/playerStats", auth, isAdmin, getPlayerStats);
router.put("/updatePaymentStatus/:userId", auth, isAdmin, updatePaymentStatus);
router.put("/updateRating/:userId", auth, isAdmin, updatePlayerRating);
router.post("/assignClass/:userId", auth, isAdmin, assignClassToUser);
router.post("/removeClass/:userId", auth, isAdmin, removeClassFromUser);
router.post("/transferClass", auth, isAdmin, transferPlayerClass);
router.post("/transferClass/:userId", auth, isAdmin, transferPlayerClass);
router.post("/assignCoachToClass/:classId", auth, isAdmin, assignCoachToClass);
router.get("/coach/:coachId/unique-players", auth, isAdmin, getUniquePlayersByCoach);

// Banners management
router.post("/createBanner", auth, isAdmin, uploads.single("bannerImg"), createBanner);
router.put("/updateBanner/:id", auth, isAdmin, uploads.single("bannerImg"), updateBanner);
router.delete("/deleteBanner/:id", auth, isAdmin, deleteBanner);
router.get("/getAllBanners", auth, isAdmin, getAllBanners);
router.patch("/toggleBannerStatus/:id", auth, isAdmin, toggleBannerStatus);

// Academy Events
router.post("/createEvent", auth, isAdmin, uploads.single("eventImg"), createEvent);
router.get("/getAllEvents", auth, isAdmin, getAllEventsForAdmin);
router.put("/updateEventStatus/:id", auth, isAdmin, updateEventStatus);
router.put("/updateEvent/:id", auth, isAdmin, uploads.single("eventImg"), updateEvent);
router.delete("/deleteEvent/:id", auth, isAdmin, deleteEvent);
router.get("/getEventParticipants/:eventId", auth, isAdmin, getEventParticipants);
router.get("/getEventDetails/:eventId", auth, requireEventAccess, getEventDetailsAdmin);

// Holiday Camp Dates & Sessions Configuration
router.post("/events/:eventId/sessions", auth, isAdmin, configureCampSessions);
router.patch("/events/:eventId/toggle-date", auth, isAdmin, toggleCampDateAvailability);
router.patch("/events/:eventId/day-note", auth, isAdmin, updateCampDayNote);
router.post("/events/:eventId/chat/day", auth, isAdmin, sendEventDayBroadcast);
router.get("/events/:eventId/chat/day/preview", auth, isAdmin, previewEventDayBroadcast);

// Holiday Camp & Event Attendance
router.get("/events/:eventId/attendance-grid", auth, requireEventAccess, getEventAttendanceGrid);
router.post("/events/:eventId/attendance/single", auth, requireEventAccess, markEventSingleAttendance);
router.post("/events/:eventId/attendance/bulk", auth, requireEventAccess, markEventBulkAttendance);
router.get("/events/registrations/:registrationId", auth, isAdmin, getEventRegistrationDetails);
router.delete("/events/registrations/:registrationId", auth, isAdmin, removeEventRegistration);
router.patch("/events/registrations/:registrationId/payment-status", auth, isAdmin, updateEventRegistrationPaymentStatus);
router.put("/events/registrations/:registrationId/payment-status", auth, isAdmin, updateEventRegistrationPaymentStatus);

// Data Exports
router.post("/exportUsers", auth, isAdmin, exportUsers);
router.post("/exportEventParticipants/:eventId", auth, isAdmin, exportEventParticipants);
router.get("/exportClassCSV", auth, requireClassAccess, exportClassCSV);

// Taxonomies creation & deletion
router.post("/createCategory", auth, isAdmin, createCategory);
router.put("/updateCategory/:id", auth, isAdmin, updateCategory);
router.delete("/deleteCategory/:id", auth, isAdmin, deletecatCategory);
router.post("/createProgram", auth, isAdmin, createProgram);
router.put("/updateProgram/:id", auth, isAdmin, updateProgram);
router.delete("/deleteProgram/:id", auth, isAdmin, deleteProgram);
router.delete("/program/:id", auth, isAdmin, deleteProgram);

// Terms
router.post("/createTerm", auth, isAdmin, createTerm);
router.delete("/deleteTerm/:id", auth, isAdmin, deleteTerm);
router.get("/getAllTerms", auth, isAdmin, getAllTerms);
router.get("/getTermById/:id", auth, isAdmin, getTermById);
router.put("/updateTerm/:id", auth, isAdmin, updateTerm);
router.post("/cloneTerm/preview", auth, isAdmin, previewCloneTerm);
router.post("/cloneTerm", auth, isAdmin, cloneTerm);
router.get("/term/:termId/earnings", auth, isAdmin, getTermEarningsReport);

// Classes
router.post("/createClass", auth, isAdmin, createClass);
router.delete("/deleteClass/:id", auth, isAdmin, deleteClassPermanently);
router.get("/getAllClasses", auth, isAdmin, getAllClasses);
router.get("/getAllClassesForAssign", isAdmin, getAllClassesForAssign);
router.get("/getClassById/:id", auth, isAdmin, getClassById);
router.put("/updateClass/:id", auth, isAdmin, updateClass);
router.post("/duplicateClass/:id", auth, isAdmin, duplicateClass);

router.get("/getCurrentYearTerms", auth, isAdmin, getCurrentYearTerms);
router.get("/getClassesByTerm/:termId", auth, isAdmin, getClassesByTerm);

// Class roster and attendance rolls
router.post("/markAttendance/:classId", auth, requireClassAccess, markAttendance);
router.post("/markSingleAttendance/:classId", auth, requireClassAccess, markSingleAttendance);
router.get("/getAttendanceByClass/:classId", auth, requireClassAccess, getAttendanceByClass);
router.get("/getAttendanceByDate/:classId", auth, requireClassAccess, getAttendanceByDate);
router.get("/getClassSessions/:classId", auth, requireClassAccess, getClassSessions);
router.get("/getClassPlayers/:classId", auth, isAdmin, getClassPlayers);
router.get("/getClassFullTable", auth, requireClassAccess, getClassFullTable);
router.get("/getClassFiltersWithTimeSlots", isAdmin, getClassFiltersWithTimeSlots);

// Team roster and attendance rolls
router.post("/markTeamAttendance/:teamId", auth, requireTeamAccess, markTeamAttendance);
router.post("/markSingleTeamAttendance/:teamId", auth, requireTeamAccess, markSingleTeamAttendance);
router.get("/getAttendanceByTeam/:teamId", auth, requireTeamAccess, getAttendanceByTeam);
router.get("/getAttendanceByTeamDate/:teamId", auth, requireTeamAccess, getAttendanceByTeamDate);
router.get("/getTeamSessions/:teamId", auth, requireTeamAccess, getTeamSessions);
router.get("/getTeamFullTable", auth, requireTeamAccess, getTeamFullTable);
router.get("/exportTeamCSV", requireTeamAccess, exportTeamCSV);

// Coaches CRUD
router.post("/createCoach", auth, isAdmin, uploads.single("profileImage"), createCoach);
router.get("/getAllCoaches", auth, isAdmin, getAllCoaches);
router.get("/getCoachById/:id", auth, isAdmin, getCoachById);
router.get("/coaches/:coachId/detail", auth, isAdmin, getCoachDetail);
router.put("/updateCoach/:id", auth, isAdmin, uploads.single("profileImage"), updateCoach);
router.put("/toggleCoachActive/:id", auth, isAdmin, toggleCoachActiveStatus);
router.put("/changeCoachPassword/:id", auth, isAdmin, changeCoachPassword);
router.get("/getCoachClassesWithSessions/:coachId", auth, isAdmin, getCoachClassesWithSessions);

// Assessments (Admin/Coach)
router.post("/assessments", auth, requirePlayerAccess, createAssessment);

// Training Session publishing (Admin/Coach)
router.post("/training", auth, uploads.array("attachments", 5), requireClassAccess, createTrainingSession);
router.put("/training/:sessionId", auth, requireTrainingAccess, uploads.array("attachments", 5), updateTrainingSession);

// League Tournament configurations (Admin only)
router.post("/leagues", auth, isAdmin, uploads.single("leagueLogo"), createLeague);

router.get(
  "/leagues",
  auth,
  isAdmin,
  getAllLeagues
);
router.get("/leagues/:leagueId", auth, isAdmin, getAdminLeagueData);
router.put("/leagues/:leagueId", auth, isAdmin, uploads.single("leagueLogo"), updateLeague);
router.delete("/leagues/:leagueId", auth, isAdmin, deleteLeague);
router.post("/leagues/:leagueId/teams", auth, isAdmin, addTeamToLeague);
router.delete("/leagues/:leagueId/teams/:teamId", auth, isAdmin, removeTeamFromLeague);
router.post("/leagues/:leagueId/recalculate-ladder", auth, isAdmin, recalculateLadder);
router.put("/leagues/:leagueId/teams/:teamId/statistics", auth, isAdmin, updateLeagueTeamStatistics);
router.patch("/leagues/:leagueId/teams/:teamId/status", auth, isAdmin, updateLeagueTeamStatus);
router.post("/leagues/:leagueId/generate-random-fixtures", auth, isAdmin, generateRandomFixtures);
router.post("/leagues/:leagueId/fixtures", auth, isAdmin, createFixture);
router.put("/leagues/:leagueId/fixtures/:fixtureId", auth, isAdmin, updateFixture);
router.delete("/leagues/:leagueId/fixtures/:fixtureId", auth, isAdmin, deleteFixture);
router.delete("/leagues/:leagueId/rounds/:round", auth, isAdmin, deleteRoundFixtures);

router.post("/teams", auth, isAdmin, uploads.single("teamLogo"), createTeam);
router.get("/getAllTeams", auth, isAdmin, getAllTeams)
router.get("/teams/:teamId", auth, isAdmin, getTeamById);
router.get("/getTeamPlayers/:teamId", auth, isAdmin, getTeamPlayers);

router.put("/teams/:teamId", auth, isAdmin, uploads.single("teamLogo"), updateTeam);
router.put("/teams/:teamId/statistics", auth, isAdmin, updateTeamStatistics);
router.get("/teams/:teamId/players/:playerId/statistics", auth, isAdmin, getTeamPlayerStatistics);
router.put("/teams/:teamId/players/:playerId/statistics", auth, isAdmin, updateTeamPlayerStatistics);
router.delete("/teams/:teamId", auth, isAdmin, deleteTeam);
router.post("/teams/:teamId/assign", auth, isAdmin, assignPlayerToTeam);
router.post("/teams/:teamId/unassign", auth, isAdmin, unassignPlayerFromTeam);
router.post("/teams/:teamId/chat/broadcast", auth, isAdmin, sendTeamBroadcast);
router.post("/teams/:teamId/temporary-players", auth, isAdmin, uploads.array("profileImages", 20), createTeamTemporaryPlayers);
router.get("/teams/:teamId/temporary-players", auth, isAdmin, getTeamTemporaryPlayers);
router.put("/teams/:teamId/temporary-players/:tempPlayerId", auth, isAdmin, uploads.single("profileImage"), updateTeamTemporaryPlayer);
router.delete("/teams/:teamId/temporary-players/:tempPlayerId", auth, isAdmin, deleteTeamTemporaryPlayer);
router.get("/available-players", auth, isAdmin, getAvailablePlayers);
router.post("/fixtures", auth, isAdmin, createFixture);
router.put("/fixtures/:matchId", auth, isAdmin, updateFixture);
router.delete("/fixtures/:matchId", auth, isAdmin, deleteFixture);
router.post("/fixtures/:matchId/events", auth, isAdmin, recordMatchEvent);
router.post("/fixtures/:matchId/complete", auth, isAdmin, completeMatch);
router.put(
  "/player-statistics/:playerId",
  auth,
  isAdmin,
  updatePlayerStatistics
);

// Store setups (Admin only)
router.post("/store/categories", auth, isAdmin, createStoreCategory);
router.get("/store/categories", auth, isAdmin, getStoreCategories);
router.put("/store/categories/:id", auth, isAdmin, updateStoreCategory);
router.delete("/store/categories/:id", auth, isAdmin, deleteStoreCategory);
router.post("/store/products", auth, isAdmin, uploads.array("images", 5), createProduct);
router.get("/store/products", auth, isAdmin, getAdminProducts);
router.put("/store/products/:id", auth, isAdmin, uploads.array("images", 5), updateProduct);
router.delete("/store/products/:id", auth, isAdmin, deleteProduct);
router.get("/store/products/:id", auth, isAdmin, getProductById);
router.get("/store/orders", auth, isAdmin, getAllOrders);
router.get("/store/orders/:id", auth, isAdmin, getOrderById);
router.patch("/store/orders/:id", auth, isAdmin, updateOrderStatus);


// News setups (Admin only)
router.post("/news", auth, isAdmin, uploads.array("images", 5), createNews);
router.get("/news/categories", auth, isAdmin, getNewsCategories);
router.get("/news", auth, isAdmin, getAllNews);
router.get("/news/:id", auth, isAdmin, getNewsById);
router.put("/news/:id", auth, isAdmin, uploads.array("images", 5), updateNews);
router.delete("/news/:id", auth, isAdmin, deleteNews);

// Bank Details Management (Admin only)
router.post("/bank-details", auth, isAdmin, uploads.single("qrCodeImage"), upsertBankDetails);
router.get("/bank-details", auth, isAdmin, getAllBankDetails);

//Invoicing (Admin only)
router.post("/invoices", auth, isAdmin, createInvoice);
router.get("/invoices", auth, isAdmin, getAdminInvoices);
router.get("/invoices/:id", auth, isAdmin, getAdminInvoiceById);
router.patch("/invoices/:id", auth, isAdmin, updateInvoice);
router.put("/invoices/:id", auth, isAdmin, updateInvoice);
router.delete("/invoices/:id", auth, isAdmin, deleteInvoice);


//Payment Management & Controls (Admin only)
router.get("/payments/settings", auth, isAdmin, getPaymentSettings);
router.put("/payments/settings", auth, isAdmin, updatePaymentSettings);
router.get("/payments", auth, isAdmin, getAdminPayments);
router.get("/payments/:id", auth, isAdmin, getAdminPaymentById);
router.patch("/payments/:id/approve", auth, isAdmin, approvePayment);
router.post("/payments/:id/approve", auth, isAdmin, approvePayment);
router.patch("/payments/:id/reject", auth, isAdmin, rejectPayment);
router.post("/payments/:id/reject", auth, isAdmin, rejectPayment);

// Admin Dashboard / Statistics
router.get("/dashboard", auth, isAdmin, getAdminDashboardOverview);
router.get("/dashboard/payments", auth, isAdmin, getPaymentDashboardStats);

router.get(
  "/player/:playerId",
  auth,
  isAdmin,
  getPlayerDetails
);

// Notifications & FCM Push Tokens (Admin)
router.put(
  "/updatePlayer/:playerId",
  auth,
  isAdmin,
  uploads.single("profileImage"),
  updatePlayer
);

// ✅ Notifications & FCM Push Tokens (Admin)
router.get("/notifications", auth, isAdmin, getAdminNotifications);
router.patch("/notifications/read-all", auth, isAdmin, markAllAdminNotificationsRead);
router.patch("/notifications/:notificationId/read", auth, isAdmin, markAdminNotificationRead);
router.post("/send-notification", auth, isAdmin, sendAdminCustomNotification);


const {
  approveTemporaryPlayer,
  rejectTemporaryPlayer,
  deleteTemporaryPlayer,
  getTemporaryPlayers: getAdminTemporaryPlayers,
} = require("../controllers/temporaryPlayerController");



const {
  getAuditLogs,
  getEntityAuditLogs,
} = require("../controllers/auditLogController");

const {
  getAllConversations,
} = require("../controllers/parentChatController");

// Temporary Player Management (Admin only)
router.get("/temporary-players", auth, isAdmin, getAdminTemporaryPlayers);
router.patch("/temporary-players/:id/approve", auth, isAdmin, approveTemporaryPlayer);
router.patch("/temporary-players/:id/reject", auth, isAdmin, rejectTemporaryPlayer);
router.delete("/temporary-players/:id", auth, isAdmin, deleteTemporaryPlayer);

// Attendance History Audit (Admin only)
router.get("/attendance-history/:classId", auth, isAdmin, getAttendanceHistory);
router.get("/team-attendance-history/:teamId", auth, isAdmin, getTeamAttendanceHistory);

// Audit Logs (Admin only)
router.get("/audit-logs", auth, isAdmin, getAuditLogs);
router.get("/audit-logs/:entityType/:entityId", auth, isAdmin, getEntityAuditLogs);

//  Coach-Parent Conversations (Admin safeguarding)
router.get("/chat/conversations", auth, isAdmin, getAllConversations);

//  Chat Deletion (Admin only)

router.delete("/deleteMessage/:messageId", auth, isAdmin, deleteSingleMessage);
router.delete("/deleteChatRoom/:roomId", auth, isAdmin, deleteFullChatRoom);

module.exports = router;
