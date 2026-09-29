/**
 * backend/payway.js
 * ABA PayWay QR (KHQR) API client.
 *
 * Real mode talks to the PayWay payment-gateway API.
 * Mock mode (PAYWAY_MOCK=true, or missing credentials) simulates the flow so the
 * whole shop can be tested end-to-end without a PayWay merchant account.
 */
const crypto = require('crypto');

const BASE_URL = (process.env.PAYWAY_BASE_URL ||
  'https://checkout-sandbox.payway.com.kh/api/payment-gateway/v1/payments').replace(/\/+$/, '');
const MERCHANT_ID = process.env.PAYWAY_MERCHANT_ID || '';
const API_KEY = process.env.PAYWAY_API_KEY || '';
const QR_TEMPLATE = process.env.PAYWAY_QR_TEMPLATE || 'template3_color';

/** true when running against the simulator instead of the real PayWay API. */
function mockMode() {
  return process.env.PAYWAY_MOCK === 'true' || !MERCHANT_ID || !API_KEY;
}

// In-memory record of mock transactions: tranId -> createdAt (ms epoch).
const mockTxns = new Map();

/** Current UTC time as "YmdHis" (e.g. 20260929093022). */
function reqTime(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}` +
    `${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}`
  );
}

function hmacSha512Base64(message, key) {
  return crypto.createHmac('sha512', key).update(message, 'utf8').digest('base64');
}

/**
 * Canonical amount representation used BOTH in the JSON body and the hash input.
 * - KHR: integer (no decimals)
 * - USD: string with exactly 2 decimals, e.g. "12.50"
 */
function canonicalAmount(amount, currency) {
  if (currency === 'KHR') return Math.round(Number(amount));
  return Number(amount).toFixed(2);
}

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

async function postJson(url, body, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON response */ }
    return { httpStatus: res.status, json, text };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Generate a KHQR for payment.
 * @param {object} o
 * @param {string} o.tranId      unique transaction id (<= 20 chars)
 * @param {number} o.amount      total (USD with decimals, KHR integer)
 * @param {string} o.currency    "USD" | "KHR"
 * @param {Array<{name,quantity,price}>} o.items  (max 10 line items)
 * @param {string} o.callbackUrl webhook URL (sent base64-encoded)
 * @param {number} o.lifetime    QR lifetime in minutes (min 3)
 * @param {object} [o.customer]  {first_name,last_name,email,phone} — keys omitted when empty
 */
async function generateQR({ tranId, amount, currency = 'USD', items = [], callbackUrl, lifetime = 15, customer = {} }) {
  if (mockMode()) {
    mockTxns.set(tranId, Date.now());
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300">` +
      `<rect width="300" height="300" fill="#f5f5f5"/>` +
      `<text x="150" y="135" text-anchor="middle" font-size="20" font-family="sans-serif" fill="#333">MOCK PAYMENT</text>` +
      `<text x="150" y="162" text-anchor="middle" font-size="13" font-family="sans-serif" fill="#666">scan simulated</text>` +
      `<text x="150" y="188" text-anchor="middle" font-size="11" font-family="monospace" fill="#999">${tranId}</text>` +
      `</svg>`;
    return {
      qrString: `MOCK-QR-${tranId}`,
      qrImage: `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`,
      abapayDeeplink: null,
      tranId,
      mock: true,
    };
  }

  const req_time = reqTime();
  const amt = canonicalAmount(amount, currency);
  const itemsB64 = b64(JSON.stringify(items));
  const callbackB64 = b64(callbackUrl || '');

  // Optional customer fields — the key is OMITTED entirely when empty (never sent as "").
  const optional = {};
  for (const k of ['first_name', 'last_name', 'email', 'phone']) {
    if (customer[k]) optional[k] = String(customer[k]);
  }

  const body = {
    req_time,
    merchant_id: MERCHANT_ID,
    tran_id: tranId,
    amount: amt,
    items: itemsB64,
    ...optional,
    purchase_type: 'purchase',
    payment_option: 'abapay_khqr',
    callback_url: callbackB64,
    currency,
    lifetime: Number(lifetime),
    qr_image_template: QR_TEMPLATE,
  };

  // Hash = base64(HMAC-SHA512(concatenation of the 18 fields in EXACT order, apiKey)).
  // Missing/omitted fields count as empty strings; values hashed exactly as sent in the body.
  const hashFields = [
    body.req_time,
    body.merchant_id,
    body.tran_id,
    body.amount,
    body.items,
    body.first_name || '',
    body.last_name || '',
    body.email || '',
    body.phone || '',
    body.purchase_type,
    body.payment_option,
    body.callback_url,
    '', // return_deeplink
    body.currency,
    '', // custom_fields
    '', // return_params
    '', // payout
    String(body.lifetime),
    body.qr_image_template,
  ];
  body.hash = hmacSha512Base64(hashFields.join(''), API_KEY);

  const { json } = await postJson(`${BASE_URL}/generate-qr`, body);
  const code = json && json.status ? json.status.code : null;
  if (json && (code === '0' || code === 0)) {
    return {
      qrString: json.qrString,
      qrImage: json.qrImage,
      abapayDeeplink: json.abapay_deeplink || null,
      tranId: json.tran_id || tranId,
      mock: false,
    };
  }
  const msg = (json && json.status && json.status.message) || 'PayWay generate-qr failed';
  throw new Error(`PayWay generate-qr error (code ${code}): ${msg}`);
}

function txnHash(req_time, tran_id) {
  return hmacSha512Base64(req_time + MERCHANT_ID + tran_id, API_KEY);
}

/** Poll the transaction status. approved=true means the customer paid. */
async function checkTransaction(tranId) {
  if (mockMode()) {
    const created = mockTxns.get(tranId);
    const ageMs = created ? Date.now() - created : null;
    // Simulate the user opening their banking app and scanning: approve after ~20s.
    const approved = ageMs !== null && ageMs >= 20000;
    return { approved, mock: true, raw: { tran_id: tranId, age_ms: ageMs } };
  }
  const req_time = reqTime();
  const body = { req_time, merchant_id: MERCHANT_ID, tran_id: tranId, hash: txnHash(req_time, tranId) };
  const { json } = await postJson(`${BASE_URL}/check-transaction-2`, body);
  const data = (json && json.data) || {};
  const approved = data.payment_status_code === 0 || data.payment_status === 'APPROVED';
  return { approved, mock: false, raw: json };
}

/** Cancel / close a transaction (best-effort, e.g. when the user cancels an order). */
async function closeTransaction(tranId) {
  if (mockMode()) {
    mockTxns.delete(tranId);
    return { ok: true, mock: true };
  }
  const req_time = reqTime();
  const body = { req_time, merchant_id: MERCHANT_ID, tran_id: tranId, hash: txnHash(req_time, tranId) };
  const { json } = await postJson(`${BASE_URL}/close-transaction`, body);
  return { ok: true, mock: false, raw: json };
}

/**
 * Verify an incoming PayWay webhook.
 * Signature = HMAC-SHA512 over the concatenated VALUES of the body fields,
 * with keys sorted alphabetically (PHP ksort-style). Compared against the
 * X-PayWay-Hmac-Sha512 header (hex or base64 accepted).
 */
function verifyWebhook(body, headers = {}) {
  if (!API_KEY) return false;
  const headerVal =
    headers['x-payway-hmac-sha512'] ||
    headers['X-PayWay-Hmac-Sha512'] ||
    headers['x-payway-hmac-sha-512'];
  if (!headerVal) return false;
  const data = body && typeof body === 'object' ? body : {};
  const concatenated = Object.keys(data)
    .sort()
    .map((k) => {
      const v = data[k];
      return v === null || v === undefined ? '' : String(v);
    })
    .join('');
  const digest = crypto.createHmac('sha512', API_KEY).update(concatenated, 'utf8').digest();
  const given = String(headerVal).trim();
  const candidates = [digest.toString('hex'), digest.toString('base64')];
  return candidates.some(
    (c) => c.length === given.length && crypto.timingSafeEqual(Buffer.from(c), Buffer.from(given))
  );
}

module.exports = {
  generateQR,
  checkTransaction,
  closeTransaction,
  verifyWebhook,
  mockMode,
  canonicalAmount,
};
