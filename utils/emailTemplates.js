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

        <p>Your account is currently 
          <span style="color:#f39c12; font-weight:bold;">Pending Approval</span>.
        </p>

        <p>Our team will review your profile and notify you once approved.</p>

        <div style="margin:30px 0; text-align:center;">
          <span style="background:#f1f3f5; padding:10px 20px; border-radius:20px; font-size:14px;">
            ⏳ Awaiting Approval
          </span>
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
            <td style="padding:8px; font-weight:bold;">Preferred Foot:</td>
            <td>${user.preferredFoot}</td>
          </tr>
          <tr>
            <td style="padding:8px; font-weight:bold;">Program:</td>
            <td>${user.programType}</td>
          </tr>
          <tr>
            <td style="padding:8px; font-weight:bold;">Club:</td>
            <td>${user.club || "N/A"}</td>
          </tr>
        </table>

        <div style="margin:30px 0; text-align:center;">
          <a href="#" style="background:#0d6efd; color:#fff; padding:12px 25px; text-decoration:none; border-radius:5px;">
            Review in Admin Panel
          </a>
        </div>

        <p>Please review and approve/reject this player.</p>

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

exports.getStatusEmailTemplate = (user, status, reason) => {
  const isApproved = status === "APPROVED";

  return `
  <div style="font-family: Arial; max-width: 600px; margin: auto; border: 1px solid #eee; padding: 20px; border-radius: 10px;">
    
    <h2 style="color: ${isApproved ? "#28a745" : "#dc3545"};">
      ${isApproved ? "🎉 Congratulations!" : "⚠️ Application Update"}
    </h2>

    <p>Hello <b>${user.fullName}</b>,</p>

    <p>
      ${
        isApproved
          ? "Your account has been <b>approved</b>. You can now login and start using CoachMax."
          : "We regret to inform you that your application has been <b>rejected</b>."
      }
    </p>

    ${
      !isApproved
        ? `<p><b>Reason:</b> ${reason}</p>`
        : ""
    }

    <div style="margin-top: 20px;">
      ${
        isApproved
          ? `<a href="#" style="background: #28a745; color: #fff; padding: 10px 20px; text-decoration: none; border-radius: 5px;">
              Login Now
            </a>`
          : ""
      }
    </div>

    <hr style="margin: 20px 0;" />

    <p style="font-size: 12px; color: #888;">
      CoachMax Team<br/>
      If you have questions, contact support.
    </p>

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