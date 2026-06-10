const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const { computeCartPrice, computeDisplayPricing } = require('./lib/pricing');

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

// Production guard: never run a live deployment with the default/empty admin
// password — that would leave the seller dashboard wide open. Fail fast at
// startup instead of silently shipping an insecure default.
if (PROD && (!process.env.ADMIN_PASSWORD || ADMIN_PASSWORD === 'changeme')) {
  console.error(
    'FATAL: ADMIN_PASSWORD must be set to a non-default value when NODE_ENV=production.\n' +
    '       Set a strong ADMIN_PASSWORD env var (e.g. in your host\'s dashboard) and redeploy.'
  );
  process.exit(1);
}

const items = JSON.parse(fs.readFileSync(ITEMS_FILE, 'utf8'));

// Constant-time secret comparison (hash first so length isn't leaked).
function secretsMatch(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// Admin sessions: the cookie holds a random token, never the password itself.
// Tokens live in memory only — a restart/redeploy just means logging in again,
// and state.json (orders) is never touched by auth.
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_SESSIONS = 500;
const sessions = new Map(); // token -> expiry epoch ms

function createSession() {
  const now = Date.now();
  for (const [t, exp] of sessions) if (now > exp) sessions.delete(t);
  while (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, now + SESSION_TTL_MS);
  return token;
}

function sessionValid(token) {
  if (!token) return false;
  const exp = sessions.get(token);
  if (!exp) return false;
  if (Date.now() > exp) { sessions.delete(token); return false; }
  return true;
}

function readAdminCookie(req) {
  const cookie = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith('admin='));
  return cookie ? cookie.slice('admin='.length) : '';
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

const fmtMoney = n => `$${Number(n).toLocaleString('en-US')}`;

// --- Email notifications (best-effort) ---------------------------------------
// Enabled only when SMTP_URL and NOTIFY_EMAIL are set; otherwise the app runs
// exactly as before with notifications off. Sending is fire-and-forget: a mail
// failure is logged but never blocks or fails a buyer's submission.
//   SMTP_URL     transport URL, e.g. smtps://user:pass@smtp.example.com:465
//   NOTIFY_EMAIL where new-request alerts are sent (the seller)
//   NOTIFY_FROM  From address (defaults to NOTIFY_EMAIL)
const NOTIFY_TO = process.env.NOTIFY_EMAIL;
const NOTIFY_FROM = process.env.NOTIFY_FROM || NOTIFY_TO;
let mailer = null;
if (process.env.SMTP_URL && NOTIFY_TO) {
  mailer = nodemailer.createTransport(process.env.SMTP_URL);
  console.log(`Email notifications ON → ${NOTIFY_TO}`);
} else {
  console.log('Email notifications OFF (set SMTP_URL and NOTIFY_EMAIL to enable)');
}

function notifyNewBid(bid) {
  if (!mailer) return;
  const lines = bid.itemIds.map(id => {
    const it = itemMap.get(id);
    return it ? `  • ${it.name} — ${fmtMoney(it.price)}` : `  • ${id}`;
  });
  const lots = bid.lotsApplied.length
    ? '\nLot deals applied: ' + bid.lotsApplied.map(l => `${l.label} (${fmtMoney(l.price)})`).join(', ') + '\n'
    : '';
  const text =
`New purchase request — total ${fmtMoney(bid.total)}

From:    ${bid.name}
Contact: ${bid.contact}
${bid.note ? `Note:    ${bid.note}\n` : ''}
Items:
${lines.join('\n')}
${lots}
Open the seller dashboard to approve or decline.
Request id: ${bid.id}`;

  // Don't await — keep the request fast and never fail the bid on a mail error.
  mailer.sendMail({
    from: NOTIFY_FROM,
    to: NOTIFY_TO,
    subject: `New request from ${bid.name} — ${fmtMoney(bid.total)}`,
    text,
  }).catch(err => console.error('Email notification failed:', err.message));
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
  // Lot offers are computed here so the storefront only ever displays prices
  // the server will actually charge.
  const display = computeDisplayPricing(items, state.soldItemIds);
  const out = {
    sale: { ...items.sale, fullLotOffer: display.fullLot },
    categories: items.categories.map(cat => ({
      ...cat,
      lot: display.categories[cat.id],
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
  res.json(computeCartPrice(items, ids, state.soldItemIds));
});

// Cap stored bids so abuse can't grow state.json without bound. Oldest decided
// bids are pruned first; pending bids are never dropped automatically.
const MAX_STORED_BIDS = 500;

app.post('/api/bids', bidLimiter, (req, res) => {
  // Single-line fields: collapse newlines too (they'd otherwise reach the
  // notification email's subject/headers).
  const oneLine = v => (v || '').toString().replace(/[\r\n]+/g, ' ').trim();
  const name = oneLine(req.body.name).slice(0, 120);
  const contact = oneLine(req.body.contact).slice(0, 200);
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

  if (state.bids.length >= MAX_STORED_BIDS) {
    for (let i = state.bids.length - 1; i >= 0 && state.bids.length >= MAX_STORED_BIDS; i--) {
      if (state.bids[i].status !== 'pending') state.bids.splice(i, 1);
    }
    if (state.bids.length >= MAX_STORED_BIDS) {
      return res.status(503).json({ error: 'Too many open requests right now — please try again later.' });
    }
  }

  const price = computeCartPrice(items, itemIds, state.soldItemIds);
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
  notifyNewBid(bid); // best-effort; never blocks the response
  res.json({ ok: true, bidId: bid.id });
});

function requireAdmin(req, res, next) {
  if (sessionValid(readAdminCookie(req))) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

app.post('/api/admin/login', loginLimiter, (req, res) => {
  const password = (req.body.password || '').toString();
  if (!password || !secretsMatch(password, ADMIN_PASSWORD)) return res.status(401).json({ error: 'Wrong password' });
  res.setHeader('Set-Cookie', `admin=${createSession()}; ${COOKIE_FLAGS}; Max-Age=${60 * 60 * 24 * 30}`);
  res.json({ ok: true });
});

app.post('/api/admin/logout', (req, res) => {
  sessions.delete(readAdminCookie(req));
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
