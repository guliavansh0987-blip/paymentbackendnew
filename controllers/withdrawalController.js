// controllers/withdrawalController.js - Withdrawal Controller
const { body, validationResult } = require('express-validator');
const firebaseService = require('../services/firebaseService');
const walletService = require('../services/walletService');
const notificationService = require('../services/notificationService');
const response = require('../helpers/response');
const logger = require('../utils/logger');
const subscriptionService = require('../services/subscriptionService');

const UPI_RE  = /^[\w.-]+@[\w.-]+$/;
const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const ACC_RE  = /^\d{9,18}$/;

/**
 * POST /api/withdrawal/request
 * Submit a withdrawal request. Supports two methods:
 *   method = 'upi'  -> requires upiId, upiHolderName
 *   method = 'bank' -> requires accountNumber, ifscCode, accountHolderName
 * (defaults to 'upi' if not provided, for backward compatibility)
 */
const requestWithdrawal = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return response.error(res, 'Validation failed', 400, errors.array());
    }

    const userId = req.user.uid;
    const method = req.body.method === 'bank' ? 'bank' : 'upi';
    // 'amount' is the NET amount the user wants to actually receive in hand.
    const netAmount = parseFloat(req.body.amount);

    // Per-method field validation. Kept here (rather than as a rigid
    // declarative express-validator chain) since which fields are required
    // depends on the chosen method.
    let upiId = '', upiHolderName = '', accountNumber = '', ifscCode = '', accountHolderName = '';
    if (method === 'upi') {
      upiId = (req.body.upiId || '').trim();
      upiHolderName = (req.body.upiHolderName || '').trim();
      if (!upiId || !UPI_RE.test(upiId)) {
        return response.error(res, 'Please enter a valid UPI ID (e.g. name@bank)');
      }
      if (!upiHolderName) {
        return response.error(res, 'Please enter the UPI holder name');
      }
    } else {
      accountNumber = (req.body.accountNumber || '').replace(/\s+/g, '');
      ifscCode = (req.body.ifscCode || '').trim().toUpperCase();
      accountHolderName = (req.body.accountHolderName || '').trim();
      if (!ACC_RE.test(accountNumber)) {
        return response.error(res, 'Please enter a valid account number (9-18 digits)');
      }
      if (!IFSC_RE.test(ifscCode)) {
        return response.error(res, 'Please enter a valid IFSC code (e.g. HDFC0001234)');
      }
      if (!accountHolderName) {
        return response.error(res, 'Please enter the account holder name');
      }
    }

    // Get platform settings
    const settings = await firebaseService.getSettings();
    const sub = await subscriptionService.getUserSubscription(userId);
    const plan = sub.plan;
    const minWithdrawal = settings.minWithdrawal || 100;
    const commissionPercent = plan.commissionPercent ?? settings.commissionPercent ?? 5;

    if (settings.maintenanceMode) {
      return response.error(res, 'Withdrawal system under maintenance.', 503);
    }

    // Check minimum withdrawal (this is the NET amount the user receives)
    if (netAmount < minWithdrawal) {
      return response.error(res, `Minimum withdrawal amount is ₹${minWithdrawal}`);
    }

    // Commission is added ON TOP of what the user wants — e.g. ₹100 net at
    // 5% commission requires ₹105 held from the wallet (100 + 5).
    const commission     = Math.round((netAmount * commissionPercent) / 100 * 100) / 100;
    const requiredAmount = Math.round((netAmount + commission) * 100) / 100;

    // Check wallet balance against the REQUIRED (gross) amount, not net
    const balance = await walletService.getBalance(userId);
    if (balance < requiredAmount) {
      return response.error(
        res,
        `Insufficient balance. To withdraw ₹${netAmount}, you need ₹${requiredAmount} in your wallet (₹${netAmount} + ${commissionPercent}% commission = ₹${commission}). Available: ₹${balance.toFixed(2)}`
      );
    }

    // Check for pending withdrawal (1 pending at a time)
    const existingWithdrawals = await firebaseService.getUserWithdrawals(userId);
    const hasPending = existingWithdrawals.some((w) => w.status === 'pending');
    if (hasPending) {
      return response.error(res, 'You already have a pending withdrawal request. Please wait for it to be processed.');
    }

    // Hold the REQUIRED (gross) amount from the wallet
    try {
      await walletService.debitWallet(userId, requiredAmount, `Withdrawal request`);
    } catch (debitErr) {
      if (debitErr.message === 'INSUFFICIENT_BALANCE') {
        return response.error(res, 'Insufficient balance');
      }
      throw debitErr;
    }

    // Create withdrawal record — 'amount' = held/gross, 'netAmount' = what user receives
    const withdrawalId = await firebaseService.createWithdrawal(userId, {
      amount: requiredAmount,
      commission,
      netAmount,
      method,
      upiId,
      upiHolderName,
      accountNumber,
      ifscCode,
      accountHolderName,
    });

    const methodLabel = method === 'bank' ? 'Bank Transfer' : 'UPI';
    await notificationService.createNotification(userId, {
      title: '📤 Withdrawal Request Submitted',
      message: `Your ${methodLabel} withdrawal request for ₹${netAmount} (₹${requiredAmount} held incl. ${commissionPercent}% commission) has been submitted and is under review.`,
      type: 'withdrawal',
    });

    await firebaseService.logActivity(userId, 'WITHDRAWAL_REQUEST', {
      withdrawalId,
      amount: requiredAmount,
      netAmount,
      method,
    });

    logger.info(`Withdrawal requested: ${withdrawalId} by ${userId} for ₹${netAmount} via ${method} (held ₹${requiredAmount})`);

    return response.success(res, 'Withdrawal request submitted successfully', {
      withdrawalId,
      amount: requiredAmount,
      commission,
      netAmount,
      method,
      status: 'pending',
    });

  } catch (err) {
    logger.error('Withdrawal request error:', err.message);
    return response.serverError(res, err.message);
  }
};

/**
 * GET /api/withdrawal/history
 * Get withdrawal history for current user
 */
const getWithdrawalHistory = async (req, res) => {
  try {
    const withdrawals = await firebaseService.getUserWithdrawals(req.user.uid);
    return response.success(res, 'Withdrawal history fetched', { withdrawals });
  } catch (err) {
    logger.error('Get withdrawal history error:', err.message);
    return response.serverError(res, err.message);
  }
};

const requestWithdrawalValidation = [
  body('amount')
    .notEmpty().withMessage('Amount is required')
    .isFloat({ min: 1 }).withMessage('Invalid amount'),
  body('method')
    .optional()
    .isIn(['upi', 'bank']).withMessage('Invalid withdrawal method'),
];

module.exports = {
  requestWithdrawal,
  getWithdrawalHistory,
  requestWithdrawalValidation,
};
