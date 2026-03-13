# Deal Scout — AI-Powered Deal Scoring Browser Extension

A browser extension that scores deals on Facebook Marketplace, Craigslist, eBay, and OfferUp using Claude AI, Google Shopping price data, and a 3-layer scam detection engine. Revenue via affiliate cards embedded in every score result.

---

## Project Structure

```
deal-scout/
├── extension/                    # Chrome extension (Manifest V3)
│   ├── manifest.json             # v0.26.39 — permissions, host rules
│   ├── background.js             # Service worker — API calls, badge updates
│   ├── content/
│   │   ├── fbm.js                # Facebook Marketplace content script
│   │   ├── craigslist.js         # Craigslist content script
│   │   ├── ebay.js               # eBay content script
│   │   └── offerup.js            # OfferUp content script
│   ├── popup/
│   │   ├── popup.html            # Extension popup UI
│   │   └── popup.js              # Popup logic — health check, rescore
│   └── icons/                    # 16px, 48px, 128px PNGs
│
├── artifacts/
│   ├── deal-scout-api/           # FastAPI backend (Python)
│   │   ├── main.py               # /score endpoint — orchestrates pipeline
│   │   └── scoring/
│   │       ├── product_extractor.py   # Claude extracts brand/model/category
│   │       ├── google_pricer.py       # Google Shopping scraper (primary)
│   │       ├── ebay_pricer.py         # eBay Finding API (fallback) + circuit breaker
│   │       ├── claude_pricer.py       # Claude market value estimation
│   │       ├── deal_scorer.py         # Final scoring logic
│   │       ├── affiliate_router.py    # 18-program affiliate card engine
│   │       ├── security_scorer.py     # 3-layer scam detection
│   │       ├── data_pipeline.py       # Market signals → PostgreSQL
│   │       ├── suggestion_engine.py   # Deal improvement suggestions
│   │       ├── product_evaluator.py   # Brand/model reputation (Claude)
│   │       ├── corrections.py         # Price range correction overrides
│   │       ├── vehicle_pricer.py      # Vehicle-specific pricing logic
│   │       └── craigslist_pricer.py   # Craigslist price data
│   │
│   └── api-server/               # Node.js proxy (routes /api/ds → FastAPI)
│       └── src/app.ts
│
└── replit.md                     # Architecture notes
```

---

## Platform Support

| Platform | Status | Notes |
|----------|--------|-------|
| Facebook Marketplace | ✅ Live | Full extraction — price, images, seller, shipping |
| Craigslist | ✅ Live | Price + description extraction |
| eBay | ✅ Live | Active listing scoring |
| OfferUp | ✅ Live | Basic extraction |

---

## Scoring Pipeline

Every listing goes through this pipeline on the backend:

```
Listing text + image
    → Product Extractor   (Claude: brand, model, category, condition)
    → Google Pricer       (PRIMARY: Google Shopping scrape — retail + used)
    → eBay Pricer         (FALLBACK: sold comps via Finding API)
    → Claude Pricer       (fills gaps with training knowledge, always runs)
    → Product Evaluator   (brand reputation, known issues)
    → Deal Scorer         (final 1–10 score + flags + suggested offer)
    → Affiliate Router    (3 category-matched cards from 18 programs)
    → Security Scorer     (3-layer scam detection — parallel)
    → Data Pipeline       (anonymized signal → PostgreSQL — async, non-blocking)
```

---

## Affiliate Program Engine

The affiliate router maps each item's detected category to the best-matched programs. 18 programs configured:

| Category | Programs |
|----------|---------|
| Electronics | Back Market, Best Buy, Newegg, Amazon, eBay |
| Phones / Tablets | Back Market, Best Buy, Amazon, eBay |
| Tools | Home Depot, Lowe's, Amazon, eBay |
| Appliances | Home Depot, Lowe's, Best Buy, Amazon, eBay |
| Furniture | Wayfair, Walmart, Amazon |
| Outdoor / Camping | REI, Amazon, eBay |
| Fitness | Dick's Sporting Goods, Amazon, Walmart |
| Vehicles | Autotrader, CarGurus, CarMax, eBay |
| Auto Parts | Advance Auto Parts, CarParts.com, Amazon, eBay |
| Musical Instruments | Sweetwater, Amazon, eBay |
| Baby / Kids / Toys | Target, Amazon, Walmart |
| Pets | Chewy, Amazon, Walmart |
| General | Amazon, eBay |

Category detection uses 170+ keyword entries covering brands (DeWalt, Dyson, Surron, Peloton, Traeger...), product types (impact driver, vacuum, grill...), and wearables (Apple Watch, Garmin, Fitbit...).

**Live programs** (earning commission now): Amazon Associates, eBay Partner Network  
**Search-only programs** (generating traffic links, commission pending credentials): all others

---

## Security Scorer

Runs in parallel with deal scoring — a listing can score 8/10 on price and still be a scam.

| Layer | Method | Cost |
|-------|--------|------|
| Layer 1 | Rule-based regex — Zelle/Venmo, off-platform contact, shipping scams, advance-fee patterns | Free |
| Layer 2 | Claude Haiku — subtle manipulation, inconsistency detection | ~$0.0003/call |
| Layer 3 | Item-specific risks — iCloud lock, VIN issues, counterfeit indicators, recall status | Included in Layer 2 |

---

## Market Intelligence Data Pipeline

Every scored listing writes an anonymized row to PostgreSQL:

- Category, item label, condition, city/state
- Asking price, eBay sold avg, Google Shopping avg, new retail price
- Deal score, price gap %, which affiliate programs were shown
- Platform (facebook_marketplace / craigslist / ebay / offerup)

**What is NOT collected:** user IDs, seller names, listing URLs, any PII.

This dataset has standalone B2B value — weekly exports for retailers, insurers, and market researchers.

---

## Pricing Architecture

```
1. Google Shopping (PRIMARY)
   - No API key required — scrapes real retail + used prices
   - Broad retailer coverage, not just eBay sellers
   - Fast with persistent browser (~0.3s after warm-up)

2. eBay Finding API (FALLBACK — when Google returns < 3 prices)
   - Best source for sold/completed comps (actual transaction prices)
   - Rate limited: ~5,000 calls/day free tier
   - Circuit breaker: detects rate limit (error 10001 from HTTP 500 body),
     opens 30-min cooldown to stop wasted quota usage

3. Claude Knowledge (ALWAYS RUNS)
   - Training knowledge fills price gaps
   - Confidence tagged as "medium" when used as primary source
```

---

## API Keys Required

| Key | Where | Env Variable |
|-----|-------|--------------|
| Anthropic (Claude) | https://console.anthropic.com | `AI_INTEGRATIONS_ANTHROPIC_API_KEY` |
| eBay Finding API | https://developer.ebay.com | `EBAY_APP_ID` |
| eBay Affiliate | https://partnernetwork.ebay.com | `EBAY_CAMPAIGN_ID` |
| Amazon Associates | https://affiliate-program.amazon.com | `AMAZON_ASSOCIATE_TAG` |

Affiliate programs for Best Buy, Home Depot, REI, etc. are in search-only mode until credentials are added to `affiliate_router.py`.

---

## Running the Stack

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
3. Navigate to any FBM / Craigslist / eBay / OfferUp listing — sidebar appears automatically

---

## Build Status

### Extension
| Feature | Status |
|---------|--------|
| Manifest V3, service worker | ✅ |
| Facebook Marketplace content script | ✅ |
| Craigslist content script | ✅ |
| eBay content script | ✅ |
| OfferUp content script | ✅ |
| Collapsible, draggable sidebar | ✅ |
| Deal score + flags + suggested offer | ✅ |
| One-click message templates (clipboard) | ✅ |
| Price history tracking (chrome.storage) | ✅ |
| Search results overlay badges | ✅ |
| Seller trust scoring | ✅ |
| Strikethrough / price reduction detection | ✅ |
| Affiliate cards (3 per score) | ✅ |
| Bleed prevention (4-layer mutex + nonce + URL + title guard) | ✅ |
| Chrome Web Store submission | 🔲 |

### Backend API
| Feature | Status |
|---------|--------|
| FastAPI /score endpoint | ✅ |
| Claude product extraction | ✅ |
| Google Shopping pricing (primary) | ✅ |
| eBay Finding API (fallback + circuit breaker) | ✅ |
| Claude knowledge pricing (always-on) | ✅ |
| 18-program affiliate routing engine | ✅ |
| 170+ category keyword map | ✅ |
| 3-layer security / scam scorer | ✅ |
| Market signals → PostgreSQL pipeline | ✅ |
| /v1/market-data B2B endpoint | ✅ |
| Reddit reputation data | ⏳ Blocked (403 on cloud IPs) |
| Craigslist comps | ⏳ Blocked (403 on cloud IPs) |

---

## Changelog

### v0.26.39 (Mar 2026) — Bleed Prevention
- 4-layer bleed prevention: AbortController + nonce guard + URL guard + title-word overlap check before render
- `_inSidebarCard()` guard on all price and image extraction strategies
- `_pickImages(minW)` filters by `clientWidth >= 200px` to exclude seller avatars and thumbnail cards

### v0.26.38 (Mar 2026) — Price Bleed Fix
- FBM "Similar listings" sidebar aria-label prices no longer contaminate current listing price
- `_inSidebarCard()` applied to all 4 price extraction strategies

### v0.26.37 (Mar 2026) — Image Fix
- `img[src*="scontent"]` was grabbing seller profile avatars (~72KB, 40–80px)
- Replaced with `_pickImages(minW)` filtering by `clientWidth >= 200px` with fallback tiers

### v0.26.36 (Mar 2026) — Mutex
- `__dealScoutRunning` mutex prevents concurrent scoring on fast navigation

### v0.5.0 (Mar 2026) — Pricing Priority Inversion
- Google Shopping promoted to PRIMARY; eBay demoted to FALLBACK
- CORS fix — `allow_origins=["*"]` for content script requests
- Sidebar positioning: `position:absolute` on root to survive Facebook's CSS transforms

### v0.4.0 (Mar 2026) — Full Pipeline
- Shipping cost extraction → shown in sidebar, factored into Claude scoring
- Seller rating extraction from DOM (no longer inferred)
- Strikethrough original price detection
- CSP compliance — all handlers use `addEventListener` post-insertion
- Claude Vision — first listing photo sent to Claude Haiku for condition mismatch
- Search results overlay badges on FBM listing thumbnails
- Pro gating via `chrome.storage.local`

### v0.2.0 (Mar 2026) — Extension Launch
- Chrome extension with FBM + Craigslist content scripts
- Full DOM extraction without data-testid
- Collapsible, draggable sidebar
- One-click message templates
- Price history tracking

### v0.1.0 (Mar 2026) — POC
- Playwright-based FBM scraper
- eBay Finding API price comparison with mock fallback
- Claude API deal scoring
- FastAPI backend

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Browser Extension | JavaScript, Chrome Manifest V3 |
| Backend API | Python + FastAPI |
| Node Proxy | Express / TypeScript |
| AI Scoring | Anthropic Claude (Sonnet + Haiku) |
| Price Data | Google Shopping (scrape) + eBay Finding API |
| Affiliate Engine | 18-program router — Amazon, eBay, Home Depot, REI, and more |
| Database | PostgreSQL (market signals, anonymized aggregate data) |
| Hosting | Replit (dev) |

---

## Security Notes

- `.env` / secrets are never committed — managed via Replit Secrets
- Extension reads DOM only — never touches credentials
- Affiliate IDs live server-side, never exposed to extension JS
- Market signal data is fully anonymized — no seller names, URLs, or user IDs collected
