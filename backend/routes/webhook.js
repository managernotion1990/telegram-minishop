/**
 * backend/routes/webhook.js
 * PayWay payment callback: verifies the signature, finds the order by tran_id,
 * and fulfils it when the payload indicates approval. Always responds 200 —
 * PayWay retries on non-2xx, so we never leak internal errors as HTTP status.
 */
const express = require('express');
const db = require('../db');
const payway = require('../payway');
const { markPaid } = require('./orders');

const router = express.Router();

function isApproved(body) {
  const data = body && body.data && typeof body.data === 'object' ? body.data : {};
  if (data.payment_status === 'APPROVED') return true;
  if (body && body.payment_status === 'APPROVED') return true;
  const code = data.payment_status_code;
  if (code !== undefined && code !== null && code !== '' && Number(code) === 0) return true;
  return false;
}

router.post('/api/webhooks/payway', async (req, res) => {
  try {
    if (payway.mockMode()) {
      // Signature check skipped in mock mode, but still logged for visibility.
      console.log('PayWay webhook (mock mode, signature check skipped):',
        JSON.stringify(req.body || {}).slice(0, 300));
    } else {
      const ok = payway.verifyWebhook(req.body, req.headers);
      if (!ok) {
        console.warn('PayWay webhook: invalid signature');
        return res.sendStatus(200);
      }
    }

    const body = req.body || {};
    const tranId = body.tran_id || (body.data && body.data.tran_id) || null;
    if (!tranId) return res.sendStatus(200);

    const order = db.getOrderByTranId(tranId);
    if (!order) {
      console.warn(`PayWay webhook: no order found for tran_id ${tranId}`);
      return res.sendStatus(200);
    }

    if (isApproved(body) && order.status === 'pending') {
      markPaid(order.id);
      console.log(`Order ${order.id} marked paid via PayWay webhook (tran ${tranId})`);
    } else {
      console.log(`PayWay webhook for order ${order.id}: not approved or already ${order.status}`);
    }
  } catch (e) {
    console.error('PayWay webhook handler error:', e.message);
  }
  return res.sendStatus(200);
});

module.exports = router;
