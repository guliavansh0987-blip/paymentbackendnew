// controllers/authController.js
const jwt = require('jsonwebtoken');
const { getAuth } = require('../firebase/admin');
const firebaseService = require('../services/firebaseService');
const response = require('../helpers/response');
const logger = require('../utils/logger');

/**
 * POST /api/auth/google
 * Works for ALL Firebase auth methods:
 * - Google Sign-In
 * - Email/Password Sign-In
 * - Email/Password Register
 * Firebase issues same ID token format for all methods.
 */
const googleAuth = async (req, res) => {
  try {
    const { idToken, referralCode, deviceId, deviceLabel } = req.body;
    if (!idToken) return response.error(res, 'Firebase ID token is required');

    // Verify Firebase ID token (works for any Firebase auth provider)
    let decodedToken;
    try {
      decodedToken = await getAuth().verifyIdToken(idToken);
    } catch (err) {
      logger.warn(`Invalid Firebase token: ${err.message}`);
      return response.unauthorized(res, 'Invalid or expired token. Please sign in again.');
    }

    const { uid, email, name, picture, firebase } = decodedToken;

    // Check maintenance mode
    const settings = await firebaseService.getSettings();
    const existingUser = await firebaseService.getUser(uid);

    // Banned users are still allowed to log in — the frontend shows them a
    // dedicated suspended screen (with the reason + a support chat) instead
    // of the dashboard. Every other endpoint stays off-limits to them via
    // the blockIfBanned middleware. They also bypass maintenance mode so
    // they can always reach that screen.
    if (settings.maintenanceMode && existingUser?.role !== 'admin' && !existingUser?.isBanned) {
      return response.error(res, 'Platform is under maintenance. Please try again later.', 503);
    }

    // Multi-device login is now allowed — an account can be signed in on
    // any number of devices at once. (Previously this blocked a second
    // device unless the first was logged out; removed per product
    // decision. See adminResetLoginActivity in adminController.js for the
    // admin-side "force everyone out" tool that replaces the old
    // single-device lock as the way to fully reset a compromised account.)

    // Upsert user — works for both Google and Email/Password
    const user = await firebaseService.upsertUser(uid, {
      email,
      displayName: name || email?.split('@')[0] || 'User',
      photoURL: picture || '',
      authProvider: firebase?.sign_in_provider || 'unknown',
      referralCode,
    });

    // Multi-device login: no device slot is claimed anymore, so nothing
    // to set here — every device gets its own valid token independently.

    // Generate JWT — tokenVersion is embedded so admin's "Reset Login
    // Activity" can invalidate every outstanding token for this account at
    // once (bump the stored version; old tokens carry the old number and
    // stop verifying) without needing a device concept at all.
    const token = jwt.sign(
      { uid, email, role: user.role, tokenVersion: user.tokenVersion || 0 },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '30d' }
    );

    await firebaseService.logActivity(uid, 'LOGIN', {
      method: firebase?.sign_in_provider || 'unknown',
      ip: req.ip,
      deviceLabel: deviceLabel || '',
    });

    logger.info(`User logged in: ${email} [${firebase?.sign_in_provider}]`);

    return response.success(res, 'Login successful', {
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
        isNewUser: !!user.isNewUser,
        authProvider: user.authProvider || '',
      },
    });
  } catch (err) {
    logger.error('Auth error:', err.message);
    return response.serverError(res, 'Authentication failed. Please try again.');
  }
};

/** GET /api/auth/me */
const getMe = async (req, res) => {
  try {
    const user = await firebaseService.getUser(req.user.uid);
    if (!user) return response.notFound(res, 'User not found');
    return response.success(res, 'User fetched', {
      uid: user.uid,
      email: user.email,
      displayName: user.displayName,
      photoURL: user.photoURL,
      phone: user.phone || '',
      upiId: user.upiId || '',
      upiHolderName: user.upiHolderName || '',
      bankDetails: user.bankDetails || null,
      checkoutTheme: user.checkoutTheme || 'default',
      // Defaults to true (not false) so every EXISTING user — who never
      // had this field before today — keeps seeing onboarding popups
      // exactly like before; only explicitly saving showOnboarding=false
      // from the toggle turns it off.
      showOnboarding: user.showOnboarding !== false,
      authProvider: user.authProvider || '',
      role: user.role,
      walletBalance: user.wallet?.balance || 0,
      bonusBalance: user.wallet?.bonusBalance || 0,
      isBanned: !!user.isBanned,
      banReason: user.banReason || '',
      impersonating: !!req.user.impersonatedBy,
      createdAt: user.createdAt,
      lastLoginAt: user.lastLoginAt,
    });
  } catch (err) {
    return response.serverError(res, err.message);
  }
};

/** POST /api/auth/logout */
const logout = async (req, res) => {
  try {
    await firebaseService.clearActiveDevice(req.user.uid);
    await firebaseService.logActivity(req.user.uid, 'LOGOUT', { ip: req.ip });
  } catch {}
  return response.success(res, 'Logged out successfully');
};

module.exports = { googleAuth, getMe, logout };
