// middleware/rateLimiter.js - API Rate Limiting
const rateLimit = require('express-rate-limit');
const response = require('../helpers/response');

/**
 * General API rate limiter - 100 requests per 15 minutes
 */
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    return response.error(res, 'Too many requests. Please try again later.', 429);
  },
});

/**
 * Auth rate limiter - 10 requests per 15 minutes
 */
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    return response.error(res, 'Too many login attempts. Please wait 15 minutes.', 429);
  },
});

/**
 * Payment creation limiter - 20 requests per 15 minutes
 */
const paymentLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    return response.error(res, 'Too many payment requests. Please try again later.', 429);
  },
});

/**
 * Withdrawal limiter - 5 requests per hour
 */
const withdrawalLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    return response.error(res, 'Too many withdrawal requests. Please try again later.', 429);
  },
});

/**
 * Public order-cancel limiter - 10 requests per 10 minutes per IP.
 * checkout.html's Cancel button has no auth (it's a customer-facing page),
 * so this is the only thing standing between it and someone hammering the
 * endpoint. Keyed by IP since there's no user/session here.
 */
const cancelOrderLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    return response.error(res, 'Too many cancel requests. Please try again later.', 429);
  },
});

/**
 * ZapAPI (Developer Portal) limiter - 60 requests per 15 minutes.
 * Keyed by the merchant's ZapAPI key when present (falls back to IP), so
 * one merchant's own site/app can't eat into another merchant's bucket,
 * and a busy site still can't hammer the backend unbounded.
 */
const apiKeyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.body && req.body.zap_api) || req.headers['x-zapapi-key'] || req.ip,
  handler: (req, res) => {
    return response.error(res, 'Too many API requests. Please try again later.', 429);
  },
});

/**
 * OTP send limiter - 5 requests per 10 minutes, keyed by email+IP so one
 * email address can't be spammed by a different attacker IP and vice versa.
 * Deliberately tighter than authLimiter: every hit here sends a real email
 * through the cPanel mailbox, which has its own daily sending cap.
 */
const otpSendLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `${(req.body && req.body.email || '').toLowerCase()}:${req.ip}`,
  handler: (req, res) => {
    return response.error(res, 'Too many OTP requests. Please wait a few minutes.', 429);
  },
});

/**
 * OTP verify limiter - 10 attempts per 10 minutes per email+IP, separate
 * from otpSendLimiter so a user retyping a mistyped code doesn't burn
 * their send quota, while still bounding brute-force guesses at a 6-digit code.
 */
const otpVerifyLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `${(req.body && req.body.email || '').toLowerCase()}:${req.ip}`,
  handler: (req, res) => {
    return response.error(res, 'Too many attempts. Please request a new code.', 429);
  },
});

/**
 * Agentic Support chat limiter - 20 messages per 10 minutes per signed-in
 * user (falls back to IP if req.user isn't set yet, though in practice this
 * always runs after `authenticate`). Every message here is a real, billed-
 * or-quota-consuming call to the NVIDIA API, so this exists purely for
 * cost/abuse control, not security.
 */
const agentChatLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.user && req.user.uid) || req.ip,
  handler: (req, res) => {
    return response.error(res, 'You are sending messages too quickly. Please wait a few minutes and try again.', 429);
  },
});

module.exports = {
  generalLimiter,
  authLimiter,
  paymentLimiter,
  withdrawalLimiter,
  apiKeyLimiter,
  otpSendLimiter,
  otpVerifyLimiter,
  agentChatLimiter,
  cancelOrderLimiter,
};
