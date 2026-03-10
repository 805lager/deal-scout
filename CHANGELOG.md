# Deal Scout — Changelog

All notable changes to this project are documented here.
Format: `vX.Y.Z — Description (Date)`

---

## v0.25.0 — Gemini AI market pricing replaces Google Shopping scraper (Mar 2026)

### New Features
- **Gemini AI pricing pipeline** (`scoring/gemini_pricer.py`) — NEW primary pricing source
  - `gemini_search` (purple `#a78bfa`): Gemini with Google Search Grounding — live web prices
  - `gemini_knowledge` (lighter purple `#c084fc`): Gemini training-data estimate — better than mock
  - Cascades: `gemini_search` → `gemini_knowledge` → `ebay_mock` (last resort only)
- **eBay pricer wired to Gemini** (`scoring/ebay_pricer.py`)
  - `get_market_prices()` tries Gemini first, falls back to eBay API, then mock
  - `GOOGLE_AI_API_KEY` env var required on Railway
- **New `/test-gemini` endpoint** (`api/main.py`) — verify Gemini integration after deploy
- **`gemini_knowledge` added to mock guards**
  - `renderQueryFeedback()` in `fbm.js`: shows amber "⚠️ Fix estimated comps" button
  - `should_trigger_buy_new()` in `affiliate_router.py`: suppresses buy-new banner
- **Requirements updated**: `google-generativeai>=0.7.0` added to `requirements.txt`

### Data Source Badges (fbm.js)
| `data_source` | Color | Label |
|---|---|---|
| `gemini_search` | `#a78bfa` purple | `✨ AI • Live search` |
| `gemini_knowledge` | `#c084fc` light purple | `🧠 AI estimate` |
| `ebay` | `#22c55e` green | `📊 Live eBay` |
| `ebay_mock` | `#94a3b8` gray | `📊 Est. prices` |
| `correction_range` | `#67e8f9` teal | `📌 Pinned range` |

### Breaking Changes
- `GOOGLE_AI_API_KEY` must be set on Railway before Gemini features are active
- `google-generativeai` package required — run `pip install -r requirements.txt`

---

## v0.24.1 — Fix comps button: mock fallback mode + locked price ranges (Mar 2026)

### New Features
- **Two-mode “Fix market comps” button** (`extension/content/fbm.js`)
  - MODE A (wrong query): dim white button, changes query field as before
  - MODE B (mock data fallback): amber `⚠️ Fix estimated comps` button, exposes Low/High price fields
  - Success message confirms what was saved: “query updated · price range $600–$950 locked in”
- **`correction_range` data source** (`scoring/ebay_pricer.py`)
  - When both Google and eBay fail and a locked range exists, uses midpoint instead of mock
  - Sets `data_source = "correction_range"`, `confidence = "medium"`
  - Suspect flag guard updated: only fires when `data_source == "ebay_mock"` (not correction_range)
- **`corrections.py` return type changed to dict**
  - Was: `Optional[str]` (query only)
  - Now: `Optional[dict]` with keys `good_query`, `price_low`, `price_high`
- **`/feedback` endpoint** accepts `correct_price_low` / `correct_price_high`

### Bugs Fixed (pre-push audit)
- **Version mismatch** — `manifest.json` and `fbm.js` both stuck at `0.24.0`; bumped to `0.24.1`
- **`correction_range` missing from badge switch** (`fbm.js`)
  - Was falling through to amber `⚠️ Est. prices`; now shows teal `📄 Pinned range`
- **`should_trigger_buy_new()` didn’t guard `correction_range`** (`scoring/affiliate_router.py`)
  - `new_price` on correction_range listings still comes from mock eBay data
  - Added `correction_range` to the `ebay_mock` suppression guard
- **`_event_buffer.clear()` before log count** (`api/main.py`)
  - `len(_event_buffer)` logged after `.clear()` — always logged 0
  - Worse: events lost if file write failed halfway through
  - Fix: snapshot buffer before writing, clear after success, log `len(snapshot)`

---

## v0.22.0 — Chrome Web Store + Railway Launch (Mar 2026)

### Summary
First public release. Extension published to Chrome Web Store. Backend live on Railway.
All users now hit `https://deal-scout-production.up.railway.app` by default — no DevTools setup required.

### Changes
- **Extension points at Railway by default** (`extension/popup/popup.js`)
  - `API_BASE_DEFAULT` changed from `http://localhost:8000` → `https://deal-scout-production.up.railway.app`
  - Zero setup for new users — install extension, open FBM, scores work immediately
- **⚙️ API Settings panel added to popup** (`extension/popup/popup.html`, `extension/popup/popup.js`)
  - Collapsible panel under the Score button lets you switch API URL without touching code
  - Saves to `chrome.storage.local` key `ds_api_base` — persists across sessions
  - Re-pings `/health` immediately after save so status card updates live
  - Useful for switching back to `localhost:8000` during local dev
- **`localhost` removed from `host_permissions`** (`extension/manifest.json`)
  - `http://localhost:8000/*` removed — would have been flagged by Google's extension review
  - Local dev still works via the ⚙️ Settings panel URL override
- **Version bumped to 0.21.1** (`extension/manifest.json`)
  - Aligns manifest version with changelog version
- **Logger NameError fixed in `_save_report_local()`** (`api/main.py`)
  - `logger.info/error` → `log.info/error` in the local file fallback path
  - Same root cause as v0.21.1 Discord fix — `logger` variable never defined, `log` is correct
  - Would have crashed Railway on the first report submission when Discord webhook is down

### Chrome Web Store — Submission Steps
1. Zip `extension/` folder only (not the full project)
2. Go to [chrome.google.com/webstore/devconsole](https://chrome.google.com/webstore/devconsole)
3. Pay $5 one-time developer fee (first time only)
4. New Item → Upload zip → fill in store listing:
   - Name: `Deal Scout — AI Deal Scorer`
   - Description: from `manifest.json` description field
   - Screenshots: at least 1 of sidebar scoring a listing
   - Category: Productivity
5. Submit for review — Google approves in 1–3 days
6. Share the store link — users click Install, done

### Update Workflow (ongoing)

**Backend update (scoring logic, prompts, bug fixes):**
1. Make changes locally
2. Run `push.bat` → Railway auto-deploys in ~60s
3. Done — all users get it instantly, no Chrome Store submission needed

**Extension update (UI, fbm.js, popup, new permissions):**
1. Make changes locally
2. Bump `version` in `manifest.json` (e.g. `0.22.0` → `0.23.0`)
3. Run `push.bat` to keep GitHub in sync
4. Zip the `extension/` folder
5. Chrome Web Store Developer Console → your listing → **Upload New Package** → upload zip
6. Submit for review
7. Chrome auto-updates all users silently within 24–48 hours — they do nothing

**Rule of thumb:** If the change only touches `api/` or `scoring/`, it's a Railway push only.
If it touches `extension/`, it needs a Store submission.

### Railway Environment Variables (required)
```
ANTHROPIC_API_KEY     = sk-ant-api03-...
EBAY_APP_ID           = ShaunLag-DealScou-PRD-...
DISCORD_WEBHOOK_URL   = https://discord.com/api/webhooks/...
CORS_ORIGINS          = *
LOG_LEVEL             = INFO
AMAZON_ASSOCIATE_TAG  = dealscout03f-20
EBAY_CAMPAIGN_ID      = 5339144027
EBAY_TRACKING_ID      = dealscout
```

### Health Check
- Live API: https://deal-scout-production.up.railway.app/health
- Expected: `{"api":"ok","anthropic_key":"set","ebay_key":"set"}`

---

## v0.21.1 — Logger NameError Fix (Mar 2026)

### Bug Fixed
- **`logger` NameError in `submit_report()` and `_save_report_local()`** (`api/main.py`)
  - `logger.info/error` calls throughout the report endpoint used an undefined variable.
    The module defines `log = logging.getLogger(__name__)`, not `logger`.
  - Would cause a `NameError` crash on the first report submission, preventing Discord
    delivery and local file fallback from working.
  - Fix: All `logger.*` → `log.*` in both functions.

---

## v0.21.0 — Deployment Readiness + Discord Reports (Mar 2026)

### New Features
- **Discord webhook for user reports** (`api/main.py`)
  - `POST /report` now routes to Discord when `DISCORD_WEBHOOK_URL` env var is set
  - Reports arrive as amber embeds: title, message body, timestamp
  - Falls back to local `reports.jsonl` if Discord is unreachable (graceful degradation)
  - Local dev: no config needed, file write works as before
  - Production: set `DISCORD_WEBHOOK_URL` in Railway dashboard

### Deployment Fixes
- **A — `API_BASE` no longer hardcoded in `fbm.js`** (`extension/content/fbm.js`)
  - Was: `const API_BASE = "http://localhost:8000"` — required manual file edit for every deploy
  - Now: reads from `chrome.storage.local` key `ds_api_base` at injection time
  - Fallback: `http://localhost:8000` (zero-config for local dev)
  - To point at production: `chrome.storage.local.set({ ds_api_base: "https://your-app.up.railway.app" })`
  - No extension reload required after storage change — value is read on each injection

- **B — CORS now configurable via env var** (`api/main.py`)
  - Was: hardcoded `allow_origins=["*"]` — any site could call the scoring API
  - Now: reads `CORS_ORIGINS` env var (comma-separated list)
  - Local dev: `CORS_ORIGINS` not set → defaults to `"*"` (unchanged behaviour)
  - Production: set `CORS_ORIGINS=https://www.facebook.com,chrome-extension://YOUR_EXT_ID`
  - Also tightened `allow_methods` and `allow_headers` to explicit lists

- **C — `data/` directory created at startup** (`api/main.py`)
  - `data/` is gitignored so it doesn't exist on fresh Railway containers or new checkouts
  - Analytics event writes and report file writes were silently failing on first deploy
  - Fix: `_event_file.parent.mkdir(parents=True, exist_ok=True)` at module load time

- **Cleanup — removed duplicate `import json`** (`api/main.py`)
  - `import json` and `import json as _json` were both present; deduplicated to `_json` only

- **Cleanup — `REPORTS_FILE` uses `os.path.abspath`** (`api/main.py`)
  - Relative path resolution was inconsistent depending on working directory at startup
  - Fixed to use `os.path.abspath(__file__)` for deterministic path on all platforms

### Deployment Runbook (first deploy)
1. Push to GitHub — Railway auto-deploys on push
2. Get your Railway URL from the Railway dashboard
3. Set env vars in Railway: `ANTHROPIC_API_KEY`, `EBAY_APP_ID`, `DISCORD_WEBHOOK_URL`, `CORS_ORIGINS`
4. Set `ds_api_base` in the extension: open DevTools on any FBM page →
   `chrome.storage.local.set({ ds_api_base: "https://your-app.up.railway.app" })`
5. Reload extension (toggle OFF→ON in chrome://extensions)
6. Score a listing — sidebar should appear and call the live API

### Ongoing Update Workflow
- **Backend:** `git push` → Railway redeploys in ~60s, health check gates the swap
- **Extension (testers):** send new `extension/` folder, click ↺ in chrome://extensions
- **Extension (Web Store):** bump `version` in `manifest.json`, upload new ZIP

---

## v0.20.0 — Popup Redesign + Report Issue + New Icons (Mar 2026)

### Changes
- **Popup redesign** (`extension/popup/popup.html`, `extension/popup/popup.js`)
  - Version badge updated to v0.20.0
  - Removed Pro Mode toggle (fully free model, no longer relevant)
  - Removed dead "Open Full Scorer" button (was linking to localhost:3000)
  - Craigslist status changed from "Live" → "Coming soon"
  - Platform order: FBM (Live) → Amazon (Retail anchor) → Craigslist (Coming soon) → OfferUp (Coming soon)
  - Single CTA: "🔍 Score Current Listing" button
  - Added "⚠️ Report an issue" link in footer
  - Report Issue modal: textarea, Send/Cancel, 2-second confirmation, auto-fills current tab URL
  - `API_BASE` reads from `chrome.storage.local` key `ds_api_base` with localhost fallback
- **New extension icons** (`extension/icons/`)
  - Indigo/purple rounded-square background, white shopping cart
  - All three sizes: icon16.png, icon48.png, icon128.png
- **`POST /report` endpoint** (`api/main.py`)
  - Appends to `reports.jsonl` in project root
  - Silent failure (no 500s for a logging call)

---

## v0.16.0 — Vehicle Market Pricing + Security Threshold Fix (Mar 2026)

### New Features
- **Vehicle market pricing via CarGurus + Craigslist** (`scoring/vehicle_pricer.py`)
  - New module: `vehicle_pricer.py` — scrapes CarGurus for real comparable listings near user's zip
  - Fallback chain: CarGurus → Craigslist (local private-party comps)
  - Title parser handles "2018 Honda Accord LX", "2011 BMW 3 Series 328i", apostrophe years
  - Returns median market value, price range (low/high), confidence level, and comp count
  - 10-minute in-memory cache to avoid redundant scrapes
  - `ebay_pricer.py` updated: vehicles now route to `vehicle_pricer` instead of returning stub
  - `fbm.js` updated: new `cargurus`/`craigslist` badge colors + 3-branch market comparison block
    - `vehicle_not_applicable`: warning + KBB/Carfax/CarGurus links (fallback when scrape fails)
    - `cargurus`/`craigslist`: Market avg, price range, diff, confidence, comp count + KBB/Carfax links
    - Default (eBay): unchanged

### Bugs Fixed
- **B-S5 — Security risk label contradicts recommendation at score 7** (`scoring/security_scorer.py`)
  - Root cause: `_score_to_risk()` threshold for `"low"` was `score >= 8`, but
    `_score_to_recommendation()` returns `"safe to proceed"` at `score >= 7`. A score of 7
    therefore produced `"medium"` risk level (rendered as ⚠️ CAUTION in the UI) alongside
    `"Safe To Proceed"` — a direct contradiction that would confuse users into thinking the
    deal is both cautionary and safe simultaneously.
  - Fix: Lowered `_score_to_risk()` threshold so `score >= 7` → `"low"` (🛡️ LOW RISK), matching
    the recommendation. Adjusted remaining thresholds: `4-6` → `"medium"`, `2-3` → `"high"`,
    `1` → `"critical"`.
  - Verified on 2018 Honda Accord LX Sedan 4D, $14,600: security score 7/10 now renders
    🛡️ LOW RISK + Safe To Proceed consistently.

### Session Testing — Vehicles (2018 Honda Accord LX Sedan 4D, $14,600, San Diego CA)
- Score: 7/10 ✅ BUY
- Recommended offer: $13,800
- Vehicle badge: ✅ present  
- Market: Vehicle warning + KBB / Carfax / CarGurus links ✅
- Amazon: absent ✅ (correct for vehicles)
- Affiliate cards: eBay + Autotrader ✅
- Dollar signs on all price rows: ✅ (v0.15.0 B-UI3 fix confirmed)
- Security: 🛡️ LOW RISK 7/10 Safe To Proceed ✅ (B-S5 fixed — was ⚠️ CAUTION + Safe To Proceed)
- Product Reputation: MIXED ✅
- No new bugs found

---

## v0.15.0 — Vehicle Price Display Fix (Mar 2026)

### Bugs Fixed
- **B-UI3 — Missing `# Deal Scout — Changelog

All notable changes to this project are documented here.
Format: `vX.Y.Z — Description (Date)`

---

 on all market comparison price rows** (`extension/content/fbm.js`)
  - Root cause: Template literal expressions in the market comparison section used `${expr}`
    (JavaScript interpolation only) instead of `${expr}` (literal `# Deal Scout — Changelog

All notable changes to this project are documented here.
Format: `vX.Y.Z — Description (Date)`

---

 + interpolation).
    All price values rendered as bare numbers: `Listed price 16800` instead of `Listed price $16,800`.
  - Fix: Added literal `# Deal Scout — Changelog

All notable changes to this project are documented here.
Format: `vX.Y.Z — Description (Date)`

---

 prefix to all five price row expressions in both the vehicle branch
    (listed price only) and the regular branch (sold avg, active avg, new retail, listed price).
  - Note: `${expr}` in a template literal = `# Deal Scout — Changelog

All notable changes to this project are documented here.
Format: `vX.Y.Z — Description (Date)`

---

 character + `${expr}` interpolation.

### Session Testing — Vehicles (2017 Toyota Tacoma Pickup, $16,800, Spring Valley CA)
- Score: 6/10 ⚠️ CAUTION
- Vehicle badge: ✅ present
- Dollar signs: ✅ now showing on all price rows

---

## v0.14.0 — Vehicle Session: 3 Bugs Fixed (Mar 2026)

### Bugs Fixed
- **B-V4 — Amazon affiliate card showing on vehicle listings** (`scoring/affiliate_router.py`, `api/main.py`)
  - Root cause (1): `"vehicles"` entry in `CATEGORY_PROGRAMS` still included `"amazon"`. The comment
    at the safety-net guard correctly said "don't add Amazon for vehicles", but that guard only blocked
    Amazon from being added as a *fallback* — it didn't prevent Amazon from being selected from the
    primary category program list.
  - Root cause (2): `detect_category()` text-matches `product_info` fields. A BMW 328i has no word
    "vehicle" in its title, so it fell through to `"general"`, which includes Amazon. The safety net
    `is_vehicle_cat` check only covered categories `"vehicles"`, `"cars"`, `"trucks"`, not `"general"`.
  - Fix (affiliate_router.py): removed `"amazon"` from `"vehicles"` `CATEGORY_PROGRAMS` entry.
  - Fix (api/main.py): compute `category_detected` before calling `get_affiliate_recommendations()`;
    override to `"vehicles"` when `listing.is_vehicle=True` and category wasn't already a vehicle
    category. Pass as `category_override` param so router uses it directly instead of re-running
    `detect_category()` internally.
  - Fix (affiliate_router.py): added `category_override` param to `get_affiliate_recommendations()`.

- **B-S3 — Security risk_level/recommendation contradicts final merged score** (`scoring/security_scorer.py`)
  - Root cause: `risk_level` and `recommendation` were taken directly from Claude AI response, but
    `final_score` is a weighted average of Layer1 (35%) + AI Layer2 (65%). AI might score 6/medium
    but L1 being clean pushes the merged final to 8. Result: sidebar showed "LOW RISK 8/10"
    + "Proceed With Caution" — contradictory and confusing.
  - Fix: Always derive `risk_level` and `recommendation` from `final_score` via `_score_to_risk()`
    and `_score_to_recommendation()`, discarding AI's label in favour of the merged numeric result.

- **B-S4 — "Salvage/rebuilt/flood damage" false positive from city name "Lemon Grove"** (`scoring/security_scorer.py`)
  - Root cause: Vehicle item risk pattern `(salvage|rebuilt|flood\s*damage|lemon)` — bare word
    `lemon` matched `"Lemon Grove, CA"` in the listing location, triggering a high-severity false
    positive on a clean-title car. Penalised the security score by 1-2 points.
  - Fix: Changed `lemon` → `lemon\s+law` in the vehicle risk pattern. The genuine risk signal is
    a seller invoking lemon law, not the word "lemon" in a location string.

### Session Testing — Vehicles (2011 BMW 3 Series 328i $6,999, Lemon Grove CA)
- Score: 7/10 ✅ BUY
- Recommended offer: $6,400
- Vehicle badge: ✅ present
- Market: KBB / Carfax / CarGurus links shown correctly ✅
- Amazon: absent ✅ (B-V4 fixed)
- Affiliate cards: eBay + Autotrader ✅
- Security: LOW RISK 8/10 Safe To Proceed ✅ (B-S3 + B-S4 fixed)
- False salvage flag: gone ✅

---

## v0.13.0 — Security Scorer Seller Date Fix (Mar 2026)

### Bugs Fixed
- **B-S1 — Security scorer always showing "unknown" seller join date** (`scoring/security_scorer.py`)
  - Root cause: `run_layer2()` used `getattr(listing, "seller_join_date", "unknown")` to get
    the seller's account age. But `ListingRequest` has no `seller_join_date` attribute — the
    data lives in `listing.seller_trust` (a dict) with key `member_since`. The getattr always
    fell back to `"unknown"`, so Claude AI was told every seller was brand new regardless of
    actual account age.
  - Impact: Claude AI scored all listings as higher risk due to "unknown seller". A seller with
    a Jan 2008 account was being flagged as "Vague seller information - joined date unknown",
    causing the security score to downgrade to HIGH RISK / "Likely Scam".
  - Fix: Extract `member_since` correctly from the seller_trust dict:
    ```python
    seller_trust_dict = (getattr(listing, "seller_trust", None) or {})
    seller_joined = seller_trust_dict.get("member_since", "unknown") or "unknown"
    ```
  - Before: iPhone 14 Plus (Jan 2008 seller) → HIGH RISK 6/10 "Likely Scam"
  - After:  iPhone 14 Plus (Jan 2008 seller) → CAUTION 7/10 "Proceed With Caution"

### Known Issues (not yet fixed)
- **B-S2 — AI flags old account age as suspicious** (`scoring/security_scorer.py`)
  - Claude AI occasionally generates a flag like "Seller account age (Jan 2008) inconsistent
    with recent activity pattern" — treating long account tenure as suspicious rather than
    trustworthy. Minor prompt tuning issue; low priority.

### Session Testing — Phones (iPhone 14 Plus 128GB $295, San Diego CA)
- Score: 7/10 ✅ BUY
- Recommended offer: $275
- Market: $232 below eBay sold avg ($482) — 44% discount
- Vehicle badge: absent ✅ (B-P2 from v0.12.0 confirmed)
- Security: CAUTION 7/10 ⚠️ (was incorrectly HIGH RISK before fix)
- Seller date: Jan 2008 correctly passed to security scorer ✅
- Affiliate cards: Amazon, eBay, Back Market ✅
- Product Reputation: GOOD (16 Reddit threads) ✅

---

## v0.12.0 — Electronics False Vehicle Detection Fix (Mar 2026)

### Bugs Fixed
- **B-P2 — MacBook Air / electronics falsely detected as vehicles** (`extension/content/fbm.js`)
  - Root cause: Strategy 2 of `detectVehicle()` fires when a 4-digit year AND a vehicle
    make name both appear in the listing text. Bare `ram` in `MAKES_RE` matched the word
    "RAM" in electronics specs (e.g. "8GB RAM"), and any modern laptop title with a year
    ("MacBook Air M1 2020") triggered the false positive.
  - How it broke: B-P1 (previous session) fixed bare `"ram "` in the Strategy 1 keyword
    list but missed the `ram` in the Strategy 2 `MAKES_RE` regex.
  - Fix: Removed `ram` from `MAKES_RE`. Dodge RAM trucks are already caught by
    `"ram 1500"` and `"ram 2500"` in Strategy 1 keywords, so no vehicle coverage is lost.
  - Verified against 8 test cases: MacBook, iPhone, Samsung, PS4, iPad, Dell XPS all
    correctly pass through; BMW 3 Series and Honda Civic still correctly detected.

### Session Testing — Electronics (MacBook Air M1 2020 8GB/512GB $450, San Diego CA)
- Score: 7/10 ✅ BUY
- Recommended offer: $420
- Market: $209 below eBay sold avg ($616) — genuine deal
- Vision: Correctly identified MacBook (no false positives)
- Security: brand-new seller flagged appropriately as caution, not a scam block
- Affiliate cards: Amazon, eBay, Back Market (certified refurb) ✅
- Vehicle badge: absent ✅ (bug fixed)

---

## v0.11.0 — Three-Tier Verdict System (Mar 2026)

### Bugs Fixed
- **B-UI2 — Score 6 incorrectly displayed as ❌ PASS** (`extension/content/fbm.js`)
  - Root cause: Verdict badge used binary `should_buy` boolean from Claude's response.
    `should_buy: false` rendered as `❌ PASS` in red, even for score 6 ("borderline/negotiate").
    This misled users into thinking mid-score listings were bad deals to avoid entirely.
  - Fix: Replaced binary BUY/PASS with a 3-tier score-based system:
    - Score ≥ 7 → `✅ BUY` (green `#22c55e`)
    - Score 4–6 → `⚠️ CAUTION` (amber `#f59e0b`)
    - Score ≤ 3 → `❌ AVOID` (red `#ef4444`)
  - Tested against Couch $400 (Escondido): score 6 now correctly shows `⚠️ CAUTION`.

### Session Testing — Furniture (Couch $400, Escondido CA)
- Score: 6/10 ⚠️ CAUTION
- Recommended offer: $320
- Vision: Correctly identified couch (no background-object false positives — B-V1 confirmed)
- Security: LOW RISK 9/10
- Affiliate cards: Amazon, eBay, Wayfair ✅

---

## v0.10.0 — Vision False-Positive Fix + Offer Display Fix (Mar 2026)

### Bugs Fixed
- **B-V1 (vision) — Vision false-positive on background objects** (`scoring/deal_scorer.py`)
  - Root cause: Claude Vision scored the PRIMARY listing subject based on whatever was
    most prominent in the photo, including background items. A couch listing with a
    bicycle visible in the background was scored as a bicycle — condition mismatch
    flagged because "bike condition doesn't match listing description."
  - Fix: Vision prompt now prepends the listing title and instructs Claude to
    "Focus ONLY on the PRIMARY SUBJECT of this photo (the item being sold)."
  - Prevents background objects from influencing condition scoring.

- **B-UI1 — Recommended offer shows $0 or blank on scam/not-recommended listings** (`scoring/deal_scorer.py`, `extension/content/fbm.js`)
  - Root cause (backend): When Claude returns `recommended_offer: 0` (its way of signaling
    "do not make an offer / don't buy"), the backend passed 0.0 to the UI which rendered
    as "$0" — confusing users who thought the item was free.
  - Fix (backend): Added sentinel: `float(raw_offer) == 0.0` → `safe_offer = -1.0`.
    The -1.0 value is a contract signal to the UI meaning "not recommended."
  - Root cause (UI): fbm.js was rendering the offer price inline in a template literal —
    impossible to add conditional logic without breaking the backtick syntax.
  - Fix (UI): Replaced inline template expression with empty `<span id="ds-tmp-offer"></span>`
    and set content via DOM after template renders:
    - `r.recommended_offer === -1` → `textContent = '🚫 Not recommended'`
    - otherwise → `textContent = '$' + Math.round(r.recommended_offer || 0)`

### Infrastructure
- **fbm.js file corruption repaired** — Previous session's edit_file calls caused
  massive file duplication (3705 lines, 4× duplicate functions). File reconstructed
  from first clean copy and B-UI1 fix reapplied correctly. File is now 2014 lines
  with all functions appearing exactly once.

---

## v0.9.0 — Phone False Vehicle Detection + Badge Fixes (Mar 2026)

### Bugs Fixed
- **B-P1 — `detectVehicle()` false-positives on phone/electronics listings** (`extension/content/fbm.js`)
  - Root cause 1: keyword `"pickup"` matched `"local pickup"` in virtually every FBM listing
    description — sellers almost always write "local pickup available" or "cash on pickup".
    Caused iPhone, electronics, and tool listings to be detected as vehicles.
  - Fix: Changed to `"pickup truck"` which requires the full phrase.
  - Root cause 2: keyword `"charger"` matched `"charger included"` / `"comes with charger"` in
    phone and electronics listings. Intended to catch Dodge Charger (car).
  - Fix: Changed to `"dodge charger"` to require the brand context.
  - Root cause 3: `"ram "` (with trailing space) in the makes list matched `"8GB RAM "` and
    `"RAM storage"` in electronics/phone descriptions. Dodge RAM models are already
    covered by `"ram 1500"` and `"ram 2500"` in the models section.
  - Fix: Removed `"ram "` from the makes list entirely.
  - Root cause 4: Year regex `'?[5-9]\d` used optional apostrophe, matching bare 2-digit numbers
    like `92` in `"92% battery health"`, `64` in `"64GB storage"`, `86` in any context.
    Together with MAKES_RE matching `"honda"` in a description mentioning a Honda brand,
    this incorrectly returned true.
  - Fix: Made apostrophe required for 2-digit years: `'[5-9]\d`. 4-digit years (1950-2029)
    are unambiguous and kept as-is. `"'98 Honda"` still works; `"92% battery"` does not.

- **B-E1 — VERSION constant stuck at "0.6.0"** (`extension/content/fbm.js`)
  - Version badge in the panel header showed `v0.6.0` despite multiple release cycles.
  - Fix: Updated `VERSION = "0.8.0"` (reflecting current codebase state including prior session fixes).

- **B-E2 — `"ebay_mock"` data source missing badge case** (`extension/content/fbm.js`)
  - Root cause: `dataColor`/`dataLabel` switch had no case for `"ebay_mock"`. Fell through
    to the amber `"⚠️ Est. prices"` fallback which has no visual distinction from an
    error state. `"ebay_mock"` means the real eBay API was unavailable and mock data
    was used — users should know this is estimated, but the amber warning was alarming.
  - Fix: Added explicit `"ebay_mock"` case → gray `#94a3b8` color + `"📊 Est. prices"` label.
    Gray communicates "limited data" without implying something went wrong.

---

## v0.8.0 — detectVehicle Car/Truck Detection + Badge Fixes (Mar 2026)

### Bugs Fixed
- **B-V3 — `detectVehicle()` misses cars, trucks, sedans** (`extension/content/fbm.js`)
  - Root cause: keyword list only covered motorcycles, ATVs, e-bikes. Titles like
    "2013 BMW 3 Series $6,300" had `is_vehicle=False`, sending it through eBay pricing
    which returns parts prices ($50-$300), triggering wrong buy_new banners and
    wrong affiliate cards (Amazon instead of Autotrader).
  - Fix 1: Added comprehensive make/model/body-type keyword list covering Toyota, Honda,
    Ford, Chevy, BMW, Dodge, Jeep, Nissan, Subaru, Hyundai, Kia, Mazda, Audi, Mercedes,
    Lexus, Tesla, plus common models (Camry, Civic, F-150, Silverado, Wrangler, etc.).
  - Fix 2: Added year+make regex pattern. Matches "2013 BMW", "2008 Ford F-150",
    "'98 Honda Civic" — year-first titles that keywords alone would miss.
  - Removed over-broad short keywords ("kx", "yz", "rm") that could false-positive
    on non-vehicle titles. Replaced with full model numbers ("kx250", "yz450", "rmz250").

- **B-D1/B-D2 — Data source badge shows wrong label/color for vehicles** (`extension/content/fbm.js`)
  - Root cause: `dataLabel` and `dataColor` had no case for `vehicle_not_applicable`.
    Vehicle listings showed amber "⚠️ Est. prices" badge instead of a vehicle indicator.
  - Fix: Added `vehicle_not_applicable` case — now shows amber "🚗 Vehicle" badge.
  - Also added `google+ebay` case (was falling through to "Est. prices").

- **B-G1 — `getCraigslistUrl()` maps San Diego to sfbay** (`extension/content/fbm.js`)
  - Root cause: typo in `cityMap`. `sandiego` was mapped to `"sfbay"` (San Francisco).
  - Fix: `sandiego` now correctly maps to `"sandiego"`.

---

## v0.7.0 — Vehicle Market Comp Fix + Buy-New Sanity Guard (Mar 2026)

### Bugs Fixed
- **B-V1 — "4172% of new" banner on vehicles** (`scoring/affiliate_router.py`, `api/main.py`)
  - Root cause: `should_trigger_buy_new()` had no upper-bound check. BMW listed at $6,300
    divided by eBay "new" price of $151 (parts, not a car) = ratio of 41.7x. The `>= 0.90`
    trigger fired because 41.7 is obviously ≥ 0.90. Showed absurd "4172% of new" banner.
  - Fix 1: Added `is_vehicle=True` guard — banner always suppressed for vehicles because
    eBay's `new_price` field reflects parts/accessories for vehicle searches, not the vehicle.
  - Fix 2: Added `ratio > 2.5` sanity check for all categories — if the listed price is
    more than 2.5× the "new" price, the new_price data is garbage; suppress banner.
  - `main.py` now passes `is_vehicle=listing.is_vehicle` to `should_trigger_buy_new()`.

- **B-V2 — eBay vehicle warning not rendering** (`extension/content/fbm.js`)
  - Root cause: Previous session's fix was only written as a diff in session notes, never
    saved to disk. File on disk had no vehicle warning at all.
  - Fix: Added inline warning to Market Comparison section when `listing.is_vehicle` is true:
    "⚠️ eBay prices shown are likely parts, not the vehicle. Use KBB or AutoTrader for real comps."
  - Also added `vehicle_not_applicable` data_source hook for future use when/if API is updated
    to skip eBay pricing for vehicles entirely (renders KBB/Carfax/CarGurus links instead).

- **B-G1 — `vehicle_details: null` Pydantic 422 error** (`extension/content/fbm.js`)
  - `vehicleDetails` returns `null` for non-vehicle listings; Pydantic requires a `dict`.
  - Fix: `vehicleDetails || {}` — null-coalesces to empty dict before sending to API.
  - Saved at end of previous session.

---

## v0.6.0 — Security Scoring + Category-Aware Thresholds (Mar 2026)

### Bugs Fixed
- **B1 — Security false positive on legit deep-discount listings** (`scoring/security_scorer.py`)
  - Category-aware price thresholds: bikes/tools/outdoor 15%, vehicles 40%, phones 30%, default 20%.

- **B2 — Price extracted as $0 on first injection, wastes API call** (`extension/content/fbm.js`)
  - Retry loop in `scoreListing()` — up to 3 retries × 800ms before aborting.

- **B3 — Vehicle DOM fields not extracted** (`extension/content/fbm.js`, `api/main.py`)
  - New `extractVehicleDetails()` — parses mileage, transmission, title_status, owners,
    paid_off, drivetrain from `span[dir=auto]` elements in "About this vehicle" section.
  - `ListingRequest` extended with `vehicle_details: dict = {}`.

- **B4 — eBay returns parts prices for vehicles** (`extension/content/fbm.js`)
  - Warning banner added to Market Comparison for vehicle listings.
  - Long-term fix requires KBB/CarGurus API integration (deferred).

- **B5 — Affiliate cards showing Amazon/Walmart for vehicles** (`scoring/affiliate_router.py`)
  - Amazon safety net skips vehicle categories.
  - Vehicle safety net always inserts Autotrader as first card.
  - `cards = cards[:max_cards]` trim added after insertions.

---

## v0.5.0 — Positioning Fix + CORS + Pricing Inversion (Mar 2026)
- ✅ **CORS fix** — FastAPI `allow_origins` changed to `["*"]`
- ✅ **Sidebar positioning fix** — `position:absolute` children of root anchor
- ✅ **Facebook transform fix** — root appended to `document.documentElement`
- ✅ **Drag now works**
- ✅ **Better error messages** — network failures show uvicorn start command
- ✅ **Pricing priority inversion** — Google Shopping primary, eBay fallback

---

## v0.4.0 — Extraction Fixes + Full Pipeline (Mar 2026)
- ✅ Price extraction fix — text node walk for current price
- ✅ Shipping cost extraction — passed to Claude as `shipping_cost`
- ✅ Seller rating extraction — reads aria-label star ratings
- ✅ Strikethrough original price detection
- ✅ CSP compliance — all handlers via `addEventListener`
- ✅ Claude Vision integration — condition mismatch detection
- ✅ Suggestion engine — 3 affiliate cards per score
- ✅ Pro gating — `isPro()` reads `ds_pro` from chrome.storage.local
- ✅ SPA navigation handler — debounced re-injection on pushState
- ✅ Search results overlay — score badges on FBM listing thumbnails

---

## v0.2.0 — Extension (Mar 2026)
- ✅ Chrome extension with FBM + Craigslist content scripts
- ✅ Full DOM extraction without data-testid
- ✅ Collapsible, draggable sidebar
- ✅ One-click message templates
- ✅ Price history tracking (chrome.storage.local)
- ✅ Search results overlay
- ✅ Seller trust scoring
- ✅ Popup: API health check, manual rescore, Open Full Scorer

---

## v0.1.0 — POC (Mar 2026)
- ✅ Playwright-based FBM scraper (URL, text, batch modes)
- ✅ eBay Finding API price comparison with mock fallback
- ✅ Claude API deal scoring with structured JSON output
- ✅ FastAPI backend wiring scraper → eBay → Claude
- ✅ Validated on real listings (Orion telescope, Gskyer telescope)

---

## v0.17.0 — Vehicle Pricing Fixed (Mar 2026)

### Root Cause Diagnosed & Fixed
- **B-V5** (Critical): `NotImplementedError` on Windows — Playwright `async_playwright` can't spawn
  subprocesses from uvicorn's `ProactorEventLoop`. Entire vehicle pricing silently failed.
- **Fix**: Replaced CarGurus Playwright scraper with direct `httpx` JSON API call.
  CarGurus' `searchResults.action` endpoint returns structured JSON — no browser needed.
  Craigslist fallback now uses `sync_playwright` inside `ThreadPoolExecutor` (own event loop).
- **B-V6**: Wrong year comps — CarGurus API returning 2001–2010 Accords when sorted by price ASC.
  Fixed by adding `startYear`/`endYear` params + client-side `carYear` filter (±2 years).
  Switched sort to `BEST_MATCH` to avoid scraping floor-priced junkers.
- **B-V7**: `Price range $0 – $0` in UI — `sold_low`, `sold_high`, `active_low` were missing
  from `DealScoreResponse` model and return statement. Added all three fields.

### Result: 2018 Honda Accord LX @ $14,600
- Before: score 2/10 ❌ AVOID — "$11,045 overpriced" (using 2001 Accord comps at $3,595)
- After: score 8/10 ✅ BUY — "$1,300 below market" (25 real 2018 Accord comps at $15,918 avg)

### Files Changed
- `scoring/vehicle_pricer.py` — full rewrite: httpx API + threaded sync Playwright fallback
- `api/main.py` — `DealScoreResponse` + return statement: added `sold_low/high`, `active_low`

---

## v0.18.0 — Vision Image Fix (Mar 2026)

### Bug Fixed: B-I1 — Vision analyzing wrong listing's photo
**Root cause:** `findListingImages()` in fbm.js filtered for CDN tier `t45.` which is used
for ad thumbnails and "similar listings" cards preloaded in the background DOM — NOT
the current listing's item photos. The listing's own photos use `t39.84726-6` CDN path.
This caused Vision to analyze a randomly-grabbed nearby listing photo instead of the
current listing, producing completely wrong mismatch flags.

**Example:** Kobalt Pull Saw $10 scored 2/10 AVOID because Vision saw "Kobalt 24V
impact wrench" from an adjacent preloaded listing, flagging a nonexistent mismatch.
Correct score should be 8-9/10 BUY ($136 eBay avg, 93% below market).

**Fix in fbm.js `findListingImages()`:**
- Changed CDN filter from `t45.` → `t39.84726` (actual item photo CDN path)
- Added `t45.84726` as secondary (future-proofing if FBM changes tier)
- Raised minimum size from 100px → 200px to skip thumbnails
- Added sort-by-width DESC so hero image is always `[0]` regardless of DOM order

### Files Changed
- `extension/content/fbm.js` — `findListingImages()` CDN tier filter + sort

---

## v0.19.9 — Fix B-PE4: $1 price extraction bug (Mar 2026)

### Bug Fixed: B-PE4 — findPrices() returns $1 instead of real listing price
**Root cause:** FBM now renders offer-count badges and star rating fragments as
`$1` spans at shallow DOM depth (< 8 levels) from the listing h1. The old
return-first logic grabbed `$1` before finding the real `$15`. This cascaded:
`listing.price = 1` → mock data seeds at `base = 150` → `$160/$185` comps displayed.

**Fix — three-strategy price extraction in `findPrices()`:**
1. **STRATEGY 0 (new):** `aria-label` exact match — FBM sets `aria-label="$15"`
   explicitly on price elements; never on badges or UI counts.
2. **STRATEGY 1:** Line-through dual-price container (unchanged, for price-reduced listings)
3. **STRATEGY 2 (rewritten):** Collect ALL `$X` candidates, filter out `< $2`,
   sort by shallowest depth then largest price. Old: return first match.
   New: collect all, pick best.

**Minimum price guard (`< $2`):** Legitimate FBM listings under $2 are extremely
rare. Any `$1` span is almost certainly a UI element, not a listing price.

**Side effect fixed:** `Filesystem:edit_file` corrupted fbm.js in the prior attempt
(file doubled to 184KB). This version is a clean rewrite from the uncorrupted source.

### Files Changed
- `extension/content/fbm.js` — v0.19.9 (findPrices rewrite, parity CSS included)

---

## v0.19.8 — Full pipeline audit: query poisoning, threshold misalignment, debug tooling (Mar 2026)

### Root Cause Analysis
v0.19.7 fixed `ebay_pricer.build_search_query()` noise_words but the change had no effect
because the query arrives via `product_extractor.extract_product()` which uses Haiku.
Haiku was generating `search_query="boys pants bundle lot"` from the listing description
("selling as a bundle"), and that query was passing through `build_search_query()` before
the noise_words fix applied. But:
- The server had not restarted to pick up the file drop (uvicorn --reload unreliable on Windows)
- `product_extractor._NOISE_WORDS` didn't include bundle/lot/pack (fallback path also polluted)
- Haiku prompt had no instruction to exclude bundle/lot from search_query
- `should_trigger_buy_new` threshold (75%) was misaligned with frontend parity (65%)
- `price_hint` guard (`<= 5x`) was too aggressive, suppressing hints on valid comps

### Fixes

**`scoring/product_extractor.py`**
- Added bundle/lot/pack to `_NOISE_WORDS` (fallback path parity with ebay_pricer)
- Added explicit CRITICAL rule to Haiku prompt: never include bundle/lot/pack/set/pcs
  in search_query; use `[gender] [item] [size]` pattern for clothing without brand

**`scoring/affiliate_router.py`**
- `should_trigger_buy_new`: lowered threshold from 75% to 65% to match frontend
  `isDealParity` threshold. Eliminates dead zone where frontend showed parity UI
  but backend returned `buy_new_trigger=False`.
- New message in 65-90% band: `"💡 Only $X more to buy new — may be worth it for warranty + returns"`
- `price_hint` sanity guard: changed from `<= 5x` to two-sided `0.5x – 15x`.
  5x was too aggressive (suppressed guitar $80 used vs $600 new = 7.5x).
  15x catches real garbage comp data.

**`api/main.py`**
- Added `GET /debug/query` endpoint: shows full query chain (Haiku output →
  build_search_query output) with a warning flag if bundle/lot still present.
  Use: `http://localhost:8000/debug/query?title=Kids+pants&description=bundle+of+3`

### Restart Required
uvicorn `--reload` does not reliably detect file-drop writes on Windows.
**Always restart the server manually after dropping in backend files.**

### Files Changed
- `scoring/product_extractor.py`
- `scoring/affiliate_router.py`
- `api/main.py`

---

## v0.19.7 — Fix market comps + affiliate card copy for clothing/bundle listings (Mar 2026)

### Bug Fixed: B-MC1 — eBay query returns adult clothing comps for kids bundle listings
**Root cause:** `build_search_query()` stripped adjectives like "used" but NOT bundle qualifiers
("bundle", "lot", "pack"). Query "boys pants bundle lot" hit eBay and returned adult name-brand
pants lots (Wrangler, Levi's) at $148-$173 avg. `new_price` came back as $155 for a $15
kids shorts bundle. This cascaded into: wrong market comparison, wrong -90% discount signal,
and parity banner never firing (ratio 15/155 = 9.7%, far below 0.65 threshold).

**Fix:** Added to `noise_words` in `build_search_query()`:
```python
"bundle", "lot", "lots", "pack", "pcs", "pieces", "set", "sets", "items", "listing", "collection"
```
Query now becomes "boys pants" → returns kids shorts at $8-12 each → correct new_price ~$20
→ parity ratio 15/20 = 75% → parity trigger fires → correct affiliate card copy shown.

### Improvement: Affiliate card copy — cleaner titles, smarter reason text
**Problem:** Cards showed raw eBay query in title ("boys pants used bundle lot — New at Amazon")
and generic reason copy ("New retail reference · compare before deciding") with no value signal.

**Changes in `_build_card()`:**
- Title: `"Shop new on {store}"` instead of `"{raw query} — New at {store}"`
- Reason: Context-aware dollar gap copy when `new_price` is available:
  - `new_price - listing_price <= $20` → `"Only $X more to buy new with full warranty"`
  - `new_price > $20 gap` → `"New from ~$Y · Z% savings used"`
  - Bad deal + new_retail card → `"Listing is $X used — verify new retail price first"`
- `price_hint`: populated as `"From ~$Y"` when `new_price` is plausible (within 5× listing price)

**Wire-up:** `get_affiliate_recommendations()` now extracts `mv_new_price` from `market_value`
and passes it through to all three `_build_card()` call sites.

### Files Changed
- `scoring/ebay_pricer.py` — `build_search_query()` noise_words updated
- `scoring/affiliate_router.py` — `_build_card()` titles, reasons, price_hint, new_price wired

---

## v0.19.6 — findListingImages: three-path gallery scoping (Mar 2026)

### Bug Fixed: B-I2b — Vision analyzing unrelated listing photo on direct URL navigation
**Root cause:** B-I2 (v0.19.4) fixed image scoping for the search overlay path by checking for
`[role="dialog"]`. But on direct URL navigation, no dialog exists, so `_imgRoot` fell back to
`document`. With `document` scope and 14+ candidate images, the sort-by-width descending logic
selected a 960px-wide "2013 BMW x5" sidebar thumbnail over the 444px-wide kids pants hero
image. Vision described a vehicle and scored the listing 1/10 AVOID with fraud flags.

**Fix: Three-path image scoping strategy in `findListingImages()`**

- **PATH A (search overlay):** Listing dialog found via h1 content check (existing B-I2 fix).
  Tight container, no sidebar pollution.

- **PATH B (direct URL):** No dialog. Walk UP the DOM from the listing h1 to find the first
  ancestor containing 1-8 t39 images. The listing photo carousel has 1-5 photos; any ancestor
  with more images is a page-level container shared with sidebars. Stops at the carousel root.

- **PATH C (document fallback):** If gallery container not found, use `document` + alt-text
  relevance filter. Images whose alt text is non-empty and shares no words (>3 chars) with the
  listing title are skipped as belonging to different listings.

### Files Changed
- `extension/content/fbm.js` — `findListingImages()` three-path scoping, VERSION 0.19.6
- `extension/manifest.json` — version 0.19.6

---

## v0.19.5 — Deal Parity Mode: promote Where to Buy when new price is close (Mar 2026)

### Feature: Deal Parity Mode
**Problem:** When FBM listed price is close to new retail (e.g. $15 used vs $22 new), the current
UI buries the affiliate cards at the bottom. Users don't see that buying new is a meaningful
alternative, and we miss affiliate revenue on listings that aren't compelling deals.

**Trigger threshold:** `listed_price >= new_retail * 0.65`
At 65%+ of new retail, the used savings are marginal enough to surface new as a real option.
Example: $15 / $22 = 68% → triggers parity mode. $80 / $200 = 40% → does NOT trigger.

**Visual changes when parity mode is active:**
- `ds-section-parity` class added: indigo accent border + subtle background tint
- `ds-parity-banner` injected at top of section:
  - Title: *"Only $X more to buy new"* (concrete dollar delta)
  - Subtitle: *"New retail ~$Y · Compare before buying used"*
- Amazon card title changed to **"Shop new on Amazon"** (was "Search on Amazon")
- Amazon card subtitle: `"New from ~$Y · Free returns on most items"`
- Amazon card reason: `"Only $X more than the used asking price"`

**Normal mode (not parity):** Unchanged — no banner, standard card copy.

**Revenue logic:** Parity mode directs users to Amazon/eBay when used savings don\'t
justify the condition risk. This is the highest-intent affiliate click scenario — user
was ready to spend, we\'re just redirecting to the new purchase channel.

### Open Bug Filed: B-MC1 — eBay comp query returns wrong category results
**Observed:** Kids pants bundle (3x size 12 boys shorts for $15) returned eBay sold avg of $148.
eBay query likely matches name-brand adult pants/jeans, not used kids bundle lots.
Result: AI scored it 8/10 (90% below market) when true savings vs new retail ($22) was ~32%.
**Status:** OPEN — requires backend ebay_pricer.py category-aware query improvement.

### Files Changed
- `extension/content/fbm.js` — Deal Parity Mode in `renderAffiliateCards()`, VERSION 0.19.5
- `extension/manifest.json` — version 0.19.5

---

## v0.19.4 — Vehicle false positive + Vision wrong image (Mar 2026)

### Bug Fixed: B-V2 — Ambiguous model names in flat keyword list causing false vehicle detection
**Root cause:** `detectVehicle()` Strategy 1 keyword list contained standalone model names that are
also common English words, product names, or place names: `"legacy"`, `"charger"`, `"escape"`,
`"compass"`, `"explorer"`, `"frontier"`, `"pathfinder"`, `"outback"`, `"malibu"`.
`"Nike Court Legacy NN"` matched `"legacy"` → full vehicle UI rendered (KBB/Carfax/CarGurus),
no eBay comps, `🚗 No data` badge, wrong recommended offer logic.

**Fix:** Removed all ambiguous model-only keywords from the flat list. Each corresponding make
(`subaru`, `ford`, `jeep`, `nissan`, `chevy`, `dodge`) is already in the keyword list, so these
models are redundant — `"Subaru Legacy"` still triggers on `"subaru"`, `"Ford Escape"` on `"ford"`.
Standalone `"legacy"` / `"charger"` / etc. no longer trigger vehicle detection alone.

**Removed from flat list:** `"explorer"`, `"escape"`, `"malibu"`, `"pathfinder"`, `"frontier"`,
`"outback"`, `"legacy"`, `"compass"`, `"charger"`

### Bug Fixed: B-I2 — Vision analyzing wrong listing photo (search result card contamination)
**Root cause:** `findListingImages()` queried `document` globally and filtered by CDN tier
(`t39.84726`). This worked on direct URL navigation. But when a listing is opened as an
overlay on the search results page, the background search result cards' photos **also** use
`t39.84726` URLs. A nearby listing (`"Lot of 30+ Shoes"`) had a larger rendered image than
the Nike sneaker overlay, so it sorted first and Vision analyzed the wrong item entirely.
Vision described `"8 different shoes including New Balance, Reebok, slippers"` for a brand
new single Nike sneaker listing — fabricating completely wrong condition and content.

**Fix:** Scope `findListingImages()` to the listing dialog container, same pattern as
`findTitle()` and `findPrices()`. When viewing from search overlay, only images inside the
listing dialog are returned, completely excluding background card images.

```javascript
const _imgRoot = [...document.querySelectorAll('[role="dialog"]')].find(
  dlg => [...dlg.querySelectorAll('h1')].some(
    h => !_IMG_NOISE.has(h.textContent.trim().toLowerCase()) && h.textContent.trim().length > 2
  )
) || document;
```

### Files Changed
- `extension/content/fbm.js` — B-V2 keyword pruning + B-I2 image scoping, VERSION 0.19.4
- `extension/manifest.json` — version 0.19.4

---

## v0.19.3 — Price/title extraction fails when Notifications dialog is open (Mar 2026)

### Bug Fixed: B-PE3 — Wrong `[role="dialog"]` scoped for price + title extraction
**Root cause:** `findTitle()` and `findPrices()` both scope to `document.querySelector('[role="dialog"]')` 
when present, intending to isolate listing overlay content from the search results page beneath it.
However FBM uses `role="dialog"` for **multiple panels** — including the Notifications panel,
which is always present with `h1="Notifications"` and zero price spans inside it.
When clicking a listing from search results, `querySelector` returns the Notifications dialog 
(first in DOM order), not the listing overlay. Both functions then search inside the wrong
container and find nothing, so `price=0` and `title` falls back to `document.title`.
This caused every listing opened from search results to fail extraction through all 8 retries.

**Fix:** Replace `querySelector('[role="dialog"]')` with a targeted search across **all** dialogs,
selecting only the one that contains a non-noise h1 (i.e. a real listing title):
```javascript
const _listingDialog = [...document.querySelectorAll('[role="dialog"]')].find(
  dlg => [...dlg.querySelectorAll('h1')].some(
    h => !NOISE.has(h.textContent.trim().toLowerCase()) && h.textContent.trim().length > 2
  )
);
const _docRoot = _listingDialog || document;
```
The Notifications dialog only has `h1="Notifications"` (in NOISE set) so it is skipped.
The listing overlay dialog has the actual item title h1 so it is selected correctly.
Falls back to `document` when no listing dialog exists (direct URL navigation).

**Applied to:** `findTitle()` and `findPrices()` — both used the same broken pattern.

### Files Changed
- `extension/content/fbm.js` — dialog scoping fix in `findTitle()` + `findPrices()`, VERSION 0.19.3
- `extension/manifest.json` — version 0.19.3

---

## v0.19.2 — Price extraction wrong/missing on slow-loading listings (Mar 2026)

### Bugs Fixed: B-PE2a + B-PE2b

**B-PE2a — Retry window too short (2.4s), FBM hydration takes 4-6s**
- Increased retries: 3 × 800ms → 8 × 800ms (6.4s window)
- Added **title readiness check**: retries now gate on BOTH `price > 0`
  AND `listing.title` being a non-noise value. If the title is still
  "Marketplace" or empty, the DOM isn't hydrated yet and any price found
  risks being from a sidebar card, not the listing.
- Added per-retry debug log showing price and title state.

**B-PE2b — "Today's picks" sidebar price contamination**
- Root cause: At depth 15-20, the ancestor walk reaches page-root-level
  containers that include "Today's picks" cards. If the listing's real price
  span isn't rendered yet, the walk finds `$20` or `$50` from a nearby card.
  This caused the 4 new tires listing ($350) to score with a `$20` listed
  price → bogus 9/10 BUY instead of correct valuation.
- Fix: **Contamination guard** in `findPrices()` ancestor walk. When a price
  is found at depth ≥ 8 (deep enough to be near page root), verify the listing
  title text exists somewhere in that ancestor's subtree. If it doesn't, the
  price is from an unrelated section — skip it. At depth < 8 we trust the
  price immediately (too close to the h1 to be contaminated).

### Files Changed
- `extension/content/fbm.js` — retry loop + contamination guard + VERSION 0.19.2
- `extension/manifest.json` — version 0.19.2

---

## v0.19.1 — Price extraction fails on "$1 · In stock" listings (Mar 2026)

### Bug Fixed: B-PE1 — Price always 0 for listings with " · In stock" suffix
**Affected:** Any listing where FBM renders the price span as `$X · In stock` or
`$X · Sold` rather than a bare `$X`. Common on sports cards, low-price items,
and "In stock" multi-quantity seller listings.

**Root cause:** The `findPrices()` fallback used `/^\$[\d,]+$/` (strict end anchor)
to match price spans. FBM appends ` · In stock` to the same text node, so
`"$1 · In stock"` fails the `# Deal Scout — Changelog

All notable changes to this project are documented here.
Format: `vX.Y.Z — Description (Date)`

---

## v0.16.0 — Vehicle Market Pricing + Security Threshold Fix (Mar 2026)

### New Features
- **Vehicle market pricing via CarGurus + Craigslist** (`scoring/vehicle_pricer.py`)
  - New module: `vehicle_pricer.py` — scrapes CarGurus for real comparable listings near user's zip
  - Fallback chain: CarGurus → Craigslist (local private-party comps)
  - Title parser handles "2018 Honda Accord LX", "2011 BMW 3 Series 328i", apostrophe years
  - Returns median market value, price range (low/high), confidence level, and comp count
  - 10-minute in-memory cache to avoid redundant scrapes
  - `ebay_pricer.py` updated: vehicles now route to `vehicle_pricer` instead of returning stub
  - `fbm.js` updated: new `cargurus`/`craigslist` badge colors + 3-branch market comparison block
    - `vehicle_not_applicable`: warning + KBB/Carfax/CarGurus links (fallback when scrape fails)
    - `cargurus`/`craigslist`: Market avg, price range, diff, confidence, comp count + KBB/Carfax links
    - Default (eBay): unchanged

### Bugs Fixed
- **B-S5 — Security risk label contradicts recommendation at score 7** (`scoring/security_scorer.py`)
  - Root cause: `_score_to_risk()` threshold for `"low"` was `score >= 8`, but
    `_score_to_recommendation()` returns `"safe to proceed"` at `score >= 7`. A score of 7
    therefore produced `"medium"` risk level (rendered as ⚠️ CAUTION in the UI) alongside
    `"Safe To Proceed"` — a direct contradiction that would confuse users into thinking the
    deal is both cautionary and safe simultaneously.
  - Fix: Lowered `_score_to_risk()` threshold so `score >= 7` → `"low"` (🛡️ LOW RISK), matching
    the recommendation. Adjusted remaining thresholds: `4-6` → `"medium"`, `2-3` → `"high"`,
    `1` → `"critical"`.
  - Verified on 2018 Honda Accord LX Sedan 4D, $14,600: security score 7/10 now renders
    🛡️ LOW RISK + Safe To Proceed consistently.

### Session Testing — Vehicles (2018 Honda Accord LX Sedan 4D, $14,600, San Diego CA)
- Score: 7/10 ✅ BUY
- Recommended offer: $13,800
- Vehicle badge: ✅ present  
- Market: Vehicle warning + KBB / Carfax / CarGurus links ✅
- Amazon: absent ✅ (correct for vehicles)
- Affiliate cards: eBay + Autotrader ✅
- Dollar signs on all price rows: ✅ (v0.15.0 B-UI3 fix confirmed)
- Security: 🛡️ LOW RISK 7/10 Safe To Proceed ✅ (B-S5 fixed — was ⚠️ CAUTION + Safe To Proceed)
- Product Reputation: MIXED ✅
- No new bugs found

---

## v0.15.0 — Vehicle Price Display Fix (Mar 2026)

### Bugs Fixed
- **B-UI3 — Missing `# Deal Scout — Changelog

All notable changes to this project are documented here.
Format: `vX.Y.Z — Description (Date)`

---

 on all market comparison price rows** (`extension/content/fbm.js`)
  - Root cause: Template literal expressions in the market comparison section used `${expr}`
    (JavaScript interpolation only) instead of `${expr}` (literal `# Deal Scout — Changelog

All notable changes to this project are documented here.
Format: `vX.Y.Z — Description (Date)`

---

 + interpolation).
    All price values rendered as bare numbers: `Listed price 16800` instead of `Listed price $16,800`.
  - Fix: Added literal `# Deal Scout — Changelog

All notable changes to this project are documented here.
Format: `vX.Y.Z — Description (Date)`

---

 prefix to all five price row expressions in both the vehicle branch
    (listed price only) and the regular branch (sold avg, active avg, new retail, listed price).
  - Note: `${expr}` in a template literal = `# Deal Scout — Changelog

All notable changes to this project are documented here.
Format: `vX.Y.Z — Description (Date)`

---

 character + `${expr}` interpolation.

### Session Testing — Vehicles (2017 Toyota Tacoma Pickup, $16,800, Spring Valley CA)
- Score: 6/10 ⚠️ CAUTION
- Vehicle badge: ✅ present
- Dollar signs: ✅ now showing on all price rows

---

## v0.14.0 — Vehicle Session: 3 Bugs Fixed (Mar 2026)

### Bugs Fixed
- **B-V4 — Amazon affiliate card showing on vehicle listings** (`scoring/affiliate_router.py`, `api/main.py`)
  - Root cause (1): `"vehicles"` entry in `CATEGORY_PROGRAMS` still included `"amazon"`. The comment
    at the safety-net guard correctly said "don't add Amazon for vehicles", but that guard only blocked
    Amazon from being added as a *fallback* — it didn't prevent Amazon from being selected from the
    primary category program list.
  - Root cause (2): `detect_category()` text-matches `product_info` fields. A BMW 328i has no word
    "vehicle" in its title, so it fell through to `"general"`, which includes Amazon. The safety net
    `is_vehicle_cat` check only covered categories `"vehicles"`, `"cars"`, `"trucks"`, not `"general"`.
  - Fix (affiliate_router.py): removed `"amazon"` from `"vehicles"` `CATEGORY_PROGRAMS` entry.
  - Fix (api/main.py): compute `category_detected` before calling `get_affiliate_recommendations()`;
    override to `"vehicles"` when `listing.is_vehicle=True` and category wasn't already a vehicle
    category. Pass as `category_override` param so router uses it directly instead of re-running
    `detect_category()` internally.
  - Fix (affiliate_router.py): added `category_override` param to `get_affiliate_recommendations()`.

- **B-S3 — Security risk_level/recommendation contradicts final merged score** (`scoring/security_scorer.py`)
  - Root cause: `risk_level` and `recommendation` were taken directly from Claude AI response, but
    `final_score` is a weighted average of Layer1 (35%) + AI Layer2 (65%). AI might score 6/medium
    but L1 being clean pushes the merged final to 8. Result: sidebar showed "LOW RISK 8/10"
    + "Proceed With Caution" — contradictory and confusing.
  - Fix: Always derive `risk_level` and `recommendation` from `final_score` via `_score_to_risk()`
    and `_score_to_recommendation()`, discarding AI's label in favour of the merged numeric result.

- **B-S4 — "Salvage/rebuilt/flood damage" false positive from city name "Lemon Grove"** (`scoring/security_scorer.py`)
  - Root cause: Vehicle item risk pattern `(salvage|rebuilt|flood\s*damage|lemon)` — bare word
    `lemon` matched `"Lemon Grove, CA"` in the listing location, triggering a high-severity false
    positive on a clean-title car. Penalised the security score by 1-2 points.
  - Fix: Changed `lemon` → `lemon\s+law` in the vehicle risk pattern. The genuine risk signal is
    a seller invoking lemon law, not the word "lemon" in a location string.

### Session Testing — Vehicles (2011 BMW 3 Series 328i $6,999, Lemon Grove CA)
- Score: 7/10 ✅ BUY
- Recommended offer: $6,400
- Vehicle badge: ✅ present
- Market: KBB / Carfax / CarGurus links shown correctly ✅
- Amazon: absent ✅ (B-V4 fixed)
- Affiliate cards: eBay + Autotrader ✅
- Security: LOW RISK 8/10 Safe To Proceed ✅ (B-S3 + B-S4 fixed)
- False salvage flag: gone ✅

---

## v0.13.0 — Security Scorer Seller Date Fix (Mar 2026)

### Bugs Fixed
- **B-S1 — Security scorer always showing "unknown" seller join date** (`scoring/security_scorer.py`)
  - Root cause: `run_layer2()` used `getattr(listing, "seller_join_date", "unknown")` to get
    the seller's account age. But `ListingRequest` has no `seller_join_date` attribute — the
    data lives in `listing.seller_trust` (a dict) with key `member_since`. The getattr always
    fell back to `"unknown"`, so Claude AI was told every seller was brand new regardless of
    actual account age.
  - Impact: Claude AI scored all listings as higher risk due to "unknown seller". A seller with
    a Jan 2008 account was being flagged as "Vague seller information - joined date unknown",
    causing the security score to downgrade to HIGH RISK / "Likely Scam".
  - Fix: Extract `member_since` correctly from the seller_trust dict:
    ```python
    seller_trust_dict = (getattr(listing, "seller_trust", None) or {})
    seller_joined = seller_trust_dict.get("member_since", "unknown") or "unknown"
    ```
  - Before: iPhone 14 Plus (Jan 2008 seller) → HIGH RISK 6/10 "Likely Scam"
  - After:  iPhone 14 Plus (Jan 2008 seller) → CAUTION 7/10 "Proceed With Caution"

### Known Issues (not yet fixed)
- **B-S2 — AI flags old account age as suspicious** (`scoring/security_scorer.py`)
  - Claude AI occasionally generates a flag like "Seller account age (Jan 2008) inconsistent
    with recent activity pattern" — treating long account tenure as suspicious rather than
    trustworthy. Minor prompt tuning issue; low priority.

### Session Testing — Phones (iPhone 14 Plus 128GB $295, San Diego CA)
- Score: 7/10 ✅ BUY
- Recommended offer: $275
- Market: $232 below eBay sold avg ($482) — 44% discount
- Vehicle badge: absent ✅ (B-P2 from v0.12.0 confirmed)
- Security: CAUTION 7/10 ⚠️ (was incorrectly HIGH RISK before fix)
- Seller date: Jan 2008 correctly passed to security scorer ✅
- Affiliate cards: Amazon, eBay, Back Market ✅
- Product Reputation: GOOD (16 Reddit threads) ✅

---

## v0.12.0 — Electronics False Vehicle Detection Fix (Mar 2026)

### Bugs Fixed
- **B-P2 — MacBook Air / electronics falsely detected as vehicles** (`extension/content/fbm.js`)
  - Root cause: Strategy 2 of `detectVehicle()` fires when a 4-digit year AND a vehicle
    make name both appear in the listing text. Bare `ram` in `MAKES_RE` matched the word
    "RAM" in electronics specs (e.g. "8GB RAM"), and any modern laptop title with a year
    ("MacBook Air M1 2020") triggered the false positive.
  - How it broke: B-P1 (previous session) fixed bare `"ram "` in the Strategy 1 keyword
    list but missed the `ram` in the Strategy 2 `MAKES_RE` regex.
  - Fix: Removed `ram` from `MAKES_RE`. Dodge RAM trucks are already caught by
    `"ram 1500"` and `"ram 2500"` in Strategy 1 keywords, so no vehicle coverage is lost.
  - Verified against 8 test cases: MacBook, iPhone, Samsung, PS4, iPad, Dell XPS all
    correctly pass through; BMW 3 Series and Honda Civic still correctly detected.

### Session Testing — Electronics (MacBook Air M1 2020 8GB/512GB $450, San Diego CA)
- Score: 7/10 ✅ BUY
- Recommended offer: $420
- Market: $209 below eBay sold avg ($616) — genuine deal
- Vision: Correctly identified MacBook (no false positives)
- Security: brand-new seller flagged appropriately as caution, not a scam block
- Affiliate cards: Amazon, eBay, Back Market (certified refurb) ✅
- Vehicle badge: absent ✅ (bug fixed)

---

## v0.11.0 — Three-Tier Verdict System (Mar 2026)

### Bugs Fixed
- **B-UI2 — Score 6 incorrectly displayed as ❌ PASS** (`extension/content/fbm.js`)
  - Root cause: Verdict badge used binary `should_buy` boolean from Claude's response.
    `should_buy: false` rendered as `❌ PASS` in red, even for score 6 ("borderline/negotiate").
    This misled users into thinking mid-score listings were bad deals to avoid entirely.
  - Fix: Replaced binary BUY/PASS with a 3-tier score-based system:
    - Score ≥ 7 → `✅ BUY` (green `#22c55e`)
    - Score 4–6 → `⚠️ CAUTION` (amber `#f59e0b`)
    - Score ≤ 3 → `❌ AVOID` (red `#ef4444`)
  - Tested against Couch $400 (Escondido): score 6 now correctly shows `⚠️ CAUTION`.

### Session Testing — Furniture (Couch $400, Escondido CA)
- Score: 6/10 ⚠️ CAUTION
- Recommended offer: $320
- Vision: Correctly identified couch (no background-object false positives — B-V1 confirmed)
- Security: LOW RISK 9/10
- Affiliate cards: Amazon, eBay, Wayfair ✅

---

## v0.10.0 — Vision False-Positive Fix + Offer Display Fix (Mar 2026)

### Bugs Fixed
- **B-V1 (vision) — Vision false-positive on background objects** (`scoring/deal_scorer.py`)
  - Root cause: Claude Vision scored the PRIMARY listing subject based on whatever was
    most prominent in the photo, including background items. A couch listing with a
    bicycle visible in the background was scored as a bicycle — condition mismatch
    flagged because "bike condition doesn't match listing description."
  - Fix: Vision prompt now prepends the listing title and instructs Claude to
    "Focus ONLY on the PRIMARY SUBJECT of this photo (the item being sold)."
  - Prevents background objects from influencing condition scoring.

- **B-UI1 — Recommended offer shows $0 or blank on scam/not-recommended listings** (`scoring/deal_scorer.py`, `extension/content/fbm.js`)
  - Root cause (backend): When Claude returns `recommended_offer: 0` (its way of signaling
    "do not make an offer / don't buy"), the backend passed 0.0 to the UI which rendered
    as "$0" — confusing users who thought the item was free.
  - Fix (backend): Added sentinel: `float(raw_offer) == 0.0` → `safe_offer = -1.0`.
    The -1.0 value is a contract signal to the UI meaning "not recommended."
  - Root cause (UI): fbm.js was rendering the offer price inline in a template literal —
    impossible to add conditional logic without breaking the backtick syntax.
  - Fix (UI): Replaced inline template expression with empty `<span id="ds-tmp-offer"></span>`
    and set content via DOM after template renders:
    - `r.recommended_offer === -1` → `textContent = '🚫 Not recommended'`
    - otherwise → `textContent = '$' + Math.round(r.recommended_offer || 0)`

### Infrastructure
- **fbm.js file corruption repaired** — Previous session's edit_file calls caused
  massive file duplication (3705 lines, 4× duplicate functions). File reconstructed
  from first clean copy and B-UI1 fix reapplied correctly. File is now 2014 lines
  with all functions appearing exactly once.

---

## v0.9.0 — Phone False Vehicle Detection + Badge Fixes (Mar 2026)

### Bugs Fixed
- **B-P1 — `detectVehicle()` false-positives on phone/electronics listings** (`extension/content/fbm.js`)
  - Root cause 1: keyword `"pickup"` matched `"local pickup"` in virtually every FBM listing
    description — sellers almost always write "local pickup available" or "cash on pickup".
    Caused iPhone, electronics, and tool listings to be detected as vehicles.
  - Fix: Changed to `"pickup truck"` which requires the full phrase.
  - Root cause 2: keyword `"charger"` matched `"charger included"` / `"comes with charger"` in
    phone and electronics listings. Intended to catch Dodge Charger (car).
  - Fix: Changed to `"dodge charger"` to require the brand context.
  - Root cause 3: `"ram "` (with trailing space) in the makes list matched `"8GB RAM "` and
    `"RAM storage"` in electronics/phone descriptions. Dodge RAM models are already
    covered by `"ram 1500"` and `"ram 2500"` in the models section.
  - Fix: Removed `"ram "` from the makes list entirely.
  - Root cause 4: Year regex `'?[5-9]\d` used optional apostrophe, matching bare 2-digit numbers
    like `92` in `"92% battery health"`, `64` in `"64GB storage"`, `86` in any context.
    Together with MAKES_RE matching `"honda"` in a description mentioning a Honda brand,
    this incorrectly returned true.
  - Fix: Made apostrophe required for 2-digit years: `'[5-9]\d`. 4-digit years (1950-2029)
    are unambiguous and kept as-is. `"'98 Honda"` still works; `"92% battery"` does not.

- **B-E1 — VERSION constant stuck at "0.6.0"** (`extension/content/fbm.js`)
  - Version badge in the panel header showed `v0.6.0` despite multiple release cycles.
  - Fix: Updated `VERSION = "0.8.0"` (reflecting current codebase state including prior session fixes).

- **B-E2 — `"ebay_mock"` data source missing badge case** (`extension/content/fbm.js`)
  - Root cause: `dataColor`/`dataLabel` switch had no case for `"ebay_mock"`. Fell through
    to the amber `"⚠️ Est. prices"` fallback which has no visual distinction from an
    error state. `"ebay_mock"` means the real eBay API was unavailable and mock data
    was used — users should know this is estimated, but the amber warning was alarming.
  - Fix: Added explicit `"ebay_mock"` case → gray `#94a3b8` color + `"📊 Est. prices"` label.
    Gray communicates "limited data" without implying something went wrong.

---

## v0.8.0 — detectVehicle Car/Truck Detection + Badge Fixes (Mar 2026)

### Bugs Fixed
- **B-V3 — `detectVehicle()` misses cars, trucks, sedans** (`extension/content/fbm.js`)
  - Root cause: keyword list only covered motorcycles, ATVs, e-bikes. Titles like
    "2013 BMW 3 Series $6,300" had `is_vehicle=False`, sending it through eBay pricing
    which returns parts prices ($50-$300), triggering wrong buy_new banners and
    wrong affiliate cards (Amazon instead of Autotrader).
  - Fix 1: Added comprehensive make/model/body-type keyword list covering Toyota, Honda,
    Ford, Chevy, BMW, Dodge, Jeep, Nissan, Subaru, Hyundai, Kia, Mazda, Audi, Mercedes,
    Lexus, Tesla, plus common models (Camry, Civic, F-150, Silverado, Wrangler, etc.).
  - Fix 2: Added year+make regex pattern. Matches "2013 BMW", "2008 Ford F-150",
    "'98 Honda Civic" — year-first titles that keywords alone would miss.
  - Removed over-broad short keywords ("kx", "yz", "rm") that could false-positive
    on non-vehicle titles. Replaced with full model numbers ("kx250", "yz450", "rmz250").

- **B-D1/B-D2 — Data source badge shows wrong label/color for vehicles** (`extension/content/fbm.js`)
  - Root cause: `dataLabel` and `dataColor` had no case for `vehicle_not_applicable`.
    Vehicle listings showed amber "⚠️ Est. prices" badge instead of a vehicle indicator.
  - Fix: Added `vehicle_not_applicable` case — now shows amber "🚗 Vehicle" badge.
  - Also added `google+ebay` case (was falling through to "Est. prices").

- **B-G1 — `getCraigslistUrl()` maps San Diego to sfbay** (`extension/content/fbm.js`)
  - Root cause: typo in `cityMap`. `sandiego` was mapped to `"sfbay"` (San Francisco).
  - Fix: `sandiego` now correctly maps to `"sandiego"`.

---

## v0.7.0 — Vehicle Market Comp Fix + Buy-New Sanity Guard (Mar 2026)

### Bugs Fixed
- **B-V1 — "4172% of new" banner on vehicles** (`scoring/affiliate_router.py`, `api/main.py`)
  - Root cause: `should_trigger_buy_new()` had no upper-bound check. BMW listed at $6,300
    divided by eBay "new" price of $151 (parts, not a car) = ratio of 41.7x. The `>= 0.90`
    trigger fired because 41.7 is obviously ≥ 0.90. Showed absurd "4172% of new" banner.
  - Fix 1: Added `is_vehicle=True` guard — banner always suppressed for vehicles because
    eBay's `new_price` field reflects parts/accessories for vehicle searches, not the vehicle.
  - Fix 2: Added `ratio > 2.5` sanity check for all categories — if the listed price is
    more than 2.5× the "new" price, the new_price data is garbage; suppress banner.
  - `main.py` now passes `is_vehicle=listing.is_vehicle` to `should_trigger_buy_new()`.

- **B-V2 — eBay vehicle warning not rendering** (`extension/content/fbm.js`)
  - Root cause: Previous session's fix was only written as a diff in session notes, never
    saved to disk. File on disk had no vehicle warning at all.
  - Fix: Added inline warning to Market Comparison section when `listing.is_vehicle` is true:
    "⚠️ eBay prices shown are likely parts, not the vehicle. Use KBB or AutoTrader for real comps."
  - Also added `vehicle_not_applicable` data_source hook for future use when/if API is updated
    to skip eBay pricing for vehicles entirely (renders KBB/Carfax/CarGurus links instead).

- **B-G1 — `vehicle_details: null` Pydantic 422 error** (`extension/content/fbm.js`)
  - `vehicleDetails` returns `null` for non-vehicle listings; Pydantic requires a `dict`.
  - Fix: `vehicleDetails || {}` — null-coalesces to empty dict before sending to API.
  - Saved at end of previous session.

---

## v0.6.0 — Security Scoring + Category-Aware Thresholds (Mar 2026)

### Bugs Fixed
- **B1 — Security false positive on legit deep-discount listings** (`scoring/security_scorer.py`)
  - Category-aware price thresholds: bikes/tools/outdoor 15%, vehicles 40%, phones 30%, default 20%.

- **B2 — Price extracted as $0 on first injection, wastes API call** (`extension/content/fbm.js`)
  - Retry loop in `scoreListing()` — up to 3 retries × 800ms before aborting.

- **B3 — Vehicle DOM fields not extracted** (`extension/content/fbm.js`, `api/main.py`)
  - New `extractVehicleDetails()` — parses mileage, transmission, title_status, owners,
    paid_off, drivetrain from `span[dir=auto]` elements in "About this vehicle" section.
  - `ListingRequest` extended with `vehicle_details: dict = {}`.

- **B4 — eBay returns parts prices for vehicles** (`extension/content/fbm.js`)
  - Warning banner added to Market Comparison for vehicle listings.
  - Long-term fix requires KBB/CarGurus API integration (deferred).

- **B5 — Affiliate cards showing Amazon/Walmart for vehicles** (`scoring/affiliate_router.py`)
  - Amazon safety net skips vehicle categories.
  - Vehicle safety net always inserts Autotrader as first card.
  - `cards = cards[:max_cards]` trim added after insertions.

---

## v0.5.0 — Positioning Fix + CORS + Pricing Inversion (Mar 2026)
- ✅ **CORS fix** — FastAPI `allow_origins` changed to `["*"]`
- ✅ **Sidebar positioning fix** — `position:absolute` children of root anchor
- ✅ **Facebook transform fix** — root appended to `document.documentElement`
- ✅ **Drag now works**
- ✅ **Better error messages** — network failures show uvicorn start command
- ✅ **Pricing priority inversion** — Google Shopping primary, eBay fallback

---

## v0.4.0 — Extraction Fixes + Full Pipeline (Mar 2026)
- ✅ Price extraction fix — text node walk for current price
- ✅ Shipping cost extraction — passed to Claude as `shipping_cost`
- ✅ Seller rating extraction — reads aria-label star ratings
- ✅ Strikethrough original price detection
- ✅ CSP compliance — all handlers via `addEventListener`
- ✅ Claude Vision integration — condition mismatch detection
- ✅ Suggestion engine — 3 affiliate cards per score
- ✅ Pro gating — `isPro()` reads `ds_pro` from chrome.storage.local
- ✅ SPA navigation handler — debounced re-injection on pushState
- ✅ Search results overlay — score badges on FBM listing thumbnails

---

## v0.2.0 — Extension (Mar 2026)
- ✅ Chrome extension with FBM + Craigslist content scripts
- ✅ Full DOM extraction without data-testid
- ✅ Collapsible, draggable sidebar
- ✅ One-click message templates
- ✅ Price history tracking (chrome.storage.local)
- ✅ Search results overlay
- ✅ Seller trust scoring
- ✅ Popup: API health check, manual rescore, Open Full Scorer

---

## v0.1.0 — POC (Mar 2026)
- ✅ Playwright-based FBM scraper (URL, text, batch modes)
- ✅ eBay Finding API price comparison with mock fallback
- ✅ Claude API deal scoring with structured JSON output
- ✅ FastAPI backend wiring scraper → eBay → Claude
- ✅ Validated on real listings (Orion telescope, Gskyer telescope)

---

## v0.17.0 — Vehicle Pricing Fixed (Mar 2026)

### Root Cause Diagnosed & Fixed
- **B-V5** (Critical): `NotImplementedError` on Windows — Playwright `async_playwright` can't spawn
  subprocesses from uvicorn's `ProactorEventLoop`. Entire vehicle pricing silently failed.
- **Fix**: Replaced CarGurus Playwright scraper with direct `httpx` JSON API call.
  CarGurus' `searchResults.action` endpoint returns structured JSON — no browser needed.
  Craigslist fallback now uses `sync_playwright` inside `ThreadPoolExecutor` (own event loop).
- **B-V6**: Wrong year comps — CarGurus API returning 2001–2010 Accords when sorted by price ASC.
  Fixed by adding `startYear`/`endYear` params + client-side `carYear` filter (±2 years).
  Switched sort to `BEST_MATCH` to avoid scraping floor-priced junkers.
- **B-V7**: `Price range $0 – $0` in UI — `sold_low`, `sold_high`, `active_low` were missing
  from `DealScoreResponse` model and return statement. Added all three fields.

### Result: 2018 Honda Accord LX @ $14,600
- Before: score 2/10 ❌ AVOID — "$11,045 overpriced" (using 2001 Accord comps at $3,595)
- After: score 8/10 ✅ BUY — "$1,300 below market" (25 real 2018 Accord comps at $15,918 avg)

### Files Changed
- `scoring/vehicle_pricer.py` — full rewrite: httpx API + threaded sync Playwright fallback
- `api/main.py` — `DealScoreResponse` + return statement: added `sold_low/high`, `active_low`

---

## v0.18.0 — Vision Image Fix (Mar 2026)

### Bug Fixed: B-I1 — Vision analyzing wrong listing's photo
**Root cause:** `findListingImages()` in fbm.js filtered for CDN tier `t45.` which is used
for ad thumbnails and "similar listings" cards preloaded in the background DOM — NOT
the current listing's item photos. The listing's own photos use `t39.84726-6` CDN path.
This caused Vision to analyze a randomly-grabbed nearby listing photo instead of the
current listing, producing completely wrong mismatch flags.

**Example:** Kobalt Pull Saw $10 scored 2/10 AVOID because Vision saw "Kobalt 24V
impact wrench" from an adjacent preloaded listing, flagging a nonexistent mismatch.
Correct score should be 8-9/10 BUY ($136 eBay avg, 93% below market).

**Fix in fbm.js `findListingImages()`:**
- Changed CDN filter from `t45.` → `t39.84726` (actual item photo CDN path)
- Added `t45.84726` as secondary (future-proofing if FBM changes tier)
- Raised minimum size from 100px → 200px to skip thumbnails
- Added sort-by-width DESC so hero image is always `[0]` regardless of DOM order

### Files Changed
- `extension/content/fbm.js` — `findListingImages()` CDN tier filter + sort

---

 end-of-string check — price returned 0, scoring
aborted with "Could not read listing price".

**Fix:** Relaxed to `/^\$[\d,]+/` (leading match only). `parsePrice()` already
strips any trailing text via `match(/\$?([\d,]+)/)[1]`. Ancestor scoping (20
levels from listing h1) prevents false matches from sidebar/search prices.

### Files Changed
- `extension/content/fbm.js` — `findPrices()` fallback regex + VERSION 0.19.1
- `extension/manifest.json` — version 0.19.1

---

## v0.19.0 — Removed Pro gating; fully free model (Mar 2026)

### Monetization Model Change
Removed all freemium/Pro gating. Deal Scout is now **fully free** for all users.
Monetization shifts to: affiliate commissions (eBay, Amazon, Autotrader, etc.) and
eventually anonymized deal data insights.

### Removed from fbm.js
- `isPro()` function — chrome.storage.local `ds_pro` check
- `renderProTeaser()` function + `.ds-pro-teaser` CSS
- Pro-split payload logic (free users were getting stripped data with no image/vehicle fields)
- Conditional render block (`if (!pro) { renderScore + teaser } else { renderScore }`)

### Result
- All users now receive: full Vision photo analysis, vehicle pricing, seller trust, market comps
- Payload always sends complete listing data including `image_urls`, `vehicle_details`, `seller_trust`
- No upsell UI in the panel

### Files Changed
- `extension/content/fbm.js` — Pro gating stripped, VERSION → 0.19.0
- `extension/manifest.json` — version → 0.19.0

---

## v0.18.1 — detectVehicle false positive on "Car Seats" (Mar 2026)

### Bug Fixed: B-P3 — "Car Seats" triggering vehicle detection
**Root cause:** `detectVehicle()` Strategy 1 keyword list contains `" car "` (with spaces)
for detecting bare vehicle references. The title "UPPAbaby VISTA Stroller with 2 MESA
Infant Car Seats & 2 Bases" lowercases to `"...infant car seats..."` which contains
`" car "` — triggering `is_vehicle=true`, routing to vehicle pricer, returning
`vehicle_not_applicable`, showing KBB/Carfax links on a stroller listing.

**Fix in fbm.js `detectVehicle()`:**
Added pre-sanitization step before keyword match that replaces known non-vehicle
compound nouns containing `car` with neutral placeholder tokens:
- `car seat(s)` → `CARSEAT`
- `car charger(s)` → `CARCHARGER`
- `car wash(es)` → `CARWASH`
- `car audio` → `CARAUDIO`
- `car freshener(s)` → `CARFRESHENER`
- `toy/race/cable/tram/stock car(s)` → `TOYCAR`

Keyword matching then runs on `sanitized` instead of raw `text`.
Strategy 2 (year + make regex) unaffected — it requires both a year AND a known
manufacturer name, so compound nouns can't trigger it.

### Files Changed
- `extension/content/fbm.js` — `detectVehicle()` pre-sanitization step

---

## Category Testing Queue
| # | Category | Status |
|---|----------|--------|
| 1–5b | Gaming, Furniture, Electronics, Phones, Vehicles | ✅ |
| 5c | 2018 Honda Accord LX $14,600 SD | ✅ v0.17.0 |
| 6 | Tools — Kobalt 10-in Pull Saw $10 | ✅ v0.18.0 (exposed B-I1) |
| 7 | Outdoor — Solo Stove Bonfire $90 | ⏳ |
| 8+ | Musical, Baby, Free, Sports | ⏳ |
