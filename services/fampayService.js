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
const { fetchGmailTransactions } = require('./imapService');
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
    // Email timestamps from Indian banking/UPI (FamPay) are in Indian Standard Time (IST: UTC+05:30).
    // Specifying +05:30 ensures UTC servers (like Vercel) parse the exact millisecond timestamp without skew.
    return new Date(`${yyyy}-${mm}-${dd}T${hh}:${min}:${ss}+05:30`).getTime();
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

    let transactions = [];
    try {
      transactions = await fetchGmailTransactions(user.fampay.email, rawPassword, 5);
    } catch (imapErr) {
      logger.warn(`Direct IMAP failed in verifyPayment, trying HTTP fallback: ${imapErr.message}`);
      try {
        const response = await axios.post(HISTORY_API_URL, {
          email: user.fampay.email,
          pass: rawPassword,
          limit: 5
        }, { httpsAgent, timeout: 8000 });
        if (response.data && response.data.status) {
          transactions = response.data.data || [];
        }
      } catch (httpErr) {
        logger.error(`HTTP fallback also failed in verifyPayment: ${httpErr.message}`);
      }
    }

    if (!transactions.length) return false;
    const paymentAmount = parseFloat(payment.amount);
    const orderCreatedAt = typeof payment.createdAt === 'number' ? payment.createdAt : Date.parse(payment.createdAt) || 0;

    for (const txn of transactions) {
      const txnAmount = parseFloat(txn.amount);
      const txnTime = parseTxnDatetime(txn.datetime);
      if (txnTime === null || txnAmount !== paymentAmount) continue;

      // 1. Timing: transaction must occur around or after the order was created
      // 3 minutes (180s) buffer handles minute-precision timestamps in emails & network skew
      const CLOCK_SKEW_BUFFER_MS = 180000;
      if (txnTime < orderCreatedAt - CLOCK_SKEW_BUFFER_MS) continue;

      // 2. Claim check: neither UTR nor txnId can already belong to a DIFFERENT order
      if (txn.utr && txn.utr !== 'NA') {
        const existingUtr = await firebaseService.getPaymentByUtr(txn.utr);
        if (existingUtr && existingUtr.orderId !== orderId) continue;
      }
      if (txn.txn_id && txn.txn_id !== 'NA') {
        const existingTxn = await firebaseService.getPaymentByTxnId(txn.txn_id);
        if (existingTxn && existingTxn.orderId !== orderId) continue;
      }

      // 3. Order ID / Correlation check:
      // Primary: The UPI QR code sets tn=ZPP<orderId>. Check if note/purpose/raw text contains it.
      const cleanOrderId = orderId.replace(/^zpp/i, '').toLowerCase();
      const targetOrderId = orderId.toLowerCase();
      const zppTarget = `zpp${cleanOrderId}`;

      const purposeStr = String(txn.purpose || '').toLowerCase();
      const rawStr = String(txn.rawText || txn.raw_text || '').toLowerCase();

      let hasOrderId = (txn.purpose && txn.purpose !== 'NA' && (
                           purposeStr.includes(targetOrderId) || 
                           purposeStr.includes(cleanOrderId) || 
                           purposeStr.includes(zppTarget)
                         )) ||
                         rawStr.includes(targetOrderId) ||
                         rawStr.includes(cleanOrderId) ||
                         rawStr.includes(zppTarget);

      let isMatch = hasOrderId;

      // Fallback: If customer's UPI app (GPay/PhonePe/Paytm) stripped or omitted the tn note,
      // verify if there are no other pending orders with this exact amount for this merchant in the window.
      if (!isMatch) {
        try {
          const pendingSnap = await ref(DB_PATHS.PAYMENTS)
            .orderByChild('userId')
            .equalTo(payment.userId)
            .once('value');

          let competingCount = 0;
          if (pendingSnap.exists()) {
            pendingSnap.forEach((child) => {
              const other = child.val();
              if (
                child.key !== orderId &&
                other.status === 'pending' &&
                parseFloat(other.amount) === paymentAmount
              ) {
                const otherCreated = typeof other.createdAt === 'number'
                  ? other.createdAt
                  : Date.parse(other.createdAt) || 0;
                if (Math.abs(otherCreated - orderCreatedAt) < 600000) {
                  competingCount++;
                }
              }
            });
          }

          if (competingCount === 0) {
            isMatch = true;
            logger.info(`FamPay auto-match via sole-order correlation for ${orderId} (₹${paymentAmount})`);
          }
        } catch (compErr) {
          logger.warn(`Competing order check warning for ${orderId}: ${compErr.message}`);
        }
      }

      if (!isMatch) {
        continue;
      }

      logger.info(`FamPay Match Found for Order ${orderId}! UTR: ${txn.utr}`);

        await ref(`${DB_PATHS.PAYMENTS}/${orderId}`).update({
          status: 'success',
          utr: txn.utr !== 'NA' ? txn.utr : (txn.txn_id || orderId),
          txnId: txn.txn_id !== 'NA' ? txn.txn_id : (txn.utr || orderId),
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

        try {
          const balance = await walletService.getBalance(payment.userId);
          const available = plan.walletLimit - balance;

          const credit = Math.min(txnAmount, available);
          if (credit > 0) {
            await walletService.creditWallet(payment.userId, credit, `Order ${orderId}`);
          }
        } catch (e) {
          logger.error(`Error crediting wallet for order ${orderId}: ${e.message}`);
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

    let transactions = [];
    try {
      transactions = await fetchGmailTransactions(user.fampay.email, rawPassword, 20);
    } catch (imapErr) {
      logger.warn(`Direct IMAP failed in checkUtrForOrder, trying HTTP fallback: ${imapErr.message}`);
      try {
        const response = await axios.post(HISTORY_API_URL, {
          email: user.fampay.email,
          pass: rawPassword,
          limit: 20
        }, { httpsAgent, timeout: 15000 });
        if (response.data && response.data.status) {
          transactions = response.data.data || [];
        }
      } catch (httpErr) {
        logger.error(`HTTP fallback also failed in checkUtrForOrder: ${httpErr.message}`);
      }
    }

    if (!transactions.length) return false;
    const paymentAmount = parseFloat(payment.amount);
    const orderCreatedAt = typeof payment.createdAt === 'number' ? payment.createdAt : Date.parse(payment.createdAt) || 0;
    const identifierTrimmed = identifier.trim();
    const identifierUpper = identifierTrimmed.toUpperCase();

    const cleanOrderId = orderId.replace(/^zpp/i, '').toLowerCase();
    const targetOrderId = orderId.toLowerCase();
    const zppTarget = `zpp${cleanOrderId}`;

    const CLOCK_SKEW_BUFFER_MS = 180000; // 3 minutes buffer

    for (const txn of transactions) {
      const txnAmount = parseFloat(txn.amount);
      const txnTime = parseTxnDatetime(txn.datetime);
      if (txnTime === null || txnAmount !== paymentAmount) continue;
      if (txnTime < orderCreatedAt - CLOCK_SKEW_BUFFER_MS) continue;

      const purposeStr = String(txn.purpose || '').toLowerCase();
      const rawStr = String(txn.rawText || txn.raw_text || '').toLowerCase();

      // Check if this transaction has the Order ID from the QR transaction note
      const hasOrderId = (txn.purpose && txn.purpose !== 'NA' && (
                           purposeStr.includes(targetOrderId) || 
                           purposeStr.includes(cleanOrderId) || 
                           purposeStr.includes(zppTarget)
                         )) ||
                         rawStr.includes(targetOrderId) ||
                         rawStr.includes(cleanOrderId) ||
                         rawStr.includes(zppTarget);

      // Check if UTR / Txn ID matches what user entered
      const utrMatch = txn.utr && txn.utr !== 'NA' && (
        txn.utr.toUpperCase() === identifierUpper ||
        txn.utr.replace(/\D/g, '') === identifierTrimmed.replace(/\D/g, '')
      );
      const txnIdMatch = txn.txn_id && txn.txn_id !== 'NA' && (
        txn.txn_id.toUpperCase() === identifierUpper ||
        txn.txn_id.toUpperCase().includes(identifierUpper) ||
        identifierUpper.includes(txn.txn_id.toUpperCase())
      );
      const rawTextMatch = rawStr.includes(identifierTrimmed.toLowerCase());

      if (hasOrderId || utrMatch || txnIdMatch || rawTextMatch) {
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
