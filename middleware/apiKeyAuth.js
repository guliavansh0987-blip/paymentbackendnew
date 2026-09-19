// middleware/apiKeyAuth.js - ZetAPI Key Authentication Middleware
//
// Authenticates requests made by a MERCHANT'S OWN site/app/server using
// their ZetPay-issued "ZetAPI" key (see services/apiTokenService.js).
// Accepts the key either in the request body (`zap_api`) or in the
// `X-ZetAPI-Key` header — matching the same lookup order `apiKeyLimiter`
// uses in middleware/rateLimiter.js, so the rate-limit bucket and the
// auth check always agree on which key made the call.
//
// NOTE: this file was missing from the deployed code entirely. Since
// routes/developer.js requires it at the top of the file (not lazily,
// inside a route handler), Node threw "Cannot find module
// '../middleware/apiKeyAuth'" while loading server.js itself — which
// crashes EVERY request through the app (server.js is the single
// serverless function all routes are routed to), not just /api/developer
// calls. That's why /api/config, /api/auth, etc. were all returning 500.
const { ref } = require('../firebase/admin');
const { DB_PATHS } = require('../config/constants');
const apiTokenService = require('../services/apiTokenService');
const response = require('../helpers/response');
const logger = require('../utils/logger');

const authenticateApiKey = async (req, res, next) => {
  try {
    const apiKey = (req.body && req.body.zap_api) || req.headers['x-zapapi-key'];

    if (!apiKey) {
      return response.unauthorized(
        res,
        'Missing ZetAPI key. Pass it as "zap_api" in the request body or an "X-ZetAPI-Key" header.'
      );
    }

    const userId = await apiTokenService.resolveToken(apiKey);
    if (!userId) {
      return response.unauthorized(res, 'Invalid ZetAPI key');
    }

    // Same "still exists / not banned" check `authenticate` does for
    // JWT-based dashboard sessions — a banned merchant shouldn't be able
    // to keep creating orders through their own site just because they
    // never rotated their ZetAPI key.
    const userSnap = await ref(`${DB_PATHS.USERS}/${userId}`).once('value');
    if (!userSnap.exists()) {
      return response.unauthorized(res, 'User not found');
    }

    const user = userSnap.val();
    if (user.isBanned) {
      return res.status(403).json({
        success: false,
        message: 'This account has been suspended.',
        banned: true,
      });
    }

    req.user = { uid: userId };
    next();
  } catch (err) {
    logger.error('ZetAPI key auth error:', err.message);
    return response.serverError(res, err.message);
  }
};

module.exports = { authenticateApiKey };
