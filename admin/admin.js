'use strict';
/* Mini-Shop Admin panel — plain JS, talks to the /api/admin contract. */

const API = '/api/admin';
const LS_KEY = 'minishop_admin_token';

let token = localStorage.getItem(LS_KEY) || '';
let productsCache = [];
let ordersCache = [];
let loadedTabs = new Set();
let keyProductId = null;

/* ---------------- helpers ---------------- */

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function toast(msg, type) {
  const el = document.createElement('div');
  el.className = 'toast toast-' + (type || 'success');
  el.textContent = msg;
  document.getElementById('toasts').appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

function fmtMoney(n) {
  const v = Number(n);
  return isFinite(v) ? '$' + v.toFixed(2) : '—';
}

function fmtDate(s) {
  if (!s) return '—';
  const d = new Date(s);
  return isNaN(d) ? esc(s) : d.toLocaleString();
}

async function api(path, opts) {
  opts = opts || {};
  const headers = Object.assign({ 'x-admin-token': token }, opts.headers || {});
  if (opts.body && typeof opts.body === 'string') headers['Content-Type'] = 'application/json';
  const res = await fetch(API + path, Object.assign({}, opts, { headers }));
  if (res.status === 401) {
    showGate('Invalid or expired token. Please sign in again.');
    throw new Error('unauthorized');
  }
  let data = null;
  try { data = await res.json(); } catch (e) { /* non-JSON */ }
  if (!res.ok) throw new Error((data && (data.error || data.message)) || 'Request failed (' + res.status + ')');
  return data;
}

/* ---------------- token gate ---------------- */

const gate = document.getElementById('tokenGate');
const tokenInput = document.getElementById('tokenInput');
const gateError = document.getElementById('gateError');

function showGate(msg) {
  gate.classList.remove('hidden');
  gateError.textContent = msg || '';
  setTimeout(() => tokenInput.focus(), 50);
}
function hideGate() {
  gate.classList.add('hidden');
  gateError.textContent = '';
  tokenInput.value = '';
}

function signIn() {
  const t = tokenInput.value.trim();
  if (!t) { gateError.textContent = 'Please enter the admin token.'; return; }
  token = t;
  localStorage.setItem(LS_KEY, token);
  hideGate();
  loadedTabs = new Set();
  init();
}

document.getElementById('tokenBtn').addEventListener('click', signIn);
tokenInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') signIn(); });

document.getElementById('logoutBtn').addEventListener('click', () => {
  token = '';
  localStorage.removeItem(LS_KEY);
  loadedTabs = new Set();
  showGate('Signed out.');
});

/* ---------------- tabs ---------------- */

document.querySelectorAll('.tabs button').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tabs button').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    const panel = document.getElementById('tab-' + btn.dataset.tab);
    panel.classList.add('active');
    loadTab(btn.dataset.tab);
  });
});

function loadTab(name) {
  if (loadedTabs.has(name)) return;
  loadedTabs.add(name);
  const loaders = {
    dashboard: loadDashboard,
    products: loadProducts,
    keys: loadKeyPools,
    orders: loadOrders,
    import: () => {},
    settings: loadSettings,
  };
  try {
    const r = loaders[name]();
    if (r && r.catch) r.catch((e) => { if (e.message !== 'unauthorized') toast(e.message, 'error'); });
  } catch (e) {
    if (e.message !== 'unauthorized') toast(e.message, 'error');
  }
}

function init() {
  loadTab('dashboard');
}

/* ---------------- dashboard ---------------- */

async function loadDashboard() {
  const s = await api('/stats');
  document.getElementById('statProducts').textContent = s.products != null ? s.products : '—';
  document.getElementById('statPending').textContent = s.orders_pending != null ? s.orders_pending : '—';
  document.getElementById('statPaid').textContent = s.orders_paid != null ? s.orders_paid : '—';
  document.getElementById('statRevenue').textContent = s.revenue_usd != null ? fmtMoney(s.revenue_usd) : '—';
}

/* ---------------- products ---------------- */

function slugify(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

async function loadProducts() {
  const data = await api('/products');
  productsCache = data.products || [];
  renderProducts();
  const cats = [...new Set(productsCache.map((p) => p.category).filter(Boolean))].sort();
  document.getElementById('categoryList').innerHTML = cats.map((c) => `<option value="${esc(c)}">`).join('');
}

function renderProducts() {
  const tbody = document.querySelector('#productsTable tbody');
  document.getElementById('productsEmpty').hidden = productsCache.length > 0;
  tbody.innerHTML = productsCache.map((p) => {
    const active = Number(p.active) === 1;
    return `<tr>
      <td><strong>${esc(p.name)}</strong><span class="cell-sub">${esc(p.slug || '')}</span></td>
      <td>${esc(p.category || '—')}</td>
      <td>${fmtMoney(p.price_usd)}</td>
      <td><span class="badge badge-type">${esc(p.delivery_type || '—')}</span></td>
      <td>${p.keys_available != null ? esc(p.keys_available) : '—'}</td>
      <td><label class="switch" title="Toggle active">
            <input type="checkbox" data-action="toggle" data-id="${p.id}" ${active ? 'checked' : ''}>
            <span class="slider"></span>
          </label></td>
      <td>
        <button class="btn btn-secondary btn-sm" data-action="edit" data-id="${p.id}">Edit</button>
        <button class="btn btn-sm ${active ? 'btn-danger' : 'btn-primary'}" data-action="deactivate" data-id="${p.id}">
          ${active ? 'Deactivate' : 'Activate'}
        </button>
      </td>
    </tr>`;
  }).join('');
}

document.querySelector('#productsTable tbody').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const id = btn.dataset.id;
  const action = btn.dataset.action;
  const product = productsCache.find((p) => String(p.id) === String(id));
  if (!product) return;
  if (action === 'edit') {
    openProductModal(product);
  } else if (action === 'deactivate') {
    await setProductActive(product, Number(product.active) !== 1);
  }
});

document.querySelector('#productsTable tbody').addEventListener('change', async (e) => {
  const input = e.target.closest('[data-action="toggle"]');
  if (!input) return;
  const id = input.dataset.id;
  const product = productsCache.find((p) => String(p.id) === String(id));
  if (!product) return;
  await setProductActive(product, input.checked);
});

async function setProductActive(product, active) {
  try {
    const body = Object.assign({}, product, { active: active ? 1 : 0 });
    delete body.keys_available;
    const data = await api('/products/' + product.id, { method: 'PUT', body: JSON.stringify(body) });
    const idx = productsCache.findIndex((p) => String(p.id) === String(product.id));
    if (idx >= 0) productsCache[idx] = data.product || Object.assign({}, product, { active: active ? 1 : 0 });
    renderProducts();
    toast(active ? 'Product activated.' : 'Product deactivated.');
  } catch (e) {
    if (e.message !== 'unauthorized') toast(e.message, 'error');
    renderProducts();
  }
}

/* ---- product modal ---- */

const productModal = document.getElementById('productModal');
let slugDirty = false;

const PAYLOAD_HINTS = {
  key: 'Leave empty — keys are managed in the Key pools tab.',
  download: 'JSON, e.g. {"url":"https://…/file.zip"}',
  subscription: 'Fulfillment instructions the buyer sees after payment.',
  text: 'Text the buyer receives after payment.',
};

function updatePayloadHint() {
  const t = document.getElementById('pfType').value;
  document.getElementById('payloadHint').textContent = PAYLOAD_HINTS[t] || '';
}

function openProductModal(product) {
  slugDirty = !!product;
  document.getElementById('productModalTitle').textContent = product ? 'Edit product' : 'Add product';
  document.getElementById('pfId').value = product ? product.id : '';
  document.getElementById('pfName').value = product ? product.name || '' : '';
  document.getElementById('pfSlug').value = product ? product.slug || '' : '';
  document.getElementById('pfDescription').value = product ? product.description || '' : '';
  document.getElementById('pfPrice').value = product ? product.price_usd : '';
  document.getElementById('pfCategory').value = product ? product.category || '' : '';
  document.getElementById('pfImage').value = product ? product.image_url || '' : '';
  document.getElementById('pfType').value = product ? product.delivery_type || 'key' : 'key';
  document.getElementById('pfPayload').value = product ? product.delivery_payload || '' : '';
  document.getElementById('pfActive').checked = product ? Number(product.active) === 1 : true;
  updatePayloadHint();
  productModal.classList.remove('hidden');
  setTimeout(() => document.getElementById('pfName').focus(), 50);
}

function closeProductModal() {
  productModal.classList.add('hidden');
}

document.getElementById('addProductBtn').addEventListener('click', () => openProductModal(null));
document.getElementById('productModalClose').addEventListener('click', closeProductModal);
document.getElementById('productModalCancel').addEventListener('click', closeProductModal);
productModal.addEventListener('click', (e) => { if (e.target === productModal) closeProductModal(); });
document.getElementById('pfType').addEventListener('change', updatePayloadHint);
document.getElementById('pfName').addEventListener('input', (e) => {
  if (!slugDirty) document.getElementById('pfSlug').value = slugify(e.target.value);
});
document.getElementById('pfSlug').addEventListener('input', () => { slugDirty = true; });

document.getElementById('productForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = document.getElementById('pfId').value;
  const name = document.getElementById('pfName').value.trim();
  const price = parseFloat(document.getElementById('pfPrice').value);
  if (!name) { toast('Name is required.', 'error'); return; }
  if (!isFinite(price) || price < 0) { toast('Enter a valid price.', 'error'); return; }
  const body = {
    name,
    slug: document.getElementById('pfSlug').value.trim() || slugify(name),
    description: document.getElementById('pfDescription').value.trim(),
    price_usd: price,
    category: document.getElementById('pfCategory').value.trim(),
    image_url: document.getElementById('pfImage').value.trim(),
    delivery_type: document.getElementById('pfType').value,
    delivery_payload: document.getElementById('pfPayload').value.trim(),
    active: document.getElementById('pfActive').checked ? 1 : 0,
  };
  try {
    if (id) {
      await api('/products/' + id, { method: 'PUT', body: JSON.stringify(body) });
      toast('Product updated.');
    } else {
      await api('/products', { method: 'POST', body: JSON.stringify(body) });
      toast('Product added.');
    }
    closeProductModal();
    loadedTabs.delete('keys');
    await loadProducts();
    if (loadedTabs.has('keys')) loadKeyPools();
  } catch (err) {
    if (err.message !== 'unauthorized') toast(err.message, 'error');
  }
});

/* ---------------- key pools ---------------- */

async function loadKeyPools() {
  if (productsCache.length === 0) {
    try { await loadProducts(); } catch (e) { return; }
  }
  const keyProducts = productsCache.filter((p) => p.delivery_type === 'key');
  const select = document.getElementById('keyProductSelect');
  select.innerHTML = keyProducts.length
    ? keyProducts.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('')
    : '<option value="">No key-delivery products</option>';
  keyProductId = keyProducts.length ? keyProducts[0].id : null;
  if (keyProductId) select.value = keyProductId;
  await renderKeys();
}

document.getElementById('keyProductSelect').addEventListener('change', async (e) => {
  keyProductId = e.target.value || null;
  await renderKeys();
});

async function renderKeys() {
  const tbody = document.querySelector('#keysTable tbody');
  if (!keyProductId) {
    tbody.innerHTML = '';
    document.getElementById('keysEmpty').hidden = false;
    return;
  }
  const data = await api('/keys?product_id=' + encodeURIComponent(keyProductId));
  const keys = data.keys || [];
  document.getElementById('keysEmpty').hidden = keys.length > 0;
  tbody.innerHTML = keys.map((k) => {
    const assigned = k.assigned_order_id != null;
    return `<tr>
      <td><code>${esc(k.key_value)}</code></td>
      <td>${assigned
        ? `<span class="badge badge-assigned">Assigned to order #${esc(k.assigned_order_id)}</span>`
        : '<span class="badge badge-available">Available</span>'}</td>
      <td>${assigned ? '' : `<button class="btn btn-danger btn-sm" data-key-id="${k.id}">Delete</button>`}</td>
    </tr>`;
  }).join('');
}

document.querySelector('#keysTable tbody').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-key-id]');
  if (!btn) return;
  if (!confirm('Delete this key?')) return;
  try {
    await api('/keys/' + btn.dataset.keyId, { method: 'DELETE' });
    toast('Key deleted.');
    await renderKeys();
  } catch (err) {
    if (err.message !== 'unauthorized') toast(err.message, 'error');
  }
});

document.getElementById('addKeysBtn').addEventListener('click', async () => {
  if (!keyProductId) { toast('Select a product first.', 'error'); return; }
  const raw = document.getElementById('keysTextarea').value;
  const keys = [...new Set(raw.split('\n').map((s) => s.trim()).filter(Boolean))];
  if (!keys.length) { toast('Paste at least one key.', 'error'); return; }
  try {
    const data = await api('/keys', {
      method: 'POST',
      body: JSON.stringify({ product_id: Number(keyProductId), keys }),
    });
    document.getElementById('keysTextarea').value = '';
    toast(`Added ${data.added != null ? data.added : keys.length} key(s).`);
    await renderKeys();
    loadedTabs.delete('products');
  } catch (err) {
    if (err.message !== 'unauthorized') toast(err.message, 'error');
  }
});

/* ---------------- orders ---------------- */

function orderItems(o) {
  let items = o.items;
  if (typeof items === 'string') {
    try { items = JSON.parse(items); } catch (e) { return items; }
  }
  return items;
}

function itemsSummary(o) {
  const items = orderItems(o);
  if (Array.isArray(items)) {
    return items.map((it) => {
      const qty = it.qty || it.quantity || 1;
      const name = it.name || it.product_name || it.title || 'Item';
      return `${esc(qty)}× ${esc(name)}`;
    }).join(', ') || '—';
  }
  return esc(typeof items === 'string' ? items : '—');
}

function statusBadge(status) {
  const s = String(status || '').toLowerCase();
  const cls = s === 'paid' ? 'badge-paid' : s === 'cancelled' ? 'badge-cancelled' : 'badge-pending';
  return `<span class="badge ${cls}">${esc(status || '—')}</span>`;
}

async function loadOrders() {
  const status = document.getElementById('orderFilter').value;
  const q = status ? '?status=' + encodeURIComponent(status) : '';
  const data = await api('/orders' + q);
  ordersCache = data.orders || [];
  renderOrders();
}

document.getElementById('orderFilter').addEventListener('change', () => {
  loadOrders().catch((e) => { if (e.message !== 'unauthorized') toast(e.message, 'error'); });
});

function renderOrders() {
  const tbody = document.querySelector('#ordersTable tbody');
  document.getElementById('ordersEmpty').hidden = ordersCache.length > 0;
  tbody.innerHTML = ordersCache.map((o) => {
    const user = o.tg_username ? '@' + o.tg_username : (o.tg_user_id != null ? 'ID ' + o.tg_user_id : '—');
    const pending = String(o.status).toLowerCase() === 'pending';
    return `<tr class="data-row" data-order-id="${o.id}">
      <td><strong>#${esc(o.id)}</strong></td>
      <td>${esc(user)}${o.tg_username && o.tg_user_id != null ? `<span class="cell-sub">ID ${esc(o.tg_user_id)}</span>` : ''}</td>
      <td>${itemsSummary(o)}</td>
      <td>${fmtMoney(o.total_usd)}${o.currency ? ' ' + esc(o.currency) : ''}</td>
      <td>${o.payway_tran_id ? `<code>${esc(o.payway_tran_id)}</code>` : '—'}</td>
      <td>${statusBadge(o.status)}</td>
      <td>${fmtDate(o.created_at)}</td>
      <td>${pending
        ? `<button class="btn btn-primary btn-sm" data-order-action="mark-paid" data-id="${o.id}">Mark paid</button>
           <button class="btn btn-danger btn-sm" data-order-action="cancel" data-id="${o.id}">Cancel</button>`
        : ''}</td>
    </tr>`;
  }).join('');
}

document.querySelector('#ordersTable tbody').addEventListener('click', async (e) => {
  const actionBtn = e.target.closest('[data-order-action]');
  if (actionBtn) {
    e.stopPropagation();
    const id = actionBtn.dataset.id;
    const action = actionBtn.dataset.orderAction;
    if (action === 'cancel' && !confirm('Cancel this order?')) return;
    try {
      await api(`/orders/${id}/${action === 'mark-paid' ? 'mark-paid' : 'cancel'}`, { method: 'POST' });
      toast(action === 'mark-paid' ? 'Order marked as paid.' : 'Order cancelled.');
      await loadOrders();
      loadedTabs.delete('dashboard');
    } catch (err) {
      if (err.message !== 'unauthorized') toast(err.message, 'error');
    }
    return;
  }
  const row = e.target.closest('tr.data-row');
  if (!row) return;
  toggleOrderDetail(row);
});

function toggleOrderDetail(row) {
  const next = row.nextElementSibling;
  if (next && next.classList.contains('detail-row')) { next.remove(); return; }
  const o = ordersCache.find((x) => String(x.id) === String(row.dataset.orderId));
  if (!o) return;
  const items = orderItems(o);
  const itemsPretty = typeof items === 'string' ? esc(items) : esc(JSON.stringify(items, null, 2));
  const detail = document.createElement('tr');
  detail.className = 'detail-row';
  detail.innerHTML = `<td colspan="8">
    <div class="detail-box">
      <dl class="detail-grid">
        <div><dt>Customer</dt><dd>${esc(o.tg_username ? '@' + o.tg_username : '—')}</dd></div>
        <div><dt>Telegram user ID</dt><dd>${esc(o.tg_user_id != null ? o.tg_user_id : '—')}</dd></div>
        <div><dt>PayWay transaction</dt><dd>${esc(o.payway_tran_id || '—')}</dd></div>
        <div><dt>Paid at</dt><dd>${fmtDate(o.paid_at)}</dd></div>
      </dl>
      <div><strong>Delivery details / items</strong></div>
      <pre>${itemsPretty}</pre>
    </div>
  </td>`;
  row.after(detail);
}

/* ---------------- import ---------------- */

document.getElementById('importBtn').addEventListener('click', async () => {
  const file = document.getElementById('csvFile').files[0];
  const result = document.getElementById('importResult');
  if (!file) { toast('Choose a CSV file first.', 'error'); return; }
  const form = new FormData();
  form.append('file', file);
  result.hidden = true;
  try {
    const res = await fetch(API + '/import', {
      method: 'POST',
      headers: { 'x-admin-token': token },
      body: form,
    });
    if (res.status === 401) { showGate('Invalid or expired token. Please sign in again.'); return; }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Import failed (' + res.status + ')');
    result.hidden = false;
    result.className = 'import-result ' + (data.skipped > 0 ? 'warn' : 'ok');
    result.textContent = `Imported ${data.imported} product(s)` + (data.skipped ? `, skipped ${data.skipped}.` : '.');
    toast('Import complete.');
    loadedTabs.delete('products');
    loadedTabs.delete('keys');
  } catch (err) {
    if (err.message !== 'unauthorized') toast(err.message, 'error');
  }
});

/* ---------------- settings ---------------- */

async function loadSettings() {
  const data = await api('/settings');
  const settings = data.settings || {};
  if (settings.shop_name) document.getElementById('shopName').textContent = settings.shop_name;
  renderSettings(settings);
}

function renderSettings(settings) {
  const tbody = document.querySelector('#settingsTable tbody');
  const entries = Object.entries(settings);
  tbody.innerHTML = entries.map(([k, v]) => settingsRow(k, v)).join('');
  if (!entries.length) {
    tbody.innerHTML = `<tr><td colspan="3" class="muted" style="text-align:center">No settings yet.</td></tr>`;
  }
}

function settingsRow(k, v) {
  return `<tr>
    <td><input type="text" class="setting-key" value="${esc(k)}" placeholder="key"></td>
    <td><input type="text" class="setting-value" value="${esc(v)}" placeholder="value"></td>
    <td><button class="btn btn-danger btn-sm setting-del">Remove</button></td>
  </tr>`;
}

document.getElementById('addSettingBtn').addEventListener('click', () => {
  const tbody = document.querySelector('#settingsTable tbody');
  const placeholder = tbody.querySelector('td.muted');
  if (placeholder) tbody.innerHTML = '';
  tbody.insertAdjacentHTML('beforeend', settingsRow('', ''));
});

document.querySelector('#settingsTable tbody').addEventListener('click', (e) => {
  const btn = e.target.closest('.setting-del');
  if (btn) btn.closest('tr').remove();
});

document.getElementById('saveSettingsBtn').addEventListener('click', async () => {
  const rows = document.querySelectorAll('#settingsTable tbody tr');
  const settings = {};
  for (const row of rows) {
    const k = row.querySelector('.setting-key');
    const v = row.querySelector('.setting-value');
    if (!k) continue;
    const key = k.value.trim();
    if (key) settings[key] = v.value;
  }
  try {
    await api('/settings', { method: 'PUT', body: JSON.stringify({ settings }) });
    if (settings.shop_name) document.getElementById('shopName').textContent = settings.shop_name;
    toast('Settings saved.');
  } catch (err) {
    if (err.message !== 'unauthorized') toast(err.message, 'error');
  }
});

/* ---------------- boot ---------------- */

document.addEventListener('DOMContentLoaded', () => {
  if (token) {
    api('/stats').then(
      () => init(),
      (e) => { if (e.message === 'unauthorized') { /* gate already shown */ } else { toast(e.message, 'error'); init(); } }
    );
  } else {
    showGate();
  }
});
