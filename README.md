# Telegram Mini-Shop — Digital Goods Store

A complete e-commerce mini-shop that runs **inside Telegram** as a Mini App, with
**ABA PayWay KHQR** payments and instant digital delivery (license keys, download
links, subscription instructions).

- **Storefront** (`/`) — mobile-first Telegram Mini App: catalog, search,
  categories, cart, KHQR checkout with live payment polling, order history with
  digital delivery reveal.
- **Admin panel** (`/admin`) — products, license-key pools, orders, CSV import,
  settings. Protected by `ADMIN_TOKEN`.
- **Backend** — Node.js + Express + SQLite. PayWay QR API integration
  (`generate-qr`, `check-transaction-2`, webhook), Telegram WebApp `initData`
  validation, mock payment mode for testing.

## Quick start (local)

```bash
cd telegram-minishop
npm install
cp .env.example .env        # then edit .env (see Configuration)
npm run seed                # loads 55 sample products + 145 sample keys
npm start                   # → http://localhost:3000
```

- Shop: http://localhost:3000
- Admin: http://localhost:3000/admin (sign in with your `ADMIN_TOKEN`)

Out of the box it runs in **mock payment mode** (`PAYWAY_MOCK=true`): checkout
shows a test QR and auto-approves after ~20 seconds, so you can try the entire
buy flow with no real money or credentials.

## Configuration (`.env`)

| Variable | What it is |
|---|---|
| `PORT` | HTTP port (default `3000`) |
| `ADMIN_TOKEN` | Password for `/admin`. **Change this.** |
| `TELEGRAM_BOT_TOKEN` | From BotFather. Enables Telegram login validation. Optional — the shop works in guest mode without it. |
| `PAYWAY_MERCHANT_ID` / `PAYWAY_API_KEY` | Issued by ABA PayWay (sandbox first, then production). |
| `PAYWAY_BASE_URL` | Sandbox: `https://checkout-sandbox.payway.com.kh/api/payment-gateway/v1/payments` · Production: `https://checkout.payway.com.kh/api/payment-gateway/v1/payments` |
| `PAYWAY_CURRENCY` | `USD` or `KHR` (default currency offered at checkout; buyer can switch) |
| `PAYWAY_LIFETIME_MIN` | QR validity in minutes (min 3, default 15) |
| `PAYWAY_QR_TEMPLATE` | ABA QR image template, e.g. `template3_color` |
| `PAYWAY_MOCK` | `true` = simulate payments (no credentials needed). Set `false` for real PayWay. |
| `EXCHANGE_RATE_USD_KHR` | Used for USD↔KHR display/conversion (default `4100`) |
| `PUBLIC_URL` | Your public base URL, e.g. `https://shop.example.com`. PayWay sends payment webhooks here — **must be publicly reachable in production** (not localhost). |

## Going live with PayWay

1. **Sandbox first:** register at the PayWay merchant portal
   (`https://sandbox.payway.com.kh/register-sandbox/`) to get a sandbox
   `merchant_id` + `api_key`. Put them in `.env`, set
   `PAYWAY_BASE_URL` to the sandbox URL, `PAYWAY_MOCK=false`, restart.
   Test with small KHR amounts (e.g. 1000 KHR) using the ABA sandbox tools.
2. **Production:** contact ABA's merchant team (`paywaysales@ababank.com`) for
   production credentials. Swap the base URL to
   `https://checkout.payway.com.kh`, keep `PAYWAY_MOCK=false`.
3. **Webhook:** in the PayWay merchant portal, register your callback URL:
   `https://YOUR-DOMAIN/api/webhooks/payway`. The app also polls PayWay
   directly, so payments confirm even if the webhook is delayed — but the
   webhook makes confirmation instant.
4. **Whitelisting:** ABA may need your production domain whitelisted — confirm
   with their integration team.

How it works: checkout calls PayWay `generate-qr` (HMAC-SHA512 signed) and shows
the KHQR. The app polls `check-transaction-2` every 5 seconds; on `APPROVED` the
order is fulfilled instantly. The webhook is a second, faster confirmation path.

## Connecting your Telegram bot

You said you'll create the bot yourself — when you're ready:

1. Talk to [@BotFather](https://t.me/BotFather) → `/newbot` → save the token →
   put it in `.env` as `TELEGRAM_BOT_TOKEN` (enables verified Telegram login).
2. Deploy this app to a public HTTPS URL (see below).
3. In BotFather: `/mybots` → your bot → **Bot Settings → Menu Button** (or
   **Configure Mini App**) → set the Web App URL to `https://YOUR-DOMAIN/`.
4. Users tap the menu button (or your `/start` button) and the shop opens inside
   Telegram with their identity attached to orders.

## Deployment

Any Node.js host works (VPS, Railway, Render, Fly.io…):

1. Copy the project, run `npm install --production`.
2. Set the `.env` values (production PayWay creds, `PUBLIC_URL`, strong
   `ADMIN_TOKEN`, `PAYWAY_MOCK=false`).
3. Run `npm run seed` once (sample catalog — replace with your real products),
   then `npm start`. Use a process manager (`pm2`, systemd) in production.
4. Put it behind HTTPS (Caddy/Nginx/Cloudflare). PayWay webhooks require HTTPS.

The database is a single SQLite file at `data/shop.db` — back it up regularly.

## Running the shop (admin guide)

- **Products** (`/admin` → Products): add/edit/deactivate. Delivery types:
  - `key` — license keys are drawn from the **Key pools** tab on each sale.
  - `download` — `delivery_payload` = `{"url":"https://…"}` (or a plain URL).
  - `subscription` / `text` — `delivery_payload` = fulfillment instructions shown to the buyer.
- **Key pools**: paste one key per line per product. Keys are assigned
  first-in-first-out and never reused.
- **Orders**: see pending/paid, manually mark paid (e.g. for bank transfers) or
  cancel. Click a row for full details.
- **Import**: bulk-add products via CSV
  (`name,price_usd,category,description,delivery_type,delivery_payload,image_url`).
- **Dashboard**: revenue and order counts at a glance.

The 55 seeded products are **samples** (marked in their descriptions) — replace
them with your real catalog before launching.

## Project structure

```
telegram-minishop/
├── backend/
│   ├── server.js        # Express app, static hosting, .env loading
│   ├── db.js            # SQLite schema + all data helpers
│   ├── payway.js        # PayWay QR API client (signing, QR, status, webhook verify)
│   ├── telegram.js      # WebApp initData validation
│   └── routes/          # public.js, orders.js, checkout, webhook.js, admin.js
├── public/              # Telegram Mini App (index.html, app.js, styles.css)
├── admin/               # Admin panel (index.html, admin.js, admin.css)
├── scripts/seed.js      # Sample catalog seeder (`npm run seed`, `--force` to reseed)
└── data/shop.db         # SQLite database (created on first run)
```

## Security notes

- `delivery_payload` (download URLs, instructions) is **never** exposed on
  public product endpoints — only revealed after payment.
- Admin routes require `x-admin-token`; Telegram `initData` is HMAC-verified.
- PayWay webhook signatures are verified (HMAC-SHA512).
- Change `ADMIN_TOKEN`, keep `.env` out of version control, and serve over HTTPS.
