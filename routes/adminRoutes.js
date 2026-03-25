const express = require("express");
const { adminLogin, logout, getPendingUsers, updateUserStatus, getUsers, createBanner, updateBanner, deleteBanner, getAllBanners, toggleBannerStatus, exportUsers } = require("../controllers/adminAuthController");
const auth = require("../middleware/authMiddleware");
const isAdmin = require("../middleware/isAdmin");
const { uploads } = require("../utils/upload");
const { createEvent, getAllEventsForAdmin, updateEventStatus, updateEvent, getEventParticipants, getEventDetailsAdmin, exportEventParticipants } = require("../controllers/eventController");

const router = express.Router();

router.post("/login", adminLogin);

router.post("/logout", auth, logout);

router.get("/getUsers", auth, getUsers);

router.put("/updateStatus/:userId", auth, isAdmin, updateUserStatus)

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

router.put("/updateEvent/:id", auth, isAdmin,uploads.single("eventImg"), updateEvent);

router.get("/getEventParticipants/:eventId", auth, isAdmin, getEventParticipants)

router.get("/getEventDetails/:eventId", auth, getEventDetailsAdmin);

router.post("/exportUsers", auth, isAdmin, exportUsers);

router.post("/exportEventParticipants/:eventId", auth, isAdmin, exportEventParticipants)

module.exports = router;