// services/paytmService.js
//
// Mirrors fampayService.js's verifyPayment shape, but for Paytm. FamPay
// has no official merchant API, so its verifyPayment scrapes a connected
// Gmail inbox (via history.php) and matches transactions by amount/time.
// Paytm DOES have an official order-status API
// (https://securegw.paytm.in/order/status), keyed by MID + the merchant's
// own order/txn reference — so this never touches email at all, and the
// amount/time/dedup heuristics fampayService needs (because it's matching
// blind against an inbox) aren't needed here: Paytm's response is already
// scoped to the exact order being asked about.
const axios = require('axios');
const encryption = require('../utils/encryption');
const firebaseService = require('./firebaseService');
const { ref } = require('../firebase/admin');
const { DB_PATHS } = require('../config/constants');
const logger = require('../utils/logger');

const PAYTM_STATUS_URL = 'https://securegw.paytm.in/order/status';

/**
 * Verifies one pending order against Paytm's own order-status API, using
 * THIS order's own owner's connected MID — never a shared/hardcoded
 * credential, same principle as fampayService's per-user credential
 * sourcing. On a confirmed TXN_SUCCESS (matched to this exact order's own
 * merchantTransactionId, not just amount), updates the order to success
 * and credits the wallet exactly once.
 */
const verifyPayment = async (orderId) => {
  try {
    const payment = await firebaseService.getPayment(orderId);
    if (!payment || payment.status !== 'pending') return false;
    if (!payment.paytmTxnRef) return false; // order wasn't created via the Paytm flow

    const verifyUid = payment.paytmVerifyUid || payment.userId;
    const user = await firebaseService.getUser(verifyUid);
    if (!user || !user.paytm || !user.paytm.isConnected) return false;

    const rawMid = encryption.decrypt(user.paytm.mid);
    if (!rawMid) return false;

    const response = await axios.get(PAYTM_STATUS_URL, {
      params: { JsonData: JSON.stringify({ MID: rawMid, ORDERID: payment.paytmTxnRef }) },
      timeout: 8000,
    });

    const data = response.data;
    if (!data || typeof data !== 'object') return false;

    // Paytm's own three-way match: right gateway status, right MID, right
    // order reference. Amount is checked too as a final sanity guard, even
    // though ORDERID alone already scopes this to one specific order.
    const txnAmount = parseFloat(data.TXNAMOUNT);
    const paymentAmount = parseFloat(payment.amount);
    if (
      data.STATUS === 'TXN_SUCCESS' &&
      data.MID === rawMid &&
      data.ORDERID === payment.paytmTxnRef &&
      txnAmount === paymentAmount
    ) {
      const utr = data.BANKTXNID || data.TXNID || '';

      // Same UTR-already-claimed guard as fampayService — closes the
      // race where two orders could otherwise both try to claim the same
      // underlying bank transaction.
      if (utr) {
        const existingCheck = await firebaseService.getPaymentByUtr(utr);
        if (existingCheck && existingCheck.orderId !== orderId) return false;
      }

      // Atomically claim the PENDING->SUCCESS transition first, so two
      // concurrent polls for the same order can't both credit the wallet.
      const updateResult = await ref(`${DB_PATHS.PAYMENTS}/${orderId}`)
        .transaction((current) => {
          if (!current || current.status !== 'pending') return; // abort — already handled by another poll
          current.status = 'success';
          current.utr = utr;
          current.txnId = data.TXNID || utr;
          current.updatedAt = Date.now();
          return current;
        });

      if (!updateResult.committed) return true; // another poll already won the race — still a genuine success, just not ours to re-process

      logger.info(`Paytm Match Found for Order ${orderId}! UTR: ${utr}`);

      const walletService = require('./walletService');

      // NOTE: unlike FamPay, Paytm has no ZetPay-pooled/system_cashier path —
      // every Paytm order is verified against THIS merchant's own connected
      // MID (line 39 above), meaning the money always already lands directly
      // in the merchant's own Paytm account. Crediting it again to the
      // ZetPay wallet would be a duplicate the merchant could then withdraw
      // on top of money they already have — the same double-payout risk as
      // genuine 'cashier' routing in fampayService.js. So Paytm orders never
      // credit Zap Cash; only the Zap Credit commission below applies.
      // incrementLinkUsage is a usage-count record, not money movement, so
      // it's unaffected and still only runs for the system_cashier case
      // (kept for forward-compatibility if a pooled Paytm path is ever added).
      if (payment.routingEngine === 'system_cashier') {
        try {
          const subscriptionService = require('./subscriptionService');
          await subscriptionService.incrementLinkUsage(payment.userId);
        } catch (e) {
          logger.error(`Failed to increment link usage for ${orderId}: ${e.message}`);
        }
      }

      // ─── Zap Credit deduction (unconditional) ─────────────────────
      // Same as fampayService/smsWebhookController: commission is owed
      // on every successful order regardless of routing engine. Never
      // blocks the payment — a failed debit is logged, not thrown.
      try {
        const subscriptionService = require('./subscriptionService');
        const sub = await subscriptionService.getUserSubscription(payment.userId);
        const plan = sub.plan;
        const commissionPct = payment.commissionPercent ?? plan.commissionPercent ?? 5;
        const creditCost = Math.round((paymentAmount * commissionPct) / 100 * 100) / 100;
        if (creditCost > 0) {
          try {
            await walletService.debitZapCredit(payment.userId, creditCost, `Commission for Order ${orderId}`);
          } catch (e) {
            logger.error(`Zap Credit debit failed for Paytm order ${orderId}: ${e.message}`);
          }
        }
      } catch (e) {
        logger.error(`Commission calc failed for Paytm order ${orderId}: ${e.message}`);
      }

      try {
        const webhookService = require('./webhookService');
        await webhookService.notifyUserWebhooks(payment.userId, 'payment.success', {
          order_id: orderId, status: 'success', amount: paymentAmount, utr, method: 'paytm',
        });
      } catch (e) { /* webhook delivery failures shouldn't block verification */ }

      try {
        const notificationService = require('./notificationService');
        const title = 'Payment Received';
        const message = `₹${paymentAmount} received via Paytm for order ${orderId}.`;
        await notificationService.createNotification(payment.userId, { title, message, type: 'payment' });
      } catch (e) { /* notification failures shouldn't block verification */ }

      return true;
    }

    if (data.STATUS === 'TXN_FAILURE' || data.STATUS === 'PENDING') {
      return false; // caller keeps polling — not yet a terminal state worth acting on
    }

    return false;
  } catch (err) {
    logger.error(`Paytm verifyPayment error for ${orderId}: ${err.message}`);
    return false;
  }
};

module.exports = { verifyPayment };
