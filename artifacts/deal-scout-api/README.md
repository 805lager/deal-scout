# Deal Scout — AI-Powered Deal Scoring Chrome Extension

Score deals instantly on Facebook Marketplace, Craigslist, eBay, and OfferUp. Powered by Claude AI with real-time eBay sold comps, a 3-layer scam detection engine, and smart affiliate recommendations.

**Extension version:** v0.32.0 &nbsp;|&nbsp; **API version:** v0.33.1 &nbsp;|&nbsp; **Chrome Web Store:** *Pending review*

---

## How It Works

Browse any supported listing → the extension sidebar appears automatically with:

- **Deal Score** (1–10) — AI-powered assessment combining price analysis, market comps, and product reputation
- **Market Comparison** — Real eBay sold prices, active listings, and new retail pricing
- **Security Check** — 3-layer scam/fraud detection running in parallel
- **Smart Recommendations** — Category-matched affiliate cards for buying new or comparing alternatives
- **Negotiation Message** — Ready-to-copy buyer message with context-aware pricing

---

## Platform Support

| Platform | Status | Detection | Features |
|----------|--------|-----------|----------|
| Facebook Marketplace | ✅ Live | URL + SPA navigation observer | Full extraction — price, images, seller trust, shipping, strikethrough price, condition, overlay/dialog support |
| Craigslist | ✅ Live | URL regex + DOM (`#postingbody`) | Price, description, location, condition extraction |
| eBay | ✅ Live | URL regex (`/itm/*`) | Active listing scoring — price, condition, seller feedback, item specifics |
| OfferUp | ✅ Live | URL regex + React SPA retry | Price, description, images, seller extraction with 500ms retry for hydration |

---

## Project Structure

```
deal-scout/
├── extension/                        # Chrome Extension (Manifest V3)
│   ├── manifest.json                 # v0.32.0 — permissions, content script routing
│   ├── background.js                 # Service worker — API routing, badge updates, caching
│   ├── content/
│   │   ├── fbm.js                    # Facebook Marketplace — MutationObserver, overlay detection
│   │   ├── craigslist.js             # Craigslist — DOM extraction
│   │   ├── ebay.js                   # eBay — item page extraction
│   │   └── offerup.js                # OfferUp — React SPA with retry
│   ├── popup/
│   │   ├── popup.html                # Extension popup UI
│   │   └── popup.js                  # Health check, rescore trigger
│   ├── icons/                        # 16px, 48px, 128px extension icons
│   └── deal_scout_extension.zip      # Ready-to-upload Chrome Web Store package
│
├── artifacts/deal-scout-api/         # FastAPI Backend (Python 3.11)
│   ├── main.py                       # Endpoints, scoring pipeline orchestration
│   └── scoring/
│       ├── product_extractor.py      # Claude Haiku — brand/model/category extraction
│       ├── ebay_pricer.py            # eBay Finding API — sold comps + circuit breaker
│       ├── claude_pricer.py          # Claude AI — market value estimation (fallback)
│       ├── deal_scorer.py            # Claude — final 1–10 score + vision analysis
│       ├── security_scorer.py        # 3-layer scam detection (regex + Claude + item-specific)
│       ├── affiliate_router.py       # 21-program affiliate card engine (567+ keywords)
│       ├── product_evaluator.py      # Brand/model reputation via Claude + Google
│       ├── data_pipeline.py          # Market signals → PostgreSQL (anonymized)
│       ├── corrections.py            # Async PostgreSQL-backed query corrections
│       ├── listing_extractor.py      # Claude Haiku — structured extraction from raw text
│       ├── vehicle_pricer.py         # CarGurus vehicle pricing
│       ├── craigslist_pricer.py      # Craigslist asking price scraper
│       ├── google_pricer.py          # Google Shopping price scraper
│       └── suggestion_engine.py      # Deal improvement suggestions
│
└── artifacts/api-server/             # Node.js proxy (Express/TypeScript)
    └── src/app.ts                    # Routes /api/ds → FastAPI on port 8000
```

---

## Scoring Pipeline

Every listing runs through this pipeline (stages run in parallel where possible):

```
Listing text + image(s)
    │
    ├─ Product Extractor      (Claude Haiku: brand, model, category, search query)
    ├─ eBay Pricer             (Finding API: sold comps, active listings, new retail)
    └─ Product Evaluator       (Google + Claude: reputation, reliability tier)
    │
    ├─ [Parallel refinement]   eBay refined query + product eval run concurrently
    │
    ├─ Deal Scorer             (Claude: 1–10 score, vision analysis, red/green flags)
    └─ Security Scorer         (3-layer scam detection — runs in parallel with deal scoring)
    │
    ├─ Post-processing         (security cap, price/market ratio adjustment, $0 guard)
    ├─ Affiliate Router        (3 category-matched cards from 21 programs)
    └─ Data Pipeline           (anonymized signal → PostgreSQL — async, non-blocking)
```

**Typical response time:** 8–12 seconds (Claude vision + eBay API + scoring)

---

## Pricing Architecture

```
1. eBay Finding API (PRIMARY)
   - Best source for sold/completed comps (actual transaction prices)
   - Active listings + new retail pricing
   - Relevance filtering (0.28 threshold) ensures comp quality
   - Circuit breaker: detects rate limits, 30-min cooldown to preserve quota

2. Claude Knowledge (FALLBACK — fills gaps when eBay has no results)
   - Training knowledge provides market value estimates
   - Handles misspellings (Jakery → Jackery) and unreleased products
   - Confidence tagged as "medium" when used as primary source

3. Post-Processing Guards
   - Security ≤ 3 → unconditionally forces should_buy = False
   - Price $0 → early return with structured low-confidence response
   - Price > 1.5x market → score capped at 5, should_buy = False
   - Price < 0.4x market + safe → score floored at 7, should_buy = True
```

---

## Security Scorer

Runs in parallel with deal scoring — a listing can score 8/10 on price and still get flagged as a scam.

| Layer | Method | What It Catches |
|-------|--------|----------------|
| Layer 1 | Rule-based regex | Zelle/Venmo requests, off-platform contact, shipping scams, advance-fee patterns |
| Layer 2 | Claude Haiku AI | Subtle manipulation, inconsistency detection, pressure tactics |
| Layer 3 | Item-specific risks | iCloud lock, VIN issues, counterfeit indicators, recall status |

---

## Affiliate Program Engine

21 programs across 15+ categories. The router matches each item's detected category to the best programs, ranked by expected revenue.

| Category | Programs |
|----------|---------|
| Electronics | Back Market, Best Buy, Newegg, Amazon, eBay |
| Phones / Tablets | Back Market, Best Buy, Amazon, eBay |
| Computers | Newegg, Back Market, Best Buy, Amazon, eBay |
| Tools | Home Depot, Lowe's, Amazon, eBay |
| Appliances | Home Depot, Lowe's, Best Buy, Wayfair, Amazon, eBay |
| Furniture | Wayfair, Walmart, Target, Amazon |
| Outdoor / Camping | REI, Dick's Sporting Goods, Amazon, eBay |
| Fitness / Sports | Dick's Sporting Goods, REI, Amazon, Walmart |
| Vehicles | Autotrader, CarGurus, CarMax, eBay |
| Auto Parts | Advance Auto Parts, CarParts.com (8%), Amazon, eBay |
| Musical Instruments | Sweetwater, Amazon, eBay |
| Baby / Kids / Toys | Target, Amazon, Walmart |
| Pets | Chewy, Amazon, Walmart |
| Clothing | Target, Walmart, Amazon |
| General | Amazon, eBay, Walmart |

**Live programs** (earning commissions): Amazon Associates, eBay Partner Network
**Search-only** (generating traffic links, credentials pending): all others

Category detection uses **567+ keyword entries** covering brands (DeWalt, Dyson, Surron, Peloton, Traeger, Jackery...), product types, and wearables.

---

## Analytics & Data

### PostgreSQL Persistence
- `affiliate_events` — records every affiliate click (program, category, price bucket, deal score, position)
- `query_corrections` — user-submitted query corrections for improving eBay search accuracy
- `market_signals` — anonymized aggregate pricing data per scored listing

### Daily Discord Digest
- Background scheduler fires at midnight UTC
- Summarizes last 24h: per-program impressions, CTR, card positions, sorted by clicks
- Manual trigger at `GET /admin/daily-summary`

### Admin Dashboard
- `GET /admin` — affiliate clicks + corrections overview
- `GET /score-log` — last 500 full scorecards for post-browse audit

### B2B Market Intelligence
- `GET /v1/market-data` — anonymized aggregate signals for retailers and researchers
- No PII collected — no user IDs, listing URLs, or seller data

---

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/score` | POST | Main scoring endpoint — full pipeline |
| `/score/stream` | POST | SSE streaming — Claude extracts fields + scores |
| `/health` | GET | Health check with key status |
| `/privacy` | GET | Privacy policy (Chrome Web Store compliance) |
| `/event` | POST | Records affiliate click events |
| `/feedback` | POST | Saves query corrections |
| `/score-log` | GET | Scoring history (last 500 entries) |
| `/admin` | GET | Admin dashboard (auth required) |
| `/admin/daily-summary` | GET | Manual daily digest trigger |
| `/v1/market-data` | GET | B2B market signals API |
| `/docs` | GET | FastAPI auto-generated API docs |

---

## Running Locally

```bash
# Backend API (FastAPI — port 8000)
cd artifacts/deal-scout-api
uvicorn main:app --host 0.0.0.0 --port 8000

# Node proxy (routes /api/ds → FastAPI)
pnpm --filter @workspace/api-server run dev

# Interactive API docs
open http://localhost:8000/docs
```

**Load extension in Chrome:**
1. `chrome://extensions` → Enable Developer Mode
2. Load Unpacked → select `/extension`
3. Navigate to any supported listing — sidebar appears automatically

---

## Environment Variables

| Variable | Required | Notes |
|----------|----------|-------|
| `AI_INTEGRATIONS_ANTHROPIC_BASE_URL` | ✅ Set by Replit | Claude AI proxy URL |
| `AI_INTEGRATIONS_ANTHROPIC_API_KEY` | ✅ Set by Replit | Claude AI proxy key |
| `EBAY_APP_ID` | ⚠️ Required | eBay Developer App ID |
| `EBAY_CAMPAIGN_ID` | Optional | eBay Partner Network campaign ID |
| `AMAZON_ASSOCIATE_TAG` | Optional | Amazon Associates tag |
| `DATABASE_URL` | ✅ Set by Replit | PostgreSQL connection string |
| `DISCORD_WEBHOOK_URL` | Optional | Daily digest notifications |
| `MARKET_DATA_API_KEY` | Optional | Protect B2B data endpoint |

---

## Build Status

### Extension
| Feature | Status |
|---------|--------|
| Manifest V3 service worker | ✅ |
| Facebook Marketplace (SPA + overlay detection) | ✅ |
| Craigslist content script | ✅ |
| eBay content script | ✅ |
| OfferUp content script (React SPA retry) | ✅ |
| Collapsible, draggable sidebar | ✅ |
| Deal score + flags + suggested offer | ✅ |
| One-click negotiation messages | ✅ |
| Price history tracking (chrome.storage) | ✅ |
| Seller trust scoring | ✅ |
| Strikethrough / price reduction detection | ✅ |
| Affiliate cards (3 per score) | ✅ |
| Claude Vision — photo condition analysis | ✅ |
| 4-layer bleed prevention (mutex + nonce + URL + title guard) | ✅ |
| Chrome Web Store submission | ⏳ Pending review |

### Backend API
| Feature | Status |
|---------|--------|
| FastAPI `/score` + `/score/stream` endpoints | ✅ |
| Claude product extraction + deal scoring | ✅ |
| eBay Finding API (primary + circuit breaker) | ✅ |
| Claude knowledge pricing (fallback) | ✅ |
| 21-program affiliate routing engine | ✅ |
| 567+ category keyword map | ✅ |
| 3-layer security / scam scorer | ✅ |
| Security/price post-processing guards | ✅ |
| Market signals → PostgreSQL pipeline | ✅ |
| Affiliate events → PostgreSQL persistence | ✅ |
| Daily Discord digest scheduler | ✅ |
| Admin dashboard + score log | ✅ |
| `/v1/market-data` B2B endpoint | ✅ |
| Privacy policy endpoint | ✅ |

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Chrome Extension | JavaScript, Manifest V3, Service Worker |
| Backend API | Python 3.11, FastAPI, Uvicorn |
| Node Proxy | Express, TypeScript |
| AI | Anthropic Claude Haiku (via Replit AI proxy) |
| Price Data | eBay Finding API + Claude knowledge fallback |
| Database | PostgreSQL (market signals, affiliate events, corrections) |
| Affiliate Engine | 21-program config-driven router |
| Hosting | Replit (production deployed) |

---

## Privacy

Deal Scout does not collect personal information. See our [Privacy Policy](https://deal-scout-805lager.replit.app/api/ds/privacy).

- Extension reads DOM only — never touches credentials or browsing history
- No cookies, fingerprinting, or user tracking
- Affiliate IDs live server-side, never exposed to extension JS
- Market signal data is fully anonymized — no seller names, URLs, or user IDs

---

## Changelog

### v0.33.1 (Mar 2026) — Scoring Fixes
- Security ≤ 3 unconditionally forces `should_buy = False` (both endpoints)
- $0 price guard returns structured response early (no pipeline crash)
- Price/market ratio post-adjustment: overpriced cap + underpriced floor
- eBay relevance threshold lowered 0.35 → 0.28 for better match rates
- Claude pricer handles misspellings and unreleased products
- eBay refinement + product eval run in parallel (saves ~1-2s)

### v0.32.0 (Mar 2026) — Analytics Persistence
- PostgreSQL persistence for affiliate events + query corrections
- Daily Discord digest scheduler (midnight UTC)
- Admin dashboard with per-program impressions/CTR breakdown
- Chrome Web Store submission package

### v0.29.x (Mar 2026) — Security & Speed
- Enhanced security check (warnings + positives + checks list)
- CarGurus affiliate integration for vehicles
- Speed optimizations across pipeline

### v0.26.x (Mar 2026) — Bleed Prevention & Stability
- 4-layer bleed prevention: AbortController + nonce + URL + title guard
- Facebook Marketplace overlay/dialog extraction
- Image filtering by `clientWidth ≥ 200px` (excludes avatars)
- `__dealScoutRunning` mutex prevents concurrent scoring

### v0.5.0 (Mar 2026) — Pipeline Architecture
- eBay promoted to primary pricing source
- Claude Vision integration for photo condition analysis
- Shipping cost extraction + seller trust scoring
- Search results overlay badges on FBM thumbnails

### v0.2.0 (Mar 2026) — Extension Launch
- Chrome extension with FBM + Craigslist content scripts
- Collapsible, draggable sidebar with one-click messaging
- Price history tracking via chrome.storage

### v0.1.0 (Mar 2026) — POC
- FastAPI backend with eBay Finding API + Claude scoring

---

## License

Private — not open source. Contact dealscout@proton.me for inquiries.
