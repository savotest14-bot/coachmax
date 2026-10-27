const mongoose = require("mongoose");
// Restricted history: no public/user endpoint exposes this collection.
const schema = new mongoose.Schema({
  player: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  actor: { type: mongoose.Schema.Types.ObjectId, required: true },
  actorType: { type: String, enum: ["PARENT", "ADMIN"], required: true },
  previous: mongoose.Schema.Types.Mixed,
  current: mongoose.Schema.Types.Mixed,
}, { timestamps: true });
module.exports = mongoose.model("MedicalRevision", schema);
