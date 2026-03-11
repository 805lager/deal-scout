# Deal Scout — Changelog

All notable changes to this project are documented here.
Format: `vX.Y.Z — Description (Date)`

---

## v0.26.0 — Fix fbm.js API_BASE default + Gemini 2.5 models + healthcheck (Mar 2026)

### Bugs Fixed
- **CRITICAL: fbm.js was hitting localhost instead of Railway** (`extension/content/fbm.js`)
  - `API_BASE` defaulted to `http://localhost:8000` while `popup.js` defaulted to Railway
  - Result: popup showed ✅ connected but all actual scores hit the local server (old pre-Gemini code)
  - Fixed: default is now `https://deal-scout-production.up.railway.app` in both files
  - Local dev: set `ds_api_base = "http://localhost:8000"` via popup Settings panel

- **All Gemini 2.0 models deprecated for new API keys** (`scoring/gemini_pricer.py`)
  - `gemini-2.0-flash` and `gemini-2.0-flash-lite` return 404 for new users
  - Updated: primary → `gemini-2.5-flash`, fallback → `gemini-2.5-flash-lite`

- **`response_mime_type` caused slow-fail timeout cascade** (`scoring/gemini_pricer.py`)
  - Google rejects `response_mime_type` on the grounding path (tools active) after a full round-trip (~6-8s)
  - All 3 fallback paths were consuming the 18s timeout before returning None → eBay mock
  - Fixed: removed `response_mime_type` from grounding path; knowledge path detects SDK support upfront

- **Gemini hallucinating brand substitution** (`scoring/gemini_pricer.py`, `scoring/ebay_pricer.py`)
  - For obscure brands (Gskyer), Gemini substituted a well-known equivalent (Celestron NexStar $650)
  - Prompt fix: explicit "Do NOT substitute brands — price by specs/tier if brand unknown"
  - Sanity guard: if `avg > listing_price × 4`, discard result and fall back to eBay

- **`gemini-1.5-flash-latest` alias deprecated** — returns 404 on v1beta endpoint
  - Was the fallback model; replaced with `gemini-2.5-flash-lite`

- **Railway healthcheck timing out on cold start** (`railway.toml`)
  - 30s window too tight for Python cold start with multiple SDK imports
  - Increased to 120s

- **Syntax error in `main.py` f-string** (`api/main.py`)
  - Trailing `}` in f-string caused `SyntaxError: single '}' is not allowed`
  - Crashed app on startup, failed Railway healthcheck silently

### New Features
- **`/health` now returns backend version** (`api/main.py`)
  - `{"api":"ok","version":"0.26.0",...}` — confirms Railway is running the latest code
  - Also reports `gemini_key` status

- **`/test-gemini` accepts `?query=` param** (`api/main.py`)
  - Test any item: `/test-gemini?query=Gskyer+80mm+telescope&listing_price=250`
  - Previously hardcoded to Celestron NexStar

- **`push.bat` pre-push syntax checks** (`push.bat`, `sync_version.py`)
  - Runs `python -m py_compile` on all 4 backend files before every git push
  - Aborts push with clear error if any file has a syntax error
  - `sync_version.py` keeps `BACKEND_VERSION` in `main.py` in sync with `VERSION` in `fbm.js`

---

## v0.25.3 — Gemini source labels + Google AI reputation badge (Mar 2026)

### Bugs Fixed
- **Market Comparison panel showed wrong source labels** (`extension/content/fbm.js`)
  - `gemini_search` now shows "AI market avg (live)" / "AI price range"
  - `gemini_knowledge` now shows "AI market avg (est.)" / "AI price range"
  - Active value row for Gemini shows `$low – $high` range instead of single avg
  - `📌 item_id` line and italic notes appear below price rows

- **`gemini_knowledge` incorrectly triggered amber "⚠️ Fix estimated comps" button**
  - Removed from `isMockData` check — only `ebay_mock` and `suspect` trigger it now

- **Dollar signs missing from all price rows** (`extension/content/fbm.js`)
  - `Filesystem:edit_file` strips `$` from `${}` template literals — caused `$1` display
  - Fixed: use `const ps = '$'` variable pattern throughout render functions

### New Features
- **Product Reputation Google AI badge** (`extension/content/fbm.js`, `scoring/product_evaluator.py`)
  - Purple "🤖 Google AI" badge when `pe.ai_powered === true`
  - Grey "Reddit" badge otherwise
  - `ai_powered: bool` field added to `ProductEvaluation` dataclass
  - Gemini reputation call runs concurrently with Reddit via `asyncio.gather`
  - Strengths shown in green when no issues present
  - Up to 3 issues shown (was 2)

- **Gemini metadata threaded through full pipeline**
  - `ai_item_id` and `ai_notes` fields on `MarketValue`, `DealScoreResponse`
  - Rendered as `📌 item_id` and italic notes in Market Comparison panel

---

## v0.25.2 — Add gemini-1.5-flash free-tier fallback (Mar 2026)

### New Features
- **3-tier Gemini cascade** (`scoring/gemini_pricer.py`)
  - Tier 1: `gemini-2.0-flash` + search grounding (live prices, paid)
  - Tier 2: `gemini-2.0-flash` knowledge only (training data, paid)
  - Tier 3: `gemini-1.5-flash` knowledge only (1,500 req/day **free**, always works)
  - Pipeline now always returns AI pricing regardless of billing status
- **`GEMINI_FALLBACK_MODEL` env var** — override the free-tier model if needed (default: `gemini-1.5-flash`)
- **`_gemini_knowledge_only` accepts `model_name` param** — single function serves all tiers
- **`/test-gemini` debug loop** — tries both models when reporting `no_result`, shows which one works

---

## v0.25.1 — Fix Gemini search grounding tool format (Mar 2026)

### Bugs Fixed
- **`tools=["google_search"]` was silently ignored by the SDK** (`scoring/gemini_pricer.py`)
  - String form is invalid — SDK expects a `types.Tool` object or dict
  - Fixed: tries `types.Tool(google_search=types.GoogleSearch())` first, falls back to `{"google_search": {}}`
  - Without this, Gemini returned plain text instead of JSON; parse failed; pipeline fell back to mock every time
- **`/test-gemini` now returns `raw_debug` on `no_result`** (`api/main.py`)
  - Makes it easy to distinguish parse error vs. model refusal vs. grounding failure
- **Added raw response logging at DEBUG level** for both grounded and knowledge-only paths

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
- `google_pricer.py` is now bypassed — Gemini is the primary pricing source
- `GOOGLE_AI_API_KEY` must be set in Railway env vars or Gemini path is skipped entirely
