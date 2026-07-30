const mongoose = require("mongoose");

const paymentSettingsSchema = new mongoose.Schema(
  {
    isOnlineEnabled: {
      type: Boolean,
      default: true,
    },
    isCodEnabled: {
      type: Boolean,
      default: true,
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Admin",
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("PaymentSettings", paymentSettingsSchema);
