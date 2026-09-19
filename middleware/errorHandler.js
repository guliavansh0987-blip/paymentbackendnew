// middleware/errorHandler.js - Global Error Handler
const logger = require('../utils/logger');

/**
 * Global error handling middleware
 * Must be registered last in Express app
 */
const errorHandler = (err, req, res, next) => {
  logger.error(`${req.method} ${req.path} - ${err.message}`, {
    stack: err.stack,
    body: req.body,
    user: req.user?.uid,
  });

  // Mongoose/Validation errors
  if (err.name === 'ValidationError') {
    return res.status(400).json({
      success: false,
      message: 'Validation failed',
      errors: Object.values(err.errors).map((e) => e.message),
    });
  }

  // JWT errors
  if (err.name === 'JsonWebTokenError') {
    return res.status(401).json({ success: false, message: 'Invalid token' });
  }

  if (err.name === 'TokenExpiredError') {
    return res.status(401).json({ success: false, message: 'Token expired' });
  }

  // Firebase errors
  if (err.code && err.code.startsWith('auth/')) {
    return res.status(401).json({ success: false, message: err.message });
  }

  // Default
  const statusCode = err.statusCode || err.status || 500;
  const message =
    process.env.NODE_ENV === 'production' && statusCode === 500
      ? 'Internal server error'
      : err.message || 'Something went wrong';

  return res.status(statusCode).json({ success: false, message });
};

/**
 * 404 handler for unmatched routes
 */
const notFoundHandler = (req, res) => {
  return res.status(404).json({
    success: false,
    message: `Route ${req.method} ${req.path} not found`,
  });
};

module.exports = errorHandler;
module.exports.notFoundHandler = notFoundHandler;
