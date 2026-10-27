const mongoose = require("mongoose");
const MedicalProfile = require("../models/MedicalProfile");
const MedicalRevision = require("../models/MedicalRevision");
const User = require("../models/User");
const { medicalList, normalizeMedicalStatus } = require("../utils/medicalStatus");

async function authorizedPlayer(req, playerId, session) {
  if (!mongoose.isValidObjectId(playerId)) throw Object.assign(new Error("Invalid player ID"), { statusCode: 400 });
  const query = User.findById(playerId);
  const player = session ? await query.session(session) : await query;
  if (!player) throw Object.assign(new Error("Player not found"), { statusCode: 404 });
  const isParent = req.role === "PARENT" && req.parent && String(player.parentId) === String(req.parent._id);
  const isAdmin = ["SUPER_ADMIN", "ADMIN"].includes(req.admin?.role);
  if (!isParent && !isAdmin) throw Object.assign(new Error("Unauthorized child medical profile"), { statusCode: 403 });
  return player;
}

exports.getMedicalProfile = async (req, res) => {
  try {
    const player = await authorizedPlayer(req, req.params.playerId);
    const profile = await MedicalProfile.findOne({ player: player._id });
    // Reads do not create records. Preserve legacy User details until reviewed.
    return res.json({ success: true, data: profile || { player: player._id, medicalConditions: player.medicalConditionDetails || "", allergies: [], injuries: [], medications: [], emergencyContact: "", notes: "" }, isMedicalCondition: player.isMedicalCondition === true });
  } catch (error) { return res.status(error.statusCode || 500).json({ success: false, message: error.message }); }
};

exports.updateMedicalProfile = async (req, res) => {
  const session = await mongoose.startSession();
  let profile;
  try {
    await session.withTransaction(async () => {
      const player = await authorizedPlayer(req, req.params.playerId, session);
      profile = await MedicalProfile.findOne({ player: player._id }).session(session);
      if (!profile) profile = new MedicalProfile({ player: player._id, medicalConditions: player.medicalConditionDetails || "" });
      const previous = profile.toObject();
      for (const field of ["injuries", "allergies", "medications"]) {
        if (req.body[field] !== undefined) {
          if (!Array.isArray(req.body[field]) || req.body[field].length > 50) throw Object.assign(new Error(`${field} must be an array with at most 50 items`), { statusCode: 400 });
          profile[field] = medicalList(req.body[field]);
        }
      }
      for (const field of ["medicalConditions", "doctorName", "emergencyContact", "insuranceDetails", "notes"]) {
        if (req.body[field] !== undefined) {
          if (typeof req.body[field] !== "string" || req.body[field].length > 5000) throw Object.assign(new Error(`${field} must be text of at most 5000 characters`), { statusCode: 400 });
          profile[field] = req.body[field].trim();
        }
      }
      const current = normalizeMedicalStatus({ medicalConditions: profile.medicalConditions, allergies: profile.allergies, ...(req.body.isMedicalCondition !== undefined ? { isMedicalCondition: req.body.isMedicalCondition } : {}) });
      profile.medicalConditions = current.medicalConditions;
      profile.allergies = current.allergies;
      player.isMedicalCondition = current.isMedicalCondition;
      player.medicalConditionDetails = current.medicalConditionDetails;
      await profile.save({ session });
      await player.save({ session });
      await MedicalRevision.create([{ player: player._id, actor: req.parent?._id || req.admin._id, actorType: req.parent ? "PARENT" : "ADMIN", previous, current: profile.toObject() }], { session });
    });
    return res.json({ success: true, message: "Medical profile updated successfully", data: profile });
  } catch (error) { return res.status(error.statusCode || (error.name === "ValidationError" || error instanceof TypeError ? 400 : 500)).json({ success: false, message: error.message }); }
  finally { await session.endSession(); }
};
