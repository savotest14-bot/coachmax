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
  requestAddProgram,
  getDashboard,
  getAllTerms,
  getPlayerProfile,
  getAllPrograms,
  getClasses,
  markPlayerAbsent,
} = require("../controllers/userController");

const {
  getMedicalProfile,
  updateMedicalProfile,
} = require("../controllers/medicalController");

const {
  getParentNotifications,
  markParentNotificationRead,
  markAllParentNotificationsRead,
  saveParentFcmToken,
} = require("../controllers/notificationController");

const {
  getClassTrainingSessions,
} = require("../controllers/trainingController");

const {
  getLeagueStandings,
  getLeagueLeaderboard,
  getFixtures,
} = require("../controllers/leagueController");

const {
  getParentInvoices,
  getParentInvoiceById,
} = require("../controllers/invoiceController");

const {
  payCOD,
  payOnline,
  resubmitPayment,
  getParentPayments,
} = require("../controllers/paymentController");

const {
  getBankDetails,
} = require("../controllers/bankDetailsController");

const {
  getProducts,
  addToCart,
  getCart,
  checkout,
  getAllCategories,
  updateCartQuantity,
  removeCartItem,
  getMyOrders,
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
const { getPlayerAssessments, getSkillProgress } = require("../controllers/assessmentController");

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
router.get("/getAllPrograms", auth, getAllPrograms);
router.get("/getProgramsByCategory/:categoryId", getProgramsByCategory);

router.get("/getAllTerms", getAllTerms);

// Parent Child Management
router.get("/getChildren", auth, getChildren);
router.post("/addChild", auth, uploads.single("profile"), addChild);
router.post("/request-program", auth, requestAddProgram);
router.post("/requestAddProgram", auth, requestAddProgram);
router.get("/getDashboard", auth, getDashboard);

// Classes & Attendance
router.get("/getMyClasses/:playerId", auth, getMyClasses);
router.get("/getMyAttendanceByClass/:classId", auth, getMyAttendanceByClass);
router.post("/attendance/mark-absent", auth, markPlayerAbsent);


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

// Bank Details
router.get("/bank-details", getBankDetails);

// Payments & Invoicing (Parent)
router.get("/invoices", auth, getParentInvoices);
router.get("/parent/invoices", auth, getParentInvoices);
router.get("/invoices/:id", auth, getParentInvoiceById);
router.get("/parent/invoices/:id", auth, getParentInvoiceById);

router.post("/invoices/:invoiceId/pay-cod", auth, payCOD);
router.post("/parent/invoices/:invoiceId/pay-cod", auth, payCOD);

router.post("/invoices/:invoiceId/pay-online", auth, uploads.single("paymentScreenshot"), payOnline);
router.post("/parent/invoices/:invoiceId/pay-online", auth, uploads.single("paymentScreenshot"), payOnline);

router.post("/payments/:paymentId/resubmit", auth, uploads.single("paymentScreenshot"), resubmitPayment);
router.post("/parent/payments/:paymentId/resubmit", auth, uploads.single("paymentScreenshot"), resubmitPayment);

router.get("/payments/history", auth, getParentPayments);
router.get("/parent/payments", auth, getParentPayments);

// Store
router.get("/store/categories", auth, getAllCategories);
router.get("/store/products", getProducts);
router.get("/store/cart", auth, getCart);
router.post("/store/cart/add", auth, addToCart);
router.patch("/store/cart/update-quantity", auth, updateCartQuantity);
router.delete("/store/cart/items/:cartItemId", auth, removeCartItem);
router.post("/store/checkout", auth, checkout);
router.get("/store/orders", auth, getMyOrders);
router.get("/store/my-orders", auth, getMyOrders);

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

router.get("/player/profile/:playerId", auth, getPlayerProfile);

router.get("/classes", getClasses);

// Notifications & FCM Push Tokens (Parent)
router.get("/notifications", auth, getParentNotifications);
router.patch("/notifications/read-all", auth, markAllParentNotificationsRead);
router.patch("/notifications/:notificationId/read", auth, markParentNotificationRead);

module.exports = router;