README
Deal Scout — AI-Powered Deal Scoring Browser Extension
An AI-powered shopping assistant that scores deals on Facebook Marketplace and Craigslist using Claude AI and real market data from eBay.

Project Structure
Personal_Shopping_Bot/
├── scraper/          # POC-only Playwright scraper (superseded by extension)
├── api/              # FastAPI backend — deal scoring, eBay pricing, affiliate links
├── scoring/          # Claude API scoring engine, eBay price comparison
├── extension/        # Chrome browser extension (production data collection layer)
│   ├── manifest.json         # Extension config — permissions, v0.2.0
│   ├── background.js         # Service worker — API calls, affiliate injection
│   ├── content/
│   │   └── fbm.js            # FBM + Craigslist content script (~850 lines)
│   ├── popup/
│   │   ├── popup.html        # Extension popup UI
│   │   └── popup.js          # Popup logic — API health check, score trigger
├── ui/               # React web UI — standalone deal scorer (Week 4 — not yet built)
├── data/             # Flat file storage for POC (JSON)
├── .env              # Credentials — NEVER commit this to git
├── check_setup.py    # Setup verification script
├── requirements.txt
└── README.md
Product Vision
Phase 1 (Now): Free browser extension + affiliate revenue

Extension detects when user views a FBM/Craigslist listing
Scores the deal using Claude AI + eBay market data
Sidebar shows deal score, flags, recommended offer, message templates
Affiliate links to eBay/Amazon embedded in results — revenue on click-through
Phase 2: Freemium — power users pay for alerts + watchlists

Free tier: real-time scoring on listings you visit
Paid ($9/mo): watchlists, proactive alerts, price history, bulk scoring
Phase 3: Acquisition target or raise to scale

Data insights product for market research / insurance / financial apps
B2B reseller tier for car flippers and power resellers
Monetization
Affiliate Revenue (Phase 1)
Every deal score shows eBay and Amazon comparison links with embedded affiliate IDs. Commission on any click-through purchase — zero user friction, zero paywall.

Program	Commission	Sign Up
eBay Partner Network	50–70% of eBay's revenue on referred sales	https://partnernetwork.ebay.com
Amazon Associates	1–10% by category	https://affiliate-program.amazon.com
API Keys
Key	Where	.env Variable
Anthropic	https://console.anthropic.com → API Keys	ANTHROPIC_API_KEY
eBay API	https://developer.ebay.com → App Keys	EBAY_APP_ID
eBay Affiliate	https://partnernetwork.ebay.com	EBAY_CAMPAIGN_ID
Amazon API	https://affiliate-program.amazon.com → PA API	AMAZON_ACCESS_KEY, AMAZON_SECRET_KEY
Amazon Affiliate	Same account	AMAZON_ASSOCIATE_TAG
Setup
# Install dependencies
python -m pip install -r requirements.txt
python -m playwright install chromium

# Configure credentials
cp .env.example .env   # fill in your keys

# Verify setup
python check_setup.py
Running the Stack
# API backend (required for extension to function)
python -m uvicorn api.main:app --reload --port 8000
# Interactive docs → http://localhost:8000/docs

# React UI (not yet built — Week 4)
cd ui && npm install && npm start
# Will open at http://localhost:3000

# POC scraper (standalone, not needed for extension)
python scraper/fbm_scraper.py --mode text
Load Extension in Chrome
chrome://extensions → Enable Developer Mode
Load Unpacked → select the /extension folder
Navigate to any FBM listing — sidebar appears automatically
Build Status
POC (Weeks 1–4) ✅
Week	Goal	Status
1	FBM scraper — 3 modes	✅
2	eBay price comparison	✅ (mock data while API approval pending)
3	Claude deal scoring engine	✅
4	React UI	⏳ Scaffolded, not yet built
Phase 1 — Chrome Extension
Feature	Status
Manifest v3, permissions, service worker	✅
FBM content script — full DOM extraction	✅
Craigslist content script	✅
Collapsible sidebar — score, flags, offer	✅
Draggable sidebar (persists position)	✅
One-click message templates (clipboard)	✅
Price history tracking (chrome.storage)	✅
Search results overlay badges	✅
Seller trust scoring	✅
Strikethrough / price reduction detection	✅
Google Shopping pricing (primary)	✅
eBay real API data (fallback)	⏳ Pending eBay API approval
Amazon price anchor	🔲 Not started
eBay affiliate link activation	🔲 Needs campaign ID in .env
Amazon affiliate link activation	🔲 Needs associate tag in .env
OfferUp support	🔲 Not started
Chrome Web Store submission	🔲 Not started
Changelog
v0.5.0 — Positioning Fix + CORS + Pricing Inversion (Mar 2026)
✅ CORS fix — FastAPI allow_origins changed from [localhost:3000] to ["*"]; content script requests from facebook.com were being rejected even with correct host_permissions
✅ Sidebar positioning fix — #ds-tab and #ds-panel changed from position:fixed (viewport-relative) to position:absolute (root-relative); previous architecture made makeDraggable() move an invisible container while tab/panel stayed put
✅ Facebook transform fix — root now appended to document.documentElement instead of document.body; Facebook applies CSS transform to body ancestors for scroll animations which breaks child position:fixed by repositioning them relative to the transformed element instead of the viewport
✅ Drag now works — tab and panel follow root correctly because they are absolute children, not independent fixed elements
✅ Better error message — network-level failures (TypeError) now show actionable "API not reachable" hint with the uvicorn start command
✅ Pricing priority inversion — Google Shopping is now PRIMARY, eBay is FALLBACK (see below)
v0.4.0 — Extraction Fixes + Full Pipeline (Mar 2026)
✅ Price extraction fix — FBM current price is a text node, not a <span>; childNodes walk correctly extracts it and ignores strikethrough original
✅ Shipping cost extraction — regex /ships? for $X/i; passed to Claude as shipping_cost; sidebar shows +$X.XX shipping = $XXX total in orange; Claude factors true total cost into scoring
✅ Seller rating extraction — no longer fabricated from trust tier; reads (N) review count + "Highly Rated" badge; infers 4.8 if badge, 4.0 if reviews exist, null otherwise
✅ Strikethrough original price detection — identifies seller price reductions; shown in sidebar and passed to Claude as context
✅ CSP compliance — Facebook strips inline onclick from injected HTML; all handlers converted to addEventListener post-insertion; fixes tab switching and card clicks
✅ Claude Vision integration — first listing photo sent to Claude Haiku for condition mismatch detection
✅ Suggestion engine — 3 affiliate cards per score (same_cheaper, better_model, same_amazon)
✅ Pro gating — isPro() reads ds_pro toggle written by popup via chrome.storage.local
✅ SPA navigation handler in background.js — debounced re-injection on history.pushState (800ms)
✅ Search results overlay — deal score badges injected on FBM listing thumbnails
✅ Multi-item / vehicle detection in Claude prompt — suppresses false flags on bundles and ATVs
v0.2.0 — Extension (Mar 2026)
✅ Chrome extension with FBM + Craigslist content scripts
✅ Full DOM extraction without data-testid (Facebook removed them late 2024)
✅ Collapsible, draggable sidebar with deal score, flags, recommended offer
✅ One-click message templates (offer, condition inquiry, fast offer)
✅ Price history tracking across visits (chrome.storage.local)
✅ Search results overlay — badge each listing thumbnail with cached score
✅ Seller trust scoring — account age, review count, Highly Rated badge
✅ Strikethrough price detection — identifies seller price reductions
✅ Popup: API health check, manual rescore trigger, Open Full Scorer button
v0.1.0 — POC (Mar 2026)
✅ Playwright-based FBM scraper (URL, text, batch modes)
✅ eBay Finding API price comparison with mock fallback
✅ Claude API deal scoring with structured JSON output
✅ FastAPI backend wiring scraper → eBay → Claude
✅ Validated on real listings (Orion telescope, Gskyer telescope)
⚠️ Notes
Bot Detection

Extension runs in user's own authenticated session — no bot detection issues
POC scraper: always use HEADLESS=false, never run from datacenter IP
Security

.env is gitignored — never commit it
Extension reads DOM only — never touches credentials
Affiliate IDs live server-side in .env, never exposed to extension JS
Tech Stack
Layer	Technology
Browser Extension	JavaScript, Chrome Manifest V3
Backend API	Python + FastAPI
AI Scoring	Anthropic Claude API
Price Comparison	eBay Finding API + Amazon PA API
Affiliate Revenue	eBay Partner Network + Amazon Associates
Frontend	React (Week 4)
Storage	chrome.storage.local (extension) + flat JSON (POC)