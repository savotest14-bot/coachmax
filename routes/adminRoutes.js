const express = require("express");
const { adminLogin, logout, getPendingUsers, updateUserStatus, getUsers, createBanner, updateBanner, deleteBanner, getAllBanners, toggleBannerStatus, exportUsers, createCategory, createProgram, assignClassToUser, createTerm, getAllTerms, getTermById, updateTerm, createClass, getAllClasses, getClassById, updateClass, getCurrentYearTerms, getClassesByTerm, markAttendance, getAttendanceByClass, getClassSessions, createCoach, getAllCoaches, getCoachById, updateCoach, getClassPlayers, markSingleAttendance, getAttendanceByDate, assignCoachToClass, getCoachClassesWithSessions,  getClassFullTable, getClassFiltersWithTimeSlots, updateAdminNote, exportClassCSV, getAllClassesForAssign } = require("../controllers/adminAuthController");
const auth = require("../middleware/authMiddleware");
const isAdmin = require("../middleware/isAdmin");
const { uploads } = require("../utils/upload");
const { createEvent, getAllEventsForAdmin, updateEventStatus, updateEvent, getEventParticipants, getEventDetailsAdmin, exportEventParticipants } = require("../controllers/eventController");

const router = express.Router();

router.post("/login", adminLogin);

router.post("/logout", auth, logout);

router.get("/getUsers", auth, getUsers);

router.put("/updateStatus/:userId", auth, isAdmin, updateUserStatus);

router.post("/assignClass/:userId", auth, isAdmin, assignClassToUser);

router.post("/assignCoachToClass/:classId", auth, isAdmin, assignCoachToClass);

router.post(
    "/createBanner",
    auth,
    isAdmin,
    uploads.single("bannerImg"),
    createBanner
);

router.put(
    "/updateBanner/:id",
    auth,
    isAdmin,
    uploads.single("bannerImg"),
    updateBanner
);

router.delete(
    "/deleteBanner/:id",
    auth,
    isAdmin,
    deleteBanner
);

router.get("/getAllBanners", auth, isAdmin, getAllBanners);

router.patch(
    "/toggleBannerStatus/:id",
    auth,
    isAdmin,
    toggleBannerStatus
);

router.post("/createEvent", auth, isAdmin, uploads.single("eventImg"), createEvent);

router.get("/getAllEvents", auth, isAdmin, getAllEventsForAdmin);

router.put("/updateEventStatus/:id", auth, isAdmin, updateEventStatus);

router.put("/updateEvent/:id", auth, isAdmin, uploads.single("eventImg"), updateEvent);

router.get("/getEventParticipants/:eventId", auth, isAdmin, getEventParticipants)

router.get("/getEventDetails/:eventId", auth, getEventDetailsAdmin);

router.post("/exportUsers", auth, isAdmin, exportUsers);

router.post("/exportEventParticipants/:eventId", auth, isAdmin, exportEventParticipants)

router.post("/createCategory", auth, isAdmin, createCategory);

router.post("/createProgram", auth, isAdmin, createProgram);

// Term
router.post("/createTerm", auth, isAdmin, createTerm);
router.get("/getAllTerms", auth, isAdmin, getAllTerms);
router.get("/getTermById/:id", auth, isAdmin, getTermById);
router.put("/updateTerm/:id", auth, isAdmin, updateTerm);

// Class
router.post("/createClass", auth, isAdmin, createClass);
router.get("/getAllClasses", auth, isAdmin, getAllClasses);
router.get("/getAllClassesForAssign",  getAllClassesForAssign);
router.get("/getClassById/:id", auth, isAdmin, getClassById);
router.put("/updateClass/:id", auth, isAdmin, updateClass);

router.get("/getCurrentYearTerms", auth, isAdmin, getCurrentYearTerms)
router.get("/getClassesByTerm/:termId", auth, isAdmin, getClassesByTerm)
router.post("/markAttendance/:classId", auth, markAttendance);
router.post("/markSingleAttendance/:classId", auth, markSingleAttendance);
router.get("/getAttendanceByClass/:classId", auth, getAttendanceByClass);
router.get("/getAttendanceByDate/:classId", auth, getAttendanceByDate);
router.get("/getClassSessions/:classId", auth, getClassSessions);

router.post("/createCoach", auth, isAdmin, createCoach);
router.get("/getAllCoaches", auth, isAdmin, getAllCoaches);
router.get("/getCoachById/:id", auth, isAdmin, getCoachById);
router.put("/updateCoach/:id", auth, isAdmin, updateCoach);

router.get("/getClassPlayers/:classId", auth, isAdmin, getClassPlayers);

router.get("/getCoachClassesWithSessions/:coachId", auth, getCoachClassesWithSessions);

router.get("/getClassFiltersWithTimeSlots",  getClassFiltersWithTimeSlots);

router.get("/getClassFullTable", auth, getClassFullTable);

router.get("/exportClassCSV", auth, exportClassCSV);

router.put("/updateAdminNote/:id", auth, updateAdminNote);
module.exports = router;