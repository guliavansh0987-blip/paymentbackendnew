// controllers/adminController.js - Admin Panel Controller
const { body, validationResult } = require('express-validator');
const jwt = require('jsonwebtoken');
const firebaseService = require('../services/firebaseService');
const walletService = require('../services/walletService');
const subscriptionService = require('../services/subscriptionService');
const referralService = require('../services/referralService');
const notificationService = require('../services/notificationService');
const supportService = require('../services/supportService');
const response = require('../helpers/response');
const logger = require('../utils/logger');

/**
 * GET /api/admin/dashboard
 * Dashboard analytics
 */
const getDashboard = async (req, res) => {
  try {
    const [users, payments, withdrawals, settings] = await Promise.all([
      firebaseService.getAllUsers(),
      firebaseService.getAllPayments(500),
      firebaseService.getAllWithdrawals(),
      firebaseService.getSettings(),
    ]);

    const totalUsers = users.filter((u) => u.role !== 'admin').length;
    // isTest orders are simulated in Test Mode (test.html) — never real
    // money, so they're excluded from every revenue/volume figure below.
    // getAllPayments() below still returns them (with isTest visible per
    // row) for admin support visibility, just not summed into these totals.
    const realPayments = payments.filter((p) => !p.isTest);
    const totalPayments = realPayments.filter((p) => p.status === 'success').length;
    const totalRevenue = realPayments
      .filter((p) => p.status === 'success')
      .reduce((sum, p) => sum + (p.payAmount || p.amount || 0), 0);
    const pendingWithdrawals = withdrawals.filter((w) => w.status === 'pending').length;
    const totalWalletBalance = users.reduce((sum, u) => sum + (u.walletBalance || 0), 0);

    // Last 7 days payments
    const now = Date.now();
    const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;
    const recentPayments = realPayments.filter(
      (p) => p.status === 'success' && p.createdAt > sevenDaysAgo
    ).length;

    return response.success(res, 'Dashboard data fetched', {
      stats: {
        totalUsers,
        totalPayments,
        totalRevenue: Math.round(totalRevenue * 100) / 100,
        pendingWithdrawals,
        totalWalletBalance: Math.round(totalWalletBalance * 100) / 100,
        recentPayments,
      },
      settings,
    });
  } catch (err) {
    logger.error('Dashboard error:', err.message);
    return response.serverError(res, err.message);
  }
};

/**
 * GET /api/admin/users
 */
const getUsers = async (req, res) => {
  try {
    const users = await firebaseService.getAllUsers();
    return response.success(res, 'Users fetched', { users, total: users.length });
  } catch (err) {
    logger.error('Get users error:', err.message);
    return response.serverError(res, err.message);
  }
};

/**
 * GET /api/admin/users/:uid
 */
const getUserDetail = async (req, res) => {
  try {
    const { ref } = require('../firebase/admin');
    const { DB_PATHS } = require('../config/constants');
    const uid = req.params.uid;

    const user = await firebaseService.getUser(uid);
    if (!user) return response.notFound(res, 'User not found');

    const [payments, withdrawals, notifications, subscription, referralData, linksSnap] = await Promise.all([
      firebaseService.getUserPayments(uid, 50),
      firebaseService.getUserWithdrawals(uid),
      notificationService.getUserNotifications(uid, 200),
      subscriptionService.getUserSubscription(uid).catch(() => null),
      referralService.getReferralData(uid).catch(() => null),
      ref(DB_PATHS.PAYMENT_LINKS).orderByChild('userId').equalTo(uid).once('value'),
    ]);

    const links = [];
    if (linksSnap.exists()) linksSnap.forEach((child) => links.push(child.val()));

    const realPayments = payments.filter((p) => !p.isTest);
    const successfulPayments = realPayments.filter((p) => p.status === 'success');
    const stats = {
      payments: {
        total: realPayments.length,
        successful: successfulPayments.length,
        totalReceived: successfulPayments.reduce((s, p) => s + (p.amount || 0), 0),
        testOrders: payments.filter((p) => p.isTest).length,
      },
      withdrawals: {
        total: withdrawals.length,
        approved: withdrawals.filter((w) => w.status === 'approved').length,
        pending: withdrawals.filter((w) => w.status === 'pending').length,
        totalWithdrawn: withdrawals.filter((w) => w.status === 'approved').reduce((s, w) => s + (w.amount || 0), 0),
      },
      notifications: {
        total: notifications.length,
        unread: notifications.filter((n) => !n.isRead).length,
      },
      paymentLinks: {
        total: links.length,
        active: links.filter((l) => l.status === 'active').length,
      },
      referrals: {
        total: referralData?.totalReferrals || 0,
        completed: (referralData?.referrals || []).filter((r) => r.status === 'completed').length,
      },
      plan: subscription?.plan?.name || 'Blaze',
      planExpiresAt: subscription?.endDate || null,
    };

    return response.success(res, 'User detail fetched', { user, payments, withdrawals, stats });
  } catch (err) {
    return response.serverError(res, err.message);
  }
};

/**
 * POST /api/admin/users/:uid/ban
 * body: { reason } — only used/stored when the action is a ban (not an unban)
 */
const toggleBan = async (req, res) => {
  try {
    const { uid } = req.params;
    const { reason } = req.body;
    const user = await firebaseService.getUser(uid);
    if (!user) return response.notFound(res, 'User not found');

    const newBanStatus = !user.isBanned;
    await firebaseService.setBanStatus(uid, newBanStatus, reason);

    const action = newBanStatus ? 'banned' : 'unbanned';
    logger.info(`User ${uid} ${action} by admin ${req.user.uid}`);

    // Notify the user — this also lands in their Notifications list (kept
    // reachable for banned users; see routes/notification.js) so the ban
    // reason is visible there too, not just on the suspended screen.
    const cleanReason = (reason || '').trim();
    await notificationService.createNotification(uid, newBanStatus ? {
      type: 'security',
      title: 'Account Suspended',
      message: cleanReason || 'Your account has been suspended for violating our Terms of Service.',
    } : {
      type: 'security',
      title: 'Account Reinstated',
      message: 'Your account has been reviewed and reinstated. You now have full access again.',
    }).catch((e) => logger.error('Ban notification failed:', e.message));

    // Two log entries on purpose: one under the admin (accountability —
    // "who banned whom"), one under the target (so it actually shows up
    // when Controller → Activity Log is opened for THIS user).
    await firebaseService.logActivity(req.user.uid, `USER_${action.toUpperCase()}`, { targetUid: uid, reason: newBanStatus ? cleanReason : '' });
    await firebaseService.logActivity(uid, `USER_${action.toUpperCase()}`, { byAdmin: req.user.uid, reason: newBanStatus ? cleanReason : '' });

    return response.success(res, `User ${action} successfully`, { isBanned: newBanStatus, banReason: newBanStatus ? (reason || '').trim() : '' });
  } catch (err) {
    return response.serverError(res, err.message);
  }
};

/**
 * POST /api/admin/users/:uid/clear-device
 * Frees a merchant's single-device login slot — needed when a user loses
 * access to their old device (lost/stolen/reset phone, cleared browser
 * data, etc.) and can no longer log out from it themselves.
 */
const clearUserDevice = async (req, res) => {
  try {
    const { uid } = req.params;
    const user = await firebaseService.getUser(uid);
    if (!user) return response.notFound(res, 'User not found');

    await firebaseService.clearActiveDevice(uid);
    await firebaseService.logActivity(req.user.uid, 'DEVICE_LOCK_CLEARED', { targetUid: uid });

    return response.success(res, 'Device lock cleared. User can now log in from a new device.');
  } catch (err) {
    return response.serverError(res, err.message);
  }
};

/**
 * POST /api/admin/users/delete-unverified
 * Bulk-deletes accounts with no name, no email, AND no wallet balance in
 * one shot. Any account with at least one of those three is untouched.
 */
const deleteUnverifiedUsers = async (req, res) => {
  try {
    const deletedUids = await firebaseService.deleteUnverifiedUsers();
    logger.info(`${deletedUids.length} unverified users deleted by admin ${req.user.uid}`);
    if (deletedUids.length > 0) {
      await firebaseService.logActivity(req.user.uid, 'BULK_DELETE_UNVERIFIED', { count: deletedUids.length });
    }
    return response.success(res, `${deletedUids.length} unverified user(s) deleted`, { deletedCount: deletedUids.length, deletedUids });
  } catch (err) {
    logger.error('Delete unverified users error:', err.message);
    return response.serverError(res, err.message);
  }
};

/**
 * DELETE /api/admin/users/:uid
 * Permanently removes a user's profile from the database.
 */
const deleteUser = async (req, res) => {
  try {
    const { uid } = req.params;
    const user = await firebaseService.getUser(uid);
    if (!user) return response.notFound(res, 'User not found');
    if (user.role === 'admin') return response.error(res, 'Cannot delete an admin account.');

    const balance = user.wallet?.balance || 0;
    if (balance > 0 && req.query.force !== 'true') {
      return response.error(res, `This user still has ₹${balance} in their wallet. Confirm again to delete anyway.`);
    }

    await firebaseService.deleteUser(uid);
    logger.info(`User ${uid} deleted by admin ${req.user.uid}`);
    await firebaseService.logActivity(req.user.uid, 'USER_DELETED', { targetUid: uid, walletBalanceAtDeletion: balance });

    return response.success(res, 'User deleted successfully');
  } catch (err) {
    return response.serverError(res, err.message);
  }
};

/**
 * POST /api/admin/wallet/adjust
 * Manual wallet credit or debit
 */
const adjustWallet = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return response.error(res, 'Validation failed', 400, errors.array());

    const { userId, amount, reason } = req.body;
    const walletType = ['bonus', 'credit'].includes(req.body.walletType) ? req.body.walletType : 'cash';
    const adjustAmount = parseFloat(amount);

    const user = await firebaseService.getUser(userId);
    if (!user) return response.notFound(res, 'User not found');

    let newBalance;
    if (walletType === 'bonus') newBalance = await walletService.adminAdjustBonusWallet(userId, adjustAmount, reason || 'Admin adjustment');
    else if (walletType === 'credit') newBalance = await walletService.adminAdjustZapCredit(userId, adjustAmount, reason || 'Admin adjustment');
    else newBalance = await walletService.adminAdjustWallet(userId, adjustAmount, reason || 'Admin adjustment');
    if (walletType === 'cash' && adjustAmount > 0) {
      try { await subscriptionService.maybeAutoUpgrade(userId); } catch (e) { logger.error('Auto-upgrade check failed: ' + e.message); }
    }

    const label = walletType === 'bonus' ? 'Zap Bonus' : walletType === 'credit' ? 'Zap Credit' : 'Zap Cash';
    await notificationService.createNotification(userId, {
      title: adjustAmount > 0 ? `💰 ${label} Credited` : `💸 ${label} Debited`,
      message: `${adjustAmount > 0 ? '₹' + adjustAmount + ' added to' : '₹' + Math.abs(adjustAmount) + ' deducted from'} your ${label} by admin. Reason: ${reason || 'N/A'}`,
      type: 'general',
    });

    await firebaseService.logActivity(req.user.uid, 'ADMIN_WALLET_ADJUST', {
      targetUid: userId,
      walletType,
      amount: adjustAmount,
      reason: reason || '',
    });
    await firebaseService.logActivity(userId, 'ADMIN_WALLET_ADJUST', {
      byAdmin: req.user.uid,
      walletType,
      amount: adjustAmount,
      reason: reason || '',
    });

    return response.success(res, `${label} adjusted`, { newBalance, walletType });
  } catch (err) {
    if (err.message === 'INSUFFICIENT_BALANCE' || err.message === 'INSUFFICIENT_BONUS_BALANCE' || err.message === 'INSUFFICIENT_ZAP_CREDIT') {
      return response.error(res, 'User has insufficient balance for debit');
    }
    return response.serverError(res, err.message);
  }
};

/**
 * GET /api/admin/payments
 */
const getAllPayments = async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const payments = await firebaseService.getAllPayments(limit);
    return response.success(res, 'Payments fetched', { payments, total: payments.length });
  } catch (err) {
    return response.serverError(res, err.message);
  }
};

/**
 * GET /api/admin/withdrawals
 */
const getAllWithdrawals = async (req, res) => {
  try {
    const withdrawals = await firebaseService.getAllWithdrawals();
    return response.success(res, 'Withdrawals fetched', { withdrawals });
  } catch (err) {
    return response.serverError(res, err.message);
  }
};

/**
 * PUT /api/admin/withdrawals/:id/approve
 */
const approveWithdrawal = async (req, res) => {
  try {
    const withdrawal = await firebaseService.getWithdrawal(req.params.id);
    if (!withdrawal) return response.notFound(res, 'Withdrawal not found');
    if (withdrawal.status !== 'pending') {
      return response.error(res, `Withdrawal is already ${withdrawal.status}`);
    }

    await firebaseService.updateWithdrawalStatus(req.params.id, 'approved', req.body.note || '');

    await notificationService.notifyWithdrawalStatus(withdrawal.userId, withdrawal.netAmount, 'approved');

    await firebaseService.logActivity(req.user.uid, 'WITHDRAWAL_APPROVED', {
      withdrawalId: req.params.id,
      userId: withdrawal.userId,
      amount: withdrawal.amount,
    });
    await firebaseService.logActivity(withdrawal.userId, 'WITHDRAWAL_APPROVED', {
      withdrawalId: req.params.id,
      byAdmin: req.user.uid,
      amount: withdrawal.amount,
    });

    return response.success(res, 'Withdrawal approved successfully');
  } catch (err) {
    return response.serverError(res, err.message);
  }
};

/**
 * PUT /api/admin/withdrawals/:id/reject
 */
const rejectWithdrawal = async (req, res) => {
  try {
    const withdrawal = await firebaseService.getWithdrawal(req.params.id);
    if (!withdrawal) return response.notFound(res, 'Withdrawal not found');
    if (withdrawal.status !== 'pending') {
      return response.error(res, `Withdrawal is already ${withdrawal.status}`);
    }

    const note = req.body.note || 'Request rejected by admin';

    await firebaseService.updateWithdrawalStatus(req.params.id, 'rejected', note);

    // Refund wallet on rejection
    await walletService.creditWallet(withdrawal.userId, withdrawal.amount, 'Withdrawal refund');

    await notificationService.notifyWithdrawalStatus(withdrawal.userId, withdrawal.amount, 'rejected', note);

    await firebaseService.logActivity(req.user.uid, 'WITHDRAWAL_REJECTED', {
      withdrawalId: req.params.id,
      userId: withdrawal.userId,
      reason: note,
    });
    await firebaseService.logActivity(withdrawal.userId, 'WITHDRAWAL_REJECTED', {
      withdrawalId: req.params.id,
      byAdmin: req.user.uid,
      reason: note,
    });

    return response.success(res, 'Withdrawal rejected and amount refunded');
  } catch (err) {
    return response.serverError(res, err.message);
  }
};

/**
 * GET /api/admin/settings
 */
const getSettings = async (req, res) => {
  try {
    const settings = await firebaseService.getSettings();
    const { ref } = require('../firebase/admin');
    const { DB_PATHS } = require('../config/constants');
    const adminsSnap = await ref(DB_PATHS.USERS).orderByChild('role').equalTo('admin').once('value');
    const adminCashiers = [];
    if (adminsSnap.exists()) {
        adminsSnap.forEach(child => {
            const u = child.val();
            if (u.fampay && u.fampay.isConnected) {
                adminCashiers.push({ uid: u.uid, name: u.displayName || u.email, upiId: u.fampay.upiId });
            }
        });
    }
    return response.success(res, 'Settings fetched', { settings, adminCashiers });
  } catch (err) {
    return response.serverError(res, err.message);
  }
};

/**
 * PUT /api/admin/settings
 */
const updateSettings = async (req, res) => {
  try {
    const allowed = [
      'minWithdrawal', 'commissionPercent', 'maintenanceMode', 'siteName', 'supportEmail',
      'signupBonus', 'referralCommissionPercent', 'referralQualifyingMinDeposit', 'signupZapCredit', 'socialLinks',
      'systemRoutingMode', 'systemRoutingAdminUid', 'hideWalletSystemEnabled', 'minZapCreditPurchase', 'fampayInviteLink'
    ];
    const update = {};
    allowed.forEach((key) => {
      if (req.body[key] !== undefined) update[key] = req.body[key];
    });

    await firebaseService.updateSettings(update);
    await firebaseService.logActivity(req.user.uid, 'SETTINGS_UPDATED', update);

    return response.success(res, 'Settings updated');
  } catch (err) {
    return response.serverError(res, err.message);
  }
};

/**
 * POST /api/admin/notifications/send
 * Broadcast notification to all users
 */
const sendBroadcast = async (req, res) => {
  try {
    const { title, message, type } = req.body;
    if (!title || !message) return response.error(res, 'Title and message required');

    const count = await notificationService.broadcastNotification({ title, message, type });

    return response.success(res, `Notification sent to ${count} users`);
  } catch (err) {
    return response.serverError(res, err.message);
  }
};

/**
 * GET /api/admin/referrals
 * All referral relationships across the platform, for oversight
 */
const getAllReferrals = async (req, res) => {
  try {
    const { ref } = require('../firebase/admin');
    const { DB_PATHS } = require('../config/constants');
    const snap = await ref(DB_PATHS.REFERRALS).once('value');
    const referrals = [];
    if (snap.exists()) {
      snap.forEach((referrerSnap) => {
        referrerSnap.forEach((r) => referrals.push(r.val()));
      });
    }
    referrals.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    const totalCommissionPaid = referrals.reduce((s, r) => s + (r.commission || 0), 0);
    return response.success(res, 'Referrals fetched', {
      referrals,
      total: referrals.length,
      completed: referrals.filter((r) => r.status === 'completed').length,
      totalCommissionPaid,
    });
  } catch (err) {
    return response.serverError(res, err.message);
  }
};

const adjustWalletValidation = [
  body('userId').notEmpty().withMessage('User ID required'),
  body('amount').isFloat({ min: -100000, max: 100000 }).withMessage('Invalid amount'),
  body('reason').optional().isLength({ max: 200 }).trim().escape(),
  body('walletType').optional().isIn(['cash', 'bonus', 'credit']).withMessage('Invalid wallet type'),
];

/**
 * GET /api/admin/support
 * Inbox — every user's support thread, most recently active first.
 */
const getSupportThreads = async (req, res) => {
  try {
    const threads = await supportService.getAllThreads();
    return response.success(res, 'Support threads fetched', { threads });
  } catch (err) {
    logger.error('Get support threads error:', err.message);
    return response.serverError(res, err.message);
  }
};

/**
 * GET /api/admin/support/:uid
 * One user's full conversation. Marks it read for admin.
 */
const getSupportThreadMessages = async (req, res) => {
  try {
    const { uid } = req.params;
    const [messages, user] = await Promise.all([
      supportService.getMessages(uid),
      firebaseService.getUser(uid),
    ]);
    await supportService.markReadByAdmin(uid);
    return response.success(res, 'Messages fetched', {
      messages,
      user: user ? { uid: user.uid, displayName: user.displayName, email: user.email, isBanned: !!user.isBanned, banReason: user.banReason || '' } : null,
    });
  } catch (err) {
    logger.error('Get support thread error:', err.message);
    return response.serverError(res, err.message);
  }
};

/**
 * POST /api/admin/support/:uid/reply
 */
const replySupportThread = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return response.error(res, 'Validation failed', 400, errors.array());

    const { uid } = req.params;
    const user = await firebaseService.getUser(uid);
    if (!user) return response.notFound(res, 'User not found');

    await supportService.sendAdminReply(uid, req.body.message);
    const messages = await supportService.getMessages(uid);
    return response.success(res, 'Reply sent', { messages });
  } catch (err) {
    logger.error('Reply support thread error:', err.message);
    return response.serverError(res, err.message);
  }
};

const replySupportValidation = [
  body('message').trim().notEmpty().withMessage('Message cannot be empty').isLength({ max: 1000 }).withMessage('Message too long'),
];

/**
 * PUT /api/admin/support/:uid/message/:messageId
 */
const editSupportMessage = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return response.error(res, 'Validation failed', 400, errors.array());
    const { uid, messageId } = req.params;
    await supportService.editAdminMessage(uid, messageId, req.body.message);
    const messages = await supportService.getMessages(uid);
    return response.success(res, 'Message updated', { messages });
  } catch (err) {
    return response.error(res, err.message || 'Failed to edit message');
  }
};

/**
 * DELETE /api/admin/support/:uid/message/:messageId
 */
const deleteSupportMessage = async (req, res) => {
  try {
    const { uid, messageId } = req.params;
    await supportService.deleteAdminMessage(uid, messageId);
    const messages = await supportService.getMessages(uid);
    return response.success(res, 'Message deleted', { messages });
  } catch (err) {
    return response.error(res, err.message || 'Failed to delete message');
  }
};

const editSupportMessageValidation = [
  body('message').trim().notEmpty().withMessage('Message cannot be empty').isLength({ max: 1000 }).withMessage('Message too long'),
];

/**
 * GET /api/admin/users/:uid/activity
 * Full activity timeline for the Controller → Activity Log view.
 */
const getUserActivity = async (req, res) => {
  try {
    const { uid } = req.params;
    const user = await firebaseService.getUser(uid);
    if (!user) return response.notFound(res, 'User not found');
    const logs = await firebaseService.getUserActivityLog(uid);
    return response.success(res, 'Activity fetched', {
      logs,
      user: { uid: user.uid, displayName: user.displayName, email: user.email },
    });
  } catch (err) {
    logger.error('Get user activity error:', err.message);
    return response.serverError(res, err.message);
  }
};

/**
 * POST /api/admin/users/:uid/notify
 * Send a one-off "Notice" to a single user — Controller → Notification.
 * Always type 'admin_notice' — this is what tells the user panel to show
 * it as a one-time popup (not just a bell-icon list item), see index.html.
 */
const sendUserNotification = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return response.error(res, 'Validation failed', 400, errors.array());

    const { uid } = req.params;
    const user = await firebaseService.getUser(uid);
    if (!user) return response.notFound(res, 'User not found');

    const { title, message } = req.body;
    await notificationService.createNotification(uid, {
      title: title.trim(),
      message: message.trim(),
      type: 'admin_notice',
    });

    await firebaseService.logActivity(req.user.uid, 'ADMIN_NOTIFICATION_SENT', { targetUid: uid, title: title.trim() });
    await firebaseService.logActivity(uid, 'ADMIN_NOTIFICATION_SENT', { byAdmin: req.user.uid, title: title.trim() });

    return response.success(res, 'Notice sent');
  } catch (err) {
    logger.error('Send user notification error:', err.message);
    return response.serverError(res, err.message);
  }
};

const sendUserNotificationValidation = [
  body('title').trim().notEmpty().withMessage('Title is required').isLength({ max: 100 }),
  body('message').trim().notEmpty().withMessage('Message is required').isLength({ max: 500 }),
];

/**
 * POST /api/admin/users/:uid/impersonate
 * "Login as User" — issues a short-lived (1h) token for the target user's
 * own account, so admin can view their dashboard/activity exactly as they
 * see it. Money-moving actions (withdrawal requests, payout-detail edits)
 * stay blocked on this token via blockIfImpersonating — investigation only.
 * Heavily logged both ends, precisely so a later fraud dispute has a clear,
 * timestamped record of who looked at what and when.
 */
const impersonateUser = async (req, res) => {
  try {
    const { uid } = req.params;
    const user = await firebaseService.getUser(uid);
    if (!user) return response.notFound(res, 'User not found');

    const token = jwt.sign(
      { uid, email: user.email, role: user.role || 'user', impersonatedBy: req.user.uid },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );

    await firebaseService.logActivity(req.user.uid, 'ADMIN_IMPERSONATION_STARTED', { targetUid: uid, targetEmail: user.email || '' });
    await firebaseService.logActivity(uid, 'ADMIN_IMPERSONATION_STARTED', { byAdmin: req.user.uid });
    logger.info(`Admin ${req.user.uid} started impersonating user ${uid}`);

    return response.success(res, 'Impersonation token issued', {
      token,
      user: {
        uid: user.uid,
        email: user.email,
        displayName: user.displayName,
        photoURL: user.photoURL,
        role: user.role,
        walletBalance: user.wallet?.balance || 0,
        isBanned: !!user.isBanned,
        banReason: user.banReason || '',
        isNewUser: false,
      },
    });
  } catch (err) {
    logger.error('Impersonate user error:', err.message);
    return response.serverError(res, err.message);
  }
};

/**
 * POST /api/admin/users/:uid/reset-login-activity
 * Force-invalidates every outstanding login session for this account by
 * bumping tokenVersion — any JWT issued before this call stops verifying
 * on the very next request (see middleware/auth.js), so the account comes
 * back completely fresh: every device that was logged in gets kicked out
 * and has to sign in again. This is now the tool for "something's wrong
 * with this account's sessions, start clean" — replacing the old
 * single-device lock, which this same reset used to just clear.
 * Does not touch the account itself (wallet, plan, bans, etc.) — only
 * session state.
 */
const adminResetLoginActivity = async (req, res) => {
  try {
    const { ref } = require('../firebase/admin');
    const { DB_PATHS } = require('../config/constants');
    const { uid } = req.params;
    const user = await firebaseService.getUser(uid);
    if (!user) return response.notFound(res, 'User not found');

    const nextVersion = (user.tokenVersion || 0) + 1;
    await ref(`${DB_PATHS.USERS}/${uid}`).update({
      tokenVersion: nextVersion,
      activeDevice: null, // clear any stale slot left over from the old single-device system
    });

    await firebaseService.logActivity(req.user.uid, 'ADMIN_RESET_LOGIN_ACTIVITY', { targetUid: uid, targetEmail: user.email || '' });
    logger.info(`Admin ${req.user.uid} reset login activity for user ${uid}`);

    return response.success(res, 'Login activity reset — this account is signed out everywhere and can log in fresh on any device.');
  } catch (err) {
    logger.error('Reset login activity error:', err.message);
    return response.serverError(res, err.message);
  }
};

module.exports = {
  getDashboard,
  getUsers,
  getUserDetail,
  toggleBan,
  clearUserDevice,
  adminResetLoginActivity,
  deleteUser,
  deleteUnverifiedUsers,
  adjustWallet,
  adjustWalletValidation,
  getAllPayments,
  getAllWithdrawals,
  approveWithdrawal,
  rejectWithdrawal,
  getSettings,
  updateSettings,
  sendBroadcast,
  getAllReferrals,
  getSupportThreads,
  getSupportThreadMessages,
  replySupportThread,
  replySupportValidation,
  editSupportMessage,
  deleteSupportMessage,
  editSupportMessageValidation,
  getUserActivity,
  sendUserNotification,
  sendUserNotificationValidation,
  impersonateUser,
};
