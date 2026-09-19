// routes/paymentLink.js
const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/paymentLinkController');
const { authenticate, blockIfBanned } = require('../middleware/auth');
const { paymentLimiter } = require('../middleware/rateLimiter');

// Public
router.get('/:linkId/public', ctrl.getLinkPublic);
router.get('/order/:orderId/status', ctrl.getLinkOrderStatus);
router.post('/:linkId/initiate', paymentLimiter, ctrl.initiatePayment);

// Authenticated (merchant)
router.post('/create', authenticate, blockIfBanned, paymentLimiter, ctrl.createLinkValidation, ctrl.createPaymentLink);
router.get('/list', authenticate, blockIfBanned, ctrl.getUserLinks);
router.put('/:linkId/disable', authenticate, blockIfBanned, ctrl.disableLink);
router.put('/:linkId/enable', authenticate, blockIfBanned, ctrl.enableLink);
router.put('/:linkId/edit', authenticate, blockIfBanned, ctrl.editLinkValidation, ctrl.editPaymentLink);
router.delete('/:linkId', authenticate, blockIfBanned, ctrl.deletePaymentLink);

module.exports = router;
