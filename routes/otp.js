// routes/otp.js
const express = require('express');
const router = express.Router();
const { sendOtp, verifyOtp, resetPassword } = require('../controllers/otpController');
const { otpSendLimiter, otpVerifyLimiter } = require('../middleware/rateLimiter');

router.post('/send', otpSendLimiter, sendOtp);
router.post('/verify', otpVerifyLimiter, verifyOtp);
// Reuses otpVerifyLimiter — this endpoint verifies a code just like
// /verify does, so it should be bounded the same way against guessing.
router.post('/reset-password', otpVerifyLimiter, resetPassword);

module.exports = router;
