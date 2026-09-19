// controllers/otpController.js
// Email OTP for two flows, both sharing the same generate/hash/verify core:
//   1. Signup verification — POST /api/otp/send  { email, name?, purpose:'signup' }
//                             POST /api/otp/verify { email, otp, purpose:'signup' }
//   2. Password reset       — POST /api/otp/send  { email, purpose:'reset' }
//                             POST /api/otp/reset-password { email, otp, newPassword }
//
// "purpose" separates the two so a signup code can't be replayed against
// the reset-password endpoint or vice versa — each is stored and looked up
// under its own DB_PATHS.EMAIL_OTPS/<purpose>/<email> key.
const crypto = require('crypto');
const { ref, serverTimestamp, getAuth } = require('../firebase/admin');
const { DB_PATHS } = require('../config/constants');
const emailService = require('../services/emailService');
const response = require('../helpers/response');
const logger = require('../utils/logger');

const OTP_LENGTH = 6;
const OTP_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_VERIFY_ATTEMPTS = 5;    // per issued code, on top of the route-level rate limiter
const VALID_PURPOSES = new Set(['signup', 'reset']);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Random 6-digit code, zero-padded (crypto-random, not Math.random). */
function generateOtp() {
  const n = crypto.randomInt(0, 10 ** OTP_LENGTH);
  return String(n).padStart(OTP_LENGTH, '0');
}

/** Store only a salted hash of the OTP — never the raw code — so a DB read
 * or backup leak can't be used to log in as someone else. Purpose is folded
 * into the hash so a signup code and a reset code for the same email/otp
 * value can never be swapped for one another. */
function hashOtp(otp, email, purpose) {
  return crypto
    .createHash('sha256')
    .update(`${otp}:${email.toLowerCase()}:${purpose}:${process.env.JWT_SECRET || 'zetpay'}`)
    .digest('hex');
}

function normalizePurpose(p) {
  const purpose = String(p || 'signup').trim().toLowerCase();
  return VALID_PURPOSES.has(purpose) ? purpose : null;
}

/** Firebase RTDB keys can't contain '.', '#', '$', '[', ']' — emails always
 * contain '.', so this makes a safe key without losing information. */
function encodeKey(email) {
  return Buffer.from(email).toString('base64url');
}

function otpRefFor(purpose, email) {
  return ref(`${DB_PATHS.EMAIL_OTPS}/${purpose}/${encodeKey(email)}`);
}

/**
 * POST /api/otp/send
 * Body: { email, name?, purpose? }  (purpose defaults to 'signup')
 *
 * For purpose='reset', this always responds with the same generic success
 * message whether or not the email is actually registered, so the endpoint
 * can't be used to enumerate which addresses have accounts. It still only
 * *sends* an email when the account exists — it just doesn't reveal that
 * distinction in the HTTP response.
 */
async function sendOtp(req, res) {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const purpose = normalizePurpose(req.body.purpose);
    if (!purpose) {
      return response.error(res, 'Invalid request.', 400);
    }
    if (!email || !EMAIL_RE.test(email)) {
      return response.error(res, 'Please enter a valid email address.', 400);
    }

    // Optional — purely cosmetic (used to personalize "Hi {name}," in the
    // email). Capped at 60 chars so an oversized value can't bloat the DB
    // record or the email; sendOtpEmail() HTML-escapes it before use.
    const name = String(req.body.name || '').trim().slice(0, 60);

    if (purpose === 'reset') {
      // Only send if an account actually exists for this email — but
      // don't let the response reveal that either way.
      let userExists = true;
      try {
        await getAuth().getUserByEmail(email);
      } catch (e) {
        userExists = false;
      }
      if (!userExists) {
        return response.success(res, 'If an account exists for this email, a code has been sent.', {
          email,
          expiresInSeconds: OTP_TTL_MS / 1000,
        });
      }
    }

    const otp = generateOtp();
    const record = {
      hash: hashOtp(otp, email, purpose),
      expiresAt: Date.now() + OTP_TTL_MS,
      attempts: 0,
      createdAt: serverTimestamp(),
    };
    if (name) record.name = name;

    await otpRefFor(purpose, email).set(record);
    await emailService.sendOtpEmail(email, otp, name, purpose);

    const successMsg = purpose === 'reset'
      ? 'If an account exists for this email, a code has been sent.'
      : 'OTP sent to your email address.';

    return response.success(res, successMsg, {
      email,
      expiresInSeconds: OTP_TTL_MS / 1000,
    });
  } catch (err) {
    logger.error('sendOtp error: ' + err.message);
    return response.serverError(res, 'Could not send OTP right now. Please try again shortly.');
  }
}

/**
 * Shared verify logic used by both /verify and /reset-password.
 * Returns { ok: true } on success (and deletes the record — one-time use),
 * or { ok: false, message, status } on failure. Does NOT send a response
 * itself, so callers can do more work (e.g. actually reset the password)
 * before responding.
 */
async function _checkOtp(email, otp, purpose) {
  const otpRef = otpRefFor(purpose, email);
  const snap = await otpRef.once('value');
  const record = snap.val();

  if (!record) {
    return { ok: false, status: 400, message: 'No code found for this email. Please request a new one.' };
  }
  if (Date.now() > record.expiresAt) {
    await otpRef.remove();
    return { ok: false, status: 400, message: 'This code has expired. Please request a new one.' };
  }
  if ((record.attempts || 0) >= MAX_VERIFY_ATTEMPTS) {
    await otpRef.remove();
    return { ok: false, status: 429, message: 'Too many incorrect attempts. Please request a new code.' };
  }

  const isMatch = record.hash === hashOtp(otp, email, purpose);
  if (!isMatch) {
    await otpRef.update({ attempts: (record.attempts || 0) + 1 });
    return { ok: false, status: 400, message: 'Incorrect code. Please try again.' };
  }

  await otpRef.remove(); // one-time use
  return { ok: true };
}

/**
 * POST /api/otp/verify
 * Body: { email, otp, purpose? }  (purpose defaults to 'signup')
 */
async function verifyOtp(req, res) {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const otp = String(req.body.otp || '').trim();
    const purpose = normalizePurpose(req.body.purpose);

    if (!purpose) {
      return response.error(res, 'Invalid request.', 400);
    }
    if (!email || !EMAIL_RE.test(email)) {
      return response.error(res, 'Please enter a valid email address.', 400);
    }
    if (!/^\d{6}$/.test(otp)) {
      return response.error(res, 'Enter the 6-digit code.', 400);
    }

    const result = await _checkOtp(email, otp, purpose);
    if (!result.ok) {
      return response.error(res, result.message, result.status);
    }

    return response.success(res, 'Email verified successfully.', { email, verified: true });
  } catch (err) {
    logger.error('verifyOtp error: ' + err.message);
    return response.serverError(res, 'Could not verify OTP right now. Please try again shortly.');
  }
}

/**
 * POST /api/otp/reset-password
 * Body: { email, otp, newPassword }
 * Verifies the reset-purpose OTP, then uses Firebase Admin to set the new
 * password directly — no email link, no re-auth of the old password needed
 * (the OTP itself is the proof of ownership of the mailbox).
 */
async function resetPassword(req, res) {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const otp = String(req.body.otp || '').trim();
    const newPassword = String(req.body.newPassword || '');

    if (!email || !EMAIL_RE.test(email)) {
      return response.error(res, 'Please enter a valid email address.', 400);
    }
    if (!/^\d{6}$/.test(otp)) {
      return response.error(res, 'Enter the 6-digit code.', 400);
    }
    if (newPassword.length < 6) {
      return response.error(res, 'Password must be at least 6 characters.', 400);
    }

    const result = await _checkOtp(email, otp, 'reset');
    if (!result.ok) {
      return response.error(res, result.message, result.status);
    }

    let userRecord;
    try {
      userRecord = await getAuth().getUserByEmail(email);
    } catch (e) {
      // OTP was valid (so the record existed when sendOtp ran), but the
      // account is gone now — extremely unlikely, but fail safely.
      return response.error(res, 'No account found for this email.', 400);
    }

    await getAuth().updateUser(userRecord.uid, { password: newPassword });

    return response.success(res, 'Password reset successfully. You can now sign in with your new password.', { email });
  } catch (err) {
    logger.error('resetPassword error: ' + err.message);
    return response.serverError(res, 'Could not reset your password right now. Please try again shortly.');
  }
}

module.exports = { sendOtp, verifyOtp, resetPassword };
