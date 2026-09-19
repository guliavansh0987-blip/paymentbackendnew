// middleware/auth.js - JWT Authentication Middleware
const jwt = require('jsonwebtoken');
const { ref } = require('../firebase/admin');
const response = require('../helpers/response');
const logger = require('../utils/logger');

/**
 * Verify JWT token and attach user to request
 */
const authenticate = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return response.unauthorized(res, 'No token provided');
    }

    const token = authHeader.split(' ')[1];

    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (err) {
      if (err.name === 'TokenExpiredError') {
        return response.unauthorized(res, 'Token expired. Please login again.');
      }
      return response.unauthorized(res, 'Invalid token');
    }

    // Check if user still exists and is active
    const userSnap = await ref(`users/${decoded.uid}`).once('value');
    if (!userSnap.exists()) {
      return response.unauthorized(res, 'User not found');
    }

    const user = userSnap.val();

    // A token's tokenVersion must match the one currently stored on the
    // user record. Admin's "Reset Login Activity" bumps the stored value,
    // which instantly invalidates every token issued before that point —
    // this is what actually forces every device to log in again, since
    // there's no device slot to clear anymore (multi-device is allowed).
    // Skipped for impersonation tokens, which carry no tokenVersion at all.
    if (!decoded.impersonatedBy && (decoded.tokenVersion || 0) !== (user.tokenVersion || 0)) {
      return response.unauthorized(res, 'Your session was reset. Please log in again.');
    }

    // NOTE: banned users are still authenticated here (so they can reach
    // /auth/me, /auth/logout and the /support chat endpoints and see why
    // they were suspended). Routes that must stay off-limits to a banned
    // user add `blockIfBanned` after `authenticate` — see below.
    req.user = {
      uid: decoded.uid,
      email: decoded.email,
      role: user.role || 'user',
      isBanned: !!user.isBanned,
      banReason: user.banReason || '',
      impersonatedBy: decoded.impersonatedBy || null, // set only on admin "Login as User" tokens
    };

    next();
  } catch (err) {
    logger.error('Auth middleware error:', err.message);
    return response.serverError(res, err.message);
  }
};

/**
 * Optional auth - attach user if token present, continue either way
 */
const optionalAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return next();
    }

    const token = authHeader.split(' ')[1];
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      req.user = { uid: decoded.uid, email: decoded.email, role: decoded.role };
    } catch {
      // Invalid token - continue as unauthenticated
    }

    next();
  } catch (err) {
    next();
  }
};

/**
 * Blocks a banned user from a route. Must run AFTER `authenticate` (needs
 * req.user). Kept separate from `authenticate` on purpose — /auth/me,
 * /auth/logout and /support/* stay reachable for a banned user, everything
 * else (wallet, payments, links, withdrawals, etc.) uses this.
 */
const blockIfBanned = (req, res, next) => {
  if (req.user && req.user.isBanned) {
    return res.status(403).json({
      success: false,
      message: 'Your account has been suspended.',
      banned: true,
      banReason: req.user.banReason || '',
    });
  }
  next();
};

/**
 * Blocks the highest-risk, money-moving actions while an admin is using a
 * "Login as User" session (Controller → Login as User). Investigation-only
 * by design — an impersonated session can look at everything but can't
 * request a withdrawal or change payout details, so this can never itself
 * become a way to move a user's money.
 */
const blockIfImpersonating = (req, res, next) => {
  if (req.user && req.user.impersonatedBy) {
    return res.status(403).json({
      success: false,
      message: 'This action is disabled during an admin-assisted session.',
      impersonationBlocked: true,
    });
  }
  next();
};

module.exports = { authenticate, optionalAuth, blockIfBanned, blockIfImpersonating };
