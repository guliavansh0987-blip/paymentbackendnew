
// utils/encryption.js
const crypto = require('crypto');

// ENCRYPTION_KEY hamesha 32 characters ki honi chahiye
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '12345678901234567890123456789012'; 
const IV_LENGTH = 16;

module.exports = {
  encrypt: (text) => {
    if (!text) return text;
    let iv = crypto.randomBytes(IV_LENGTH);
    let cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY), iv);
    let encrypted = cipher.update(text);
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    return iv.toString('hex') + ':' + encrypted.toString('hex');
  },
  
  decrypt: (text) => {
    if (!text) return text;
    // Agar text already plain text hai (jaise pehle save hua tha), toh wahi return karega error nahi dega
    if (!text.includes(':')) return text; 
    
    try {
      let textParts = text.split(':');
      let iv = Buffer.from(textParts.shift(), 'hex');
      let encryptedText = Buffer.from(textParts.join(':'), 'hex');
      let decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY), iv);
      let decrypted = decipher.update(encryptedText);
      decrypted = Buffer.concat([decrypted, decipher.final()]);
      return decrypted.toString();
    } catch (e) {
      console.error('Decryption failed:', e);
      return null;
    }
  }
};
