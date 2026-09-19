// services/apiTokenService.js - ZetAPI Developer Token Management
//
// Lets a ZetPay merchant accept payments on THEIR OWN website/app using a
// token issued by ZetPay itself — a "ZetAPI" key — the same way ZetPay
// accepts payments using Zap UPI Gateway's own "ZAPKEY".
//   ZapUpi  -> ZAPKEY  (ZetPay is the merchant, calling Zap UPI Gateway)
//   ZetPay  -> ZAPAPI  (a ZetPay user is the merchant, calling ZetPay)
//
// One active key per user. Regenerating immediately invalidates the old
// one (the reverse-lookup index entry is deleted before the new one is
// written, so a key is never valid for two different users at once).
const crypto = require('crypto');
const { ref, serverTimestamp } = require('../firebase/admin');
const { DB_PATHS } = require('../config/constants');

// No ambiguous look-alike characters (0/O, 1/I/l) — keeps the key easy to
// read back and re-type correctly if a merchant is copying it by hand.
// Includes digits (2-9) alongside letters, per spec.
const TOKEN_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
const TOKEN_PREFIX = 'ZPP';
const TOKEN_SUFFIX = 'SX';
const RANDOM_LENGTH = 30; // + 3-char prefix + 2-char suffix = 35 total
const TOKEN_LENGTH = TOKEN_PREFIX.length + RANDOM_LENGTH + TOKEN_SUFFIX.length;

function generateTokenString() {
  const bytes = crypto.randomBytes(RANDOM_LENGTH);
  let middle = '';
  for (let i = 0; i < RANDOM_LENGTH; i++) {
    middle += TOKEN_CHARS[bytes[i] % TOKEN_CHARS.length];
  }
  return TOKEN_PREFIX + middle + TOKEN_SUFFIX;
}

/**
 * Get a user's existing ZetAPI key, creating one on first call.
 */
async function getOrCreateToken(userId) {
  const userTokenRef = ref(`${DB_PATHS.USERS}/${userId}/apiToken`);
  const snap = await userTokenRef.once('value');
  // Only reuse the existing key if it actually matches the CURRENT spec.
  // Keys issued before TOKEN_LENGTH was raised to 32 are shorter (e.g. 16
  // chars) and were being returned as-is forever, since this check never
  // verified length — that's why "already changed to 32" never showed up
  // for existing users. A short key now falls through to regenerateToken,
  // which issues a fresh 32-char one (and properly retires the old one).
  if (snap.exists() && snap.val() && snap.val().key && snap.val().key.length === TOKEN_LENGTH) {
    return snap.val();
  }
  return regenerateToken(userId);
}

/**
 * Issue a brand new ZetAPI key for a user, replacing any previous one.
 * The old key stops resolving immediately.
 */
async function regenerateToken(userId) {
  const userTokenRef = ref(`${DB_PATHS.USERS}/${userId}/apiToken`);
  const existingSnap = await userTokenRef.once('value');
  const existing = existingSnap.exists() ? existingSnap.val() : null;

  if (existing && existing.key) {
    await ref(`${DB_PATHS.API_TOKENS}/${existing.key}`).remove();
  }

  const key = generateTokenString();
  const record = {
    key,
    // Date.now() (not serverTimestamp()) — this exact `record` object is
    // returned straight to the API response below, never re-read from the
    // DB first. serverTimestamp() only resolves to a real number once
    // Firebase writes it; until then it's a placeholder object, which is
    // why the dashboard was showing "Created Invalid Date".
    createdAt: Date.now(),
    lastUsedAt: null,
  };

  await userTokenRef.set(record);
  await ref(`${DB_PATHS.API_TOKENS}/${key}`).set(userId);

  return record;
}

/**
 * Resolve a ZetAPI key to its owning userId. Returns null if the key
 * doesn't exist (never issued, or replaced by a regenerate).
 */
async function resolveToken(key) {
  if (!key) return null;
  const snap = await ref(`${DB_PATHS.API_TOKENS}/${key}`).once('value');
  if (!snap.exists()) return null;

  const userId = snap.val();
  // Best-effort "last used" tracking — not on the critical path, so we
  // don't await it or let a failure here block the actual request.
  ref(`${DB_PATHS.USERS}/${userId}/apiToken/lastUsedAt`).set(serverTimestamp()).catch(() => {});
  return userId;
}

module.exports = {
  getOrCreateToken,
  regenerateToken,
  resolveToken,
};
