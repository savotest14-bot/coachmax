const mongoose = require("mongoose");

const cartSchema = new mongoose.Schema(
  {
    parent: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Parent",
      required: true,
      unique: true,
    },
    lastCheckoutKey: { type: String },
    items: [
      {
        product: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Product",
          required: true,
        },
        quantity: {
          type: Number,
          required: true,
          min: 1,
          validate: Number.isSafeInteger,
          default: 1,
        },
        selectedSize: {
          type: String,
          default: "",
        },
        selectedColor: {
          type: String,
          default: "",
        },
      },
    ],
  },
  { timestamps: true, optimisticConcurrency: true }
);

module.exports = mongoose.model("Cart", cartSchema);
