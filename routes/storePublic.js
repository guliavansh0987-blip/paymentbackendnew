// routes/storePublic.js - Store Portal (public, no auth) — powers store.html
const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/storePublicController');
const { paymentLimiter } = require('../middleware/rateLimiter');

router.get('/order/:orderId/status', ctrl.getOrderStatus);
router.get('/:storeId/product/:productId', ctrl.getProductPublic);
router.post('/:storeId/product/:productId/purchase', paymentLimiter, ctrl.initiatePurchase);
router.get('/:storeId', ctrl.getStorePublic);

module.exports = router;
