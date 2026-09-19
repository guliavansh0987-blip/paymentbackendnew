// routes/referral.js
const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/referralController');
const { authenticate, blockIfBanned } = require('../middleware/auth');

router.use(authenticate, blockIfBanned);

router.get('/my', ctrl.getMyReferral);

module.exports = router;
