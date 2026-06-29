const mongoose = require("mongoose");

const documentSchema = new mongoose.Schema(
  {
    player: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    documentType: {
      type: String,
      enum: [
        "BIRTH_CERTIFICATE",
        "PASSPORT",
        "MEDICAL_FORM",
        "CONSENT_FORM",
        "INSURANCE",
        "PHOTO",
      ],
      required: true,
    },
    fileUrl: {
      type: String,
      required: true,
    },
    uploadedAt: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Document", documentSchema);
