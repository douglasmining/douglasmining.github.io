# Newsletter Worker

An encrypted subscriber list for douglasmining.com, built the same way as the
douglas.lol secure drop.

## How it works

1. **Signup** — `newsletter.html` loads OpenPGP.js from the site itself and
   encrypts `{ email, at }` in the visitor's browser to the Douglas Mining
   public key (`src/public-key.asc`). Only the armored ciphertext is POSTed to
   `/subscribe`.
2. **Worker** — checks the message is really encrypted to that key, applies
   daily rate limits (per hashed IP and overall), stores the ciphertext in the
   `douglasmining-newsletter` D1 database, and sends a notification email that
   contains only a reference code. The Worker never sees an address.
3. **Admin** — `/admin/` on the Worker's own URL. Paste or open the private
   key; the page signs a one-time challenge to prove it holds the key, then
   fetches the list and decrypts every entry locally. From there you can copy
   the active addresses, download a CSV, unsubscribe, reactivate or delete.
   The private key never leaves the tab.
4. **Unsubscribe** — each signup gets a reference code like `K7Q2-M9XA`. A
   subscriber can enter it on the newsletter page to unsubscribe without the
   server ever learning their address.

## Reaching the admin page

`https://douglasmining.com/admin` is served directly by this Worker. The
domain's web DNS records (the four apex A records and `www`) are proxied
through Cloudflare, and `wrangler.toml` declares the route
`douglasmining.com/admin*`, so only that path reaches the Worker; everything
else on douglasmining.com still comes from GitHub Pages. The Worker's admin
page is self-contained under `/admin/` (OpenPGP.js at `/admin/openpgp.min.js`).

Cloudflare SSL/TLS mode is Automatic and running **Full**, which GitHub Pages
needs behind the proxy. If the site ever redirect-loops, check that setting
first. Turning the proxy off on those five DNS records restores direct
GitHub Pages serving (and breaks the `/admin` route).

## Endpoints

| Method | Path                       | Purpose                                   |
| ------ | -------------------------- | ----------------------------------------- |
| GET    | `/key`                     | Armored public key the page encrypts to   |
| POST   | `/subscribe`               | `{ m: "<armored PGP message>" }`          |
| POST   | `/unsubscribe`             | `{ ref: "K7Q2-M9XA" }`                    |
| GET    | `/admin/`                  | Admin page (static)                       |
| GET    | `/admin/challenge`         | One-time login challenge                  |
| POST   | `/admin/login`             | `{ challenge, mac, signature }` → token   |
| GET    | `/admin/subscribers`       | List (Bearer token)                       |
| POST   | `/admin/subscribers/:id`   | `{ status: "active" \| "unsubscribed" }`  |
| DELETE | `/admin/subscribers/:id`   | Remove a row                              |

## Deploy

Needs Node 22+ (`/usr/local/opt/node@22/bin` on this Mac) and a Cloudflare
login (`npx wrangler login`).

```bash
cd worker
npm install
npx wrangler deploy
```

One-time setup after the first deploy:

```bash
# Random secret used for challenge/session HMACs and IP hashing.
openssl rand -base64 32 | npx wrangler secret put SESSION_SECRET
```

The D1 schema is in `schema.sql`. It was applied once when the database was
created; re-run it with `npx wrangler d1 execute douglasmining-newsletter
--remote --file schema.sql` if you ever recreate the database.

## Configuration (`wrangler.toml`)

- `ALLOWED_ORIGINS` — origins allowed to call `/subscribe` from the browser.
- `NOTIFY_FROM` — sender for notification emails. Must be on a domain with
  Cloudflare Email Routing enabled (douglas.lol is; douglasmining.com's mail
  stays on Google Workspace and is untouched).
- `NOTIFY_TO` — must be a verified destination address in Cloudflare Email
  Routing. Sends to verified destinations are free.

## Rotating the key

Replace `src/public-key.asc`, redeploy, and keep the old private key around to
read entries encrypted before the switch.
