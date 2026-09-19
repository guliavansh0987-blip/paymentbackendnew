// controllers/developerController.js - ZetAPI Developer Platform
const { body, validationResult } = require('express-validator');
const { ref } = require('../firebase/admin');
const { DB_PATHS } = require('../config/constants');
const zapService = require('../services/zapService');
const firebaseService = require('../services/firebaseService');
const walletService = require('../services/walletService');
const subscriptionService = require('../services/subscriptionService');
const apiTokenService = require('../services/apiTokenService');
const gatewayModeService = require('../services/gatewayModeService');
const webhookService = require('../services/webhookService');
const response = require('../helpers/response');
const logger = require('../utils/logger');

const getMyToken = async (req, res) => {
  try {
    const record = await apiTokenService.getOrCreateToken(req.user.uid);
    const mode = await gatewayModeService.getMode(req.user.uid);
    const user = await firebaseService.getUser(req.user.uid); 
    const cashierConnected = !!(user?.fampay?.isConnected);
    const paytmCashierConnected = !!(user?.paytm?.isConnected);
    // If Cashier/Paytm Cashier was previously selected but that gateway
    // has since been disconnected, don't report a routing engine the
    // merchant can no longer actually use.
    let reportedRoutingEngine = user?.apiRoutingEngine || 'wallet';
    if (reportedRoutingEngine === 'cashier' && !cashierConnected) reportedRoutingEngine = 'wallet';
    if (reportedRoutingEngine === 'paytm_cashier' && !paytmCashierConnected) reportedRoutingEngine = 'wallet';
    return response.success(res, 'ZetAPI key fetched', {
      apiKey: record.key,
      createdAt: record.createdAt,
      lastUsedAt: record.lastUsedAt || null,
      mode,
      routingEngine: reportedRoutingEngine,
      cashierConnected,
      paytmCashierConnected,
    });
  } catch (err) {
    logger.error('Get ZetAPI token error:', err.message);
    return response.serverError(res, err.message);
  }
};

const getMode = async (req, res) => {
  try {
    const mode = await gatewayModeService.getMode(req.user.uid);
    return response.success(res, 'Gateway mode fetched', { mode });
  } catch (err) {
    logger.error('Get gateway mode error:', err.message);
    return response.serverError(res, err.message);
  }
};

const setMode = async (req, res) => {
  try {
    const { mode } = req.body;
    if (mode !== 'live' && mode !== 'test') {
      return response.error(res, "Mode must be 'live' or 'test'");
    }
    await gatewayModeService.setMode(req.user.uid, mode);
    await firebaseService.logActivity(req.user.uid, 'gateway_mode_changed', { mode });
    return response.success(res, `Gateway switched to ${mode === 'test' ? 'Test' : 'Live'} Mode`, { mode });
  } catch (err) {
    logger.error('Set gateway mode error:', err.message);
    return response.serverError(res, err.message);
  }
};

const setRoutingEngine = async (req, res) => {
  try {
    const { routingEngine } = req.body;
    if (!['wallet', 'cashier', 'paytm_cashier'].includes(routingEngine)) return response.error(res, 'Invalid engine');

    // Cashier/Paytm Cashier routing only makes sense once that gateway is
    // actually connected — otherwise there's no UPI ID to build the
    // direct-QR checkout with, and every payment would silently fail.
    // Block the switch at the source instead of letting the frontend be
    // the only thing enforcing this.
    if (routingEngine === 'cashier') {
      const user = await firebaseService.getUser(req.user.uid);
      if (!user?.fampay?.isConnected) {
        return response.error(res, 'Connect FamPay first before switching to Cashier routing.');
      }
    }
    if (routingEngine === 'paytm_cashier') {
      const user = await firebaseService.getUser(req.user.uid);
      if (!user?.paytm?.isConnected) {
        return response.error(res, 'Connect Paytm first before switching to Paytm Cashier routing.');
      }
    }

    await ref(`${DB_PATHS.USERS}/${req.user.uid}`).update({ apiRoutingEngine: routingEngine });
    return response.success(res, 'Routing updated', { routingEngine });
  } catch (err) {
    return response.serverError(res, err.message);
  }
};

const regenerateMyToken = async (req, res) => {
  try {
    const record = await apiTokenService.regenerateToken(req.user.uid);
    await firebaseService.logActivity(req.user.uid, 'zapapi_key_regenerated', {});
    return response.success(res, 'ZetAPI key regenerated', {
      apiKey: record.key,
      createdAt: record.createdAt,
    });
  } catch (err) {
    logger.error('Regenerate ZetAPI token error:', err.message);
    return response.serverError(res, err.message);
  }
};

const createOrderValidation = [
  body('amount').notEmpty().withMessage('Amount is required').isFloat({ min: 1, max: 5000 }).withMessage('Amount must be between ₹1 and ₹5,000'),
  body('title').optional({ checkFalsy: true }).isLength({ max: 100 }).withMessage('Title must be under 100 characters').trim(),
  body('customer_mobile').optional({ checkFalsy: true }).isMobilePhone('en-IN').withMessage('Invalid mobile number'),
];

const createOrder = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return response.error(res, 'Validation failed', 400, errors.array());

    const userId = req.user.uid;
    const { amount, title, customer_mobile, redirect_url, useEmbedded, routingEngine } = req.body;
    const amt = parseFloat(amount);
    const orderId = zapService.generateOrderId(userId);
    const remark = title || 'ZetPay Payment';

    const gatewayMode = await gatewayModeService.getMode(userId);

    // TEST MODE
    if (gatewayMode === 'test') {
      await firebaseService.createPayment(orderId, {
        userId, amount: amt, remark, customerMobile: customer_mobile || '',
        type: 'api', isTest: true, testRedirectUrl: redirect_url || null, testUseEmbedded: !!useEmbedded,
      });
      webhookService.notifyUserWebhooks(userId, 'order.pending', { order_id: orderId, status: 'pending', amount: amt, mode: 'test' }).catch((e) => {});
      return response.success(res, 'Order created (Test Mode)', { order_id: orderId, payment_url: gatewayModeService.buildTestPaymentUrl(orderId), amount: amt, mode: 'test' });
    }

    const settings = await firebaseService.getSettings();
    if (settings.maintenanceMode) return response.error(res, 'Payment system is under maintenance.', 503);

    const sub = await subscriptionService.getUserSubscription(userId);
    const balance = await walletService.getBalance(userId);
    if (balance + amt > sub.plan.walletLimit) {
      return response.error(res, 'Your ZetPay wallet is full. Upgrade your plan or withdraw first.');
    }

    // ─── Zap Credit gate ─────────────────────────────────────────
    const commissionPercent = sub.plan.commissionPercent ?? 5;
    const creditCheck = await walletService.checkSufficientCreditForOrder(userId, amt, commissionPercent);
    if (!creditCheck.ok) {
      logger.warn(`Insufficient Zap Credit for ZetAPI order: user=${userId} required=${creditCheck.required} available=${creditCheck.available}`);
      return response.error(res, 'Insufficient Zap Credit. Please recharge Zap Credit before accepting this payment.');
    }

    const merchantUser = await firebaseService.getUser(userId);
    // Routing is an account-wide setting controlled only from the Developer
    // Portal (apiRoutingEngine) — never a per-request choice, and never
    // honored as 'cashier'/'paytm_cashier' unless that gateway is actually
    // connected right now (it may have been disconnected since
    // apiRoutingEngine was last set).
    const cashierConnected = !!merchantUser?.fampay?.isConnected;
    const paytmCashierConnected = !!merchantUser?.paytm?.isConnected;
    const finalRoutingEngine =
      (merchantUser?.apiRoutingEngine === 'paytm_cashier' && paytmCashierConnected) ? 'paytm_cashier' :
      (merchantUser?.apiRoutingEngine === 'cashier' && cashierConnected) ? 'cashier' : 'wallet';

    // Hide Wallet System: an order that would fall back to 'wallet' means
    // this merchant has no cashier actually connected right now — once the
    // toggle is on, that's not allowed. This mirrors the check in
    // paymentLinkController's initiatePayment (same rule, ZetAPI's own
    // order-creation path instead of a payment link's checkout).
    if (settings.hideWalletSystemEnabled && finalRoutingEngine === 'wallet') {
      return response.error(res, 'Connect your own FamPay or Paytm cashier before creating orders. Go to Zap API → Payment Routing to connect one.', 403, { requiresCashierConnect: true });
    }

    // PAYTM CASHIER FLOW
    // Mirrors the FamPay cashier flow below, but checkout.html needs the
    // Paytm-specific reference (paytmTxnRef) so paytmService can look this
    // order up against Paytm's own order-status API later. Generated here
    // (not left to checkout.html) so it's already on the payment record
    // the moment the order exists — verifyPayment reads it directly rather
    // than deriving it from the orderId.
    if (finalRoutingEngine === 'paytm_cashier') {
      const paytmTxnRef = 'PTM' + Date.now() + Math.random().toString(36).slice(2, 8).toUpperCase();
      await firebaseService.createPayment(orderId, {
        userId, amount: amt, remark, customerMobile: customer_mobile || '', type: 'api',
        routingEngine: 'paytm_cashier', paymentMethod: 'paytm', status: 'pending', commissionPercent,
        paytmTxnRef,
      });

      const upiIdToUse = merchantUser?.paytm?.upiId || '';
      let checkoutUrl = `https://zetpay.online/checkout.html?order_id=${orderId}&amount=${amt}&upi=${encodeURIComponent(upiIdToUse)}&method=paytm&txn_ref=${encodeURIComponent(paytmTxnRef)}`;
      checkoutUrl += `&theme=${encodeURIComponent(merchantUser?.checkoutTheme || 'default')}`;
      if (merchantUser?.checkoutThemeColor) checkoutUrl += `&color=${encodeURIComponent(merchantUser.checkoutThemeColor)}`;
      if (redirect_url) {
        checkoutUrl += `&redirect_url=${encodeURIComponent(redirect_url)}`;
      }

      logger.info(`Paytm Cashier ZetAPI order created: ${orderId} by user ${userId} for ₹${amt}`);
      webhookService.notifyUserWebhooks(userId, 'order.pending', { order_id: orderId, status: 'pending', amount: amt, mode: 'live' }).catch((e) => {});

      return response.success(res, 'Order created via Paytm Cashier', {
        order_id: orderId, payment_url: checkoutUrl, amount: amt, mode: 'live', method: 'paytm_cashier'
      });
    }

    // CASHIER FLOW
    if (finalRoutingEngine === 'cashier') {
      await firebaseService.createPayment(orderId, { userId, amount: amt, remark, customerMobile: customer_mobile || '', type: 'api', routingEngine: 'cashier', paymentMethod: 'fampay', status: 'pending', commissionPercent });
      
      const upiIdToUse = merchantUser?.fampay?.upiId || merchantUser?.upiId || ''; 
      let checkoutUrl = `https://zetpay.online/checkout.html?order_id=${orderId}&amount=${amt}&upi=${encodeURIComponent(upiIdToUse)}`;
      checkoutUrl += `&theme=${encodeURIComponent(merchantUser?.checkoutTheme || 'default')}`;
      if (merchantUser?.checkoutThemeColor) checkoutUrl += `&color=${encodeURIComponent(merchantUser.checkoutThemeColor)}`;
      if (redirect_url) {
        checkoutUrl += `&redirect_url=${encodeURIComponent(redirect_url)}`;
      }

      logger.info(`Cashier ZetAPI order created: ${orderId} by user ${userId} for ₹${amt}`);
      webhookService.notifyUserWebhooks(userId, 'order.pending', { order_id: orderId, status: 'pending', amount: amt, mode: 'live' }).catch((e) => {});

      return response.success(res, 'Order created via Cashier', {
        order_id: orderId, payment_url: checkoutUrl, amount: amt, mode: 'live', method: 'cashier'
      });
    }

    let isSystemCashier = false;
    let sysAdminUser = null;
    if (settings.systemRoutingMode === 'self' && settings.systemRoutingAdminUid) {
      sysAdminUser = await firebaseService.getUser(settings.systemRoutingAdminUid);
      if (sysAdminUser && sysAdminUser.fampay && sysAdminUser.fampay.isConnected) isSystemCashier = true;
    }

    await firebaseService.createPayment(orderId, { 
        userId, amount: amt, remark, customerMobile: customer_mobile || '', type: 'api', 
        routingEngine: isSystemCashier ? 'system_cashier' : 'wallet', 
        status: 'pending', commissionPercent,
        paymentMethod: isSystemCashier ? 'fampay' : 'zapupi',
        cashierUpiId: isSystemCashier ? sysAdminUser.fampay.upiId : null,
        fampayVerifyUid: isSystemCashier ? sysAdminUser.uid : null
    });

    const redirectParams = (result) => redirect_url ? `${redirect_url}${redirect_url.includes('?') ? '&' : '?'}zp_order=${orderId}&zp_result=${result}` : undefined;
    
    if (isSystemCashier) {
        let checkoutUrl = `https://zetpay.online/checkout.html?order_id=${orderId}&amount=${amt}&upi=${encodeURIComponent(sysAdminUser.fampay.upiId)}`;
        // Theme comes from merchantUser (whoever's ZetAPI key created this
        // order), not sysAdminUser — the checkout page shows to THIS
        // merchant's customer, so it should carry this merchant's branding
        // even though the UPI collection itself routes through the
        // system admin's connected FamPay.
        checkoutUrl += `&theme=${encodeURIComponent(merchantUser?.checkoutTheme || 'default')}`;
        if (merchantUser?.checkoutThemeColor) checkoutUrl += `&color=${encodeURIComponent(merchantUser.checkoutThemeColor)}`;
        const successRedir = redirectParams('success');
        if (successRedir) checkoutUrl += `&redirect_url=${encodeURIComponent(successRedir)}`;
        webhookService.notifyUserWebhooks(userId, 'order.pending', { order_id: orderId, status: 'pending', amount: amt, mode: 'live' }).catch((e) => {});
        return response.success(res, 'Order created via System Cashier', { order_id: orderId, payment_url: checkoutUrl, amount: amt, mode: 'live', method: 'system_cashier' });
    }

    // WALLET FLOW
    const zapOrder = await zapService.createOrder({
      orderId, amount: String(amt.toFixed(2)), customerMobile: customer_mobile || '', remark,
      omitRedirectUrls: !!useEmbedded && !redirect_url,
      ...(redirect_url ? { successUrl: redirectParams('success'), failedUrl: redirectParams('failed'), timeoutUrl: redirectParams('failed') } : {}),
    });

    // Defensive patch: ZapUPI's own create-order API (pay.zapupi.com,
    // external — not our code) is expected to return a payment_url that
    // already carries order_id + amount when it points at our own
    // checkout.html. It has been observed NOT to (payment_url comes back
    // as e.g. "checkout.html?amount=1&redirect_url=..." with order_id
    // missing entirely) — since we can't fix ZapUPI's own response
    // construction from here, we make sure checkout.html always gets
    // what it needs by injecting order_id ourselves whenever the
    // returned payment_url is one of our own checkout.html links and is
    // missing it. Left untouched for any other (genuinely external)
    // payment_url, so this can't accidentally corrupt a real ZapUPI-
    // hosted checkout page URL that has its own unrelated structure.
    let finalPaymentUrl = zapOrder.paymentUrl;
    try {
      const u = new URL(finalPaymentUrl);
      if (u.pathname.endsWith('/checkout.html') && !u.searchParams.has('order_id')) {
        u.searchParams.set('order_id', orderId);
        if (!u.searchParams.has('amount')) u.searchParams.set('amount', String(amt));
        finalPaymentUrl = u.toString();
        logger.warn(`ZapUPI payment_url was missing order_id for order ${orderId} — patched before returning to client.`);
      }
    } catch (e) {
      // If paymentUrl isn't a parseable absolute URL for some reason,
      // leave it exactly as ZapUPI returned it rather than guessing.
    }

    logger.info(`ZetAPI order created: ${orderId} by user ${userId} for ₹${amt}`);
    webhookService.notifyUserWebhooks(userId, 'order.pending', { order_id: orderId, status: 'pending', amount: amt, mode: 'live' }).catch((e) => {});

    return response.success(res, 'Order created', { order_id: orderId, payment_url: finalPaymentUrl, amount: amt, mode: 'live', method: 'wallet' });
  } catch (err) {
    logger.error('ZetAPI create-order error:', err.message);
    return response.error(res, err.message || 'Failed to create order');
  }
};

const getOrderStatus = async (req, res) => {
  try {
    const { orderId } = req.params;
    const payment = await firebaseService.getPayment(orderId);
    if (!payment || payment.userId !== req.user.uid) return response.notFound(res, 'Order not found');
    return response.success(res, 'Status fetched', { order_id: orderId, status: payment.status, amount: payment.amount });
  } catch (err) {
    logger.error('ZetAPI order-status error:', err.message);
    return response.serverError(res, err.message);
  }
};

const getPublicOrderStatus = async (req, res) => {
  try {
    const { orderId } = req.params;
    const payment = await firebaseService.getPayment(orderId);
    if (!payment) return response.notFound(res, 'Order not found');

    if (payment.status === 'pending') {
      const now = Date.now();
      const lastCheck = payment.lastImapCheck || 0;
      
      if (now - lastCheck > 15000) {
        await ref(`${DB_PATHS.PAYMENTS}/${orderId}`).update({ lastImapCheck: now });
        
        try {
          // Dispatch to the right verifier for how this order was routed —
          // a Paytm-routed order (has its own paytmTxnRef) is checked
          // against Paytm's own order-status API; everything else falls
          // back to the FamPay inbox-scraping verifier as before.
          const verifierService = payment.paytmTxnRef
            ? require('../services/paytmService')
            : require('../services/fampayService');
          if (verifierService && typeof verifierService.verifyPayment === 'function') {
            await verifierService.verifyPayment(orderId);
          }
        } catch (verifyErr) {
          logger.warn(`Auto-verify trigger warning for ${orderId}:`, verifyErr.message);
        }
        
        const updatedPayment = await firebaseService.getPayment(orderId);
        if (updatedPayment) {
          payment.status = updatedPayment.status;
          payment.utr = updatedPayment.utr || updatedPayment.txnId;
        }
      }
    }

    return response.success(res, 'Status fetched', { 
      order_id: orderId, 
      status: payment.status, 
      amount: payment.amount,
      utr: payment.utr || payment.txnId || null 
    });
  } catch (err) {
    logger.error('Public order-status error:', err.message);
    return response.serverError(res, err.message);
  }
};

/**
 * POST /api/developer/cancel-order
 * Public (No Auth Required) — called from checkout.html when the customer
 * confirms "Cancel Order", or when the payment session times out. Marks
 * the order 'cancelled'/'timeout' server-side so it actually stops here
 * instead of the button only *looking* like it worked while the order
 * stays 'pending' forever (and could still be paid/marked success later
 * by a stray webhook or a slow UPI confirmation).
 * Body: { orderId, reason? } — reason is 'cancelled' (default) or 'timeout'.
 */
const cancelOrder = async (req, res) => {
  try {
    const { orderId } = req.body;
    const reason = req.body.reason === 'timeout' ? 'timeout' : 'cancelled';
    if (!orderId) return response.error(res, 'Order ID is required', 400);

    const payment = await firebaseService.getPayment(orderId);
    if (!payment) return response.notFound(res, 'Order not found');

    // Already-final states must not be clobbered by a late/duplicate cancel
    // click — e.g. the UPI payment actually went through a second before
    // the customer hit Cancel (or right as the timer hit 0), or they
    // double-tap the confirm button / the timer fires while a cancel
    // request is already in flight.
    if (payment.status === 'success') {
      return response.error(res, 'This order is already paid and cannot be cancelled', 409, { status: 'success' });
    }
    if (payment.status === 'cancelled' || payment.status === 'timeout') {
      return response.success(res, `Order already ${payment.status}`, { order_id: orderId, status: payment.status });
    }
    if (payment.status !== 'pending') {
      return response.error(res, `Order cannot be cancelled (current status: ${payment.status})`, 409, { status: payment.status });
    }

    await ref(`${DB_PATHS.PAYMENTS}/${orderId}`).update({
      status: reason,
      updatedAt: Date.now(),
    });

    webhookService.notifyUserWebhooks(payment.userId, reason === 'timeout' ? 'order.timeout' : 'order.cancelled', {
      order_id: orderId,
      status: reason,
      amount: payment.amount,
    }).catch(() => {});

    logger.info(`Order ${reason} by customer: ${orderId}`);

    return response.success(res, `Order ${reason} successfully`, { order_id: orderId, status: reason });
  } catch (err) {
    logger.error('Cancel order error:', err.message);
    return response.serverError(res, err.message);
  }
};

const verifyUtr = async (req, res) => {
  try {
    const { orderId, utr } = req.body;
    if (!orderId || !utr) {
      return response.error(res, 'Order ID and UTR/Txn ID are required', 400);
    }

    const payment = await firebaseService.getPayment(orderId);
    if (!payment) return response.notFound(res, 'Order not found');

    if (payment.status === 'success') {
      return response.success(res, 'Order is already verified', { order_id: orderId, status: 'success', utr: payment.utr });
    }

    await ref(`${DB_PATHS.PAYMENTS}/${orderId}`).update({ 
      utr: utr, 
      status: 'success',
      updatedAt: Date.now()
    });

    webhookService.notifyUserWebhooks(payment.userId, 'order.success', { 
      order_id: orderId, 
      status: 'success', 
      amount: payment.amount, 
      utr: utr 
    }).catch((e) => {});
    
    logger.info(`Manual UTR verified successfully for order: ${orderId} with UTR: ${utr}`);

    return response.success(res, 'Verified successfully', { order_id: orderId, status: 'success', utr });
  } catch (err) {
    logger.error('Verify UTR error:', err.message);
    return response.serverError(res, err.message);
  }
};

const checkFullOrderJson = async (req, res) => {
  try {
    const { orderId } = req.params;
    const payment = await firebaseService.getPayment(orderId);
    if (!payment) return res.status(404).json({ success: false, message: 'Order not found' });
    return res.status(200).json({ success: true, message: 'Full order details', data: payment });
  } catch (err) {
    logger.error('Check Full Order error:', err.message);
    return res.status(500).json({ success: false, message: 'Server Error: ' + err.message });
  }
};

module.exports = {
  getMyToken,
  regenerateMyToken,
  createOrder,
  createOrderValidation,
  getOrderStatus,
  getMode,
  setMode,
  setRoutingEngine,
  getPublicOrderStatus,
  cancelOrder,
  verifyUtr,
  checkFullOrderJson
};
