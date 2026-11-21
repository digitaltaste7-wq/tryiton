# TryOn — instructions for the coding agent

Read this whole file before changing anything.

## What this is
TryOn: AI virtual try-on for online stores (jewellery, pet, clothing). A store owner signs up,
pastes their website, gets a preview "lookbook" of their own products worn by a model / their pet,
then adds one line of code (`/w.js`) to go live.

Owner: Vidit (not a coder). Explain results in plain words, 2–3 sentences. Do the work yourself;
never ask him to edit code by hand.

## How it runs
- Node 22.13+, Express, ES modules, SQLite built into Node (`node:sqlite`). Only dependency: express.
- Hosted on **Railway**, auto-deploys from GitHub repo **digitaltaste7-wq/tryiton**, branch **main**.
  Pushing to main = going live (takes ~2 min).
- Live URL: https://tryiton-production-8c4d.up.railway.app — `/health` shows the version string.
- Files sit flat in the repo root (no src/ folder). Keep it that way — the Dockerfile copies the root.

## Files
- `server.js` – routes: sign-up/login, dashboard (`/app`), store setup, preview page `/preview/:key`,
  widget API, `/health` (bump the version string on every change; current: `v15-real-angles`).
- `ai.js` – all image AI. Calls Google Gemini image models. Per-product "brief": a text model looks at
  the product photo and writes product-specific prompt parts (cached), falls back to `buildPrompt`.
  Optional quality check. Retries with backoff; on 429 rotates Vertex regions.
- `jobs.js` – job queue that runs try-ons in parallel (`MAX_PARALLEL`, `PER_JOB`), auto-retries
  "busy/429" items twice after 40s.
- `catalog.js` – reads products from Shopify / WooCommerce / any site's product data.
- `net.js` – safe fetch (public addresses only, size + redirect limits). Always use it for outside URLs.
- `db.js` SQLite storage · `auth.js` sessions/admins · `views.js` HTML pages · `app.js`/`app.css`
  dashboard front-end · `widget.js` shopper widget (served as `/w.js`) · `preview.css`.
- `bridge/` – NOT part of the Railway app. Google Cloud Run function **tryon-bridge** (entry point
  `vertex`, Node 22, project project-ae2caa0b-ef34-41e0-a07, region us-central1). It turns a request
  `{model, body, location}` + header `x-proxy-key` into a Vertex AI `generateContent` call using the
  Cloud Run service account (no keys). Deploy with:
  `gcloud run deploy tryon-bridge --source bridge --function vertex --region us-central1 --project project-ae2caa0b-ef34-41e0-a07`
  (or paste index.js in Cloud Run → Source → Save and redeploy).

## Why the bridge exists
Google AI Studio API key credits ran out. Vertex AI uses the Google Cloud free-trial credits, but the
org policy blocks service-account keys and JSON keys, so the app calls Vertex through the bridge.

## Railway variables (values live in Railway — never write secrets into code, chat or git)
- `VERTEX_PROXY_URL` = bridge URL · `VERTEX_PROXY_KEY` = shared secret (also set as `PROXY_KEY` on Cloud Run)
- `GEMINI_MODELS`, `GEMINI_PREMIUM_MODELS` (now `gemini-2.5-flash-image`), `GEMINI_QC_MODEL`
- `JEWELLERY_MODELS`, `CLOTHING_MODELS` (best model first) · `JEWELLERY_ANGLES` (extra jewellery angles, default 2, 0 = off)
- `TRYON_QC` (0 = off), `TRYON_BRIEF`, `PER_JOB`, `MAX_PARALLEL`, `VERTEX_REGIONS`
- `APP_URL`, `ADMIN_EMAILS`, `DATA_DIR=/data`, `TRIAL_IMAGES`
- `GEMINI_API_KEY` (old AI Studio route, unused while the bridge is set) · `TRYON_MOCK=1` = test mode, no AI

## Rules
1. Before pushing: `node --check` every changed .js file and run `npm start` locally with
   `TRYON_MOCK=1` to confirm it boots and `/health` answers.
2. Commit with a clear message and push to `main`. Then check `/health` on the live URL shows the new version.
3. Never commit `.env`, keys, service-account JSON, or the proxy key.
4. Don't add heavy dependencies or a build step. Keep the flat layout.
5. Known issue to watch: Vertex "429 Resource exhausted" on the new trial account (low shared quota).
   Fix ideas in order: region rotation (done), fewer parallel jobs, ask Google for more quota.

## Current state (v15)
- Realism rules for every photo (`REAL_PHOTO`, `PET_PHOTO`, `JEWEL_PHOTO` in ai.js).
- Clothing must keep the exact garment design (`GARMENT_EXACT` + the brief's `design` field). Quality
  check flags changed prints/necklines/details; up to 2 regenerations (`REGEN`).
- Jewellery: main look first, then `jewelleryAngles()` makes extra angle shots (`ANGLE_VIEWS`) per type.
  jobs.js stores them in `item.angles`; server sends them in the job poll (`ha=` param); widget.js shows
  thumbnails in the detail view.
- The live repo may still be on v12/v13 — the v14/v15 files in this folder are the newest. The first push
  from this folder brings the live app up to v15.

## How Vidit works with you
He pastes prompts written for him. Do the whole change, test it (rule 1), push, check `/health`, then
tell him in 2–3 plain sentences what changed and what to test.
