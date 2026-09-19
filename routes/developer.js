// routes/developer.js - Developer Portal / ZapAPI
const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/developerController');
const webhookCtrl = require('../controllers/webhookController');
const { authenticate, blockIfBanned, blockIfImpersonating } = require('../middleware/auth');
const { authenticateApiKey } = require('../middleware/apiKeyAuth');
const { apiKeyLimiter, cancelOrderLimiter } = require('../middleware/rateLimiter');
const { requireAdmin } = require('../middleware/adminAuth'); // Added for check-order security

// Dashboard-authenticated (JWT) — Developer Portal -> Zap API page
router.get('/token', authenticate, blockIfBanned, ctrl.getMyToken);
router.post('/token/regenerate', authenticate, blockIfBanned, ctrl.regenerateMyToken);

// Gateway Test/Live mode toggle & Routing
router.get('/mode', authenticate, blockIfBanned, ctrl.getMode);
router.post('/mode', authenticate, blockIfBanned, blockIfImpersonating, ctrl.setMode);
router.post('/routing', authenticate, blockIfBanned, blockIfImpersonating, ctrl.setRoutingEngine);

// Webhook URLs
router.get('/webhooks', authenticate, blockIfBanned, webhookCtrl.listWebhooks);
router.post('/webhooks', authenticate, blockIfBanned, blockIfImpersonating, webhookCtrl.addWebhookValidation, webhookCtrl.addWebhook);
router.delete('/webhooks/:webhookId', authenticate, blockIfBanned, blockIfImpersonating, webhookCtrl.deleteWebhook);
router.put('/webhooks/:webhookId/toggle', authenticate, blockIfBanned, blockIfImpersonating, webhookCtrl.toggleWebhook);

// ZapAPI-key authenticated
router.post('/create-order', apiKeyLimiter, authenticateApiKey, ctrl.createOrderValidation, ctrl.createOrder);
router.get('/order-status/:orderId', apiKeyLimiter, authenticateApiKey, ctrl.getOrderStatus);

// Public Order Status for Checkout.html (No Auth Required - Auto Verify Throttled)
router.get('/public-order-status/:orderId', ctrl.getPublicOrderStatus);

// Cancel Order from Checkout.html (No Auth Required - IP Rate Limited)
router.post('/cancel-order', cancelOrderLimiter, ctrl.cancelOrder);

// Manual UTR / Txn ID Verification from Checkout page (No Auth Required)
router.post('/verify-utr', ctrl.verifyUtr);

// Full JSON Order Check (Admin/Debug Only)
router.get('/check-order/:orderId', authenticate, blockIfBanned, requireAdmin, ctrl.checkFullOrderJson);

module.exports = router;
