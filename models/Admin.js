const mongoose = require("mongoose");

const adminSchema = new mongoose.Schema(
    {
        name: String,

        email: {
            type: String,
            unique: true,
            required: true,
        },

        mobile: {
            type: String,
            unique: true,
            required: true,
        },
        profile:String,
        otp: String,
        otpExpire: Date,
        isOtpVerified: {type:Boolean, default:false},
        password: {
            type: String,
            required: true,
        },
        tokens: [
            {
                type: String,
            }
        ],
        role: {
            type: String,
            enum: ["SUPER_ADMIN", "COACH"],
            default: "COACH",
        },
    },
    { timestamps: true }
);

module.exports = mongoose.model("Admin", adminSchema);