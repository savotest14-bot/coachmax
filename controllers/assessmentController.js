const PlayerAssessment = require("../models/PlayerAssessment");
const SkillProgress = require("../models/SkillProgress");
const User = require("../models/User");

// ✅ Create assessment (Admin/Coach only)
exports.createAssessment = async (req, res) => {
  try {
    const {
      player,
      technicalSkills,
      tacticalSkills,
      physicalSkills,
      mentalSkills,
      weakFoot,
      passing,
      shooting,
      dribbling,
      ballControl,
      defending,
      pace,
      stamina,
      confidence,
      discipline,
      communication,
      coachComments,
      improvementAreas,
      overallRating,
    } = req.body;

    if (!player || !overallRating) {
      return res.status(400).json({ success: false, message: "Player and overallRating are required" });
    }

    const assessment = await PlayerAssessment.create({
      player,
      coach: req.admin._id,
      technicalSkills,
      tacticalSkills,
      physicalSkills,
      mentalSkills,
      weakFoot,
      passing,
      shooting,
      dribbling,
      ballControl,
      defending,
      pace,
      stamina,
      confidence,
      discipline,
      communication,
      coachComments,
      improvementAreas,
      overallRating,
    });

    // Check last assessment to calculate skill progress delta updates
    const lastAssessment = await PlayerAssessment.findOne({ player, _id: { $ne: assessment._id } })
      .sort({ assessmentDate: -1 });

    const skillsToTrack = [
      "technicalSkills", "tacticalSkills", "physicalSkills", "mentalSkills",
      "weakFoot", "passing", "shooting", "dribbling", "ballControl",
      "defending", "pace", "stamina", "confidence", "discipline", "communication"
    ];

    for (const skill of skillsToTrack) {
      if (req.body[skill] !== undefined) {
        const prevScore = lastAssessment ? (lastAssessment[skill] || 0) : 0;
        const currentScore = req.body[skill];
        const improvement = currentScore - prevScore;

        await SkillProgress.create({
          player,
          skillName: skill,
          previousScore: prevScore,
          currentScore,
          improvement,
          coach: req.admin._id,
          assessmentDate: assessment.assessmentDate,
        });
      }
    }

    res.status(201).json({
      success: true,
      message: "Assessment saved and progress logs updated successfully",
      data: assessment,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ✅ Get assessments list for a player (Parent or Coach/Admin)
exports.getPlayerAssessments = async (req, res) => {
  try {
    const { playerId } = req.params;

    if (req.role === "PARENT") {
      const child = await User.findOne({ _id: playerId, parentId: req.parent._id });
      if (!child) {
        return res.status(403).json({ success: false, message: "Unauthorized child profile" });
      }
    }

    const assessments = await PlayerAssessment.find({ player: playerId })
      .populate("coach", "name email")
      .sort({ assessmentDate: -1 });

    res.json({ success: true, data: assessments });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ✅ Get skill progress history for a player
exports.getSkillProgress = async (req, res) => {
  try {
    const { playerId } = req.params;

    if (req.role === "PARENT") {
      const child = await User.findOne({ _id: playerId, parentId: req.parent._id });
      if (!child) {
        return res.status(403).json({ success: false, message: "Unauthorized child profile" });
      }
    }

    const progress = await SkillProgress.find({ player: playerId })
      .populate("coach", "name email")
      .sort({ assessmentDate: 1 });

    res.json({ success: true, data: progress });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
