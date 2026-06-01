const fmt = n => `$${n.toLocaleString('en-US')}`;

const root = document.getElementById('root');
let view = { tab: 'pending', bids: [], items: null };

async function fetchBids() {
  const res = await fetch('/api/admin/bids');
  if (res.status === 401) { renderLogin(); return false; }
  view.bids = (await res.json()).bids;
  return true;
}

async function fetchItems() {
  const res = await fetch('/api/items');
  view.items = await res.json();
}

function renderLogin(err = '') {
  root.innerHTML = `
    <div class="login-card">
      <h1>Seller sign in</h1>
      <p class="muted">Enter the admin password to view bids.</p>
      <form id="login-form">
        <label>Password<input type="password" name="password" autofocus required /></label>
        <button type="submit" class="primary">Sign in</button>
        ${err ? `<div class="error">${err}</div>` : ''}
      </form>
    </div>`;
  document.getElementById('login-form').addEventListener('submit', async e => {
    e.preventDefault();
    const password = e.target.password.value;
    const res = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    if (!res.ok) return renderLogin('Wrong password.');
    init();
  });
}

async function init() {
  const ok = await fetchBids();
  if (!ok) return;
  await fetchItems();
  renderDashboard();
}

function bidStatusLabel(b) {
  if (b.status === 'auto-declined') return 'auto-declined';
  return b.status;
}

function renderDashboard() {
  const pending = view.bids.filter(b => b.status === 'pending');
  const decided = view.bids.filter(b => b.status !== 'pending');
  const sold = view.items.categories.flatMap(c => c.items.filter(i => i.sold).map(i => ({ ...i, category: c.title })));

  root.innerHTML = `
    <div class="admin-shell">
      <h1>Seller dashboard</h1>
      <p class="muted">${pending.length} pending request${pending.length === 1 ? '' : 's'} · ${sold.length} item${sold.length === 1 ? '' : 's'} sold</p>
      <div class="admin-tabs">
        <button class="admin-tab ${view.tab === 'pending' ? 'active' : ''}" data-tab="pending">Pending (${pending.length})</button>
        <button class="admin-tab ${view.tab === 'history' ? 'active' : ''}" data-tab="history">History (${decided.length})</button>
        <button class="admin-tab ${view.tab === 'sold' ? 'active' : ''}" data-tab="sold">Sold items (${sold.length})</button>
        <button class="admin-tab" id="logout" style="margin-left:auto;">Sign out</button>
      </div>
      <div id="tab-body"></div>
    </div>`;

  for (const tabBtn of document.querySelectorAll('.admin-tab[data-tab]')) {
    tabBtn.addEventListener('click', () => { view.tab = tabBtn.dataset.tab; renderDashboard(); });
  }
  document.getElementById('logout').addEventListener('click', async () => {
    await fetch('/api/admin/logout', { method: 'POST' });
    renderLogin();
  });

  const body = document.getElementById('tab-body');
  if (view.tab === 'pending') body.innerHTML = renderBidList(pending, true);
  else if (view.tab === 'history') body.innerHTML = renderBidList(decided, false);
  else body.innerHTML = renderSold(sold);

  wireBidActions();
  wireSoldActions();
}

function renderBidList(bids, allowDecisions) {
  if (bids.length === 0) {
    return `<div class="cart-empty" style="padding:60px 0;">No ${view.tab === 'pending' ? 'pending' : 'past'} requests yet.</div>`;
  }
  return `<div class="bid-list">${bids.map(b => `
    <div class="bid-card ${b.status}">
      <div class="bid-head">
        <div>
          <div class="bid-buyer">${escapeHtml(b.name)}</div>
          <div class="bid-contact">${escapeHtml(b.contact)} · <span class="bid-when">${new Date(b.createdAt).toLocaleString()}</span></div>
        </div>
        <div style="text-align:right;">
          <div class="bid-total">${fmt(b.total)}</div>
          <span class="bid-status ${b.status}">${bidStatusLabel(b)}</span>
        </div>
      </div>
      ${b.note ? `<div class="bid-note">${escapeHtml(b.note)}</div>` : ''}
      <div class="bid-items">
        ${b.items.map(it => `
          <div class="bid-item ${it.sold && b.status === 'pending' ? 'sold' : ''}">
            <span>${escapeHtml(it.name)} <span class="muted">— ${escapeHtml(it.category || '')}</span>${it.sold && b.status === 'pending' ? ' <strong>(already sold)</strong>' : ''}</span>
            <span>${fmt(it.price)}</span>
          </div>
        `).join('')}
        ${b.lotsApplied?.length ? `<div class="bid-item" style="border-top:1px solid var(--line); margin-top:6px; padding-top:8px;"><span>Lot deal applied: ${b.lotsApplied.map(l => `${escapeHtml(l.label)} (${fmt(l.price)})`).join(', ')}</span><span></span></div>` : ''}
      </div>
      ${b.autoDeclineReason ? `<div class="muted" style="font-size:12px;">Reason: ${escapeHtml(b.autoDeclineReason)}</div>` : ''}
      <div class="bid-actions">
        ${allowDecisions ? `
          <button class="approve" data-approve="${b.id}">Approve & mark sold</button>
          <button class="decline" data-decline="${b.id}">Decline</button>
        ` : ''}
        <button class="delete" data-delete="${b.id}">Delete</button>
      </div>
    </div>
  `).join('')}</div>`;
}

function renderSold(items) {
  if (items.length === 0) {
    return `<div class="cart-empty" style="padding:60px 0;">Nothing marked sold yet.</div>`;
  }
  return `<div class="sold-items">${items.map(i => `
    <div class="sold-item">
      <span>${escapeHtml(i.name)} <span class="muted">— ${escapeHtml(i.category)}</span></span>
      <span>${fmt(i.price)} <button data-unsell="${i.id}">unsell</button></span>
    </div>
  `).join('')}</div>`;
}

function wireBidActions() {
  for (const btn of document.querySelectorAll('[data-approve]')) {
    btn.addEventListener('click', async () => {
      btn.disabled = true; btn.textContent = 'Approving…';
      const res = await fetch(`/api/admin/bids/${btn.dataset.approve}/approve`, { method: 'POST' });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        alert(err.error || 'Could not approve.');
        btn.disabled = false; btn.textContent = 'Approve & mark sold';
        return;
      }
      await init();
    });
  }
  for (const btn of document.querySelectorAll('[data-decline]')) {
    btn.addEventListener('click', async () => {
      if (!confirm('Decline this request?')) return;
      await fetch(`/api/admin/bids/${btn.dataset.decline}/decline`, { method: 'POST' });
      await init();
    });
  }
  for (const btn of document.querySelectorAll('[data-delete]')) {
    btn.addEventListener('click', async () => {
      if (!confirm('Permanently delete this request from history?')) return;
      await fetch(`/api/admin/bids/${btn.dataset.delete}/delete`, { method: 'POST' });
      await init();
    });
  }
}

function wireSoldActions() {
  for (const btn of document.querySelectorAll('[data-unsell]')) {
    btn.addEventListener('click', async () => {
      if (!confirm('Mark this item as available again?')) return;
      await fetch(`/api/admin/items/${btn.dataset.unsell}/unsell`, { method: 'POST' });
      await init();
    });
  }
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

init();
