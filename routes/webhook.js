// routes/webhook.js
const express = require('express');
const router = express.Router();
const { handleZapWebhook } = require('../webhooks/zapWebhook');

// Zap UPI POSTs to this on every payment status change
// No JWT auth - Zap sends this directly
router.post('/zap', handleZapWebhook);

module.exports = router;
