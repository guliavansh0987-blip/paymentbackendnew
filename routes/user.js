// routes/user.js
const express = require('express');
const router = express.Router();
const { authenticate, blockIfBanned, blockIfImpersonating } = require('../middleware/auth');
const firebaseService = require('../services/firebaseService');
const subscriptionService = require('../services/subscriptionService');
const response = require('../helpers/response');
const { body, validationResult } = require('express-validator');

router.use(authenticate, blockIfBanned);

// Themes that require Silver plan or above — checked server-side too, not
// just hidden in the UI, since profile updates are a direct API call.
const PREMIUM_THEMES = ['aurora', 'obsidian'];
const PREMIUM_PLAN_IDS = ['silver', 'gold', 'developer'];

// PUT /api/user/profile
router.put('/profile', blockIfImpersonating, [
  body('displayName').optional().isLength({ max: 60 }).trim().escape(),
  body('phone').optional().matches(/^\d{10}$/).withMessage('Invalid phone number'),
  body('upiId').optional().matches(/^[\w.-]+@[\w.-]+$/).withMessage('Invalid UPI ID'),
  body('upiHolderName').optional({ checkFalsy: true }).isLength({ max: 100 }).trim().escape(),
  body('bankDetails').optional().isObject().withMessage('Invalid bank details'),
  body('bankDetails.accountNumber').optional({ checkFalsy: true }).matches(/^\d{9,18}$/).withMessage('Invalid account number'),
  body('bankDetails.ifscCode').optional({ checkFalsy: true }).matches(/^[A-Z]{4}0[A-Z0-9]{6}$/i).withMessage('Invalid IFSC code'),
  body('bankDetails.accountHolderName').optional({ checkFalsy: true }).isLength({ max: 100 }).trim().escape(),
  body('checkoutTheme').optional().isIn(['default', 'nova', 'ember', 'emerald', 'aurora', 'obsidian']).withMessage('Invalid theme'),
  body('checkoutThemeColor').optional({ checkFalsy: true }).matches(/^#[0-9A-Fa-f]{6}$/).withMessage('Invalid color — use a hex code'),
  body('showOnboarding').optional().isBoolean().withMessage('Invalid value').toBoolean(),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return response.error(res, 'Validation failed', 400, errors.array());

  try {
    if (PREMIUM_THEMES.includes(req.body.checkoutTheme)) {
      const sub = await subscriptionService.getUserSubscription(req.user.uid);
      if (!PREMIUM_PLAN_IDS.includes(sub?.plan?.id)) {
        return response.error(res, 'This template needs Silver plan or above.', 403);
      }
    }

    await firebaseService.updateUserProfile(req.user.uid, req.body);
    return response.success(res, 'Profile updated successfully');
  } catch (err) {
    return response.serverError(res, err.message);
  }
});

module.exports = router;
