const mongoose = require("mongoose");

const userSchema = new mongoose.Schema(
    {
        fullName: String,
        email: {
            type: String,
            unique: true,
            sparse: true,
        },
        password: String,
        phone: {
            type: String,
            unique: true,
        },
        otp: String,
        otpExpire: Date,
        isOtpVerified: {type:Boolean, default:false},
        dob: Date,
        profile: String,
        club: String,
        contactName: String,

        preferredFoot: {
            type: String,
            enum: ["LEFT", "RIGHT", "AMBIDEXTROUS"],
        },

        skillLevel: {
            type: Number,
            min: 1,
            max: 5,
        },

        medicalCondition: String,
        comments: String,

        status: {
            type: String,
            enum: ["PENDING", "APPROVED", "REJECTED"],
            default: "PENDING",
        },
        tokens: [
            {
                type: String,
            }
        ],
        programType: {
            type: String,
            enum: ["ONE_ON_ONE", "DEVELOPMENT", "ELITE", "GROUP"],
            required: true,
        },
        rejectReason: {
            type: String,
            default: null,
        },

        approvedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Admin",
            default: null,
        },

        rejectedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Admin",
            default: null,
        },
        approvedAt: {
            type: Date,
            default: null,
        },

        rejectedAt: {
            type: Date,
            default: null,
        },
        isBlocked: {
            type: Boolean,
            default: false,
        },
    },
    { timestamps: true }
);

module.exports = mongoose.model("User", userSchema);