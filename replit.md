# Deal Scout API — Replit Backend

## Overview

FastAPI backend for the Deal Scout Chrome extension. Scores deals on Facebook Marketplace, Craigslist, and Amazon using Claude AI + eBay pricing data. Migrated from Railway. Zero external AI API keys needed — uses Replit's built-in Claude AI proxy.

## Stack

- **Language**: Python 3.11
- **Framework**: FastAPI + Uvicorn
- **AI**: Claude Haiku (via Replit AI integration — no API key needed)
- **Pricing**: eBay Finding API + Claude AI fallback
- **Monorepo tool**: pnpm workspaces (Node.js side)

## Architecture

```
artifacts/deal-scout-api/
├── main.py                   # FastAPI app, routes, request/response models
├── requirements.txt          # Python deps (asyncpg added for DB pipeline)
└── scoring/                  # Pipeline modules
    ├── deal_scorer.py         # Claude scoring (main AI call)
    ├── product_extractor.py   # Claude extracts brand/model from vague title
    ├── ebay_pricer.py         # eBay Finding API comps + _safe_craigslist wrapper
    ├── claude_pricer.py       # Claude AI price fallback (replaces Gemini)
    ├── craigslist_pricer.py   # Craigslist asking prices via RSS (no API key)
    ├── product_evaluator.py   # Reddit + Google reliability signals
    ├── security_scorer.py     # Claude scam/fraud detection
    ├── affiliate_router.py    # Buy suggestion cards (config-driven, 20+ programs)
    ├── data_pipeline.py       # Market signal data collection → DB
    ├── vehicle_pricer.py      # Car pricing via CarGurus
    ├── suggestion_engine.py   # Deal card generation
    ├── corrections.py         # Manual query corrections
    └── google_pricer.py       # Google Shopping price scraper
```

## API Endpoints

- `POST /score` — main endpoint, scores a deal listing; fires market signal write as background task
- `GET /health` — health check with key status
- `GET /test-claude` — tests Claude pricing integration end-to-end
- `GET /test-claude-connection` — tests Claude API connection
- `GET /test-ebay` — tests eBay API connection
- `GET /v1/market-data` — anonymized aggregate market signals (B2B data product)
- `GET /admin/dashboard` — data pipeline summary stats
- `GET /docs` — FastAPI auto-generated API docs

## Revenue Streams

### 1. Affiliate Commissions
- **Amazon Associates** (`dealscout03f-20`): Live, ~4% avg
- **eBay Partner Network** (campaign `5339144027`): Live, ~4%
- **Automotive** (search-only until tags added): Autotrader ($50-150/lead CPA), CarGurus, CarMax, Advance Auto (4%), CarParts.com (8%)
- **20+ other programs** configured in `affiliate_router.py` (search-only; activate by adding env var tag)
- Cards redesigned: full-width CTA buttons, brand colors, score-aware headers, trust signals

### 2. Market Intelligence Data
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

Get your free eBay key at: https://developer.ebay.com/my/keys

## Running Locally

The workflow `Deal Scout API` runs:
```
cd artifacts/deal-scout-api && uvicorn main:app --host 0.0.0.0 --port 8000
```

API available at `http://localhost:8000` within Replit.

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
  - Rebuild `deal_scout_extension.zip` whenever any file under `extension/` changes, and push the new zip to the public repo.

## TypeScript API Server (pre-existing)

The workspace also has a TypeScript/Express API server at `artifacts/api-server/` (separate from Deal Scout, runs on port 8080 at path `/api`). This was pre-existing and is unrelated to the Deal Scout backend.
