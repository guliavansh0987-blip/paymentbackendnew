// webhooks/zapWebhook.js
const firebaseService     = require('../services/firebaseService');
const walletService       = require('../services/walletService');
const notificationService = require('../services/notificationService');
const subscriptionService = require('../services/subscriptionService');
const referralService     = require('../services/referralService');
const zapService          = require('../services/zapService');
const storeService        = require('../services/storeService');
const webhookService      = require('../services/webhookService');
const { ref }             = require('../firebase/admin');
const { DB_PATHS, DEFAULT_PLANS } = require('../config/constants');
const logger              = require('../utils/logger');

async function handleZapWebhook(req, res) {
  const { order_id, status, txn_id, amount, pay_amount, utr, environment } = req.body;
  if (!order_id) {
    logger.warn('Webhook: missing order_id');
    return res.status(200).json({ status: 'ok' });
  }
  logger.info(`Webhook: ${order_id} status=${status}`);

  await processWebhookAsync({ order_id, status, txn_id, amount, pay_amount, utr, environment });

  return res.status(200).json({ status: 'ok' });
}

async function processWebhookAsync(data) {
  const { order_id, status, txn_id, amount, pay_amount, utr, environment } = data;
  try {
    const payment = await firebaseService.getPayment(order_id);
    if (!payment) { logger.error(`Payment not found: ${order_id}`); return; }

    // ─── Normalize status ──────────────────────────────────────────
    const normalize = (s) => {
      const v = String(s || '').trim().toLowerCase();
      if (v === 'success') return 'Success';
      if (v === 'failed'
        || v.startsWith('cancel')
        || v.startsWith('reject')
        || v.startsWith('decline')
        || v.startsWith('expire')
      ) return 'Failed';
      if (v === 'pending') return 'Pending';
      return null;
    };

    let verifiedStatus = normalize(status);
    if (verifiedStatus !== 'Success' && verifiedStatus !== 'Failed') {
      try {
        const api = await zapService.getOrderStatus(order_id);
        const apiStatus = normalize(api.status);
        if (apiStatus === 'Success' || apiStatus === 'Failed') {
          verifiedStatus = apiStatus;
        }
      } catch (e) { logger.warn(`API verify failed: ${e.message}`); }
    } else {
      try {
        const api = await zapService.getOrderStatus(order_id);
        const apiStatus = normalize(api.status);
        if (apiStatus && apiStatus !== verifiedStatus) {
          logger.warn(`Webhook/API mismatch ${order_id}: webhook=${verifiedStatus}, API=${apiStatus} — trusting webhook`);
        }
      } catch (e) { /* non-critical */ }
    }

    // ─── Duplicate prevention ──────────────────────────────────────
    // Status-aware: only skips a REPEAT delivery of the same final status
    // for this order (e.g. Zap retrying its own webhook). A genuine status
    // transition for the same order — most importantly Failed → Success,
    // when a payment that first reported as failed is later confirmed —
    // is NOT a duplicate and must still update the DB and notify the user.
    if (await firebaseService.isOrderProcessed(order_id, verifiedStatus)) {
      logger.warn(`Duplicate ignored: ${order_id} (status=${verifiedStatus})`); return;
    }
    await firebaseService.markOrderProcessed(order_id, verifiedStatus);

    await firebaseService.updatePaymentStatus(order_id, { status: verifiedStatus, txn_id, utr, amount, pay_amount, environment });

    if (verifiedStatus !== 'Success' && verifiedStatus !== 'Failed') {
      await firebaseService.unmarkOrderProcessed(order_id);
      logger.warn(`Webhook ${order_id}: inconclusive status (raw="${status}"), released claim for retry`);
      return;
    }

    if (verifiedStatus !== 'Success') {
      // ─── Failure notification ────────────────────────────────────
      let title = '❌ Payment Failed';
      let message = `Your payment of ₹${amount} failed. Order: ${order_id}`;
      if (payment.type === 'subscription' && payment.planId) {
        title = '❌ Subscription Payment Failed';
        message = `Your plan upgrade payment of ₹${amount} failed. Order: ${order_id}`;
      } else if (payment.storeId) {
        title = '⚠️ Purchase Attempt Failed';
        message = `A customer's ₹${amount} purchase from your store did not go through. Order: ${order_id}`;
      } else if (payment.linkId) {
        title = '⚠️ Payment Attempt Failed';
        message = `A customer's payment of ₹${amount} via your payment link did not go through. Order: ${order_id}`;
      }
      await notificationService.createNotification(payment.userId, { title, message, type: 'payment' });

      webhookService.notifyUserWebhooks(payment.userId, 'order.failed', {
        order_id, status: 'failed', amount: parseFloat(amount || 0),
      }).catch((e) => logger.warn(`notifyUserWebhooks(failed) error: ${e.message}`));

      return;
    }

    const grossAmount = parseFloat(pay_amount || amount || 0);
    if (grossAmount <= 0) return;

    // ─── ──────────────────────────────────────────────────────────────
    // ─── CRITICAL FIX: FamPay/Cashier Payments — NO Wallet Credit ──
    // If payment method is 'fampay' or routingEngine is 'cashier',
    // the merchant already received money in their FamPay account.
    // DO NOT credit ZetPay wallet again. Just mark success + notify.
    // ─── ──────────────────────────────────────────────────────────────
    if (payment.paymentMethod === 'fampay' || payment.routingEngine === 'cashier') {
      logger.info(`FamPay/Cashier payment ${order_id} — skipping wallet credit (merchant already received money in FamPay)`);

      await notificationService.createNotification(payment.userId, {
        title: '✅ Payment Received via FamPay',
        message: `₹${grossAmount} has been received in your FamPay account. Order: ${order_id}`,
        type: 'payment',
      });

      await firebaseService.logActivity(payment.userId, 'FAMPAY_PAYMENT_RECEIVED', {
        orderId: order_id,
        amount: grossAmount,
        utr: utr || null,
      });

      await webhookService.notifyUserWebhooks(payment.userId, 'order.success', {
        order_id, status: 'success', amount: grossAmount, utr: utr || null,
      }).catch((e) => logger.warn(`Webhook notify error: ${e.message}`));

      return;
    }

    // ─── Outgoing webhook for success (non-FamPay) ──────────────────
    webhookService.notifyUserWebhooks(payment.userId, 'order.success', {
      order_id, status: 'success', amount: grossAmount, utr: utr || null,
    }).catch((e) => logger.warn(`notifyUserWebhooks(success) error: ${e.message}`));

    // ─── SUBSCRIPTION PAYMENT ──────────────────────────────────────
    if (payment.type === 'subscription' && payment.planId) {
      await handleSubscriptionPayment(payment, grossAmount, order_id);
      return;
    }

    // ─── STORE UNLOCK ──────────────────────────────────────────────
    if (payment.type === 'store_unlock') {
      await handleStoreUnlockPayment(payment, grossAmount, order_id);
      return;
    }

    // ─── STORE PORTAL PURCHASE ─────────────────────────────────────
    if (payment.storeId) {
      await handleStorePurchase(payment, grossAmount, order_id, utr);
      return;
    }

    // ─── ZAP CREDIT TOP-UP (direct, via UPI) ────────────────────────
    if (payment.type === 'zap_credit_topup') {
      await handleZapCreditTopup(payment, grossAmount, order_id);
      return;
    }

    // ─── WALLET TOP-UP (direct) ────────────────────────────────────
    if (!payment.linkId) {
      await handleWalletTopup(payment, grossAmount, order_id);
      if (payment.type === 'wallet_topup') {
        await referralService.processQualifyingDeposit(payment.userId, grossAmount);
      }
      return;
    }

    // ─── PAYMENT LINK PAYMENT ─────────────────────────────────────
    await handleLinkPayment(payment, grossAmount, order_id, utr);

  } catch (err) {
    logger.error(`Webhook error ${order_id}:`, err.message);
  }
}

// ─── SUBSCRIPTION PAYMENT ────────────────────────────────────────
async function handleSubscriptionPayment(payment, amount, orderId) {
  try {
    const plan = await subscriptionService.getPlan(payment.planId) || DEFAULT_PLANS[payment.planId];
    if (!plan) { logger.error(`Plan not found: ${payment.planId}`); return; }

    const durationDays = payment.durationDays || 30;
    const durationLabel = payment.durationMonths && payment.durationMonths !== 1
      ? `${payment.durationMonths} months`
      : `${durationDays} days`;

    await subscriptionService.activateSubscription(payment.userId, payment.planId, durationDays);

    await notificationService.createNotification(payment.userId, {
      title: `🎉 ${plan.name} Plan Activated!`,
      message: `Your ${plan.name} subscription is now active for ${durationLabel}. Payment ₹${amount} confirmed.`,
      type: 'subscription',
    });

    await firebaseService.logActivity(payment.userId, 'SUBSCRIPTION_ACTIVATED', {
      planId: payment.planId, planName: plan.name, amount, orderId, durationDays,
    });

    logger.info(`Subscription activated: ${payment.userId} → ${payment.planId} (${durationDays}d)`);
  } catch (err) {
    logger.error(`Subscription activation failed: ${err.message}`);
  }
}

// ─── WALLET TOP-UP ──────────────────────────────────────────────
async function handleWalletTopup(payment, amount, orderId) {
  // NOTE: the "already processed?" re-fetch-and-skip guard that used to be
  // here was removed — see the comment in handleLinkPayment above for why:
  // updatePaymentStatus() has already written status:'success' to the DB
  // by the time this function runs, so re-checking it here always looked
  // like a duplicate and skipped crediting the wallet on every real
  // top-up. Duplicate-delivery protection is handled earlier and
  // correctly via isOrderProcessed/markOrderProcessed.

  const sub  = await subscriptionService.getUserSubscription(payment.userId);
  const plan = sub.plan;
  const balance  = await walletService.getBalance(payment.userId);
  const available = plan.walletLimit - balance;

  if (available <= 0) {
    await notificationService.createNotification(payment.userId, {
      title: '⚠️ Wallet Full',
      message: `Payment of ₹${amount} received but wallet is full (limit ₹${plan.walletLimit}). Please withdraw first.`,
      type: 'payment',
    });
    return;
  }

  const credit = Math.min(amount, available);
  await walletService.creditWallet(payment.userId, credit, `Top-up ${orderId}`);
  try { await subscriptionService.maybeAutoUpgrade(payment.userId); } catch (e) { logger.error('Auto-upgrade check failed: ' + e.message); }

  await notificationService.createNotification(payment.userId, {
    title: '💰 Wallet Credited',
    message: `₹${credit} added to your wallet. Order: ${orderId}`,
    type: 'payment',
  });

  await firebaseService.logActivity(payment.userId, 'WALLET_TOPUP', { orderId, amount: credit });
  logger.info(`Wallet top-up: ${payment.userId} +₹${credit}`);
}

// ─── ZAP CREDIT TOP-UP (via UPI) ──────────────────────────────────
// Unlike Zap Cash, Zap Credit has no plan-based wallet limit — it's not
// withdrawable real money, just "fuel" spent on commission. So the full
// paid amount always credits, no partial/available-space capping needed.
async function handleZapCreditTopup(payment, amount, orderId) {
  // See handleLinkPayment's comment above — same stale-guard bug, removed
  // for the same reason (the DB already shows 'success' by this point in
  // every real invocation, so this always false-flagged as a duplicate).

  const newBalance = await walletService.creditZapCredit(payment.userId, amount, `UPI Top-up ${orderId}`);

  await notificationService.createNotification(payment.userId, {
    title: '⚡ Zap Credit Added',
    message: `${amount} Zap Credit added to your account. Order: ${orderId}`,
    type: 'payment',
  });

  await firebaseService.logActivity(payment.userId, 'ZAP_CREDIT_TOPUP', { orderId, amount });
  logger.info(`Zap Credit top-up: ${payment.userId} +${amount} (balance: ${newBalance})`);
}

// ─── PAYMENT LINK PAYMENT ────────────────────────────────────────
async function handleLinkPayment(payment, grossAmount, orderId, utr) {
  // NOTE: there used to be a second "already processed?" guard here that
  // re-fetched the payment and skipped crediting if its status was
  // already 'success'. That's actively wrong: updatePaymentStatus() (in
  // processWebhookAsync, above) already writes status:'success' to the DB
  // BEFORE handleLinkPayment ever runs — so this guard was reading back
  // the write this same webhook invocation just made, one line earlier,
  // and always skipping wallet credit as a false "duplicate". Real
  // duplicate-delivery protection already happens earlier via
  // isOrderProcessed/markOrderProcessed (status-aware, checked before any
  // DB write occurs), so it doesn't need to be repeated — incorrectly —
  // here.

  const sub  = await subscriptionService.getUserSubscription(payment.userId);
  const plan = sub.plan;
  const balance   = await walletService.getBalance(payment.userId);
  const available = plan.walletLimit - balance;

  if (available <= 0) {
    await notificationService.createNotification(payment.userId, {
      title: '⚠️ Wallet Full',
      message: `Payment ₹${grossAmount} received but wallet full. Withdraw funds.`,
      type: 'payment',
    });
    return;
  }

  const credit = Math.min(grossAmount, available);
  await walletService.creditWallet(payment.userId, credit, `Link ${payment.linkId}`);
  try { await subscriptionService.maybeAutoUpgrade(payment.userId); } catch (e) { logger.error('Auto-upgrade check failed: ' + e.message); }

  // ─── Zap Credit deduction ──────────────────────────────────────
  const commissionPct = payment.commissionPercent ?? plan.commissionPercent ?? 5;
  const creditCost = Math.round((grossAmount * commissionPct) / 100 * 100) / 100;
  if (creditCost > 0) {
    try {
      await walletService.debitZapCredit(payment.userId, creditCost, `Commission for Order ${orderId}`);
    } catch (e) {
      logger.error(`Zap Credit debit failed for already-verified order ${orderId}: ${e.message}`);
    }
  }

  const linkRef = ref(`${DB_PATHS.PAYMENT_LINKS}/${payment.linkId}`);
  const linkSnap = await linkRef.once('value');
  const linkData = linkSnap.val();
  if (linkData) {
    await linkRef.update({
      paymentCount: (linkData.paymentCount || 0) + 1,
      totalCollected: (linkData.totalCollected || 0) + grossAmount,
      lastPaidAt: Date.now(),
    });
  }

  await notificationService.createNotification(payment.userId, {
    title: '💰 Payment Received via Link',
    message: `₹${credit} credited to your wallet. Order: ${orderId}`,
    type: 'payment',
  });

  await firebaseService.logActivity(payment.userId, 'PAYMENT_SUCCESS', {
    orderId, grossAmount, netAmount: credit, linkId: payment.linkId, utr,
  });

  logger.info(`Link payment: ${payment.userId} +₹${credit}`);
}

// ─── STORE UNLOCK ────────────────────────────────────────────────
async function handleStoreUnlockPayment(payment, amount, orderId) {
  try {
    await storeService.setUnlocked(payment.userId, true);

    await notificationService.createNotification(payment.userId, {
      title: '🎉 Store Unlocked!',
      message: `Your ZetPay Store is now unlocked (₹${amount} confirmed) — customize it and start selling!`,
      type: 'general',
    });

    await firebaseService.logActivity(payment.userId, 'STORE_UNLOCKED_UPI', { amount, orderId });
    logger.info(`Store unlocked via UPI: ${payment.userId}`);
  } catch (err) {
    logger.error(`Store unlock activation failed: ${err.message}`);
  }
}

// ─── STORE PURCHASE ──────────────────────────────────────────────
async function handleStorePurchase(payment, grossAmount, orderId, utr) {
  // Same stale-guard bug as handleLinkPayment/handleWalletTopup/
  // handleZapCreditTopup above — removed for the same reason.

  const sub  = await subscriptionService.getUserSubscription(payment.userId);
  const plan = sub.plan;
  const balance   = await walletService.getBalance(payment.userId);
  const available = plan.walletLimit - balance;

  if (available <= 0) {
    await notificationService.createNotification(payment.userId, {
      title: '⚠️ Wallet Full',
      message: `Payment ₹${grossAmount} received but wallet full. Withdraw funds.`,
      type: 'payment',
    });
    return;
  }

  const credit = Math.min(grossAmount, available);
  await walletService.creditWallet(payment.userId, credit, `Store ${payment.storeId} product ${payment.productId}`);
  try { await subscriptionService.maybeAutoUpgrade(payment.userId); } catch (e) { logger.error('Auto-upgrade check failed: ' + e.message); }

  // ─── Zap Credit deduction ──────────────────────────────────────
  const commissionPct = payment.commissionPercent ?? plan.commissionPercent ?? 5;
  const creditCost = Math.round((grossAmount * commissionPct) / 100 * 100) / 100;
  if (creditCost > 0) {
    try {
      await walletService.debitZapCredit(payment.userId, creditCost, `Commission for Order ${orderId}`);
    } catch (e) {
      logger.error(`Zap Credit debit failed for already-verified order ${orderId}: ${e.message}`);
    }
  }

  let productTitle = 'Product';
  if (payment.productId) {
    const productRef = ref(`${DB_PATHS.STORES}/${payment.userId}/products/${payment.productId}`);
    const productSnap = await productRef.once('value');
    const productData = productSnap.val();
    if (productData) {
      productTitle = productData.title || productTitle;
      await productRef.update({
        salesCount: (productData.salesCount || 0) + 1,
        totalCollected: (productData.totalCollected || 0) + grossAmount,
        lastSoldAt: Date.now(),
      });
    }
  }

  await notificationService.createNotification(payment.userId, {
    title: '🛍️ Product Sold!',
    message: `"${productTitle}" sold for ₹${credit}, credited to your wallet. Order: ${orderId}`,
    type: 'payment',
  });

  await firebaseService.logActivity(payment.userId, 'STORE_SALE', {
    orderId, grossAmount, netAmount: credit, storeId: payment.storeId, productId: payment.productId, utr,
  });

  logger.info(`Store sale: ${payment.userId} +₹${credit} (product ${payment.productId})`);
}

module.exports = { handleZapWebhook };
