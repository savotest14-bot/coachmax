exports.welcomeEmail = (name) => {
  return `
  <div style="font-family: Arial, sans-serif; background:#f4f6f8; padding:20px;">
    <div style="max-width:600px; margin:auto; background:#ffffff; border-radius:10px; overflow:hidden; box-shadow:0 2px 10px rgba(0,0,0,0.1);">
      
      <div style="background:#0d6efd; color:#fff; padding:20px; text-align:center;">
        <h2>Welcome to CoachMax 🎉</h2>
      </div>

      <div style="padding:30px; color:#333;">
        <h3>Hello ${name} 👋</h3>

        <p>Thank you for registering with <b>CoachMax</b>.</p>

        <p>Your account has been created successfully. You can now log in and start using CoachMax.</p>

        <div style="margin:30px 0; text-align:center;">
          <a href="#" style="background:#0d6efd; color:#fff; padding:10px 20px; text-decoration:none; border-radius:5px;">
            Login Now
          </a>
        </div>

        <p>If you have any questions, feel free to contact us.</p>

        <br/>

        <p style="color:#555;">Best Regards,<br/><b>CoachMax Team</b></p>
      </div>

      <div style="background:#f4f6f8; text-align:center; padding:15px; font-size:12px; color:#888;">
        © ${new Date().getFullYear()} CoachMax. All rights reserved.
      </div>

    </div>
  </div>
  `;
};

const escapeHtml = (value = "") => String(value).replace(/[&<>"']/g, (character) => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
}[character]));

exports.temporaryPlayerAccessEmail = ({ parentName, playerName, email, isNewAccount = false, loginUrl }) => {
  const safeParentName = escapeHtml(parentName || "Parent/Guardian");
  const safePlayerName = escapeHtml(playerName || "your player");
  const safeEmail = escapeHtml(email || "");
  const safeLoginUrl = escapeHtml(loginUrl);
  return `<div style="font-family:Arial,sans-serif;background:#f4f6f8;padding:24px;color:#172033">
    <div style="max-width:600px;margin:auto;background:#fff;border-radius:12px;overflow:hidden">
      <div style="background:#08245b;color:#fff;padding:22px 28px"><h2 style="margin:0">CoachMax account access</h2></div>
      <div style="padding:28px"><p>Hello ${safeParentName},</p>
        <p>${isNewAccount ? `A CoachMax parent account was created when <b>${safePlayerName}</b> was added as a temporary player.` : `<b>${safePlayerName}</b> was added to your existing CoachMax parent account.`}</p>
        <p>Account email: <b>${safeEmail}</b></p>
        ${isNewAccount ? `<p>Open the link below and enter this email to request your six-digit code. Verify the code to choose your own password. The code expires after ten minutes; the verified reset grant expires after five minutes and works once.</p>` : `<p>Use your existing CoachMax password. If you need help, choose <b>Forgot password</b> on the login page.</p>`}
        <div style="margin:28px 0;text-align:center"><a href="${safeLoginUrl}" style="display:inline-block;background:#064bff;color:#fff;padding:13px 24px;text-decoration:none;border-radius:7px;font-weight:bold">${isNewAccount ? "Choose your password" : "Open CoachMax and sign in"}</a></div>
        <p style="font-size:13px;color:#64748b">If the button does not work, copy this link into your browser:<br/><a href="${safeLoginUrl}">${safeLoginUrl}</a></p>
        <p style="font-size:13px;color:#64748b">If you did not expect this message, contact the CoachMax team.</p>
      </div>
    </div>
  </div>`;
};
exports.newUserAdminEmail = (user) => {
  return `
  <div style="font-family: Arial, sans-serif; background:#f4f6f8; padding:20px;">
    <div style="max-width:600px; margin:auto; background:#ffffff; border-radius:10px; overflow:hidden; box-shadow:0 2px 10px rgba(0,0,0,0.1);">

      <div style="background:#28a745; color:#fff; padding:20px; text-align:center;">
        <h2>🚀 New Player Registration</h2>
      </div>

      <div style="padding:30px; color:#333;">
        
        <h3>Player Details</h3>

        <table style="width:100%; border-collapse:collapse;">
          <tr>
            <td style="padding:8px; font-weight:bold;">Name:</td>
            <td>${user.fullName}</td>
          </tr>
          <tr>
            <td style="padding:8px; font-weight:bold;">Email:</td>
            <td>${user.email || "N/A"}</td>
          </tr>
          <tr>
            <td style="padding:8px; font-weight:bold;">Phone:</td>
            <td>${user.phone}</td>
          </tr>
          <tr>
            <td style="padding:8px; font-weight:bold;">Skill Level:</td>
            <td>${user.skillLevel} ⭐</td>
          </tr>
          <tr>
            <td style="padding:8px; font-weight:bold;">Club:</td>
            <td>${user.club || "N/A"}</td>
          </tr>
        </table>

        <div style="margin:30px 0; text-align:center;">
          <a href="#" style="background:#0d6efd; color:#fff; padding:12px 25px; text-decoration:none; border-radius:5px;">
            View in Admin Panel
          </a>
        </div>

        <br/>

        <p style="color:#555;">CoachMax System</p>
      </div>

      <div style="background:#f4f6f8; text-align:center; padding:15px; font-size:12px; color:#888;">
        © ${new Date().getFullYear()} CoachMax
      </div>

    </div>
  </div>
  `;
};



exports.forgotEmail = (user, otp) => { 
  return `
<div style="font-family: Arial, sans-serif; background:#f4f6f8; padding:20px;">
  <div style="max-width:600px; margin:auto; background:#ffffff; border-radius:10px; overflow:hidden; box-shadow:0 2px 10px rgba(0,0,0,0.1);">

    <!-- Header -->
    <div style="background:#dc3545; color:#fff; padding:20px; text-align:center;">
      <h2>🔐 Password Reset</h2>
    </div>

    <!-- Body -->
    <div style="padding:30px; color:#333;">
      <h3>Hello ${user.fullName || "User"} 👋</h3>

      <p>We received a request to reset your password.</p>

      <p>Your One-Time Password (OTP) is:</p>

      <!-- OTP BOX -->
      <div style="text-align:center; margin:30px 0;">
        <span style="
          display:inline-block;
          background:#f1f3f5;
          padding:15px 30px;
          font-size:28px;
          letter-spacing:8px;
          font-weight:bold;
          color:#0d6efd;
          border-radius:8px;
        ">
          ${otp}
        </span>
      </div>

      <p style="text-align:center; color:#dc3545; font-weight:bold;">
        ⏱ This OTP is valid for 10 minutes
      </p>

      <p>If you did not request this, please ignore this email.</p>

      <br/>

      <p style="color:#555;">
        Regards,<br/>
        <b>CoachMax Team</b>
      </p>
    </div>

    <!-- Footer -->
    <div style="background:#f4f6f8; text-align:center; padding:15px; font-size:12px; color:#888;">
      © ${new Date().getFullYear()} CoachMax. All rights reserved.
    </div>

  </div>
</div>
`};
