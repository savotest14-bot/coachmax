const mongoose = require("mongoose");

const orderSchema = new mongoose.Schema(
  {
    parent: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Parent",
      required: true,
    },
    checkoutKey: { type: String },
    totalAmountMinor: { type: Number, min: 0 },
    currency: { type: String, default: "AUD" },
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
        },
        price: {
          type: Number,
          required: true,
        },
        priceMinor: { type: Number, min: 0 },
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
    totalAmount: {
      type: Number,
      required: true,
    },
    paymentStatus: {
      type: String,
      enum: ["PENDING", "PAID", "FAILED", "REFUNDED"],
      default: "PENDING",
    },
    shippingAddress: {
      type: String,
      required: true,
    },
    status: {
      type: String,
      enum: ["PENDING", "PROCESSING", "SHIPPED", "DELIVERED", "CANCELLED"],
      default: "PENDING",
    },
    invoice: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Invoice",
    },
  },
  { timestamps: true }
);

orderSchema.index({ parent: 1, checkoutKey: 1 }, { unique: true, partialFilterExpression: { checkoutKey: { $type: "string" } } });

module.exports = mongoose.model("Order", orderSchema);
