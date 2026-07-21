const mongoose = require("mongoose");

const bankDetailsSchema = new mongoose.Schema(
  {
    accountName: {
      type: String,
      required: true,
      trim: true,
    },
    bankName: {
      type: String,
      required: true,
      trim: true,
    },
    accountNumber: {
      type: String,
      required: true,
      trim: true,
    },
    iban: {
      type: String,
      default: "",
      trim: true,
    },
    swiftCode: {
      type: String,
      default: "",
      trim: true,
    },
    branch: {
      type: String,
      default: "",
      trim: true,
    },
    qrCodeImage: {
      type: String,
      default: "",
    },
    instructions: {
      type: String,
      default: "",
    },
    isActive: {
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

module.exports = mongoose.model("BankDetails", bankDetailsSchema);
