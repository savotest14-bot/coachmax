const Class = require("../models/Class");
const Team = require("../models/Team");

/**
 * Middleware: Ensures the request is from a COACH or SUPER_ADMIN.
 * For COACH, additionally verifies ownership of the resource if classId/teamId is present.
 * SUPER_ADMIN bypasses all ownership checks.
 */
const isCoach = async (req, res, next) => {
  try {
    // Must be authenticated as admin (COACH or SUPER_ADMIN)
    if (!req.admin) {
      return res.status(403).json({
        success: false,
        message: "Access denied. Coach or Admin authentication required.",
      });
    }

    // SUPER_ADMIN bypasses all ownership checks
    if (req.admin.role === "SUPER_ADMIN") {
      return next();
    }

    // Must be a COACH
    if (req.admin.role !== "COACH") {
      return res.status(403).json({
        success: false,
        message: "Access denied. Coach role required.",
      });
    }

    // If classId is present, verify coach is assigned to that class
    const classId = req.params?.classId || req.body?.classId || req.query?.classId;

    if (classId) {
      const classData = await Class.findById(classId).select("coach assistantCoach");

      if (!classData) {
        return res.status(404).json({
          success: false,
          message: "Class not found.",
        });
      }

      const coachId = req.admin._id.toString();
      const isAssigned =
        (classData.coach && classData.coach.toString() === coachId) ||
        (classData.assistantCoach && classData.assistantCoach.toString() === coachId);

      if (!isAssigned) {
        return res.status(403).json({
          success: false,
          message: "Access denied. You are not assigned to this class.",
        });
      }
    }

    // If teamId is present, verify coach is assigned to that team
    const teamId = req.params?.teamId || req.body?.teamId || req.query?.teamId;

    if (teamId) {
      const teamData = await Team.findById(teamId).select("coach assistantCoach");

      if (!teamData) {
        return res.status(404).json({
          success: false,
          message: "Team not found.",
        });
      }

      const coachId = req.admin._id.toString();
      const isAssigned =
        (teamData.coach && teamData.coach.toString() === coachId) ||
        (teamData.assistantCoach && teamData.assistantCoach.toString() === coachId);

      if (!isAssigned) {
        return res.status(403).json({
          success: false,
          message: "Access denied. You are not assigned to this team.",
        });
      }
    }

    next();
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

/**
 * Middleware: Ensures the request is from a SUPER_ADMIN only.
 * Used for admin-only operations like approving temporary players, deleting resources, etc.
 */
const isSuperAdmin = (req, res, next) => {
  if (!req.admin || req.admin.role !== "SUPER_ADMIN") {
    return res.status(403).json({
      success: false,
      message: "Access denied. Super Admin only.",
    });
  }
  next();
};

module.exports = { isCoach, isSuperAdmin };
