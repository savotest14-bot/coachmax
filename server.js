const express = require("express")
const dotenv = require("dotenv");
const cors = require("cors");
const connectDB = require("./config/db.js");
const adminRoutes = require("./routes/adminRoutes");
const seedAdmin = require("./config/seedAdmin.js");
const userRoutes = require("./routes/userRoutes.js")
const authRoutes = require("./routes/authRoutes.js")
const coachRoutes = require("./routes/coachRoutes.js")
const path = require("path");

dotenv.config();
connectDB().then(async () => {
  await seedAdmin();
})

const app = express();

app.use(cors());
app.use(express.json());

app.use("/uploads", express.static(path.join(__dirname, "uploads")));
app.use("/public", express.static(path.join(__dirname, "public")));


app.get("/", (req, res) => {
    res.send("server is running");
});

app.get("/swagger.json", (req, res) => {
    res.sendFile(path.join(__dirname, "swagger.json"));
});

app.get("/api-docs", (req, res) => {
    res.sendFile(path.join(__dirname, "swagger.json"));
});

app.use("/api/admin", adminRoutes);
app.use("/api/user", userRoutes);
app.use("/api/auth", authRoutes)
app.use("/api/coach", coachRoutes)

const http = require("http");
const { initSocket } = require("./sockets/chatSocket");

const server = http.createServer(app);

// Initialize Real-Time Socket.IO
initSocket(server);

// Initialize Cron Jobs
const { initCronJobs } = require("./services/cronService");
initCronJobs();

const PORT = process.env.PORT || 4001;
server.listen(PORT, () => console.log(`🚀 Server with Socket.IO running on port ${PORT}`));

