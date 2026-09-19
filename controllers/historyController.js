// controllers/historyController.js
const imap = require('imap-simple');
const { simpleParser } = require('mailparser');
const { ref } = require('../firebase/admin');
const { DB_PATHS } = require('../config/constants');
const firebaseService = require('../services/firebaseService');
const walletService = require('../services/walletService');
const response = require('../helpers/response');
const logger = require('../utils/logger');

const fetchHistory = async (req, res) => {
  const { email, pass, limit = 15 } = req.body; 
  const userId = req.user?.uid; 

  if (!email || !pass) {
    return response.error(res, 'Email and App Password are required.', 400);
  }

  const fetchLimit = Math.min(Math.max(limit, 1), 50); 

  const config = {
    imap: {
      user: email,
      password: pass,
      host: 'imap.gmail.com',
      port: 993,
      tls: true,
      authTimeout: 10000,
      tlsOptions: { rejectUnauthorized: false }
    }
  };

  try {
    const connection = await imap.connect(config);
    await connection.openBox('INBOX');

    const searchCriteria = ['ALL'];
    const fetchOptions = { bodies: [''], struct: true, markSeen: false };

    const results = await connection.search(searchCriteria, fetchOptions);
    results.sort((a, b) => b.attributes.uid - a.attributes.uid);
    const limitedResults = results.slice(0, fetchLimit);

    const parsedTransactions = [];

    for (const item of limitedResults) {
      const all = item.parts.find(part => part.which === '');
      const mail = await simpleParser(all.body);
      const subject = mail.subject || '';
      const body = mail.text || ''; 
      const dateFallback = mail.date;

      let amount = null, sender = 'NA', txn_id = 'NA', utr = 'NA', purpose = 'NA', txn_time = null;

      const amtSubjMatch = subject.match(/(?:₹|Rs\.?|INR)\s*([\d,]+(?:\.\d+)?)/i);
      if (amtSubjMatch) amount = parseFloat(amtSubjMatch[1].replace(/,/g, ''));

      const amtBodyMatch = body.match(/received\s+(?:₹|Rs\.?)\s*([\d,]+(?:\.\d+)?)/i);
      if (amtBodyMatch) amount = parseFloat(amtBodyMatch[1].replace(/,/g, ''));

      const senderMatch = body.match(/from\s+([A-Za-z][A-Za-z0-9\s]{1,40}?)\s+at\s+\d/i);
      if (senderMatch) sender = senderMatch[1].trim();

      const txnIdMatch = body.match(/transaction\s+id\s+([A-Z0-9]+)/i);
      if (txnIdMatch) txn_id = txnIdMatch[1];

      const utrMatch = body.match(/UTR[:\s]+(\d+)/i);
      if (utrMatch) utr = utrMatch[1];

      const timeMatch = body.match(/at\s+(\d{1,2}:\d{2}\s*[AP]M\s*IST,?\s*\d{1,2}\s+\w+\s+\d{4})/i);
      if (timeMatch) txn_time = timeMatch[1].trim();

      let finalDatetime = 'NA';
      if (txn_time) {
        const dt = new Date(txn_time.replace(/IST/i, '').trim());
        if (!isNaN(dt.getTime())) finalDatetime = formatDate(dt);
      }
      if (finalDatetime === 'NA' && dateFallback) {
        const dt = new Date(dateFallback);
        if (!isNaN(dt.getTime())) finalDatetime = formatDate(dt);
      }

      if (amount && (subject.toLowerCase().includes('fam') || body.toLowerCase().includes('fam') || body.toLowerCase().includes('received'))) {
        parsedTransactions.push({ name: sender, utr: utr, datetime: finalDatetime, amount: amount, purpose: purpose, txn_id: txn_id });
      }
    }
    connection.end();

    if (userId && parsedTransactions.length > 0) {
        const allOrdersSnap = await ref(DB_PATHS.PAYMENTS).orderByChild('userId').equalTo(userId).once('value');
        const usedIdentifiers = new Set();
        const pendingOrders = [];
        
        if (allOrdersSnap.exists()) {
            allOrdersSnap.forEach(child => {
                const o = child.val();
                if (o.status === 'success') {
                    if (o.utr && o.utr !== 'NA') usedIdentifiers.add(o.utr);
                    if (o.txn_id && o.txn_id !== 'NA') usedIdentifiers.add(o.txn_id);
                } else if (o.status === 'pending') {
                    pendingOrders.push({ id: child.key, ...o });
                }
            });
        }

        const availableTransactions = parsedTransactions.filter(tx => {
            const hasUtr = tx.utr !== 'NA' && usedIdentifiers.has(tx.utr);
            const hasTxn = tx.txn_id !== 'NA' && usedIdentifiers.has(tx.txn_id);
            return !hasUtr && !hasTxn;
        });
        
        for (const order of pendingOrders) {
            const matchIndex = availableTransactions.findIndex(tx => parseFloat(tx.amount) === parseFloat(order.amount));
            
            if (matchIndex !== -1) {
                const match = availableTransactions[matchIndex];
                availableTransactions.splice(matchIndex, 1); // Mark as used
                
                // Bug fix: Removed the invalid markOrderProcessed function
                await firebaseService.updatePaymentStatus(order.id, { 
                    status: 'success', 
                    txn_id: match.txn_id !== 'NA' ? match.txn_id : 'AUTO_SYNC', 
                    utr: match.utr !== 'NA' ? match.utr : 'AUTO_SYNC',
                    environment: 'email_auto_sync'
                });
                
                try {
                  const subSnap = await ref(`${DB_PATHS.USER_SUBSCRIPTIONS}/${userId}`).once('value');
                  const plan = subSnap.val()?.plan || { walletLimit: 500 };
                  const balance = await walletService.getBalance(userId);
                  const available = plan.walletLimit - balance;

                  const credit = Math.min(order.amount, available);
                  if (credit > 0) {
                      await walletService.creditWallet(userId, credit, `Auto-Sync FamPay Order ${order.id}`);
                  }

                  // ─── Zap Credit deduction ──────────────────────
                  const commissionPct = order.commissionPercent ?? plan.commissionPercent ?? 5;
                  const creditCost = Math.round((order.amount * commissionPct) / 100 * 100) / 100;
                  if (creditCost > 0) {
                    try {
                      await walletService.debitZapCredit(userId, creditCost, `Commission for Order ${order.id}`);
                    } catch (e) {
                      logger.error(`Zap Credit debit failed for already-verified order ${order.id}: ${e.message}`);
                    }
                  }
                } catch(e) {
                  logger.error('Error crediting wallet during auto-sync:', e.message);
                }
            }
        }
    }

    return response.success(res, 'History synced', parsedTransactions);

  } catch (error) {
    let friendlyError = 'Connection failed. Please check your credentials.';
    const errStr = error.toString().toLowerCase();
    if (errStr.includes('authenticationfailed') || errStr.includes('invalid credentials')) {
      friendlyError = 'Invalid App Password. Please check your Google App Password.';
    }
    logger.error('Fetch history error:', error);
    return response.error(res, friendlyError);
  }
};

function formatDate(dt) {
  const pad = (n) => n.toString().padStart(2, '0');
  return `${pad(dt.getDate())}-${pad(dt.getMonth() + 1)}-${dt.getFullYear()} ${pad(dt.getHours())}:${pad(dt.getMinutes())}:${pad(dt.getSeconds())}`;
}

module.exports = { fetchHistory };
