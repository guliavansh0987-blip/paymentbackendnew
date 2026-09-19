// routes/subscription.js
const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/subscriptionController');
const { authenticate, blockIfBanned } = require('../middleware/auth');
const { paymentLimiter } = require('../middleware/rateLimiter');

router.get('/plans',    ctrl.getPlans);                          // public
router.get('/duration-options', ctrl.getDurationOptions);        // public
router.get('/my',       authenticate, blockIfBanned, ctrl.getMySubscription);   // auth
router.post('/auto-upgrade', authenticate, blockIfBanned, ctrl.setAutoUpgrade);  // auth
router.post('/purchase', authenticate, blockIfBanned, paymentLimiter, ctrl.purchasePlan); // auth
router.post('/purchase-wallet', authenticate, blockIfBanned, paymentLimiter, ctrl.purchasePlanWithWallet); // auth

module.exports = router;
