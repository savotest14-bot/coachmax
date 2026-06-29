const MedicalProfile = require("../models/MedicalProfile");
const User = require("../models/User");

// ✅ Get child's medical profile (Parent or Admin)
exports.getMedicalProfile = async (req, res) => {
  try {
    const { playerId } = req.params;

    // If Parent, verify ownership
    if (req.role === "PARENT") {
      const child = await User.findOne({ _id: playerId, parentId: req.parent._id });
      if (!child) {
        return res.status(403).json({ success: false, message: "Unauthorized child profile" });
      }
    }

    let profile = await MedicalProfile.findOne({ player: playerId });
    if (!profile) {
      // Create a default profile if not exists
      profile = await MedicalProfile.create({ player: playerId });
    }

    res.json({ success: true, data: profile });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ✅ Update child's medical profile (Parent or Admin)
exports.updateMedicalProfile = async (req, res) => {
  try {
    const { playerId } = req.params;
    const { injuries, allergies, medications, medicalConditions, doctorName, emergencyContact, insuranceDetails, notes } = req.body;

    // If Parent, verify ownership
    if (req.role === "PARENT") {
      const child = await User.findOne({ _id: playerId, parentId: req.parent._id });
      if (!child) {
        return res.status(403).json({ success: false, message: "Unauthorized child profile" });
      }
    }

    let profile = await MedicalProfile.findOne({ player: playerId });
    if (!profile) {
      profile = new MedicalProfile({ player: playerId });
    }

    if (injuries !== undefined) profile.injuries = injuries;
    if (allergies !== undefined) profile.allergies = allergies;
    if (medications !== undefined) profile.medications = medications;
    if (medicalConditions !== undefined) profile.medicalConditions = medicalConditions;
    if (doctorName !== undefined) profile.doctorName = doctorName;
    if (emergencyContact !== undefined) profile.emergencyContact = emergencyContact;
    if (insuranceDetails !== undefined) profile.insuranceDetails = insuranceDetails;
    if (notes !== undefined) profile.notes = notes;

    await profile.save();

    res.json({ success: true, message: "Medical profile updated successfully", data: profile });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
