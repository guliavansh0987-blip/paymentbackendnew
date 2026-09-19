// controllers/agentController.js
// Agentic Support — conversation management + the streaming chat endpoint.
// All routes here are dashboard-authenticated (JWT); every read/write is
// scoped to req.user.uid so one user can never see or touch another
// user's conversations.
const { ref, serverTimestamp } = require('../firebase/admin');
const { DB_PATHS } = require('../config/constants');
const agentService = require('../services/agentService');
const response = require('../helpers/response');
const logger = require('../utils/logger');

const MAX_MESSAGE_LENGTH = 6000;
const MAX_STORED_MESSAGES = 200;   // per conversation, oldest trimmed first
const CONTEXT_WINDOW_MESSAGES = 20; // how many recent messages are actually sent to the model

function convRef(uid, conversationId) {
  return ref(`${DB_PATHS.AGENT_CONVERSATIONS}/${uid}/${conversationId}`);
}

/** Turns a user's first message into a short conversation title. */
function makeTitle(firstMessage) {
  const clean = String(firstMessage || '').replace(/\s+/g, ' ').trim();
  if (!clean) return 'New chat';
  return clean.length > 48 ? clean.slice(0, 48).trim() + '…' : clean;
}

/**
 * GET /api/agent/conversations
 * List this user's conversations (id, title, updatedAt only — not the
 * full message bodies, to keep this list call light).
 */
async function listConversations(req, res) {
  try {
    const snap = await ref(`${DB_PATHS.AGENT_CONVERSATIONS}/${req.user.uid}`).once('value');
    if (!snap.exists()) return response.success(res, 'Conversations fetched', { conversations: [] });
    const val = snap.val();
    const conversations = Object.keys(val).map((id) => ({
      id,
      title: val[id].title || 'New chat',
      updatedAt: val[id].updatedAt || val[id].createdAt || 0,
    })).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return response.success(res, 'Conversations fetched', { conversations });
  } catch (err) {
    logger.error('listConversations error: ' + err.message);
    return response.serverError(res, 'Could not load your chat history.');
  }
}

/**
 * POST /api/agent/conversations
 * Creates a new, empty conversation and returns its id — the frontend
 * calls this when the user clicks "New Chat".
 */
async function createConversation(req, res) {
  try {
    const newRef = ref(`${DB_PATHS.AGENT_CONVERSATIONS}/${req.user.uid}`).push();
    const record = { title: 'New chat', createdAt: serverTimestamp(), updatedAt: serverTimestamp(), messages: [] };
    await newRef.set(record);
    return response.success(res, 'Conversation created', { id: newRef.key });
  } catch (err) {
    logger.error('createConversation error: ' + err.message);
    return response.serverError(res, 'Could not start a new chat.');
  }
}

/**
 * GET /api/agent/conversations/:id
 * Full message history for one conversation.
 */
async function getConversation(req, res) {
  try {
    const snap = await convRef(req.user.uid, req.params.id).once('value');
    if (!snap.exists()) return response.error(res, 'Conversation not found.', 404);
    const val = snap.val();
    return response.success(res, 'Conversation fetched', {
      id: req.params.id,
      title: val.title || 'New chat',
      messages: val.messages || [],
    });
  } catch (err) {
    logger.error('getConversation error: ' + err.message);
    return response.serverError(res, 'Could not load this conversation.');
  }
}

/**
 * PUT /api/agent/conversations/:id
 * Body: { title } — manual rename from the history drawer.
 */
async function renameConversation(req, res) {
  try {
    const title = String(req.body.title || '').trim().slice(0, 80);
    if (!title) return response.error(res, 'Title cannot be empty.', 400);
    const targetRef = convRef(req.user.uid, req.params.id);
    const snap = await targetRef.once('value');
    if (!snap.exists()) return response.error(res, 'Conversation not found.', 404);
    await targetRef.update({ title, updatedAt: serverTimestamp() });
    return response.success(res, 'Renamed');
  } catch (err) {
    logger.error('renameConversation error: ' + err.message);
    return response.serverError(res, 'Could not rename this conversation.');
  }
}

/**
 * DELETE /api/agent/conversations/:id
 */
async function deleteConversation(req, res) {
  try {
    const targetRef = convRef(req.user.uid, req.params.id);
    const snap = await targetRef.once('value');
    if (!snap.exists()) return response.error(res, 'Conversation not found.', 404);
    await targetRef.remove();
    return response.success(res, 'Conversation deleted');
  } catch (err) {
    logger.error('deleteConversation error: ' + err.message);
    return response.serverError(res, 'Could not delete this conversation.');
  }
}

/**
 * POST /api/agent/conversations/:id/messages
 * Body: { message, thinking }
 * Streams the assistant's reply back as Server-Sent Events, then persists
 * both the user's message and the assistant's full reply to the
 * conversation once streaming completes.
 */
async function sendMessage(req, res) {
  const { id } = req.params;
  const userMessage = String(req.body.message || '').trim();
  const thinking = !!req.body.thinking;
  const modelId = agentService.MODELS[req.body.model] ? req.body.model : agentService.DEFAULT_MODEL_ID;
  const modelCfg = agentService.getModelConfig(modelId);

  if (!userMessage) return response.error(res, 'Message cannot be empty.', 400);
  if (userMessage.length > MAX_MESSAGE_LENGTH) {
    return response.error(res, `Message is too long (max ${MAX_MESSAGE_LENGTH} characters).`, 400);
  }

  const targetRef = convRef(req.user.uid, id);
  let existing;
  try {
    const snap = await targetRef.once('value');
    if (!snap.exists()) return response.error(res, 'Conversation not found.', 404);
    existing = snap.val();
  } catch (err) {
    logger.error('sendMessage load error: ' + err.message);
    return response.serverError(res, 'Could not load this conversation.');
  }

  const history = Array.isArray(existing.messages) ? existing.messages : [];
  const isFirstMessage = history.length === 0;

  // Build the message array actually sent to the model: system prompt +
  // a bounded recent window of history + the new user message. The FULL
  // history is still what gets persisted below — this window only limits
  // what's sent to the model each turn, to keep latency/cost bounded on
  // long-running conversations.
  const recentHistory = history.slice(-CONTEXT_WINDOW_MESSAGES).map((m) => ({ role: m.role, content: m.content }));
  const modelMessages = [
    { role: 'system', content: agentService.buildSystemPrompt(modelCfg.label, modelCfg.tag) },
  ];

  // If the frontend reports an active artifact (stored in the user's own
  // browser localStorage — never on our server), give the model its
  // CURRENT content fresh on every turn. This is what makes multi-step
  // "read the file, then edit it" reliable: without this, the model would
  // only know the file as it was when first created, and a second/third
  // edit request could reference text an earlier edit already changed.
  const activeArtifact = req.body.activeArtifact;
  if (activeArtifact && activeArtifact.filename && typeof activeArtifact.content === 'string') {
    const truncated = activeArtifact.content.length > 8000
      ? activeArtifact.content.slice(0, 8000) + '\n... (truncated, file continues)'
      : activeArtifact.content;
    modelMessages.push({
      role: 'system',
      content: `The current active artifact is "${activeArtifact.filename}" (version ${activeArtifact.version || 1}). Its exact current content is:\n\n\`\`\`${activeArtifact.language || ''}\n${truncated}\n\`\`\`\n\nWhen the user asks for a change, use this exact content for your OLD: text in {{edit_artifact}} blocks — it must match precisely.`,
    });
  }

  modelMessages.push(...recentHistory, { role: 'user', content: userMessage });

  // ── Set up SSE ──
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable proxy buffering where applicable
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  const send = (payload) => { try { res.write(`data: ${JSON.stringify(payload)}\n\n`); } catch (e) {} };

  // If the client disconnects (Stop button click aborts the fetch, or they
  // just close the tab), abort the upstream NVIDIA request too — otherwise
  // we'd keep paying for/generating a full reply nobody is watching anymore.
  const upstreamController = new AbortController();
  req.on('close', () => upstreamController.abort());

  try {
    const { content, reasoning } = await agentService.streamChat({
      modelId,
      messages: modelMessages,
      thinking,
      signal: upstreamController.signal,
      onDelta: (chunk) => send({ type: 'content', chunk }),
      onReasoningDelta: (chunk) => send({ type: 'reasoning', chunk }),
    });

    const now = Date.now();
    const newMessages = [
      ...history,
      { role: 'user', content: userMessage, ts: now },
      { role: 'assistant', content, reasoning: reasoning || null, ts: now, model: modelId },
    ].slice(-MAX_STORED_MESSAGES); // trim oldest first if this conversation has gotten very long

    const updates = { messages: newMessages, updatedAt: serverTimestamp() };
    if (isFirstMessage) updates.title = makeTitle(userMessage);
    await targetRef.update(updates);

    send({ type: 'done', title: updates.title || existing.title || 'New chat', ts: now });
  } catch (err) {
    logger.error('sendMessage stream error: ' + err.message);
    send({ type: 'error', message: err.message || 'Something went wrong. Please try again.', suggestSwitchTo: err.suggestSwitchTo || null });
  } finally {
    res.end();
  }
}

/**
 * GET /api/agent/models
 * Lets the frontend render the model picker without hardcoding the list.
 */
async function listModels(req, res) {
  return response.success(res, 'Models fetched', { models: agentService.listModels(), default: agentService.DEFAULT_MODEL_ID });
}

module.exports = {
  listConversations,
  createConversation,
  getConversation,
  renameConversation,
  deleteConversation,
  sendMessage,
  listModels,
};
