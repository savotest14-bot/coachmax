const dns = require("dns");
const mongoose = require("mongoose");

// Fix for Node.js querySrv ECONNREFUSED on Windows with MongoDB Atlas SRV records
// try {
//   dns.setServers(["8.8.8.8", "8.8.4.4"]);
// } catch (e) {
//   console.warn("Could not set custom DNS servers:", e.message);
// }

const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log("MongoDB Connected");
  } catch (err) {
    console.log(err);
    process.exit(1);
  }
};

module.exports = connectDB;