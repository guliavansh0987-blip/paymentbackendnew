const express = require('express');
const router = express.Router();
const { googleAuth, getMe, logout } = require('../controllers/authController');
const { authenticate } = require('../middleware/auth');
const { authLimiter } = require('../middleware/rateLimiter');

router.post('/google', authLimiter, googleAuth);
router.get('/me', authenticate, getMe);
router.post('/logout', authenticate, logout);

module.exports = router;

// POST /api/auth/create-admin - PERMANENTLY DISABLED: Admin creation through this endpoint is removed. Only existing admins can log in.
router.post('/create-admin', (req, res) => {
  return res.status(403).json({ success: false, message: 'Admin creation is disabled. Only existing admin accounts can log in.' });
});

