// services/gatewayModeService.js - ZetPay Gateway Test Mode / Live Mode
//
// A merchant can flip their account between LIVE (real Zap UPI Gateway, real
// money) and TEST (simulated checkout via test.html, no real money ever
// moves) from the Developer Portal. This service is the single source of
// truth for that toggle and for building the URL a customer gets sent to
// while a merchant is in test mode.
//
// Defaults to 'live' for every existing and new account so nothing about
// current production behaviour changes unless a merchant explicitly opts
// into 'test'.

const { ref, serverTimestamp } = require('../firebase/admin');
const { DB_PATHS } = require('../config/constants');

const VALID_MODES = ['live', 'test'];

/**
 * Get a merchant's current gateway mode. Always resolves to 'live' or 'test'
 * (never throws, never returns undefined/null) so callers can branch on it
 * directly.
 */
async function getMode(uid) {
  const snap = await ref(`${DB_PATHS.USERS}/${uid}/gatewayMode`).once('value');
  return snap.val() === 'test' ? 'test' : 'live';
}

/**
 * Set a merchant's gateway mode. Throws on an invalid value so the calling
 * controller can turn that into a clean 400 response.
 */
async function setMode(uid, mode) {
  if (!VALID_MODES.includes(mode)) {
    throw new Error(`Invalid gateway mode: ${mode}`);
  }
  await ref(`${DB_PATHS.USERS}/${uid}`).update({
    gatewayMode: mode,
    gatewayModeUpdatedAt: serverTimestamp(),
  });
  return mode;
}

/**
 * The merchant-facing frontend's primary origin — same normalisation
 * zapService.js already uses for its own default success/failed URLs, kept
 * here too so gatewayTestController can build the same kind of fallback
 * redirect for test orders without duplicating the parsing logic.
 */
function getFrontendBase() {
  return (process.env.FRONTEND_URL || '').split(',')[0].trim().replace(/\/+$/, '');
}

/**
 * Base URL that hosts the public storefront (root/store/index.html) —
 * deliberately NOT the same as FRONTEND_URL. FRONTEND_URL points at the
 * panel subdomain that serves pay.html/link.html; the storefront lives on
 * the root marketing domain instead (customer-facing, clean "zetpay.online"
 * link). Override with STORE_URL if that ever needs to change; defaults to
 * the production root domain so nothing breaks if the env var is unset.
 */
function getStoreBase() {
  const raw = process.env.STORE_URL || 'https://zetpay.online';
  return raw.split(',')[0].trim().replace(/\/+$/, '');
}

/**
 * Base URL that hosts test.html. Defaults to FRONTEND_URL (the panel domain
 * that already serves pay.html/link.html) since test.html ships alongside
 * them there. Override with TEST_GATEWAY_URL if you'd rather host it
 * elsewhere (e.g. only on the marketing root domain).
 */
function getTestGatewayBase() {
  const raw = process.env.TEST_GATEWAY_URL || process.env.FRONTEND_URL || '';
  return raw.split(',')[0].trim().replace(/\/+$/, '');
}

/**
 * Build the fake "payment_url" a test-mode order gets instead of a real Zap
 * UPI Gateway URL — customers land on our own simulator instead of a real
 * checkout page.
 */
function buildTestPaymentUrl(orderId) {
  return `${getTestGatewayBase()}/test.html?order=${encodeURIComponent(orderId)}`;
}

module.exports = {
  getMode,
  setMode,
  buildTestPaymentUrl,
  getFrontendBase,
  getStoreBase,
};
