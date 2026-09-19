// services/supportService.js - Simple 1:1 Support Chat (user <-> admin)
//
// Schema:
//   supportMessages/{uid}/{pushId} = { id, sender: 'user'|'admin', message, createdAt }
//   supportThreads/{uid}           = { uid, userName, userEmail, lastMessage,
//                                       lastSender, lastMessageAt, createdAt,
//                                       unreadForAdmin, unreadForUser }
//
// Deliberately reachable even when the user is banned (see middleware/auth.js
// blockIfBanned) — this is the one channel a suspended user keeps.

const { ref, serverTimestamp } = require('../firebase/admin');
const { DB_PATHS } = require('../config/constants');

const MAX_MESSAGE_LENGTH = 1000;

function clean(message) {
  return String(message || '').trim().slice(0, MAX_MESSAGE_LENGTH);
}

/**
 * User sends a message. Creates the thread on first contact.
 */
async function sendUserMessage(uid, userMeta, message) {
  const text = clean(message);
  const msgRef = ref(`${DB_PATHS.SUPPORT_MESSAGES}/${uid}`).push();
  await msgRef.set({
    id: msgRef.key,
    sender: 'user',
    message: text,
    createdAt: serverTimestamp(),
  });

  const threadRef = ref(`${DB_PATHS.SUPPORT_THREADS}/${uid}`);
  const threadSnap = await threadRef.once('value');
  const existing = threadSnap.val() || {};

  await threadRef.update({
    uid,
    userName: userMeta.displayName || userMeta.email || 'User',
    userEmail: userMeta.email || '',
    lastMessage: text,
    lastSender: 'user',
    lastMessageAt: serverTimestamp(),
    unreadForAdmin: (existing.unreadForAdmin || 0) + 1,
    unreadForUser: existing.unreadForUser || 0,
    createdAt: existing.createdAt || serverTimestamp(),
  });

  return msgRef.key;
}

/**
 * Admin replies to a user's thread.
 */
async function sendAdminReply(uid, message) {
  const text = clean(message);
  const msgRef = ref(`${DB_PATHS.SUPPORT_MESSAGES}/${uid}`).push();
  await msgRef.set({
    id: msgRef.key,
    sender: 'admin',
    message: text,
    createdAt: serverTimestamp(),
  });

  const threadRef = ref(`${DB_PATHS.SUPPORT_THREADS}/${uid}`);
  const threadSnap = await threadRef.once('value');
  const existing = threadSnap.val() || {};

  await threadRef.update({
    lastMessage: text,
    lastSender: 'admin',
    lastMessageAt: serverTimestamp(),
    unreadForUser: (existing.unreadForUser || 0) + 1,
    unreadForAdmin: existing.unreadForAdmin || 0,
  });

  return msgRef.key;
}

/**
 * All messages for one user's thread, oldest first (chat order).
 */
async function getMessages(uid, limit = 300) {
  const snap = await ref(`${DB_PATHS.SUPPORT_MESSAGES}/${uid}`).once('value');
  if (!snap.exists()) return [];
  const msgs = [];
  snap.forEach((child) => { const v = child.val(); if (v) msgs.push(v); });
  msgs.sort((a, b) => (Number(a?.createdAt) || 0) - (Number(b?.createdAt) || 0));
  return msgs.slice(-limit);
}

async function markReadByUser(uid) {
  await ref(`${DB_PATHS.SUPPORT_THREADS}/${uid}`).update({ unreadForUser: 0 }).catch(() => {});
}

async function markReadByAdmin(uid) {
  await ref(`${DB_PATHS.SUPPORT_THREADS}/${uid}`).update({ unreadForAdmin: 0 }).catch(() => {});
}

/**
 * Edit an admin-authored message. Refuses to touch a user's own message —
 * only the sender's own words can be corrected, never the other side's.
 * Also refreshes the thread's lastMessage preview if this was the latest one.
 */
async function editAdminMessage(uid, messageId, newText) {
  const msgRef = ref(`${DB_PATHS.SUPPORT_MESSAGES}/${uid}/${messageId}`);
  const snap = await msgRef.once('value');
  if (!snap.exists()) throw new Error('Message not found');
  const msg = snap.val();
  if (msg.sender !== 'admin') throw new Error('Only admin-sent messages can be edited');

  const text = clean(newText);
  await msgRef.update({ message: text, editedAt: serverTimestamp() });

  const threadSnap = await ref(`${DB_PATHS.SUPPORT_THREADS}/${uid}`).once('value');
  const thread = threadSnap.val();
  if (thread && thread.lastSender === 'admin' && thread.lastMessage === msg.message) {
    await ref(`${DB_PATHS.SUPPORT_THREADS}/${uid}`).update({ lastMessage: text });
  }
}

/**
 * Delete an admin-authored message (same one-sided restriction as edit).
 */
async function deleteAdminMessage(uid, messageId) {
  const msgRef = ref(`${DB_PATHS.SUPPORT_MESSAGES}/${uid}/${messageId}`);
  const snap = await msgRef.once('value');
  if (!snap.exists()) throw new Error('Message not found');
  if (snap.val().sender !== 'admin') throw new Error('Only admin-sent messages can be deleted');
  await msgRef.remove();
}

/**
 * Admin inbox — every thread, most recently active first.
 */
async function getAllThreads() {
  const snap = await ref(DB_PATHS.SUPPORT_THREADS).once('value');
  if (!snap.exists()) return [];
  const threads = [];
  snap.forEach((child) => { const v = child.val(); if (v) threads.push(v); });
  threads.sort((a, b) => (Number(b?.lastMessageAt) || 0) - (Number(a?.lastMessageAt) || 0));
  return threads;
}

module.exports = {
  sendUserMessage,
  sendAdminReply,
  getMessages,
  markReadByUser,
  markReadByAdmin,
  getAllThreads,
  editAdminMessage,
  deleteAdminMessage,
};
