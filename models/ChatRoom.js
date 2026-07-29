const mongoose = require("mongoose");

const chatRoomSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: ["DIRECT", "GROUP", "BROADCAST"],
      default: "DIRECT",
    },
    members: [
      {
        refModel: {
          type: String,
          enum: ["Parent", "Admin"],
          required: true,
        },
        user: {
          type: mongoose.Schema.Types.ObjectId,
          refPath: "members.refModel",
          required: true,
        },
      },
    ],
    name: {
      type: String,
      default: "", // Name for group chat
    },
    classId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Class",
      default: null,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("ChatRoom", chatRoomSchema);
