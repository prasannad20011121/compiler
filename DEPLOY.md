# Deploying browser-ide — all free tiers, total cost $0

Three services, all free, no credit card. Do these in order.

## 1. MongoDB Atlas (database — free M0)

1. Create an account at https://www.mongodb.com/cloud/atlas/register
2. Create a free **M0** cluster (any region close to you).
3. Database Access → add a database user (username + password).
4. Network Access → "Allow access from anywhere" (0.0.0.0/0 — Render's IPs rotate).
5. Copy the connection string: `mongodb+srv://<user>:<password>@<cluster>.mongodb.net/browser-ide`

## 2. Render (API — free web service)

1. Push this repo to GitHub (both `client/` and `server/`).
2. Create an account at https://render.com → New → Web Service → connect the repo.
3. Settings:
   - **Root Directory**: `server`
   - **Build Command**: `npm ci`
   - **Start Command**: `npm start`
   - **Instance Type**: Free
4. Environment variables:
   - `MONGODB_URI` = the Atlas connection string from step 1
   - `JWT_SECRET` = a long random string (e.g. from https://www.uuidgenerator.net/ ×2)
   - `CLIENT_ORIGIN` = your Cloudflare Pages URL (add after step 3, e.g. `https://browser-ide.pages.dev`)
5. Note your service URL, e.g. `https://browser-ide-api.onrender.com`.
   - Free tier sleeps after 15 min idle; the first request takes ~30 s to wake. The IDE
     itself is unaffected — only cloud save/load waits.

## 3. Cloudflare Pages (frontend + all WASM runtimes — free, unlimited static bandwidth)

1. Put your Render URL into `client/src/environments/environment.production.ts` (`apiBase`).
2. Create an account at https://dash.cloudflare.com → Workers & Pages → Create → Pages → connect the repo.
3. Build settings:
   - **Root directory**: `client`
   - **Build command**: `npm ci && npm run runtimes && npm run build`
   - **Build output directory**: `dist/client/browser`
4. Deploy. The `public/_headers` file ships automatically and sets COOP/COEP
   (required for interactive stdin) plus immutable caching for the runtimes.
5. Go back to Render and set `CLIENT_ORIGIN` to your `*.pages.dev` URL.

## Verify the deployment

Open the Pages URL and check:

- DevTools console: `crossOriginIsolated` → must be `true`.
- Network tab: **zero cross-origin requests** on load (everything from your origin),
  and **zero requests of any kind when you press Run**.
- Run one file per language: `.js`, `.ts`, `.py` (with `input()`), `.c`/`.cpp` (with `std::cin`), `.java`.
- Second visit: runtimes come from the service-worker cache — Run works offline.
- Sign in → Save workspace → open it on another machine.

## Free-tier limits that matter

| Service | Limit | Impact |
|---|---|---|
| Cloudflare Pages | 25 MB per file, 500 builds/month | No runtime file comes close (C/C++ is our own compiler, bundled with the app — no vendored toolchain) |
| Render free | Sleeps after 15 min idle | Cloud save waits ~30 s on first use |
| Atlas M0 | 512 MB storage | Thousands of projects |
