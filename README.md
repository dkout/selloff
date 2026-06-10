# Moving Sale

Interactive storefront for the Cambridge moving sale. Buyers browse items, add to cart (lot deals auto-apply), and submit a purchase request. The seller reviews and approves; approved items are marked sold and disappear from the storefront for other buyers.

## Run locally

```bash
cd site
npm install
ADMIN_PASSWORD=yourpassword npm start
```

Open:
- Storefront: http://localhost:3000
- Seller dashboard: http://localhost:3000/admin.html

If `ADMIN_PASSWORD` isn't set, it defaults to `changeme`.

## How lot deals work

- Each category (slide) has a lot price. If the cart contains **every item** in a category and the lot price is lower than the individual sum, the cart total is replaced with the lot price (savings shown).
- If the cart contains **every non-bike item across the whole sale**, the full-lot deal (price set in `items.json`) applies instead. Bike categories still get their own lot pricing on top, so one combined cart never costs more than splitting the same items across requests.

All pricing lives in `lib/pricing.js` and runs server-side (`POST /api/price` for cart totals; `GET /api/items` ships the computed lot offers the storefront displays), so the page never shows a price the server won't charge. Run `npm test` to exercise the pricing rules.

## Approval flow

1. Buyer submits a purchase request → bid is `pending`.
2. Items stay visible to others; a pending request does not lock items.
3. Seller approves → items become `sold` and are crossed off / filtered out on the storefront.
4. Other pending bids that include any now-sold item are auto-declined and noted in history.
5. Seller can mark a sold item available again from the "Sold items" tab.

## Storage

Two separate concerns:

- **Catalog** (`site/data/items.json`) ships with the app and is read-only at runtime. Edit prices/items here, commit, redeploy.
- **Runtime state** (`state.json` — bids + sold items) is written to `DATA_DIR` (default `site/data/`, atomic writes). In production, point `DATA_DIR` at a **persistent disk** — mounting it there never hides the catalog, because the catalog always loads from the app directory.

## Deploy

This is a plain Node/Express app — no build step. It needs a long-lived Node process, a small persistent disk for `state.json`, an env var, and HTTPS. Run it as a **single instance** (state is in-process).

### Render (one-click via the included `render.yaml`)

1. Push this folder to a GitHub repo.
2. Render dashboard → **New → Blueprint** → connect the repo. It reads `render.yaml` and provisions a web service + a 1 GB disk mounted at `/var/data` with `DATA_DIR=/var/data`.
3. When prompted, set **`ADMIN_PASSWORD`** (it's intentionally not in the file).
4. Deploy → you get an `https://…onrender.com` URL with automatic TLS.

(A persistent disk requires the **Starter** plan, ~$7/mo. The free plan has no disk and would reset bids on sleep.)

### Railway / Fly.io

Same shape: Node service, start `npm start`, attach a ~1 GB volume, set `DATA_DIR` to the mount path, `NODE_ENV=production`, and `ADMIN_PASSWORD`.

### Free / temporary (tunnel from your machine)

```bash
ADMIN_PASSWORD=yourpass npm start
npx cloudflared tunnel --url http://localhost:3000   # public HTTPS URL, live while your machine is on
```

### Vercel / Netlify

Not suitable as-is — serverless filesystems are read-only, so `state.json` won't persist. You'd need to swap `loadState`/`saveState` in `server.js` for a hosted store (`@vercel/kv`, Upstash, Postgres, etc.).

## Configuration

Environment variables:

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `ADMIN_PASSWORD` | `changeme` | Seller login password (compared in constant time). A successful login sets a random session-token cookie — the password itself is never stored in the browser. Sessions are in-memory, so a server restart/redeploy just means signing in again; orders are unaffected. |
| `DATA_DIR` | `./data` | Where mutable `state.json` is written (point at a persistent disk in prod). The catalog `items.json` always loads from the app directory regardless. |
| `NODE_ENV` | — | Set to `production` to add the `Secure` flag to the admin cookie (requires HTTPS). **In production the app refuses to start unless `ADMIN_PASSWORD` is set to a non-default value.** |
| `TRUST_PROXY` | `1` | Proxy hops to trust for client IP (rate limiting). `0` for direct/localhost |
| `SMTP_URL` | — | SMTP transport URL for new-request email alerts, e.g. `smtps://user:pass@smtp.example.com:465`. If unset, email notifications are off. |
| `NOTIFY_EMAIL` | — | Where new-request alerts are sent (the seller). Required (with `SMTP_URL`) to enable email. |
| `NOTIFY_FROM` | `NOTIFY_EMAIL` | From address on alert emails. |

### Email notifications

When `SMTP_URL` **and** `NOTIFY_EMAIL` are both set, the seller gets an email every time a buyer submits a request (buyer name, contact, items, total, and any lot deals applied). Sending is best-effort and fire-and-forget: a mail failure is logged but never blocks or fails the buyer's submission. Leave either var unset to keep notifications off.

Works with any SMTP provider — e.g. a Gmail app password (`smtps://you%40gmail.com:app-password@smtp.gmail.com:465`), SendGrid, Mailgun, Resend's SMTP, etc. URL-encode any special characters in the username/password.

## Notes on behavior & limits

- **Lot pricing is dynamic.** A lot's price is `min(set lot price, round(90% of the remaining items' sum))`, so a lot always saves at least 10% and never costs more than the seller's set price. As items sell, the lot price tracks 90% of what's left. A lot is only offered while at least **2** items remain in it (`MIN_LOT_ITEMS` in `lib/pricing.js` — the single source of truth; the frontend only displays server-computed prices). The "take everything (excluding bikes)" deal follows the same rule against all available non-bike items.
  - Note: if a category's set lot price is *higher* than 90% of its items' sum (e.g. Cookware: set $190 vs items summing $180 → shown at $162), the 90% cap wins. Adjust the set price in `items.json` if that's not intended.
- **The bundle countdown is informational.** It hides itself once the deadline passes; it never changes pricing. To actually end the deal, edit `fullLot` in `items.json` and redeploy.
- **Rate limiting** (best-effort, in-memory): 20 login attempts / 15 min and 10 bid submissions / min per IP. Resets on restart.
- **Input caps**: buyer name ≤ 120 chars, contact ≤ 200, note ≤ 500; request body ≤ 100 kB. At most 500 stored bids — beyond that, oldest *decided* bids are pruned first and new submissions are refused (503) rather than dropping anything pending.
- **Images** were downscaled to ~1100px long edge and served with a 7-day cache. Full-resolution originals are backed up at `../images_original_backup/` (outside the deployable `site/` tree).
