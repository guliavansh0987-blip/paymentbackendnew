// controllers/storeController.js - Store Portal (merchant-facing, JWT auth)
// Everything here is scoped to req.user.uid — a merchant can only ever
// read/write their OWN store settings and products through these routes.
// The public storefront (store.html) talks to storePublicController
// instead, which is read-only plus the purchase flow.
const storeService = require('../services/storeService');
const firebaseService = require('../services/firebaseService');
const walletService = require('../services/walletService');
const subscriptionService = require('../services/subscriptionService');
const zapService = require('../services/zapService');
const gatewayModeService = require('../services/gatewayModeService');
const notificationService = require('../services/notificationService');
const response = require('../helpers/response');
const logger = require('../utils/logger');

// One-time fee to unlock Customize Store + Store Settings for anyone not
// on a plan that already includes it for free (see FREE_ACCESS_PLAN_IDS).
// Fixed here, server-side, on purpose — never trust a client-sent amount
// for this, same principle subscriptionController already follows for
// plan prices.
const STORE_UNLOCK_PRICE = 29;
const FREE_ACCESS_PLAN_IDS = ['gold', 'developer'];

/**
 * True if this merchant can use Customize Store / Store Settings right
 * now — either their current plan includes it for free, or they've paid
 * the one-time unlock fee before. My Store (product management) is never
 * gated by this; only the other two Store Portal pages are.
 */
async function hasStoreAccess(uid) {
  const sub = await subscriptionService.getUserSubscription(uid);
  if (FREE_ACCESS_PLAN_IDS.includes(sub?.plan?.id)) return true;
  const settings = await storeService.getOrCreateSettings(uid);
  return !!settings.unlocked;
}

/** GET /api/store/settings */
const getSettings = async (req, res) => {
  try {
    const settings = await storeService.getOrCreateSettings(req.user.uid);
    return response.success(res, 'Store settings fetched', settings);
  } catch (err) {
    logger.error('Get store settings error:', err.message);
    return response.serverError(res, err.message);
  }
};

/**
 * PUT /api/store/settings
 * Body: { storeName?, logoUrl?, theme?, socialLinks?: {telegram,whatsapp,youtube,instagram} }
 * Every field optional — only what's sent gets changed.
 */
const updateSettings = async (req, res) => {
  try {
    const settings = await storeService.updateSettings(req.user.uid, req.body || {});
    await firebaseService.logActivity(req.user.uid, 'store_settings_updated', {});
    return response.success(res, 'Store settings updated', settings);
  } catch (err) {
    logger.error('Update store settings error:', err.message);
    return response.error(res, err.message);
  }
};

/** GET /api/store/products */
const getProducts = async (req, res) => {
  try {
    const products = await storeService.getProducts(req.user.uid);
    return response.success(res, 'Products fetched', { products });
  } catch (err) {
    logger.error('Get products error:', err.message);
    return response.serverError(res, err.message);
  }
};

/**
 * POST /api/store/products
 * Body: { imageUrl, title, description, originalPrice,        <- required
 *         discountPrice?, productLink?, screenshotUrls?[≤8] }  <- optional
 */
const createProduct = async (req, res) => {
  try {
    const product = await storeService.createProduct(req.user.uid, req.body || {});
    await firebaseService.logActivity(req.user.uid, 'store_product_created', { productId: product.id, title: product.title });
    return response.success(res, 'Product added', product, 201);
  } catch (err) {
    logger.error('Create product error:', err.message);
    return response.error(res, err.message, 400, err.validationErrors || null);
  }
};

/** PUT /api/store/products/:id — every field optional, only what's sent changes */
const updateProduct = async (req, res) => {
  try {
    const product = await storeService.updateProduct(req.user.uid, req.params.id, req.body || {});
    await firebaseService.logActivity(req.user.uid, 'store_product_updated', { productId: req.params.id });
    return response.success(res, 'Product updated', product);
  } catch (err) {
    logger.error('Update product error:', err.message);
    if (err.notFound) return response.notFound(res, 'Product not found');
    return response.error(res, err.message, 400, err.validationErrors || null);
  }
};

/** DELETE /api/store/products/:id */
const deleteProduct = async (req, res) => {
  try {
    await storeService.deleteProduct(req.user.uid, req.params.id);
    await firebaseService.logActivity(req.user.uid, 'store_product_deleted', { productId: req.params.id });
    return response.success(res, 'Product deleted');
  } catch (err) {
    logger.error('Delete product error:', err.message);
    if (err.notFound) return response.notFound(res, 'Product not found');
    return response.serverError(res, err.message);
  }
};

/** GET /api/store/access */
const getAccess = async (req, res) => {
  try {
    const hasAccess = await hasStoreAccess(req.user.uid);
    return response.success(res, 'Access checked', { hasAccess, unlockPrice: STORE_UNLOCK_PRICE });
  } catch (err) {
    logger.error('Get store access error:', err.message);
    return response.serverError(res, err.message);
  }
};

/**
 * POST /api/store/unlock/upi
 * Creates a real Zap UPI order for the flat unlock fee. Deliberately
 * ALWAYS real money regardless of the merchant's own Gateway Mode — that
 * toggle exists to sandbox COLLECTING FROM customers, not to let a
 * merchant fake-pay their own platform fee, same reasoning
 * subscription/wallet-topup purchases already follow.
 */
const initiateUnlockUpi = async (req, res) => {
  try {
    const uid = req.user.uid;
    if (await hasStoreAccess(uid)) return response.error(res, 'Your store is already unlocked.');

    const orderId = zapService.generateOrderId(uid);
    const settings = await firebaseService.getSettings();
    let isSystemCashier = false;
    let sysAdminUser = null;
    if (settings.systemRoutingMode === 'self' && settings.systemRoutingAdminUid) {
      sysAdminUser = await firebaseService.getUser(settings.systemRoutingAdminUid);
      if (sysAdminUser && sysAdminUser.fampay && sysAdminUser.fampay.isConnected) isSystemCashier = true;
    }

    await firebaseService.createPayment(orderId, {
      userId: uid,
      amount: STORE_UNLOCK_PRICE,
      remark: 'ZetPay Store Unlock (One-Time)',
      type: 'store_unlock',
      routingEngine: isSystemCashier ? 'system_cashier' : 'wallet',
      paymentMethod: isSystemCashier ? 'fampay' : 'zapupi',
      cashierUpiId: isSystemCashier ? sysAdminUser.fampay.upiId : null,
      fampayVerifyUid: isSystemCashier ? sysAdminUser.uid : null
    });

    // Land back on Store Portal specifically (not the generic dashboard
    // default) with a flag index.html's own JS checks for on load to
    // show the same premium unlock celebration the wallet-pay path shows
    // immediately — the webhook will have already confirmed and unlocked
    // by the time a real UPI redirect completes.
    const DASH = gatewayModeService.getFrontendBase();

    if (isSystemCashier) {
        const safeRedirect = `${DASH}/index.html?storeUnlock=success&order=${orderId}`;
        const checkoutUrl = `https://zetpay.online/checkout.html?order_id=${orderId}&amount=${STORE_UNLOCK_PRICE}&upi=${encodeURIComponent(sysAdminUser.fampay.upiId)}&redirect_url=${encodeURIComponent(safeRedirect)}`;
        logger.info(`Store unlock order created (System Cashier): ${orderId}`);
        return response.success(res, 'Payment order created', {
            orderId: orderId,
            paymentUrl: checkoutUrl,
            amount: STORE_UNLOCK_PRICE,
        });
    }

    const zapOrder = await zapService.createOrder({
      orderId,
      amount: String(STORE_UNLOCK_PRICE.toFixed(2)),
      remark: 'ZetPay Store Unlock',
      successUrl: `${DASH}/index.html?storeUnlock=success&order=${orderId}`,
      failedUrl:  `${DASH}/index.html?storeUnlock=failed&order=${orderId}`,
      timeoutUrl: `${DASH}/index.html?storeUnlock=failed&order=${orderId}`,
    });

    logger.info(`Store unlock order created: ${orderId} by user ${uid}`);
    return response.success(res, 'Payment order created', {
      orderId: zapOrder.orderId,
      paymentUrl: zapOrder.paymentUrl,
      amount: STORE_UNLOCK_PRICE,
    });
  } catch (err) {
    logger.error('Initiate store unlock (UPI) error:', err.message);
    return response.serverError(res, err.message);
  }
};

/**
 * POST /api/store/unlock/wallet
 * Instant unlock straight from wallet balance — same "debit now, mark
 * order Success immediately, no webhook needed" pattern
 * purchasePlanWithWallet already uses for plan upgrades.
 */
const unlockViaWallet = async (req, res) => {
  try {
    const uid = req.user.uid;
    if (await hasStoreAccess(uid)) return response.error(res, 'Your store is already unlocked.');

    const balance = await walletService.getBalance(uid);
    if (balance < STORE_UNLOCK_PRICE) {
      return response.error(res, `Insufficient wallet balance. You need ₹${STORE_UNLOCK_PRICE}, available: ₹${balance.toFixed(2)}`);
    }

    try {
      await walletService.debitWallet(uid, STORE_UNLOCK_PRICE, 'Store Unlock (One-Time)');
    } catch (debitErr) {
      if (debitErr.message === 'INSUFFICIENT_BALANCE') return response.error(res, 'Insufficient wallet balance.');
      throw debitErr;
    }

    await storeService.setUnlocked(uid, true);

    const orderId = zapService.generateOrderId(uid);
    await firebaseService.createPayment(orderId, {
      userId: uid,
      amount: STORE_UNLOCK_PRICE,
      remark: 'ZetPay Store Unlock (Wallet)',
      type: 'store_unlock',
    });
    await firebaseService.updatePaymentStatus(orderId, {
      status: 'Success', txn_id: 'WALLET', utr: '', amount: STORE_UNLOCK_PRICE, pay_amount: STORE_UNLOCK_PRICE,
    });

    await notificationService.createNotification(uid, {
      title: '🎉 Store Unlocked!',
      message: 'Your ZetPay Store is now unlocked — customize it and start selling!',
      type: 'general',
    });
    await firebaseService.logActivity(uid, 'STORE_UNLOCKED_WALLET', { amount: STORE_UNLOCK_PRICE });

    logger.info(`Store unlocked via wallet: ${uid}`);
    return response.success(res, 'Store unlocked!', { unlocked: true });
  } catch (err) {
    logger.error('Unlock store via wallet error:', err.message);
    return response.serverError(res, err.message);
  }
};

module.exports = {
  getSettings,
  updateSettings,
  getProducts,
  createProduct,
  updateProduct,
  deleteProduct,
  getAccess,
  initiateUnlockUpi,
  unlockViaWallet,
};
