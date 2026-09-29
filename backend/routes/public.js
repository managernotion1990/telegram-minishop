/**
 * backend/routes/public.js
 * Public storefront API. Never exposes products' delivery_payload.
 */
const express = require('express');
const db = require('../db');

const router = express.Router();

// GET /api/products?category=&q=&active=1
//   active: "1" (default) -> active only, "0" -> inactive only, "all" -> everything
router.get('/api/products', (req, res) => {
  const { category, q, active } = req.query;
  let activeOnly = true;
  if (active === 'all') activeOnly = null;
  else if (active === '0' || active === 'false') activeOnly = false;

  const products = db.listProducts({ category, q, activeOnly }).map((p) => {
    const { delivery_payload, ...pub } = p; // NEVER exposed publicly
    return pub;
  });
  res.json({ products });
});

// GET /api/categories
router.get('/api/categories', (req, res) => {
  res.json({ categories: db.listCategories() });
});

module.exports = router;
