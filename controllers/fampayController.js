// controllers/fampayController.js
//
// Multi-account FamPay Connect: a merchant can save up to 3 FamPay
// accounts (each with its own phone/UPI ID/Gmail/app-password), see them
// in a list with a 4-digit cashier ID and Active/Inactive status, and
// toggle exactly one as the account actually used for checkout.
//
// Storage shape: user.fampayAccounts = { <cashierId>: { upiId, mobile,
// email, password (encrypted), isVerified, isActive, createdAt } }
//
// IMPORTANT — backward compatibility: every payment-routing controller
// across the codebase (paymentController, paymentLinkController,
// storeController, storePublicController, developerController,
// adminController, fampayService) reads a single user.fampay object
// directly and has no awareness of accounts/lists. Rather than touching
// all of those call sites, this controller keeps user.fampay mirrored to
// whichever account in fampayAccounts is currently isActive — so
// switching the active account here transparently changes what every one
// of those existing routes uses, with zero changes needed there.
const axios = require('axios');
const encryption = require('../utils/encryption');
const response = require('../helpers/response');
const firebaseService = require('../services/firebaseService');
const { ref } = require('../firebase/admin');
const { DB_PATHS } = require('../config/constants');
const logger = require('../utils/logger');

const HISTORY_API_URL = 'https://zetpay.online/history.php';
const MAX_ACCOUNTS = 3;

// 4-digit numeric id, unique within this merchant's own account list —
// short enough to read at a glance (matches the "440" / "2700" style ids
// in the competitor screenshot), collision-checked against what this
// merchant already has rather than being globally unique (no need for
// that — these ids are only ever looked up scoped to one merchant).
function generateCashierId(existingIds) {
  let id;
  do {
    id = String(Math.floor(1000 + Math.random() * 9000));
  } while (existingIds.includes(id));
  return id;
}

// Re-applies whichever account is isActive (if any) onto user.fampay —
// the single-object mirror every other controller reads. Called after
// every mutation (add/verify/toggle/remove) so that mirror never drifts
// from the account list's own idea of what's active.
async function syncActiveAccountToLegacyField(uid, accounts) {
  const activeEntry = Object.entries(accounts || {}).find(([, acc]) => acc.isActive);

  if (!activeEntry) {
    await ref(`${DB_PATHS.USERS}/${uid}/fampay`).remove();
    await ref(`${DB_PATHS.USERS}/${uid}`).update({ apiRoutingEngine: 'wallet' });
    return;
  }

  const [, acc] = activeEntry;
  await ref(`${DB_PATHS.USERS}/${uid}/fampay`).set({
    upiId: acc.upiId,
    email: acc.email,
    password: acc.password,
    mobile: acc.mobile,
    isConnected: true,
    connectedAt: acc.createdAt,
  });
  await ref(`${DB_PATHS.USERS}/${uid}`).update({ apiRoutingEngine: 'cashier' });
}

// One-time backward migration: a merchant who connected FamPay BEFORE
// multi-account support existed only has legacy user.fampay populated —
// fampayAccounts would be empty even though they genuinely have a
// working, verified connection. Rather than making that account
// invisible in the new list UI (and implicitly asking them to
// re-verify something that already works), fold it into fampayAccounts
// as a real, already-active, already-verified entry the first time this
// is read after the update. Runs at most once per merchant — after this,
// fampayAccounts is non-empty and this branch never runs again for them.
async function migrateLegacyFampayIfNeeded(uid, user) {
  const hasAccounts = user?.fampayAccounts && Object.keys(user.fampayAccounts).length > 0;
  if (hasAccounts) return user.fampayAccounts;
  if (!user?.fampay || !user.fampay.isConnected) return {};

  const cashierId = generateCashierId([]);
  const migrated = {
    upiId: user.fampay.upiId || '',
    mobile: user.fampay.mobile || '',
    email: user.fampay.email || null,
    password: user.fampay.password || null, // already encrypted — carried over as-is, not re-encrypted
    isVerified: true, // it was working under the old single-account system, so it already passed a real Gmail check
    isActive: true,
    createdAt: user.fampay.connectedAt || Date.now(),
  };
  await ref(`${DB_PATHS.USERS}/${uid}/fampayAccounts/${cashierId}`).set(migrated);
  return { [cashierId]: migrated };
}

const getFampayAccounts = async (req, res) => {
  try {
    const user = await firebaseService.getUser(req.user.uid);
    const accounts = await migrateLegacyFampayIfNeeded(req.user.uid, user);

    const list = Object.entries(accounts).map(([cashierId, acc]) => ({
      cashierId,
      upiId: acc.upiId,
      mobile: acc.mobile,
      email: acc.email,
      isVerified: !!acc.isVerified,
      isActive: !!acc.isActive,
      createdAt: acc.createdAt,
      // Password is intentionally never sent back to the frontend.
    })).sort((a, b) => a.createdAt - b.createdAt);

    return response.success(res, 'FamPay accounts fetched', {
      accounts: list,
      maxAccounts: MAX_ACCOUNTS,
      canAddMore: list.length < MAX_ACCOUNTS,
    });
  } catch (err) {
    logger.error('Get FamPay Accounts Error:', err.message);
    return response.serverError(res, err.message);
  }
};

// Step 1 of the add-account popup: phone + UPI ID only, no verification
// yet. Saved immediately as isVerified:false / isActive:false — the
// account shows up in the list right away (Status: Inactive) even if the
// user abandons step 2, rather than silently losing what they entered.
const addFampayAccountBasic = async (req, res) => {
  try {
    const { upiId, mobile } = req.body;
    if (!upiId || !mobile) {
      return response.error(res, 'UPI ID and mobile number are required', 400);
    }
    if (!/^[\w.\-]+@fam$/i.test(upiId.trim())) {
      return response.error(res, 'FamPay UPI ID should look like username@fam', 400);
    }
    if (!/^[6-9]\d{9}$/.test(mobile.trim())) {
      return response.error(res, 'Enter a valid 10-digit mobile number', 400);
    }

    const user = await firebaseService.getUser(req.user.uid);
    const accounts = user?.fampayAccounts || {};
    const existingIds = Object.keys(accounts);

    if (existingIds.length >= MAX_ACCOUNTS) {
      return response.error(res, `You can connect up to ${MAX_ACCOUNTS} FamPay accounts. Remove one before adding another.`, 400);
    }

    const cashierId = generateCashierId(existingIds);
    await ref(`${DB_PATHS.USERS}/${req.user.uid}/fampayAccounts/${cashierId}`).set({
      upiId: upiId.trim(),
      mobile: mobile.trim(),
      email: null,
      password: null,
      isVerified: false,
      isActive: false,
      createdAt: Date.now(),
    });

    return response.success(res, 'Account created — now verify your Gmail to activate it', { cashierId });
  } catch (err) {
    logger.error('Add FamPay Account (basic) Error:', err.message);
    return response.serverError(res, err.message);
  }
};

// Step 2: Gmail + app password, verified against history.php the same
// way the old single-account connectFampay did. On success this marks
// the account isVerified:true — it still isn't necessarily the ACTIVE
// one (that's a separate, explicit toggle) unless this is the merchant's
// first-ever verified account, in which case it's activated automatically
// so a brand-new merchant doesn't have to know to flip a switch just to
// get their first account working.
const verifyFampayAccount = async (req, res) => {
  try {
    const { cashierId, email, password } = req.body;
    if (!cashierId || !email || !password) {
      return response.error(res, 'Email and App Password are required', 400);
    }

    const user = await firebaseService.getUser(req.user.uid);
    const accounts = user?.fampayAccounts || {};
    if (!accounts[cashierId]) {
      return response.error(res, 'Account not found', 404);
    }

    const apiRes = await axios.post(HISTORY_API_URL, { email, pass: password, limit: 1 });
    if (!apiRes.data || !apiRes.data.status) {
      const detail = (apiRes.data && (apiRes.data.error || apiRes.data.raw_error)) || 'IMAP Auth failed.';
      return response.error(res, 'Invalid Email or App Password: ' + detail, 400);
    }

    const encryptedPassword = encryption.encrypt(password);
    const hasAnyVerifiedAccount = Object.values(accounts).some(acc => acc.isVerified);

    await ref(`${DB_PATHS.USERS}/${req.user.uid}/fampayAccounts/${cashierId}`).update({
      email,
      password: encryptedPassword,
      isVerified: true,
      // First verified account for this merchant auto-activates; if they
      // already have one active, leave activation to the explicit toggle
      // below so verifying a 2nd/3rd account never silently switches
      // which one checkout is using.
      isActive: hasAnyVerifiedAccount ? !!accounts[cashierId].isActive : true,
    });

    const updatedUser = await firebaseService.getUser(req.user.uid);
    await syncActiveAccountToLegacyField(req.user.uid, updatedUser?.fampayAccounts || {});

    return response.success(res, 'FamPay account verified successfully');
  } catch (err) {
    logger.error('Verify FamPay Account Error:', err.message);
    return response.serverError(res, 'Verification failed: ' + err.message);
  }
};

// Explicit single-active toggle — activating one account deactivates
// every other one for this merchant, enforced server-side (not just left
// to the frontend) since this directly controls which inbox real
// payments get verified against.
const setActiveFampayAccount = async (req, res) => {
  try {
    const { cashierId } = req.body;
    if (!cashierId) return response.error(res, 'cashierId is required', 400);

    const user = await firebaseService.getUser(req.user.uid);
    const accounts = user?.fampayAccounts || {};
    if (!accounts[cashierId]) return response.error(res, 'Account not found', 404);
    if (!accounts[cashierId].isVerified) {
      return response.error(res, 'Verify this account (connect Gmail) before activating it.', 400);
    }

    const updates = {};
    Object.keys(accounts).forEach(id => {
      updates[`fampayAccounts/${id}/isActive`] = (id === cashierId);
    });
    await ref(`${DB_PATHS.USERS}/${req.user.uid}`).update(updates);

    const updatedUser = await firebaseService.getUser(req.user.uid);
    await syncActiveAccountToLegacyField(req.user.uid, updatedUser?.fampayAccounts || {});

    return response.success(res, 'Active FamPay account updated');
  } catch (err) {
    logger.error('Set Active FamPay Account Error:', err.message);
    return response.serverError(res, err.message);
  }
};

const removeFampayAccount = async (req, res) => {
  try {
    const { cashierId } = req.body;
    if (!cashierId) return response.error(res, 'cashierId is required', 400);

    await ref(`${DB_PATHS.USERS}/${req.user.uid}/fampayAccounts/${cashierId}`).remove();

    const updatedUser = await firebaseService.getUser(req.user.uid);
    await syncActiveAccountToLegacyField(req.user.uid, updatedUser?.fampayAccounts || {});
    await firebaseService.logActivity(req.user.uid, 'FAMPAY_ACCOUNT_REMOVED', { cashierId });

    return response.success(res, 'Account removed');
  } catch (err) {
    logger.error('Remove FamPay Account Error:', err.message);
    return response.serverError(res, err.message);
  }
};

// ── Legacy single-account endpoints, kept working ──
// Some older frontend builds (or this same page mid-deploy) may still
// call /status, /connect, /disconnect directly. /status now reads the
// active account out of the new list; /connect and /disconnect are
// thin wrappers so nothing 404s during a rolling deploy.
const getFampayStatus = async (req, res) => {
  try {
    const user = await firebaseService.getUser(req.user.uid);

    if (user && user.fampay && user.fampay.isConnected) {
      return response.success(res, 'FamPay is connected', {
        isConnected: true,
        upiId: user.fampay.upiId,
        email: user.fampay.email,
        mobile: user.fampay.mobile
      });
    }

    return response.success(res, 'FamPay is disconnected', { isConnected: false });
  } catch (err) {
    logger.error('Get FamPay Status Error:', err.message);
    return response.serverError(res, err.message);
  }
};

const disconnectFampay = async (req, res) => {
  try {
    await ref(`${DB_PATHS.USERS}/${req.user.uid}/fampay`).remove();
    await ref(`${DB_PATHS.USERS}/${req.user.uid}`).update({ apiRoutingEngine: 'wallet' });
    await firebaseService.logActivity(req.user.uid, 'FAMPAY_DISCONNECTED', { routingResetTo: 'wallet' });
    return response.success(res, 'FamPay disconnected successfully');
  } catch (err) {
    logger.error('Disconnect FamPay Error:', err.message);
    return response.serverError(res, err.message);
  }
};

const getHistory = async (req, res) => {
  try {
    const user = await firebaseService.getUser(req.user.uid);

    if (!user || !user.fampay || !user.fampay.isConnected) {
      return response.error(res, 'FamPay is not connected. Please connect first.', 400);
    }

    const rawPassword = encryption.decrypt(user.fampay.password);
    if (!rawPassword) {
      return response.error(res, 'Failed to decrypt app password. Please reconnect FamPay.', 400);
    }

    const apiRes = await axios.post(HISTORY_API_URL, {
      email: user.fampay.email,
      pass: rawPassword,
      limit: 15
    });

    if (!apiRes.data || !apiRes.data.status) {
      return response.error(res, apiRes.data?.error || 'Failed to fetch emails from server.', 400);
    }

    return response.success(res, 'History fetched', apiRes.data.data);
  } catch (err) {
    logger.error('Fetch History Error:', err.message);
    return response.serverError(res, 'Error fetching history: ' + err.message);
  }
};

module.exports = {
  getFampayAccounts,
  addFampayAccountBasic,
  verifyFampayAccount,
  setActiveFampayAccount,
  removeFampayAccount,
  getFampayStatus,
  disconnectFampay,
  getHistory,
};
