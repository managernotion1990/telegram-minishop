/**
 * backend/routes/orders.js
 * Order lifecycle: create -> checkout (PayWay QR) -> paid/cancelled.
 * Exports markPaid(orderId) for reuse by the PayWay webhook route.
 */
const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const payway = require('../payway');
const { validateInitData } = require('../telegram');

const router = express.Router();
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';

/** Resolve the Telegram user from initData (body, query, or x-telegram-init-data header). */
function authedUser(req) {
  const initData =
    (req.body && req.body.initData) || req.query.initData || req.headers['x-telegram-init-data'];
  if (!initData) return null;
  const { valid, user } = validateInitData(initData, BOT_TOKEN);
  return valid ? user : null;
}

function newOrderId() {
  return 'ord_' + crypto.randomBytes(6).toString('hex');
}

/** PayWay tran_id: unique, <= 20 chars, e.g. "SM1234ABCD9XQ2PL". */
function newTranId() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let rnd = '';
  for (let i = 0; i < 6; i++) rnd += chars[crypto.randomInt(chars.length)];
  return ('S' + Date.now().toString(36).toUpperCase() + rnd).slice(0, 20);
}

function exchangeRate() {
  const v = Number(db.getSetting('exchange_rate_usd_khr', process.env.EXCHANGE_RATE_USD_KHR || '4100'));
  return Number.isFinite(v) && v > 0 ? v : 4100;
}

// ---------------------------------------------------------------------------
// POST /api/orders  {items:[{product_id, qty}], initData?} -> create pending order
// ---------------------------------------------------------------------------
router.post('/api/orders', ah(async (req, res) => {
  const { items } = req.body || {};
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'items must be a non-empty array of {product_id, qty}' });
  }
  const user = authedUser(req);

  const orderItems = [];
  let totalUsd = 0;
  for (const it of items) {
    const product = db.getProductInternal(Number(it.product_id));
    if (!product || !product.active) {
      return res.status(400).json({ error: `product ${it.product_id} is unavailable` });
    }
    const qty = Math.max(1, Math.min(99, parseInt(it.qty, 10) || 1));
    if (product.delivery_type === 'key') {
      const available = db.countUnassignedKeys(product.id);
      if (available < qty) {
        return res.status(400).json({ error: `not enough stock for "${product.name}" (${available} left)` });
      }
    }
    orderItems.push({
      product_id: product.id,
      name: product.name,
      qty,
      unit_price: product.price_usd,
      delivery_type: product.delivery_type,
      delivery_payload: product.delivery_payload, // snapshot at purchase time
    });
    totalUsd += product.price_usd * qty;
  }
  totalUsd = Math.round(totalUsd * 100) / 100;

  const orderId = newOrderId();
  const order = db.createOrder({
    id: orderId,
    tg_user_id: user ? String(user.id) : (req.body.tg_user_id || null),
    tg_username: user ? (user.username || null) : (req.body.tg_username || null),
    total_usd: totalUsd,
    items: orderItems,
  });

  const rate = exchangeRate();
  res.status(201).json({
    order_id: orderId,
    total_usd: totalUsd,
    total_khr: Math.round(totalUsd * rate),
    currency: order.currency,
    items: orderItems,
  });
}));

// ---------------------------------------------------------------------------
// POST /api/checkout  {order_id, currency ("USD"|"KHR"), initData?} -> PayWay QR
// ---------------------------------------------------------------------------
router.post('/api/checkout', ah(async (req, res) => {
  const { order_id, currency } = req.body || {};
  const order = order_id ? db.getOrder(order_id) : null;
  if (!order) return res.status(404).json({ error: 'order not found' });
  if (order.status !== 'pending') return res.status(400).json({ error: `order is ${order.status}` });

  const cur = String(currency || process.env.PAYWAY_CURRENCY || 'USD').toUpperCase();
  if (cur !== 'USD' && cur !== 'KHR') return res.status(400).json({ error: 'currency must be USD or KHR' });

  const rate = exchangeRate();
  const items = JSON.parse(order.items_json || '[]');
  const amount = cur === 'KHR' ? Math.round(order.total_usd * rate) : order.total_usd;

  // PayWay accepts max 10 line items — merge down to a single summary line when needed.
  let payItems;
  if (items.length > 10) {
    const qty = items.reduce((s, i) => s + i.qty, 0);
    payItems = [{ name: `Order ${order.id} (${qty} items)`, quantity: 1, price: amount }];
  } else {
    payItems = items.map((i) => ({
      name: String(i.name).slice(0, 60),
      quantity: i.qty,
      price: cur === 'KHR' ? Math.round(i.unit_price * rate) : i.unit_price,
    }));
  }

  const tranId = newTranId();
  const publicUrl = (process.env.PUBLIC_URL || 'http://localhost:3000').replace(/\/+$/, '');
  const lifetime = Math.max(3, parseInt(process.env.PAYWAY_LIFETIME_MIN || '15', 10) || 15);

  const qr = await payway.generateQR({
    tranId,
    amount,
    currency: cur,
    items: payItems,
    callbackUrl: `${publicUrl}/api/webhooks/payway`,
    lifetime,
  });

  db.updateOrder(order.id, { payway_tran_id: tranId, currency: cur });

  res.json({
    qr_image: qr.qrImage,
    qr_string: qr.qrString,
    abapay_deeplink: qr.abapayDeeplink,
    tran_id: tranId,
    expires_at: new Date(Date.now() + lifetime * 60 * 1000).toISOString(),
    mock: !!qr.mock,
  });
}));

// ---------------------------------------------------------------------------
// GET /api/orders/:id/status -> poll payment; auto-fulfils on approval
// ---------------------------------------------------------------------------
router.get('/api/orders/:id/status', ah(async (req, res) => {
  const order = db.getOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'order not found' });

  if (order.status === 'pending' && order.payway_tran_id) {
    try {
      const check = await payway.checkTransaction(order.payway_tran_id);
      if (check.approved) markPaid(order.id);
    } catch (e) {
      console.error('checkTransaction failed:', e.message);
    }
  }

  const fresh = db.getOrder(order.id);
  res.json({
    order_id: fresh.id,
    status: fresh.status,
    paid: fresh.status === 'paid',
    delivery: fresh.status === 'paid' ? JSON.parse(fresh.delivery_json || '[]') : null,
  });
}));

// ---------------------------------------------------------------------------
// GET /api/my-orders  (?initData | ?tg_user_id= | ?guest_ids=ord_x,ord_y)
// ---------------------------------------------------------------------------
router.get('/api/my-orders', ah(async (req, res) => {
  const user = authedUser(req);
  const tgUserId = user ? String(user.id) : (req.query.tg_user_id || null);
  const guestIds = String(req.query.guest_ids || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (!tgUserId && !guestIds.length) {
    return res.status(400).json({ error: 'initData, tg_user_id, or guest_ids required' });
  }

  const orders = [];
  const seen = new Set();
  if (tgUserId) {
    for (const o of db.listOrders({ tg_user_id: tgUserId })) {
      orders.push(o); seen.add(o.id);
    }
  }
  if (guestIds.length) {
    for (const o of db.listOrders({ ids: guestIds })) {
      if (!seen.has(o.id)) orders.push(o);
    }
  }
  orders.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));

  res.json({
    orders: orders.map((o) => ({
      id: o.id,
      status: o.status,
      total_usd: o.total_usd,
      currency: o.currency,
      created_at: o.created_at,
      paid_at: o.paid_at,
      items: JSON.parse(o.items_json || '[]').map((i) => ({
        product_id: i.product_id, name: i.name, qty: i.qty, unit_price: i.unit_price,
      })),
      delivery: o.status === 'paid' ? JSON.parse(o.delivery_json || '[]') : null,
    })),
  });
}));

// ---------------------------------------------------------------------------
// POST /api/orders/:id/cancel -> pending -> cancelled (+ close PayWay txn)
// ---------------------------------------------------------------------------
router.post('/api/orders/:id/cancel', ah(async (req, res) => {
  const order = db.getOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'order not found' });
  if (order.status !== 'pending') return res.status(400).json({ error: `order is ${order.status}` });

  if (order.payway_tran_id) {
    try { await payway.closeTransaction(order.payway_tran_id); }
    catch (e) { console.error('closeTransaction failed (best-effort):', e.message); }
  }
  db.updateOrder(order.id, { status: 'cancelled' });
  res.json({ order_id: order.id, status: 'cancelled' });
}));

/** Fulfil a paid order and return its delivery payload (idempotent). */
function markPaid(orderId) {
  return db.markOrderPaid(orderId);
}

module.exports = router;
module.exports.markPaid = markPaid;
