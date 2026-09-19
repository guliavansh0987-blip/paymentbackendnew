// services/emailService.js
// Sends transactional email (OTPs, etc.) through a cPanel mailbox via SMTP.
//
// Required env vars (set these in Vercel → Project → Settings → Environment
// Variables, and in cPanel → Email Accounts for the mailbox itself):
//   SMTP_HOST   e.g. zetpay.online        (cPanel → Email Accounts → Connect Devices, SSL/TLS section)
//   SMTP_PORT   465 (SSL) or 587 (STARTTLS)
//   SMTP_SECURE 'true' for port 465, 'false' for port 587
//   SMTP_USER   e.g. help@zetpay.online
//   SMTP_PASS   the mailbox password (never commit this — env var only)
//   SMTP_FROM_NAME  optional display name, defaults to 'ZetPay Gateway'
const nodemailer = require('nodemailer');
const logger = require('../utils/logger');

let transporter = null;

/**
 * Lazily builds the transporter on first use rather than at module load —
 * mirrors firebase/admin.js's pattern of not throwing at import time, so a
 * missing SMTP env var doesn't crash the whole serverless function, only
 * the email-sending call path.
 */
function getTransporter() {
  if (transporter) return transporter;

  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASS) {
    throw new Error(
      'Missing SMTP env vars. Check: SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS'
    );
  }

  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT),
    secure: String(process.env.SMTP_SECURE || 'true') === 'true', // true for 465, false for 587
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });

  return transporter;
}

/** Escapes HTML special chars in the user-supplied name before interpolating
 * it into the email markup — the name comes straight from the request body,
 * so this stops it from being used to inject stray HTML/tags into the email. */
function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Sends a 6-digit OTP email. Caller is responsible for generating/storing
 * the code and its expiry — this function only sends it.
 * `name` is optional — falls back to a generic greeting when not supplied.
 * `purpose` is 'signup' (default) or 'reset' — only changes the wording,
 * not the underlying template.
 */
async function sendOtpEmail(toEmail, otp, name, purpose) {
  const fromName = process.env.SMTP_FROM_NAME || 'ZetPay Gateway';
  const fromAddress = process.env.SMTP_USER;
  const greetName = name ? escapeHtml(name) : 'there';
  const year = new Date().getFullYear();
  const isReset = purpose === 'reset';

  const introLine = isReset
    ? 'Use this code to reset your password:'
    : 'Your verification code is:';
  const subject = isReset ? 'Reset your ZetPay Gateway password' : 'OTP for your email';
  const securityLine = isReset
    ? "If you didn't request a password reset, you can safely ignore this email."
    : 'Do not share this code with anyone.';

  const html = `
  <div style="background:#0b0f1a;padding:32px 16px;font-family:'Segoe UI',Arial,sans-serif;">
    <div style="max-width:480px;margin:0 auto;background:#11162a;border-radius:14px;overflow:hidden;border:1px solid #1f2745;">

      <!-- Header -->
      <div style="background:linear-gradient(135deg,#3d5afe,#1a2a8f);padding:26px 32px;">
        <span style="color:#ffffff;font-size:20px;font-weight:700;letter-spacing:0.2px;">ZetPay Gateway</span>
      </div>

      <!-- Body -->
      <div style="padding:32px;">
        <p style="margin:0 0 14px;color:#e7eaf6;font-size:16px;">Hi ${greetName},</p>
        <p style="margin:0 0 22px;color:#c6cbe0;font-size:14.5px;line-height:1.5;">${introLine}</p>

        <div style="background:#0b0f1a;border:1px dashed #3d5afe;border-radius:10px;padding:20px;text-align:center;margin-bottom:24px;">
          <span style="font-size:34px;font-weight:700;letter-spacing:10px;color:#7c8cff;font-family:'Courier New',monospace;">${otp}</span>
        </div>

        <p style="margin:0 0 8px;color:#8a90ab;font-size:13.5px;">This code expires in <strong style="color:#c6cbe0;">5 minutes</strong>.</p>
        <p style="margin:0;color:#8a90ab;font-size:13.5px;">${securityLine}</p>
      </div>

      <!-- Footer -->
      <div style="background:#0d1220;padding:18px 32px;border-top:1px solid #1f2745;text-align:center;">
        <p style="margin:0;color:#5c6284;font-size:12px;">© ${year} ZetPay Gateway. This is an automated message, please don't reply.</p>
      </div>

    </div>
  </div>`;

  const text = `Hi ${name || 'there'},\n\n${introLine} ${otp}\nIt expires in 5 minutes.\n${securityLine}\n\n© ${year} ZetPay Gateway`;

  await getTransporter().sendMail({
    from: `"${fromName}" <${fromAddress}>`,
    to: toEmail,
    subject,
    html,
    text,
  });

  logger.info(`OTP email (${purpose || 'signup'}) sent to ${toEmail}`);
}

module.exports = { sendOtpEmail };
