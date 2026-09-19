// services/subscriptionService.js
const { ref, serverTimestamp } = require('../firebase/admin');
const { DB_PATHS, DEFAULT_PLANS, SUBSCRIPTION_DURATIONS } = require('../config/constants');
const walletService = require('./walletService');
const logger = require('../utils/logger');

/**
 * The duration/discount tiers available on every plan's purchase flow.
 */
function getDurationOptions() {
  return SUBSCRIPTION_DURATIONS;
}

// Backfills any field missing on a DB-stored plan record with the value
// from DEFAULT_PLANS. Needed because DEFAULT_PLANS has since gained
// fields (webhookLimit, updated feature copy) that older seeded DB
// records never received — the DB always wins verbatim over
// DEFAULT_PLANS without this, so a plan missing webhookLimit would show
// "undefined webhooks" on the frontend, and could feed the literal string
// 'undefined' into a payment remark sent to the UPI gateway (which then
// rejects it as an invalid remark).
function withPlanDefaults(plan) {
  if (!plan) return plan;
  const defaults = DEFAULT_PLANS[plan.id] || {};
  return { ...defaults, ...plan };
}

/**
 * Price breakdown for a plan at a chosen duration. This is the ONLY place
 * that decides what a multi-month purchase actually costs — purchasePlan
 * and purchasePlanWithWallet always recompute from planId + months here
 * instead of trusting any amount the client sends, so a tampered request
 * can never buy a discount it wasn't actually offered.
 * Returns null if `months` isn't one of the configured tiers.
 */
function calculateDurationPrice(monthlyPrice, months) {
  const option = SUBSCRIPTION_DURATIONS.find(d => d.months === Number(months));
  if (!option) return null;
  const basePrice      = Math.round(monthlyPrice * option.months * 100) / 100;
  const discountAmount = Math.round(basePrice * option.discountPercent / 100 * 100) / 100;
  const finalPrice     = Math.round((basePrice - discountAmount) * 100) / 100;
  return {
    months: option.months,
    discountPercent: option.discountPercent,
    basePrice,
    discountAmount,
    finalPrice,
    durationDays: option.months * 30,
  };
}

/**
 * Seed default plans into Firebase ONLY if they don't already exist.
 * Backend will NEVER overwrite existing admin-edited values.
 */
async function seedDefaultPlans() {
  for (const plan of Object.values(DEFAULT_PLANS)) {
    const planRef = ref(`${DB_PATHS.PLANS}/${plan.id}`);
    const snap = await planRef.once('value');
    if (!snap.exists()) {
      await planRef.set({ ...plan, createdAt: Date.now() });
      logger.info(`✅ Seeded missing plan: ${plan.id}`);
    }
  }
}

/**
 * Get all active plans ordered by displayOrder
 */
async function getAllPlans() {
  const snap = await ref(DB_PATHS.PLANS).orderByChild('displayOrder').once('value');
  if (!snap.exists()) return [];
  const plans = [];
  snap.forEach((child) => {
    const plan = child.val();
    if (plan.isActive !== false) plans.push(withPlanDefaults({ id: child.key, ...plan }));
  });
  return plans;
}

/**
 * Get all plans including inactive (admin only)
 */
async function getAllPlansAdmin() {
  const snap = await ref(DB_PATHS.PLANS).orderByChild('displayOrder').once('value');
  if (!snap.exists()) return [];
  const plans = [];
  snap.forEach((child) => plans.push(withPlanDefaults({ id: child.key, ...child.val() })));
  return plans.sort((a, b) => (a.displayOrder || 0) - (b.displayOrder || 0));
}

/**
 * Get a specific plan by ID
 */
async function getPlan(planId) {
  const snap = await ref(`${DB_PATHS.PLANS}/${planId}`).once('value');
  if (!snap.exists()) return null;
  return withPlanDefaults({ id: planId, ...snap.val() });
}

/**
 * Get user's current subscription (with plan details)
 * Falls back to Blaze (free) plan if no subscription
 */
async function getUserSubscription(userId) {
  const snap = await ref(`${DB_PATHS.USER_SUBSCRIPTIONS}/${userId}`).once('value');

  if (!snap.exists()) {
    // Assign Blaze plan
    return await assignFreePlan(userId);
  }

  const sub = snap.val();

  // Check if paid subscription has expired
  if (sub.planId !== 'blaze' && sub.endDate && Date.now() > sub.endDate) {
    logger.info(`Subscription expired for ${userId}, reverting to Blaze`);
    return await assignFreePlan(userId);
  }

  // Attach full plan details
  const plan = await getPlan(sub.planId) || DEFAULT_PLANS[sub.planId] || DEFAULT_PLANS.blaze;
  return { ...sub, plan };
}

/**
 * Has this user ever completed a successful payment for this exact plan
 * before? Used so that switching BACK to a plan already paid for earlier
 * (e.g. bought Bronze, upgraded to Developer, now switching back down to
 * Bronze) doesn't charge them a second time for it — they already own it.
 * Free (Blaze) is always "already owned" since it costs nothing.
 *
 * Reads PAYMENTS records for this user — createPayment() already writes
 * type='subscription' + planId + status on every subscription order, so
 * no new data model is needed.
 */
async function hasUserPaidForPlan(userId, planId) {
  if (planId === 'blaze') return true;
  const snap = await ref(DB_PATHS.PAYMENTS).orderByChild('userId').equalTo(userId).once('value');
  if (!snap.exists()) return false;
  let found = false;
  snap.forEach((child) => {
    const p = child.val();
    if (p.type === 'subscription' && p.planId === planId && p.status === 'success') found = true;
  });
  return found;
}

/**
 * Assign free Blaze plan to user
 */
async function assignFreePlan(userId) {
  const blazePlan = await getPlan('blaze') || DEFAULT_PLANS.blaze;
  const sub = {
    planId: 'blaze',
    planName: blazePlan.name,
    status: 'active',
    startDate: Date.now(),
    endDate: null,        // Free plan never expires
    price: 0,
    paymentLinksUsedThisMonth: 0,
    monthResetDate: getNextMonthReset(),
    withdrawalsThisWeek: 0,
    withdrawalsToday: 0,
    weekResetDate: getNextWeekReset(),
    dayResetDate: getNextDayReset(),
    updatedAt: Date.now(),
  };
  await ref(`${DB_PATHS.USER_SUBSCRIPTIONS}/${userId}`).set(sub);
  // If they were on a higher-limit plan and had a balance that fit THAT
  // plan but not Blaze's ₹500 limit, push the excess into Over Balance
  // rather than just leaving `balance` over the new (lower) cap.
  try { await walletService.enforceWalletCap(userId, blazePlan.walletLimit); } catch (e) { logger.error('enforceWalletCap on downgrade failed: ' + e.message); }
  return { ...sub, plan: blazePlan };
}

/**
 * Upgrade user to a paid plan (called after admin manually activates,
 * or after payment verification for subscription purchase)
 */
async function activateSubscription(userId, planId, durationDays = 30) {
  const plan = await getPlan(planId) || DEFAULT_PLANS[planId];
  if (!plan) throw new Error(`Plan ${planId} not found`);

  const now = Date.now();
  const endDate = durationDays > 0 ? now + durationDays * 24 * 60 * 60 * 1000 : null;

  const sub = {
    planId: plan.id,
    planName: plan.name,
    status: 'active',
    startDate: now,
    endDate,
    price: plan.price,
    paymentLinksUsedThisMonth: 0,
    monthResetDate: getNextMonthReset(),
    withdrawalsThisWeek: 0,
    withdrawalsToday: 0,
    weekResetDate: getNextWeekReset(),
    dayResetDate: getNextDayReset(),
    updatedAt: now,
  };

  await ref(`${DB_PATHS.USER_SUBSCRIPTIONS}/${userId}`).set(sub);
  logger.info(`Subscription activated: User=${userId}, Plan=${planId}`);
  return { ...sub, plan };
}

/**
 * AUTO-UPGRADE
 * Stored on the USER record (not the subscription doc) since
 * activateSubscription/assignFreePlan both fully overwrite the
 * subscription doc — storing it there would wipe the preference on the
 * very upgrade it's meant to trigger.
 */
async function setAutoUpgradePreference(userId, planId) {
  if (planId) {
    await ref(`${DB_PATHS.USERS}/${userId}/autoUpgradePlanId`).set(planId);
  } else {
    await ref(`${DB_PATHS.USERS}/${userId}/autoUpgradePlanId`).remove();
  }
}

/**
 * Called after any wallet credit (real payment, admin adjustment) —
 * if the user has an auto-upgrade target set and their Zap Cash now
 * covers that plan's price, silently completes the upgrade for them.
 * Mirrors the wallet-purchase path in subscriptionController.js.
 */
async function maybeAutoUpgrade(userId) {
  const prefSnap = await ref(`${DB_PATHS.USERS}/${userId}/autoUpgradePlanId`).once('value');
  const targetPlanId = prefSnap.val();
  if (!targetPlanId) return null;

  const plan = await getPlan(targetPlanId) || DEFAULT_PLANS[targetPlanId];
  if (!plan || plan.price <= 0) { await setAutoUpgradePreference(userId, null); return null; }

  const balance = await walletService.getBalance(userId);
  if (balance < plan.price) return null; // not yet — leave the preference in place

  try {
    await walletService.debitWallet(userId, plan.price, `Auto-upgrade: ${plan.name}`);
  } catch (e) {
    return null; // race with something else that spent the balance first — try again next credit
  }

  const sub = await activateSubscription(userId, targetPlanId, 30);
  await walletService.enforceWalletCap(userId, plan.walletLimit); // pull back any Over Balance that now fits
  await setAutoUpgradePreference(userId, null); // one-shot — clear once fulfilled

  const notificationService = require('./notificationService');
  await notificationService.createNotification(userId, {
    title: `🚀 Auto-Upgraded to ${plan.name}!`,
    message: `₹${plan.price} was automatically deducted from your Zap Cash and your ${plan.name} plan is now active for 30 days.`,
    type: 'subscription',
  });

  logger.info(`Auto-upgrade completed: User=${userId}, Plan=${targetPlanId}`);
  return sub;
}

/**
 * Check and reset monthly link count if month has passed
 */
async function checkAndResetMonthlyLinks(userId) {
  const subRef = ref(`${DB_PATHS.USER_SUBSCRIPTIONS}/${userId}`);
  const snap = await subRef.once('value');
  if (!snap.exists()) return;

  const sub = snap.val();
  if (Date.now() > (sub.monthResetDate || 0)) {
    await subRef.update({
      paymentLinksUsedThisMonth: 0,
      monthResetDate: getNextMonthReset(),
    });
  }
}

/**
 * Increment payment link count for user
 * (same .transaction() reliability fix as walletService — see notes there)
 */
async function incrementLinkCount(userId) {
  await checkAndResetMonthlyLinks(userId);
  const subRef = ref(`${DB_PATHS.USER_SUBSCRIPTIONS}/${userId}`);
  const snap = await subRef.once('value');
  const sub = snap.val();
  if (!sub) return;
  await subRef.update({ paymentLinksUsedThisMonth: (sub.paymentLinksUsedThisMonth || 0) + 1 });
}

/**
 * Decrement payment link count for user — called when a link is
 * permanently deleted, freeing up that slot in their monthly quota.
 * Deliberately does NOT call checkAndResetMonthlyLinks first (unlike
 * increment) — deleting a link should never trigger a fresh counting
 * period; it should just reduce whatever the current count already is.
 * Floored at 0 so it can never go negative (e.g. if the month already
 * reset between creating and deleting the link).
 */
async function decrementLinkCount(userId) {
  const subRef = ref(`${DB_PATHS.USER_SUBSCRIPTIONS}/${userId}`);
  const snap = await subRef.once('value');
  const sub = snap.val();
  if (!sub) return;
  const next = Math.max(0, (sub.paymentLinksUsedThisMonth || 0) - 1);
  await subRef.update({ paymentLinksUsedThisMonth: next });
}

/**
 * Check withdrawal limits based on plan
 */
async function checkWithdrawalLimit(userId, plan) {
  const subRef = ref(`${DB_PATHS.USER_SUBSCRIPTIONS}/${userId}`);
  const snap = await subRef.once('value');
  const sub = snap.val() || {};

  const period = plan.withdrawalPeriod || 'week';
  const maxCount = plan.withdrawalCount || 1;

  let usedCount, resetDate, resetKey, usedKey;

  if (period === 'day') {
    usedCount = sub.withdrawalsToday || 0;
    resetDate = sub.dayResetDate || 0;
    usedKey = 'withdrawalsToday';
    resetKey = 'dayResetDate';
    const isExpired = Date.now() > resetDate;
    if (isExpired) { usedCount = 0; }
  } else {
    usedCount = sub.withdrawalsThisWeek || 0;
    resetDate = sub.weekResetDate || 0;
    usedKey = 'withdrawalsThisWeek';
    resetKey = 'weekResetDate';
    const isExpired = Date.now() > resetDate;
    if (isExpired) { usedCount = 0; }
  }

  return {
    allowed: usedCount < maxCount,
    used: usedCount,
    max: maxCount,
    period,
    usedKey,
    resetKey,
  };
}

/**
 * Increment withdrawal count after successful submission
 */
async function incrementWithdrawalCount(userId, plan) {
  const info = await checkWithdrawalLimit(userId, plan);
  const subRef = ref(`${DB_PATHS.USER_SUBSCRIPTIONS}/${userId}`);
  const snap = await subRef.once('value');
  const sub = snap.val() || {};
  const period = plan.withdrawalPeriod || 'week';

  const update = {};
  if (period === 'day') {
    const isExpired = Date.now() > (sub.dayResetDate || 0);
    update.withdrawalsToday = isExpired ? 1 : (sub.withdrawalsToday || 0) + 1;
    if (isExpired) update.dayResetDate = getNextDayReset();
  } else {
    const isExpired = Date.now() > (sub.weekResetDate || 0);
    update.withdrawalsThisWeek = isExpired ? 1 : (sub.withdrawalsThisWeek || 0) + 1;
    if (isExpired) update.weekResetDate = getNextWeekReset();
  }

  await subRef.update(update);
}

// ── Date helpers ──
function getNextMonthReset() {
  const d = new Date();
  d.setMonth(d.getMonth() + 1, 1);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function getNextWeekReset() {
  const d = new Date();
  d.setDate(d.getDate() + (7 - d.getDay()));
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function getNextDayReset() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

module.exports = {
  seedDefaultPlans,
  getAllPlans,
  getAllPlansAdmin,
  getPlan,
  getUserSubscription,
  hasUserPaidForPlan,
  getDurationOptions,
  calculateDurationPrice,
  assignFreePlan,
  activateSubscription,
  checkAndResetMonthlyLinks,
  incrementLinkCount,
  decrementLinkCount,
  checkWithdrawalLimit,
  incrementWithdrawalCount,
  setAutoUpgradePreference,
  maybeAutoUpgrade,
};
