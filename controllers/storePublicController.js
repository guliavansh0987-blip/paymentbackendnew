// controllers/storePublicController.js - Store Portal (public, no auth)
const { ref } = require('../firebase/admin');
const zapService = require('../services/zapService');
const firebaseService = require('../services/firebaseService');
const walletService = require('../services/walletService');
const subscriptionService = require('../services/subscriptionService');
const gatewayModeService = require('../services/gatewayModeService');
const storeService = require('../services/storeService');
const response = require('../helpers/response');
const logger = require('../utils/logger');
const { DB_PATHS } = require('../config/constants');

function publicProduct(p) {
  return {
    id: p.id,
    imageUrl: p.imageUrl,
    title: p.title,
    description: p.description,
    screenshotUrls: p.screenshotUrls || [],
    originalPrice: p.originalPrice,
    discountPrice: p.discountPrice,
    categoryId: p.categoryId || null,
  };
}

async function loadActiveMerchantStore(storeId) {
  const uid = await storeService.getUidByStoreId(storeId);
  if (!uid) return { error: 'Store not found' };

  const merchant = await firebaseService.getUser(uid);
  if (!merchant || merchant.isBanned) return { error: 'This store is no longer available.' };

  const settingsSnap = await ref(`${DB_PATHS.STORES}/${uid}/settings`).once('value');
  if (!settingsSnap.exists()) return { error: 'Store not found' };

  return { uid, merchant, settings: settingsSnap.val() };
}

const getStorePublic = async (req, res) => {
  try {
    const { storeId } = req.params;
    const { uid, settings, error } = await loadActiveMerchantStore(storeId);
    if (error) return response.notFound(res, error);

    const products = await storeService.getProducts(uid);

    return response.success(res, 'Store fetched', {
      storeId,
      storeName: settings.storeName,
      logoUrl: settings.logoUrl,
      theme: settings.theme,
      socialLinks: settings.socialLinks,
      showSortButton: settings.showSortButton || false,
      categories: settings.categories || [],
      products: products.map(publicProduct),
    });
  } catch (err) {
    logger.error('Get store public error:', err.message);
    return response.serverError(res, err.message);
  }
};

const getProductPublic = async (req, res) => {
  try {
    const { storeId, productId } = req.params;
    const { uid, settings, error } = await loadActiveMerchantStore(storeId);
    if (error) return response.notFound(res, error);

    const product = await storeService.getProduct(uid, productId);
    if (!product) return response.notFound(res, 'Product not found');

    return response.success(res, 'Product fetched', {
      storeId,
      storeName: settings.storeName,
      theme: settings.theme,
      product: publicProduct(product),
    });
  } catch (err) {
    logger.error('Get product public error:', err.message);
    return response.serverError(res, err.message);
  }
};

const initiatePurchase = async (req, res) => {
  try {
    const { storeId, productId } = req.params;
    const { customerName, customerMobile, customerEmail } = req.body;

    const { uid, error } = await loadActiveMerchantStore(storeId);
    if (error) return response.notFound(res, error);

    const product = await storeService.getProduct(uid, productId);
    if (!product) return response.notFound(res, 'Product not found');

    const amount = product.discountPrice != null && product.discountPrice > 0
      ? product.discountPrice
      : product.originalPrice;
    const orderId = zapService.generateOrderId(uid);
    const remark = `${product.title} | StoreID:${storeId} | ProductID:${productId}`;
    const gatewayMode = await gatewayModeService.getMode(uid);

    if (gatewayMode === 'test') {
      await firebaseService.createPayment(orderId, {
        userId: uid, amount, remark, customerMobile: customerMobile || '',
        customerName: customerName || '', customerEmail: customerEmail || '',
        storeId, productId, isTest: true,
      });
      return response.success(res, 'Purchase initiated (Test Mode)', {
        paymentUrl: gatewayModeService.buildTestPaymentUrl(orderId),
        orderId, amount, isTest: true,
      });
    }

    const sub = await subscriptionService.getUserSubscription(uid);
    const balance = await walletService.getBalance(uid);
    if (balance + amount > sub.plan.walletLimit) {
      return response.error(res, 'This store is temporarily unable to accept payments. Please try again shortly.');
    }

    const commissionPercent = sub.plan.commissionPercent ?? 5;
    const creditCheck = await walletService.checkSufficientCreditForOrder(uid, amount, commissionPercent);
    if (!creditCheck.ok) {
      return response.error(res, 'Insufficient Zap Credit. This store is temporarily unable to accept payments.');
    }

    const settings = await firebaseService.getSettings();
    if (settings.maintenanceMode) return response.error(res, 'Payment system under maintenance.', 503);

    const merchantUser = await firebaseService.getUser(uid);
    const isFamPay = merchantUser?.fampay?.isConnected;

    // Same live, connection-verified routing check as payment links and
    // ZapAPI orders — 'cashier' is only honored while FamPay is actually
    // connected right now, so a stale apiRoutingEngine value left over
    // from a since-disconnected FamPay account can't build a checkout
    // with no real UPI ID behind it.
    if (merchantUser?.apiRoutingEngine === 'cashier' && isFamPay) {
      await firebaseService.createPayment(orderId, {
        userId: uid, amount, remark, customerMobile: customerMobile || '', customerName: customerName || '', customerEmail: customerEmail || '', storeId, productId, commissionPercent,
        paymentMethod: 'fampay', cashierUpiId: merchantUser.fampay.upiId, routingEngine: 'cashier',
      });
      const STORE_BASE = gatewayModeService.getStoreBase();
      const redirectUrl = `${STORE_BASE}/store=${storeId}?order=${orderId}`;
      const checkoutUrl = `https://zetpay.online/checkout.html?order_id=${orderId}&amount=${amount}&upi=${encodeURIComponent(merchantUser.fampay.upiId)}&redirect_url=${encodeURIComponent(redirectUrl)}`;
      return response.success(res, 'Purchase initiated via Cashier', {
        paymentUrl: checkoutUrl, orderId, amount, isTest: false, method: 'cashier',
      });
    }

    let isSystemCashier = false;
    let sysAdminUser = null;
    if (settings.systemRoutingMode === 'self' && settings.systemRoutingAdminUid) {
      sysAdminUser = await firebaseService.getUser(settings.systemRoutingAdminUid);
      if (sysAdminUser && sysAdminUser.fampay && sysAdminUser.fampay.isConnected) isSystemCashier = true;
    }

    await firebaseService.createPayment(orderId, {
      userId: uid, amount, remark, customerMobile: customerMobile || '', customerName: customerName || '', customerEmail: customerEmail || '', storeId, productId, commissionPercent,
      routingEngine: isSystemCashier ? 'system_cashier' : 'wallet',
      paymentMethod: isSystemCashier ? 'fampay' : 'zapupi',
      cashierUpiId: isSystemCashier ? sysAdminUser.fampay.upiId : null,
      fampayVerifyUid: isSystemCashier ? sysAdminUser.uid : null
    });

    const STORE_BASE = gatewayModeService.getStoreBase();

    if (isSystemCashier) {
      const safeRedirect = `${STORE_BASE}/store=${storeId}?order=${orderId}&result=success`;
      const checkoutUrl = `https://zetpay.online/checkout.html?order_id=${orderId}&amount=${amount}&upi=${encodeURIComponent(sysAdminUser.fampay.upiId)}&redirect_url=${encodeURIComponent(safeRedirect)}`;
      return response.success(res, 'Purchase initiated via System Cashier', { paymentUrl: checkoutUrl, orderId, amount, isTest: false, method: 'system_cashier' });
    }

    const zapOrder = await zapService.createOrder({
      orderId,
      amount: String(amount.toFixed(2)),
      customerMobile: customerMobile || '',
      remark: product.title,
      successUrl: `${STORE_BASE}/store=${storeId}?order=${orderId}&result=success`,
      failedUrl:  `${STORE_BASE}/store=${storeId}?order=${orderId}&result=failed`,
      timeoutUrl: `${STORE_BASE}/store=${storeId}?order=${orderId}&result=failed`,
    });

    return response.success(res, 'Purchase initiated', {
      paymentUrl: zapOrder.paymentUrl,
      orderId, amount, isTest: false,
    });
  } catch (err) {
    logger.error('Initiate store purchase error:', err.message);
    return response.serverError(res, err.message);
  }
};

const getOrderStatus = async (req, res) => {
  try {
    const { orderId } = req.params;
    let payment = await firebaseService.getPayment(orderId);

    if (!payment || !payment.storeId) return response.notFound(res, 'Order not found');

    if (payment.status === 'pending' && payment.paymentMethod === 'fampay') {
      const fampayService = require('../services/fampayService');
      await fampayService.verifyPayment(orderId);
      const updatedPayment = await firebaseService.getPayment(orderId);
      if (updatedPayment) payment = updatedPayment;
    }

    const out = {
      orderId,
      status: payment.status,
      storeId: payment.storeId,
    };

    if (payment.status === 'success' && payment.productId) {
      const product = await storeService.getProduct(payment.userId, payment.productId);
      out.productTitle = product?.title || null;
      out.productLink = product?.productLink || '';
    }

    return response.success(res, 'Status fetched', out);
  } catch (err) {
    logger.error('Get store order status error:', err.message);
    return response.serverError(res, err.message);
  }
};

module.exports = {
  getStorePublic,
  getProductPublic,
  initiatePurchase,
  getOrderStatus,
};
