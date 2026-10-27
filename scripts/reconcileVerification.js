/** Dry-run by default. Does not load .env. Review output against a restored
 * staging database before applying with VERIFICATION_MIGRATION_URI + --apply.
 * Medical text never appears in terminal output. Back up before applying. */
const mongoose = require("mongoose");
mongoose.set("autoIndex", false);
mongoose.set("autoCreate", false);
const User = require("../models/User");
const MedicalProfile = require("../models/MedicalProfile");
const MedicalRevision = require("../models/MedicalRevision");
const RegistrationRequest = require("../models/RegistrationRequest");
const { medicalText, medicalList, normalizeMedicalStatus } = require("../utils/medicalStatus");

async function reconcileVerification({ apply = false, actorId } = {}) {
  if (apply && !mongoose.isValidObjectId(actorId)) throw new Error("A verified admin actor ID is required when applying medical revisions");
  if (apply) {
    for (const Model of [RegistrationRequest, MedicalRevision]) {
      try { await Model.createCollection(); } catch (error) { if (error.code !== 48) throw error; }
    }
  }
  const report = { orphanRequests: [], clearNegativeAlerts: [], setKnownAlerts: [], needsReview: [] };
  const players = await User.find({ $or: [{ playerStatus: "PENDING_APPROVAL" }, { isMedicalCondition: true }] });
  for (const player of players) {
    if (player.playerStatus === "PENDING_APPROVAL" && player.parentId && (player.temporaryClass || player.createdByRole === "COACH")) {
      const request = await RegistrationRequest.exists({ player: player._id, requestType: { $in: ["TEMPORARY_PLAYER", "TEMPORARY"] } });
      if (!request) {
        report.orphanRequests.push(String(player._id));
        if (apply) await RegistrationRequest.updateOne({ player: player._id, requestType: "TEMPORARY_PLAYER" }, { $setOnInsert: { parent: player.parentId, category: player.category || null, programs: player.programs || [], preferredTerm: player.term || null, preferredClasses: player.temporaryClass ? [player.temporaryClass] : [], requestType: "TEMPORARY_PLAYER", status: "PENDING", createdBy: player.createdBy } }, { upsert: true });
      }
    }
    if (player.isMedicalCondition !== true) continue;
    const profile = await MedicalProfile.findOne({ player: player._id });
    const hasProfileAlert = profile && (medicalText(profile.medicalConditions) || medicalList(profile.allergies).length || medicalList(profile.medications).length || medicalList(profile.injuries).length);
    // A blank flagged record is ambiguous; only exact, affirmative NO text is
    // eligible. Known profile conditions/allergies/medication stay flagged.
    if (!String(player.medicalConditionDetails || "").trim() || hasProfileAlert) { report.needsReview.push(String(player._id)); continue; }
    if (medicalText(player.medicalConditionDetails)) continue;
    report.clearNegativeAlerts.push(String(player._id));
    if (apply) {
      const session = await mongoose.startSession();
      try {
        await session.withTransaction(async () => {
          const oldValue = { isMedicalCondition: player.isMedicalCondition, medicalConditionDetails: player.medicalConditionDetails };
          const result = await User.updateOne({ _id: player._id, isMedicalCondition: true, medicalConditionDetails: player.medicalConditionDetails }, { $set: { isMedicalCondition: false, medicalConditionDetails: "" } }, { session });
          if (result.modifiedCount) await MedicalRevision.create([{ player: player._id, actor: actorId, actorType: "ADMIN", previous: oldValue, current: { isMedicalCondition: false, medicalConditionDetails: "", migration: "verification-medical-v1" } }], { session });
        });
      } finally { await session.endSession(); }
    }
  }
  const profiles = await MedicalProfile.find({});
  for (const profile of profiles) {
    const current = normalizeMedicalStatus({ medicalConditions: profile.medicalConditions, allergies: profile.allergies });
    if (!current.isMedicalCondition) continue;
    const player = await User.findById(profile.player);
    if (!player || player.isMedicalCondition === true) continue;
    report.setKnownAlerts.push(String(player._id));
    if (apply) {
      const session = await mongoose.startSession();
      try {
        await session.withTransaction(async () => {
          const latestProfile = await MedicalProfile.findById(profile._id).session(session);
          const latestPlayer = await User.findById(player._id).session(session);
          if (!latestProfile || !latestPlayer || latestPlayer.isMedicalCondition === true) return;
          const medical = normalizeMedicalStatus({ medicalConditions: latestProfile.medicalConditions, allergies: latestProfile.allergies });
          if (!medical.isMedicalCondition) return;
          const previous = { isMedicalCondition: latestPlayer.isMedicalCondition, medicalConditionDetails: latestPlayer.medicalConditionDetails };
          latestPlayer.isMedicalCondition = true;
          latestPlayer.medicalConditionDetails = medical.medicalConditionDetails;
          await latestPlayer.save({ session });
          await MedicalRevision.create([{ player: latestPlayer._id, actor: actorId, actorType: "ADMIN", previous, current: { isMedicalCondition: true, medicalConditionDetails: medical.medicalConditionDetails, migration: "verification-medical-v1", source: "MedicalProfile" } }], { session });
        });
      } finally { await session.endSession(); }
    }
  }
  return report;
}

if (require.main === module) {
  (async () => {
    const uri = process.env.VERIFICATION_MIGRATION_URI;
    if (!uri) throw new Error("Set VERIFICATION_MIGRATION_URI explicitly; application .env is never loaded");
    await mongoose.connect(uri, { autoIndex: false, autoCreate: false });
    try { console.log(JSON.stringify({ mode: process.argv.includes("--apply") ? "APPLY" : "DRY_RUN", ...(await reconcileVerification({ apply: process.argv.includes("--apply"), actorId: process.env.VERIFICATION_MIGRATION_ACTOR })) }, null, 2)); }
    finally { await mongoose.disconnect(); }
  })().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { reconcileVerification };
