// firebase/admin.js
const admin = require('firebase-admin');
const logger = require('../utils/logger');

let db;
let initialized = false;

function initializeFirebase() {
  try {
    if (admin.apps.length > 0) {
      db = admin.apps[0].database();
      initialized = true;
      return;
    }

    // ── Private key fix for Vercel ──
    // Vercel sometimes stores \n as literal \\n — both cases handled
    let privateKey = process.env.FIREBASE_PRIVATE_KEY || '';
    if (privateKey.includes('\\n')) {
      privateKey = privateKey.replace(/\\n/g, '\n');
    }
    // Remove surrounding quotes if present
    privateKey = privateKey.replace(/^["']|["']$/g, '');

    if (!privateKey || !process.env.FIREBASE_CLIENT_EMAIL || !process.env.FIREBASE_PROJECT_ID) {
      throw new Error(
        'Missing Firebase env vars. Check: FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY'
      );
    }

    admin.initializeApp({
      credential: admin.credential.cert({
        type: 'service_account',
        project_id: process.env.FIREBASE_PROJECT_ID,
        client_email: process.env.FIREBASE_CLIENT_EMAIL,
        private_key: privateKey,
      }),
      databaseURL: process.env.FIREBASE_DATABASE_URL,
    });

    db = admin.database();
    initialized = true;
    logger.info('✅ Firebase Admin SDK initialized');

  } catch (error) {
    // ⚠️ Do NOT call process.exit() — it crashes Vercel serverless functions
    logger.error('❌ Firebase initialization failed: ' + error.message);
    logger.error('Fix: Check your Firebase environment variables in Vercel Dashboard');
    // Let the app start but DB calls will fail gracefully
  }
}

function getAuth() {
  return admin.auth();
}

function getDatabase() {
  if (!db) {
    throw new Error('Firebase not initialized. Check environment variables in Vercel Dashboard.');
  }
  return db;
}

function ref(path) {
  return getDatabase().ref(path);
}

function serverTimestamp() {
  return admin.database.ServerValue.TIMESTAMP;
}

module.exports = {
  initializeFirebase,
  getAuth,
  getDatabase,
  ref,
  serverTimestamp,
  admin,
};
