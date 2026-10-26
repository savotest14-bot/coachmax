const mongoose = require("mongoose");

const chatRoomSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: ["DIRECT", "GROUP", "BROADCAST"],
      default: "DIRECT",
    },
    // Normalized business scope used by the admin communication centre. The
    // legacy `type` field is retained for backwards compatibility with older
    // clients and existing rooms.
    scope: {
      type: String,
      enum: ["DIRECT", "CLASS", "EVENT_DAY", "TEAM", "LEAGUE", "PROGRAM", "GROUP"],
      default: null,
    },
    audience: {
      type: String,
      enum: ["PARENT_COACH", "CLASS_PARENTS", "EVENT_PARENTS", "TEAM_PARENTS", "LEAGUE_PARENTS", "PROGRAM_PARENTS", "STAFF", "CUSTOM"],
      default: null,
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
      default: "",
    },
    // Explicit scope metadata keeps class, team, direct, and holiday-day
    // conversations distinguishable in the communication centre.
    scopeType: {
      type: String,
      enum: ["DIRECT", "CLASS", "EVENT_DAY", "TEAM", "LEAGUE", "PROGRAM", "GLOBAL"],
      default: "DIRECT",
      index: true,
    },
    scopeLabel: {
      type: String,
      default: "",
    },
    audienceType: {
      type: String,
      enum: ["DIRECT", "PARENTS", "STAFF", "TEAM", "LEAGUE", "PROGRAM"],
      default: "DIRECT",
    },
    recipientCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    entityStatus: {
      type: String,
      default: "ACTIVE",
    },
    subtitle: {
      type: String,
      default: "",
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Admin",
      default: null,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    archivedAt: {
      type: Date,
      default: null,
    },
    lastActivityAt: {
      type: Date,
      default: null,
    },
    classId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Class",
      default: null,
    },
    termId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Term",
      default: null,
    },
    programId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Program",
      default: null,
    },
    // Broadcast scope metadata. A room can be scoped to one class, event day,
    // or team while retaining the existing BROADCAST room behavior.
    eventId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Event",
      default: null,
    },
    eventSessionDate: {
      type: String,
      default: null,
      match: [/^$|^\d{4}-\d{2}-\d{2}$/, "Event session date must be YYYY-MM-DD"],
    },
    campSessionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "CampSession",
      default: null,
    },
    eventSessionType: {
      type: String,
      default: null,
    },
    teamId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Team",
      default: null,
    },
    leagueId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "League",
      default: null,
    },
    // Snapshot IDs are useful for explaining who receives a broadcast in the
    // admin UI. Recipient membership remains authoritative for access checks.
    participantPlayerIds: [{
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    }],
    lastMessage: {
      text: { type: String, default: "" },
      sender: {
        type: mongoose.Schema.Types.ObjectId,
        refPath: "lastMessage.senderModel",
      },
      senderModel: {
        type: String,
        enum: ["Parent", "Admin"],
      },
      senderName: { type: String, default: "" },
      timestamp: { type: Date },
      type: {
        type: String,
        enum: ["TEXT", "ATTACHMENT"],
        default: "TEXT",
      },
    },
  },
  { timestamps: true }
);

chatRoomSchema.index({ "members.user": 1, "members.refModel": 1 });
chatRoomSchema.index({ type: 1, classId: 1 });
chatRoomSchema.index({ type: 1, eventId: 1, eventSessionDate: 1, campSessionId: 1 });
chatRoomSchema.index({ type: 1, teamId: 1 });
chatRoomSchema.index({ type: 1, leagueId: 1 });
chatRoomSchema.index({ termId: 1, updatedAt: -1 });

chatRoomSchema.pre("validate", function normalizeScope() {
  if (!this.scope) {
    if (this.type === "DIRECT") this.scope = "DIRECT";
    else if (this.eventId) this.scope = "EVENT_DAY";
    else if (this.leagueId) this.scope = "LEAGUE";
    else if (this.teamId) this.scope = "TEAM";
    else if (this.programId) this.scope = "PROGRAM";
    else if (this.classId) this.scope = "CLASS";
    else this.scope = this.type === "GROUP" || this.type === "BROADCAST" ? "GROUP" : "CLASS";
  }
  if (!this.lastActivityAt && this.lastMessage?.timestamp) {
    this.lastActivityAt = this.lastMessage.timestamp;
  }
});

module.exports = mongoose.model("ChatRoom", chatRoomSchema);
