const express = require("express");
const {
  adminLogin,
  logout,
  updatePaymentStatus,
  getUsers,
  createBanner,
  updateBanner,
  deleteBanner,
  getAllBanners,
  toggleBannerStatus,
  exportUsers,
  createCategory,
  createProgram,
  assignClassToUser,
  createTerm,
  getAllTerms,
  getTermById,
  updateTerm,
  createClass,
  getAllClasses,
  getClassById,
  updateClass,
  getCurrentYearTerms,
  getClassesByTerm,
  markAttendance,
  getAttendanceByClass,
  getClassSessions,
  createCoach,
  getAllCoaches,
  getCoachById,
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
  getPlayerDetails,
} = require("../controllers/adminAuthController");

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
} = require("../controllers/leagueController");

const {
  createCategory: createStoreCategory,
  createProduct,
  getAllCategories,
  updateCategory,
  deleteCategory,
  getAllOrders,
  getOrderById,
  updateOrderStatus,
} = require("../controllers/storeController");

const {
  createNews,
} = require("../controllers/newsController");

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
} = require("../controllers/paymentController");

const {
  createBankDetails,
  updateBankDetails,
  getAllBankDetails,
  upsertBankDetails,
} = require("../controllers/bankDetailsController");

const auth = require("../middleware/authMiddleware");
const isAdmin = require("../middleware/isAdmin");
const { uploads } = require("../utils/upload");
const {
  createEvent,
  getAllEventsForAdmin,
  updateEventStatus,
  updateEvent,
  getEventParticipants,
  getEventDetailsAdmin,
  exportEventParticipants,
} = require("../controllers/eventController");

const {
  getRegistrationRequests,
  getUnallocatedPlayers,
  assignClassesToPlayer,
  getPlayersByCategoryAndProgram,
} = require("../controllers/registrationRequestController");

const router = express.Router();

// Registration Requests & Enrollment Workflow (Admin)
router.get("/registration-requests", auth, isAdmin, getRegistrationRequests);
router.get("/unallocated-players", auth, isAdmin, getUnallocatedPlayers);
router.get("/players/search", auth, isAdmin, getPlayersByCategoryAndProgram);
router.patch("/player/:playerId/assign-classes", auth, isAdmin, assignClassesToPlayer);


// Administrative Auth & Players Mod
router.post("/login", adminLogin);
router.post("/logout", auth, logout);
router.get("/getUsers", auth, getUsers);
router.put("/updatePaymentStatus/:userId", auth, isAdmin, updatePaymentStatus);
router.put("/updateRating/:userId", auth, isAdmin, updatePlayerRating);
router.post("/assignClass/:userId", auth, isAdmin, assignClassToUser);
router.post("/removeClass/:userId", auth, isAdmin, removeClassFromUser);
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
router.get("/getEventParticipants/:eventId", auth, isAdmin, getEventParticipants);
router.get("/getEventDetails/:eventId", auth, getEventDetailsAdmin);

// Data Exports
router.post("/exportUsers", auth, isAdmin, exportUsers);
router.post("/exportEventParticipants/:eventId", auth, isAdmin, exportEventParticipants);
router.get("/exportClassCSV", auth, exportClassCSV);

// Taxonomies creation
router.post("/createCategory", auth, isAdmin, createCategory);
router.post("/createProgram", auth, isAdmin, createProgram);

// Terms
router.post("/createTerm", auth, isAdmin, createTerm);
router.get("/getAllTerms", auth, isAdmin, getAllTerms);
router.get("/getTermById/:id", auth, isAdmin, getTermById);
router.put("/updateTerm/:id", auth, isAdmin, updateTerm);

// Classes
router.post("/createClass", auth, isAdmin, createClass);
router.get("/getAllClasses", auth, isAdmin, getAllClasses);
router.get("/getAllClassesForAssign", getAllClassesForAssign);
router.get("/getClassById/:id", auth, isAdmin, getClassById);
router.put("/updateClass/:id", auth, isAdmin, updateClass);

router.get("/getCurrentYearTerms", auth, isAdmin, getCurrentYearTerms);
router.get("/getClassesByTerm/:termId", auth, isAdmin, getClassesByTerm);

// Class roster and attendance rolls
router.post("/markAttendance/:classId", auth, markAttendance);
router.post("/markSingleAttendance/:classId", auth, markSingleAttendance);
router.get("/getAttendanceByClass/:classId", auth, getAttendanceByClass);
router.get("/getAttendanceByDate/:classId", auth, getAttendanceByDate);
router.get("/getClassSessions/:classId", auth, getClassSessions);
router.get("/getClassPlayers/:classId", auth, isAdmin, getClassPlayers);
router.get("/getClassFullTable", auth, getClassFullTable);
router.get("/getClassFiltersWithTimeSlots", getClassFiltersWithTimeSlots);

// Coaches CRUD
router.post("/createCoach", auth, isAdmin, createCoach);
router.get("/getAllCoaches", auth, isAdmin, getAllCoaches);
router.get("/getCoachById/:id", auth, isAdmin, getCoachById);
router.put("/updateCoach/:id", auth, isAdmin, updateCoach);
router.get("/getCoachClassesWithSessions/:coachId", auth, getCoachClassesWithSessions);

// ✅ NEW: Assessments (Admin/Coach)
router.post("/assessments", auth, createAssessment);

// ✅ NEW: Training Session publishing (Admin/Coach)
router.post("/training", auth, uploads.array("attachments", 5), createTrainingSession);
router.put("/training/:sessionId", auth, uploads.array("attachments", 5), updateTrainingSession);

// ✅ NEW: League Tournament configurations (Admin only)
router.post("/leagues", auth, isAdmin, uploads.single("leagueLogo"), createLeague);
router.get(
  "/leagues",
  auth,
  isAdmin,
  getAllLeagues
);
router.post("/teams", auth, isAdmin, uploads.single("teamLogo"), createTeam);
router.get("/getAllTeams", auth, isAdmin, getAllTeams)
router.post("/teams/:teamId/assign", auth, isAdmin, assignPlayerToTeam);
router.get("/available-players", auth, isAdmin, getAvailablePlayers);
router.post("/fixtures", auth, isAdmin, createFixture);
router.post("/fixtures/:matchId/events", auth, recordMatchEvent);
router.post("/fixtures/:matchId/complete", auth, completeMatch);
router.put(
  "/player-statistics/:playerId",
  auth,
  isAdmin,
  updatePlayerStatistics
);

// ✅ NEW: Store setups (Admin only)
router.post("/store/categories", auth, isAdmin, createStoreCategory);
router.get("/store/categories", auth, isAdmin, getAllCategories);
router.put("/store/categories/:id", auth, isAdmin, updateCategory);
router.delete("/store/categories/:id", auth, isAdmin, deleteCategory);
router.post("/store/products", auth, isAdmin, uploads.array("images", 5), createProduct);
router.get("/store/orders", auth, isAdmin, getAllOrders);
router.get("/store/orders/:id", auth, isAdmin, getOrderById);
router.patch("/store/orders/:id", auth, isAdmin, updateOrderStatus);


// ✅ NEW: News setups (Admin only)
router.post("/news", auth, isAdmin, uploads.array("images", 5), createNews);

// ✅ Bank Details Management (Admin only)
router.post("/bank-details", auth, isAdmin, uploads.single("qrCodeImage"), upsertBankDetails);
router.get("/bank-details", auth, isAdmin, getAllBankDetails);

// ✅ Invoicing (Admin only)
router.post("/invoices", auth, isAdmin, createInvoice);
router.get("/invoices", auth, isAdmin, getAdminInvoices);
router.get("/invoices/:id", auth, isAdmin, getAdminInvoiceById);
router.patch("/invoices/:id", auth, isAdmin, updateInvoice);
router.put("/invoices/:id", auth, isAdmin, updateInvoice);
router.delete("/invoices/:id", auth, isAdmin, deleteInvoice);


// ✅ Payment Management (Admin only)
router.get("/payments", auth, isAdmin, getAdminPayments);
router.get("/payments/:id", auth, isAdmin, getAdminPaymentById);
router.patch("/payments/:id/approve", auth, isAdmin, approvePayment);
router.post("/payments/:id/approve", auth, isAdmin, approvePayment);
router.patch("/payments/:id/reject", auth, isAdmin, rejectPayment);
router.post("/payments/:id/reject", auth, isAdmin, rejectPayment);

// ✅ Admin Dashboard / Statistics
router.get("/dashboard/payments", auth, isAdmin, getPaymentDashboardStats);

router.get(
  "/player/:playerId",
  auth,
  isAdmin,
  getPlayerDetails
);

// ✅ Notifications & FCM Push Tokens (Admin)
router.get("/notifications", auth, isAdmin, getAdminNotifications);
router.patch("/notifications/read-all", auth, isAdmin, markAllAdminNotificationsRead);
router.patch("/notifications/:notificationId/read", auth, isAdmin, markAdminNotificationRead);
router.post("/send-notification", auth, isAdmin, sendAdminCustomNotification);

// ═══════════════════════════════════════════════
// Coach Mobile App — Admin Oversight Endpoints
// ═══════════════════════════════════════════════

const {
  approveTemporaryPlayer,
  rejectTemporaryPlayer,
  deleteTemporaryPlayer,
  getTemporaryPlayers: getAdminTemporaryPlayers,
} = require("../controllers/temporaryPlayerController");

const {
  getAttendanceHistory,
} = require("../controllers/coachAttendanceController");

const {
  getAuditLogs,
  getEntityAuditLogs,
} = require("../controllers/auditLogController");

const {
  getAllConversations,
} = require("../controllers/parentChatController");

// ✅ Temporary Player Management (Admin only)
router.get("/temporary-players", auth, isAdmin, getAdminTemporaryPlayers);
router.patch("/temporary-players/:id/approve", auth, isAdmin, approveTemporaryPlayer);
router.patch("/temporary-players/:id/reject", auth, isAdmin, rejectTemporaryPlayer);
router.delete("/temporary-players/:id", auth, isAdmin, deleteTemporaryPlayer);

// ✅ Attendance History Audit (Admin only)
router.get("/attendance-history/:classId", auth, isAdmin, getAttendanceHistory);

// ✅ Audit Logs (Admin only)
router.get("/audit-logs", auth, isAdmin, getAuditLogs);
router.get("/audit-logs/:entityType/:entityId", auth, isAdmin, getEntityAuditLogs);

// ✅ Coach-Parent Conversations (Admin safeguarding)
router.get("/chat/conversations", auth, isAdmin, getAllConversations);

module.exports = router;