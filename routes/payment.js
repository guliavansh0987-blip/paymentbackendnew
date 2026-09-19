// routes/payment.js
const express = require('express');
const router = express.Router();
const { createOrder, getPaymentStatus, getPaymentHistory, createOrderValidation } = require('../controllers/paymentController');
const { authenticate, blockIfBanned } = require('../middleware/auth');
const { paymentLimiter } = require('../middleware/rateLimiter');

router.use(authenticate, blockIfBanned);

router.post('/create-order', paymentLimiter, createOrderValidation, createOrder);
router.get('/status/:orderId', getPaymentStatus);
router.get('/history', getPaymentHistory);

module.exports = router;
