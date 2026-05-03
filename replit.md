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
- **Prompt-injection defense (extractor + evaluator + scorer — #70 v0.45.1)** —
  every Claude call that interpolates seller text wraps the user-controlled
  fields in tagged envelopes (`<listing_title>`, `<listing_description>`,
  `<listing_condition>`, `<listing_location>`, `<listing_price_text>`,
  `<seller_name>`, `<seller_joined>`, `<seller_tier>`, `<page_text>`,
  `<product_name>`, `<product_category>`, `<product_reputation>`).
  Shared sanitiser `scoring/_prompt_safety.py::sanitize_for_prompt` escapes
  both opening and closing variants of any reserved tag prefix; shared
  `UNTRUSTED_SYSTEM_MESSAGE` is attached as the `system=` arg of every
  Claude call. Three layers of defense: (1) sanitiser breaks tag syntax,
  (2) wrap markers fence the data, (3) system message tells Claude to
  treat all tagged content as data.

Pending hardening: per-install token system (replacing static `DS_API_KEY`),
log scrubbing. Tracked in `.local/tasks/extension-auth-lockdown.md`.

## Cybersecurity-first principles

Deal Scout handles untrusted listing data, an admin-token-gated dashboard,
outbound scraping of multiple third-party sites, an Anthropic API key, an
eBay app key, a Discord webhook, a GitHub token, and a browser extension
that runs on Facebook, eBay, Craigslist, and OfferUp. Every change must
satisfy these standing rules — they are not optional and not per-task.

1. **Server-built strings for trust-affecting copy.** Disclaimers,
   confidence labels, security flags, recall notices, walk-away advice,
   pricing-source caveats, and any "we don't have data on X" message
   are built from Python templates referencing only structured numeric
   or enum fields. The LLM never authors safety-critical copy. A
   malicious listing must not be able to strip, invert, or fake any of
   these strings.
2. **Untrusted input wrapping.** All seller-supplied text passed to
   Claude (title, description, condition, location, price text, seller
   name, seller-joined, seller tier, page text, product name, product
   category, product reputation) MUST go through
   `scoring/_prompt_safety.py::sanitize_for_prompt`, be wrapped in the
   tagged envelope (`<listing_title>` etc.), and the call MUST attach
   `UNTRUSTED_SYSTEM_MESSAGE` as `system=`. Any new field that
   interpolates user text follows the same three-layer pattern.
3. **Admin gating is sacred.** Every `/admin/*` route stays behind
   `ADMIN_TOKEN` via the `X-Admin-Token` header. Never weaken the gate
   "just for a test". Never accept the token via URL params (referrers
   and access logs leak them). Admin endpoints fail-closed (503) when
   `ADMIN_TOKEN` is unset.
4. **No PII in telemetry, INFO logs, or extension-facing errors.** No
   listing URLs, prices, install_ids, seller names, or listing titles
   in `claude_cache` aggregates, market signal exports, audit
   telemetry, or any error string returned to the extension. The
   `market_signals` and `claude_usage` payloads are anonymized
   aggregates only.
5. **SSRF guards on every outbound fetcher.** Image fetch, DDG, Google
   Shopping, Reddit, Amazon, eBay, Craigslist RSS, and any future
   scraper must use the existing `_is_safe_image_url`-style guard (or
   equivalent) and a hard timeout. New fetchers ship with the guard,
   not as a follow-up.
6. **Secrets are never logged, echoed, written to disk, or returned in
   responses.** `ANTHROPIC_API_KEY`, `EBAY_APP_ID`, `EBAY_CERT_ID`,
   `ADMIN_TOKEN`, `DS_API_KEY`, `DISCORD_WEBHOOK_URL`, `GITHUB_TOKEN`,
   and `MARKET_DATA_API_KEY` never appear in any log line at any
   verbosity, in any error response body or header, or in chat output.
   When debugging proxy issues, print only `usage` from responses,
   never headers or bodies.
7. **Extension uses `textContent`, never `innerHTML`.** All
   user-controlled and LLM-controlled strings rendered in the four
   content scripts and shared `lib/*.js` modules use `textContent`.
   Any HTML rendering requires a vetted sanitizer and explicit
   review.
8. **Mutating endpoints are key-gated AND rate-limited.** Any new
   `POST` that changes server-side state (the `/affiliate/flag`
   pattern) requires a key gate (`X-DS-Key` or `X-Admin-Token`) plus
   per-install rate limiting. Anonymous mutating endpoints are
   prohibited.
9. **Server-side caps on LLM-controlled fields.** `ai_confidence`,
   deal `score`, `trust_severity`, and any other field that drives
   user-visible safety copy is force-clamped server-side after parsing
   the model output. The model can never bump itself past the cap a
   prompt-injected listing tries to extract.

## Cybersecurity checklist (every new task plan)

Every new plan file under `.local/tasks/*.md` MUST include a
`## Cybersecurity notes` section that explicitly answers each of the
following, even if the answer is "N/A — this change does not touch X":

1. Does this change introduce new untrusted input to an LLM? If yes,
   is it wrapped with `UNTRUSTED_SYSTEM_MESSAGE` and the
   `<tagged_envelope>` pattern, and does it pass through
   `sanitize_for_prompt`?
2. Does this change introduce a new outbound fetch? If yes, what is
   its SSRF guard, what is its hard timeout, and does it reuse an
   existing fetcher pattern?
3. Does this change introduce a new endpoint or modify an existing
   one's gate? If yes, what authenticates it (admin token, DS key,
   install_id) and what rate-limits it?
4. Does this change change what is logged at INFO level or returned
   in any HTTP response body or header? If yes, has it been audited
   for PII (urls, prices, install_id, seller names, listing titles)
   and secrets?
5. Does this change render user-controlled or LLM-controlled text in
   the extension? If yes, is it `textContent` only, and is the source
   string built server-side from structured fields?
6. Does this change bypass or relax any existing server-side cap
   (confidence cap, score cap, trust-signal floor, comp-count
   threshold, payload `max_length`)? If yes, why is the relaxation
   safe?

A plan file that does not answer all six questions is not ready to be
proposed.

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
    ├── ebay_pricer.py         # Market value orchestrator — multi-source pipeline; clean_browse_comps (Task #58) does stddev outlier rejection + condition-mismatch dropping + 30/90/180-day recency weighting (drops >180d), and emits comp_summary with weighted_avg. Same cleaned set drives both score and confidence (no divergence).
    ├── ebay_browse.py         # eBay Browse API (OAuth2, real sold prices — PRIMARY source)
    ├── confidence.py          # (Task #58) Bucketer: lowest of {comp_count, spread, extraction, market_confidence ceiling} → high|medium|low|none. "none" forces can_price=False with cant_price_message verdict copy.
    ├── trust.py               # (Task #59) Composite trust/scam evaluator. Combines vision-derived signals (is_stock_photo, photo_text_contradiction from extended deal_scorer prompt) with pure-Python heuristics (vague_description, price_too_good_new_acct, duplicate_seller_listing). Returns trust_signals + trust_severity (none|info|warn|alert); 2+ signals cap score to 5, all 6 floor to 1 with verdict override. Each signal fails open on missing data.
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

Current: **v0.45.0** (extension) / **v0.45.0** (API — read from `artifacts/deal-scout-api/VERSION`)

### v0.46.3 CAN'T PRICE → new-retail fallback (Task #78)
When sold/active comps are too thin (<3 cleaned) but a new-retail price
is known (Google Shopping, Claude knowledge, or Amazon), the scorer no
longer dead-ends with a CAN'T PRICE banner. Instead it scores against
new-retail with confidence force-capped to "low" and surfaces a
server-built `pricing_disclaimer` (e.g. "Score based on new-retail price
(~$950); no used sales found — confidence is low."). The CAN'T PRICE
banner is now reserved for the genuine no-anchor case where BOTH used
comps AND new-retail are missing.

Trigger: kegerator bug ($525 ask, 0 comps, new ~$950) — previously
dead-ended at CAN'T PRICE; now scores in the 6-8 range with the amber
disclaimer rendered immediately under the confidence chip.

Implementation:
- `scoring/confidence.py`: new `determine_anchor_source(comp_count,
  new_price)` (single source of truth: "sold_comps" | "new_retail" |
  "none"); `derive_confidence(..., new_price=)` adds the new-retail
  branch returning bucket="low" + `anchor_source="new_retail"`; new
  helper `new_retail_disclaimer(new_price)` returns the fixed-template
  caveat (NEVER LLM-authored, per the project's Cybersecurity-first
  rules added in Task #81).
- `main.py`: `_build_confidence_payload` now passes `new_price` through
  and adds `anchor_source` + `pricing_disclaimer` to the response;
  `DealScoreResponse` gains those two fields; both `/score` and
  `/score-stream` compute `anchor_source` via `determine_anchor_source`
  before calling `score_deal` and pass it through as a kwarg.
- `scoring/deal_scorer.py`: `build_scoring_prompt` and `score_deal`
  accept `anchor_source`; when `"new_retail"` the prompt injects an
  `## ANCHOR: NEW-RETAIL FALLBACK` block telling Claude to score vs new
  retail with bracketed guidance (≤70% → 7-8, 70-85% → 5-6, 85%+ →
  ≤5). Post-parse, confidence is force-set to "low" regardless of what
  Claude returned, so the model can't escape the disclaimer.
- Extension (`lib/digest.js` + all 4 content scripts): new
  `renderPricingDisclaimer(container, text)` helper renders an amber
  banner via `textContent` (no innerHTML — defense-in-depth even though
  the text is server-built). Wired into fbm/ebay/craigslist/offerup
  immediately after `renderConfidenceBlock`.

VERSION 0.46.2 → 0.46.3, manifest 0.46.1 → 0.46.3.

### v0.46.2 Score speedup pass 1 (API only — Task #74)
Five low-risk perf wins on `/score` and `/score-stream` with no behavior
change. Extension manifest stays at v0.46.1.

**Cache validation — FAILED 2026-05-03 (Task #79).** Sample: **55
score_log rows / 404 Claude calls over a 24h window.** Result: every
label is 0% hit rate AND 0 cache_creation_input_tokens.

```
label              calls  hits  hit_rate%  token_read%  input_tok  cache_read  cache_creation
DealScorer            55     0       0.0         0.0     251,411           0               0
ProductExtractor      54     0       0.0         0.0      65,086           0               0
MergedExtractor        1     0       0.0         0.0       1,676           0               0
SecurityScorer        53     0       0.0         0.0      61,768           0               0
ProductEvaluator      76     0       0.0         0.0      67,103           0               0
CompVerifier          84     0       0.0         0.0      48,553           0               0
SanityCheck           48     0       0.0         0.0      20,423           0               0
ClaudePricer          33     0       0.0         0.0      24,280           0               0
TOTALS               404     0       0.0         0.0     540,300           0               0
```

**Suspected cause** (not yet definitively confirmed end-to-end against
the upstream Anthropic endpoint): the Replit Modelfarm proxy at
`http://localhost:1106/modelfarm/anthropic/v1/messages` silently drops
the `cache_control` field before forwarding. The smoking gun is that
**both** `cache_read_input_tokens` and `cache_creation_input_tokens`
are zero on every call — including the very first call against any
given system block, which would otherwise have populated
`cache_creation_input_tokens` if the proxy honored the field.

Cross-check: the per-call `[ClaudeCache]` log lines (added in #75) were
spot-checked against the dashboard aggregate. Every line in the sample
window reads `cache_read=0 cache_creation=0 hit=N`, matching the 0/0
totals above — i.e. there is no row-level disagreement between the
per-call telemetry and the aggregated `claude_cache` block.

Note on label coverage: `ListingExtractor` (the legacy text-only
extractor at `scoring/listing_extractor.py:192`) was not exercised in
this window — current `/score-stream` traffic routes through
`MergedExtractor` (`scoring/listing_extractor.py:405`), which combined
the two extractor steps. A direct `/score-stream` validation call was
fired during this task and confirmed `MergedExtractor` also reports
0/0 (calls=2, hits=0, cache_r=0, cache_c=0). All three extractor
labels (`ProductExtractor` 59 calls, `MergedExtractor` 2 calls, and
`ListingExtractor` by inference) share the same
`claude_call_with_retry` wrapper, so the 0% systemic result on every
observed label — including the active extractor path — is
representative.

A two-call usage-only repro against Modelfarm with a >2,500-token
cached system block confirmed 0/0 on both calls. Repro command
(verbatim, run from the project root):

```
$ python .local/cache_repro.py
[call-1 (expect cache_creation>0 if honored)] usage: input=2655 output=4 cache_read=0 cache_creation=0
[call-2 (expect cache_read>0 if honored)]    usage: input=2655 output=4 cache_read=0 cache_creation=0
```

The #74 system-block caching investment is
therefore a no-op end-to-end. Follow-up debug task #82 opened to (a)
mirror the repro against the official Anthropic endpoint to confirm
the proxy is the layer dropping the field, (b) file with Replit's
Modelfarm team, and (c) record a disposition (wait / bypass / remove
the `cache_control` blocks) for user approval.

1. **Anthropic prompt caching on every system block.** All eight Haiku
   call sites now pass `system=` as a list of content blocks with
   `cache_control: {"type":"ephemeral"}` so the static prefix can be
   cached server-side: `deal_scorer.score_deal`,
   `product_evaluator.evaluate_product`, `security_scorer.run_layer2`,
   `ebay_pricer._llm_verify_comps` (CompVerifier),
   `ebay_pricer._llm_sanity_check` (SanityCheck),
   `product_extractor.extract_product`,
   `listing_extractor.extract_listing_from_text`,
   `listing_extractor.extract_listing_and_product`.
2. **Vision policy lifted into a cached system block.** The static portion
   of the per-call vision instruction in `deal_scorer.score_deal` (~25
   lines about primary-subject focus, damage scanning, no-fabrication
   rule) now lives in `_VISION_POLICY_TEXT` and is sent as a second
   cached `system` block whenever images are present. Only the dynamic
   preface (photo counts, listing title) stays in the user message, so
   prompt caching covers the constant policy.
3. **Per-image fetch timeout in `_fetch_multiple_images`.** Each image
   fetch is now wrapped in `asyncio.wait_for(_fetch_image_base64, 2.5s)`
   so a single slow CDN response can't drag the whole vision call past
   its budget. Drops are logged at info level. Image cap stays at 5 per
   listing per user request.
4. **Security scoring launched earlier in `/score`.** The
   `score_security` task now starts immediately after the step1+2
   `gather` unpack — i.e. in parallel with the eBay refinement step
   AND the deal scorer (vision) call — instead of after refinement.
   Uses `prelim_market` for context (the security verdict isn't
   sensitive to refined-vs-prelim market data). Saves ~1.5–3s on the
   common refinement path.
5. **Tighter `max_tokens` on Layer-2 security.** `security_scorer`
   dropped from 400→300. **Reverted product_evaluator 900→600** —
   smoke test showed the v0.46.0 reputation v2 schema (category_leaders,
   same_budget_alternatives, brand_rank) needed the full 900 to avoid
   JSON truncation. Held at 900; perf win on that call comes from the
   cached system block alone.

Smoke tests against two synthetic listings (Sony WH-1000XM4, Bose QC45)
return 200 OK with full security + reputation + affiliate payloads.

### v0.46.0 Reputation + Negotiation v2 (Option B)
**Backend (`artifacts/deal-scout-api/`):**
- `product_evaluator.py` — extended Claude prompt with `brand_rank_in_category`,
  `category_leaders[]`, `same_budget_alternatives[]`, `recall_flag` +
  `recall_summary`, per-field confidence. Listing inputs wrapped via
  `_wrap_untrusted` / `_UNTRUSTED_SYS_MSG` (prompt-injection hardening).
- `scoring/deal_scorer.py` — Negotiation v2 schema: `negotiation.{strategy,
  walk_away, leverage_points, variants{polite,direct,lowball},
  counter_response}`. Strategy rules: score-8+ → `pay_asking`; vague listing
  → `question_first`; <<market → `verify_first`; thin comps suppress lowball.
  Bundle hardening: `bundle_items[]` required when `is_multi_item`,
  `bundle_confidence` field. `_normalize_negotiation` helper sanitises
  model output. JSON-schema example block uses `{{` / `}}` escapes — Python
  3.11 f-string parser fails otherwise (regression seen during ship).
- `scoring/affiliate_router.py` — `filter_affiliate_cards()` adds title
  overlap, price-sanity (<50% asking suppresses), negative keywords
  (part/kit/filter/etc), bundle/refurb mismatch, and per-card
  `confidence_label` (exact|approximate|search|browse|suppressed).
- `main.py` — `affiliate_flags` table init at startup + per-cold-start;
  `_get_flagged_programs(listing.listing_url)` read-path suppression in
  `/score` and `/score-stream`; new `POST /affiliate/flag` endpoint
  (key-gated, 10/min/install rate-limit). `DealScoreResponse` extended
  with `bundle_items`, `bundle_confidence`, `is_multi_item`, `negotiation`.

**Extension (`extension/`):**
- `content/lib/repv2.js` (NEW) — shared `window.DealScoutV2` module with
  `renderRecallBanner`, `renderReputationV2Extra`, `renderNegotiation`
  (3-variant cards + leverage + counter + walk-away ceiling),
  `renderBundleHardened`, `renderAffiliateFlagFooter`. Loaded by all 4
  content scripts via `manifest.json` content_scripts[].js.
- `content/{fbm,ebay,craigslist,offerup}.js` — bundle gate switched from
  `r.bundle_breakdown.items` → `(r.is_multi_item || r.bundle_items.length)`
  so the "📦 Bundle of N items" line always renders for multi-item
  listings. Negotiation render swapped to `DealScoutV2.renderNegotiation`
  with legacy fallback when `r.negotiation` is absent.

**Deferred (next release):**
- Per-card 🚩 affiliate flag button — currently shipped as a single
  bottom-of-panel "Report a wrong recommendation" link with retailer
  prompt. Per-card glyph requires touching each platform's affiliate
  card builder.
- `install_id` plumbing through extension → `/affiliate/flag` body.

### v0.45.0 Saved listings — popup recall (browser-only)
Browser-only recall feature so users can find previously-scored listings
without re-searching. Star toggle (`☆`/`★`) lives in the sticky digest's
top-right corner with a `(?)` tooltip pointing to the toolbar icon.
First-ever save shows a 6-second discoverability hint; subsequent saves
get a brief toast. At-cap (10 saves) reveals an inline swap picker —
the user always picks who gets evicted, no FIFO. Re-visiting a saved
listing adds a *"★ Saved Nd ago at $X (down $Y)"* annotation under the
header. Storage in `chrome.storage.sync` keyed `ds_saved_listings`
(falls back to `chrome.storage.local` with a *"Sync disabled"* note when
sync is unavailable). New section appended to the **bottom** of the
popup — existing controls untouched. Zero backend, zero new tables.
New shared helper at `extension/content/lib/saved.js`; star + picker +
annotation logic in extended `lib/digest.js` (`attachSaveStar`).

### v0.44.0 Score panel — Approach A layout (sticky digest + collapsibles)
Score panel restructured: sticky digest at top (header, confidence, trust,
leverage, summary) stays visible while the user scrolls; long-tail detail
moves into 5 collapsibles below — *Why this score*, *Market Comparison*,
*Compare Prices*, *Security Check*, *Product Reputation* — collapsed by
default with a one-line summary on each closed row. Empty sections are
suppressed entirely. Expand state is persisted **per section name** (not
per listing) under `ds_section_state` in `chrome.storage.local`, so a
preference for "always show Market Comparison" sticks across every
listing on every marketplace. Pure rendering refactor — no backend
changes. New shared primitive lives at `extension/content/lib/digest.js`
(loaded via `content_scripts` in manifest before each platform script);
`fbm.js`, `craigslist.js`, `ebay.js`, and `offerup.js` all call
`window.DealScoutDigest.beginDigest(panel)` + `openCollapsible(...)`.
Also fixed a latent drag bug in `craigslist.js` `renderHeader` where the
mousedown handler stored `_ds_drag` on the header's container instead of
the panel — only manifested once the container became the new sticky
digest wrapper.


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
