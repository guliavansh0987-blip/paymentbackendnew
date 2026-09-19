// controllers/paytmController.js
//
// Multi-account Paytm Connect — same shape as the multi-account
// fampayController.js: up to 3 saved accounts, 4-digit cashier ids,
// Active/Inactive status, one explicit active toggle. See
// fampayController.js's header comment for the full rationale on why
// user.paytm is kept mirrored to the active account rather than updating
// every payment-routing controller to understand a list.
//
// Storage shape: user.paytmAccounts = { <cashierId>: { mid (encrypted),
// upiId, mobile, isVerified, isActive, createdAt } }
const axios = require('axios');
const encryption = require('../utils/encryption');
const response = require('../helpers/response');
const firebaseService = require('../services/firebaseService');
const { ref } = require('../firebase/admin');
const { DB_PATHS } = require('../config/constants');
const logger = require('../utils/logger');

const PAYTM_STATUS_URL = 'https://securegw.paytm.in/order/status';
const MAX_ACCOUNTS = 3;
const MID_PATTERN = /^[A-Za-z0-9]{6,20}$/;

function generateCashierId(existingIds) {
  let id;
  do {
    id = String(Math.floor(1000 + Math.random() * 9000));
  } while (existingIds.includes(id));
  return id;
}

async function syncActiveAccountToLegacyField(uid, accounts) {
  const activeEntry = Object.entries(accounts || {}).find(([, acc]) => acc.isActive);

  if (!activeEntry) {
    await ref(`${DB_PATHS.USERS}/${uid}/paytm`).remove();
    await ref(`${DB_PATHS.USERS}/${uid}`).update({ apiRoutingEngine: 'wallet' });
    return;
  }

  const [, acc] = activeEntry;
  await ref(`${DB_PATHS.USERS}/${uid}/paytm`).set({
    mid: acc.mid,
    upiId: acc.upiId,
    mobile: acc.mobile,
    isConnected: true,
    connectedAt: acc.createdAt,
  });
  await ref(`${DB_PATHS.USERS}/${uid}`).update({ apiRoutingEngine: 'paytm_cashier' });
}

async function probeMid(mid) {
  const probeRes = await axios.get(PAYTM_STATUS_URL, {
    params: { JsonData: JSON.stringify({ MID: mid, ORDERID: 'ZETPAY_CONNECT_PROBE' }) },
    timeout: 8000,
  });
  if (!probeRes.data || typeof probeRes.data !== 'object' || !probeRes.data.MID) return false;
  return probeRes.data.MID === mid;
}

// One-time backward migration — see fampayController.js's identical
// function for the full rationale. A merchant who connected Paytm via
// the old single-account flow only has user.paytm populated; fold it
// into paytmAccounts as an already-active, already-verified entry the
// first time this is read post-update.
async function migrateLegacyPaytmIfNeeded(uid, user) {
  const hasAccounts = user?.paytmAccounts && Object.keys(user.paytmAccounts).length > 0;
  if (hasAccounts) return user.paytmAccounts;
  if (!user?.paytm || !user.paytm.isConnected) return {};

  const cashierId = generateCashierId([]);
  const migrated = {
    upiId: user.paytm.upiId || '',
    mobile: user.paytm.mobile || '',
    mid: user.paytm.mid || null, // already encrypted — carried over as-is
    isVerified: true,
    isActive: true,
    createdAt: user.paytm.connectedAt || Date.now(),
  };
  await ref(`${DB_PATHS.USERS}/${uid}/paytmAccounts/${cashierId}`).set(migrated);
  return { [cashierId]: migrated };
}

const getPaytmAccounts = async (req, res) => {
  try {
    const user = await firebaseService.getUser(req.user.uid);
    const accounts = await migrateLegacyPaytmIfNeeded(req.user.uid, user);

    const list = Object.entries(accounts).map(([cashierId, acc]) => ({
      cashierId,
      upiId: acc.upiId,
      mobile: acc.mobile,
      isVerified: !!acc.isVerified,
      isActive: !!acc.isActive,
      createdAt: acc.createdAt,
    })).sort((a, b) => a.createdAt - b.createdAt);

    return response.success(res, 'Paytm accounts fetched', {
      accounts: list,
      maxAccounts: MAX_ACCOUNTS,
      canAddMore: list.length < MAX_ACCOUNTS,
    });
  } catch (err) {
    logger.error('Get Paytm Accounts Error:', err.message);
    return response.serverError(res, err.message);
  }
};

const addPaytmAccountBasic = async (req, res) => {
  try {
    const { upiId, mobile } = req.body;
    if (!upiId || !mobile) {
      return response.error(res, 'UPI ID and mobile number are required', 400);
    }
    if (!/^[\w.\-]+@\w+$/i.test(upiId.trim())) {
      return response.error(res, 'Enter a valid UPI ID (e.g. name@paytm)', 400);
    }
    if (!/^[6-9]\d{9}$/.test(mobile.trim())) {
      return response.error(res, 'Enter a valid 10-digit mobile number', 400);
    }

    const user = await firebaseService.getUser(req.user.uid);
    const accounts = user?.paytmAccounts || {};
    const existingIds = Object.keys(accounts);

    if (existingIds.length >= MAX_ACCOUNTS) {
      return response.error(res, `You can connect up to ${MAX_ACCOUNTS} Paytm accounts. Remove one before adding another.`, 400);
    }

    const cashierId = generateCashierId(existingIds);
    await ref(`${DB_PATHS.USERS}/${req.user.uid}/paytmAccounts/${cashierId}`).set({
      upiId: upiId.trim(),
      mobile: mobile.trim(),
      mid: null,
      isVerified: false,
      isActive: false,
      createdAt: Date.now(),
    });

    return response.success(res, 'Account created — now verify your Merchant ID to activate it', { cashierId });
  } catch (err) {
    logger.error('Add Paytm Account (basic) Error:', err.message);
    return response.serverError(res, err.message);
  }
};

const verifyPaytmAccount = async (req, res) => {
  try {
    const { cashierId, mid } = req.body;
    if (!cashierId || !mid) {
      return response.error(res, 'Merchant ID is required', 400);
    }
    if (!MID_PATTERN.test(mid.trim())) {
      return response.error(res, 'Merchant ID looks invalid — check it against your Paytm Business Dashboard.', 400);
    }

    const user = await firebaseService.getUser(req.user.uid);
    const accounts = user?.paytmAccounts || {};
    if (!accounts[cashierId]) {
      return response.error(res, 'Account not found', 404);
    }

    let midOk;
    try {
      midOk = await probeMid(mid.trim());
    } catch (probeErr) {
      logger.error('Paytm MID probe failed:', probeErr.message);
      return response.error(res, 'Could not reach Paytm to verify this Merchant ID. Please try again shortly.', 400);
    }
    if (!midOk) {
      return response.error(res, 'Could not verify this Merchant ID with Paytm. Double-check it and try again.', 400);
    }

    const encryptedMid = encryption.encrypt(mid.trim());
    const hasAnyVerifiedAccount = Object.values(accounts).some(acc => acc.isVerified);

    await ref(`${DB_PATHS.USERS}/${req.user.uid}/paytmAccounts/${cashierId}`).update({
      mid: encryptedMid,
      isVerified: true,
      isActive: hasAnyVerifiedAccount ? !!accounts[cashierId].isActive : true,
    });

    const updatedUser = await firebaseService.getUser(req.user.uid);
    await syncActiveAccountToLegacyField(req.user.uid, updatedUser?.paytmAccounts || {});

    return response.success(res, 'Paytm account verified successfully');
  } catch (err) {
    logger.error('Verify Paytm Account Error:', err.message);
    return response.serverError(res, 'Verification failed: ' + err.message);
  }
};

const setActivePaytmAccount = async (req, res) => {
  try {
    const { cashierId } = req.body;
    if (!cashierId) return response.error(res, 'cashierId is required', 400);

    const user = await firebaseService.getUser(req.user.uid);
    const accounts = user?.paytmAccounts || {};
    if (!accounts[cashierId]) return response.error(res, 'Account not found', 404);
    if (!accounts[cashierId].isVerified) {
      return response.error(res, 'Verify this account (confirm Merchant ID) before activating it.', 400);
    }

    const updates = {};
    Object.keys(accounts).forEach(id => {
      updates[`paytmAccounts/${id}/isActive`] = (id === cashierId);
    });
    await ref(`${DB_PATHS.USERS}/${req.user.uid}`).update(updates);

    const updatedUser = await firebaseService.getUser(req.user.uid);
    await syncActiveAccountToLegacyField(req.user.uid, updatedUser?.paytmAccounts || {});

    return response.success(res, 'Active Paytm account updated');
  } catch (err) {
    logger.error('Set Active Paytm Account Error:', err.message);
    return response.serverError(res, err.message);
  }
};

const removePaytmAccount = async (req, res) => {
  try {
    const { cashierId } = req.body;
    if (!cashierId) return response.error(res, 'cashierId is required', 400);

    await ref(`${DB_PATHS.USERS}/${req.user.uid}/paytmAccounts/${cashierId}`).remove();

    const updatedUser = await firebaseService.getUser(req.user.uid);
    await syncActiveAccountToLegacyField(req.user.uid, updatedUser?.paytmAccounts || {});
    await firebaseService.logActivity(req.user.uid, 'PAYTM_ACCOUNT_REMOVED', { cashierId });

    return response.success(res, 'Account removed');
  } catch (err) {
    logger.error('Remove Paytm Account Error:', err.message);
    return response.serverError(res, err.message);
  }
};

const getPaytmStatus = async (req, res) => {
  try {
    const user = await firebaseService.getUser(req.user.uid);

    if (user && user.paytm && user.paytm.isConnected) {
      return response.success(res, 'Paytm is connected', {
        isConnected: true,
        upiId: user.paytm.upiId,
        mobile: user.paytm.mobile,
      });
    }

    return response.success(res, 'Paytm is disconnected', { isConnected: false });
  } catch (err) {
    logger.error('Get Paytm Status Error:', err.message);
    return response.serverError(res, err.message);
  }
};

const disconnectPaytm = async (req, res) => {
  try {
    await ref(`${DB_PATHS.USERS}/${req.user.uid}/paytm`).remove();
    await ref(`${DB_PATHS.USERS}/${req.user.uid}`).update({ apiRoutingEngine: 'wallet' });
    await firebaseService.logActivity(req.user.uid, 'PAYTM_DISCONNECTED', { routingResetTo: 'wallet' });
    return response.success(res, 'Paytm disconnected successfully');
  } catch (err) {
    logger.error('Disconnect Paytm Error:', err.message);
    return response.serverError(res, err.message);
  }
};

module.exports = {
  getPaytmAccounts,
  addPaytmAccountBasic,
  verifyPaytmAccount,
  setActivePaytmAccount,
  removePaytmAccount,
  getPaytmStatus,
  disconnectPaytm,
};
