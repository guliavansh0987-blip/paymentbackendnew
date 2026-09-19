// controllers/supportController.js - User-facing Support Chat
const { body, validationResult } = require('express-validator');
const supportService = require('../services/supportService');
const firebaseService = require('../services/firebaseService');
const response = require('../helpers/response');
const logger = require('../utils/logger');

/**
 * GET /api/support/messages
 * Fetch the caller's own chat thread with support. Also clears the
 * "unread admin reply" flag, since fetching = the user is looking at it.
 */
const getMyMessages = async (req, res) => {
  try {
    const messages = await supportService.getMessages(req.user.uid);
    await supportService.markReadByUser(req.user.uid);
    return response.success(res, 'Messages fetched', { messages });
  } catch (err) {
    logger.error('Get support messages error:', err.message);
    return response.serverError(res, err.message);
  }
};

/**
 * POST /api/support/messages
 * Send a message to support. Works even for a banned/suspended account —
 * this is intentionally the one channel a suspended user keeps.
 */
const sendMessage = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return response.error(res, 'Validation failed', 400, errors.array());

    const user = await firebaseService.getUser(req.user.uid);
    await supportService.sendUserMessage(
      req.user.uid,
      { displayName: user?.displayName, email: req.user.email },
      req.body.message
    );

    const messages = await supportService.getMessages(req.user.uid);
    return response.success(res, 'Message sent', { messages });
  } catch (err) {
    logger.error('Send support message error:', err.message);
    return response.serverError(res, err.message);
  }
};

const sendMessageValidation = [
  body('message').trim().notEmpty().withMessage('Message cannot be empty').isLength({ max: 1000 }).withMessage('Message too long'),
];

module.exports = { getMyMessages, sendMessage, sendMessageValidation };
