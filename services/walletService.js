// services/walletService.js - Wallet Operations with Firebase Transactions
const { ref, serverTimestamp } = require('../firebase/admin');
const { DB_PATHS } = require('../config/constants');
const firebaseService = require('./firebaseService');
const logger = require('../utils/logger');

/**
 * Get wallet balance for a user
 */
async function getBalance(userId) {
  const snap = await ref(`${DB_PATHS.USERS}/${userId}/wallet/balance`).once('value');
  return snap.exists() ? parseFloat(snap.val()) : 0;
}

/**
 * OVER BALANCE — keeps `balance` from ever exceeding the user's CURRENT
 * plan's wallet limit. Anything over that limit lives in `overBalance`
 * instead — untouchable by withdrawals or purchases (debitWallet never
 * reads it) until the user's effective limit rises enough to absorb it
 * (upgrading a plan), at which point it merges back into `balance`.
 * Pass `walletLimitOverride` when the caller already knows the limit to
 * use (e.g. right after a plan change) to skip a redundant lookup.
 */
async function enforceWalletCap(userId, walletLimitOverride = null) {
  const walletRef = ref(`${DB_PATHS.USERS}/${userId}/wallet`);
  const snap = await walletRef.once('value');
  const w = snap.val() || {};
  const balance = parseFloat(w.balance || 0);
  const overBalance = parseFloat(w.overBalance || 0);
  const total = Math.round((balance + overBalance) * 100) / 100;

  const limit = walletLimitOverride != null ? walletLimitOverride : await firebaseService.getEffectiveWalletLimit(userId);

  let newBalance, newOverBalance;
  if (limit <= 0 || total <= limit) {
    newBalance = total;
    newOverBalance = 0;
  } else {
    newBalance = limit;
    newOverBalance = Math.round((total - limit) * 100) / 100;
  }

  if (newBalance !== balance || newOverBalance !== overBalance) {
    await walletRef.update({ balance: newBalance, overBalance: newOverBalance, lastUpdated: Date.now() });
  }
  return { balance: newBalance, overBalance: newOverBalance };
}

async function getOverBalance(userId) {
  const snap = await ref(`${DB_PATHS.USERS}/${userId}/wallet/overBalance`).once('value');
  return snap.exists() ? parseFloat(snap.val()) : 0;
}

/**
 * Credit wallet
 * NOTE: previously used Firebase's .transaction(), but the Admin SDK's
 * RTDB transactions are unreliable on serverless cold starts (Vercel) —
 * they can spuriously abort even when the data is valid, since the SDK
 * has no persistent local cache to optimistically work from. A simple
 * read-then-write is far more reliable here; true simultaneous double
 * requests for the same user are rare enough that this tradeoff is safe.
 * @param {string} userId
 * @param {number} amount - Amount to credit
 * @param {string} reason - Reason for credit (for logging)
 */
async function creditWallet(userId, amount, reason = '') {
  // Hide Wallet System: once enabled, Zap Cash can no longer receive new
  // money through ANY path — this function is the single choke point every
  // credit route funnels through (FamPay/Paytm webhooks, SMS webhook,
  // ZapUPI webhook, admin adjustments excepted — see adminAdjustWallet).
  // Existing balances are untouched; only new top-ups are blocked. This is
  // a last-resort backstop — the real prevention is upstream, in
  // paymentLinkController/developerController refusing to create orders at
  // all for a merchant with no cashier connected once this is on. If this
  // guard actually fires in practice, it means something got past that
  // upstream check and should be investigated, not silently relied upon.
  const settings = await firebaseService.getSettings();
  if (settings.hideWalletSystemEnabled) {
    logger.warn(`creditWallet blocked by Hide Wallet System: User=${userId}, Amount=₹${amount}, Reason=${reason}`);
    return getBalance(userId);
  }

  const walletRef = ref(`${DB_PATHS.USERS}/${userId}/wallet`);
  const snap = await walletRef.once('value');
  const currentWallet = snap.val();
  const currentBalance = currentWallet ? parseFloat(currentWallet.balance || 0) : 0;
  const rawNewBalance = Math.round((currentBalance + amount) * 100) / 100;
  await walletRef.update({ balance: rawNewBalance, lastUpdated: Date.now() });

  // Cap against the current plan's wallet limit — any overflow moves to
  // Over Balance instead of just sitting in `balance` unbounded.
  const capped = await enforceWalletCap(userId);
  logger.info(`Wallet credited: User=${userId}, Amount=₹${amount}, Reason=${reason}, Balance=₹${capped.balance}, OverBalance=₹${capped.overBalance}`);
  return capped.balance;
}

/**
 * Debit wallet
 * Same reliability fix as creditWallet above — .transaction() on this
 * SDK/environment combo could spuriously report a committed:false abort
 * even when the balance was genuinely sufficient, which surfaced to users
 * as an incorrect "Insufficient balance" error on valid purchases.
 * @param {string} userId
 * @param {number} amount - Amount to debit
 * @param {string} reason - Reason for debit
 */
async function debitWallet(userId, amount, reason = '') {
  const walletRef = ref(`${DB_PATHS.USERS}/${userId}/wallet`);
  const snap = await walletRef.once('value');
  const currentWallet = snap.val();
  if (!currentWallet) throw new Error('INSUFFICIENT_BALANCE');
  const currentBalance = parseFloat(currentWallet.balance || 0);
  if (currentBalance < amount) throw new Error('INSUFFICIENT_BALANCE');
  const newBalance = Math.round((currentBalance - amount) * 100) / 100;
  await walletRef.update({ balance: newBalance, lastUpdated: Date.now() });
  logger.info(`Wallet debited: User=${userId}, Amount=₹${amount}, Reason=${reason}, Balance=₹${newBalance}`);
  return newBalance;
}

/**
 * Manual wallet adjustment by admin (credit or debit)
 * @param {string} userId
 * @param {number} amount - Positive = credit, Negative = debit
 * @param {string} reason
 */
async function adminAdjustWallet(userId, amount, reason = 'Admin adjustment') {
  // Bypasses the Hide Wallet System guard in creditWallet deliberately —
  // that guard exists to stop new THIRD-PARTY money flowing in through
  // payment webhooks, not to stop the admin correcting a balance or
  // issuing a refund. Duplicates creditWallet's core logic rather than
  // calling it, specifically to skip that check.
  if (amount > 0) {
    const walletRef = ref(`${DB_PATHS.USERS}/${userId}/wallet`);
    const snap = await walletRef.once('value');
    const currentWallet = snap.val();
    const currentBalance = currentWallet ? parseFloat(currentWallet.balance || 0) : 0;
    const rawNewBalance = Math.round((currentBalance + amount) * 100) / 100;
    await walletRef.update({ balance: rawNewBalance, lastUpdated: Date.now() });
    const capped = await enforceWalletCap(userId);
    logger.info(`Wallet credited (admin, bypasses Hide Wallet System): User=${userId}, Amount=₹${amount}, Reason=${reason}, Balance=₹${capped.balance}`);
    return capped.balance;
  } else if (amount < 0) {
    return await debitWallet(userId, Math.abs(amount), reason);
  }
  return await getBalance(userId);
}

/* ============================================================
   ZAP BONUS — a separate, currently-inert balance.
   Deliberately isolated from every function above: nothing in
   subscriptionService/withdrawalController/paymentController reads or
   writes this. It exists purely so a balance can be tracked and shown to
   the user; what it can actually be spent on is a future decision.
   Structurally mirrors the cash wallet functions above for consistency,
   just pointed at wallet/bonusBalance instead of wallet/balance.
============================================================ */

async function getBonusBalance(userId) {
  const snap = await ref(`${DB_PATHS.USERS}/${userId}/wallet/bonusBalance`).once('value');
  return snap.exists() ? parseFloat(snap.val()) : 0;
}

async function creditBonusWallet(userId, amount, reason = '') {
  const walletRef = ref(`${DB_PATHS.USERS}/${userId}/wallet`);
  const snap = await walletRef.once('value');
  const currentWallet = snap.val();
  const currentBonus = currentWallet ? parseFloat(currentWallet.bonusBalance || 0) : 0;
  const newBonus = Math.round((currentBonus + amount) * 100) / 100;
  await walletRef.update({ bonusBalance: newBonus, bonusLastUpdated: Date.now() });
  logger.info(`Zap Bonus credited: User=${userId}, Amount=₹${amount}, Reason=${reason}, Bonus=₹${newBonus}`);
  return newBonus;
}

async function debitBonusWallet(userId, amount, reason = '') {
  const walletRef = ref(`${DB_PATHS.USERS}/${userId}/wallet`);
  const snap = await walletRef.once('value');
  const currentWallet = snap.val();
  const currentBonus = currentWallet ? parseFloat(currentWallet.bonusBalance || 0) : 0;
  if (currentBonus < amount) throw new Error('INSUFFICIENT_BONUS_BALANCE');
  const newBonus = Math.round((currentBonus - amount) * 100) / 100;
  await walletRef.update({ bonusBalance: newBonus, bonusLastUpdated: Date.now() });
  logger.info(`Zap Bonus debited: User=${userId}, Amount=₹${amount}, Reason=${reason}, Bonus=₹${newBonus}`);
  return newBonus;
}

async function adminAdjustBonusWallet(userId, amount, reason = 'Admin adjustment') {
  if (amount > 0) {
    return await creditBonusWallet(userId, amount, reason);
  } else if (amount < 0) {
    return await debitBonusWallet(userId, Math.abs(amount), reason);
  }
  return await getBonusBalance(userId);
}

/* ============================================================
   ZAP CREDIT — the balance that pays a merchant's per-transaction
   commission whenever a customer completes an order (Payment Link,
   Store purchase, Cashier checkout). Separate from Zap Cash: Zap Cash
   is the merchant's real money, Zap Credit is purely "fuel" spent to
   accept payments. New users start with a signup grant (see
   config/constants.js ZAP_CREDIT_SIGNUP_GRANT); existing users are
   backfilled once the same way (see firebaseService.upsertUser).
   Converting Zap Cash -> Zap Credit is 1:1 and free (0% commission —
   it's the merchant moving their own money internally). Recharging
   via UPI credits this balance directly once the top-up order succeeds.
============================================================ */

async function getZapCredit(userId) {
  const snap = await ref(`${DB_PATHS.USERS}/${userId}/wallet/zapCredit`).once('value');
  return snap.exists() ? parseFloat(snap.val()) : 0;
}

async function creditZapCredit(userId, amount, reason = '') {
  const walletRef = ref(`${DB_PATHS.USERS}/${userId}/wallet`);
  const snap = await walletRef.once('value');
  const currentWallet = snap.val();
  const current = currentWallet ? parseFloat(currentWallet.zapCredit || 0) : 0;
  const newBalance = Math.round((current + amount) * 100) / 100;
  await walletRef.update({ zapCredit: newBalance, zapCreditLastUpdated: Date.now() });
  logger.info(`Zap Credit credited: User=${userId}, Amount=${amount}, Reason=${reason}, Balance=${newBalance}`);
  return newBalance;
}

async function debitZapCredit(userId, amount, reason = '') {
  const walletRef = ref(`${DB_PATHS.USERS}/${userId}/wallet`);
  const snap = await walletRef.once('value');
  const currentWallet = snap.val();
  const current = currentWallet ? parseFloat(currentWallet.zapCredit || 0) : 0;
  if (current < amount) throw new Error('INSUFFICIENT_ZAP_CREDIT');
  const newBalance = Math.round((current - amount) * 100) / 100;
  await walletRef.update({ zapCredit: newBalance, zapCreditLastUpdated: Date.now() });
  logger.info(`Zap Credit debited: User=${userId}, Amount=${amount}, Reason=${reason}, Balance=${newBalance}`);
  return newBalance;
}

/**
 * Checks whether a user has enough Zap Credit to cover the commission
 * on an order of the given amount, using their plan's commissionPercent.
 * Used to gate checkout creation BEFORE a payment link/page is issued,
 * so a customer never lands on a checkout page the merchant can't
 * actually get paid out for.
 * @returns {{ ok: boolean, required: number, available: number }}
 */
async function checkSufficientCreditForOrder(userId, orderAmount, commissionPercent) {
  const required = Math.round((orderAmount * commissionPercent) / 100 * 100) / 100;
  const available = await getZapCredit(userId);
  return { ok: available >= required, required, available };
}

/**
 * Admin manual adjustment (credit or debit), mirrors adminAdjustWallet.
 */
async function adminAdjustZapCredit(userId, amount, reason = 'Admin adjustment') {
  if (amount > 0) {
    return await creditZapCredit(userId, amount, reason);
  } else if (amount < 0) {
    return await debitZapCredit(userId, Math.abs(amount), reason);
  }
  return await getZapCredit(userId);
}

module.exports = {
  getBalance,
  creditWallet,
  debitWallet,
  adminAdjustWallet,
  enforceWalletCap,
  getOverBalance,
  getBonusBalance,
  creditBonusWallet,
  debitBonusWallet,
  adminAdjustBonusWallet,
  getZapCredit,
  creditZapCredit,
  debitZapCredit,
  checkSufficientCreditForOrder,
  adminAdjustZapCredit,
};
