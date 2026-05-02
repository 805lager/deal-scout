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

## Security model (as of #54 partial — May 2026)

- **`DS_API_KEY` (secret, set)** — shared between extension and API. All
  user-facing endpoints (`/score`, `/score/stream`, `/event`, `/thumbs`,
  `/feedback`, `/report`) require it via `X-DS-Key` header. Dev-mode
  bypass: if unset, the gate is skipped.
- **`ADMIN_TOKEN` (secret, MUST be set per environment)** — separate token
  for `/admin/*` endpoints. Dashboards, audit logs, telemetry, and the
  daily-summary trigger ALL fail-closed (503) when unset. Sent via
  `X-Admin-Token` header (header-only — URL params would leak via referrers
  and request logs). Legacy `X-DS-Key` header accepted for one release of
  compat — drop next release.
- **CORS** — explicit allowlist in both dev (`app`) and prod (`_root_app`):
  4 marketplace origins + dashboard + Chrome extension ID. Override via
  `CORS_ORIGINS` env var.
- **Payload caps** — Pydantic `Field(max_length=...)` on every user-supplied
  string; oversized inputs return 422 before reaching Claude.
- **Prompt-injection defense (extractor only — evaluator/scorer pending)** —
  user title/description wrapped in `<listing_title>`/`<listing_description>`
  tags, `_sanitize_for_prompt` escapes closing tags, system message marks
  tag content as untrusted.

Pending hardening: per-install token system (replacing static `DS_API_KEY`),
log scrubbing, prompt-injection wrap in `product_evaluator.py` and
`deal_scorer.py`. Tracked in `.local/tasks/extension-auth-lockdown.md`.

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
- `GET /admin/dashboard` — data pipeline summary stats + persistent score-cache hit-rate metric
- `POST /admin/score-cache/clear?url=...` (or `?all=true`) — invalidate persistent score_cache rows (admin-token auth)
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

Current: **v0.43.4** (extension) / **v0.43.4** (API — read from `artifacts/deal-scout-api/VERSION`)

### v0.43.4 Faster scoring + cleaner FBM popup on navigation
Four changes that shave wall time off every score and stop the Deal
Scout panel from getting stuck on screen when the user clicks away
from a Marketplace listing.

**Speed 1 — merged Claude extraction (`/score-stream`).** The streaming
pipeline used to make TWO sequential Haiku calls for every listing:
`extract_listing_from_text` (clean title/price/etc from raw page text)
followed by `extract_product` (brand/model/search_query). Both were
short-prompt structured-output tasks against the same listing data.
New `extract_listing_and_product()` in `scoring/listing_extractor.py`
returns both shapes in a single Haiku call — saves ~0.6-1.2s/score and
halves per-score Haiku token cost. Output schema is a strict superset
of the originals; downstream callers (eBay pricer, deal scorer,
security scorer, audit logger) are unchanged. `/score-stream` no
longer runs a preliminary-then-refined eBay pair either — once we
have `product_info.search_query` from the merged call, eBay is queried
directly with the right query the first time.

**Speed 2 — short-circuit refined eBay when prelim is strong (`/score`).**
The non-stream `/score` path still does prelim+refine to overlap
extraction with eBay. Added a third skip-refinement condition (on top
of the existing `_queries_similar` and `_ebay_rate_limited` checks):
if the preliminary pass already returned `sold_count >= 5` AND the
refined query has ≥50% token overlap with the raw title, skip the
refined eBay call entirely. Saves another ~1.5-2.5s on common cases
where the seller-written title was already specific enough.

**Speed 3 — DB schema-ensure moved to startup.** New
`@app.on_event("startup") _ensure_db_tables_at_startup` runs
`_ensure_affiliate_events_table` + `_ensure_corrections_table` once
at process start. The in-request `_ensure_*_table()` calls remain as
defense-in-depth — the module-level idempotent flag they set means
those subsequent calls early-out for free instead of paying for the
first-call DDL roundtrip on a user-facing request.

**Cleanup — FBM popup clears on non-listing navigation.** On Facebook
Marketplace (an SPA), navigating from a scored listing back to the
search results, FB home, or any non-`/item/<id>` URL used to leave
the previous score panel sitting on screen until manually closed.
Now `_onFbmNav` in `extension/content/fbm.js` aborts any in-flight
score and calls `removePanel()` immediately when the destination URL
isn't a listing — covering both `pushState`/`replaceState` and
`popstate` (Back/Forward). Defense-in-depth in `extension/background.js`:
`webNavigation.onCommitted` on facebook.com tabs sends a `CLEAR_PANEL`
message whenever the new URL isn't a listing, so even cross-origin
or refresh-style navigations the in-page hook misses still clean up.
`fbm.js` message handler responds to `CLEAR_PANEL` with the same
abort+nonce-bump+removePanel sequence used by RESCORE.

Bleed/overlap protections preserved unchanged: per-`(tabId, listingId)`
score cache in background.js, `__dealScoutNonce` + `__dealScoutAbort`
per-listing in fbm.js, per-listing `score_log_id`, and the v0.43.3
audit-dedup are all untouched.

### v0.43.3 Rescore Findings — dedupe by score_log_id
Bug in v0.43.1's rescore button: the audit returns one row per
finding, so a listing with 3 findings (category_routing +
score_accuracy + data_source) was getting rescored 3× back-to-back.
Wasteful and worse — rapid duplicate calls can hit different
pricing-pipeline branches (rate limits, cache races) and produce
inconsistent scores for the same listing in the same batch (one user
saw Talaria #454 rescore 6→7 then 6→2 in the same run). Now dedupes by
`score_log_id` before iterating; confirm dialog notes how many duplicate
finding rows were collapsed.

### v0.43.2 Three audit-driven fixes — affiliate routing, score anchoring, e-bike eBay coverage
Audit dashboard rescore surfaced three real issues; this release fixes all three.

**Task A — Affiliate cards now follow the micromobility pricing routing.**
After v0.43.0 the pricing pipeline correctly skipped CarGurus for e-bikes
and Talarias, but the affiliate router was still detecting them as
"vehicles" (via the bare "motorcycle" keyword in CATEGORY_MAP) and
showing autotrader/cargurus cards. `detect_category()` in
`scoring/affiliate_router.py` now runs the same micromobility brand list
+ regex as `scoring/ebay_pricer.py` BEFORE the keyword loop and forces
`bikes` for any match — keeping affiliate routing in sync with pricing
routing. Added e-bike brand coverage: e-lux, aventon, ride1up, juiced,
bakcou, ariel rider, wired freedom, narrak, lectric.

**Task B — Score anchored on `sold_avg`, not blended `estimated_value`.**
`_price_direction_hint` in `scoring/deal_scorer.py` now prefers
`sold_avg` as the price anchor whenever `sold_count >= 3` (real recent
transactions). When `sold_avg` and `estimated_value` diverge by >15%,
both numbers are surfaced in a new "PRICING SIGNAL DIVERGENCE" line
that explicitly tells Claude to treat sold_avg as authoritative. Added
two new rules to the CRITICAL RULES FOR DATA QUALITY block telling
Claude to (1) anchor on sold_avg over estimated_value and (2) honor the
PRICE DIRECTION line literally — a 25%+ discount with reasonable comps
must score 7+. Also relaxed the low-confidence cap so a meaningfully
discounted item with no listing-text red flags can still score 6-7
even with thin comps. Fixes Talaria #454 type cases where 28% below
sold_avg was scoring 6 ("Fair deal") instead of 7-8.

**Task C — E-bike brands no longer fall through to `claude_knowledge`.**
Added a "micromobility broaden-and-retry" step in `get_market_value()`
in `scoring/ebay_pricer.py`: if both the full query and the
`_build_short_query` retry return 0 sold comps AND the listing matches
the micromobility brand/regex set, do one final eBay Browse query of
the form `<first 1-2 brand tokens> ebike` (skipping filler words like
"electric"/"bike") before falling back to Google Shopping or
claude_knowledge. Also expanded the micromobility brand keyword set in
`ebay_pricer.py` to include the e-bike brands the audit caught. Fixes
E-Lux #455 type cases where data_source was claude_knowledge instead
of ebay_browse.

### v0.43.1 Audit dashboard — Rescore Findings button
- Added a "Rescore Findings" button to the audit dashboard header next to
  "Check Scores Now". Disabled until a check has run. Once enabled, it
  iterates every flagged finding, calls `/admin/audit/rescore` for each
  score_log_id sequentially, and renders a compact summary panel above
  the findings list showing per-listing old→new score, data_source
  changes, and a totals line ("N changed, M unchanged, K errored").
  Useful after deploying a scoring fix to validate it against historical
  flagged listings without having to score new items first.

### v0.43.0 E-bike / micromobility classification fix
- **Bug surfaced by audit dashboard**: e-bikes, e-trikes, e-scooters, Surrons,
  and electric "motorcycles" were being routed through the vehicle pricing
  pipeline (CarGurus → Craigslist), failing to find auto comps, returning
  `data_source=vehicle_not_applicable` + `estimated_value=$0` + `confidence=none`.
  Despite zero market data, Claude was still returning `score=6, should_buy=true`
  — purely speculative recommendations.
- **Fix in 4 layers**:
  1. `extension/content/fbm.js`: added `isMicromobility` regex that negates
     `isVehicle` for ebike/etrike/escooter/Surron/Talaria/OneWheel/hoverboard.
     (Defensive only — `extractListing` is dead code; `extractRaw` is live.)
  2. `scoring/listing_extractor.py`: tightened Claude extraction prompt to
     explicitly exclude micromobility from `is_vehicle`. **This is the
     authoritative gate** for FBM/Craigslist/eBay/OfferUp.
  3. `scoring/ebay_pricer.py`: added micromobility brand keyword set + regex
     (`electric <0-3 words> <bike|tricycle|scooter|moped|moto|motorcycle|dirt bike>`)
     that, even when `is_vehicle=True` slips through, skips the vehicle pricer
     and falls through to the regular eBay+Google pipeline. Verified: Surron,
     Narrak Electric Fat Tire Tricycle, Super73, Talaria, OneWheel, Wired
     Freedom, "Electric Folding Mountain Bike" all now return real comps.
     Real cars (Honda Civic, F-150) still route to CarGurus correctly.
  4. `main.py`: added "no-data guard" Step 4c.5 (in `/score`) and Step 4b.5
     (in `/score-stream`) that caps score at 5 and forces `should_buy=False`
     whenever `data_source=='vehicle_not_applicable'` OR `confidence=='none'`
     OR `estimated_value<=0`. Adds a red flag so the verdict is honest about
     the missing data. Backstop for future cases of any item type with no
     usable comps.

### v0.42.6 Restore thumbs UI + daily cost reporting
- Extension: drop the `score_id`-required gate on the FB score-card thumbs
  feedback. Buttons now always render; click handler logs (and skips the
  POST) when score_id is missing instead of silently hiding the entire
  feedback section. Fixes "thumbs missing" caused by upstream DB write
  failures returning `score_id=0`.
- API: add **💰 Cost & Usage** field to the daily Discord summary. Reports
  estimated Anthropic spend today / month-to-date / projected, plus
  Claude API call counts and raw scoring run counts. Estimate uses
  calibrated $0.015/score (Haiku 4.5 ~7k in / 800 out × ~3.5 calls per
  scoring run). Adjust `ANTHROPIC_MONTHLY_LIMIT_USD` in main.py to match
  your actual plan. Add precise per-call token tracking as a follow-up
  for true accuracy.


### v0.42.5 Auto-score OFF — clean up residual panels
- **Bug**: With auto-score OFF, a small "📊 Deal Scout ⟳ Loading…" panel
  could still appear on listings. Cause: residual panels from before the
  toggle was flipped, or from a navigation that fired before the gate
  resolved, were left in the DOM.
- **Fix**: When `_dsAutoIfEnabled` (fbm.js) and `_dsMaybeScore` (offerup.js)
  see auto-score is OFF, they now `removePanel()` to clear any stale panel
  in addition to skipping scoring. RESCORE handlers continue to work
  unconditionally.

### v0.42.4 Auto-score on/off toggle in popup
- **User request**: Some users browse listings without wanting the Deal Scout
  panel to pop up automatically — they only want to score on demand.
- **Popup UI**: Added a labeled switch ("Auto-score on page load") in
  `extension/popup/popup.html` + `popup.js`. State is persisted in
  `chrome.storage.local` under `ds_auto_score` (default ON / true). Toggle
  is read on popup open and written on change.
- **Content-script gating** (all 4 scripts): Added a `_dsAutoScoreEnabled()`
  helper that reads the same key. Gated the auto-trigger sites only:
    * `fbm.js`: initial `autoScore()` on listing load + bg-reinjection rescan
      timer
    * `craigslist.js`: `tryInit()` initial scoring
    * `offerup.js`: `waitForContent()` -> auto-score on title-change &
      fallback timeout
    * `ebay.js`: initial 1500ms auto-score timer
  The `RESCORE` message handler (used by the popup's "Score Current Listing"
  button) and the in-panel manual RESCORE button continue to fire
  unconditionally, so users can still score on demand when auto-score is OFF.
- **No backend changes** — purely a client-side gating change. API call is
  never made when auto-score is off and the user doesn't click the button.

### v0.42.3 Thin-comp market guard — stop single-comp AVOID verdicts
- **User report**: Nephrite jade money toad listing ($399 + $60.51 ship, 25 lb
  hand-carved stone) scored **2/10 AVOID** with red flag "Price 819% above
  eBay sold average" and `recommended_offer` $85 — based on a single $50
  eBay comp with `confidence=low`. The prompt-level rule telling Haiku
  "do not flag price-to-comp mismatch when confidence is low" was being
  ignored (same pattern as the v0.42.2 hallucination filter), and the UI
  delta badge had no confidence gating at all.
- **Server: post-process guard** in `scoring/deal_scorer.py`
  (`_apply_thin_comp_guard`). When `market_value.confidence == "low"` AND
  `sold_count <= 2`, the guard:
    * strips red_flags matching any of ~20 comp-driven patterns
      (`"% above"`, `"overpriced"`, `"price-to-value ratio"`, `"far exceeds"`,
      `"vs. asking"`, `"markup of over"`, `"indefensible"`, …)
    * rewrites `summary` / `verdict` / `value_assessment` that use the same
      language to "Comps are thin — fair value cannot be confirmed"
    * floors `score` at 4 **only if** a comp-driven flag was actually
      removed (so genuine low scores driven by real issues like scam
      payment requests are preserved)
    * floors `recommended_offer` at 50% of asking so a single weak comp
      can't anchor the negotiation number
- **Server: stronger prompt wording** in the CRITICAL RULES FOR DATA
  QUALITY section — added an explicit negative example showing the
  exact phrasings Haiku must not produce when confidence=low.
- **Extension UI gating (all 4 content scripts)**: In the Market
  Comparison panel, the red "$X above market (+Y%)" badge is replaced
  with a neutral "○ Comps limited — comparison unreliable" note when
  `market_confidence === "low"` AND `sold_count <= 2`. Applied
  identically to `fbm.js`, `craigslist.js`, `offerup.js`, and `ebay.js`
  so behavior is consistent regardless of marketplace.
- **Regression tests**: `artifacts/deal-scout-api/tests/
  test_thin_comp_guard.py` covers six cases including the exact jade
  toad payload, high-confidence listings (guard inactive), boundary at
  `sold_count == 3`, and real non-comp scam flags (score not floored).

### v0.42.2 eBay Auction Mode — Pydantic v2 setattr fix + AI hallucination filter
- **ROOT CAUSE: Pydantic v2 silently rejected setattr** — `ListingRequest`
  used legacy `class Config` syntax. In Pydantic v2 (vs v1), setting
  attributes that aren't declared fields raises an exception. The streaming
  pipeline wraps both `setattr(listing, "auction_current_bid", ...)` and the
  new `setattr(listing, "raw_text", ...)` in `try/except: pass` blocks, so
  the failures were silent — the security scorer never saw the auction
  current bid OR the raw page text. Fixed by switching to
  `model_config = {"extra": "allow", ...}`.
- **Page text now flows to scorers**: With setattr working, `raw_text`
  reaches both `score_security` (via listing attribute) and `score_deal`
  (via `listing_dict["raw_text"]`). The Layer 2 prompt now includes a
  dedicated "Listing page text" block with item specifics, return policy,
  and shipping info that the summarized `description` field had been
  stripping out.
- **Page-text-aware hallucination filter** in `security_scorer.run_layer2`:
  Even with the page text in the prompt, Claude Haiku still emits boilerplate
  "missing specs / no storage / no return policy" warnings driven by
  category priors. Added a post-process filter that drops any AI flag or
  item_risk that claims "missing X" or "no X" when the raw page text
  actually contains tokens proving X is present. Examples:
    * "no storage details" + page contains "SSD"/"256 GB" → dropped
    * "no return policy" + page contains "Returns:"/"30-day return" → dropped
    * "no model number" + page contains "MPN"/"UPC" → dropped
- **Expanded auction price-anomaly patterns**: Added "price suggests",
  "price indicates", "price implies", "suspiciously low", "unrealistically
  low" so AI flags like "Price suggests potential stolen / iCloud-locked
  / water-damaged unit" no longer leak through on auctions where the
  current bid is supposed to start low.
- **Result on the user-reported MacBook M1 auction** ($152.50, 8 bids):
  security score went from 6/medium with 6 mostly-hallucinated warnings
  to 8/low with 4 real concerns (no specs section, no photos, BIOS lock
  reminder, request cosmetic photos).

### v0.42.1 eBay Auction Mode — DOM extraction + display consistency
- **Extractor robustness in `extension/content/ebay.js`**: Modern eBay auction
  pages render text without literal "Current bid:" / "Time left:" labels
  (e.g. `"$152.50\n8 bidsEnds in 3d 22h"`). Fixed:
  - `bid_count` regex no longer requires a trailing word boundary (eBay's text
    can be concatenated like `8 bidsEnds`).
  - `time_left_text` accepts `"Ends in Xd Yh"` and standalone `"Xd Yh left"`
    in addition to the old `"Time left:"` form.
  - `current_bid` falls back to the $ price nearest the bid-count text or the
    "Place bid" button when no explicit "Current bid" label exists.
- **UI fallback bug fixed**: `renderAuctionHeader` / `renderAuctionAdvice` no
  longer fall back to `r.price` when `auction_advice.current_bid` is 0 — that
  was displaying the suggested-max-bid override as the current bid.
- **Market Comparison row label**: For pure auctions the "Listed price" row
  now reads "Current bid" and uses the real bid (not the override) for the
  delta, with neutral coloring + "(current bid)" suffix to communicate the
  price will rise.
- **Deal-scorer summary swap**: For pure auctions the response `summary` is
  now the auction-advice reasoning ("Bid up to $X for a strong deal..."),
  not the Claude prose that referenced the override price.
- **Layer 2 security auction context**: `run_layer2` accepts `is_auction`,
  `auction_current_bid`, `market_sold_avg` and uses an auction-aware price
  block ("Current bid: $X (auction in progress; typical sold ~$Y)") plus an
  AUCTION CONTEXT block instructing Claude not to flag the bid as
  below-market. Defense-in-depth post-process: AI flags matching price-anomaly
  patterns are dropped for auctions, and the AI score is boosted by ~1.5 per
  dropped flag (capped at +3) so the merged security score isn't punished
  for a flag we hide from the user.

### v0.42.0 eBay Auction Mode
- **Auction detection in `extension/content/ebay.js`**: `extractAuctionData()` parses
  the eBay DOM for "Current bid", "Place bid", "Time left", "(N bids)", and
  "Buy It Now" signals. Sends `is_auction`, `current_bid`, `bid_count`,
  `time_left_text`, `has_buy_it_now`, `buy_it_now_price` alongside `raw_text`.
- **Backend Auction Mode in `main.py /score/stream`**: When `is_auction=True`
  and no Buy It Now option, derives `suggested_max_bid = sold_avg * 0.85` and
  `walk_away_price = sold_avg * 1.05`, then OVERRIDES `listing.price` →
  `suggested_max_bid` for the rest of the pipeline. Hybrid (auction + BIN)
  listings use the BIN price as the scoring price. Returns new `auction_advice`
  dict in `DealScoreResponse` with current bid, time left, bid range, market avg.
- **Suppresses false low-price scam flag**: `security_scorer.run_layer1` accepts
  `is_auction` and skips both the "X% below market" and "unusually low for
  category" hard-floor flags when True. Defense-in-depth — the price override
  above already prevents the trigger.
- **Auction Mode UI in ebay.js**: `renderAuctionHeader()` replaces the score
  circle with an "AUCTION" badge + current bid + time left. `renderAuctionAdvice()`
  shows the bid range (green "bid up to" cap, red "walk away" floor, gray market
  avg, color-coded current bid status). Suppresses negotiation-message and
  Buy New sections in auction mode.

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
  - **Sync ALL version numbers** on every version bump. Use `scripts/bump-version.sh X.Y.Z` to do steps 1+2 in one shot — it updates `extension/manifest.json` and `artifacts/deal-scout-api/VERSION` (the single source of truth that `main.py:BACKEND_VERSION` reads at startup; the audit dashboard reads it too, so it never lags behind a release). Then manually:
    3. `replit.md` → Extension Version section
    4. Rebuild `deal_scout_extension.zip`
  - The `BACKEND_VERSION` constant in `main.py` is no longer hand-edited — it is read from `artifacts/deal-scout-api/VERSION` at module load. Do not reintroduce a hardcoded string.
  - **Extension zip contents** (only these files belong in the zip):
    - `manifest.json`
    - `background.js`
    - `content/fbm.js`, `content/craigslist.js`, `content/ebay.js`, `content/offerup.js`
    - `popup/popup.html`, `popup/popup.js`
    - `lib/purify.min.js`
    - `icons/icon16.png`, `icons/icon48.png`, `icons/icon128.png`

## TypeScript API Server (pre-existing)

The workspace also has a TypeScript/Express API server at `artifacts/api-server/` (separate from Deal Scout, runs on port 8080 at path `/api`). This was pre-existing and is unrelated to the Deal Scout backend.
