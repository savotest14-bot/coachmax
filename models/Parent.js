const mongoose = require("mongoose");

const parentSchema = new mongoose.Schema(
  {
    fullName: {
      type: String,
      required: true,
    },
    email: {
      type: String,
      unique: true,
      required: true,
      lowercase: true,
      trim: true,
    },
    phone: {
      type: String,
      unique: true,
      required: true,
      trim: true,
    },
    password: {
      type: String,
      required: true,
    },
    address: String,
    city: String,
    state: String,
    postcode: String,
    country: String,
    emergencyContact: {
      type: String,
      required: true,
    },
    relationship: {
      type: String,
      required: true,
    },
    notificationSettings: {
      push: { type: Boolean, default: true },
      email: { type: Boolean, default: true },
    },
    profileImage: String,
    status: {
      type: String,
      enum: ["PENDING", "APPROVED", "REJECTED"],
      default: "APPROVED",
    },
    emailVerified: {
      type: Boolean,
      default: false,
    },
    phoneVerified: {
      type: Boolean,
      default: false,
    },
    isBlocked: {
      type: Boolean,
      default: false,
    },
    tokens: [{ type: String }],
    otp: String,
    otpExpire: Date,
    isOtpVerified: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Parent", parentSchema);
