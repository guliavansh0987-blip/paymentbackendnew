// services/storeService.js - Store Portal data layer
//
// Every merchant gets ONE store (auto-created on first touch of Store
// Portal) holding: settings (name/logo/theme/social links) + an unlimited
// (well, capped) list of products. Customers reach it publicly via
// store.html?id=<storeId> — storeId is a short public identifier, never
// the merchant's Firebase uid, resolved through STORE_ID_INDEX the same
// way ZetAPI keys resolve through API_TOKENS.
const crypto = require('crypto');
const { ref, serverTimestamp } = require('../firebase/admin');
const { DB_PATHS } = require('../config/constants');

const MAX_SCREENSHOTS = 8;
const MAX_PRODUCTS = 300; // a sane technical safety cap, not a plan/business restriction
const VALID_THEMES = ['boutique', 'editorial', 'market']; // <-- FIX: editorial added

function generateStoreId() {
  return crypto.randomBytes(4).toString('hex'); // e.g. "a1b2c3d4"
}
function generateProductId() {
  return crypto.randomBytes(6).toString('hex');
}

const DEFAULT_LOGO_URL = '/zetpay-logo.svg';

/**
 * Get a merchant's store settings, auto-creating a default store (with a
 * freshly generated, collision-checked storeId) the first time they ever
 * touch Store Portal.
 */
async function getOrCreateSettings(uid) {
  const settingsRef = ref(`${DB_PATHS.STORES}/${uid}/settings`);
  const snap = await settingsRef.once('value');
  if (snap.exists()) return snap.val();

  let storeId = generateStoreId();
  while ((await ref(`${DB_PATHS.STORE_ID_INDEX}/${storeId}`).once('value')).exists()) {
    storeId = generateStoreId();
  }

  const defaults = {
    storeId,
    storeName: 'ZetPay Store',
    logoUrl: DEFAULT_LOGO_URL,
    theme: 'boutique',
    socialLinks: { telegram: '', whatsapp: '', youtube: '', instagram: '' },
    unlocked: false,
    showSortButton: false,   // <-- NEW: toggle for sort on storefront
    categories: [],          // <-- NEW: [{ id, name, icon }]
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
  await settingsRef.set(defaults);
  await ref(`${DB_PATHS.STORE_ID_INDEX}/${storeId}`).set(uid);
  return defaults;
}

/**
 * System-managed unlock flag — deliberately not exposed through
 * updateSettings' user-editable fields below. Only ever called from
 * storeController's wallet-unlock handler and the store_unlock webhook
 * branch, never directly from a merchant-facing form.
 */
async function setUnlocked(uid, value) {
  await getOrCreateSettings(uid);
  await ref(`${DB_PATHS.STORES}/${uid}/settings`).update({ unlocked: !!value, updatedAt: serverTimestamp() });
}

/** Merchant-facing settings update — only ever touches known-safe fields. */
async function updateSettings(uid, data) {
  await getOrCreateSettings(uid);
  const updates = { updatedAt: serverTimestamp() };

  if (data.storeName !== undefined) {
    const name = String(data.storeName).trim().slice(0, 60);
    updates.storeName = name || 'ZetPay Store';
  }
  if (data.logoUrl !== undefined) {
    const url = String(data.logoUrl).trim().slice(0, 500);
    updates.logoUrl = url || DEFAULT_LOGO_URL;
  }
  if (data.theme !== undefined) {
    if (!VALID_THEMES.includes(data.theme)) throw new Error(`Invalid theme: ${data.theme}`);
    updates.theme = data.theme;
  }
  if (data.socialLinks !== undefined && typeof data.socialLinks === 'object' && data.socialLinks !== null) {
    const sl = data.socialLinks;
    updates.socialLinks = {
      telegram: String(sl.telegram || '').trim().slice(0, 300),
      whatsapp: String(sl.whatsapp || '').trim().slice(0, 300),
      youtube: String(sl.youtube || '').trim().slice(0, 300),
      instagram: String(sl.instagram || '').trim().slice(0, 300),
    };
  }

  // ─── NEW: Show Sort Button toggle ──────────────────────────────
  if (data.showSortButton !== undefined) {
    updates.showSortButton = !!data.showSortButton;
  }

  // ─── NEW: Categories array ──────────────────────────────────────
  if (data.categories !== undefined && Array.isArray(data.categories)) {
    const valid = data.categories.filter(c => c && c.name && c.name.trim());
    updates.categories = valid.map(c => ({
      id: c.id || 'cat_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      name: c.name.trim().slice(0, 30),
      icon: (c.icon || '').trim().slice(0, 30) || null,
    }));
  }

  await ref(`${DB_PATHS.STORES}/${uid}/settings`).update(updates);
  const snap = await ref(`${DB_PATHS.STORES}/${uid}/settings`).once('value');
  return snap.val();
}

async function getProducts(uid) {
  const snap = await ref(`${DB_PATHS.STORES}/${uid}/products`).once('value');
  if (!snap.exists()) return [];
  return Object.values(snap.val()).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

async function getProduct(uid, productId) {
  const snap = await ref(`${DB_PATHS.STORES}/${uid}/products/${productId}`).once('value');
  return snap.exists() ? snap.val() : null;
}

/**
 * Validates + sanitizes product input. `partial: true` (for updates) only
 * validates fields that were actually supplied; create always requires
 * the four mandatory fields regardless of what was sent.
 */
function validateProductInput(data, { partial = false } = {}) {
  const errors = [];
  const out = {};

  if (!partial || data.imageUrl !== undefined) {
    const v = String(data.imageUrl || '').trim();
    if (!v) errors.push('Product image URL is required');
    out.imageUrl = v.slice(0, 500);
  }
  if (!partial || data.title !== undefined) {
    const v = String(data.title || '').trim();
    if (!v) errors.push('Product title is required');
    out.title = v.slice(0, 120);
  }
  if (!partial || data.description !== undefined) {
    const v = String(data.description || '').trim();
    if (!v) errors.push('Product description is required');
    out.description = v.slice(0, 3000);
  }
  if (!partial || data.originalPrice !== undefined) {
    const v = parseFloat(data.originalPrice);
    if (!v || v <= 0) errors.push('Original price is required and must be greater than 0');
    out.originalPrice = v;
  }
  if (data.discountPrice !== undefined) {
    if (data.discountPrice === null || data.discountPrice === '') {
      out.discountPrice = null;
    } else {
      const v = parseFloat(data.discountPrice);
      const base = out.originalPrice !== undefined ? out.originalPrice : null;
      if (isNaN(v) || v < 0) errors.push('Discount price must be a valid non-negative number');
      else if (base !== null && v >= base) errors.push('Discount price must be less than the original price');
      out.discountPrice = v;
    }
  }
  if (data.productLink !== undefined) {
    out.productLink = String(data.productLink || '').trim().slice(0, 1000);
  }
  if (data.screenshotUrls !== undefined) {
    if (!Array.isArray(data.screenshotUrls)) {
      errors.push('screenshotUrls must be a list of URLs');
      out.screenshotUrls = [];
    } else {
      if (data.screenshotUrls.length > MAX_SCREENSHOTS) errors.push(`Maximum ${MAX_SCREENSHOTS} screenshots allowed`);
      out.screenshotUrls = data.screenshotUrls.map((s) => String(s || '').trim()).filter(Boolean).slice(0, MAX_SCREENSHOTS);
    }
  }

  // ─── NEW: Category ID support ──────────────────────────────────
  if (data.categoryId !== undefined) {
    out.categoryId = data.categoryId || null;
  }

  return { errors, data: out };
}

async function createProduct(uid, input) {
  const { errors, data } = validateProductInput(input, { partial: false });
  if (errors.length) { const e = new Error(errors[0]); e.validationErrors = errors; throw e; }

  const existing = await getProducts(uid);
  if (existing.length >= MAX_PRODUCTS) throw new Error(`You've reached the maximum of ${MAX_PRODUCTS} products.`);

  await getOrCreateSettings(uid);

  const id = generateProductId();
  const product = {
    id,
    imageUrl: data.imageUrl,
    title: data.title,
    description: data.description,
    originalPrice: data.originalPrice,
    discountPrice: data.discountPrice ?? null,
    productLink: data.productLink || '',
    screenshotUrls: data.screenshotUrls || [],
    categoryId: data.categoryId || null, // <-- NEW
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
  await ref(`${DB_PATHS.STORES}/${uid}/products/${id}`).set(product);
  return product;
}

async function updateProduct(uid, productId, input) {
  const existing = await getProduct(uid, productId);
  if (!existing) { const e = new Error('Product not found'); e.notFound = true; throw e; }

  const { errors, data } = validateProductInput(input, { partial: true });
  if (errors.length) { const e = new Error(errors[0]); e.validationErrors = errors; throw e; }

  const updates = { ...data, updatedAt: serverTimestamp() };
  await ref(`${DB_PATHS.STORES}/${uid}/products/${productId}`).update(updates);
  return { ...existing, ...updates };
}

async function deleteProduct(uid, productId) {
  const existing = await getProduct(uid, productId);
  if (!existing) { const e = new Error('Product not found'); e.notFound = true; throw e; }
  await ref(`${DB_PATHS.STORES}/${uid}/products/${productId}`).remove();
}

/** storeId -> uid, for the public storefront. Returns null if unknown. */
async function getUidByStoreId(storeId) {
  const snap = await ref(`${DB_PATHS.STORE_ID_INDEX}/${storeId}`).once('value');
  return snap.exists() ? snap.val() : null;
}

module.exports = {
  getOrCreateSettings,
  updateSettings,
  setUnlocked,
  getProducts,
  getProduct,
  createProduct,
  updateProduct,
  deleteProduct,
  getUidByStoreId,
  VALID_THEMES,
  MAX_SCREENSHOTS,
  MAX_PRODUCTS,
};
