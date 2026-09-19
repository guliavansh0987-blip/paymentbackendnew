// services/firebaseService.js - Firebase RTDB Operations
const { ref, serverTimestamp, admin } = require('../firebase/admin');
const { DB_PATHS, DEFAULT_SETTINGS, ZAP_CREDIT_SIGNUP_GRANT } = require('../config/constants');
const logger = require('../utils/logger');

/**
 * =============================
 * USER OPERATIONS
 * =============================
 */

/**
 * Get user by UID
 */
async function getUser(uid) {
  const snap = await ref(`${DB_PATHS.USERS}/${uid}`).once('value');
  return snap.exists() ? { uid, ...snap.val() } : null;
}

/**
 * Generate a unique, human-shareable referral code (e.g. ZAP6UTQV85ZO)
 */
function generateReferralCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let suffix = '';
  for (let i = 0; i < 8; i++) suffix += chars[Math.floor(Math.random() * chars.length)];
  return `ZAP${suffix}`;
}

/**
 * Resolve a referral code to the referrer's UID (returns null if not found)
 */
async function getUidByReferralCode(code) {
  if (!code) return null;
  const snap = await ref(`${DB_PATHS.REFERRAL_CODES}/${code.trim().toUpperCase()}`).once('value');
  return snap.exists() ? snap.val() : null;
}

/**
 * Create or update user on login
 */
async function upsertUser(uid, data) {
  const userRef = ref(`${DB_PATHS.USERS}/${uid}`);
  const snap = await userRef.once('value');
  const isNewUser = !snap.exists();

  if (!snap.exists()) {
    const myReferralCode = generateReferralCode();
    const settings = await getSettings();
    const signupBonus = settings.signupBonus || 0;
    const zapCreditGrant = settings.signupZapCredit ?? ZAP_CREDIT_SIGNUP_GRANT;

    let referredBy = null;
    let bonusGranted = 0;
    if (data.referralCode) {
      const referrerUid = await getUidByReferralCode(data.referralCode);
      if (referrerUid && referrerUid !== uid) {
        referredBy = referrerUid;
        bonusGranted = signupBonus;
      }
    }

    await userRef.set({
      uid,
      email: data.email,
      displayName: data.displayName || '',
      photoURL: data.photoURL || '',
      role: 'user',
      wallet: { balance: 0, bonusBalance: bonusGranted, zapCredit: zapCreditGrant, lastUpdated: serverTimestamp() },
      isActive: true,
      isBanned: false,
      referralCode: myReferralCode,
      referredBy,
      createdAt: serverTimestamp(),
      lastLoginAt: serverTimestamp(),
    });

    await ref(`${DB_PATHS.REFERRAL_CODES}/${myReferralCode}`).set(uid);

    if (referredBy) {
      await ref(`${DB_PATHS.REFERRALS}/${referredBy}/${uid}`).set({
        referredUid: uid,
        referrerUid: referredBy,
        name: data.displayName || 'User',
        email: data.email || '',
        status: 'waiting',
        signupBonusGiven: bonusGranted > 0,
        signupBonus: bonusGranted,
        purchaseAmount: null,
        commissionPercent: settings.referralCommissionPercent || 25,
        commission: null,
        createdAt: serverTimestamp(),
        completedAt: null,
      });
    }
  } else {
    const existing = snap.val();
    const updates = {
      displayName: data.displayName || existing.displayName,
      photoURL: data.photoURL || existing.photoURL,
      lastLoginAt: serverTimestamp(),
    };
    if (!existing.referralCode) {
      const myReferralCode = generateReferralCode();
      updates.referralCode = myReferralCode;
      await ref(`${DB_PATHS.REFERRAL_CODES}/${myReferralCode}`).set(uid);
    }
    // Zap Credit backfill — existing users (created before this feature)
    // never got the signup grant, so give it once here. Guarded by the
    // field's absence so this never re-grants on later logins.
    if (existing.wallet?.zapCredit === undefined) {
      const settings = await getSettings();
      updates['wallet/zapCredit'] = settings.signupZapCredit ?? ZAP_CREDIT_SIGNUP_GRANT;
      updates['wallet/zapCreditLastUpdated'] = serverTimestamp();
    }
    await userRef.update(updates);
  }

  const updated = await userRef.once('value');
  return { uid, ...updated.val(), isNewUser };
}

/**
 * Update user profile
 */
async function updateUserProfile(uid, data) {
  const allowed = ['displayName', 'phone', 'upiId', 'upiHolderName', 'bankDetails', 'checkoutTheme', 'checkoutThemeColor', 'showOnboarding'];
  const update = {};
  allowed.forEach((key) => {
    if (data[key] !== undefined) update[key] = data[key];
  });
  update.updatedAt = serverTimestamp();
  await ref(`${DB_PATHS.USERS}/${uid}`).update(update);
}

/**
 * Get all users (admin)
 */
async function getAllUsers() {
  const snap = await ref(DB_PATHS.USERS).once('value');
  if (!snap.exists()) return [];
  const users = [];
  snap.forEach((child) => {
    const user = child.val();
    users.push({
      uid: child.key,
      email: user.email,
      displayName: user.displayName,
      photoURL: user.photoURL,
      role: user.role,
      walletBalance: user.wallet?.balance || 0,
      isActive: user.isActive,
      isBanned: user.isBanned,
      createdAt: user.createdAt,
      lastLoginAt: user.lastLoginAt,
    });
  });
  return users.sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * Ban or unban user
 */
async function setBanStatus(uid, isBanned, reason = '') {
  await ref(`${DB_PATHS.USERS}/${uid}`).update({
    isBanned,
    banReason: isBanned ? (reason || '').trim() : '',
    bannedAt: isBanned ? serverTimestamp() : null,
    updatedAt: serverTimestamp(),
  });
}

/**
 * Full activity timeline for one user
 */
async function getUserActivityLog(uid, limit = 300) {
  const snap = await ref(DB_PATHS.ACTIVITY_LOGS).orderByChild('userId').equalTo(uid).limitToLast(limit).once('value');
  const logs = [];
  if (snap.exists()) snap.forEach((child) => logs.push(child.val()));
  logs.sort((a, b) => (Number(b?.timestamp) || 0) - (Number(a?.timestamp) || 0));
  return logs;
}

/**
 * =============================
 * PAYMENT OPERATIONS
 * =============================
 */

/**
 * Create a payment record
 */
async function createPayment(orderId, data) {
  await ref(`${DB_PATHS.PAYMENTS}/${orderId}`).set({
    orderId,
    userId: data.userId,
    amount: parseFloat(data.amount),
    status: data.status || 'pending',
    remark: data.remark || '',
    customerMobile: data.customerMobile || '',
    customerName: data.customerName || '',
    customerEmail: data.customerEmail || '',
    linkId: data.linkId || null,
    type: data.type || 'wallet_topup',
    planId: data.planId || null,
    durationMonths: data.durationMonths || null,
    durationDays: data.durationDays || null,
    commissionPercent: data.commissionPercent || null,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    environment: null,
    isTest: !!data.isTest,
    testRedirectUrl: data.testRedirectUrl || null,
    testUseEmbedded: !!data.testUseEmbedded,
    testResult: null,
    paymentMethod: data.paymentMethod || 'zapupi',
    cashierUpiId: data.cashierUpiId || null,
    fampayVerifyUid: data.fampayVerifyUid || null,
    storeId: data.storeId || null,
    productId: data.productId || null,
    routingEngine: data.routingEngine || 'wallet',
    txnId: null,
    utr: null,
  });
}

/**
 * Update payment status (webhook)
 */
async function updatePaymentStatus(orderId, data) {
  const normalizedStatus =
    data.status === 'Success' ? 'success' :
    data.status === 'Failed'  ? 'failed'  :
    'pending';

  const update = {
    status: normalizedStatus,
    txnId: data.txn_id || '',
    utr: data.utr || '',
    payAmount: parseFloat(data.pay_amount || data.amount || 0),
    environment: data.environment || 'cashier',
    updatedAt: serverTimestamp(),
  };
  await ref(`${DB_PATHS.PAYMENTS}/${orderId}`).update(update);
}

/**
 * Get payment by orderId
 */
async function getPayment(orderId) {
  const snap = await ref(`${DB_PATHS.PAYMENTS}/${orderId}`).once('value');
  return snap.exists() ? snap.val() : null;
}

/**
 * Get payments by userId
 */
async function getUserPayments(userId, limit = 50) {
  const RAW_SCAN_SIZE = Math.max(limit * 20, 2000);
  const snap = await ref(DB_PATHS.PAYMENTS)
    .orderByChild('createdAt')
    .limitToLast(RAW_SCAN_SIZE)
    .once('value');

  if (!snap.exists()) return [];
  const payments = [];
  snap.forEach((child) => {
    const val = child.val();
    if (val && val.userId === userId) payments.push(val);
  });
  return payments.sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
}

/**
 * Get all payments (admin)
 */
async function getAllPayments(limit = 100) {
  const snap = await ref(DB_PATHS.PAYMENTS)
    .orderByChild('createdAt')
    .limitToLast(limit)
    .once('value');
  if (!snap.exists()) return [];
  const payments = [];
  snap.forEach((child) => payments.push(child.val()));
  return payments.sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * Check if THIS status for this order was already processed.
 * Storing the status (not just a bare timestamp) means a genuine status
 * transition for the same order — e.g. a payment that first webhooks in
 * as Failed and is later corrected to Success by ZapUPI — is treated as
 * new work instead of being silently dropped as a "duplicate". Only a
 * repeat delivery of the SAME status (Zap retrying its own webhook) is
 * skipped.
 */
async function isOrderProcessed(orderId, status) {
  const snap = await ref(`${DB_PATHS.PROCESSED_ORDERS}/${orderId}`).once('value');
  if (!snap.exists()) return false;
  const recorded = snap.val();
  // Back-compat: older entries were written as a bare serverTimestamp
  // (a number), not { status, processedAt }. Treat those as "processed,
  // status unknown" so we don't accidentally reprocess old orders on
  // deploy — but any NEW write always uses the object form below.
  const recordedStatus = recorded && typeof recorded === 'object' ? recorded.status : undefined;
  if (!recordedStatus) return true;
  return recordedStatus === status;
}

/**
 * Mark order as processed for a given status.
 */
async function markOrderProcessed(orderId, status) {
  await ref(`${DB_PATHS.PROCESSED_ORDERS}/${orderId}`).set({ status: status || null, processedAt: serverTimestamp() });
}

/**
 * Release an early claim made by markOrderProcessed
 */
async function unmarkOrderProcessed(orderId) {
  await ref(`${DB_PATHS.PROCESSED_ORDERS}/${orderId}`).remove();
}

/**
 * Get a payment by its UTR (returns the first match)
 */
async function getPaymentByUtr(utr) {
  if (!utr) return null;
  const snap = await ref(DB_PATHS.PAYMENTS)
    .orderByChild('utr')
    .equalTo(utr)
    .once('value');
  if (!snap.exists()) return null;
  let result = null;
  snap.forEach((child) => {
    result = child.val();
  });
  return result;
}

/**
 * Get a payment by its Transaction ID (txnId)
 */
async function getPaymentByTxnId(txnId) {
  if (!txnId) return null;
  const snap = await ref(DB_PATHS.PAYMENTS)
    .orderByChild('txnId')
    .equalTo(txnId)
    .once('value');
  if (!snap.exists()) return null;
  let result = null;
  snap.forEach((child) => {
    result = child.val();
  });
  return result;
}

/**
 * =============================
 * WITHDRAWAL OPERATIONS
 * =============================
 */

/**
 * Create withdrawal request
 */
async function createWithdrawal(userId, data) {
  const withdrawalRef = ref(DB_PATHS.WITHDRAWALS).push();
  const id = withdrawalRef.key;
  const method = data.method === 'bank' ? 'bank' : 'upi';
  const record = {
    id,
    userId,
    method,
    amount: parseFloat(data.amount),
    commission: parseFloat(data.commission),
    netAmount: parseFloat(data.netAmount),
    status: 'pending',
    adminNote: '',
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
  if (method === 'bank') {
    record.accountNumber = data.accountNumber;
    record.ifscCode = data.ifscCode;
    record.accountHolderName = data.accountHolderName;
    record.accountName = data.accountHolderName || '';
  } else {
    record.upiId = data.upiId;
    record.upiHolderName = data.upiHolderName || '';
    record.accountName = data.upiHolderName || '';
  }
  await withdrawalRef.set(record);
  return id;
}

/**
 * Update withdrawal status (admin)
 */
async function updateWithdrawalStatus(withdrawalId, status, adminNote = '') {
  await ref(`${DB_PATHS.WITHDRAWALS}/${withdrawalId}`).update({
    status,
    adminNote,
    updatedAt: serverTimestamp(),
  });
}

/**
 * Get user withdrawals
 */
async function getUserWithdrawals(userId) {
  const snap = await ref(DB_PATHS.WITHDRAWALS)
    .orderByChild('userId')
    .equalTo(userId)
    .once('value');
  if (!snap.exists()) return [];
  const list = [];
  snap.forEach((child) => { const v = child.val(); if (v) list.push(v); });
  return list.sort((a, b) => (Number(b?.createdAt) || 0) - (Number(a?.createdAt) || 0));
}

/**
 * Get all withdrawals (admin)
 */
async function getAllWithdrawals() {
  const snap = await ref(DB_PATHS.WITHDRAWALS).once('value');
  if (!snap.exists()) return [];
  const list = [];
  snap.forEach((child) => { const v = child.val(); if (v) list.push(v); });
  return list.sort((a, b) => (Number(b?.createdAt) || 0) - (Number(a?.createdAt) || 0));
}

/**
 * Get withdrawal by ID
 */
async function getWithdrawal(withdrawalId) {
  const snap = await ref(`${DB_PATHS.WITHDRAWALS}/${withdrawalId}`).once('value');
  return snap.exists() ? snap.val() : null;
}

/**
 * =============================
 * PLATFORM SETTINGS
 * =============================
 */

/**
 * SINGLE-DEVICE LOGIN
 */
async function setActiveDevice(uid, deviceId, label) {
  await ref(`${DB_PATHS.USERS}/${uid}/activeDevice`).set({
    deviceId,
    label: label || 'Unknown device',
    loginAt: serverTimestamp(),
  });
}

async function clearActiveDevice(uid) {
  await ref(`${DB_PATHS.USERS}/${uid}/activeDevice`).set(null);
}

async function getSettings() {
  const snap = await ref(DB_PATHS.SETTINGS).once('value');
  if (!snap.exists()) return DEFAULT_SETTINGS;
  return { ...DEFAULT_SETTINGS, ...snap.val() };
}

/**
 * Update platform settings (admin)
 */
async function updateSettings(data) {
  await ref(DB_PATHS.SETTINGS).update({
    ...data,
    updatedAt: serverTimestamp(),
  });
}

/**
 * =============================
 * ACTIVITY LOG
 * =============================
 */

/**
 * Log an activity
 */
async function logActivity(userId, action, details = {}) {
  const logRef = ref(DB_PATHS.ACTIVITY_LOGS).push();
  await logRef.set({
    userId,
    action,
    details,
    timestamp: serverTimestamp(),
    ip: details.ip || '',
  });
}

/**
 * Permanently delete a user record from the database.
 */
async function getEffectiveWalletLimit(userId) {
  const { DEFAULT_PLANS } = require('../config/constants');
  const subSnap = await ref(`${DB_PATHS.USER_SUBSCRIPTIONS}/${userId}`).once('value');
  const sub = subSnap.val();
  const planId = (sub && sub.planId) || 'blaze';
  const planSnap = await ref(`${DB_PATHS.PLANS}/${planId}`).once('value');
  const plan = planSnap.val();
  return (plan && plan.walletLimit != null) ? plan.walletLimit
    : (DEFAULT_PLANS[planId] && DEFAULT_PLANS[planId].walletLimit) || DEFAULT_PLANS.blaze.walletLimit;
}

async function deleteUser(uid) {
  const user = await getUser(uid);
  if (user?.referralCode) {
    await ref(`${DB_PATHS.REFERRAL_CODES}/${user.referralCode}`).remove();
  }
  await ref(`${DB_PATHS.USERS}/${uid}`).remove();
}

/**
 * Delete all "unverified" users in one shot
 */
async function deleteUnverifiedUsers() {
  const snap = await ref(DB_PATHS.USERS).once('value');
  if (!snap.exists()) return [];
  const toDelete = [];
  snap.forEach((child) => {
    const u = child.val();
    if (!u) return;
    const noName = !u.displayName || !String(u.displayName).trim();
    const noEmail = !u.email || !String(u.email).trim();
    const noBalance = !u.wallet?.balance || u.wallet.balance <= 0;
    if (noName && noEmail && noBalance) toDelete.push(child.key);
  });
  for (const uid of toDelete) {
    await deleteUser(uid);
  }
  return toDelete;
}

/**
 * Increment payment link stats (called from webhook)
 */
async function incrementPaymentLinkStats(linkId, amount) {
  const linkRef = ref(`${DB_PATHS.PAYMENT_LINKS}/${linkId}`);
  const snap = await linkRef.once('value');
  if (!snap.exists()) return;
  await linkRef.update({
    paymentCount: (snap.val().paymentCount || 0) + 1,
    totalCollected: (snap.val().totalCollected || 0) + parseFloat(amount),
    lastPaidAt: Date.now(),
  });
}

module.exports = {
  // Users
  getUser,
  upsertUser,
  updateUserProfile,
  getAllUsers,
  setBanStatus,
  generateReferralCode,
  getUidByReferralCode,
  deleteUser,
  deleteUnverifiedUsers,
  getEffectiveWalletLimit,
  // Payments
  createPayment,
  updatePaymentStatus,
  getPayment,
  getUserPayments,
  getAllPayments,
  isOrderProcessed,
  markOrderProcessed,
  unmarkOrderProcessed,
  getPaymentByUtr,
  getPaymentByTxnId,
  // Withdrawals
  createWithdrawal,
  updateWithdrawalStatus,
  getUserWithdrawals,
  getAllWithdrawals,
  getWithdrawal,
  // Settings
  getSettings,
  updateSettings,
  setActiveDevice,
  clearActiveDevice,
  // Logs
  logActivity,
  getUserActivityLog,
  // Misc
  incrementPaymentLinkStats,
};
