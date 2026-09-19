// services/imapService.js - Native Node.js IMAP for Gmail / FamPay
const imap = require('imap-simple');
const { simpleParser } = require('mailparser');
const logger = require('../utils/logger');

function formatDate(dt) {
  const pad = (n) => n.toString().padStart(2, '0');
  return `${pad(dt.getDate())}-${pad(dt.getMonth() + 1)}-${dt.getFullYear()} ${pad(dt.getHours())}:${pad(dt.getMinutes())}:${pad(dt.getSeconds())}`;
}

/**
 * Verify that a Gmail address and 16-character App Password can connect via IMAP
 */
async function verifyGmailCredentials(email, password) {
  const cleanPass = String(password || '').replace(/\s+/g, '');
  const config = {
    imap: {
      user: email.trim(),
      password: cleanPass,
      host: 'imap.gmail.com',
      port: 993,
      tls: true,
      authTimeout: 15000,
      tlsOptions: { rejectUnauthorized: false }
    }
  };

  const connection = await imap.connect(config);
  await connection.openBox('INBOX');
  connection.end();
  return true;
}

/**
 * Fetch and parse recent transactions directly from Gmail INBOX
 */
async function fetchGmailTransactions(email, password, limit = 15) {
  const cleanPass = String(password || '').replace(/\s+/g, '');
  const config = {
    imap: {
      user: email.trim(),
      password: cleanPass,
      host: 'imap.gmail.com',
      port: 993,
      tls: true,
      authTimeout: 15000,
      tlsOptions: { rejectUnauthorized: false }
    }
  };

  const connection = await imap.connect(config);
  const box = await connection.openBox('INBOX');
  const total = box.messages?.total || 0;

  if (total === 0) {
    connection.end();
    return [];
  }

  // Fetch only the most recent N messages by sequence number (super fast, avoids full mailbox scan)
  const fetchCount = Math.min(Math.max(limit, 1), 50);
  const startSeq = Math.max(1, total - fetchCount + 1);
  const searchCriteria = [[`${startSeq}:${total}`]];
  const fetchOptions = { bodies: [''], struct: true, markSeen: false };

  const results = await connection.search(searchCriteria, fetchOptions);
  results.sort((a, b) => b.attributes.uid - a.attributes.uid);

  const parsedTransactions = [];

  for (const item of results) {
    try {
      const all = item.parts.find(part => part.which === '');
      if (!all) continue;
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

      parsedTransactions.push({
        name: sender !== 'NA' ? sender : (mail.from?.value?.[0]?.name || mail.from?.text || 'FamPay User'),
        utr: utr,
        datetime: finalDatetime,
        amount: amount || 0,
        purpose: purpose,
        txn_id: txn_id !== 'NA' ? txn_id : String(item.attributes.uid)
      });
    } catch (parseErr) {
      logger.warn(`Failed to parse email message ${item.attributes.uid}: ${parseErr.message}`);
    }
  }

  connection.end();
  return parsedTransactions;
}

module.exports = {
  verifyGmailCredentials,
  fetchGmailTransactions,
};
