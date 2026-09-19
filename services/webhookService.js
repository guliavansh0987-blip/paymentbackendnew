// services/webhookService.js
// Lets a merchant register one or more of THEIR OWN server URLs to be
// notified (via an outgoing POST) whenever one of their orders changes
// status — "Order pending" (created) and "Order success/failed" (settled).
// This is separate from ZetPay's own incoming webhook (webhooks/zapWebhook.js,
// which receives FROM the upstream ZapUPI gateway) — this service SENDS
// OUT to the merchant's own infrastructure instead.
const crypto = require('crypto');
const axios = require('axios');
const { ref, serverTimestamp } = require('../firebase/admin');
const { DB_PATHS } = require('../config/constants');
const subscriptionService = require('./subscriptionService');
const logger = require('../utils/logger');

const URL_RE = /^https:\/\/.+/i; // https-only — no plaintext http endpoints
const DELIVERY_TIMEOUT_MS = 8000;

/**
 * How many webhook URLs the given plan allows. -1 means unlimited
 * (Developer plan). Falls back to Blaze's limit if a plan is somehow
 * missing the field (shouldn't happen, but fails safe/restrictive rather
 * than accidentally granting unlimited).
 */
function getLimitForPlan(plan) {
  if (!plan) return 3;
  return typeof plan.webhookLimit === 'number' ? plan.webhookLimit : 3;
}

async function listWebhooks(uid) {
  const snap = await ref(`${DB_PATHS.WEBHOOKS}/${uid}`).once('value');
  if (!snap.exists()) return [];
  const val = snap.val();
  return Object.keys(val).map((id) => ({ id, ...val[id] })).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
}

/**
 * Adds a new webhook URL for this user, enforcing their plan's limit.
 * Throws with a user-facing message on any validation/limit failure so
 * the controller can just forward err.message.
 */
async function addWebhook(uid, url) {
  const trimmed = String(url || '').trim();
  if (!URL_RE.test(trimmed)) {
    throw new Error('Webhook URL must start with https:// (plain http:// is not allowed).');
  }
  if (trimmed.length > 500) {
    throw new Error('Webhook URL is too long.');
  }

  const existing = await listWebhooks(uid);
  if (existing.some((w) => w.url === trimmed)) {
    throw new Error('This URL is already registered.');
  }

  const sub = await subscriptionService.getUserSubscription(uid);
  const limit = getLimitForPlan(sub.plan);
  if (limit !== -1 && existing.length >= limit) {
    throw new Error(`Your ${sub.plan.name} plan allows up to ${limit} webhook URL${limit === 1 ? '' : 's'}. Upgrade your plan to add more, or remove one first.`);
  }

  const id = crypto.randomBytes(8).toString('hex');
  const record = {
    url: trimmed,
    isActive: true,
    createdAt: serverTimestamp(),
    lastTriggeredAt: null,
    lastStatus: null, // 'success' | 'failed' — result of the most recent delivery attempt
  };
  await ref(`${DB_PATHS.WEBHOOKS}/${uid}/${id}`).set(record);
  return { id, ...record };
}

async function deleteWebhook(uid, webhookId) {
  const webhookRef = ref(`${DB_PATHS.WEBHOOKS}/${uid}/${webhookId}`);
  const snap = await webhookRef.once('value');
  if (!snap.exists()) throw new Error('Webhook not found.');
  await webhookRef.remove();
}

async function toggleWebhook(uid, webhookId, isActive) {
  const webhookRef = ref(`${DB_PATHS.WEBHOOKS}/${uid}/${webhookId}`);
  const snap = await webhookRef.once('value');
  if (!snap.exists()) throw new Error('Webhook not found.');
  await webhookRef.update({ isActive: !!isActive });
}

/**
 * Fires a single delivery attempt to every ACTIVE webhook this user has
 * registered. Best-effort and fully isolated per-URL: one merchant's
 * unreachable/slow server can never affect another user's delivery, and a
 * delivery failure never throws back into the payment webhook flow that
 * called this (that flow's own correctness must never depend on the
 * merchant's own server being up). Every attempt updates lastTriggeredAt/
 * lastStatus so the merchant can see delivery health in Developer Portal.
 *
 * @param {string} uid
 * @param {'pending'|'success'|'failed'} event
 * @param {object} payload - order_id, amount, status, etc.
 */
async function notifyUserWebhooks(uid, event, payload) {
  let hooks;
  try {
    hooks = (await listWebhooks(uid)).filter((w) => w.isActive);
  } catch (err) {
    logger.error(`webhookService: failed to list webhooks for ${uid}: ${err.message}`);
    return;
  }
  if (!hooks.length) return;

  const body = {
    event, // 'order.pending' | 'order.success' | 'order.failed'
    ...payload,
    sent_at: Date.now(),
  };

  await Promise.all(hooks.map(async (hook) => {
    const hookRef = ref(`${DB_PATHS.WEBHOOKS}/${uid}/${hook.id}`);
    try {
      await axios.post(hook.url, body, {
        timeout: DELIVERY_TIMEOUT_MS,
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'ZetPay-Webhook/1.0' },
        // Any 2xx counts as delivered; anything else (4xx/5xx) is a failed
        // delivery from ZetPay's point of view — don't throw for those,
        // classify them below instead of letting axios reject on non-2xx.
        validateStatus: () => true,
      }).then(async (res) => {
        const delivered = res.status >= 200 && res.status < 300;
        await hookRef.update({ lastTriggeredAt: Date.now(), lastStatus: delivered ? 'success' : 'failed' });
        if (!delivered) logger.warn(`Webhook delivery non-2xx (${res.status}) for ${uid} -> ${hook.url}`);
      });
    } catch (err) {
      // Network error, timeout, DNS failure, etc.
      try { await hookRef.update({ lastTriggeredAt: Date.now(), lastStatus: 'failed' }); } catch (e) {}
      logger.warn(`Webhook delivery failed for ${uid} -> ${hook.url}: ${err.message}`);
    }
  }));
}

module.exports = {
  getLimitForPlan,
  listWebhooks,
  addWebhook,
  deleteWebhook,
  toggleWebhook,
  notifyUserWebhooks,
};
