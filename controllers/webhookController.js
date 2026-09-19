// controllers/webhookController.js
// Dashboard-authenticated (JWT) endpoints for a merchant to manage their
// own outgoing webhook URLs — see services/webhookService.js for what
// these are actually used for (order.pending / order.success / order.failed
// notifications sent to the merchant's own server).
const { body, validationResult } = require('express-validator');
const webhookService = require('./../services/webhookService');
const subscriptionService = require('../services/subscriptionService');
const firebaseService = require('../services/firebaseService');
const response = require('../helpers/response');
const logger = require('../utils/logger');

/**
 * GET /api/developer/webhooks
 * Returns the merchant's registered webhook URLs plus their plan's limit,
 * so the Developer Portal can show "3 / 5 used" and disable the add button
 * at the cap.
 */
const listWebhooks = async (req, res) => {
  try {
    const [webhooks, sub] = await Promise.all([
      webhookService.listWebhooks(req.user.uid),
      subscriptionService.getUserSubscription(req.user.uid),
    ]);
    const limit = webhookService.getLimitForPlan(sub.plan);
    return response.success(res, 'Webhooks fetched', {
      webhooks,
      limit, // -1 means unlimited
      planName: sub.plan.name,
    });
  } catch (err) {
    logger.error('listWebhooks error: ' + err.message);
    return response.serverError(res, err.message);
  }
};

const addWebhookValidation = [
  body('url').notEmpty().withMessage('Webhook URL is required').trim(),
];

/**
 * POST /api/developer/webhooks
 * Body: { url }
 */
const addWebhook = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return response.error(res, 'Validation failed', 400, errors.array());

    const webhook = await webhookService.addWebhook(req.user.uid, req.body.url);
    await firebaseService.logActivity(req.user.uid, 'WEBHOOK_ADDED', { url: webhook.url });
    return response.success(res, 'Webhook added', { webhook });
  } catch (err) {
    // addWebhook throws plain, user-facing Error messages (limit reached,
    // invalid URL, duplicate) — surface those directly rather than a
    // generic 500, same pattern the rest of this codebase uses.
    return response.error(res, err.message || 'Failed to add webhook');
  }
};

/**
 * DELETE /api/developer/webhooks/:webhookId
 */
const deleteWebhook = async (req, res) => {
  try {
    await webhookService.deleteWebhook(req.user.uid, req.params.webhookId);
    await firebaseService.logActivity(req.user.uid, 'WEBHOOK_DELETED', { webhookId: req.params.webhookId });
    return response.success(res, 'Webhook removed');
  } catch (err) {
    return response.error(res, err.message || 'Failed to remove webhook');
  }
};

/**
 * PUT /api/developer/webhooks/:webhookId/toggle
 * Body: { isActive }
 */
const toggleWebhook = async (req, res) => {
  try {
    const isActive = !!req.body.isActive;
    await webhookService.toggleWebhook(req.user.uid, req.params.webhookId, isActive);
    return response.success(res, isActive ? 'Webhook enabled' : 'Webhook disabled');
  } catch (err) {
    return response.error(res, err.message || 'Failed to update webhook');
  }
};

module.exports = {
  listWebhooks,
  addWebhookValidation,
  addWebhook,
  deleteWebhook,
  toggleWebhook,
};
