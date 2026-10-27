const mongoose = require("mongoose");
module.exports = mongoose.model("Counter", new mongoose.Schema({ _id: String, sequence: { type: Number, default: 0 } }, { versionKey: false }));
