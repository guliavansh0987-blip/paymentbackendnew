// services/zapService.js - Zap UPI Gateway API Service
// CRITICAL: This file must NEVER be exposed to frontend
const axios = require('axios');
const logger = require('../utils/logger');

const ZAP_API_URL = process.env.ZAP_API_URL || 'https://pay.zapupi.com/api';
const ZAP_KEY = process.env.ZAP_KEY;

// FRONTEND_URL may now hold a comma-separated list (server.js's CORS
// allowlist splits on ',' to support multiple live domains during a
// domain migration, e.g. "https://zetpay.online,https://zetpay.online").
// The default redirect URLs below need a SINGLE origin, not the raw
// comma-joined value — take the first one, which should be the current
// primary/production domain.
const PRIMARY_FRONTEND_URL = (process.env.FRONTEND_URL || '').split(',')[0].trim().replace(/\/+$/, '');

/**
 * Sanitize remark for Zap UPI gateway.
 * UPI/payment gateways reject remarks containing emoji or non-ASCII
 * characters (e.g. plan names like "🥉 Bronze" cause "Invalid Remark").
 * Strips everything except letters, numbers, spaces and basic punctuation,
 * collapses whitespace, and falls back to a safe default if empty.
 */
function sanitizeRemark(text) {
  if (!text) return 'ZetPay Payment';
  const cleaned = String(text)
    .replace(/[^\x20-\x7E]/g, '')      // strip emoji & all non-ASCII chars
    .replace(/[^a-zA-Z0-9 .,\-_|:]/g, '') // keep only safe punctuation — NOT parentheses: the
                                           // gateway rejects any remark containing them with
                                           // "Invalid Remark", confirmed by comparing against
                                           // remarks that succeed (e.g. "Wallet Recharge - User
                                           // ID: 2", "Testing") vs ones that failed, which all
                                           // had a "(...)" segment
    .replace(/\s+/g, ' ')
    .trim();
  return (cleaned || 'ZetPay Payment').slice(0, 50);
}

/**
 * Create a payment order with Zap UPI
 * @param {Object} params
 * @param {string} params.orderId - Unique order ID
 * @param {string} params.amount - Amount in INR
 * @param {string} [params.customerMobile] - Optional customer mobile
 * @param {string} [params.remark] - Optional remark
 */
async function createOrder({ orderId, amount, customerMobile, remark, successUrl, failedUrl, timeoutUrl, omitRedirectUrls }) {
  if (!ZAP_KEY) {
    throw new Error('ZAP_KEY not configured');
  }

  const payload = {
    zap_key: ZAP_KEY,
    order_id: orderId,
    amount: String(amount),
    remark: sanitizeRemark(remark),
  };

  // When the order will be opened via ZapUPI's single-html-web-kit.js
  // (embedded overlay + onSuccess/onFailed/onTimeout JS callbacks), the
  // SDK manages redirect detection internally — adding our own
  // success_url/failed_url/timeout_url here would conflict with that.
  if (!omitRedirectUrls) {
    payload.success_url = successUrl || `${PRIMARY_FRONTEND_URL}/index.html?payment=success&order=${orderId}`;
    payload.failed_url  = failedUrl  || `${PRIMARY_FRONTEND_URL}/index.html?payment=failed&order=${orderId}`;
    payload.timeout_url = timeoutUrl || `${PRIMARY_FRONTEND_URL}/index.html?payment=failed&order=${orderId}`;
  }

  // Add optional fields
  if (customerMobile) payload.customer_mobile = customerMobile;

  // Add webhook URL if configured
  if (process.env.WEBHOOK_URL) {
    payload.webhook_url = process.env.WEBHOOK_URL;
  }

  logger.info(`Creating Zap order: ${orderId}, Amount: ₹${amount}, Remark: ${payload.remark}`);

  const response = await axios.post(`${ZAP_API_URL}/create-order`, payload, {
    timeout: 15000,
    headers: { 'Content-Type': 'application/json' },
  });

  const data = response.data;

  if (data.status !== 'success' && !data.payment_url) {
    throw new Error(data.message || 'Failed to create payment order');
  }

  return {
    paymentUrl: data.payment_url,
    orderId: data.order_id || orderId,
    status: data.status,
  };
}

/**
 * Check order payment status
 * @param {string} orderId - Order ID to check
 * Per official ZapUPI docs, the response is FLAT and 'status' here is the
 * actual payment status: "Pending" | "Success" | "Failed" — NOT a lowercase
 * API-call-wrapper status like create-order's 'status' field. Treating it
 * like the create-order response was a bug — it made this function throw
 * on every call except a real (rare) literal 'success' string, silently
 * breaking the webhook's server-side double-verification.
 */
async function getOrderStatus(orderId) {
  if (!ZAP_KEY) {
    throw new Error('ZAP_KEY not configured');
  }

  const response = await axios.post(
    `${ZAP_API_URL}/order-status`,
    { zap_key: ZAP_KEY, order_id: orderId },
    { timeout: 15000, headers: { 'Content-Type': 'application/json' } }
  );

  // { status: 'Pending'|'Success'|'Failed', amount, pay_amount, txn_id, utr, environment }
  return response.data;
}

/**
 * Generate a unique order ID
 */
function generateOrderId(userId) {
  const timestamp = Date.now();
  const suffix = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `ZP${timestamp}${suffix}`;
}

module.exports = {
  createOrder,
  getOrderStatus,
  generateOrderId,
};
