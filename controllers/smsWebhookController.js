// controllers/smsWebhookController.js
const { ref } = require('../firebase/admin');
const { DB_PATHS } = require('../config/constants');
const firebaseService = require('../services/firebaseService');
const walletService = require('../services/walletService');
const fampayService = require('../services/fampayService');
const notificationService = require('../services/notificationService');
const logger = require('../utils/logger');

async function notifyVerifiedOrder(order, orderId, amount) {
  let title = '💰 Payment Received';
  let message = `₹${amount} credited to your wallet. Order: ${orderId}`;
  if (order.storeId && order.productId) {
    try {
      const productSnap = await ref(`${DB_PATHS.STORES}/${order.userId}/products/${order.productId}`).once('value');
      const productData = productSnap.val();
      if (productData) {
        title = '🛍️ Product Sold!';
        message = `"${productData.title || 'Product'}" sold for ₹${amount}. Order: ${orderId}`;
        await ref(`${DB_PATHS.STORES}/${order.userId}/products/${order.productId}`).update({
          salesCount: (productData.salesCount || 0) + 1,
          totalCollected: (productData.totalCollected || 0) + amount,
          lastSoldAt: Date.now(),
        });
      }
    } catch (e) {
      logger.warn(`Product stats update failed for ${orderId}: ${e.message}`);
    }
  } else if (order.linkId) {
    title = '💰 Payment Received via Link';
    message = `₹${amount} credited to your wallet. Order: ${orderId}`;
  }
  await notificationService.createNotification(order.userId, { title, message, type: 'payment' });
}

const processIncomingSms = async (req, res) => {
  try {
    const { secret, orderId, utr, status } = req.body;

    if (secret !== process.env.SMS_WEBHOOK_SECRET) {
      return res.status(401).json({ success: false, message: 'Unauthorized webhook secret' });
    }

    if (!orderId) {
      return res.status(400).json({ success: false, message: 'Order ID is required' });
    }

    const orderSnap = await ref(`${DB_PATHS.PAYMENTS}/${orderId}`).once('value');
    if (!orderSnap.exists()) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    const targetOrder = orderSnap.val();
    if (targetOrder.status === 'success') {
      return res.status(200).json({ success: true, message: 'Order already processed' });
    }

    await firebaseService.markOrderProcessed(orderId, 'Success');
    await firebaseService.updatePaymentStatus(orderId, { 
      status: 'Success', 
      txn_id: utr || 'ONLINE_VERIFIED', 
      utr: utr || 'ONLINE_VERIFIED',
      environment: 'direct_online_webhook'
    });

    const subSnap = await ref(`${DB_PATHS.USER_SUBSCRIPTIONS}/${targetOrder.userId}`).once('value');
    const plan = subSnap.val()?.plan || { walletLimit: 500 };
    const balance = await walletService.getBalance(targetOrder.userId);
    const available = plan.walletLimit - balance;

    if (targetOrder.routingEngine !== 'cashier' && targetOrder.routingEngine !== 'system_cashier') {
      const credit = Math.min(targetOrder.amount, available);
      if (credit > 0) {
        await walletService.creditWallet(targetOrder.userId, credit, `Online Gateway Order ${orderId}`);
      }
    }

    const commissionPct = targetOrder.commissionPercent ?? plan.commissionPercent ?? 5;
    const creditCost = Math.round((targetOrder.amount * commissionPct) / 100 * 100) / 100;
    if (creditCost > 0) {
      try {
        await walletService.debitZapCredit(targetOrder.userId, creditCost, `Commission for Order ${orderId}`);
      } catch (e) {
        logger.error(`Zap Credit debit failed for already-verified order ${orderId}: ${e.message}`);
      }
    }

    await notifyVerifiedOrder(targetOrder, orderId, targetOrder.amount);

    logger.info(`Online Verification Success: Order ${orderId}`);
    return res.status(200).json({ success: true, message: 'Payment verified successfully' });

  } catch (error) {
    logger.error(`Webhook Error: ${error.message}`);
    return res.status(500).json({ success: false, message: 'Internal Server Error' });
  }
};

const verifyManualUtr = async (req, res) => {
  try {
    const { orderId, utr } = req.body;

    if (!orderId || !utr || utr.length < 5) {
      return res.status(400).json({ success: false, message: 'Valid Order ID and UTR/Txn ID are required' });
    }

    const orderSnap = await ref(`${DB_PATHS.PAYMENTS}/${orderId}`).once('value');
    if (!orderSnap.exists()) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    const targetOrder = orderSnap.val();
    if (targetOrder.status === 'success') {
      return res.status(200).json({ success: true, message: 'Already verified' });
    }

    const allPaymentsSnap = await ref(DB_PATHS.PAYMENTS)
      .orderByChild('utr')
      .equalTo(utr.trim())
      .once('value');
    if (allPaymentsSnap.exists()) {
      let used = false;
      allPaymentsSnap.forEach(child => {
        const p = child.val();
        if (p.status === 'success' && p.utr === utr.trim()) used = true;
      });
      if (used) {
        return res.status(400).json({ success: false, message: 'This UTR/Txn ID has already been used for another order.' });
      }
    }

    const verified = await fampayService.checkUtrForOrder(orderId, utr.trim());

    if (!verified) {
      return res.status(400).json({ success: false, message: 'Payment not found with this UTR/Txn ID. Please check and try again.' });
    }

    await firebaseService.markOrderProcessed(orderId, 'Success');
    await firebaseService.updatePaymentStatus(orderId, { 
      status: 'Success', 
      txn_id: utr.trim(), 
      utr: utr.trim(),
      environment: 'manual_fallback'
    });

    const subSnap = await ref(`${DB_PATHS.USER_SUBSCRIPTIONS}/${targetOrder.userId}`).once('value');
    const plan = subSnap.val()?.plan || { walletLimit: 500 };
    const balance = await walletService.getBalance(targetOrder.userId);
    const available = plan.walletLimit - balance;
    
    if (targetOrder.routingEngine !== 'cashier' && targetOrder.routingEngine !== 'system_cashier') {
      const credit = Math.min(targetOrder.amount, available);
      if (credit > 0) {
        await walletService.creditWallet(targetOrder.userId, credit, `Manual Verify Order ${orderId}`);
      }
    }

    const commissionPct = targetOrder.commissionPercent ?? plan.commissionPercent ?? 5;
    const creditCost = Math.round((targetOrder.amount * commissionPct) / 100 * 100) / 100;
    if (creditCost > 0) {
      try {
        await walletService.debitZapCredit(targetOrder.userId, creditCost, `Commission for Order ${orderId}`);
      } catch (e) {
        logger.error(`Zap Credit debit failed for already-verified order ${orderId}: ${e.message}`);
      }
    }

    await notifyVerifiedOrder(targetOrder, orderId, targetOrder.amount);

    logger.info(`Manual verification success: Order ${orderId}, ID: ${utr}`);
    return res.status(200).json({ success: true, message: 'Verified successfully!' });

  } catch (error) {
    logger.error('Manual verification error:', error.message);
    return res.status(500).json({ success: false, message: 'Internal Server Error' });
  }
};

/**
 * Confirm a payment that checkout.html has ALREADY verified against the
 * live mailbox itself (via verify_status.php), for the system_cashier
 * flow where checkUtrForOrder's per-merchant FamPay lookup doesn't apply
 * (system_cashier orders aren't tied to one user's connected mailbox).
 * This performs the exact same DB write / wallet credit / commission /
 * notification steps as verifyManualUtr — it just skips re-querying the
 * mailbox a second time, since checkout.html already did that check and
 * is reporting a confirmed result, not a user-typed guess.
 */
const confirmCheckoutPaid = async (req, res) => {
  try {
    const { orderId, utr } = req.body;

    if (!orderId || !utr || String(utr).length < 3) {
      return res.status(400).json({ success: false, message: 'Valid Order ID and UTR/Txn ID are required' });
    }

    const orderSnap = await ref(`${DB_PATHS.PAYMENTS}/${orderId}`).once('value');
    if (!orderSnap.exists()) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    const targetOrder = orderSnap.val();
    if (targetOrder.status === 'success') {
      return res.status(200).json({ success: true, message: 'Already verified' });
    }

    const utrTrimmed = String(utr).trim();

    const allPaymentsSnap = await ref(DB_PATHS.PAYMENTS)
      .orderByChild('utr')
      .equalTo(utrTrimmed)
      .once('value');
    if (allPaymentsSnap.exists()) {
      let used = false;
      allPaymentsSnap.forEach(child => {
        const p = child.val();
        if (p.status === 'success' && p.utr === utrTrimmed) used = true;
      });
      if (used) {
        return res.status(400).json({ success: false, message: 'This UTR/Txn ID has already been used for another order.' });
      }
    }

    await firebaseService.markOrderProcessed(orderId, 'Success');
    await firebaseService.updatePaymentStatus(orderId, {
      status: 'Success',
      txn_id: utrTrimmed,
      utr: utrTrimmed,
      environment: 'checkout_confirmed'
    });

    const subSnap = await ref(`${DB_PATHS.USER_SUBSCRIPTIONS}/${targetOrder.userId}`).once('value');
    const plan = subSnap.val()?.plan || { walletLimit: 500 };
    const balance = await walletService.getBalance(targetOrder.userId);
    const available = plan.walletLimit - balance;

    if (targetOrder.routingEngine !== 'cashier' && targetOrder.routingEngine !== 'system_cashier') {
      const credit = Math.min(targetOrder.amount, available);
      if (credit > 0) {
        await walletService.creditWallet(targetOrder.userId, credit, `Checkout Confirmed Order ${orderId}`);
      }
    }

    const commissionPct = targetOrder.commissionPercent ?? plan.commissionPercent ?? 5;
    const creditCost = Math.round((targetOrder.amount * commissionPct) / 100 * 100) / 100;
    if (creditCost > 0) {
      try {
        await walletService.debitZapCredit(targetOrder.userId, creditCost, `Commission for Order ${orderId}`);
      } catch (e) {
        logger.error(`Zap Credit debit failed for checkout-confirmed order ${orderId}: ${e.message}`);
      }
    }

    await notifyVerifiedOrder(targetOrder, orderId, targetOrder.amount);

    logger.info(`Checkout-confirmed payment: Order ${orderId}, UTR: ${utrTrimmed}`);
    return res.status(200).json({ success: true, message: 'Order confirmed', order_id: orderId, status: 'success' });

  } catch (error) {
    logger.error('Confirm checkout paid error:', error.message);
    return res.status(500).json({ success: false, message: 'Internal Server Error' });
  }
};

module.exports = { processIncomingSms, verifyManualUtr, confirmCheckoutPaid };
