const mongoose = require("mongoose");

const messageSchema = new mongoose.Schema(
  {
    room: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ChatRoom",
      required: true,
    },
    sender: {
      refModel: {
        type: String,
        enum: ["Parent", "Admin"],
        required: true,
      },
      user: {
        type: mongoose.Schema.Types.ObjectId,
        refPath: "sender.refModel",
        required: true,
      },
    },
    text: {
      type: String,
      default: "",
    },
    attachments: [
      {
        fileType: {
          type: String,
          enum: ["IMAGE", "VIDEO", "FILE", "AUDIO"],
        },
        url: String,
      },
    ],
    status: {
      type: String,
      enum: ["SENT", "DELIVERED", "READ"],
      default: "SENT",
    },
    deliveredTo: [
      {
        user: {
          type: mongoose.Schema.Types.ObjectId,
          required: true,
        },
        deliveredAt: {
          type: Date,
          default: Date.now,
        },
      },
    ],
    readReceipts: [
      {
        user: {
          type: mongoose.Schema.Types.ObjectId,
          required: true,
        },
        readAt: {
          type: Date,
          default: Date.now,
        },
      },
    ],
  },
  { timestamps: true }
);

module.exports = mongoose.model("Message", messageSchema);
