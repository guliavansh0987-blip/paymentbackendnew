// config/constants.js - Production Constants for ZetPay Backend

const DB_PATHS = {
  USERS: 'users',
  PAYMENTS: 'payments',
  PAYMENT_LINKS: 'paymentLinks',
  PLANS: 'plans',
  USER_SUBSCRIPTIONS: 'userSubscriptions',
  WALLET: 'wallet',
  WITHDRAWALS: 'withdrawals',
  SETTINGS: 'settings',
  NOTIFICATIONS: 'notifications',
  SUPPORT_MESSAGES: 'supportMessages',
  SUPPORT_THREADS: 'supportThreads',
  PROMO_CODES: 'promoCodes',
  PROMO_REDEMPTIONS: 'promoRedemptions',
  REFERRALS: 'referrals',
  REFERRAL_CODES: 'referralCodes',
  API_TOKENS: 'apiTokens',
  WEBHOOKS: 'webhooks',
  STORES: 'stores',
  STORE_ID_INDEX: 'storeIdIndex',
  PROCESSED_ORDERS: 'processedOrders',
  AGENT_CONVERSATIONS: 'agentConversations',
  ACTIVITY_LOGS: 'activityLogs',
  EMAIL_OTPS: 'emailOtps'
};

const DEFAULT_SETTINGS = {
  commissionPercent: 5,
  fampayInviteLink: 'https://get.fampay.in/SOVIOEMTW-100P',
  hideWalletSystemEnabled: false,
  maintenanceMode: false,
  minWithdrawal: 100,
  minZapCreditPurchase: 50,
  referralCommissionPercent: 30,
  referralQualifyingMinDeposit: 100,
  signupBonus: 100,
  signupZapCredit: 50,
  siteName: 'ZetPay',
  socialLinks: {
    instagram: {
      enabled: true,
      url: 'https://www.instagram.com/only_sovitx?igsh=djZudm5rcTYwOGM4'
    },
    telegram: {
      enabled: true,
      url: 'https://t.me/SovitX_developer'
    },
    whatsapp: {
      enabled: false,
      url: ''
    },
    youtube: {
      enabled: true,
      url: 'https://youtube.com/@ai_science_sovitx?si=vq06Nie8s66d4SOZ'
    }
  },
  supportEmail: 'support@zetpay.online'
};

const DEFAULT_PLANS = {
  blaze: {
    id: 'blaze',
    name: '⚡ Blaze',
    badge: 'Free',
    price: 0,
    walletLimit: 500,
    commissionPercent: 5,
    paymentLinksPerMonth: 100,
    linkExpiryDays: 7,
    webhookLimit: 3,
    withdrawalCount: 1,
    withdrawalPeriod: 'week',
    displayOrder: 1,
    isActive: true,
    isDefault: true,
    isHighlighted: false,
    features: [
      '100 Payment Links/month',
      '7 Day Link Expiry',
      '₹500 Wallet Limit',
      '1 Withdrawal/week',
      '5% Commission',
      '3 Webhooks',
      'Unlock premium themes (Silver+)',
      'Free Store Access'
    ]
  },
  bronze: {
    id: 'bronze',
    name: '🥉 Bronze',
    badge: 'Starter',
    price: 29,
    walletLimit: 1000,
    commissionPercent: 3.5,
    paymentLinksPerMonth: 250,
    linkExpiryDays: 15,
    webhookLimit: 5,
    withdrawalCount: 3,
    withdrawalPeriod: 'week',
    displayOrder: 2,
    isActive: true,
    isDefault: false,
    isHighlighted: false,
    features: [
      '250 Payment Links/month',
      '15 Day Link Expiry',
      '₹1,000 Wallet Limit',
      '3 Withdrawals/week',
      '3.5% Commission',
      '5 Webhooks',
      'Unlock premium themes (Silver+)',
      'Free Store Access'
    ]
  },
  silver: {
    id: 'silver',
    name: '🥈 Silver',
    badge: 'Most Popular',
    price: 59,
    walletLimit: 3000,
    commissionPercent: 2,
    paymentLinksPerMonth: 1000,
    linkExpiryDays: 30,
    webhookLimit: 10,
    withdrawalCount: 1,
    withdrawalPeriod: 'day',
    displayOrder: 3,
    isActive: true,
    isDefault: false,
    isHighlighted: true,
    features: [
      '1,000 Payment Links/month',
      '30 Day Link Expiry',
      '₹3,000 Wallet Limit',
      '1 Withdrawal/day',
      '2% Commission',
      '10 Webhooks',
      'Unlock premium themes',
      'Free Store Access'
    ]
  },
  gold: {
    id: 'gold',
    name: '🥇 Gold',
    badge: 'Premium',
    price: 149,
    walletLimit: 7500,
    commissionPercent: 1,
    paymentLinksPerMonth: 3000,
    linkExpiryDays: 90,
    webhookLimit: 25,
    withdrawalCount: 3,
    withdrawalPeriod: 'day',
    displayOrder: 4,
    isActive: true,
    isDefault: false,
    isHighlighted: false,
    features: [
      '3,000 Payment Links/month',
      '90 Day Link Expiry',
      '₹7,500 Wallet Limit',
      '3 Withdrawals/day',
      '1% Commission',
      '25 Webhooks',
      'Unlock premium themes',
      'Free Store Access'
    ]
  },
  developer: {
    id: 'developer',
    name: '👨‍💻 Developer',
    badge: 'Unlimited',
    price: 299,
    walletLimit: 20000,
    commissionPercent: 0.5,
    paymentLinksPerMonth: -1,
    linkExpiryDays: -1,
    webhookLimit: -1,
    withdrawalCount: 10,
    withdrawalPeriod: 'day',
    displayOrder: 5,
    isActive: true,
    isDefault: false,
    isHighlighted: false,
    features: [
      'Unlimited Payment Links',
      'No Link Expiry',
      '₹20,000 Wallet Limit',
      '10 Withdrawals/day',
      '0.5% Commission',
      'Unlimited Webhooks',
      'Unlock premium themes',
      'Free Store Access'
    ]
  }
};

const DEFAULT_PROMO_CODES = {
  WELCM5: {
    code: 'WELCM5',
    type: 'fixed',
    value: 5,
    maxUses: -1,
    usedCount: 0,
    perUserLimit: 1,
    description: 'Welcome bonus — ₹5 Zap Bonus credit',
    isActive: true
  }
};

const NOTIFICATION_TYPE = {
  GENERAL: 'general',
  PAYMENT: 'payment',
  WITHDRAWAL: 'withdrawal',
  SUBSCRIPTION: 'subscription',
  SECURITY: 'security',
  SYSTEM: 'system'
};

const SUBSCRIPTION_DURATIONS = [
  { months: 1, discountPercent: 0, label: '1 Month' },
  { months: 3, discountPercent: 10, label: '3 Months (10% OFF)' },
  { months: 6, discountPercent: 15, label: '6 Months (15% OFF)' },
  { months: 12, discountPercent: 25, label: '12 Months (25% OFF)' }
];

const ZAP_CREDIT_SIGNUP_GRANT = 50;

module.exports = {
  DB_PATHS,
  DEFAULT_SETTINGS,
  DEFAULT_PLANS,
  DEFAULT_PROMO_CODES,
  NOTIFICATION_TYPE,
  SUBSCRIPTION_DURATIONS,
  ZAP_CREDIT_SIGNUP_GRANT
};
