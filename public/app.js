const state = {
  data: null,
  cart: new Set(),
  search: '',
  hideSold: true,
  priceCache: { sig: null, value: null },
};

const fmt = n => `$${n.toLocaleString('en-US')}`;

async function loadItems() {
  const res = await fetch('/api/items');
  state.data = await res.json();
  state.priceCache = { sig: null, value: null }; // availability may have changed
  hydrate();
  render();
}

function itemName(id) {
  for (const c of state.data.categories) for (const it of c.items) if (it.id === id) return it.name;
  return null;
}

// Drop anything from the cart that is no longer available or no longer exists.
function pruneCart() {
  if (!state.data) return;
  const available = new Set();
  for (const c of state.data.categories) for (const it of c.items) if (!it.sold) available.add(it.id);
  let changed = false;
  for (const id of [...state.cart]) if (!available.has(id)) { state.cart.delete(id); changed = true; }
  if (changed) persistCart();
}

function hydrate() {
  const sale = state.data.sale;
  document.getElementById('brand-text').textContent = sale.title;
  document.getElementById('hero-title').textContent = sale.title;
  document.getElementById('hero-sub').textContent = `${sale.subtitle}`;
  document.getElementById('foot-loc').textContent = sale.location;

  try {
    const saved = JSON.parse(localStorage.getItem('cart') || '[]');
    const valid = new Set();
    for (const c of state.data.categories) for (const it of c.items) if (!it.sold) valid.add(it.id);
    for (const id of saved) if (valid.has(id)) state.cart.add(id);
  } catch {}
}

function nonBikeCategories() {
  const excluded = new Set(state.data.sale.fullLot.excludeCategoryIds);
  return state.data.categories.filter(c => !excluded.has(c.id));
}

function availableCategoryIds(cat) {
  return cat.items.filter(i => !i.sold).map(i => i.id);
}

// Mirrors the server's pricing rule exactly (see server.js):
// effective lot price = min(set price, 10% off the remaining items),
// offered only while at least MIN_LOT_ITEMS remain.
const MIN_LOT_ITEMS = 2;
function effectiveLotPrice(initial, availSum) {
  return Math.min(initial, Math.round(0.9 * availSum));
}

function categoryLot(cat) {
  const avail = cat.items.filter(i => !i.sold);
  const availSum = avail.reduce((a, b) => a + b.price, 0);
  const price = effectiveLotPrice(cat.lotPrice, availSum);
  return {
    avail,
    availIds: avail.map(i => i.id),
    availSum,
    price,
    savings: availSum - price,
    worth: avail.length >= MIN_LOT_ITEMS,
  };
}

function fullLotState() {
  const initial = state.data.sale.fullLot.price;
  const availIds = [];
  let availSum = 0;
  for (const c of nonBikeCategories()) {
    for (const it of c.items) if (!it.sold) { availIds.push(it.id); availSum += it.price; }
  }
  const price = effectiveLotPrice(initial, availSum);
  return { availIds, availSum, price, savings: availSum - price, worth: availIds.length >= MIN_LOT_ITEMS };
}

function persistCart() {
  localStorage.setItem('cart', JSON.stringify([...state.cart]));
}

async function priceCart() {
  if (state.cart.size === 0) return { total: 0, lotsApplied: [], lineItems: [] };
  const sig = [...state.cart].sort().join(',');
  if (state.priceCache.sig === sig) return state.priceCache.value;
  const res = await fetch('/api/price', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ itemIds: [...state.cart] }),
  });
  const value = await res.json();
  state.priceCache = { sig, value };
  return value;
}

function render() {
  pruneCart();
  const root = document.getElementById('categories');
  const q = state.search.toLowerCase().trim();
  const hideSold = state.hideSold;
  root.innerHTML = '';

  for (const cat of state.data.categories) {
    const visibleItems = cat.items.filter(it => {
      if (hideSold && it.sold) return false;
      if (!q) return true;
      return cat.title.toLowerCase().includes(q) || it.name.toLowerCase().includes(q);
    });
    if (visibleItems.length === 0) continue;

    const el = document.createElement('section');
    el.className = 'category';
    const lot = categoryLot(cat);
    const lotInCart = lot.availIds.length > 0 && lot.availIds.every(id => state.cart.has(id));

    // Lot row sits at the END of the section, and only while the deal still saves money.
    const lotRow = lot.worth
      ? `<div class="category-lot-row at-end">
           <div class="category-lot">Lot: <strong>${fmt(lot.price)}</strong> <span class="save">save ${fmt(lot.savings)}</span></div>
           <button class="category-lot-btn${lotInCart ? ' in-cart' : ''}" data-cat-lot="${cat.id}">${lotInCart ? '✓ Lot in cart' : 'Add lot to cart'}</button>
         </div>`
      : '';

    el.innerHTML = `
      <div class="category-media" data-cat="${cat.id}">
        <img src="/images/${cat.image}" alt="${cat.title}" loading="lazy" />
        <div class="category-media-tag">${cat.items.length} item${cat.items.length === 1 ? '' : 's'}</div>
      </div>
      <div class="category-info">
        <h2 class="category-title">${cat.title}</h2>
        <div class="items" data-cat-items="${cat.id}"></div>
        ${lotRow}
      </div>
    `;
    const itemsEl = el.querySelector('[data-cat-items]');
    for (const it of visibleItems) {
      const inCart = state.cart.has(it.id);
      const row = document.createElement('div');
      row.className = 'item' + (it.sold ? ' sold' : '') + (inCart ? ' in-cart' : '');
      row.innerHTML = `
        <div class="item-name" title="${it.name}">${it.name}</div>
        <div class="item-price">${fmt(it.price)}</div>
        ${it.sold
          ? '<span class="sold-tag">SOLD</span>'
          : `<button class="item-action${inCart ? ' in-cart' : ''}" data-item="${it.id}">${inCart ? 'In cart' : 'Add'}</button>`}
      `;
      itemsEl.appendChild(row);
    }
    root.appendChild(el);
  }

  if (!root.children.length) {
    const anyAvailable = state.data.categories.some(c => c.items.some(i => !i.sold));
    root.innerHTML = `<div class="empty-state">${
      q ? 'No items match your search.'
        : (anyAvailable ? 'No items to show.' : 'Everything has been sold — thanks for looking!')
    }</div>`;
  }

  document.getElementById('cart-count').textContent = state.cart.size;

  const fl = fullLotState();
  const heroLot = document.getElementById('hero-lot');
  const takeAllBtn = document.getElementById('take-all-btn');
  if (fl.worth) {
    heroLot.innerHTML = `<span>Take everything (excluding bikes):</span> <strong>${fmt(fl.price)}</strong> <span class="hero-save">save ${fmt(fl.savings)}</span>`;
    const allInCart = fl.availIds.every(id => state.cart.has(id));
    takeAllBtn.style.display = '';
    takeAllBtn.disabled = false;
    takeAllBtn.classList.toggle('in-cart', allInCart);
    takeAllBtn.textContent = allInCart ? '✓ Everything in cart' : 'Add everything to cart';
  } else {
    heroLot.innerHTML = `<span>Browse the items below — buying individually now beats the full-lot bundle.</span>`;
    takeAllBtn.style.display = 'none';
  }

  renderCart();
}

async function renderCart() {
  const body = document.getElementById('cart-body');
  const totalEl = document.getElementById('cart-total');
  const savingsEl = document.getElementById('cart-savings');
  const checkout = document.getElementById('checkout-btn');

  if (state.cart.size === 0) {
    body.innerHTML = '<div class="cart-empty">Your cart is empty.<br/>Browse items and tap <strong>Add</strong>.</div>';
    totalEl.textContent = '$0';
    savingsEl.textContent = '';
    checkout.disabled = true;
    return;
  }

  const price = await priceCart();
  checkout.disabled = false;

  const lotMap = new Map();
  for (const lot of price.lotsApplied) lotMap.set(lot.kind === 'full' ? '__full__' : lot.categoryId, lot);

  const byCat = new Map();
  for (const li of price.lineItems) {
    const key = li.includedInLot === 'full' ? '__full__' : (li.includedInLot || ('_' + state.data.categories.find(c => c.items.some(i => i.id === li.itemId))?.id));
    if (!byCat.has(key)) byCat.set(key, []);
    byCat.get(key).push(li);
  }

  let html = '';
  const sumIndividual = price.lineItems.reduce((a, b) => a + b.price, 0);

  for (const [key, lines] of byCat) {
    const lot = lotMap.get(key);
    if (lot) {
      const sub = lines.reduce((a, b) => a + b.price, 0);
      const save = sub - lot.price;
      html += `<div class="cart-lot-badge">${lot.label}: <strong>${fmt(lot.price)}</strong> — saved ${fmt(save)}</div>`;
      for (const li of lines) {
        html += `<div class="cart-line lot">
          <div class="cart-line-name struck" title="${li.name}">${li.name}</div>
          <div class="cart-line-price">${fmt(li.price)}</div>
          <button class="cart-line-remove" data-remove="${li.itemId}" aria-label="Remove">✕</button>
        </div>`;
      }
    } else {
      for (const li of lines) {
        html += `<div class="cart-line">
          <div class="cart-line-name" title="${li.name}">${li.name}</div>
          <div class="cart-line-price bold">${fmt(li.price)}</div>
          <button class="cart-line-remove" data-remove="${li.itemId}" aria-label="Remove">✕</button>
        </div>`;
      }
    }
  }

  body.innerHTML = html;
  totalEl.textContent = fmt(price.total);
  const totalSavings = sumIndividual - price.total;
  savingsEl.textContent = totalSavings > 0 ? `You're saving ${fmt(totalSavings)} with lot deals.` : '';
}

function openCart() {
  document.getElementById('cart-drawer').classList.add('open');
  document.getElementById('scrim').hidden = false;
}
function closeCart() {
  document.getElementById('cart-drawer').classList.remove('open');
  document.getElementById('scrim').hidden = true;
}

function toggleItem(id) {
  if (state.cart.has(id)) state.cart.delete(id);
  else state.cart.add(id);
  persistCart();
  render();
}

document.addEventListener('click', e => {
  const addBtn = e.target.closest('[data-item]');
  if (addBtn) { toggleItem(addBtn.dataset.item); return; }
  const remove = e.target.closest('[data-remove]');
  if (remove) { state.cart.delete(remove.dataset.remove); persistCart(); render(); return; }
  const lotBtn = e.target.closest('[data-cat-lot]');
  if (lotBtn) { toggleCategoryLot(lotBtn.dataset.catLot); return; }
  const media = e.target.closest('[data-cat]');
  if (media) { openCategoryImage(media.dataset.cat); return; }
});

function toggleCategoryLot(catId) {
  const cat = state.data.categories.find(c => c.id === catId);
  if (!cat) return;
  const ids = availableCategoryIds(cat);
  const allIn = ids.every(id => state.cart.has(id));
  if (allIn) for (const id of ids) state.cart.delete(id);
  else for (const id of ids) state.cart.add(id);
  persistCart();
  render();
}

function toggleTakeAll() {
  const ids = fullLotState().availIds;
  if (ids.length === 0) return;
  const allIn = ids.every(id => state.cart.has(id));
  if (allIn) for (const id of ids) state.cart.delete(id);
  else for (const id of ids) state.cart.add(id);
  persistCart();
  render();
  openCart();
}

document.getElementById('take-all-btn').addEventListener('click', toggleTakeAll);

document.getElementById('cart-btn').addEventListener('click', openCart);
document.getElementById('cart-close').addEventListener('click', closeCart);
document.getElementById('scrim').addEventListener('click', closeCart);

document.getElementById('search').addEventListener('input', e => {
  state.search = e.target.value;
  render();
});
document.getElementById('hide-sold').addEventListener('change', e => {
  state.hideSold = e.target.checked;
  render();
});

async function refreshCheckoutSummary() {
  const summary = document.getElementById('dialog-summary');
  const price = await priceCart();
  let rows = '';
  for (const lot of price.lotsApplied) {
    rows += `<div class="row"><span>${lot.label}</span><span>${fmt(lot.price)}</span></div>`;
  }
  for (const li of price.lineItems) {
    if (li.includedInLot) continue;
    rows += `<div class="row"><span>${li.name}</span><span>${fmt(li.price)}</span></div>`;
  }
  rows += `<div class="row total"><span>Total</span><span>${fmt(price.total)}</span></div>`;
  summary.innerHTML = rows;
}

document.getElementById('checkout-btn').addEventListener('click', async () => {
  await refreshCheckoutSummary();
  document.getElementById('form-error').hidden = true;
  document.getElementById('checkout-dialog').showModal();
});

document.getElementById('cancel-checkout').addEventListener('click', () => {
  document.getElementById('checkout-dialog').close();
});

document.getElementById('checkout-form').addEventListener('submit', async e => {
  e.preventDefault();
  const form = e.target;
  const data = {
    name: form.name.value.trim(),
    contact: form.contact.value.trim(),
    note: form.note.value.trim(),
    itemIds: [...state.cart],
  };
  const errBox = document.getElementById('form-error');
  errBox.hidden = true;
  const res = await fetch('/api/bids', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    if (res.status === 409 && Array.isArray(err.unavailableItemIds)) {
      const names = err.unavailableItemIds.map(itemName).filter(Boolean);
      for (const id of err.unavailableItemIds) state.cart.delete(id);
      persistCart();
      await loadItems();              // refresh availability + re-render
      if (state.cart.size === 0) {
        document.getElementById('checkout-dialog').close();
        return;
      }
      await refreshCheckoutSummary(); // reflect the trimmed cart
      errBox.textContent = `No longer available: ${names.join(', ') || 'some items'}. Removed from your cart — please review and resubmit.`;
    } else {
      errBox.textContent = err.error || 'Could not submit your request.';
    }
    errBox.hidden = false;
    return;
  }
  document.getElementById('checkout-dialog').close();
  state.cart.clear();
  persistCart();
  form.reset();
  document.getElementById('success-dialog').showModal();
  closeCart();
  loadItems();
});

document.getElementById('success-close').addEventListener('click', () => {
  document.getElementById('success-dialog').close();
});

function openCategoryImage(catId) {
  const cat = state.data.categories.find(c => c.id === catId);
  if (!cat) return;
  const dialog = document.getElementById('item-dialog');
  const dlgImg = document.getElementById('item-dialog-img');
  dlgImg.src = `/images/${cat.image}`;
  dlgImg.alt = cat.title;
  document.getElementById('item-dialog-cat').textContent = `${cat.items.length} item${cat.items.length === 1 ? '' : 's'}`;
  document.getElementById('item-dialog-name').textContent = cat.title;
  const lot = categoryLot(cat);
  document.getElementById('item-dialog-price').innerHTML = lot.worth
    ? `Lot: ${fmt(lot.price)} <span style="color:var(--ink-muted); font-weight:400; font-size:14px;">(${fmt(lot.availSum)} separately — save ${fmt(lot.savings)})</span>`
    : `<span style="font-size:15px; color:var(--ink-muted);">Items priced individually</span>`;
  const addBtn = document.getElementById('item-dialog-add');
  const available = lot.avail;
  const allInCart = available.length > 0 && available.every(i => state.cart.has(i.id));
  if (available.length === 0) {
    addBtn.style.display = 'none';
  } else {
    addBtn.style.display = '';
    const label = lot.worth ? 'lot' : 'all items';
    addBtn.textContent = allInCart ? `Remove ${label} from cart` : `Add ${label} to cart`;
  }
  addBtn.onclick = () => {
    if (allInCart) for (const i of available) state.cart.delete(i.id);
    else for (const i of available) state.cart.add(i.id);
    persistCart();
    dialog.close();
    render();
  };
  dialog.showModal();
}

document.getElementById('item-dialog-close').addEventListener('click', () => {
  document.getElementById('item-dialog').close();
});

loadItems();
