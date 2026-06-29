const express = require("express");
const {
  register,
  login,
  logout,
  getActiveBanners,
  getCategories,
  getProgramsByCategory,
  getMyClasses,
  getMyAttendanceByClass,
  getChildren,
  addChild,
  getDashboard,
  getAllTerms,
} = require("../controllers/userController");

const {
  getMedicalProfile,
  updateMedicalProfile,
} = require("../controllers/medicalController");

const {
  getPlayerAssessments,
  getSkillProgress,
} = require("../controllers/assessmentController");

const {
  getClassTrainingSessions,
} = require("../controllers/trainingController");

const {
  getLeagueStandings,
  getLeagueLeaderboard,
  getFixtures,
} = require("../controllers/leagueController");

const {
  getInvoices,
  recordPayment,
  getPaymentHistory,
} = require("../controllers/paymentController");

const {
  getProducts,
  addToCart,
  getCart,
  checkout,
} = require("../controllers/storeController");

const {
  getAllNews,
} = require("../controllers/newsController");

const {
  getOrCreateDirectRoom,
  sendMessage,
  getRoomMessages,
  getMyRooms,
} = require("../controllers/chatController");

const {
  uploadDocument,
  getPlayerDocuments,
} = require("../controllers/documentController");

const auth = require("../middleware/authMiddleware");
const { uploads } = require("../utils/upload");
const {
  getAllEventsForUser,
  registerForEvent,
  cancelRegistration,
  getMyEvents,
  getEventDetails,
} = require("../controllers/eventController");

const router = express.Router();

// Public / Guest Auth
router.post(
  "/register",
  uploads.array("profiles", 10),
  register
);
router.post("/login", login);
router.post("/logout", auth, logout);

// Banners & Catalog
router.get("/getActiveBanners", auth, getActiveBanners);
router.get("/getCategories", getCategories);
router.get("/getProgramsByCategory/:categoryId", getProgramsByCategory);

router.get("/getAllTerms", getAllTerms);

// Parent Child Management
router.get("/getChildren", auth, getChildren);
router.post("/addChild", auth, uploads.single("profile"), addChild);
router.get("/getDashboard", auth, getDashboard);

// Classes & Attendance
router.get("/getMyClasses", auth, getMyClasses);
router.get("/getMyAttendanceByClass/:classId", auth, getMyAttendanceByClass);

// Medical profile
router.get("/medical/:playerId", auth, getMedicalProfile);
router.put("/medical/:playerId", auth, updateMedicalProfile);

// Assessments & Skills
router.get("/assessments/:playerId", auth, getPlayerAssessments);
router.get("/progress/:playerId", auth, getSkillProgress);

// Class training sessions plan
router.get("/training/:classId", auth, getClassTrainingSessions);

// Events
router.get("/getAllEvents", auth, getAllEventsForUser);
router.post("/registerForEvent", auth, registerForEvent);
router.post("/cancelRegistration", auth, cancelRegistration);
router.get("/getMyEvents", auth, getMyEvents);
router.get("/getEventDetails/:eventId", auth, getEventDetails);

// League Statistics
router.get("/leagues/:leagueId/standings", getLeagueStandings);
router.get("/leagues/:leagueId/leaderboard", getLeagueLeaderboard);
router.get("/leagues/:leagueId/fixtures", getFixtures);

// Payments & Invoicing
router.get("/invoices", auth, getInvoices);
router.post("/payments/pay", auth, recordPayment);
router.get("/payments/history", auth, getPaymentHistory);

// Store
router.get("/store/products", getProducts);
router.get("/store/cart", auth, getCart);
router.post("/store/cart/add", auth, addToCart);
router.post("/store/checkout", auth, checkout);

// News / Announcements
router.get("/news", getAllNews);

// Chat & Messaging
router.post("/chat/room", auth, getOrCreateDirectRoom);
router.post("/chat/message/send", auth, uploads.single("file"), sendMessage);
router.get("/chat/room/:roomId/messages", auth, getRoomMessages);
router.get("/chat/rooms", auth, getMyRooms);

// Documents Verification
router.post("/documents/upload", auth, uploads.single("document"), uploadDocument);
router.get("/documents/:playerId", auth, getPlayerDocuments);

module.exports = router;