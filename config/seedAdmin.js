const Admin = require("../models/Admin");
const bcrypt = require("bcryptjs");

const seedAdmin = async () => {
  try {
    const adminEmail = process.env.ADMIN_EMAIL;
    const adminMobile = process.env.ADMIN_MOBILE;

    if (!adminEmail && !adminMobile && !process.env.ADMIN_PASSWORD) return;
    if (!adminEmail || !adminMobile || !process.env.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD.length < 8) throw new Error("Configure a complete admin email, mobile and password of at least 8 characters, or omit all seed settings");

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
    throw err;
  }
};

module.exports = seedAdmin;
