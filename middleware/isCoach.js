const Class = require("../models/Class");
const Team = require("../models/Team");

const isCoach = async (req, res, next) => {
  try {
    if (!req.admin) {
      return res.status(403).json({
        success: false,
        message: "Access denied. Coach or Admin authentication required.",
      });
    }

    if (req.admin.role === "SUPER_ADMIN") {
      return next();
    }

    if (req.admin.role !== "COACH") {
      return res.status(403).json({
        success: false,
        message: "Access denied. Coach role required.",
      });
    }
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
