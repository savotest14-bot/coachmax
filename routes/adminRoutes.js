const express = require("express");
const {
  adminLogin,
  logout,
  getPendingUsers,
  updateUserStatus,
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
  updateAdminNote,
  exportClassCSV,
  getAllClassesForAssign,
  getParents,
} = require("../controllers/adminAuthController");

const {
  createAssessment,
} = require("../controllers/assessmentController");

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
} = require("../controllers/leagueController");

const {
  createCategory: createStoreCategory,
  createProduct,
  getAllCategories,
  updateCategory,
  deleteCategory,
} = require("../controllers/storeController");

const {
  createNews,
} = require("../controllers/newsController");

const {
  createInvoice,
} = require("../controllers/paymentController");

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

const router = express.Router();

// Administrative Auth & Players Mod
router.post("/login", adminLogin);
router.post("/logout", auth, logout);
router.get("/getUsers", auth, getUsers);
router.put("/updateStatus/:userId", auth, isAdmin, updateUserStatus);
router.post("/assignClass/:userId", auth, isAdmin, assignClassToUser);
router.post("/assignCoachToClass/:classId", auth, isAdmin, assignCoachToClass);

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
router.put("/updateAdminNote/:id", auth, updateAdminNote);

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

// ✅ NEW: News setups (Admin only)
router.post("/news", auth, isAdmin, uploads.array("images", 5), createNews);

// ✅ NEW: Invoicing (Admin only)
router.post("/invoices", auth, isAdmin, createInvoice);

module.exports = router;