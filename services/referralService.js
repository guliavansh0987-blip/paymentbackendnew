// services/referralService.js
const { ref, serverTimestamp } = require('../firebase/admin');
const { DB_PATHS } = require('../config/constants');
const firebaseService = require('./firebaseService');
const walletService = require('./walletService');
const notificationService = require('./notificationService');
const logger = require('../utils/logger');

/**
 * Get full referral dashboard data for a user: their code, stats, and
 * the list of people they've referred (with status).
 */
async function getReferralData(uid) {
  const user = await firebaseService.getUser(uid);

  const snap = await ref(`${DB_PATHS.REFERRALS}/${uid}`).once('value');
  const referrals = [];
  if (snap.exists()) snap.forEach((child) => referrals.push(child.val()));
  referrals.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  const totalIncome = referrals.reduce((s, r) => s + (r.commission || 0), 0);

  const now = new Date();
  const thisMonthIncome = referrals
    .filter((r) => {
      if (!r.completedAt) return false;
      const d = new Date(r.completedAt);
      return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
    })
    .reduce((s, r) => s + (r.commission || 0), 0);

  return {
    referralCode: user?.referralCode || '',
    totalReferrals: referrals.length,
    completedReferrals: referrals.filter((r) => r.status === 'completed').length,
    totalIncome,
    thisMonthIncome,
    referrals,
  };
}

/**
 * Called after a successful WALLET TOP-UP (self-funded "Add Money", not
 * money received via payment links from customers). If this user was
 * referred and this deposit meets the qualifying minimum, and they
 * haven't already triggered a reward, credit the referrer's wallet.
 */
async function processQualifyingDeposit(uid, depositAmount) {
  try {
    const user = await firebaseService.getUser(uid);
    if (!user || !user.referredBy) return;

    const settings = await firebaseService.getSettings();
    const minDeposit = settings.referralQualifyingMinDeposit || 100;
    if (depositAmount < minDeposit) return;

    const refRef = ref(`${DB_PATHS.REFERRALS}/${user.referredBy}/${uid}`);
    const refSnap = await refRef.once('value');
    if (!refSnap.exists()) return;
    const refData = refSnap.val();
    if (refData.status === 'completed') return; // already rewarded — one-time only

    const commPct = refData.commissionPercent || settings.referralCommissionPercent || 25;
    const commission = Math.round(depositAmount * commPct) / 100;

    await walletService.creditWallet(
      user.referredBy,
      commission,
      `Referral commission from ${user.displayName || uid}`
    );

    await refRef.update({
      status: 'completed',
      purchaseAmount: depositAmount,
      commission,
      completedAt: serverTimestamp(),
    });

    await notificationService.createNotification(user.referredBy, {
      title: '🎉 Referral Commission Earned!',
      message: `${user.displayName || 'Your referral'} made a qualifying deposit of ₹${depositAmount}. You earned ₹${commission} (${commPct}%)!`,
      type: 'general',
    });

    logger.info(`Referral reward: ${user.referredBy} +₹${commission} (from ${uid})`);
  } catch (err) {
    logger.error('processQualifyingDeposit error:', err.message);
  }
}

module.exports = { getReferralData, processQualifyingDeposit };
