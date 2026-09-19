// routes/notification.js
// NOTE: deliberately NOT using blockIfBanned — a banned user still needs to
// see their "Account Suspended" notification (with the reason) here.
const express = require('express');
const router = express.Router();
const { getNotifications, markAsRead, markAllAsRead, getUnreadCount, registerFcmToken, unregisterFcmToken, sendTestPush } = require('../controllers/notificationController');
const { authenticate } = require('../middleware/auth');

router.use(authenticate);

router.get('/list', getNotifications);
router.get('/count', getUnreadCount);
router.put('/read/:id', markAsRead);
router.put('/read-all', markAllAsRead);
router.post('/fcm-token', registerFcmToken);
router.delete('/fcm-token', unregisterFcmToken);
router.post('/test-push', sendTestPush);

module.exports = router;
