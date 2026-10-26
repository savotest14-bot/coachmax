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

    venueName: String, 
    venue: String, 
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
    // Soft deletion keeps attendance, invoice, and chat history available for auditing.
    isArchived: {
      type: Boolean,
      default: false,
      index: true,
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

    eventType: {
      type: String,
      default: "TOURNAMENT",
    },
    // Events and holiday camps belong to the term in which they run. This is
    // used to keep user chat visibility term-scoped while retaining history
    // for administrators.
    termId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Term",
      default: null,
      index: true,
    },
    // Holiday Camp specific settings
    campConfig: {
      defaultFullDayPrice: { type: Number, default: 90 },
      defaultHalfDayPrice: { type: Number, default: 70 },
      defaultFullDayStartTime: { type: String, default: "08:00 AM" },
      defaultFullDayEndTime: { type: String, default: "04:00 PM" },
      defaultHalfDayStartTime: { type: String, default: "08:00 AM" },
      defaultHalfDayEndTime: { type: String, default: "02:00 PM" },
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
