// routes/paytm.js
const express = require('express');
const router = express.Router();
const paytmController = require('../controllers/paytmController');
const { authenticate, blockIfBanned } = require('../middleware/auth');

// Multi-account endpoints
router.get('/accounts', authenticate, blockIfBanned, paytmController.getPaytmAccounts);
router.post('/accounts/add', authenticate, blockIfBanned, paytmController.addPaytmAccountBasic);
router.post('/accounts/verify', authenticate, blockIfBanned, paytmController.verifyPaytmAccount);
router.post('/accounts/activate', authenticate, blockIfBanned, paytmController.setActivePaytmAccount);
router.post('/accounts/remove', authenticate, blockIfBanned, paytmController.removePaytmAccount);

// Legacy single-account endpoints (kept for rolling-deploy safety)
router.get('/status', authenticate, blockIfBanned, paytmController.getPaytmStatus);
router.post('/disconnect', authenticate, blockIfBanned, paytmController.disconnectPaytm);

module.exports = router;
