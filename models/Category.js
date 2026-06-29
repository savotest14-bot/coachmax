const mongoose = require("mongoose");

const categorySchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      unique: true,
    },
    icon: {
      type: String,
      default: "",
    },
    description: {
      type: String,
      default: "",
    },
    displayOrder: {
      type: Number,
      default: 0,
    },
    ageRange: {
      type: String,
      default: "",
    },
    genderRestriction: {
      type: String,
      enum: ["BOYS", "GIRLS", "COED"],
      default: "COED",
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Category", categorySchema);