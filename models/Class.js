const mongoose = require("mongoose");

const classSchema = new mongoose.Schema(
  {
    name: String,

    term: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Term",
      required: true,
    },

    program: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Program",
      required: true,
    },

    category: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Category",
      required: true,
    },

    dayOfWeek: {
      type: String, // Monday, Tuesday
      required: true,
    },

    startTime: String,
    endTime: String,

    location: String,

    coach: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },

    capacity: Number,

    players: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
      },
    ],
  },
  { timestamps: true }
);

module.exports = mongoose.model("Class", classSchema);