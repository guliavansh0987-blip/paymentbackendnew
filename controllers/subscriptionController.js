// controllers/subscriptionController.js
const subscriptionService = require('../services/subscriptionService');
const firebaseService     = require('../services/firebaseService');
const walletService       = require('../services/walletService');
const notificationService = require('../services/notificationService');
const zapService          = require('../services/zapService');
const { ref }             = require('../firebase/admin');
const { DB_PATHS, DEFAULT_PLANS } = require('../config/constants');
const response = require('../helpers/response');
const logger   = require('../utils/logger');
const { body, validationResult } = require('express-validator');

/** GET /api/subscription/plans — public */
const getPlans = async (req, res) => {
  try {
    let plans = await subscriptionService.getAllPlans();

    // Fallback: if DB empty, return defaults (happens before first seed)
    if (!plans || plans.length === 0) {
      plans = Object.values(DEFAULT_PLANS).filter(p => p.isActive !== false);
    }

    return response.success(res, 'Plans fetched', { plans });
  } catch (err) {
    // Always return default plans even on error
    const plans = Object.values(DEFAULT_PLANS);
    return response.success(res, 'Plans fetched', { plans });
  }
};

/** GET /api/subscription/duration-options — public. The duration/discount
 * tiers shown on the upgrade flow's "Choose Duration" step. */
const getDurationOptions = async (req, res) => {
  try {
    return response.success(res, 'Duration options fetched', { durations: subscriptionService.getDurationOptions() });
  } catch (err) {
    return response.success(res, 'Duration options fetched', { durations: subscriptionService.getDurationOptions() });
  }
};

/** GET /api/subscription/my */
const setAutoUpgrade = async (req, res) => {
  try {
    const { planId } = req.body; // null/omitted = cancel
    if (planId) {
      const plan = await subscriptionService.getPlan(planId) || DEFAULT_PLANS[planId];
      if (!plan) return response.notFound(res, 'Plan not found');
    }
    await subscriptionService.setAutoUpgradePreference(req.user.uid, planId || null);
    return response.success(res, planId ? `Auto-upgrade to this plan enabled.` : 'Auto-upgrade cancelled.', { planId: planId || null });
  } catch (err) {
    return response.serverError(res, err.message);
  }
};

const getMySubscription = async (req, res) => {
  try {
    const sub = await subscriptionService.getUserSubscription(req.user.uid);
    const [overBalance, autoUpgradeSnap] = await Promise.all([
      walletService.getOverBalance(req.user.uid),
      ref(`${DB_PATHS.USERS}/${req.user.uid}/autoUpgradePlanId`).once('value'),
    ]);
    return response.success(res, 'Subscription fetched', { subscription: sub, overBalance, autoUpgradePlanId: autoUpgradeSnap.val() || null });
  } catch (err) {
    logger.error('Get subscription error:', err.message);
    // Return Blaze as fallback
    return response.success(res, 'Subscription fetched', {
      subscription: {
        planId: 'blaze', status: 'active', endDate: null,
        paymentLinksUsedThisMonth: 0,
        plan: DEFAULT_PLANS.blaze
      },
      overBalance: 0, autoUpgradePlanId: null,
    });
  }
};

/**
 * POST /api/subscription/purchase
 * Creates a payment order for plan upgrade (Zap UPI or Admin Cashier)
 */
const purchasePlan = async (req, res) => {
  try {
    const { planId, confirmDowngrade, durationMonths } = req.body;
    if (!planId) return response.error(res, 'planId required');

    const plan = await subscriptionService.getPlan(planId) || DEFAULT_PLANS[planId];
    if (!plan) return response.notFound(res, 'Plan not found');
    if (plan.price === 0) return response.error(res, 'Blaze plan is free — no payment needed');

    // Price is ALWAYS computed here from planId + durationMonths — never
    // trust a client-sent amount, or a tampered request could buy a
    // discount it was never actually offered. Defaults to 1 month (no
    // discount) if omitted, so older frontend builds keep working.
    const pricing = subscriptionService.calculateDurationPrice(plan.price, durationMonths || 1);
    if (!pricing) return response.error(res, 'Invalid duration selected');

    const userId = req.user.uid;

    // Guard against silently downgrading (e.g. Developer -> Bronze) without
    // the user explicitly acknowledging they'll lose the higher plan's
    // benefits. The dashboard shows a confirmation modal and resends with
    // confirmDowngrade:true; a direct API call without it gets a clear
    // 409 instead of quietly switching them down.
    const currentSub = await subscriptionService.getUserSubscription(userId);
    const isDowngrade = (plan.displayOrder || 0) < (currentSub?.plan?.displayOrder || 0);
    if (isDowngrade && !confirmDowngrade) {
      return response.error(res, `You're currently on ${currentSub.plan.name}. Switching to ${plan.name} will replace it and you'll lose its higher limits. Confirm to continue.`, 409, { requiresDowngradeConfirmation: true, currentPlan: currentSub.plan.name });
    }

    // Already paid for this plan before (e.g. bought Bronze earlier,
    // upgraded to Developer since, now switching back to Bronze) — skip
    // the UPI payment step entirely and just re-activate it for free.
    const alreadyPaid = await subscriptionService.hasUserPaidForPlan(userId, planId);
    if (alreadyPaid) {
      const sub = await subscriptionService.activateSubscription(userId, planId, 30);
      await walletService.enforceWalletCap(userId, plan.walletLimit);
      await subscriptionService.setAutoUpgradePreference(userId, null);
      await notificationService.createNotification(userId, {
        title: `🎉 ${plan.name} Plan Activated!`,
        message: `Switched back to ${plan.name} — no charge, you already own this plan.`,
        type: 'subscription',
      });
      await firebaseService.logActivity(userId, 'SUBSCRIPTION_REACTIVATED_FREE', { planId: plan.id, planName: plan.name });
      logger.info(`Subscription re-activated (already owned, no charge): ${userId} → ${planId}`);
      return response.success(res, `Switched to ${plan.name} — no charge since you already own this plan.`, { subscription: sub, plan, alreadyOwned: true });
    }

    const orderId = zapService.generateOrderId(userId);

    const settings = await firebaseService.getSettings();
    let isSystemCashier = false;
    let sysAdminUser = null;
    if (settings.systemRoutingMode === 'self' && settings.systemRoutingAdminUid) {
      sysAdminUser = await firebaseService.getUser(settings.systemRoutingAdminUid);
      if (sysAdminUser && sysAdminUser.fampay && sysAdminUser.fampay.isConnected) {
        isSystemCashier = true;
      }
    }

    // Save subscription order in payments with type='subscription'.
    // durationMonths/durationDays travel with the record so the webhook
    // (which only ever sees the orderId) knows how many days to activate
    // for once the payment confirms — see zapWebhook.js.
    await firebaseService.createPayment(orderId, {
      userId,
      amount: pricing.finalPrice,
      remark: `ZetPay Subscription - ${plan.name} - ${pricing.months} mo`,
      type: 'subscription',
      planId: plan.id,
      durationMonths: pricing.months,
      durationDays: pricing.durationDays,
      routingEngine: isSystemCashier ? 'system_cashier' : 'wallet',
      paymentMethod: isSystemCashier ? 'fampay' : 'zapupi',
      cashierUpiId: isSystemCashier ? sysAdminUser.fampay.upiId : null,
      fampayVerifyUid: isSystemCashier ? sysAdminUser.uid : null
    });

    if (isSystemCashier) {
        // Same comma-separated FRONTEND_URL caveat as elsewhere — take only the first origin.
        const frontendUrl = (process.env.FRONTEND_URL || '').split(',')[0].trim().replace(/\/+$/, '');
        const dashboardRedir = `${frontendUrl}/index.html?payment=success&order=${orderId}`;
        const checkoutUrl = `https://zetpay.online/checkout.html?order_id=${orderId}&amount=${pricing.finalPrice}&upi=${encodeURIComponent(sysAdminUser.fampay.upiId)}&redirect_url=${encodeURIComponent(dashboardRedir)}`;
        
        logger.info(`Subscription order (System Cashier): ${orderId} user=${userId}`);
        
        return response.success(res, 'Payment order created', {
            orderId: orderId,
            paymentUrl: checkoutUrl,
            amount: pricing.finalPrice,
            planName: plan.name,
            pricing,
        });
    }

    // Create Zap UPI order
    const zapOrder = await zapService.createOrder({
      orderId,
      amount: String(pricing.finalPrice.toFixed(2)),
      remark: `ZetPay ${plan.name} Plan - ${pricing.months} mo`,
    });

    logger.info(`Subscription order: ${orderId} user=${userId} plan=${planId} months=${pricing.months} amount=${pricing.finalPrice}`);

    return response.success(res, 'Payment order created', {
      orderId: zapOrder.orderId,
      paymentUrl: zapOrder.paymentUrl,
      amount: pricing.finalPrice,
      planName: plan.name,
      pricing,
    });
  } catch (err) {
    logger.error('Purchase plan error:', err.message);
    return response.serverError(res, err.message);
  }
};

/**
 * POST /api/subscription/purchase-wallet
 * Pay for a plan upgrade directly from wallet balance — instant activation,
 * no UPI gateway involved.
 */
const purchasePlanWithWallet = async (req, res) => {
  try {
    const { planId, autoUpgrade, confirmDowngrade, durationMonths } = req.body;
    if (!planId) return response.error(res, 'planId required');

    const plan = await subscriptionService.getPlan(planId) || DEFAULT_PLANS[planId];
    if (!plan) return response.notFound(res, 'Plan not found');
    if (plan.price === 0) return response.error(res, 'Blaze plan is free — no payment needed');

    // Same rule as the UPI path: price is always computed here, never
    // trusted from the client.
    const pricing = subscriptionService.calculateDurationPrice(plan.price, durationMonths || 1);
    if (!pricing) return response.error(res, 'Invalid duration selected');

    const userId = req.user.uid;

    // Same downgrade guard as the UPI purchase path — see comment there.
    const currentSubForCheck = await subscriptionService.getUserSubscription(userId);
    const isDowngrade = (plan.displayOrder || 0) < (currentSubForCheck?.plan?.displayOrder || 0);
    if (isDowngrade && !confirmDowngrade) {
      return response.error(res, `You're currently on ${currentSubForCheck.plan.name}. Switching to ${plan.name} will replace it and you'll lose its higher limits. Confirm to continue.`, 409, { requiresDowngradeConfirmation: true, currentPlan: currentSubForCheck.plan.name });
    }

    // Already paid for this plan before (e.g. bought Bronze earlier,
    // upgraded to Developer since, now switching back to Bronze) — just
    // re-activate it for free instead of charging a second time. This
    // stays a flat 30-day freebie regardless of the duration picked above
    // — since nothing is actually being charged here, honoring a chosen
    // 24-month discount for free isn't something we want to hand out.
    const alreadyPaid = await subscriptionService.hasUserPaidForPlan(userId, planId);
    if (alreadyPaid) {
      const sub = await subscriptionService.activateSubscription(userId, planId, 30);
      await walletService.enforceWalletCap(userId, plan.walletLimit);
      await subscriptionService.setAutoUpgradePreference(userId, null);
      await notificationService.createNotification(userId, {
        title: `🎉 ${plan.name} Plan Activated!`,
        message: `Switched back to ${plan.name} — no charge, you already own this plan.`,
        type: 'subscription',
      });
      await firebaseService.logActivity(userId, 'SUBSCRIPTION_REACTIVATED_FREE', { planId: plan.id, planName: plan.name });
      logger.info(`Subscription re-activated (already owned, no charge): ${userId} → ${planId}`);
      return response.success(res, `Switched to ${plan.name} — no charge since you already own this plan.`, { subscription: sub, plan, alreadyOwned: true });
    }

    const balance = await walletService.getBalance(userId);

    if (balance < pricing.finalPrice) {
      if (autoUpgrade) {
        // Not enough right now — save this as a standing instruction and
        // silently complete the upgrade the moment enough Zap Cash comes
        // in (see subscriptionService.maybeAutoUpgrade, checked after
        // every wallet credit). That path only ever knows planId (not a
        // duration), so it always auto-upgrades at the plain 1-month
        // price — the multi-month discount picked here doesn't carry
        // over to a deferred auto-upgrade.
        await subscriptionService.setAutoUpgradePreference(userId, planId);
        return response.success(res, `We'll upgrade you to ${plan.name} (1 month) automatically as soon as your Zap Cash covers ₹${plan.price}.`, { autoUpgradeScheduled: true, planId });
      }
      return response.error(res, `Insufficient wallet balance. You need ₹${pricing.finalPrice}, available: ₹${balance.toFixed(2)}`);
    }

    // Debit wallet (transaction-safe, re-checks balance internally)
    try {
      await walletService.debitWallet(userId, pricing.finalPrice, `Subscription: ${plan.name} (${pricing.months} mo)`);
    } catch (debitErr) {
      if (debitErr.message === 'INSUFFICIENT_BALANCE') {
        return response.error(res, 'Insufficient wallet balance.');
      }
      throw debitErr;
    }

    // Activate immediately — no webhook needed for wallet payments
    const sub = await subscriptionService.activateSubscription(userId, planId, pricing.durationDays);
    // Pull back any Over Balance that now fits under the new plan's limit
    await walletService.enforceWalletCap(userId, plan.walletLimit);
    // This purchase supersedes any standing auto-upgrade instruction
    await subscriptionService.setAutoUpgradePreference(userId, null);

    const orderId = zapService.generateOrderId(userId);
    await firebaseService.createPayment(orderId, {
      userId,
      amount: pricing.finalPrice,
      remark: `ZetPay Subscription - Wallet - ${plan.name} - ${pricing.months} mo`,
      type: 'subscription',
      planId: plan.id,
      durationMonths: pricing.months,
      durationDays: pricing.durationDays,
    });
    await firebaseService.updatePaymentStatus(orderId, { status: 'Success', txn_id: 'WALLET', utr: '', amount: pricing.finalPrice, pay_amount: pricing.finalPrice });

    const durationLabel = pricing.months === 1 ? '1 month' : `${pricing.months} months`;
    await notificationService.createNotification(userId, {
      title: `🎉 ${plan.name} Plan Activated!`,
      message: `₹${pricing.finalPrice} deducted from wallet. Your ${plan.name} subscription is now active for ${durationLabel}.`,
      type: 'subscription',
    });

    await firebaseService.logActivity(userId, 'SUBSCRIPTION_ACTIVATED_WALLET', {
      planId: plan.id, planName: plan.name, amount: pricing.finalPrice, durationMonths: pricing.months, orderId,
    });

    logger.info(`Subscription via wallet: ${userId} → ${planId} months=${pricing.months} amount=${pricing.finalPrice}`);

    return response.success(res, `${plan.name} plan activated!`, {
      subscription: sub,
      plan,
      orderId,
      pricing,
    });
  } catch (err) {
    logger.error('Purchase plan with wallet error:', err.message);
    return response.serverError(res, err.message);
  }
};

// ─── Admin Plan Management ──────────────────────────────────

const adminGetPlans = async (req, res) => {
  try {
    let plans = await subscriptionService.getAllPlansAdmin();
    if (!plans || plans.length === 0) plans = Object.values(DEFAULT_PLANS);
    return response.success(res, 'Plans fetched', { plans });
  } catch (err) {
    return response.success(res, 'Plans fetched', { plans: Object.values(DEFAULT_PLANS) });
  }
};

const adminCreatePlan = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return response.error(res, 'Validation failed', 400, errors.array());

    const { id, name, badge, price, walletLimit, paymentLinksPerMonth,
      linkExpiryDays, commissionPercent, withdrawalCount, withdrawalPeriod,
      features, isHighlighted, displayOrder } = req.body;

    const existing = await ref(`${DB_PATHS.PLANS}/${id}`).once('value');
    if (existing.exists()) return response.error(res, `Plan ID "${id}" already exists.`);

    const plan = {
      id, name, badge: badge || '',
      price: parseFloat(price),
      walletLimit: parseFloat(walletLimit),
      paymentLinksPerMonth: parseInt(paymentLinksPerMonth),
      linkExpiryDays: parseInt(linkExpiryDays),
      commissionPercent: parseFloat(commissionPercent),
      withdrawalCount: parseInt(withdrawalCount),
      withdrawalPeriod: withdrawalPeriod || 'week',
      features: Array.isArray(features) ? features : [],
      isHighlighted: !!isHighlighted,
      isDefault: false, isActive: true,
      displayOrder: parseInt(displayOrder) || 99,
      createdAt: Date.now(),
    };

    await ref(`${DB_PATHS.PLANS}/${id}`).set(plan);
    return response.success(res, 'Plan created', { plan }, 201);
  } catch (err) {
    return response.serverError(res, err.message);
  }
};

const adminUpdatePlan = async (req, res) => {
  try {
    const { id } = req.params;
    const snap = await ref(`${DB_PATHS.PLANS}/${id}`).once('value');
    if (!snap.exists()) return response.notFound(res, 'Plan not found');

    const allowed = ['name','badge','price','walletLimit','paymentLinksPerMonth',
      'linkExpiryDays','commissionPercent','withdrawalCount','withdrawalPeriod',
      'features','isHighlighted','isActive','displayOrder'];

    const update = { updatedAt: Date.now() };
    allowed.forEach(k => { if (req.body[k] !== undefined) update[k] = req.body[k]; });

    await ref(`${DB_PATHS.PLANS}/${id}`).update(update);
    return response.success(res, 'Plan updated');
  } catch (err) {
    return response.serverError(res, err.message);
  }
};

const adminDeletePlan = async (req, res) => {
  try {
    const { id } = req.params;
    const snap = await ref(`${DB_PATHS.PLANS}/${id}`).once('value');
    if (!snap.exists()) return response.notFound(res, 'Plan not found');
    if (snap.val().isDefault) return response.error(res, 'Cannot delete the default free plan.');
    await ref(`${DB_PATHS.PLANS}/${id}`).remove();
    return response.success(res, 'Plan deleted');
  } catch (err) {
    return response.serverError(res, err.message);
  }
};

const adminAssignPlan = async (req, res) => {
  try {
    const { uid } = req.params;
    const { planId, durationDays } = req.body;

    const user = await firebaseService.getUser(uid);
    if (!user) return response.notFound(res, 'User not found');

    const plan = await subscriptionService.getPlan(planId) || DEFAULT_PLANS[planId];
    if (!plan) return response.notFound(res, 'Plan not found');

    const sub = await subscriptionService.activateSubscription(uid, planId, durationDays || 30);

    await notificationService.createNotification(uid, {
      title: '🎉 Plan Activated!',
      message: `Your ${plan.name} plan has been activated! Enjoy your upgraded features.`,
      type: 'subscription',
    });

    return response.success(res, `${plan.name} plan assigned`, { subscription: sub });
  } catch (err) {
    return response.serverError(res, err.message);
  }
};

const adminGetPaymentLinks = async (req, res) => {
  try {
    const snap = await ref(DB_PATHS.PAYMENT_LINKS).orderByChild('createdAt').limitToLast(200).once('value');
    const links = [];
    if (snap.exists()) snap.forEach(c => links.push(c.val()));
    return response.success(res, 'Payment links fetched', { links: links.reverse(), total: links.length });
  } catch (err) {
    return response.success(res, 'Payment links fetched', { links: [], total: 0 });
  }
};

const adminGetCommissionLogs = async (req, res) => {
  try {
    // Commission is now earned at withdrawal time (not at payment-receipt
    // time), so withdrawals — not the old commissionLogs table — are the
    // source of truth for commission reporting.
    const withdrawals = await firebaseService.getAllWithdrawals();
    const logs = withdrawals
      .filter((w) => w.commission > 0)
      .map((w) => ({
        userId: w.userId,
        withdrawalId: w.id,
        commission: w.commission,
        netAmount: w.netAmount,
        grossAmount: w.amount,
        status: w.status, // commission is only realized once status === 'approved'
        createdAt: w.createdAt,
      }))
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

    const totalCommission = logs
      .filter((l) => l.status === 'approved')
      .reduce((s, l) => s + (l.commission || 0), 0);

    return response.success(res, 'Commission logs fetched', { logs, totalCommission });
  } catch (err) {
    return response.success(res, 'Commission logs fetched', { logs: [], totalCommission: 0 });
  }
};

const planValidation = [
  body('id').notEmpty().matches(/^[a-z0-9_]+$/),
  body('name').notEmpty().isLength({ max: 50 }),
  body('price').isFloat({ min: 0 }),
  body('walletLimit').isFloat({ min: 0 }),
  body('paymentLinksPerMonth').isInt({ min: -1 }),
  body('linkExpiryDays').isInt({ min: -1 }),
  body('commissionPercent').isFloat({ min: 0, max: 100 }),
  body('withdrawalCount').isInt({ min: 1 }),
];

module.exports = {
  getPlans, getMySubscription, purchasePlan, purchasePlanWithWallet, setAutoUpgrade,
  getDurationOptions,
  adminGetPlans, adminCreatePlan, adminUpdatePlan, adminDeletePlan,
  adminAssignPlan, adminGetPaymentLinks, adminGetCommissionLogs,
  planValidation,
};
