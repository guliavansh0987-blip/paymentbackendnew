// routes/agent.js
const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/agentController');
const { authenticate, blockIfBanned } = require('../middleware/auth');
const { agentChatLimiter } = require('../middleware/rateLimiter');

router.get('/models', authenticate, blockIfBanned, ctrl.listModels);
router.get('/conversations', authenticate, blockIfBanned, ctrl.listConversations);
router.post('/conversations', authenticate, blockIfBanned, ctrl.createConversation);
router.get('/conversations/:id', authenticate, blockIfBanned, ctrl.getConversation);
router.put('/conversations/:id', authenticate, blockIfBanned, ctrl.renameConversation);
router.delete('/conversations/:id', authenticate, blockIfBanned, ctrl.deleteConversation);

// The actual chat call — rate-limited since every message is a real NVIDIA API call.
router.post('/conversations/:id/messages', authenticate, blockIfBanned, agentChatLimiter, ctrl.sendMessage);

module.exports = router;
