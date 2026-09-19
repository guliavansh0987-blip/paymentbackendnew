const express = require('express');
const router = express.Router();
const { processIncomingSms, verifyManualUtr, confirmCheckoutPaid } = require('../controllers/smsWebhookController');

router.post('/webhook', processIncomingSms);
router.post('/verify-manual', verifyManualUtr); // <--- Add this line
router.post('/confirm-paid', confirmCheckoutPaid); // checkout.html -> trusted write, no re-check

module.exports = router;
