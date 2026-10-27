const mongoose = require("mongoose");
const schema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  kind: { type: String, enum: ["NOTIFICATION", "EMAIL"], default: "NOTIFICATION" },
  payload: { type: mongoose.Schema.Types.Mixed, required: true },
  status: { type: String, enum: ["PENDING", "SENDING", "SENT", "FAILED"], default: "PENDING" },
  attempts: { type: Number, default: 0 },
  nextAttempt: { type: Date, default: Date.now },
  lockedUntil: Date,
  lastError: String,
}, { timestamps: true });
schema.index({ status: 1, nextAttempt: 1 });
module.exports = mongoose.model("DeliveryJob", schema);
