const express = require("express");
const { register, login, getActiveBanners, getCategories, getProgramsByCategory } = require("../controllers/userController");
const { logout, createCoach, getAllCoaches, getCoachById, updateCoach } = require("../controllers/adminAuthController");
const auth = require("../middleware/authMiddleware");
const { getAllEventsForUser, registerForEvent, cancelRegistration, getMyEvents, getEventDetails } = require("../controllers/eventController");

const router = express.Router();

router.post("/register", register);

router.post("/login", login)

router.post("/logout", auth, logout);

router.get("/getActiveBanners", auth, getActiveBanners);

router.get("/getAllEvents", auth, getAllEventsForUser);

router.post("/registerForEvent", auth, registerForEvent);

router.post("/cancelRegistration", auth, cancelRegistration);

router.get("/getMyEvents", auth, getMyEvents);

router.get("/getEventDetails/:eventId", auth, getEventDetails);

router.get("/getCategories", getCategories);

router.get("/getProgramsByCategory/:categoryId", getProgramsByCategory)

module.exports = router;