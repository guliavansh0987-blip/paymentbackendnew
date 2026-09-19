// helpers/response.js - Standard API Response Helper

/**
 * Send success response
 */
const success = (res, message, data = null, statusCode = 200) => {
  const response = { success: true, message };
  if (data !== null) response.data = data;
  return res.status(statusCode).json(response);
};

/**
 * Send error response
 */
const error = (res, message, statusCode = 400, errors = null) => {
  const response = { success: false, message };
  if (errors) response.errors = errors;
  return res.status(statusCode).json(response);
};

/**
 * Send unauthorized response
 */
const unauthorized = (res, message = 'Unauthorized access') => {
  return res.status(401).json({ success: false, message });
};

/**
 * Send forbidden response
 */
const forbidden = (res, message = 'Access forbidden') => {
  return res.status(403).json({ success: false, message });
};

/**
 * Send not found response
 */
const notFound = (res, message = 'Resource not found') => {
  return res.status(404).json({ success: false, message });
};

/**
 * Send server error response
 */
const serverError = (res, message = 'Internal server error') => {
  return res.status(500).json({ success: false, message });
};

module.exports = { success, error, unauthorized, forbidden, notFound, serverError };

