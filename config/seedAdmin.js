const Admin = require("../models/Admin");
const bcrypt = require("bcryptjs");

const seedAdmin = async () => {
  try {
    const adminEmail = process.env.ADMIN_EMAIL;
    const adminMobile = process.env.ADMIN_MOBILE;

    const adminExists = await Admin.findOne({
      $or: [{ email: adminEmail }, { mobile: adminMobile }],
    });

    if (adminExists) {
      console.log("✅ Admin already exists");
      return;
    }

    const hashedPassword = await bcrypt.hash(
      process.env.ADMIN_PASSWORD,
      10
    );

    await Admin.create({
      name: "Super Admin",
      email: adminEmail,
      mobile: adminMobile,
      password: hashedPassword,
      role: "SUPER_ADMIN",
    });

    console.log("🔥 Admin created successfully");

  } catch (err) {
    console.error("❌ Admin seed error:", err.message);
  }
};

module.exports = seedAdmin;