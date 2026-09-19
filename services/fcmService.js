// services/fcmService.js - Firebase Cloud Messaging (push notifications)
//
// Called from exactly one place — notificationService.createNotification —
// so every existing notification trigger in the app (payment success/
// failed, wallet credit, withdrawal status, subscription events, admin
// notices, Test Mode simulations, etc.) automatically sends a push too,
// with zero changes needed anywhere else.
//
// Uses the SAME Firebase Admin app already initialized for the Realtime
// Database (firebase/admin.js) — admin.messaging() needs no separate
// credential or setup.
//
// Sending is always best-effort: every function here swallows its own
// errors and never throws, because a push-delivery hiccup must never
// break the payment webhook / withdrawal update / notification write it
// was triggered from.
const crypto = require('crypto');
const { ref, admin } = require('../firebase/admin');
const { DB_PATHS } = require('../config/constants');
const logger = require('../utils/logger');

/**
 * Realtime Database keys can't contain '.', '#', '$', '[', ']', or '/'.
 * FCM tokens are usually safe but can contain ':' and vary by platform,
 * so hash to a stable, safe key instead of sanitizing the token itself —
 * this also naturally de-dupes if the same device registers twice.
 */
function tokenKey(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Register (or refresh) one device's FCM token for a user. Safe to call
 * repeatedly with the same token — it's just a keyed upsert, so a page
 * reload re-registering the same token is a no-op in practice.
 */
async function registerToken(uid, token, meta = {}) {
  if (!uid || !token) throw new Error('uid and token are required');
  await ref(`${DB_PATHS.USERS}/${uid}/fcmTokens/${tokenKey(token)}`).set({
    token,
    platform: meta.platform || 'web',
    userAgent: (meta.userAgent || '').slice(0, 200),
    updatedAt: admin.database.ServerValue.TIMESTAMP,
  });
}

/** Remove one device's token — e.g. when notifications are turned off. */
async function unregisterToken(uid, token) {
  if (!uid || !token) return;
  await ref(`${DB_PATHS.USERS}/${uid}/fcmTokens/${tokenKey(token)}`).remove();
}

/**
 * Send a push notification to every device a user has registered.
 * Never throws — always resolves to a result object instead, so callers
 * (like the test-push endpoint) can show the caller exactly what
 * happened without anyone needing to dig through server logs:
 *   { ok, deviceCount, successCount, failureCount, errors: [{code,message}] }
 * The normal notificationService.createNotification flow just awaits this
 * and ignores the result — nothing about that path changes.
 */
async function sendPushToUser(uid, { title, message, type }) {
  try {
    const snap = await ref(`${DB_PATHS.USERS}/${uid}/fcmTokens`).once('value');
    if (!snap.exists()) {
      logger.info(`FCM: no registered devices for user ${uid} — nothing to send`);
      return { ok: false, deviceCount: 0, successCount: 0, failureCount: 0, errors: [], reason: 'no_devices_registered' };
    }

    const entries = Object.entries(snap.val());
    const tokens = entries.map(([, v]) => v?.token).filter(Boolean);
    if (tokens.length === 0) {
      logger.info(`FCM: user ${uid} has token entries but no usable token values`);
      return { ok: false, deviceCount: 0, successCount: 0, failureCount: 0, errors: [], reason: 'no_usable_tokens' };
    }

    const resp = await admin.messaging().sendEachForMulticast({
      tokens,
      notification: { title, body: message },
      data: { type: type || 'general' },
      webpush: {
        fcmOptions: { link: (process.env.FRONTEND_URL || '').split(',')[0].trim().replace(/\/+$/, '') || '/' },
        notification: {
          icon: 'https://res.cloudinary.com/dihj6dmbb/image/upload/v1782028733/quickurl/20260621132708_1782028720083.png',
        },
      },
    });

    logger.info(`FCM: sent to ${tokens.length} device(s) for user ${uid} — ${resp.successCount} succeeded, ${resp.failureCount} failed`);

    // Prune tokens FCM says are no longer valid (uninstalled, expired,
    // browser data cleared, etc.) so this list stays clean over time —
    // and collect every failure's actual code/message so the caller can
    // see it directly, not just in server logs.
    const deadKeys = [];
    const errors = [];
    resp.responses.forEach((r, i) => {
      if (!r.success) {
        const code = r.error?.code || 'unknown';
        const message = r.error?.message || '(no message)';
        logger.error(`FCM: token ${i} failed — ${code}: ${message}`);
        errors.push({ code, message });
        if (
          code === 'messaging/registration-token-not-registered' ||
          code === 'messaging/invalid-registration-token'
        ) {
          deadKeys.push(entries[i][0]);
        }
      }
    });
    if (deadKeys.length > 0) {
      const updates = {};
      deadKeys.forEach((key) => { updates[key] = null; });
      await ref(`${DB_PATHS.USERS}/${uid}/fcmTokens`).update(updates);
      logger.info(`FCM: pruned ${deadKeys.length} dead token(s) for user ${uid}`);
    }

    return {
      ok: resp.successCount > 0,
      deviceCount: tokens.length,
      successCount: resp.successCount,
      failureCount: resp.failureCount,
      errors,
    };
  } catch (err) {
    // Log the full error, not just .message — FCM/Admin SDK errors carry
    // a .code (e.g. messaging/third-party-auth-error,
    // messaging/mismatched-credential) that .message alone often omits.
    logger.error(`FCM push send error for user ${uid}: [${err.code || 'no-code'}] ${err.message}`);
    return {
      ok: false,
      deviceCount: 0,
      successCount: 0,
      failureCount: 0,
      errors: [{ code: err.code || 'no-code', message: err.message }],
      reason: 'send_threw',
    };
  }
}

module.exports = { registerToken, unregisterToken, sendPushToUser };
