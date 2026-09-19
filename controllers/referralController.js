// controllers/referralController.js
const referralService = require('../services/referralService');
const firebaseService = require('../services/firebaseService');
const response = require('../helpers/response');
const logger = require('../utils/logger');

/** Mask a name like "Sovit Kumar" -> "S***" (matches ZapUPI's display style) */
function maskName(name) {
  if (!name) return '***';
  const parts = name.trim().split(/\s+/);
  return parts.map((p) => p.charAt(0).toUpperCase() + '***').join(' ');
}

/** Mask an email like "name@gmail.com" -> "na***@gmail.com" */
function maskEmail(email) {
  if (!email || !email.includes('@')) return '***';
  const [local, domain] = email.split('@');
  return `${local.slice(0, 2)}***@${domain}`;
}

/** GET /api/referral/my */
const getMyReferral = async (req, res) => {
  try {
    const data = await referralService.getReferralData(req.user.uid);
    data.referrals = data.referrals.map((r) => ({
      ...r,
      name: maskName(r.name),
      email: maskEmail(r.email),
    }));
    const settings = await firebaseService.getSettings();
    data.signupBonus = settings.signupBonus || 0;
    return response.success(res, 'Referral data fetched', data);
  } catch (err) {
    logger.error('Get referral data error:', err.message);
    return response.serverError(res, err.message);
  }
};

module.exports = { getMyReferral };
