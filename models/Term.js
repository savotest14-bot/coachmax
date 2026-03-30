const mongoose = require("mongoose");

const termSchema = new mongoose.Schema(
  {
    name: {
      type: String, // Term 1, Term 2
      required: true,
    },
    year: {
      type: Number,
      required: true,
    },
    startDate: {
      type: Date,
      required: true,
    },
    endDate: {
      type: Date,
      
      required: true,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Term", termSchema);