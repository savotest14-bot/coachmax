const nodemailer = require("nodemailer");

const sendEmail = async (to, subject, html) => {
  try {
    if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) return false;
    const transporter = nodemailer.createTransport({
      ...(process.env.EMAIL_HOST ? { host: process.env.EMAIL_HOST, port: Number(process.env.EMAIL_PORT || 587), secure: Number(process.env.EMAIL_PORT || 587) === 465 } : { service: "gmail" }),
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 20000,
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
      },
    });

    await transporter.sendMail({
      from: `"CoachMax" <${process.env.EMAIL_USER}>`,
      to,
      subject,
      html,
    });

    return true;
  } catch (err) {
    console.error("Email delivery failed", { code: err.code || "SMTP_ERROR" });
    return false;
  }
};

module.exports = sendEmail;
