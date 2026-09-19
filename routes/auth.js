const express = require('express');
const router = express.Router();
const { googleAuth, getMe, logout } = require('../controllers/authController');
const { authenticate } = require('../middleware/auth');
const { authLimiter } = require('../middleware/rateLimiter');

router.post('/google', authLimiter, googleAuth);
router.get('/me', authenticate, getMe);
router.post('/logout', authenticate, logout);

module.exports = router;

// POST /api/auth/create-admin
router.post('/create-admin', authLimiter, async (req, res) => {
  const { idToken, secret } = req.body;
  if (!idToken || !secret) return res.status(400).json({ success:false, message:'idToken and secret required' });
  if (secret !== process.env.ADMIN_SECRET) return res.status(403).json({ success:false, message:'Invalid secret key' });

  const { getAuth, ref } = require('../firebase/admin');
  const firebaseService  = require('../services/firebaseService');
  const jwt = require('jsonwebtoken');
  try {
    const decoded = await getAuth().verifyIdToken(idToken);
    const { uid, email, name, picture } = decoded;
    await firebaseService.upsertUser(uid, { email, displayName: name || email, photoURL: picture || '' });
    await ref(`users/${uid}/role`).set('admin');
    const user  = await firebaseService.getUser(uid);
    const token = jwt.sign({ uid, email, role:'admin' }, process.env.JWT_SECRET, { expiresIn:'30d' });
    return res.json({ success:true, message:'Admin created', data:{ token, user:{ ...user, role:'admin' } } });
  } catch(err) {
    return res.status(400).json({ success:false, message: err.message });
  }
});
