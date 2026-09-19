// middleware/adminAuth.js - Admin Role Check Middleware
const { ref } = require('../firebase/admin');
const response = require('../helpers/response');
const logger = require('../utils/logger');

/**
 * Check if authenticated user has admin role
 * Must be used AFTER authenticate middleware
 */
const requireAdmin = async (req, res, next) => {
  try {
    if (!req.user) {
      return response.unauthorized(res);
    }

    // Fetch fresh role from DB to prevent stale JWT role
    const userSnap = await ref(`users/${req.user.uid}`).once('value');
    if (!userSnap.exists()) {
      return response.unauthorized(res, 'User not found');
    }

    const user = userSnap.val();

    if (user.role !== 'admin') {
      return response.forbidden(res, 'Admin access required');
    }

    // Update req.user with fresh data
    req.user.role = 'admin';
    req.adminUser = user;

    next();
  } catch (err) {
    logger.error('Admin auth middleware error:', err.message);
    return response.serverError(res, err.message);
  }
};

module.exports = { requireAdmin };
