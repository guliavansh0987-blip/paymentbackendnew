// routes/gatewayTest.js - Gateway Test Mode simulator (backs test.html)
//
// Public, unauthenticated — same pattern as routes/paymentLink.js's public
// endpoints. Every handler is scoped to isTest === true orders only, so
// there's nothing sensitive-by-guessing-an-orderId here beyond what
// pay.html already exposes for any order (amount/title/merchant name).
const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/gatewayTestController');
const { paymentLimiter } = require('../middleware/rateLimiter');

router.get('/:orderId', ctrl.getTestOrder);
router.post('/:orderId/simulate', paymentLimiter, ctrl.simulateResult);

module.exports = router;
