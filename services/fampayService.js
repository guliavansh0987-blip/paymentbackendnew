// services/fampayService.js
const axios = require('axios');
const https = require('https');
const firebaseService = require('./firebaseService');
const walletService = require('./walletService');
const webhookService = require('./webhookService');
const notificationService = require('./notificationService');
const encryption = require('../utils/encryption');
const logger = require('../utils/logger');
const { ref } = require('../firebase/admin');
const { DB_PATHS } = require('../config/constants');

const httpsAgent = new https.Agent({ rejectUnauthorized: false });
const HISTORY_API_URL = 'https://zetpay.online/history.php';

// history.php's date field is "datetime" (a formatted string like
// "26-08-2026 15:50:00", d-m-Y H:i:s) — not "timestamp". Both
// verifyPayment and checkUtrForOrder below need this to compare a
// transaction's time against the order's creation time.
function parseTxnDatetime(str) {
    if (!str || typeof str !== 'string') return null;
    const m = str.match(/^(\d{2})-(\d{2})-(\d{4})\s+(\d{2}):(\d{2}):(\d{2})$/);
    if (!m) return null;
    const [, dd, mm, yyyy, hh, min, ss] = m;
    return new Date(`${yyyy}-${mm}-${dd}T${hh}:${min}:${ss}`).getTime();
}

const verifyPayment = async (orderId) => {
  try {
    const payment = await firebaseService.getPayment(orderId);
    if (!payment || payment.status !== 'pending') return false;

    const verifyUid = payment.fampayVerifyUid || payment.userId;
    const user = await firebaseService.getUser(verifyUid);
    if (!user || !user.fampay || !user.fampay.isConnected) return false;

    const rawPassword = encryption.decrypt(user.fampay.password);
    if (!rawPassword) return false;

    const response = await axios.post(HISTORY_API_URL, {
      email: user.fampay.email,
      pass: rawPassword,
      limit: 15
    }, { httpsAgent, timeout: 15000 });

    // history.php's success flag is named "status", not "success" —
    // this check always rejected a genuinely successful response
    // before ever reaching the transaction-matching loop below.
    if (!response.data || !response.data.status) return false;

    const transactions = response.data.data || [];
    const paymentAmount = parseFloat(payment.amount);
    // payment.createdAt comes from Firebase's serverTimestamp() — by the
    // time this read happens it has resolved to a plain number
    // (milliseconds since epoch), but guard against any non-numeric
    // shape rather than letting a broken comparison silently reject
    // every transaction.
    const orderCreatedAt = typeof payment.createdAt === 'number' ? payment.createdAt : Date.parse(payment.createdAt) || 0;

    for (const txn of transactions) {
      const txnAmount = parseFloat(txn.amount);
      const txnTime = parseTxnDatetime(txn.datetime);
      if (txnTime === null || txnAmount !== paymentAmount) continue;

      // Matching on amount alone was unsafe: any other ₹X payment (any
      // order, any time within the old 60s-before window) could wrongly
      // confirm THIS order. Two independent checks now gate a match:
      //   1. Timing — the email must be from AFTER this order was
      //      created (a small forward buffer only, for clock skew
      //      between this server and the mail server — never backward,
      //      since a payment can't confirm an order that didn't exist
      //      yet).
      //   2. Not already claimed — this exact UTR/txn hasn't already
      //      been recorded against a DIFFERENT order (checked before
      //      the match is accepted, closing the race where two orders
      //      of the same amount are pending close together).
      // purpose (FamX's own payment-note field, when present) is
      // checked separately below as an extra positive signal, but its
      // absence doesn't block a match — many transfer types never
      // populate it.
      const CLOCK_SKEW_BUFFER_MS = 5000;
      if (txnTime < orderCreatedAt - CLOCK_SKEW_BUFFER_MS) continue;

      const txnIdentifier = (txn.utr && txn.utr !== 'NA') ? txn.utr : txn.txn_id;
      if (txnIdentifier) {
        const existingCheck = await firebaseService.getPaymentByUtr(txnIdentifier);
        if (existingCheck && existingCheck.orderId !== orderId) continue;
      }

      // Extra positive signal when available: FamX often echoes its own
      // "ZP<orderId>"-style reference in the payment note. Not required
      // (FamPay-to-FamPay transfers frequently have no purpose text at
      // all) — but if purpose IS present and does NOT contain this
      // order's id, that's a strong sign the email belongs to a
      // different order, so it's rejected rather than trusted on amount
      // + timing alone.
      if (txn.purpose && txn.purpose !== 'NA' && !txn.purpose.includes(orderId)) continue;

      logger.info(`FamPay Match Found for Order ${orderId}! UTR: ${txn.utr}`);

        await ref(`${DB_PATHS.PAYMENTS}/${orderId}`).update({
          status: 'success',
          utr: txn.utr,
          txnId: txn.txn_id || txn.utr,
          updatedAt: Date.now()
        });

        // ─── Wallet credit (routing-dependent) ────────────────────────
        // Three routingEngine values reach this function: 'system_cashier',
        // 'cashier', and 'wallet' (see paymentLinkController/paymentController/
        // storeController/developerController/subscriptionController for
        // where each is set).
        //
        // - system_cashier: ZetPay's own pooled FamPay collects the money —
        //   it genuinely passes through ZetPay, so it must be credited to
        //   the merchant's Zap Cash wallet (capped at walletLimit).
        // - wallet: same — money genuinely lands in a ZetPay-controlled
        //   account, so it's credited the same way.
        // - cashier: the merchant's OWN connected FamPay account collects
        //   the money directly — it's already sitting in their own FamPay/
        //   bank, never touching ZetPay. Crediting Zap Cash here would be a
        //   real duplicate: the merchant would have the money in their own
        //   account AND a matching ZetPay wallet balance they could then
        //   withdraw — a double-payout. So 'cashier' must NEVER credit
        //   Zap Cash; only the Zap Credit commission below applies, and
        //   incrementPaymentLinkStats (for the Paid-count/collected total)
        //   still runs regardless, since that's just a record, not money
        //   movement.
        const subscriptionService = require('./subscriptionService');
        const subSnap = await ref(`${DB_PATHS.USER_SUBSCRIPTIONS}/${payment.userId}`).once('value');
        const plan = subSnap.val()?.plan || { walletLimit: 500 };

        if (payment.routingEngine === 'cashier') {
          logger.info(`Order ${orderId}: genuine cashier routing — money already in merchant's own FamPay, skipping Zap Cash credit.`);
        } else {
          try {
            const balance = await walletService.getBalance(payment.userId);
            const available = plan.walletLimit - balance;

            const credit = Math.min(txnAmount, available);
            if (credit > 0) {
              await walletService.creditWallet(payment.userId, credit, `Order ${orderId}`);
            }
          } catch (e) {
            logger.error(`Error crediting wallet for ${payment.routingEngine}: ${e.message}`);
          }
        }

        // ─── Zap Credit deduction (unconditional) ─────────────────────
        // Commission is owed on every successful order regardless of
        // routing engine — cashier or direct wallet, doesn't matter.
        // Never blocks the payment itself: a failed debit here (e.g.
        // insufficient Zap Credit) is logged, not thrown, since the
        // customer has already paid and the merchant's wallet is
        // already credited by this point.
        const commissionPct = payment.commissionPercent ?? plan.commissionPercent ?? 5;
        const creditCost = Math.round((txnAmount * commissionPct) / 100 * 100) / 100;
        if (creditCost > 0) {
          try {
            await walletService.debitZapCredit(payment.userId, creditCost, `Commission for Order ${orderId}`);
          } catch (e) {
            logger.error(`Zap Credit debit failed for order ${orderId}: ${e.message}`);
          }
        }

        webhookService.notifyUserWebhooks(payment.userId, 'order.success', {
          order_id: orderId,
          status: 'success',
          amount: txnAmount,
          utr: txn.utr
        }).catch(() => {});

        if (payment.linkId) {
          await firebaseService.incrementPaymentLinkStats(payment.linkId, txnAmount);
        }

        let title = '💰 Payment Received via FamPay';
        let message = `₹${txnAmount} received in your FamPay account. Order: ${orderId}`;
        if (payment.storeId && payment.productId) {
          try {
            const productSnap = await ref(`${DB_PATHS.STORES}/${payment.userId}/products/${payment.productId}`).once('value');
            const productData = productSnap.val();
            if (productData) {
              title = '🛍️ Product Sold!';
              message = `"${productData.title || 'Product'}" sold for ₹${txnAmount} via FamPay. Order: ${orderId}`;
              await ref(`${DB_PATHS.STORES}/${payment.userId}/products/${payment.productId}`).update({
                salesCount: (productData.salesCount || 0) + 1,
                totalCollected: (productData.totalCollected || 0) + txnAmount,
                lastSoldAt: Date.now(),
              });
            }
          } catch (e) {
            logger.warn(`Product stats update failed for ${orderId}: ${e.message}`);
          }
        } else if (payment.linkId) {
          title = '💰 Payment Received via Link';
          message = `₹${txnAmount} received via your payment link (FamPay). Order: ${orderId}`;
        }

        await notificationService.createNotification(payment.userId, {
          title, message, type: 'payment',
        });

        return true;
    }
    return false;
  } catch (err) {
    logger.error(`Fampay verification error for ${orderId}: ${err.message}`);
    return false;
  }
};

async function checkUtrForOrder(orderId, identifier) {
  try {
    const payment = await firebaseService.getPayment(orderId);
    if (!payment) return false;

    const verifyUid = payment.fampayVerifyUid || payment.userId;
    const user = await firebaseService.getUser(verifyUid);
    if (!user || !user.fampay || !user.fampay.isConnected) return false;

    const rawPassword = encryption.decrypt(user.fampay.password);
    if (!rawPassword) return false;

    const response = await axios.post(HISTORY_API_URL, {
      email: user.fampay.email,
      pass: rawPassword,
      limit: 20
    }, { httpsAgent, timeout: 15000 });
    // Same field-name fix as verifyPayment above — history.php returns
    // "status", not "success".
    if (!response.data || !response.data.status) return false;

    const transactions = response.data.data || [];
    const paymentAmount = parseFloat(payment.amount);
    const orderCreatedAt = typeof payment.createdAt === 'number' ? payment.createdAt : Date.parse(payment.createdAt) || 0;
    const identifierTrimmed = identifier.trim();

    for (const txn of transactions) {
      const txnAmount = parseFloat(txn.amount);
      const txnTime = parseTxnDatetime(txn.datetime);
      
      const utrMatch = (txn.utr === identifierTrimmed);
      const txnIdMatch = (txn.txn_id === identifierTrimmed);
      
      // The identifier itself (a specific UTR/txn id the user typed) is
      // already a strong signal here, unlike the amount-only case in
      // verifyPayment — but keep the same forward-only time check for
      // consistency, and the same "not already claimed" dedup guard.
      const CLOCK_SKEW_BUFFER_MS = 5000;
      if ((utrMatch || txnIdMatch) && txnTime !== null && txnTime >= orderCreatedAt - CLOCK_SKEW_BUFFER_MS && txnAmount === paymentAmount) {
        if (txn.utr && txn.utr !== 'NA') {
          const existingUtrCheck = await firebaseService.getPaymentByUtr(txn.utr);
          if (existingUtrCheck && existingUtrCheck.orderId !== orderId) continue;
        }
        if (txn.txn_id && txn.txn_id !== 'NA') {
          const existingTxnCheck = await firebaseService.getPaymentByTxnId(txn.txn_id);
          if (existingTxnCheck && existingTxnCheck.orderId !== orderId) continue;
        }
        return true;
      }
    }
    return false;
  } catch (err) {
    logger.error(`checkUtrForOrder error for ${orderId}: ${err.message}`);
    return false;
  }
}

module.exports = { verifyPayment, checkUtrForOrder };
