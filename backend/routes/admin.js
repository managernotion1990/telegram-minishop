/**
 * backend/routes/admin.js
 * Admin API — every route requires header  x-admin-token: <ADMIN_TOKEN>  (else 401).
 */
const express = require('express');
const multer = require('multer');
const db = require('../db');
const { markPaid } = require('./orders');

const router = express.Router();
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'change-me-to-something-long';

function adminAuth(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (!token || token !== ADMIN_TOKEN) return res.status(401).json({ error: 'unauthorized' });
  next();
}
router.use('/api/admin', adminAuth);

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------
router.get('/api/admin/products', (req, res) => {
  res.json({ products: db.listProductsInternal({ activeOnly: null }) });
});

router.post('/api/admin/products', ah(async (req, res) => {
  const p = req.body || {};
  if (!p.name || p.price_usd === undefined) {
    return res.status(400).json({ error: 'name and price_usd required' });
  }
  res.status(201).json({ product: db.createProduct(p) });
}));

router.put('/api/admin/products/:id', ah(async (req, res) => {
  const existing = db.getProduct(req.params.id);
  if (!existing) return res.status(404).json({ error: 'product not found' });
  res.json({ product: db.updateProduct(req.params.id, req.body || {}) });
}));

router.delete('/api/admin/products/:id', ah(async (req, res) => {
  db.softDeleteProduct(req.params.id); // soft delete: active = 0
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------
router.get('/api/admin/orders', (req, res) => {
  const { status } = req.query;
  const orders = db.listOrders(status ? { status } : {});
  res.json({
    orders: orders.map((o) => ({
      ...o,
      items: JSON.parse(o.items_json || '[]'),
      delivery: o.delivery_json ? JSON.parse(o.delivery_json) : null,
    })),
  });
});

router.post('/api/admin/orders/:id/mark-paid', ah(async (req, res) => {
  const order = db.getOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'order not found' });
  res.json({ order_id: order.id, ...markPaid(order.id) });
}));

router.post('/api/admin/orders/:id/cancel', ah(async (req, res) => {
  const order = db.getOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'order not found' });
  db.updateOrder(order.id, { status: 'cancelled' });
  res.json({ order_id: order.id, status: 'cancelled' });
}));

// ---------------------------------------------------------------------------
// License keys
// ---------------------------------------------------------------------------
router.get('/api/admin/keys', (req, res) => {
  const { product_id } = req.query;
  res.json({ keys: db.listKeys(product_id ? Number(product_id) : null) });
});

router.post('/api/admin/keys', ah(async (req, res) => {
  const { product_id, keys } = req.body || {};
  if (!product_id || !Array.isArray(keys)) {
    return res.status(400).json({ error: 'product_id and keys[] required' });
  }
  const product = db.getProduct(Number(product_id));
  if (!product) return res.status(404).json({ error: 'product not found' });
  res.status(201).json(db.addKeys(Number(product_id), keys)); // {inserted, skipped}
}));

router.delete('/api/admin/keys/:id', ah(async (req, res) => {
  db.deleteKey(req.params.id);
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
router.get('/api/admin/settings', (req, res) => {
  res.json({ settings: db.getAllSettings() });
});

router.put('/api/admin/settings', ah(async (req, res) => {
  const { settings } = req.body || {};
  if (!settings || typeof settings !== 'object') {
    return res.status(400).json({ error: 'settings object required' });
  }
  for (const [k, v] of Object.entries(settings)) db.setSetting(k, v);
  res.json({ settings: db.getAllSettings() });
}));

// ---------------------------------------------------------------------------
// CSV import — multipart upload (field "file").
// Columns: name,price_usd,category,description,delivery_type,delivery_payload,image_url
// Upserts by product name.
// ---------------------------------------------------------------------------
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n') {
      row.push(field); rows.push(row); row = []; field = '';
    } else if (c === '\r') {
      // ignore
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

router.post('/api/admin/import', upload.single('file'), ah(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'CSV file required (multipart field "file")' });
  const rows = parseCSV(req.file.buffer.toString('utf8').replace(/^\uFEFF/, ''));
  if (rows.length < 2) return res.status(400).json({ error: 'CSV is empty' });

  const header = rows[0].map((h) => String(h).trim().toLowerCase());
  const idx = (name) => header.indexOf(name);
  let created = 0;
  let updated = 0;

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r.length || r.every((c) => !String(c).trim())) continue;
    const name = idx('name') >= 0 ? String(r[idx('name')] || '').trim() : '';
    if (!name) continue;

    const col = (n) => (idx(n) >= 0 ? String(r[idx(n)] || '').trim() : '');
    const payload = {
      name,
      price_usd: Number(col('price_usd')) || 0,
      category: col('category'),
      description: col('description'),
      delivery_type: col('delivery_type') || 'text',
      delivery_payload: col('delivery_payload'),
      image_url: col('image_url'),
      active: 1,
    };
    // delivery_payload may be a JSON blob or plain-text instructions — normalise to JSON.
    try {
      JSON.parse(payload.delivery_payload || '{}');
    } catch {
      payload.delivery_payload = payload.delivery_payload
        ? JSON.stringify({ instructions: payload.delivery_payload })
        : '{}';
    }

    const existing = db.getProductByName(name);
    if (existing) { db.updateProduct(existing.id, payload); updated++; }
    else { db.createProduct(payload); created++; }
  }
  res.json({ created, updated });
}));

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------
router.get('/api/admin/stats', (req, res) => {
  res.json(db.getStats()); // {products, orders_pending, orders_paid, revenue_usd}
});

module.exports = router;
