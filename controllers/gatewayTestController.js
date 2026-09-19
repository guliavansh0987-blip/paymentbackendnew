// controllers/gatewayTestController.js - Gateway Test Mode simulator
//
// Backs test.html. When a merchant has switched their account to Test
// Mode, developerController.createOrder and paymentLinkController's
// initiatePayment both hand the customer a payment_url that points here
// instead of to the real Zap UPI Gateway. Nothing in this file ever calls
// walletService — a test order can only ever change a payment's `status`
// and send a clearly-labelled notification, never move real money.
//
// Both endpoints are public/unauthenticated by design, same as
// getLinkPublic/getLinkOrderStatus — the person hitting test.html is a
// merchant's own customer (or the merchant themselves while integrating),
// never a logged-in ZetPay dashboard user. Safety instead comes from
// scoping: every lookup below requires payment.isTest === true, so this
// code can never read or touch a real, live order no matter what orderId
// is passed in.
const { ref, serverTimestamp } = require('../firebase/admin');
const { DB_PATHS, NOTIFICATION_TYPE } = require('../config/constants');
const firebaseService = require('../services/firebaseService');
const notificationService = require('../services/notificationService');
const gatewayModeService = require('../services/gatewayModeService');
const response = require('../helpers/response');
const logger = require('../utils/logger');

/**
 * Where test.html should send the customer after an outcome is chosen.
 * Mirrors exactly where a REAL Zap Gateway redirect would have sent them
 * for the same order, so nothing downstream needs to know it was a test.
 */
function buildRedirectUrl(payment, result) {
  const FRONTEND = gatewayModeService.getFrontendBase();

  // Payment-link order -> same verification round trip a real link
  // payment uses (pay.html re-checks status server-side before showing
  // success/failure, so this is safe even though the redirect itself is
  // just a query param set by the client).
  if (payment.linkId) {
    return `${FRONTEND}/pay.html?id=${payment.linkId}&order=${payment.orderId}&result=${result}`;
  }

  // Store Portal purchase -> back to the SAME storefront page the
  // customer bought from (root/store/index.html, zetpay.online/store=<id>),
  // not pay.html or the merchant dashboard — it re-verifies via
  // getOrderStatus itself before showing the product's delivery link,
  // same safety principle as the pay.html path. Lives on the root domain,
  // not the panel FRONTEND base, so it gets its own base URL.
  if (payment.storeId) {
    const STORE_BASE = gatewayModeService.getStoreBase();
    return `${STORE_BASE}/store=${payment.storeId}?order=${payment.orderId}&result=${result}`;
  }

  // ZapAPI order where the merchant supplied their own redirect_url ->
  // send them back there with the same zp_order/zp_result params a real
  // Zap Gateway redirect would use.
  if (payment.testRedirectUrl) {
    const sep = payment.testRedirectUrl.includes('?') ? '&' : '?';
    return `${payment.testRedirectUrl}${sep}zp_order=${payment.orderId}&zp_result=${result}`;
  }

  // ZapAPI order opened via the zetpay-pay.js widget popup -> no redirect
  // at all. The widget is already polling order-status and will close its
  // own popup the moment it sees the new status.
  if (payment.testUseEmbedded) {
    return null;
  }

  // Raw ZapAPI call with no redirect_url given — same fallback
  // zapService.js itself uses for a live order in this situation.
  return `${FRONTEND}/index.html?payment=${result}&order=${payment.orderId}`;
}

/** Clearly-labelled Test Mode notification copy for each outcome. */
function buildNotification(payment, result) {
  const amountStr = `₹${Number(payment.amount).toFixed(2)}`;
  const via = payment.storeId ? 'store' : (payment.linkId ? 'payment link' : 'ZapAPI');

  if (result === 'success') {
    return {
      title: '🧪 Test Payment Successful',
      message: `A ${amountStr} test payment was simulated via your ${via} (Order ${payment.orderId}). Test Mode — your wallet was NOT credited.`,
    };
  }
  if (result === 'cancelled') {
    return {
      title: '🧪 Test Payment Cancelled',
      message: `A ${amountStr} test payment via your ${via} was marked Cancelled (Order ${payment.orderId}). Test Mode — no money was involved.`,
    };
  }
  return {
    title: '🧪 Test Payment Failed',
    message: `A ${amountStr} test payment via your ${via} was marked Failed (Order ${payment.orderId}). Test Mode — no money was involved.`,
  };
}

/**
 * GET /api/gateway-test/:orderId
 * Public. Lets test.html render the order it's simulating a checkout for.
 */
const getTestOrder = async (req, res) => {
  try {
    const { orderId } = req.params;
    const payment = await firebaseService.getPayment(orderId);

    if (!payment || !payment.isTest) {
      return response.notFound(res, 'Test order not found. It may have expired or this link was already used.');
    }

    let merchantName = 'ZetPay Merchant';
    if (payment.linkId) {
      const linkSnap = await ref(`${DB_PATHS.PAYMENT_LINKS}/${payment.linkId}`).once('value');
      if (linkSnap.exists() && linkSnap.val().merchantName) merchantName = linkSnap.val().merchantName;
    } else {
      const merchant = await firebaseService.getUser(payment.userId);
      if (merchant && merchant.displayName) merchantName = merchant.displayName;
    }

    return response.success(res, 'Test order fetched', {
      orderId,
      amount: payment.amount,
      title: payment.remark || 'ZetPay Payment',
      merchantName,
      status: payment.status, // 'pending' | 'success' | 'failed'
      testResult: payment.testResult || null,
    });
  } catch (err) {
    logger.error('Get test order error:', err.message);
    return response.serverError(res, err.message);
  }
};

/**
 * POST /api/gateway-test/:orderId/simulate
 * Public. Body: { result: 'success' | 'failed' | 'cancelled' }
 *
 * The only three things this ever does: (1) update this ONE payment's
 * status, (2) send one clearly-labelled Test Mode notification to the
 * merchant, (3) hand back where test.html should send the customer next.
 * It never calls walletService, never touches commission/referral/
 * subscription logic, and is a no-op (idempotent) once an order has
 * already left 'pending'.
 */
const simulateResult = async (req, res) => {
  try {
    const { orderId } = req.params;
    const { result } = req.body;

    if (!['success', 'failed', 'cancelled'].includes(result)) {
      return response.error(res, "result must be 'success', 'failed', or 'cancelled'");
    }

    const payment = await firebaseService.getPayment(orderId);
    if (!payment || !payment.isTest) {
      return response.notFound(res, 'Test order not found. It may have expired or this link was already used.');
    }

    // Idempotent: a refreshed tab or an accidental double-tap gets back the
    // same redirect instead of a second notification/activity-log entry.
    if (payment.status !== 'pending') {
      return response.success(res, 'Test result already recorded', {
        redirectUrl: buildRedirectUrl(payment, payment.testResult || payment.status),
      });
    }

    const normalizedStatus = result === 'success' ? 'success' : 'failed';

    await ref(`${DB_PATHS.PAYMENTS}/${orderId}`).update({
      status: normalizedStatus,
      testResult: result,
      environment: 'test',
      updatedAt: serverTimestamp(),
    });

    const { title, message } = buildNotification(payment, result);
    await notificationService.createNotification(payment.userId, {
      title,
      message,
      type: NOTIFICATION_TYPE.PAYMENT,
    });

    await firebaseService.logActivity(payment.userId, 'test_payment_simulated', {
      orderId,
      result,
      amount: payment.amount,
    });

    logger.info(`[TEST MODE] Order ${orderId} simulated as '${result}'`);

    return response.success(res, 'Test result recorded', {
      redirectUrl: buildRedirectUrl(payment, result),
    });
  } catch (err) {
    logger.error('Simulate test result error:', err.message);
    return response.serverError(res, err.message);
  }
};

module.exports = {
  getTestOrder,
  simulateResult,
};
