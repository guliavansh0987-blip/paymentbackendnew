// routes/store.js - Store Portal (merchant-facing, JWT auth)
const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/storeController');
const { authenticate, blockIfBanned } = require('../middleware/auth');
const { paymentLimiter } = require('../middleware/rateLimiter');

router.use(authenticate, blockIfBanned);

router.get('/settings', ctrl.getSettings);
router.put('/settings', ctrl.updateSettings);

router.get('/products', ctrl.getProducts);
router.post('/products', paymentLimiter, ctrl.createProduct);
router.put('/products/:id', ctrl.updateProduct);
router.delete('/products/:id', ctrl.deleteProduct);

router.get('/access', ctrl.getAccess);
router.post('/unlock/upi', paymentLimiter, ctrl.initiateUnlockUpi);
router.post('/unlock/wallet', paymentLimiter, ctrl.unlockViaWallet);

module.exports = router;
