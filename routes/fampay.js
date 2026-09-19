// routes/fampay.js
const express = require('express');
const router = express.Router();
const fampayController = require('../controllers/fampayController');
const { authenticate, blockIfBanned } = require('../middleware/auth');

// Multi-account endpoints
router.get('/accounts', authenticate, blockIfBanned, fampayController.getFampayAccounts);
router.post('/accounts/add', authenticate, blockIfBanned, fampayController.addFampayAccountBasic);
router.post('/accounts/verify', authenticate, blockIfBanned, fampayController.verifyFampayAccount);
router.post('/accounts/activate', authenticate, blockIfBanned, fampayController.setActiveFampayAccount);
router.post('/accounts/remove', authenticate, blockIfBanned, fampayController.removeFampayAccount);

// Legacy single-account endpoints (kept for rolling-deploy safety)
router.get('/status', authenticate, blockIfBanned, fampayController.getFampayStatus);
router.post('/disconnect', authenticate, blockIfBanned, fampayController.disconnectFampay);

// Live email history fetch karne ke liye naya route
router.get('/history', authenticate, blockIfBanned, fampayController.getHistory);

module.exports = router;
