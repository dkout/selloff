const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme';
// The catalog ships WITH the app and is read-only at runtime.
const APP_DATA_DIR = path.join(__dirname, 'data');
const ITEMS_FILE = path.join(APP_DATA_DIR, 'items.json');
// Mutable runtime state (bids + sold items). In production point DATA_DIR at a
// persistent disk; mounting it here never hides the catalog above.
const STATE_DIR = process.env.DATA_DIR || APP_DATA_DIR;
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const PROD = process.env.NODE_ENV === 'production';
const COOKIE_FLAGS = `Path=/; HttpOnly; SameSite=Lax${PROD ? '; Secure' : ''}`;

const items = JSON.parse(fs.readFileSync(ITEMS_FILE, 'utf8'));

// Constant-time secret comparison (hash first so length isn't leaked).
function secretsMatch(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// Lightweight in-memory rate limiter keyed by client IP. Best-effort
// (single process, resets on restart) — enough to blunt brute force / spam.
function rateLimiter({ windowMs, max }) {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    let rec = hits.get(ip);
    if (!rec || now > rec.reset) rec = { count: 0, reset: now + windowMs };
    rec.count++;
    hits.set(ip, rec);
    if (hits.size > 5000) for (const [k, v] of hits) if (now > v.reset) hits.delete(k);
    if (rec.count > max) {
      const retry = Math.ceil((rec.reset - now) / 1000);
      res.setHeader('Retry-After', retry);
      return res.status(429).json({ error: 'Too many requests — please slow down and try again shortly.' });
    }
    next();
  };
}

function loadState() {
  fs.mkdirSync(STATE_DIR, { recursive: true }); // ensure the (possibly mounted) state dir exists
  if (!fs.existsSync(STATE_FILE)) {
    const initial = { bids: [], soldItemIds: [] };
    fs.writeFileSync(STATE_FILE, JSON.stringify(initial, null, 2));
    return initial;
  }
  return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
}

function saveState(state) {
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

let state = loadState();

const itemMap = new Map();
const itemToCategory = new Map();
for (const cat of items.categories) {
  for (const it of cat.items) {
    itemMap.set(it.id, it);
    itemToCategory.set(it.id, cat);
  }
}

// Minimum available items for a lot deal to be offered at all.
const MIN_LOT_ITEMS = 2;

// Effective lot price = the better of the seller's set price and a guaranteed
// 10%-off-the-remaining-items price. A lot therefore always saves at least 10%
// and never costs more than the original set price.
function effectiveLotPrice(initial, availSum) {
  return Math.min(initial, Math.round(0.9 * availSum));
}

// A lot deal applies to the items still AVAILABLE in its set, priced at
// effectiveLotPrice(), and is only offered while at least MIN_LOT_ITEMS remain.
function computeCartPrice(itemIds, soldIds = state.soldItemIds) {
  const sold = new Set(soldIds);
  // Sold items are never priced, even if a stale client sends them.
  const ids = new Set([...itemIds].filter(id => !sold.has(id)));
  const byCategory = new Map();
  for (const id of ids) {
    const cat = itemToCategory.get(id);
    if (!cat) continue;
    if (!byCategory.has(cat.id)) byCategory.set(cat.id, []);
    byCategory.get(cat.id).push(id);
  }

  let total = 0;
  const lotsApplied = [];
  const lineItems = [];

  const fullLot = items.sale.fullLot;
  const excluded = new Set(fullLot.excludeCategoryIds);
  const nonBikeCats = items.categories.filter(c => !excluded.has(c.id));
  const availNonBike = [];
  for (const c of nonBikeCats) for (const it of c.items) if (!sold.has(it.id)) availNonBike.push(it);
  const availNonBikeSum = availNonBike.reduce((a, b) => a + b.price, 0);

  const hasAllNonBike = availNonBike.length > 0 && availNonBike.every(it => ids.has(it.id));
  const fullLotPrice = effectiveLotPrice(fullLot.price, availNonBikeSum);

  if (hasAllNonBike && availNonBike.length >= MIN_LOT_ITEMS) {
    total += fullLotPrice;
    lotsApplied.push({ kind: 'full', label: fullLot.label, price: fullLotPrice });
    for (const it of availNonBike) {
      lineItems.push({ itemId: it.id, name: it.name, price: it.price, includedInLot: 'full' });
    }
    for (const [catId, selectedIds] of byCategory) {
      if (excluded.has(catId)) {
        for (const id of selectedIds) {
          const it = itemMap.get(id);
          total += it.price;
          lineItems.push({ itemId: id, name: it.name, price: it.price, includedInLot: null });
        }
      }
    }
    return { total, lotsApplied, lineItems };
  }

  for (const [catId, selectedIds] of byCategory) {
    const cat = itemToCategory.get(selectedIds[0]);
    const availItems = cat.items.filter(it => !sold.has(it.id));
    const availSum = availItems.reduce((a, b) => a + b.price, 0);
    const allAvailSelected = availItems.length > 0 && availItems.every(it => ids.has(it.id));
    if (allAvailSelected && availItems.length >= MIN_LOT_ITEMS && cat.lotPrice) {
      const lotPrice = effectiveLotPrice(cat.lotPrice, availSum);
      total += lotPrice;
      lotsApplied.push({ kind: 'category', categoryId: catId, label: `${cat.title} lot`, price: lotPrice });
      for (const id of selectedIds) {
        const it = itemMap.get(id);
        lineItems.push({ itemId: id, name: it.name, price: it.price, includedInLot: catId });
      }
    } else {
      for (const id of selectedIds) {
        const it = itemMap.get(id);
        total += it.price;
        lineItems.push({ itemId: id, name: it.name, price: it.price, includedInLot: null });
      }
    }
  }

  return { total, lotsApplied, lineItems };
}

const app = express();
// Trust the first proxy hop (Render/Railway/Fly/etc.) so req.ip reflects the
// real client for rate limiting. Override with TRUST_PROXY if needed.
app.set('trust proxy', process.env.TRUST_PROXY === undefined ? 1 : Number(process.env.TRUST_PROXY));
app.use(express.json({ limit: '100kb' }));

const loginLimiter = rateLimiter({ windowMs: 15 * 60 * 1000, max: 20 });
const bidLimiter = rateLimiter({ windowMs: 60 * 1000, max: 10 });

app.get('/api/items', (_req, res) => {
  const soldSet = new Set(state.soldItemIds);
  const pendingCount = new Map();
  for (const b of state.bids) {
    if (b.status === 'pending') {
      for (const id of b.itemIds) pendingCount.set(id, (pendingCount.get(id) || 0) + 1);
    }
  }
  const out = {
    sale: items.sale,
    categories: items.categories.map(cat => ({
      ...cat,
      items: cat.items.map(it => ({
        ...it,
        sold: soldSet.has(it.id),
        pendingRequests: pendingCount.get(it.id) || 0,
      })),
    })),
  };
  res.json(out);
});

app.post('/api/price', (req, res) => {
  const ids = Array.isArray(req.body.itemIds) ? req.body.itemIds : [];
  res.json(computeCartPrice(ids));
});

app.post('/api/bids', bidLimiter, (req, res) => {
  const name = (req.body.name || '').toString().trim().slice(0, 120);
  const contact = (req.body.contact || '').toString().trim().slice(0, 200);
  const note = (req.body.note || '').toString().trim().slice(0, 500);
  // De-dupe and cap to keep stored bids bounded.
  const itemIds = Array.isArray(req.body.itemIds)
    ? [...new Set(req.body.itemIds.filter(id => itemMap.has(id)))].slice(0, 500)
    : [];

  if (!name) return res.status(400).json({ error: 'Name is required' });
  if (!contact) return res.status(400).json({ error: 'Contact (email or phone) is required' });
  if (itemIds.length === 0) return res.status(400).json({ error: 'Pick at least one item' });

  const soldSet = new Set(state.soldItemIds);
  const unavailable = itemIds.filter(id => soldSet.has(id));
  if (unavailable.length > 0) {
    return res.status(409).json({ error: 'Some items are no longer available', unavailableItemIds: unavailable });
  }

  const price = computeCartPrice(itemIds);
  const bid = {
    id: crypto.randomBytes(6).toString('hex'),
    name,
    contact,
    note,
    itemIds,
    total: price.total,
    lotsApplied: price.lotsApplied,
    status: 'pending',
    createdAt: new Date().toISOString(),
  };
  state.bids.unshift(bid);
  saveState(state);
  res.json({ ok: true, bidId: bid.id });
});

function requireAdmin(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const cookie = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith('admin='));
  let cookieToken = '';
  if (cookie) {
    try { cookieToken = decodeURIComponent(cookie.slice('admin='.length)); } catch { cookieToken = ''; }
  }
  if ((token && secretsMatch(token, ADMIN_PASSWORD)) || (cookieToken && secretsMatch(cookieToken, ADMIN_PASSWORD))) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

app.post('/api/admin/login', loginLimiter, (req, res) => {
  const password = (req.body.password || '').toString();
  if (!password || !secretsMatch(password, ADMIN_PASSWORD)) return res.status(401).json({ error: 'Wrong password' });
  res.setHeader('Set-Cookie', `admin=${encodeURIComponent(password)}; ${COOKIE_FLAGS}; Max-Age=${60 * 60 * 24 * 30}`);
  res.json({ ok: true });
});

app.post('/api/admin/logout', (_req, res) => {
  res.setHeader('Set-Cookie', `admin=; ${COOKIE_FLAGS}; Max-Age=0`);
  res.json({ ok: true });
});

app.get('/api/admin/bids', requireAdmin, (_req, res) => {
  const soldSet = new Set(state.soldItemIds);
  const bids = state.bids.map(b => ({
    ...b,
    items: b.itemIds.map(id => {
      const it = itemMap.get(id);
      const cat = itemToCategory.get(id);
      return it ? { id, name: it.name, price: it.price, category: cat?.title, sold: soldSet.has(id) } : { id, name: 'unknown', price: 0 };
    }),
  }));
  res.json({ bids });
});

app.post('/api/admin/bids/:id/approve', requireAdmin, (req, res) => {
  const bid = state.bids.find(b => b.id === req.params.id);
  if (!bid) return res.status(404).json({ error: 'Bid not found' });
  if (bid.status !== 'pending') return res.status(400).json({ error: `Bid is already ${bid.status}` });

  const soldSet = new Set(state.soldItemIds);
  const conflicts = bid.itemIds.filter(id => soldSet.has(id));
  if (conflicts.length > 0) {
    return res.status(409).json({ error: 'Some items are already sold', conflictItemIds: conflicts });
  }

  bid.status = 'approved';
  bid.decidedAt = new Date().toISOString();
  const sold = new Set(state.soldItemIds);
  for (const id of bid.itemIds) sold.add(id);
  state.soldItemIds = [...sold];

  const nowSold = new Set(state.soldItemIds);
  for (const other of state.bids) {
    if (other.id === bid.id || other.status !== 'pending') continue;
    if (other.itemIds.some(id => nowSold.has(id))) {
      other.status = 'auto-declined';
      other.decidedAt = new Date().toISOString();
      other.autoDeclineReason = 'overlapping item was approved for another buyer';
    }
  }
  saveState(state);
  res.json({ ok: true });
});

app.post('/api/admin/bids/:id/decline', requireAdmin, (req, res) => {
  const bid = state.bids.find(b => b.id === req.params.id);
  if (!bid) return res.status(404).json({ error: 'Bid not found' });
  if (bid.status !== 'pending') return res.status(400).json({ error: `Bid is already ${bid.status}` });
  bid.status = 'declined';
  bid.decidedAt = new Date().toISOString();
  saveState(state);
  res.json({ ok: true });
});

app.post('/api/admin/bids/:id/delete', requireAdmin, (req, res) => {
  const idx = state.bids.findIndex(b => b.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  state.bids.splice(idx, 1);
  saveState(state);
  res.json({ ok: true });
});

app.post('/api/admin/items/:id/unsell', requireAdmin, (req, res) => {
  const idx = state.soldItemIds.indexOf(req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not sold' });
  state.soldItemIds.splice(idx, 1);
  saveState(state);
  res.json({ ok: true });
});

// Photos are immutable for the life of the sale — cache aggressively.
app.use('/images', express.static(path.join(__dirname, 'public', 'images'), { maxAge: '7d' }));
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`Moving sale running on http://localhost:${PORT}`);
  console.log(`Admin: http://localhost:${PORT}/admin.html  (password: ${ADMIN_PASSWORD === 'changeme' ? '"changeme" — set ADMIN_PASSWORD env var to change' : '••••'})`);
});
