const express = require("express")
const dotenv = require("dotenv");
const cors = require("cors");
const connectDB = require("./config/db.js");
const adminRoutes = require("./routes/adminRoutes");
const seedAdmin = require("./config/seedAdmin.js");
const userRoutes = require("./routes/userRoutes.js")
const authRoutes = require("./routes/authRoutes.js")
const path = require("path");

dotenv.config();
connectDB().then(async () => {
  await seedAdmin();
})

const app = express();

app.use(cors());
app.use(express.json());

app.use("/uploads", express.static(path.join(__dirname, "uploads")));
 

app.get("/", (req, res) => {
    res.send("server is running");
});

app.use("/api/admin", adminRoutes);
app.use("/api/user", userRoutes);
app.use("/api/auth", authRoutes)

const PORT = process.env.PORT
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
