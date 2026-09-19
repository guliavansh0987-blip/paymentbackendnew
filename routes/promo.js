// routes/promo.js
const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/promoController');
const { authenticate, blockIfBanned } = require('../middleware/auth');
const { paymentLimiter } = require('../middleware/rateLimiter');

router.use(authenticate, blockIfBanned);

router.post('/apply', paymentLimiter, ctrl.applyPromoValidation, ctrl.applyPromo);

module.exports = router;
