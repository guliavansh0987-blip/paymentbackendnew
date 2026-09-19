// routes/wallet.js
const express = require('express');
const router = express.Router();
const { authenticate, blockIfBanned } = require('../middleware/auth');
const walletService = require('../services/walletService');
const response = require('../helpers/response');

router.use(authenticate, blockIfBanned);

router.get('/balance', async (req, res) => {
  try {
    const [balance, bonusBalance, overBalance, zapCredit] = await Promise.all([
      walletService.getBalance(req.user.uid),
      walletService.getBonusBalance(req.user.uid),
      walletService.getOverBalance(req.user.uid),
      walletService.getZapCredit(req.user.uid),
    ]);
    return response.success(res, 'Balance fetched', { balance, bonusBalance, overBalance, zapCredit });
  } catch (err) {
    return response.serverError(res, err.message);
  }
});

/**
 * POST /api/wallet/convert-to-credit
 * Move money from Zap Cash into Zap Credit, 1:1, no commission — this is
 * the merchant moving their own money internally, not a customer order.
 * Body: { amount }
 */
router.post('/convert-to-credit', async (req, res) => {
  try {
    const amount = parseFloat(req.body.amount);
    if (!amount || amount <= 0) {
      return response.error(res, 'Enter a valid amount greater than ₹0');
    }

    const firebaseService = require('../services/firebaseService');
    const settings = await firebaseService.getSettings();
    const minPurchase = settings.minZapCreditPurchase || 50;
    if (amount < minPurchase) {
      return response.error(res, `Minimum Zap Credit top-up is ₹${minPurchase}.`);
    }

    const balance = await walletService.getBalance(req.user.uid);
    if (balance < amount) {
      return response.error(res, `Insufficient Zap Cash. Available: ₹${balance.toFixed(2)}`);
    }

    await walletService.debitWallet(req.user.uid, amount, 'Converted to Zap Credit');
    const newCredit = await walletService.creditZapCredit(req.user.uid, amount, 'Converted from Zap Cash');
    const newBalance = await walletService.getBalance(req.user.uid);

    return response.success(res, 'Converted to Zap Credit', { zapCredit: newCredit, balance: newBalance });
  } catch (err) {
    if (err.message === 'INSUFFICIENT_BALANCE') {
      return response.error(res, 'Insufficient Zap Cash balance.');
    }
    return response.serverError(res, err.message);
  }
});

module.exports = router;
