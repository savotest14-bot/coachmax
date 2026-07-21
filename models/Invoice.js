const mongoose = require("mongoose");

const invoiceItemSchema = new mongoose.Schema({
  title: {
    type: String,
    required: true,
  },
  description: {
    type: String,
    default: "",
  },
  amount: {
    type: Number,
    required: true,
    default: 0,
  },
});

const invoiceSchema = new mongoose.Schema(
  {
    invoiceNumber: {
      type: String,
      unique: true,
      required: true,
    },
    parent: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Parent",
      required: true,
    },
    players: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
      },
    ],
    items: [invoiceItemSchema],
    subtotal: {
      type: Number,
      default: 0,
    },
    discount: {
      type: Number,
      default: 0,
    },
    totalAmount: {
      type: Number,
      required: true,
      default: 0,
    },
    amount: {
      type: Number, // Backward compatibility field (synchronized with totalAmount)
      default: 0,
    },
    dueDate: {
      type: Date,
      required: true,
    },
    type: {
      type: String,
      enum: ["ACADEMY_FEE", "TOURNAMENT_FEE", "CAMP_FEE", "STORE_ORDER", "CUSTOM"],
      default: "CUSTOM",
    },
    description: {
      type: String,
      default: "",
    },
    notes: {
      type: String,
      default: "",
    },
    paymentMethod: {
      type: String,
      enum: ["ONLINE", "COD", null],
      default: null,
    },
    paymentStatus: {
      type: String,
      enum: ["UNPAID", "PAYMENT_PENDING", "PAID", "REJECTED", "CANCELLED"],
      default: "UNPAID",
    },
    status: {
      type: String,
      enum: ["ACTIVE", "CANCELLED"],
      default: "ACTIVE",
    },
    verifiedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Admin",
    },
    verifiedAt: {
      type: Date,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Invoice", invoiceSchema);
