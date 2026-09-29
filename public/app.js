/* MiniShop — Telegram Mini App storefront */
(function () {
  'use strict';

  /* ---------------- Telegram ---------------- */
  var tg = (window.Telegram && window.Telegram.WebApp) ? window.Telegram.WebApp : null;

  function initTelegram() {
    if (!tg) return;
    tg.ready();
    tg.expand();
    // Apply theme params with fallbacks
    var tp = tg.themeParams || {};
    var set = function (name, value) { if (value) document.documentElement.style.setProperty(name, value); };
    set('--bg', tp.bg_color);
    set('--surface', tp.secondary_bg_color || tp.section_bg_color);
    set('--text', tp.text_color);
    set('--text-muted', tp.hint_color);
    set('--accent', tp.button_color);
    set('--border', 'rgba(127,127,127,0.18)');
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta && tp.bg_color) meta.setAttribute('content', tp.bg_color);
    // Single back-button router
    tg.BackButton.onClick(onBackPressed);
  }

  /* ---------------- State ---------------- */
  var state = {
    products: [],
    productsById: {},
    categories: [],
    activeCategory: 'All',
    query: '',
    cart: {},            // productId -> qty
    view: 'shop',
    modalProduct: null,
    modalQty: 1,
    checkoutCurrency: 'USD',
    checkoutTotals: { usd: 0, khr: 0 },
    orderId: null,
    pollTimer: null,
    countdownTimer: null,
    expiresAt: null,
    paying: false
  };

  var KHR_RATE = 4100; // approx rate for cart display only; backend totals are authoritative
  var PLACEHOLDER = 'data:image/svg+xml;utf8,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><rect width="400" height="400" fill="#1e2a38"/><text x="200" y="210" font-size="64" text-anchor="middle" fill="#9fb0c3">📦</text></svg>'
  );

  /* ---------------- Helpers ---------------- */
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function fmtUSD(n) { return '$' + Number(n || 0).toFixed(2); }
  function fmtKHR(n) { return '៛' + Math.round(Number(n || 0)).toLocaleString('en-US'); }

  function $(id) { return document.getElementById(id); }

  var toastTimer = null;
  function toast(msg) {
    var el = $('toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.add('hidden'); }, 3200);
  }

  async function api(path, opts) {
    opts = opts || {};
    var method = opts.method || 'GET';
    var fetchOpts = { method: method, headers: { 'Content-Type': 'application/json' } };
    if (opts.body) {
      var body = Object.assign({}, opts.body);
      if (tg && tg.initData) body.initData = tg.initData;
      fetchOpts.body = JSON.stringify(body);
    }
    var res = await fetch(path, fetchOpts);
    var data = null;
    try { data = await res.json(); } catch (e) { /* non-JSON */ }
    if (!res.ok) {
      var msg = (data && (data.error || data.message)) || ('Request failed (' + res.status + ')');
      throw new Error(msg);
    }
    return data;
  }

  function copyText(text) {
    function done() { toast('Copied to clipboard'); }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { toast('Copy failed'); });
    } else {
      var ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); done(); } catch (e) { toast('Copy failed'); }
      document.body.removeChild(ta);
    }
  }

  function deliveryHint(type) {
    switch (String(type || '').toLowerCase()) {
      case 'key': case 'license': case 'license_key': return '🔑 License key delivered instantly';
      case 'url': case 'link': return '🔗 Link delivered instantly';
      case 'file': case 'download': return '📥 Download delivered instantly';
      case 'account': return '👤 Account details delivered instantly';
      case 'subscription': return '🔁 Subscription activated instantly';
      default: return '⚡ Delivered instantly after payment';
    }
  }

  function imageSrc(p) { return p.image_url ? p.image_url : PLACEHOLDER; }

  /* ---------------- Navigation ---------------- */
  var VIEWS = ['shop', 'cart', 'checkout', 'payment', 'success', 'orders'];

  function showView(name) {
    state.view = name;
    VIEWS.forEach(function (v) { $('view-' + v).classList.toggle('hidden', v !== name); });
    // Tabs reflect the three main sections
    document.querySelectorAll('#tabs .tab').forEach(function (t) {
      var tv = t.getAttribute('data-view');
      t.classList.toggle('active', tv === name || (tv === 'cart' && (name === 'checkout' || name === 'payment')));
    });
    // Back button
    if (tg) {
      if (name === 'shop' || name === 'cart' || name === 'orders') tg.BackButton.hide();
      else tg.BackButton.show();
    }
    updateMainButton();
    window.scrollTo(0, 0);
  }

  function onBackPressed() {
    if (!$('modal-overlay').classList.contains('hidden')) { closeModal(); return; }
    if (!$('order-overlay').classList.contains('hidden')) { closeOrderModal(); return; }
    if (state.view === 'checkout') showView('cart');
    else if (state.view === 'payment') showView('cart'); // order stays pending, visible in Orders
    else if (state.view === 'success') showView('shop');
  }

  function updateMainButton() {
    if (!tg || !tg.MainButton) return;
    if (state.view === 'checkout' && !state.paying) {
      var total = cartTotalUSD();
      tg.MainButton.setText('Pay ' + fmtUSD(total));
      tg.MainButton.show();
    } else {
      tg.MainButton.hide();
    }
  }

  /* ---------------- Cart ---------------- */
  function loadCart() {
    try {
      var raw = localStorage.getItem('minishop_cart');
      state.cart = raw ? JSON.parse(raw) : {};
    } catch (e) { state.cart = {}; }
  }
  function saveCart() {
    try { localStorage.setItem('minishop_cart', JSON.stringify(state.cart)); } catch (e) {}
  }

  function cartCount() {
    return Object.keys(state.cart).reduce(function (n, id) { return n + (state.cart[id] || 0); }, 0);
  }
  function cartTotalUSD() {
    return Object.keys(state.cart).reduce(function (sum, id) {
      var p = state.productsById[id];
      return sum + (p ? p.price_usd * state.cart[id] : 0);
    }, 0);
  }

  function updateBadges() {
    var n = cartCount();
    [$('cart-badge'), $('tab-cart-badge')].forEach(function (el) {
      el.textContent = n;
      el.classList.toggle('hidden', n === 0);
    });
  }

  function addToCart(id, qty) {
    var p = state.productsById[id];
    if (!p) return;
    state.cart[id] = (state.cart[id] || 0) + (qty || 1);
    saveCart();
    updateBadges();
    if (state.view === 'cart') renderCart();
    toast('Added to cart');
  }

  /* ---------------- Catalog ---------------- */
  async function loadCatalog() {
    try {
      var [prodRes, catRes] = await Promise.all([
        api('/api/products'),
        api('/api/categories').catch(function () { return { categories: [] }; })
      ]);
      state.products = (prodRes.products || []).filter(function (p) { return p.active !== false; });
      state.productsById = {};
      state.products.forEach(function (p) { state.productsById[p.id] = p; });
      state.categories = catRes.categories || [];
      renderCategories();
      renderProducts();
    } catch (e) {
      $('product-grid').innerHTML = '<div class="empty" style="grid-column:1/-1"><span class="big">😕</span>Could not load products.<br>' + esc(e.message) + '</div>';
    }
  }

  function renderCategories() {
    var wrap = $('category-chips');
    var cats = ['All'].concat(state.categories);
    wrap.innerHTML = cats.map(function (c) {
      return '<button class="chip' + (c === state.activeCategory ? ' active' : '') + '" data-cat="' + esc(c) + '">' + esc(c) + '</button>';
    }).join('');
    wrap.querySelectorAll('.chip').forEach(function (chip) {
      chip.addEventListener('click', function () {
        state.activeCategory = chip.getAttribute('data-cat');
        renderCategories();
        renderProducts();
      });
    });
  }

  function filteredProducts() {
    var q = state.query.trim().toLowerCase();
    return state.products.filter(function (p) {
      var okCat = state.activeCategory === 'All' || p.category === state.activeCategory;
      var okQ = !q || (p.name + ' ' + (p.description || '')).toLowerCase().indexOf(q) !== -1;
      return okCat && okQ;
    });
  }

  function renderProducts() {
    var grid = $('product-grid');
    var list = filteredProducts();
    if (!list.length) {
      grid.innerHTML = '<div class="empty" style="grid-column:1/-1"><span class="big">🔍</span>No products found.</div>';
      return;
    }
    grid.innerHTML = list.map(function (p) {
      return '<div class="card" data-id="' + esc(p.id) + '">' +
        '<img class="card-img" src="' + esc(imageSrc(p)) + '" alt="' + esc(p.name) + '" loading="lazy" onerror="this.src=\'' + PLACEHOLDER + '\'" />' +
        '<div class="card-body">' +
          '<div class="tag">' + esc(p.category || 'General') + '</div>' +
          '<h4 class="card-name">' + esc(p.name) + '</h4>' +
          '<div class="card-foot">' +
            '<span class="price">' + fmtUSD(p.price_usd) + '</span>' +
            (p.keys_available === 0
              ? '<span class="tag">Sold out</span>'
              : '<button class="add-btn" data-add="' + esc(p.id) + '">Add</button>') +
          '</div>' +
        '</div></div>';
    }).join('');
    grid.querySelectorAll('.card').forEach(function (card) {
      card.addEventListener('click', function (e) {
        if (e.target.closest('[data-add]')) return; // handled below
        openProduct(card.getAttribute('data-id'));
      });
    });
    grid.querySelectorAll('[data-add]').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        addToCart(btn.getAttribute('data-add'), 1);
      });
    });
  }

  /* ---------------- Product modal ---------------- */
  function openProduct(id) {
    var p = state.productsById[id];
    if (!p) return;
    state.modalProduct = p;
    state.modalQty = 1;
    $('modal-img').src = imageSrc(p);
    $('modal-img').onerror = function () { this.src = PLACEHOLDER; };
    $('modal-category').textContent = p.category || 'General';
    $('modal-name').textContent = p.name;
    $('modal-desc').textContent = p.description || '';
    $('modal-delivery').textContent = deliveryHint(p.delivery_type);
    updateModalQty();
    $('modal-overlay').classList.remove('hidden');
    if (tg) tg.BackButton.show();
  }

  function updateModalQty() {
    var p = state.modalProduct;
    $('modal-qty').textContent = state.modalQty;
    $('modal-price').textContent = fmtUSD(p.price_usd * state.modalQty);
    $('modal-add').disabled = p.keys_available === 0;
    $('modal-add').textContent = p.keys_available === 0 ? 'Sold out' : 'Add to cart';
  }

  function closeModal() {
    $('modal-overlay').classList.add('hidden');
    state.modalProduct = null;
    updateMainButton();
    if (tg && (state.view === 'shop' || state.view === 'cart' || state.view === 'orders')) tg.BackButton.hide();
  }

  /* ---------------- Cart view ---------------- */
  function renderCart() {
    var wrap = $('cart-items');
    var ids = Object.keys(state.cart).filter(function (id) { return state.cart[id] > 0 && state.productsById[id]; });
    if (!ids.length) {
      wrap.innerHTML = '<div class="empty"><span class="big">🧺</span>Your cart is empty.</div>';
      $('cart-summary').classList.add('hidden');
      return;
    }
    wrap.innerHTML = ids.map(function (id) {
      var p = state.productsById[id];
      var qty = state.cart[id];
      return '<div class="cart-line" data-id="' + esc(id) + '">' +
        '<img class="cart-thumb" src="' + esc(imageSrc(p)) + '" alt="" onerror="this.src=\'' + PLACEHOLDER + '\'" />' +
        '<div class="cart-info"><div class="cart-name">' + esc(p.name) + '</div>' +
        '<div class="cart-price">' + fmtUSD(p.price_usd) + ' each</div></div>' +
        '<div class="stepper"><button class="step-btn" data-dec="' + esc(id) + '">−</button>' +
        '<span>' + qty + '</span>' +
        '<button class="step-btn" data-inc="' + esc(id) + '">+</button></div>' +
        '<button class="remove-btn" data-remove="' + esc(id) + '" aria-label="Remove">🗑</button>' +
      '</div>';
    }).join('');

    wrap.querySelectorAll('[data-inc]').forEach(function (b) {
      b.addEventListener('click', function () { var id = b.getAttribute('data-inc'); state.cart[id]++; saveCart(); updateBadges(); renderCart(); });
    });
    wrap.querySelectorAll('[data-dec]').forEach(function (b) {
      b.addEventListener('click', function () {
        var id = b.getAttribute('data-dec');
        state.cart[id]--;
        if (state.cart[id] <= 0) delete state.cart[id];
        saveCart(); updateBadges(); renderCart();
      });
    });
    wrap.querySelectorAll('[data-remove]').forEach(function (b) {
      b.addEventListener('click', function () { delete state.cart[b.getAttribute('data-remove')]; saveCart(); updateBadges(); renderCart(); });
    });

    var total = cartTotalUSD();
    $('cart-subtotal-usd').textContent = fmtUSD(total);
    $('cart-subtotal-khr').textContent = fmtKHR(total * KHR_RATE) + ' (approx)';
    $('cart-summary').classList.remove('hidden');
  }

  /* ---------------- Checkout ---------------- */
  function renderCheckout() {
    var ids = Object.keys(state.cart).filter(function (id) { return state.cart[id] > 0 && state.productsById[id]; });
    if (!ids.length) { showView('cart'); return; }
    $('checkout-items').innerHTML = ids.map(function (id) {
      var p = state.productsById[id];
      return '<div class="order-line"><span>' + esc(p.name) + ' <span class="muted">× ' + state.cart[id] + '</span></span><span>' + fmtUSD(p.price_usd * state.cart[id]) + '</span></div>';
    }).join('');
    updateCheckoutTotal();
  }

  function updateCheckoutTotal() {
    var usd = cartTotalUSD();
    $('checkout-total').textContent = state.checkoutCurrency === 'KHR' ? fmtKHR(usd * KHR_RATE) + ' (approx)' : fmtUSD(usd);
    updateMainButton();
  }

  async function startCheckout() {
    if (state.paying) return;
    var items = Object.keys(state.cart)
      .filter(function (id) { return state.cart[id] > 0 && state.productsById[id]; })
      .map(function (id) { return { product_id: id, qty: state.cart[id] }; });
    if (!items.length) { toast('Your cart is empty'); return; }
    state.paying = true;
    updateMainButton();
    $('pay-btn').disabled = true;
    $('pay-btn').textContent = 'Creating order…';
    try {
      var order = await api('/api/orders', { method: 'POST', body: { items: items } });
      state.checkoutTotals = { usd: order.total_usd, khr: order.total_khr };
      var pay = await api('/api/checkout', {
        method: 'POST',
        body: { order_id: order.order_id, currency: state.checkoutCurrency }
      });
      state.orderId = order.order_id;
      // Cart is now an order — clear it
      state.cart = {};
      saveCart();
      updateBadges();
      showPayment(pay);
    } catch (e) {
      toast(e.message);
    } finally {
      state.paying = false;
      $('pay-btn').disabled = false;
      $('pay-btn').textContent = 'Pay';
      updateMainButton();
    }
  }

  /* ---------------- Payment ---------------- */
  function showPayment(pay) {
    $('pay-qr').src = pay.qr_image || PLACEHOLDER;
    var amt = state.checkoutCurrency === 'KHR' ? fmtKHR(state.checkoutTotals.khr) : fmtUSD(state.checkoutTotals.usd);
    $('pay-amount').textContent = amt;
    $('test-badge').classList.toggle('hidden', !pay.mock);
    var dl = $('pay-deeplink');
    if (pay.abapay_deeplink) { dl.href = pay.abapay_deeplink; dl.classList.remove('hidden'); }
    else dl.classList.add('hidden');
    state.expiresAt = pay.expires_at ? new Date(pay.expires_at).getTime() : Date.now() + 10 * 60 * 1000;
    showView('payment');
    startCountdown();
    startPolling();
  }

  function startCountdown() {
    stopCountdown();
    function tick() {
      var left = Math.max(0, state.expiresAt - Date.now());
      var m = Math.floor(left / 60000), s = Math.floor((left % 60000) / 1000);
      var el = $('pay-countdown');
      el.textContent = left > 0 ? 'Expires in ' + m + ':' + String(s).padStart(2, '0') : 'Payment link expired';
      el.classList.toggle('expired', left <= 0);
      if (left <= 0) { stopCountdown(); stopPolling(); }
    }
    tick();
    state.countdownTimer = setInterval(tick, 1000);
  }
  function stopCountdown() {
    if (state.countdownTimer) { clearInterval(state.countdownTimer); state.countdownTimer = null; }
  }

  function startPolling() {
    stopPolling();
    state.pollTimer = setInterval(checkOrderStatus, 5000);
  }
  function stopPolling() {
    if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
  }

  async function checkOrderStatus() {
    if (!state.orderId) return;
    try {
      var st = await api('/api/orders/' + encodeURIComponent(state.orderId) + '/status');
      if (st.status === 'paid' || st.paid) {
        stopPolling(); stopCountdown();
        showSuccess(st.delivery || []);
      } else if (st.status === 'expired' || st.status === 'cancelled') {
        stopPolling(); stopCountdown();
        toast('Payment ' + st.status);
        showView('cart');
        renderCart();
      }
    } catch (e) { /* keep polling; show transient errors only on manual check */ }
  }

  async function cancelOrder() {
    if (!state.orderId) return;
    try {
      await api('/api/orders/' + encodeURIComponent(state.orderId) + '/cancel', { method: 'POST', body: {} });
    } catch (e) { toast(e.message); return; }
    stopPolling(); stopCountdown();
    state.orderId = null;
    toast('Order cancelled');
    showView('shop');
  }

  /* ---------------- Success / delivery ---------------- */
  function deliveryHTML(delivery) {
    if (!delivery || !delivery.length) {
      return '<div class="empty"><span class="big">📭</span>No delivery items yet.</div>';
    }
    return delivery.map(function (d) {
      var parts = '<h4>' + esc(d.name) + (d.qty > 1 ? ' × ' + d.qty : '') + '</h4>';
      (d.keys || []).forEach(function (k) {
        parts += '<div class="key-box"><span>' + esc(k) + '</span><button class="copy-btn" data-copy="' + esc(k) + '">Copy</button></div>';
      });
      if (d.url) {
        parts += '<a class="btn btn-secondary btn-block" style="text-decoration:none;display:block;text-align:center;margin:0 0 8px" href="' + esc(d.url) + '" target="_blank" rel="noopener">Open download link</a>';
      }
      if (d.instructions) {
        parts += '<div class="instructions">' + esc(d.instructions) + '</div>';
      }
      return '<div class="delivery-item">' + parts + '</div>';
    }).join('');
  }

  function bindCopyButtons(root) {
    root.querySelectorAll('[data-copy]').forEach(function (b) {
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        copyText(b.getAttribute('data-copy'));
      });
    });
  }

  function showSuccess(delivery) {
    var wrap = $('success-delivery');
    wrap.innerHTML = deliveryHTML(delivery);
    bindCopyButtons(wrap);
    state.orderId = null;
    showView('success');
  }

  /* ---------------- Orders ---------------- */
  async function loadOrders() {
    var wrap = $('orders-list');
    wrap.innerHTML = '<div class="skeleton-card"></div><div class="skeleton-card"></div>';
    try {
      var res = await api('/api/my-orders');
      var orders = res.orders || [];
      if (!orders.length) {
        wrap.innerHTML = '<div class="empty"><span class="big">📦</span>No orders yet.</div>';
        return;
      }
      wrap.innerHTML = orders.map(function (o) {
        var when = o.created_at ? new Date(o.created_at).toLocaleString() : '';
        var itemCount = (o.items || []).reduce(function (n, i) { return n + (i.qty || 1); }, 0);
        var total = o.currency === 'KHR' && o.total_khr ? fmtKHR(o.total_khr) : fmtUSD(o.total_usd);
        return '<div class="order-card" data-order="' + esc(o.id) + '">' +
          '<div class="order-top"><span class="order-id">#' + esc(String(o.id).slice(0, 8)) + '</span>' +
          '<span class="pill ' + esc(o.status) + '">' + esc(o.status) + '</span></div>' +
          '<div class="order-meta">' + itemCount + ' item(s) · ' + total + (when ? ' · ' + esc(when) : '') + '</div>' +
        '</div>';
      }).join('');
      wrap.querySelectorAll('[data-order]').forEach(function (card) {
        card.addEventListener('click', function () { openOrderDetail(card.getAttribute('data-order')); });
      });
    } catch (e) {
      wrap.innerHTML = '<div class="empty"><span class="big">😕</span>Could not load orders.<br>' + esc(e.message) + '</div>';
    }
  }

  async function openOrderDetail(id) {
    $('order-title').textContent = 'Order #' + String(id).slice(0, 8);
    $('order-delivery').innerHTML = '<div class="skeleton-card"></div>';
    $('order-overlay').classList.remove('hidden');
    if (tg) tg.BackButton.show();
    try {
      var st = await api('/api/orders/' + encodeURIComponent(id) + '/status');
      var wrap = $('order-delivery');
      wrap.innerHTML = deliveryHTML(st.delivery || []);
      bindCopyButtons(wrap);
    } catch (e) {
      $('order-delivery').innerHTML = '<div class="empty">Could not load delivery details.<br>' + esc(e.message) + '</div>';
    }
  }

  function closeOrderModal() {
    $('order-overlay').classList.add('hidden');
    if (tg && (state.view === 'shop' || state.view === 'cart' || state.view === 'orders')) tg.BackButton.hide();
  }

  /* ---------------- Events ---------------- */
  function bindEvents() {
    // Tabs
    document.querySelectorAll('#tabs .tab').forEach(function (t) {
      t.addEventListener('click', function () {
        var v = t.getAttribute('data-view');
        stopPolling(); stopCountdown();
        if (v === 'cart') renderCart();
        if (v === 'orders') loadOrders();
        showView(v);
      });
    });
    $('cart-btn').addEventListener('click', function () { renderCart(); showView('cart'); });

    // Search (debounced)
    var searchTimer = null;
    $('search-input').addEventListener('input', function (e) {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(function () { state.query = e.target.value; renderProducts(); }, 250);
    });

    // Modal
    $('modal-close').addEventListener('click', closeModal);
    $('modal-overlay').addEventListener('click', function (e) { if (e.target === $('modal-overlay')) closeModal(); });
    $('modal-inc').addEventListener('click', function () { state.modalQty++; updateModalQty(); });
    $('modal-dec').addEventListener('click', function () { if (state.modalQty > 1) state.modalQty--; updateModalQty(); });
    $('modal-add').addEventListener('click', function () {
      if (state.modalProduct) { addToCart(state.modalProduct.id, state.modalQty); closeModal(); }
    });

    // Checkout
    $('checkout-btn').addEventListener('click', function () { renderCheckout(); showView('checkout'); });
    $('currency-seg').querySelectorAll('.seg-btn').forEach(function (b) {
      b.addEventListener('click', function () {
        state.checkoutCurrency = b.getAttribute('data-currency');
        $('currency-seg').querySelectorAll('.seg-btn').forEach(function (x) { x.classList.toggle('active', x === b); });
        updateCheckoutTotal();
      });
    });
    $('pay-btn').addEventListener('click', startCheckout);

    // Payment
    $('check-status-btn').addEventListener('click', async function () {
      try { await checkOrderStatus(); toast('Still waiting for payment…'); }
      catch (e) { toast(e.message); }
    });
    $('cancel-order-btn').addEventListener('click', cancelOrder);

    // Success
    $('success-orders-btn').addEventListener('click', function () { loadOrders(); showView('orders'); });
    $('success-shop-btn').addEventListener('click', function () { showView('shop'); });

    // Order modal
    $('order-close').addEventListener('click', closeOrderModal);
    $('order-overlay').addEventListener('click', function (e) { if (e.target === $('order-overlay')) closeOrderModal(); });

    // Telegram MainButton
    if (tg && tg.MainButton) tg.MainButton.onClick(function () { if (state.view === 'checkout') startCheckout(); });
  }

  /* ---------------- Boot ---------------- */
  initTelegram();
  loadCart();
  updateBadges();
  bindEvents();
  showView('shop');
  loadCatalog();
})();
