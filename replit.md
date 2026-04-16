# Deal Scout — Replit Project

## Artifacts

### Deal Scout Social Media Ad
- **Location**: `artifacts/deal-scout-social-ad/`
- **Type**: Animated video (React + Framer Motion)
- **Preview**: `/deal-scout-social-ad/`
- **Description**: ~25-second punchy social media ad for Instagram/TikTok/YouTube Shorts. Fast-paced 5-scene format.
- **Scenes**: 5 scenes (hook 3.5s, scoring 5s, features 5.5s, demo 7s, close 4s)
- **Features Covered**: Deal scoring, scam detection, price comparison, negotiation help
- **Assets**: Real Chrome Web Store logo, screen recording of Deal Scout in action
- **Fonts**: Outfit (display) + Inter (body)
- **Colors**: Same as brand video — emerald/slate dark theme

### Deal Scout Brand Awareness Video
- **Location**: `artifacts/deal-scout-brand-video/`
- **Type**: Animated video (React + Framer Motion)
- **Preview**: `/deal-scout-brand-video/`
- **Description**: ~56-second brand awareness video introducing Deal Scout. Tells a problem/solution narrative across 7 scenes.
- **Scenes**: 7 scenes (hook 8s, problem 8s, solution 7s, scoring/scam-detection 9s, reputation/negotiation 9s, demo 8s, close 7s)
- **Features Covered**: AI deal scoring, 3-layer scam detection, product reputation checks, negotiation help, eBay price comparisons
- **Fonts**: Outfit (display) + Inter (body) from Google Fonts
- **Colors**: Emerald green (#10B981) primary, blue (#3B82F6) accent, slate dark theme

# Deal Scout API — Replit Backend

## Overview

FastAPI backend for the Deal Scout Chrome extension. Scores deals on Facebook Marketplace, Craigslist, and Amazon using Claude AI + eBay pricing data. Migrated from Railway. Zero external AI API keys needed — uses Replit's built-in Claude AI proxy.

## Stack

- **Language**: Python 3.11
- **Framework**: FastAPI + Uvicorn
- **AI**: Claude Haiku (via Replit AI integration — no API key needed)
- **Pricing**: eBay Browse API (primary, sold+active) → Google Shopping → Claude AI + DuckDuckGo grounding → eBay Finding API (last resort only)
- **Deps**: brotli (Google Shopping decompression)
- **Monorepo tool**: pnpm workspaces (Node.js side)

## Architecture

```
artifacts/deal-scout-api/
├── main.py                   # FastAPI app, routes, request/response models
├── requirements.txt          # Python deps (asyncpg added for DB pipeline)
└── scoring/                  # Pipeline modules
    ├── deal_scorer.py         # Claude scoring (main AI call)
    ├── product_extractor.py   # Claude extracts brand/model from vague title
    ├── ebay_pricer.py         # Market value orchestrator — multi-source pipeline
    ├── ebay_browse.py         # eBay Browse API (OAuth2, real sold prices — PRIMARY source)
    ├── claude_pricer.py       # Claude AI price estimation + PostgreSQL price cache (48hr TTL)
    ├── craigslist_pricer.py   # Craigslist asking prices via RSS (no API key)
    ├── product_evaluator.py   # Reddit + Google reliability signals
    ├── security_scorer.py     # Claude scam/fraud detection
    ├── affiliate_router.py    # Buy suggestion cards (config-driven, 20+ programs)
    ├── data_pipeline.py       # Market signal data collection → DB
    ├── vehicle_pricer.py      # Car pricing via CarGurus
    ├── suggestion_engine.py   # Deal card generation
    ├── corrections.py         # Manual query corrections
    ├── web_pricer.py          # DuckDuckGo Lite web search (4 queries, real-time price grounding)
    ├── google_pricer.py       # Google Shopping price scraper (4 extraction strategies)
    └── audit.py               # Score audit: anomaly detection, telemetry aggregation, LLM quality review, rescore diff
```

## API Endpoints

- `POST /score` — main endpoint, scores a deal listing; fires market signal write as background task
- `GET /health` — health check with key status
- `GET /test-claude` — tests Claude pricing integration end-to-end
- `GET /test-claude-connection` — tests Claude API connection
- `GET /test-ebay` — tests eBay API connection
- `GET /v1/market-data` — anonymized aggregate market signals (B2B data product)
- `POST /event` — records affiliate click events to PostgreSQL `affiliate_events` table
- `POST /feedback` — saves query corrections to PostgreSQL `query_corrections` table
- `GET /admin` — admin dashboard (reads affiliate clicks + corrections from DB)
- `GET /admin/daily-summary` — manual trigger for daily Discord digest
- `GET /admin/dashboard` — data pipeline summary stats
- `GET /score-log` — comprehensive scoring history (last 500 scorecards); each entry has listing info, deal score, security check, affiliate cards, price comparison, product evaluation, product info — for post-browse audit of every feature
- `DELETE /score-log` — clears scoring history
- `GET /admin/audit` — score audit dashboard (SPA with telemetry cards, anomaly detection, LLM review, rescore comparison)
- `GET /admin/audit/telemetry` — aggregated scoring telemetry (deal scores, data sources, confidence, platforms, timing, versions)
- `GET /admin/audit/review` — anomaly detection review packet (flagged scorecards with rule-based checks)
- `POST /admin/audit/check` — LLM-powered score quality review (Claude analyzes scorecards for accuracy issues)
- `POST /admin/audit/rescore` — re-scores a logged listing and returns old vs new diff
- `GET /docs` — FastAPI auto-generated API docs

## Revenue Streams

### 1. Affiliate Commissions
- **Amazon Associates** (`dealscout03f-20`): Live, ~4% avg
- **eBay Partner Network** (campaign `5339144027`): Live, ~4%
- **Automotive** (search-only until tags added): Autotrader ($50-150/lead CPA), CarGurus, CarMax, Advance Auto (4%), CarParts.com (8%)
- **20+ other programs** configured in `affiliate_router.py` (search-only; activate by adding env var tag)
- Cards redesigned: full-width CTA buttons, brand colors, score-aware headers, trust signals

### 2. Analytics & Persistence (PostgreSQL)
- `affiliate_events` table: records every affiliate click (program, category, price bucket, deal score, position, selection reason, commission status)
- `query_corrections` table: stores user-submitted query corrections for improving eBay search queries
- Daily Discord digest: background scheduler fires at 9:00 AM PST daily, summarizes last 24h of scores, affiliate clicks, corrections, and user metrics (active/new/dropped/total). Manual trigger at `GET /admin/daily-summary`. Requires `DISCORD_WEBHOOK_URL` env var.
- `corrections.py` is fully async with lazy table creation via `_ensure_table()`

### 3. Market Intelligence Data
- Every `/score` call writes an anonymized signal to `market_signals` PostgreSQL table
- Signals include: category, item label, condition, city, pricing from all sources, deal score, affiliate programs shown
- No PII collected — no user IDs, no listing URLs, no seller data
- Sellable via AWS Data Exchange, Snowflake Marketplace, or direct `/v1/market-data` API
- Protect with `MARKET_DATA_API_KEY` env var before sharing with buyers

## Environment Variables / Secrets

| Variable | Status | Notes |
|---|---|---|
| `AI_INTEGRATIONS_ANTHROPIC_BASE_URL` | ✅ Set by Replit | Claude AI proxy URL |
| `AI_INTEGRATIONS_ANTHROPIC_API_KEY` | ✅ Set by Replit | Claude AI proxy key |
| `EBAY_APP_ID` | ⚠️ Required | eBay Developer App ID (Client ID) |
| `EBAY_CERT_ID` | ⚠️ Required | eBay Developer Cert ID (Client Secret) — for Browse API |

Get your free eBay keys at: https://developer.ebay.com/my/keys

## Running Locally

**Both workflows must be running for the extension to work:**

1. `Deal Scout API` — Python FastAPI on port 8000
   ```
   cd artifacts/deal-scout-api && uvicorn main:app --host 0.0.0.0 --port 8000
   ```
2. `artifacts/api-server: API Server` — TypeScript/Express proxy on port 8080
   ```
   pnpm --filter @workspace/api-server run dev
   ```

The api-server proxies `/api/ds` → `http://localhost:8000` (stripping the prefix) via `http-proxy-middleware` in `artifacts/api-server/src/app.ts`. The extension's external URL routes through the api-server, not directly to the Python app. **If the api-server is stopped, the extension gets 502 errors.**

## Extension Version

Current: **v0.41.0** (extension) / **v0.41.0** (API)

### v0.33.0 API Scoring Fixes
- Security ≤3 unconditionally forces `should_buy=False` (not just score cap)
- $0 price guard returns structured response early (no pipeline crash)
- Price/score ratio post-adjustment: >1.5x overpriced → cap 5, <0.4x underpriced + safe → floor 7
- eBay relevance threshold lowered 0.35→0.28 for better match rates
- Claude pricer handles misspellings (Jakery→Jackery) and unreleased products
- eBay refinement + product eval run in parallel (saves ~1-2s)
- All fixes applied to both standard and streaming endpoints

Key mechanisms in `extension/content/fbm.js`:
- **MutationObserver settling**: Waits for DOM mutations to stop for 1s (max 8s) before extracting content. Observes document.body to catch overlay changes.
- **Content-title consistency check**: After extraction, verifies H1 title words appear in raw_text. Rejects stale body content (up to 8 retries).
- **Fingerprint guard**: First 300 chars of normalized raw_text; catches same-content-different-listing.
- **Terminal stale abort**: If all retries exhaust with stale fingerprint or title mismatch, aborts with RESCORE prompt instead of scoring stale content.

### FBM SPA Simulator Test Page
Available at `/api/ds/fbm-test` — simulates Facebook Marketplace SPA navigation with configurable body-content update delay.

## FBM Overlay/Dialog Extraction (v0.29.7)

Facebook Marketplace renders listing detail pages as overlays/dialogs on top of previous listings during SPA navigation. The `_getListingContainer()` helper detects these overlays (checking `[role="dialog"]`, `[aria-modal="true"]`, close-button overlays) and directs all extraction functions (`extractRaw()`, `_getCurrentH1Title()`, `_getMainImageUrl()`) to read from the foreground listing instead of the background `[role="main"]`. Diag fields `containerSource` and `dialogDetected` track which DOM element was used for extraction.

## Extension Content Scripts

All four content scripts use `chrome.runtime.sendMessage({type: 'SCORE_LISTING', listing})` to route through `background.js`, which calls the FastAPI `/score` endpoint. Each includes the `platform` field on the listing object so the data pipeline labels signals correctly.

| File | Platform | URL Pattern | Detection Method |
|---|---|---|---|
| `extension/fbm.js` | `facebook_marketplace` | `facebook.com/marketplace/item/*` | URL regex |
| `extension/craigslist.js` | `craigslist` | `*.craigslist.org/*/d/*.html` | URL regex + DOM (`#postingbody`) |
| `extension/ebay.js` | `ebay` | `www.ebay.com/itm/*` | URL regex |
| `extension/offerup.js` | `offerup` | `offerup.com/item/detail/*` | URL regex + 500ms retry (React SPA) |

**Manifest entries needed** (add to `manifest.json` `content_scripts`):
```json
{ "matches": ["https://*.craigslist.org/*/d/*.html"], "js": ["craigslist.js"], "run_at": "document_idle" },
{ "matches": ["https://www.ebay.com/itm/*"], "js": ["ebay.js"], "run_at": "document_idle" },
{ "matches": ["https://offerup.com/item/detail/*"], "js": ["offerup.js"], "run_at": "document_idle" }
```

**After deploying to Replit**, update `API_BASE` at the top of each content script to your production URL.

## Migration Changes (from Railway)

1. **Anthropic client**: `api_key=ANTHROPIC_API_KEY` → `api_key=AI_INTEGRATIONS_ANTHROPIC_API_KEY, base_url=AI_INTEGRATIONS_ANTHROPIC_BASE_URL`
2. **Model names**: `claude-haiku-4-5-20251001` → `claude-haiku-4-5`
3. **Gemini pricer replaced**: `scoring/gemini_pricer.py` → `scoring/claude_pricer.py` (Claude-based)
4. **Product evaluator**: Gemini reputation calls → Claude reputation calls
5. **Port**: `API_PORT` env var → `PORT` env var (Replit standard)
6. **No external AI keys needed**: All AI calls go through Replit's built-in Claude proxy

## Workflow Preferences

- **Always push to GitHub after any code change** — do not wait to be asked.
  - Extension changes (content scripts, background.js, manifest, zip) → push to **public** repo `805lager/deal-scout`
  - Backend changes (main.py, scoring/*.py, requirements.txt) → push to **private** repo `805lager/deal-scout-api`
  - When both change in the same session, push both repos in the same step.
  - Rebuild `deal_scout_extension.zip` at the project root whenever any file under `extension/` changes. **Exclude .zip files** when building (never nest a zip inside the zip). Only keep one zip: `deal_scout_extension.zip`. Delete any old versioned zips (e.g. `deal-scout-v0.28.0.zip`).
  - **Always create a Git tag** (`git tag -a vX.Y.Z -m "..."`) for every version bump and push it to both remotes (`git push origin vX.Y.Z && git push api vX.Y.Z`). This ensures releases appear on GitHub.
  - **Sync ALL version numbers** on every version bump. Update all of these together:
    1. `extension/manifest.json` → `"version": "X.Y.Z"`
    2. `artifacts/deal-scout-api/main.py` → `BACKEND_VERSION = "X.Y.Z"`
    3. `replit.md` → Extension Version section
    4. Rebuild `deal_scout_extension.zip`
  - **Extension zip contents** (only these files belong in the zip):
    - `manifest.json`
    - `background.js`
    - `content/fbm.js`, `content/craigslist.js`, `content/ebay.js`, `content/offerup.js`
    - `popup/popup.html`, `popup/popup.js`
    - `lib/purify.min.js`
    - `icons/icon16.png`, `icons/icon48.png`, `icons/icon128.png`

## TypeScript API Server (pre-existing)

The workspace also has a TypeScript/Express API server at `artifacts/api-server/` (separate from Deal Scout, runs on port 8080 at path `/api`). This was pre-existing and is unrelated to the Deal Scout backend.
