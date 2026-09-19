// controllers/notificationController.js - Notification Controller
const notificationService = require('../services/notificationService');
const firebaseService = require('../services/firebaseService');
const fcmService = require('../services/fcmService');
const response = require('../helpers/response');
const logger = require('../utils/logger');

/**
 * GET /api/notification/list
 * Get user notifications
 */
const getNotifications = async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 30, 50);
    const notifications = await notificationService.getUserNotifications(req.user.uid, limit);
    const unreadCount = notifications.filter((n) => !n.isRead).length;

    return response.success(res, 'Notifications fetched', { notifications, unreadCount });
  } catch (err) {
    logger.error('Get notifications error:', err.message);
    return response.serverError(res, err.message);
  }
};

/**
 * PUT /api/notification/read/:id
 * Mark a notification as read
 */
const markAsRead = async (req, res) => {
  try {
    await notificationService.markAsRead(req.user.uid, req.params.id);
    await firebaseService.logActivity(req.user.uid, 'NOTIFICATION_READ', { notificationId: req.params.id });
    return response.success(res, 'Notification marked as read');
  } catch (err) {
    logger.error('Mark read error:', err.message);
    return response.serverError(res, err.message);
  }
};

/**
 * PUT /api/notification/read-all
 * Mark all notifications as read
 */
const markAllAsRead = async (req, res) => {
  try {
    await notificationService.markAllAsRead(req.user.uid);
    await firebaseService.logActivity(req.user.uid, 'NOTIFICATION_READ_ALL', {});
    return response.success(res, 'All notifications marked as read');
  } catch (err) {
    logger.error('Mark all read error:', err.message);
    return response.serverError(res, err.message);
  }
};

/**
 * GET /api/notification/count
 * Get unread notification count
 */
const getUnreadCount = async (req, res) => {
  try {
    const count = await notificationService.getUnreadCount(req.user.uid);
    return response.success(res, 'Count fetched', { unreadCount: count });
  } catch (err) {
    return response.success(res, 'Count fetched', { unreadCount: 0 });
  }
};

/**
 * POST /api/notification/fcm-token
 * Body: { token, platform? }
 * Registers (or refreshes) this device's push token for the logged-in
 * user. Called once the browser has granted notification permission and
 * the Firebase SDK has produced a token — see index.html's push-setup.
 */
const registerFcmToken = async (req, res) => {
  try {
    const { token, platform } = req.body;
    if (!token) return response.error(res, 'token is required');

    await fcmService.registerToken(req.user.uid, token, {
      platform,
      userAgent: req.headers['user-agent'] || '',
    });

    return response.success(res, 'Push notifications enabled');
  } catch (err) {
    logger.error('Register FCM token error:', err.message);
    return response.serverError(res, err.message);
  }
};

/**
 * DELETE /api/notification/fcm-token
 * Body: { token }
 * Called when the user turns push notifications off on this device.
 */
const unregisterFcmToken = async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return response.error(res, 'token is required');

    await fcmService.unregisterToken(req.user.uid, token);
    return response.success(res, 'Push notifications disabled for this device');
  } catch (err) {
    logger.error('Unregister FCM token error:', err.message);
    return response.serverError(res, err.message);
  }
};

/**
 * POST /api/notification/test-push
 * Sends a single push straight to the logged-in user's own devices,
 * bypassing payments/webhooks entirely — for isolating whether FCM
 * delivery itself works, separate from anything about Test Mode or
 * payment flows. Check your Vercel function logs right after calling
 * this; fcmService now logs the exact per-device FCM result.
 */
const sendTestPush = async (req, res) => {
  try {
    const result = await fcmService.sendPushToUser(req.user.uid, {
      title: '🔔 Test Push',
      message: 'If you see this as a real notification, push delivery is working.',
      type: 'general',
    });

    if (result.deviceCount === 0) {
      return response.error(res, `No push devices registered for your account (${result.reason}). Try Disable then Enable again.`);
    }
    if (result.ok) {
      return response.success(res, `Sent to ${result.successCount}/${result.deviceCount} device(s). If it still doesn't show up on your phone, that's a delivery/OS-level issue, not a send failure.`, result);
    }
    // Sent, but FCM itself rejected every device — this is the exact
    // error that was previously only visible in Vercel logs.
    const codes = result.errors.map(e => e.code).join(', ');
    return response.error(res, `FCM rejected the push for all ${result.deviceCount} device(s): ${codes}`, 502, result.errors);
  } catch (err) {
    logger.error('Send test push error:', err.message);
    return response.serverError(res, err.message);
  }
};

module.exports = {
  getNotifications,
  markAsRead,
  markAllAsRead,
  getUnreadCount,
  registerFcmToken,
  unregisterFcmToken,
  sendTestPush,
};
