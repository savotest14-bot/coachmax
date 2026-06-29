const mongoose = require("mongoose");

const eventSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
    },
    description: String,
    category: String,
    maxParticipants: Number,

    startDate: Date,
    endDate: Date,
    startTime: String,
    endTime: String,

    venueName: String, // Kept for backward compatibility
    venue: String, // Added
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

    // Added fields
    eventType: {
      type: String,
      default: "TOURNAMENT",
    },
    registrationFee: {
      type: Number,
      default: 0,
    },
    documentsRequired: [
      {
        type: String,
      },
    ],
    organizer: {
      type: String,
      default: "",
    },
    sponsors: [
      {
        type: String,
      },
    ],
  },
  { timestamps: true }
);

module.exports = mongoose.model("Event", eventSchema);