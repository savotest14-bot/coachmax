const mongoose = require("mongoose");

const eventSchema = new mongoose.Schema(
  {
    title: String,
    description: String,
    category: String,
    maxParticipants: Number,

    startDate: Date,
    endDate: Date,
    startTime: String,
    endTime: String,

    venueName: String,
    address: String,
    googleMapLink: String,

    // Contact
    contactPhone: String,
    website: String,
    registrationDeadline: Date,
    isRegistrationOpen: {
      type: Boolean,
      default: true,
    },
    bannerImage: String,
    totalRegistered: {
      type: Number,
      default: 0,
    },
    status: {
      type: String,
      enum: ["UPCOMING", "ONGOING", "COMPLETED"],
      default: "UPCOMING",
    },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Admin",
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Event", eventSchema);