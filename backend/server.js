/**
 * backend/server.js
 * Express entrypoint: loads .env, serves the storefront (public/) at / and the
 * admin panel (admin/) at /admin, mounts the API routers.
 */

// Tiny built-in .env loader (no dotenv dependency): existing process.env wins.
(function loadEnv() {
  const path = require('path');
  const fs = require('fs');
  const file = path.join(__dirname, '..', '.env');
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return; }
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if (val.length >= 2 &&
        ((val[0] === '"' && val[val.length - 1] === '"') ||
         (val[0] === "'" && val[val.length - 1] === "'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
})();

const path = require('path');
const express = require('express');
const app = express();

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));

// Static frontends (built by other agents): shop at /, admin panel at /admin.
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/admin', express.static(path.join(__dirname, '..', 'admin')));

// API routers
app.use(require('./routes/public'));
app.use(require('./routes/orders'));
app.use(require('./routes/webhook'));
app.use(require('./routes/admin'));

app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// 404 for unknown API routes (static fallback already ran above)
app.use('/api', (req, res) => res.status(404).json({ error: 'not found' }));

// Central error handler
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(err.status || 500).json({ error: err.message || 'internal error' });
});

const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => {
  console.log(`tg-minishop backend listening on :${PORT} (mock payments: ${process.env.PAYWAY_MOCK === 'true'})`);
});
