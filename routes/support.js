// routes/support.js
// IMPORTANT: only `authenticate` here — deliberately NOT `blockIfBanned`.
// A suspended user must still be able to reach support chat.
const express = require('express');
const router = express.Router();
const { getMyMessages, sendMessage, sendMessageValidation } = require('../controllers/supportController');
const { authenticate } = require('../middleware/auth');

router.get('/messages', authenticate, getMyMessages);
router.post('/messages', authenticate, sendMessageValidation, sendMessage);

module.exports = router;
