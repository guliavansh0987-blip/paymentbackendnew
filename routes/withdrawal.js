// routes/withdrawal.js
const express = require('express');
const router = express.Router();
const { requestWithdrawal, getWithdrawalHistory, requestWithdrawalValidation } = require('../controllers/withdrawalController');
const { authenticate, blockIfBanned, blockIfImpersonating } = require('../middleware/auth');
const { withdrawalLimiter } = require('../middleware/rateLimiter');

router.use(authenticate, blockIfBanned);

router.post('/request', blockIfImpersonating, withdrawalLimiter, requestWithdrawalValidation, requestWithdrawal);
router.get('/history', getWithdrawalHistory);

module.exports = router;
