# Personal Shopping Bot

An AI-powered shopping assistant that scores deals on Facebook Marketplace,
Craigslist, and other platforms using Claude AI and real market data from eBay and Amazon.

---

## Project Structure
```
Personal_Shopping_Bot/
├── scraper/          # POC-only Playwright scraper (replaced by extension in production)
├── api/              # FastAPI backend — deal scoring, affiliate links, watchlists
├── scoring/          # Claude API deal scoring, eBay + Amazon price comparison
├── extension/        # Chrome browser extension (production data collection layer)
│   ├── manifest.json     # Extension config — permissions, scripts, metadata
│   ├── background.js     # Service worker — handles API calls, affiliate link injection
│   ├── content.js        # Page scraper — reads FBM/Craigslist/Amazon DOM
│   ├── popup.html        # Extension popup UI
│   └── popup.js          # Popup logic
├── ui/               # React web UI — standalone deal scorer (POC + affiliate demo)
├── data/             # Flat file storage for POC (JSON, no database yet)
├── .env              # Credentials — NEVER commit this to git
├── check_setup.py    # Setup verification script
├── requirements.txt
└── README.md
```

---

## Product Vision

**Phase 1 (Now):** Free browser extension + affiliate revenue
- Extension detects when user views a FBM/Craigslist/Amazon listing
- Automatically scores the deal using Claude AI + eBay/Amazon market data
- Shows a deal score sidebar — no user action needed
- Affiliate links to eBay/Amazon embedded in results — revenue on click-through purchases

**Phase 2:** Freemium — power users pay for alerts + watchlists
- Free tier: real-time scoring on listings you visit
- Paid ($9/mo): watchlists, proactive alerts, price history, bulk scoring

**Phase 3:** Acquisition target or raise to scale
- Data insights product for market research / insurance / financial apps
- B2B reseller tier for car flippers and power resellers

---

## Monetization Strategy

### Affiliate Revenue (Phase 1)
Every deal score result shows comparison links to eBay and Amazon with embedded affiliate IDs.
When a user clicks through and purchases, we earn a commission — no user friction, no paywall.

| Program | Commission | Sign Up |
|---------|-----------|---------|
| eBay Partner Network | 50-70% of eBay's revenue on referred sales | https://partnernetwork.ebay.com |
| Amazon Associates | 1-10% depending on category | https://affiliate-program.amazon.com |

### Affiliate Link Format
```
eBay:   https://www.ebay.com/sch/i.html?_nkw={query}&mkevt=1&mkcid=1&mkrid=711-53200-19255-0&campid={CAMPAIGN_ID}&toolid=10001
Amazon: https://www.amazon.com/s?k={query}&tag={ASSOCIATE_TAG}
```

---

## API Keys — Where to Get Them

### Anthropic (Claude API)
1. Go to https://console.anthropic.com
2. Sign in → **API Keys** → **Create Key**
3. Paste into `.env` as `ANTHROPIC_API_KEY=sk-ant-...`

### eBay API (price comparison)
1. Go to https://developer.ebay.com
2. **My Account → Application Access Keys → Create App → Production**
3. Copy App ID into `.env` as `EBAY_APP_ID=...`

### eBay Partner Network (affiliate revenue)
1. Go to https://partnernetwork.ebay.com
2. Apply for an account (usually approved within 24hrs)
3. Get your Campaign ID and paste into `.env` as `EBAY_CAMPAIGN_ID=...`

### Amazon Product Advertising API (price comparison)
1. Join Amazon Associates at https://affiliate-program.amazon.com
2. Once approved, go to Tools → Product Advertising API
3. Get Access Key + Secret Key + Associate Tag
4. Paste into `.env` as `AMAZON_ACCESS_KEY`, `AMAZON_SECRET_KEY`, `AMAZON_ASSOCIATE_TAG`

### Amazon Associates (affiliate revenue)
- Same account as above — your Associate Tag is embedded in all product links

---

## Setup

```bash
# 1. Install Python dependencies
python -m pip install -r requirements.txt

# 2. Install Playwright browser (POC scraper only)
python -m playwright install chromium

# 3. Fill in your .env file (see API Keys section above)

# 4. Verify everything is ready
python check_setup.py
```

---

## Running the Stack

### POC Scraper (data collection — replaced by extension in production)
```bash
# Manual text input mode — no FB account needed
python scraper/fbm_scraper.py --mode text

# Single URL mode
python scraper/fbm_scraper.py --mode url --input "https://www.facebook.com/marketplace/item/123"

# Batch mode — one URL per line in a text file
python scraper/fbm_scraper.py --mode batch --input data/urls.txt
```

### eBay Pricer
```bash
python scoring/ebay_pricer.py
```

### Deal Scorer
```bash
python scoring/deal_scorer.py
```

### API Backend
```bash
python -m uvicorn api.main:app --reload --port 8000
# Docs available at http://localhost:8000/docs
```

### React UI
```bash
cd ui && npm install && npm start
# Opens at http://localhost:3000
```

### Chrome Extension (load unpacked)
1. Open Chrome → `chrome://extensions`
2. Enable **Developer Mode** (top right)
3. Click **Load Unpacked**
4. Select the `/extension` folder
5. Browse to any FBM or Craigslist listing — sidebar appears automatically

---

## Build Progress

### POC (Weeks 1-4) ✅ Complete
| Week | Goal | Status |
|------|------|--------|
| 1 | FBM scraper — 3 modes, no login required | ✅ Done |
| 2 | eBay API — market price comparison | ✅ Done |
| 3 | Claude API — deal scoring engine | ✅ Done |
| 4 | React UI — paste a listing, get a score | ✅ Done |

### Phase 1 — Chrome Extension + Affiliate Revenue
| Task | Status |
|------|--------|
| Extension manifest + permissions | ✅ Scaffolded |
| Content script — FBM listing detection | 🔲 In progress |
| Content script — Craigslist listing detection | 🔲 Not started |
| Content script — Amazon listing detection | 🔲 Not started |
| Background service worker — API calls | 🔲 Not started |
| Sidebar UI — deal score display | 🔲 Not started |
| eBay affiliate link injection | 🔲 Not started |
| Amazon affiliate link injection | 🔲 Not started |

---

## Changelog

### v0.1.0 — POC Complete (Mar 3, 2026)
- ✅ Built Playwright-based FBM scraper with 3 modes (URL, text, batch)
- ✅ Built eBay Finding API price comparison module with mock fallback
- ✅ Built Claude API deal scoring engine with structured JSON output
- ✅ Built React UI — paste a listing, get a full AI deal score
- ✅ Built FastAPI backend wiring all three stages together
- ✅ Validated full pipeline on real listing (Orion telescope, Gskyer telescope)
- ✅ Confirmed Claude catches condition inconsistencies and flags red/green signals

### Next Up — v0.2.0 Chrome Extension
- Chrome extension scaffold (manifest, content script, background worker)
- FBM listing auto-detection and scraping from user's own session
- Amazon price comparison integration
- eBay + Amazon affiliate link injection in deal score results

---

## ⚠️ Bot Detection Notes
- Scraper: always run with `HEADLESS=false` — visible browser is less detectable
- Extension: runs in user's own authenticated session — no bot detection issues
- Never run the scraper from a datacenter IP — use home/residential connection

---

## ⚠️ Security Notes
- Never commit `.env` to git — already in `.gitignore`
- Extension never touches user credentials — reads DOM only
- Affiliate IDs live server-side in `.env` — never exposed to the extension

---

## Tech Stack
| Layer | Technology |
|-------|-----------|
| Browser Extension | JavaScript, Chrome Manifest V3 |
| Data Collection (POC) | Python + Playwright |
| Backend API | Python + FastAPI |
| AI Scoring | Anthropic Claude API (claude-haiku-4-5) |
| Price Comparison | eBay Finding API + Amazon Product Advertising API |
| Affiliate Revenue | eBay Partner Network + Amazon Associates |
| Frontend | React |
| Storage | Flat JSON files (POC) → PostgreSQL (Phase 2) |
