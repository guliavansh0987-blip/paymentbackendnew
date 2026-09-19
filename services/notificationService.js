// services/notificationService.js - Notification System
const { ref, serverTimestamp } = require('../firebase/admin');
const { DB_PATHS, NOTIFICATION_TYPE } = require('../config/constants');
const fcmService = require('./fcmService');
const logger = require('../utils/logger');

/**
 * Create a notification for a user.
 *
 * Also sends a push notification (FCM) to every device the user has
 * registered — this is the ONLY place that needs to know about push at
 * all, since every notification in this app (payment success/failed,
 * wallet credit, withdrawal status, subscription events, admin notices,
 * test-mode simulations, etc.) already flows through this one function.
 * fcmService.sendPushToUser never throws, so a push-delivery hiccup can
 * never break the in-app notification (or whatever triggered it, e.g. a
 * payment webhook) that this is called from.
 */
async function createNotification(userId, { title, message, type = NOTIFICATION_TYPE.GENERAL }) {
  const notifRef = ref(`${DB_PATHS.NOTIFICATIONS}/${userId}`).push();
  await notifRef.set({
    id: notifRef.key,
    title,
    message,
    type,
    isRead: false,
    createdAt: serverTimestamp(),
  });
  await fcmService.sendPushToUser(userId, { title, message, type });
  return notifRef.key;
}

/**
 * Get notifications for a user
 * NOTE: fetches the full set and sorts/slices in JS rather than using
 * orderByChild + limitToLast — that combination silently misbehaves on
 * Firebase RTDB if the .indexOn rule for 'createdAt' hasn't been applied
 * (a common deployment gap), causing newer notifications to be dropped
 * from the result while getUnreadCount (a simpler equalTo query) still
 * counts them correctly — exactly the "badge says 2, list shows 1" bug.
 */
async function getUserNotifications(userId, limit = 30) {
  const snap = await ref(`${DB_PATHS.NOTIFICATIONS}/${userId}`).once('value');
  if (!snap.exists()) return [];
  const notifs = [];
  // Defensive: skip any null/malformed child so one bad record can't
  // affect the rest of the list.
  snap.forEach((child) => { const v = child.val(); if (v) notifs.push(v); });
  notifs.sort((a, b) => (Number(b?.createdAt) || 0) - (Number(a?.createdAt) || 0));
  return notifs.slice(0, limit);
}

/**
 * Mark notification as read
 */
async function markAsRead(userId, notifId) {
  await ref(`${DB_PATHS.NOTIFICATIONS}/${userId}/${notifId}`).update({
    isRead: true,
  });
}

/**
 * Mark all notifications as read
 */
async function markAllAsRead(userId) {
  const snap = await ref(`${DB_PATHS.NOTIFICATIONS}/${userId}`).once('value');
  if (!snap.exists()) return;
  const updates = {};
  snap.forEach((child) => {
    if (child.val().isRead === false) updates[`${child.key}/isRead`] = true;
  });
  if (Object.keys(updates).length) await ref(`${DB_PATHS.NOTIFICATIONS}/${userId}`).update(updates);
}

/**
 * Get unread notification count
 */
async function getUnreadCount(userId) {
  const snap = await ref(`${DB_PATHS.NOTIFICATIONS}/${userId}`).once('value');
  if (!snap.exists()) return 0;
  let count = 0;
  snap.forEach((child) => { const v = child.val(); if (v && v.isRead === false) count++; });
  return count;
}

/**
 * Send notification to all users (admin broadcast)
 */
async function broadcastNotification({ title, message, type = NOTIFICATION_TYPE.GENERAL }) {
  const usersSnap = await ref(DB_PATHS.USERS).once('value');
  if (!usersSnap.exists()) return 0;

  let count = 0;
  const promises = [];

  usersSnap.forEach((child) => {
    const uid = child.key;
    const user = child.val();
    if (!user.isBanned && user.role !== 'admin') {
      promises.push(createNotification(uid, { title, message, type }));
      count++;
    }
  });

  await Promise.all(promises);
  logger.info(`Broadcast sent to ${count} users: ${title}`);
  return count;
}

/**
 * Payment success notification
 */
async function notifyPaymentSuccess(userId, amount, orderId) {
  return createNotification(userId, {
    title: '💰 Payment Received',
    message: `₹${amount} has been added to your wallet. Order: ${orderId}`,
    type: NOTIFICATION_TYPE.PAYMENT,
  });
}

/**
 * Withdrawal status notification
 */
async function notifyWithdrawalStatus(userId, amount, status, adminNote = '') {
  const isApproved = status === 'approved';
  return createNotification(userId, {
    title: isApproved ? '✅ Withdrawal Approved' : '❌ Withdrawal Rejected',
    message: isApproved
      ? `Your withdrawal request of ₹${amount} has been approved and will be processed soon.`
      : `Your withdrawal request of ₹${amount} was rejected. ${adminNote ? 'Reason: ' + adminNote : ''}`,
    type: NOTIFICATION_TYPE.WITHDRAWAL,
  });
}

module.exports = {
  createNotification,
  getUserNotifications,
  markAsRead,
  markAllAsRead,
  getUnreadCount,
  broadcastNotification,
  notifyPaymentSuccess,
  notifyWithdrawalStatus,
};
