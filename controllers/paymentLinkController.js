// controllers/paymentLinkController.js
const { body, validationResult } = require('express-validator');
const { ref } = require('../firebase/admin');
const zapService = require('../services/zapService');
const firebaseService = require('../services/firebaseService');
const walletService = require('../services/walletService');
const notificationService = require('../services/notificationService');
const subscriptionService = require('../services/subscriptionService');
const gatewayModeService = require('../services/gatewayModeService');
const response = require('../helpers/response');
const logger = require('../utils/logger');
const { DB_PATHS } = require('../config/constants');
const crypto = require('crypto');

function generateLinkId() {
  return crypto.randomBytes(4).toString('hex');
}

const createPaymentLink = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return response.error(res, 'Validation failed', 400, errors.array());

    // NOTE: routingEngine is intentionally NOT accepted here. Routing is an
    // account-wide setting (user.apiRoutingEngine, controlled only from the
    // Developer Portal / ZapAPI section) — it must never be chosen per-link,
    // and every link always follows whatever the account is set to at the
    // moment it's actually paid (see initiatePayment below).
    const { amount, title, description, redirectUrl, usageLimit } = req.body;
    const userId = req.user.uid;

    const sub = await subscriptionService.getUserSubscription(userId);
    const plan = sub.plan;
    if (!plan) return response.error(res, 'Could not load your plan. Try again.');

    // Hide Wallet System: once enabled, a merchant must have their OWN
    // cashier (FamPay or Paytm) connected and selected before they can
    // create any new payment link at all — this is the actual prevention
    // point; creditWallet's own guard (walletService.js) is only a
    // backstop in case something slips past this. A merchant with no
    // cashier connected has nowhere legitimate for the link to route
    // money to once wallet top-ups are blocked, so refusing at creation
    // time (rather than letting them discover it later at checkout) is
    // the whole point of the popup this error is meant to trigger.
    const settings = await firebaseService.getSettings();
    if (settings.hideWalletSystemEnabled) {
      const merchantUser = await firebaseService.getUser(userId);
      const hasCashier =
        (merchantUser?.apiRoutingEngine === 'cashier' && merchantUser?.fampay?.isConnected) ||
        (merchantUser?.apiRoutingEngine === 'paytm_cashier' && merchantUser?.paytm?.isConnected);
      if (!hasCashier) {
        return response.error(res, 'Connect your own FamPay or Paytm cashier before creating payment links. Go to Zap API → Payment Routing to connect one.', 403, { requiresCashierConnect: true });
      }
    }

    await subscriptionService.checkAndResetMonthlyLinks(userId);
    const linksUsed = sub.paymentLinksUsedThisMonth || 0;
    if (plan.paymentLinksPerMonth !== -1 && linksUsed >= plan.paymentLinksPerMonth) {
      return response.error(res, `You've used all ${plan.paymentLinksPerMonth} payment links this month. Upgrade your plan for more.`);
    }

    const balance = await walletService.getBalance(userId);
    if (balance >= plan.walletLimit) {
      return response.error(res, `Your wallet has reached its limit of ₹${plan.walletLimit}. Withdraw funds to create new links.`);
    }

    let linkId = generateLinkId();
    let exists = await ref(`${DB_PATHS.PAYMENT_LINKS}/${linkId}`).once('value');
    while (exists.exists()) {
      linkId = generateLinkId();
      exists = await ref(`${DB_PATHS.PAYMENT_LINKS}/${linkId}`).once('value');
    }

    let expiresAt;
    if (req.body.expiryDays !== undefined && req.body.expiryDays !== null && req.body.expiryDays !== '') {
      const days = parseInt(req.body.expiryDays, 10);
      expiresAt = (days > 0) ? Date.now() + days * 24 * 60 * 60 * 1000 : null;
    } else {
      expiresAt = plan.linkExpiryDays > 0 ? Date.now() + plan.linkExpiryDays * 24 * 60 * 60 * 1000 : null;
    }

    const user = await firebaseService.getUser(userId);

    const linkData = {
      id: linkId,
      userId,
      merchantName: user?.displayName || 'Merchant',
      title: title.trim(),
      description: description?.trim() || '',
      redirectUrl: redirectUrl?.trim() || '',
      amount: parseFloat(amount),
      status: 'active',
      expiresAt,
      planId: plan.id,
      planName: plan.name,
      commissionPercent: plan.commissionPercent,
      usageLimit: usageLimit ? parseInt(usageLimit, 10) : null, // NEW: Save Usage Limit
      createdAt: Date.now(),
      paidAt: null,
      paymentCount: 0,
      totalCollected: 0,
    };

    await ref(`${DB_PATHS.PAYMENT_LINKS}/${linkId}`).set(linkData);
    await subscriptionService.incrementLinkCount(userId);

    await firebaseService.logActivity(userId, 'PAYMENT_LINK_CREATED', {
      linkId, title: linkData.title, amount: linkData.amount, expiresAt,
    });

    // FRONTEND_URL may hold a comma-separated list of live domains (see
    // server.js's CORS allowlist / zapService.js's PRIMARY_FRONTEND_URL for
    // the same pattern) — always take just the first entry for a public URL.
    const frontendUrl = (process.env.FRONTEND_URL || '').split(',')[0].trim().replace(/\/+$/, '');
    const publicUrl = `${frontendUrl}/pay.html?id=${linkId}`;
    logger.info(`Payment link created: ${linkId} by ${userId}`);

    return response.success(res, 'Payment link created!', {
      linkId, publicUrl, amount: linkData.amount, title: linkData.title, redirectUrl: linkData.redirectUrl,
      expiresAt, usageLimit: linkData.usageLimit,
      linksRemaining: plan.paymentLinksPerMonth === -1 ? 'Unlimited' : plan.paymentLinksPerMonth - linksUsed - 1,
    });
  } catch (err) {
    logger.error('Create payment link error:', err.message);
    return response.serverError(res, err.message);
  }
};

const getUserLinks = async (req, res) => {
  try {
    const snap = await ref(DB_PATHS.PAYMENT_LINKS).orderByChild('userId').equalTo(req.user.uid).once('value');
    const links = [];
    if (snap.exists()) {
      snap.forEach((child) => {
        const link = child.val();
        if (link.expiresAt && Date.now() > link.expiresAt && link.status === 'active') {
          link.status = 'expired';
        }
        // Limit Check Logic
        if (link.usageLimit && link.paymentCount >= link.usageLimit && link.status === 'active') {
          link.status = 'expired'; // Treat as expired visually
        }
        links.push(link);
      });
    }
    links.sort((a, b) => b.createdAt - a.createdAt);
    return response.success(res, 'Links fetched', { links, total: links.length });
  } catch (err) {
    logger.error('Get user links error:', err.message);
    return response.serverError(res, err.message);
  }
};

const getLinkPublic = async (req, res) => {
  try {
    const { linkId } = req.params;
    const snap = await ref(`${DB_PATHS.PAYMENT_LINKS}/${linkId}`).once('value');
    if (!snap.exists()) return response.notFound(res, 'Payment link not found');

    const link = snap.val();

    if (link.status === 'disabled') return response.error(res, 'This payment link has been disabled by the merchant.');
    if (link.expiresAt && Date.now() > link.expiresAt) return response.error(res, 'This payment link has expired.');
    
    // NEW: Usage Limit Check
    if (link.usageLimit && link.paymentCount >= link.usageLimit) {
      return response.error(res, 'This payment link has reached its maximum usage limit.');
    }

    const merchant = await firebaseService.getUser(link.userId);
    if (!merchant || merchant.isBanned) return response.error(res, 'This payment link is no longer available.');

    return response.success(res, 'Link details fetched', {
      linkId: link.id, merchantName: link.merchantName, title: link.title, description: link.description,
      amount: link.amount, expiresAt: link.expiresAt, status: link.status, redirectUrl: link.redirectUrl || '',
      checkoutTheme: merchant.checkoutTheme || 'default', checkoutThemeColor: merchant.checkoutThemeColor || '',
      fampayConnected: !!merchant.fampay?.isConnected, fampayUpiId: merchant.fampay?.isConnected ? merchant.fampay.upiId : null,
      routingEngine: link.routingEngine || 'wallet',
    });
  } catch (err) {
    logger.error('Get link public error:', err.message);
    return response.serverError(res, err.message);
  }
};

const initiatePayment = async (req, res) => {
  try {
    const { linkId } = req.params;
    const { customerMobile, customerName, useEmbedded } = req.body;

    const snap = await ref(`${DB_PATHS.PAYMENT_LINKS}/${linkId}`).once('value');
    if (!snap.exists()) return response.notFound(res, 'Payment link not found');

    const link = snap.val();

    if (link.status === 'disabled') return response.error(res, 'This payment link is disabled.');
    if (link.expiresAt && Date.now() > link.expiresAt) return response.error(res, 'This payment link has expired.');
    
    // NEW: Usage Limit Check
    if (link.usageLimit && link.paymentCount >= link.usageLimit) {
      return response.error(res, 'This payment link has reached its maximum usage limit.');
    }

    const orderId = zapService.generateOrderId(link.userId);
    const gatewayMode = await gatewayModeService.getMode(link.userId);

    if (gatewayMode === 'test') {
      await firebaseService.createPayment(orderId, {
        userId: link.userId, amount: link.amount, remark: `${link.title} | LinkID:${linkId}`, customerMobile: customerMobile || '', linkId, isTest: true,
      });
      await ref(`${DB_PATHS.PAYMENT_LINKS}/${linkId}`).update({ lastOrderId: orderId, lastCustomerName: customerName || '', lastCustomerMobile: customerMobile || '' });
      return response.success(res, 'Payment initiated (Test Mode)', { paymentUrl: gatewayModeService.buildTestPaymentUrl(orderId), orderId, amount: link.amount, isTest: true });
    }

    const merchantSub = await subscriptionService.getUserSubscription(link.userId);
    const balance = await walletService.getBalance(link.userId);
    if (balance + link.amount > merchantSub.plan.walletLimit) {
      return response.error(res, 'Merchant wallet is full. Please contact the merchant.');
    }

    // ─── Zap Credit gate ─────────────────────────────────────────
    // Every completed order costs the merchant commissionPercent% of the
    // order amount in Zap Credit. If they don't have enough to cover it,
    // don't let the customer land on a checkout page at all — fail here,
    // before any order record or payment URL is created.
    const commissionPercent = merchantSub.plan.commissionPercent ?? 5;
    const creditCheck = await walletService.checkSufficientCreditForOrder(link.userId, link.amount, commissionPercent);
    if (!creditCheck.ok) {
      logger.warn(`Insufficient Zap Credit for link ${linkId}: user=${link.userId} required=${creditCheck.required} available=${creditCheck.available}`);
      return response.error(res, 'Insufficient Zap Credit. This merchant needs to recharge Zap Credit before they can accept this payment.');
    }

    const settings = await firebaseService.getSettings();
    if (settings.maintenanceMode) return response.error(res, 'Payment system under maintenance.', 503);

    const merchantUser = await firebaseService.getUser(link.userId);
    const isFamPay = merchantUser?.fampay?.isConnected;
    const isPaytm = merchantUser?.paytm?.isConnected;

    // Hide Wallet System backstop: covers a link created before the toggle
    // was turned on, or before the merchant's cashier got disconnected
    // afterward. createPaymentLink already refuses to make NEW links
    // without a connected cashier once this is on, but an existing link
    // could still be sitting out there — this is what actually stops a
    // customer from reaching checkout on one of those.
    const hasCashierNow =
      (merchantUser?.apiRoutingEngine === 'cashier' && isFamPay) ||
      (merchantUser?.apiRoutingEngine === 'paytm_cashier' && isPaytm);
    if (settings.hideWalletSystemEnabled && !hasCashierNow) {
      return response.error(res, 'This merchant has not connected their own cashier to receive money. Payments cannot be accepted on this link right now.', 403);
    }

    // Routing is decided live, from the merchant's account-wide setting
    // (Developer Portal → Payment Routing), never from anything stored on
    // the link itself — a link created weeks ago must immediately reflect
    // a routing change made today. 'cashier' is only honored if FamPay is
    // ACTUALLY connected right now; if the merchant switched the setting
    // to cashier earlier but has since disconnected FamPay (or never
    // connected it), this safely falls through to the normal wallet flow
    // below instead of building a checkout with no UPI ID to pay to.
    const useCashier = merchantUser?.apiRoutingEngine === 'cashier' && isFamPay;

    if (useCashier) {
      await firebaseService.createPayment(orderId, {
        userId: link.userId, amount: link.amount, remark: `${link.title} | LinkID:${linkId}`, customerMobile: customerMobile || '', linkId,
        paymentMethod: 'fampay', cashierUpiId: merchantUser.fampay.upiId, routingEngine: 'cashier', commissionPercent
      });
      await ref(`${DB_PATHS.PAYMENT_LINKS}/${linkId}`).update({ lastOrderId: orderId, lastCustomerName: customerName || '', lastCustomerMobile: customerMobile || '' });
      // Was: redirect_url only got appended when link.redirectUrl was set,
      // with no fallback — unlike the system_cashier branch below, which
      // always builds a safeRedirect. Since checkout.html is a full-page
      // navigation (not an iframe — window.location.href, not
      // ZapUPI.loadPayment), its own inIframe check is always false, so it
      // never posts back to a parent. Its ONLY way home is the redirect_url
      // param; missing that, it fell to document.referrer (unreliable across
      // WebViews/app browsers) or '/' — landing on the site root instead of
      // link.html, which is why the customer never saw their payment record.
      // Mirrors system_cashier's own default exactly, so both routes behave
      // the same when the merchant hasn't set a custom redirectUrl.
      const safeRedirect = link.redirectUrl || `${process.env.FRONTEND_URL}/pay.html?id=${linkId}&order=${orderId}&result=success`;
      let checkoutUrl = `https://zetpay.online/checkout.html?order_id=${orderId}&amount=${link.amount}&upi=${encodeURIComponent(merchantUser.fampay.upiId)}&redirect_url=${encodeURIComponent(safeRedirect)}`;
      checkoutUrl += `&theme=${encodeURIComponent(merchantUser?.checkoutTheme || 'default')}`;
      if (merchantUser?.checkoutThemeColor) checkoutUrl += `&color=${encodeURIComponent(merchantUser.checkoutThemeColor)}`;
      return response.success(res, 'Payment initiated via Cashier', { paymentUrl: checkoutUrl, orderId, amount: link.amount, isTest: false, method: 'cashier' });
    }

    let isSystemCashier = false;
    let sysAdminUser = null;
    if (!isFamPay && settings.systemRoutingMode === 'self' && settings.systemRoutingAdminUid) {
      sysAdminUser = await firebaseService.getUser(settings.systemRoutingAdminUid);
      if (sysAdminUser && sysAdminUser.fampay && sysAdminUser.fampay.isConnected) isSystemCashier = true;
    }

    await firebaseService.createPayment(orderId, {
      userId: link.userId, amount: link.amount, remark: `${link.title} | LinkID:${linkId}`, customerMobile: customerMobile || '', linkId,
      paymentMethod: isSystemCashier ? 'fampay' : 'zapupi', 
      cashierUpiId: isSystemCashier ? sysAdminUser.fampay.upiId : null, 
      routingEngine: isSystemCashier ? 'system_cashier' : 'wallet', 
      commissionPercent,
      fampayVerifyUid: isSystemCashier ? sysAdminUser.uid : null
    });

    await ref(`${DB_PATHS.PAYMENT_LINKS}/${linkId}`).update({ lastOrderId: orderId, lastCustomerName: customerName || '', lastCustomerMobile: customerMobile || '' });

    if (isSystemCashier) {
      const safeRedirect = `${process.env.FRONTEND_URL}/pay.html?id=${linkId}&order=${orderId}&result=success`;
      let checkoutUrl = `https://zetpay.online/checkout.html?order_id=${orderId}&amount=${link.amount}&upi=${encodeURIComponent(sysAdminUser.fampay.upiId)}&redirect_url=${encodeURIComponent(safeRedirect)}`;
      checkoutUrl += `&theme=${encodeURIComponent(merchantUser?.checkoutTheme || 'default')}`;
      if (merchantUser?.checkoutThemeColor) checkoutUrl += `&color=${encodeURIComponent(merchantUser.checkoutThemeColor)}`;
      return response.success(res, 'Payment initiated via System Cashier', { paymentUrl: checkoutUrl, orderId, amount: link.amount, isTest: false, method: 'system_cashier' });
    } else {
      // NOTE: previously there was an `else if (isFamPay)` branch here that
      // forced ANY merchant with FamPay connected through the cashier
      // checkout flow — even when their apiRoutingEngine was explicitly set
      // to 'wallet'. That silently broke "switch back to wallet routing"
      // (payments kept going through FamPay/checkout.html, and correctly-
      // routed wallet payments never got their commission-adjusted amount
      // credited via the normal handleLinkPayment path) and has been
      // removed. FamPay-connected merchants who are actually routed to
      // 'cashier' were already returned via the useCashier branch above —
      // reaching this point means the account is genuinely on wallet/ZapUPI
      // routing, so it must always go through the real ZapUPI order flow.
      const zapOrder = await zapService.createOrder({
        orderId, amount: String(link.amount.toFixed(2)), customerMobile: customerMobile || '', remark: link.title, omitRedirectUrls: !!useEmbedded,
        ...(useEmbedded ? {} : {
          successUrl: `${process.env.FRONTEND_URL}/pay.html?id=${linkId}&order=${orderId}&result=success`,
          failedUrl:  `${process.env.FRONTEND_URL}/pay.html?id=${linkId}&order=${orderId}&result=failed`,
          timeoutUrl: `${process.env.FRONTEND_URL}/pay.html?id=${linkId}&order=${orderId}&result=timeout`,
        }),
      });
      return response.success(res, 'Payment initiated', { paymentUrl: zapOrder.paymentUrl, orderId, amount: link.amount, isTest: false, method: 'zapupi' });
    }
  } catch (err) {
    logger.error('Initiate link payment error:', err.message);
    return response.serverError(res, err.message);
  }
};

const getLinkOrderStatus = async (req, res) => {
  try {
    const { orderId } = req.params;
    const payment = await firebaseService.getPayment(orderId);
    // Serves any cashier-routed order checkout.html might poll: payment
    // links (linkId), store products (storeId), and direct ZapAPI orders
    // (type: 'api', no linkId/storeId of their own) — checkout.html polls
    // this same endpoint regardless of which of these created the order.
    if (!payment) return response.notFound(res, 'Order not found');

    if (payment.status === 'pending' && (payment.paymentMethod === 'fampay' || payment.routingEngine === 'cashier' || payment.routingEngine === 'system_cashier')) {
      const fampayService = require('../services/fampayService');
      await fampayService.verifyPayment(orderId);
      const updatedPayment = await firebaseService.getPayment(orderId);
      if (updatedPayment) payment.status = updatedPayment.status;
    }

    return response.success(res, 'Status fetched', { orderId, status: payment.status, linkId: payment.linkId || null });
  } catch (err) {
    logger.error('Get link order status error:', err.message);
    return response.serverError(res, err.message);
  }
};

const editPaymentLink = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return response.error(res, 'Validation failed', 400, errors.array());

    const { linkId } = req.params;
    const snap = await ref(`${DB_PATHS.PAYMENT_LINKS}/${linkId}`).once('value');
    if (!snap.exists()) return response.notFound(res, 'Link not found');

    const link = snap.val();
    if (link.userId !== req.user.uid) return response.forbidden(res);

    const { amount, title, description, redirectUrl, usageLimit } = req.body;
    const updates = {
      amount: parseFloat(amount),
      title: title.trim(),
      description: description?.trim() || '',
      redirectUrl: redirectUrl?.trim() || '',
    };

    if (usageLimit !== undefined) {
      updates.usageLimit = usageLimit ? parseInt(usageLimit, 10) : null;
    }

    if (req.body.expiryDays !== undefined && req.body.expiryDays !== null && req.body.expiryDays !== '') {
      const days = parseInt(req.body.expiryDays, 10);
      updates.expiresAt = (days > 0) ? Date.now() + days * 24 * 60 * 60 * 1000 : null;
    }

    await ref(`${DB_PATHS.PAYMENT_LINKS}/${linkId}`).update(updates);

    await firebaseService.logActivity(req.user.uid, 'PAYMENT_LINK_EDITED', {
      linkId,
      before: { amount: link.amount, title: link.title, description: link.description || '', redirectUrl: link.redirectUrl || '', expiresAt: link.expiresAt ?? null },
      after: { amount: updates.amount, title: updates.title, description: updates.description, redirectUrl: updates.redirectUrl, expiresAt: updates.expiresAt !== undefined ? updates.expiresAt : (link.expiresAt ?? null) },
    });

    return response.success(res, 'Payment link updated');
  } catch (err) {
    logger.error('Edit payment link error:', err.message);
    return response.serverError(res, err.message);
  }
};

const deletePaymentLink = async (req, res) => {
  try {
    const { linkId } = req.params;
    const snap = await ref(`${DB_PATHS.PAYMENT_LINKS}/${linkId}`).once('value');
    if (!snap.exists()) return response.notFound(res, 'Link not found');

    const link = snap.val();
    if (link.userId !== req.user.uid) return response.forbidden(res);

    await ref(`${DB_PATHS.PAYMENT_LINKS}/${linkId}`).remove();
    await subscriptionService.decrementLinkCount(link.userId);

    await firebaseService.logActivity(req.user.uid, 'PAYMENT_LINK_DELETED', { linkId, title: link.title, amount: link.amount });

    return response.success(res, 'Payment link deleted');
  } catch (err) {
    logger.error('Delete payment link error:', err.message);
    return response.serverError(res, err.message);
  }
};

const disableLink = async (req, res) => {
  try {
    const { linkId } = req.params;
    const snap = await ref(`${DB_PATHS.PAYMENT_LINKS}/${linkId}`).once('value');
    if (!snap.exists()) return response.notFound(res, 'Link not found');
    if (snap.val().userId !== req.user.uid) return response.forbidden(res);

    await ref(`${DB_PATHS.PAYMENT_LINKS}/${linkId}`).update({ status: 'disabled' });
    await firebaseService.logActivity(req.user.uid, 'PAYMENT_LINK_DISABLED', { linkId, title: snap.val().title });
    return response.success(res, 'Payment link disabled');
  } catch (err) {
    return response.serverError(res, err.message);
  }
};

const enableLink = async (req, res) => {
  try {
    const { linkId } = req.params;
    const snap = await ref(`${DB_PATHS.PAYMENT_LINKS}/${linkId}`).once('value');
    if (!snap.exists()) return response.notFound(res, 'Link not found');
    const link = snap.val();
    if (link.userId !== req.user.uid) return response.forbidden(res);
    if (link.expiresAt && Date.now() > link.expiresAt) return response.error(res, 'Cannot re-enable an expired link.');
    if (link.usageLimit && link.paymentCount >= link.usageLimit) return response.error(res, 'Cannot re-enable. Maximum usage limit reached.');

    await ref(`${DB_PATHS.PAYMENT_LINKS}/${linkId}`).update({ status: 'active' });
    await firebaseService.logActivity(req.user.uid, 'PAYMENT_LINK_ENABLED', { linkId, title: link.title });
    return response.success(res, 'Payment link enabled');
  } catch (err) {
    return response.serverError(res, err.message);
  }
};

const createLinkValidation = [
  body('amount').isFloat({ min: 1, max: 2000 }).withMessage('Amount must be between ₹1 and ₹2,000'),
  body('title').notEmpty().withMessage('Title is required').isLength({ max: 80 }).trim(),
  body('description').optional().isLength({ max: 300 }).trim().escape(),
  body('redirectUrl').optional({ checkFalsy: true }).isURL({ require_protocol: true }).withMessage('Redirect URL must be a valid URL starting with http:// or https://').isLength({ max: 500 }),
  body('expiryDays').optional({ checkFalsy: false }).custom((v) => {
    if (v === '' || v === null || v === undefined) return true;
    const n = parseInt(v, 10);
    if (n === -1 || n === 0) return true;
    if (n >= 1 && n <= 3650) return true;
    throw new Error('Expiry must be -1 (never) or between 1 and 3650 days');
  }),
  body('usageLimit').optional({ checkFalsy: true }).isInt({ min: 1 }).withMessage('Usage limit must be at least 1'),
];

const editLinkValidation = createLinkValidation;

module.exports = {
  createPaymentLink,
  getUserLinks,
  getLinkPublic,
  getLinkOrderStatus,
  initiatePayment,
  disableLink,
  enableLink,
  editPaymentLink,
  deletePaymentLink,
  createLinkValidation,
  editLinkValidation,
};
