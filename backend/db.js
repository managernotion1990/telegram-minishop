/**
 * backend/db.js
 * SQLite persistence layer built on better-sqlite3.
 * Database file: <project>/data/shop.db (created automatically on first run).
 */
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'shop.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------
db.exec(`
CREATE TABLE IF NOT EXISTS products (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  name             TEXT NOT NULL,
  slug             TEXT UNIQUE NOT NULL,
  description      TEXT NOT NULL DEFAULT '',
  price_usd        REAL NOT NULL DEFAULT 0,
  category         TEXT NOT NULL DEFAULT '',
  image_url        TEXT NOT NULL DEFAULT '',
  delivery_type    TEXT NOT NULL DEFAULT 'text',   -- 'key' | 'download' | 'subscription' | 'text'
  delivery_payload TEXT NOT NULL DEFAULT '{}',     -- JSON: {"url": "..."} | {"instructions": "..."}
  active           INTEGER NOT NULL DEFAULT 1,
  created_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS keys (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id        INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  key_value         TEXT UNIQUE NOT NULL,
  assigned_order_id TEXT NULL,                     -- NULL = still in stock
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_keys_product ON keys(product_id, assigned_order_id);

CREATE TABLE IF NOT EXISTS orders (
  id             TEXT PRIMARY KEY,                 -- e.g. "ord_" + 12 hex chars
  tg_user_id     TEXT,
  tg_username    TEXT,
  status         TEXT NOT NULL DEFAULT 'pending', -- pending | paid | expired | cancelled
  total_usd      REAL NOT NULL,
  currency       TEXT NOT NULL DEFAULT 'USD',     -- currency chosen at checkout
  payway_tran_id TEXT,
  items_json     TEXT NOT NULL,                   -- [{product_id,name,qty,unit_price,delivery_type,delivery_payload}]
  delivery_json  TEXT NULL,                       -- filled on payment: per-item delivery data
  created_at     TEXT NOT NULL,
  paid_at        TEXT NULL
);
CREATE INDEX IF NOT EXISTS idx_orders_user   ON orders(tg_user_id);
CREATE INDEX IF NOT EXISTS idx_orders_tran   ON orders(payway_tran_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

// Default settings (idempotent — INSERT OR IGNORE, so scripts/seed.js can override later).
const seedSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
seedSetting.run('exchange_rate_usd_khr', process.env.EXCHANGE_RATE_USD_KHR || '4100');
seedSetting.run('shop_name', "Kai's Digital Shop");

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function setSetting(key, value) {
  db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, String(value));
}

function getAllSettings() {
  const rows = db.prepare('SELECT key, value FROM settings ORDER BY key').all();
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------
const PRODUCT_COLUMNS = 'id, name, slug, description, price_usd, category, image_url, delivery_type, active, created_at';

function listProducts({ category, q, activeOnly = true } = {}) {
  const where = [];
  const params = [];
  if (activeOnly === true) where.push('p.active = 1');
  else if (activeOnly === false) where.push('p.active = 0');
  if (category) { where.push('p.category = ?'); params.push(category); }
  if (q) { where.push('(p.name LIKE ? OR p.description LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
  const cols = PRODUCT_COLUMNS.split(', ').map((c) => `p.${c}`).join(', ');
  const sql = `
    SELECT ${cols},
           (SELECT COUNT(*) FROM keys k WHERE k.product_id = p.id AND k.assigned_order_id IS NULL) AS keys_available
    FROM products p
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY p.created_at DESC, p.id DESC`;
  return db.prepare(sql).all(...params);
}

function getProduct(id) {
  return db.prepare(`SELECT ${PRODUCT_COLUMNS} FROM products WHERE id = ?`).get(id) || null;
}

// Internal getter — includes delivery_payload (never expose via public routes).
function getProductInternal(id) {
  return db.prepare(`SELECT ${PRODUCT_COLUMNS}, delivery_payload FROM products WHERE id = ?`).get(id) || null;
}

// Internal list for admin — includes delivery_payload.
function listProductsInternal({ category, q, activeOnly = null } = {}) {
  const where = [];
  const params = [];
  if (activeOnly === true) where.push('p.active = 1');
  else if (activeOnly === false) where.push('p.active = 0');
  if (category) { where.push('p.category = ?'); params.push(category); }
  if (q) { where.push('(p.name LIKE ? OR p.description LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
  const cols = PRODUCT_COLUMNS.split(', ').map((c) => `p.${c}`).join(', ');
  const sql = `
    SELECT ${cols}, p.delivery_payload,
           (SELECT COUNT(*) FROM keys k WHERE k.product_id = p.id AND k.assigned_order_id IS NULL) AS keys_available
    FROM products p
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY p.created_at DESC, p.id DESC`;
  return db.prepare(sql).all(...params);
}

function getProductByName(name) {
  return db.prepare(`SELECT ${PRODUCT_COLUMNS} FROM products WHERE name = ?`).get(name) || null;
}

function generateSlug(name) {
  const base =
    (String(name || 'product').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'product');
  let slug = base;
  let i = 2;
  while (db.prepare('SELECT 1 FROM products WHERE slug = ?').get(slug)) slug = `${base}-${i++}`;
  return slug;
}

function createProduct(p) {
  const slug = p.slug || generateSlug(p.name);
  const info = db
    .prepare(`
      INSERT INTO products (name, slug, description, price_usd, category, image_url, delivery_type, delivery_payload, active, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      p.name,
      slug,
      p.description || '',
      Number(p.price_usd) || 0,
      p.category || '',
      p.image_url || '',
      p.delivery_type || 'text',
      typeof p.delivery_payload === 'string' ? p.delivery_payload : JSON.stringify(p.delivery_payload || {}),
      p.active === undefined ? 1 : (p.active ? 1 : 0),
      new Date().toISOString()
    );
  return getProduct(info.lastInsertRowid);
}

function updateProduct(id, p) {
  const fields = [];
  const params = [];
  for (const key of ['name', 'slug', 'description', 'price_usd', 'category', 'image_url', 'delivery_type', 'delivery_payload', 'active']) {
    if (p[key] !== undefined) {
      let val = p[key];
      if (key === 'delivery_payload' && typeof val !== 'string') val = JSON.stringify(val);
      if (key === 'active') val = val ? 1 : 0;
      if (key === 'price_usd') val = Number(val) || 0;
      fields.push(`${key} = ?`);
      params.push(val);
    }
  }
  if (!fields.length) return getProduct(id);
  params.push(id);
  db.prepare(`UPDATE products SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  return getProduct(id);
}

function softDeleteProduct(id) {
  db.prepare('UPDATE products SET active = 0 WHERE id = ?').run(id);
}

function listCategories() {
  return db
    .prepare(`SELECT DISTINCT category FROM products WHERE active = 1 AND category <> '' ORDER BY category`)
    .all()
    .map((r) => r.category);
}

// ---------------------------------------------------------------------------
// License / activation keys
// ---------------------------------------------------------------------------
function countUnassignedKeys(productId) {
  return db
    .prepare('SELECT COUNT(*) AS n FROM keys WHERE product_id = ? AND assigned_order_id IS NULL')
    .get(productId).n;
}

function listKeys(productId) {
  const cols = 'id, product_id, key_value, assigned_order_id, created_at';
  return productId
    ? db.prepare(`SELECT ${cols} FROM keys WHERE product_id = ? ORDER BY id`).all(productId)
    : db.prepare(`SELECT ${cols} FROM keys ORDER BY product_id, id`).all();
}

function addKeys(productId, keyValues) {
  const insert = db.prepare('INSERT OR IGNORE INTO keys (product_id, key_value, created_at) VALUES (?, ?, ?)');
  let inserted = 0;
  let skipped = 0;
  const now = new Date().toISOString();
  const tx = db.transaction((vals) => {
    for (const v of vals) {
      const val = String(v).trim();
      if (!val) { skipped++; continue; }
      const info = insert.run(productId, val, now);
      if (info.changes > 0) inserted++; else skipped++;
    }
  });
  tx(keyValues);
  return { inserted, skipped };
}

function deleteKey(id) {
  db.prepare('DELETE FROM keys WHERE id = ?').run(id);
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------
function createOrder({ id, tg_user_id, tg_username, total_usd, currency = 'USD', items }) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO orders (id, tg_user_id, tg_username, status, total_usd, currency, items_json, created_at)
    VALUES (?, ?, ?, 'pending', ?, ?, ?, ?)`)
    .run(id, tg_user_id || null, tg_username || null, total_usd, currency, JSON.stringify(items), now);
  return getOrder(id);
}

function getOrder(id) {
  return db.prepare('SELECT * FROM orders WHERE id = ?').get(id) || null;
}

function getOrderByTranId(tranId) {
  return db.prepare('SELECT * FROM orders WHERE payway_tran_id = ?').get(tranId) || null;
}

function updateOrder(id, fields) {
  const allowed = ['status', 'total_usd', 'currency', 'payway_tran_id', 'items_json', 'delivery_json', 'paid_at', 'tg_user_id', 'tg_username'];
  const sets = [];
  const params = [];
  for (const [k, v] of Object.entries(fields)) {
    if (allowed.includes(k)) { sets.push(`${k} = ?`); params.push(v); }
  }
  if (!sets.length) return getOrder(id);
  params.push(id);
  db.prepare(`UPDATE orders SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  return getOrder(id);
}

function listOrders({ status, tg_user_id, ids } = {}) {
  const where = [];
  const params = [];
  if (status) { where.push('status = ?'); params.push(status); }
  if (tg_user_id) { where.push('tg_user_id = ?'); params.push(tg_user_id); }
  if (ids && ids.length) { where.push(`id IN (${ids.map(() => '?').join(',')})`); params.push(...ids); }
  const sql = `SELECT * FROM orders ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC, id DESC`;
  return db.prepare(sql).all(...params);
}

function parsePayload(json) {
  try { return JSON.parse(json || '{}'); } catch { return {}; }
}

/**
 * Fulfil a paid order: flip status, stamp paid_at, build delivery_json.
 * - key        -> assign that many unassigned keys to the order
 * - download   -> expose the download URL from delivery_payload
 * - subscription/text -> expose the instructions text
 * Idempotent: calling twice returns the existing delivery.
 */
function markOrderPaid(orderId) {
  const order = getOrder(orderId);
  if (!order) throw new Error(`order not found: ${orderId}`);
  if (order.status === 'paid') {
    return { alreadyPaid: true, delivery: parsePayload(order.delivery_json) || [] };
  }
  const items = parsePayload(order.items_json) || [];
  const delivery = [];
  const assignKey = db.prepare('UPDATE keys SET assigned_order_id = ? WHERE id = ?');
  const takeKeys = db.prepare(
    'SELECT id, key_value FROM keys WHERE product_id = ? AND assigned_order_id IS NULL ORDER BY id LIMIT ?'
  );

  for (const item of items) {
    const entry = { type: item.delivery_type, product_id: item.product_id, name: item.name, qty: item.qty };
    if (item.delivery_type === 'key') {
      const rows = takeKeys.all(item.product_id, item.qty);
      for (const r of rows) assignKey.run(orderId, r.id);
      entry.keys = rows.map((r) => r.key_value);
      entry.short = rows.length < item.qty; // true if stock ran out mid-fulfilment
    } else if (item.delivery_type === 'download') {
      const payload = parsePayload(item.delivery_payload);
      const raw = typeof item.delivery_payload === 'string' ? item.delivery_payload.trim() : '';
      entry.url = payload.url || (/^https?:\/\//i.test(raw) ? raw : null);
    } else {
      const payload = parsePayload(item.delivery_payload);
      const raw = typeof item.delivery_payload === 'string' ? item.delivery_payload.trim() : '';
      entry.instructions = payload.instructions || payload.text || raw;
    }
    delivery.push(entry);
  }

  const paidAt = new Date().toISOString();
  db.prepare('UPDATE orders SET status = ?, paid_at = ?, delivery_json = ? WHERE id = ?')
    .run('paid', paidAt, JSON.stringify(delivery), orderId);
  return { alreadyPaid: false, delivery };
}

function getStats() {
  const products = db.prepare('SELECT COUNT(*) AS n FROM products WHERE active = 1').get().n;
  const orders_pending = db.prepare("SELECT COUNT(*) AS n FROM orders WHERE status = 'pending'").get().n;
  const orders_paid = db.prepare("SELECT COUNT(*) AS n FROM orders WHERE status = 'paid'").get().n;
  const revenue = db.prepare("SELECT COALESCE(SUM(total_usd), 0) AS s FROM orders WHERE status = 'paid'").get().s;
  return { products, orders_pending, orders_paid, revenue_usd: Number(revenue) };
}

module.exports = {
  db,
  getSetting,
  setSetting,
  getAllSettings,
  listProducts,
  getProduct,
  getProductInternal,
  listProductsInternal,
  getProductByName,
  generateSlug,
  createProduct,
  updateProduct,
  softDeleteProduct,
  listCategories,
  countUnassignedKeys,
  listKeys,
  addKeys,
  deleteKey,
  createOrder,
  getOrder,
  getOrderByTranId,
  updateOrder,
  listOrders,
  markOrderPaid,
  getStats,
};
