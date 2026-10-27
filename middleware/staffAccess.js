const mongoose = require("mongoose");
const Class = require("../models/Class");
const Team = require("../models/Team");
const Event = require("../models/Event");
const CampSession = require("../models/CampSession");

const privileged = (req) => ["SUPER_ADMIN", "ADMIN"].includes(req.admin?.role);
const requireStaff = (req, res, next) => {
  if (!req.admin || !["SUPER_ADMIN", "ADMIN", "COACH"].includes(req.admin.role) || req.admin.isActive === false) {
    return res.status(403).json({ success: false, message: "Active staff access required" });
  }
  return next();
};
const id = (value) => String(value?._id || value || "");
const assigned = (resource, staff) => [resource.coach, resource.assistantCoach, resource.createdBy].some((value) => id(value) === id(staff));
const resourceAccess = (Model, key) => async (req, res, next) => {
  if (!req.admin) return res.status(403).json({ success: false, message: "Staff access required" });
  if (privileged(req)) return next();
  const resourceId = req.params[key] || req.body?.[key] || req.query[key];
  if (!mongoose.isValidObjectId(resourceId)) return res.status(400).json({ success: false, message: `A valid ${key} is required` });
  try {
    const resource = await Model.findById(resourceId).select("coach assistantCoach createdBy players");
    if (!resource) return res.status(404).json({ success: false, message: "Resource not found" });
    if (!assigned(resource, req.admin._id)) return res.status(403).json({ success: false, message: "You are not assigned to this resource" });
    req.staffResource = resource;
    return next();
  } catch (error) { return next(error); }
};
const requireEventAccess = async (req, res, next) => {
  if (!req.admin) return res.status(403).json({ success: false, message: "Staff access required" });
  if (privileged(req)) return next();
  const eventId = req.params.eventId || req.body?.eventId || req.query.eventId;
  if (!mongoose.isValidObjectId(eventId)) return res.status(400).json({ success: false, message: "A valid eventId is required" });
  try {
    const event = await Event.findById(eventId).select("createdBy");
    if (!event) return res.status(404).json({ success: false, message: "Event not found" });
    const sessionAssignment = await CampSession.exists({ event: eventId, $or: [{ coach: req.admin._id }, { assistantCoach: req.admin._id }] });
    if (id(event.createdBy) !== id(req.admin._id) && !sessionAssignment) return res.status(403).json({ success: false, message: "You are not assigned to this event" });
    return next();
  } catch (error) { return next(error); }
};
const requirePlayerAccess = async (req, res, next) => {
  if (privileged(req)) return next();
  if (!req.admin || req.admin.isActive === false) return res.status(403).json({ success: false, message: "Active staff access required" });
  const player = req.params.playerId || req.body?.player || req.body?.playerId;
  if (!mongoose.isValidObjectId(player)) return res.status(400).json({ success: false, message: "A valid player ID is required" });
  try {
    const staff = req.admin._id;
    const scope = { $or: [{ coach: staff }, { assistantCoach: staff }] };
    const [cls, team] = await Promise.all([Class.exists({ ...scope, players: player }), Team.exists({ ...scope, "players.player": player })]);
    if (!cls && !team) return res.status(403).json({ success: false, message: "Player is not assigned to your classes or teams" });
    return next();
  } catch (error) { return next(error); }
};
const requireTrainingAccess = async (req, res, next) => {
  if (privileged(req)) return next();
  try {
    const training = await require("../models/TrainingSession").findById(req.params.sessionId).select("coach class");
    if (!training) return res.status(404).json({ success: false, message: "Training session not found" });
    if (id(training.coach) !== id(req.admin?._id)) return res.status(403).json({ success: false, message: "You cannot edit this training session" });
    return next();
  } catch (error) { return next(error); }
};
module.exports = { requireStaff, requirePlayerAccess, requireTrainingAccess, requireClassAccess: resourceAccess(Class, "classId"), requireTeamAccess: resourceAccess(Team, "teamId"), requireEventAccess, privileged };
