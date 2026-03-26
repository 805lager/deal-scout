"""
FastAPI Backend — Personal Shopping Bot

Exposes a single endpoint for the POC:
  POST /score  — accepts listing details, runs the full pipeline, returns a deal score

The pipeline it runs:
  1. product_extractor.py  — Claude Haiku extracts brand/model/search_query from vague title
  2. ebay_pricer.py        — eBay comps using extracted query (not raw title)
     product_evaluator.py — Reddit + Google Shopping reliability signals (concurrent with #2)
  3. deal_scorer.py        — Claude scores the deal with product reputation context injected
  4. suggestion_engine.py  — Generates affiliate buy suggestion cards based on score
  5. Returns combined result as JSON to the extension sidebar

WHY FastAPI over Flask:
  Built-in async support matches our async scraper/scorer architecture.
  Auto-generates API docs at /docs — useful for testing without the UI.
  Pydantic validation catches bad input before it hits the scoring logic.

RUNS ON: http://localhost:8000  (set API_PORT in .env to change)
API DOCS: http://localhost:8000/docs  (auto-generated, very handy)

START:
  uvicorn api.main:app --reload --port 8000
"""

import asyncio
import sys
import os
import logging
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from dotenv import load_dotenv
from typing import Optional
from collections import defaultdict

load_dotenv()

# Add project root to path so we can import from /scoring
# Path setup not needed — scoring/ is in the same directory

from scoring.ebay_pricer import get_market_value
from scoring.deal_scorer import score_deal
from scoring.product_extractor import extract_product, ProductInfo
from scoring.product_evaluator import evaluate_product
from scoring.affiliate_router import get_affiliate_recommendations, should_trigger_buy_new, get_program_status, build_affiliate_event
from scoring.security_scorer import score_security, SecurityScore
from dataclasses import asdict as dc_asdict_top
import time as _time
import json as _json
from datetime import datetime
from collections import deque

# In-memory event buffer — batched before write to avoid per-event I/O
# In production this would flush to a database or analytics service
_event_buffer: deque = deque(maxlen=10000)
_event_file = Path(__file__).parent.parent / "data" / "analytics_events.jsonl"

# Ensure data/ directory exists at startup.
# WHY: data/ is gitignored (may contain PII) so it won't exist on a fresh
# Railway container or new dev checkout. Any code that writes to _event_file
# or REPORTS_FILE will silently fail without this guard.
try:
    _event_file.parent.mkdir(parents=True, exist_ok=True)
except Exception as _mkdir_err:
    print(f"[Startup] Warning: could not create data/ dir: {_mkdir_err}")

logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO"),
    format="%(asctime)s [%(levelname)s] %(message)s"
)
log = logging.getLogger(__name__)

API_PORT = int(os.getenv("PORT", os.getenv("API_PORT", "8000")))
UI_PORT  = int(os.getenv("UI_PORT",  "3000"))

# ── In-memory score cache ─────────────────────────────────────────────────────
# Keyed by (title.lower(), price). TTL = 20 min.
# Avoids re-running the full AI pipeline when a user revisits the same listing
# or clicks back/forward during a browsing session.
_score_cache: dict = {}
_SCORE_CACHE_TTL = 1200  # 20 minutes

def _cache_key(title: str, price: float) -> str:
    import hashlib
    raw = f"{title.strip().lower()}|{price:.2f}"
    return hashlib.md5(raw.encode()).hexdigest()

def _cache_get(key: str):
    entry = _score_cache.get(key)
    if not entry:
        return None
    if _time.time() - entry["ts"] > _SCORE_CACHE_TTL:
        del _score_cache[key]
        return None
    return entry["payload"]

def _cache_set(key: str, payload: dict):
    # Evict oldest entries if cache grows too large
    if len(_score_cache) > 500:
        oldest = min(_score_cache, key=lambda k: _score_cache[k]["ts"])
        del _score_cache[oldest]
    _score_cache[key] = {"ts": _time.time(), "payload": payload}

app = FastAPI(
    title="Personal Shopping Bot API",
    description="AI-powered deal scoring for second-hand marketplace listings",
    version="0.1.0-poc",
)

# ── Rate Limiting ─────────────────────────────────────────────────────────────
# Simple in-memory IP rate limiter — no Redis needed for POC.
# Protects Claude API credits from abuse if someone discovers the Railway URL.
# Limits: 300 scores/hour per IP (covers active browsing sessions; blocks scrapers).
_rate_limit_store: dict = defaultdict(list)
RATE_LIMIT_REQUESTS = 200
RATE_LIMIT_WINDOW   = 86400  # seconds (24 hours)

def _check_rate_limit(client_ip: str):
    now = _time.time()
    window_start = now - RATE_LIMIT_WINDOW
    # Prune timestamps outside window
    _rate_limit_store[client_ip] = [
        t for t in _rate_limit_store[client_ip] if t > window_start
    ]
    if len(_rate_limit_store[client_ip]) >= RATE_LIMIT_REQUESTS:
        raise HTTPException(
            status_code=429,
            detail=f"Rate limit: {RATE_LIMIT_REQUESTS} scores per day. Try again tomorrow."
        )
    _rate_limit_store[client_ip].append(now)

# ── API Key Auth ───────────────────────────────────────────────────────────────
# Shared secret between the extension and the API.
# Extension sends: X-DS-Key: <value>
# If DS_API_KEY env var is not set, auth is skipped (dev mode).
_DS_API_KEY = os.getenv("DS_API_KEY", "")

def _check_api_key(request: Request):
    if not _DS_API_KEY:
        return  # dev mode — no key configured, skip check
    client_key = request.headers.get("X-DS-Key", "")
    if client_key != _DS_API_KEY:
        raise HTTPException(status_code=401, detail="Unauthorized")

# CORS — configurable via CORS_ORIGINS env var
#
# Content scripts run in the context of facebook.com, so every API request
# carries Origin: https://www.facebook.com. Popup requests carry the
# chrome-extension:// origin. Both must be allowed.
#
# Local dev:   CORS_ORIGINS not set → defaults to "*" (allow all)
# Production:  Set in Railway dashboard:
#   CORS_ORIGINS=https://www.facebook.com,chrome-extension://YOUR_EXTENSION_ID
#
# Get your extension ID from chrome://extensions after loading the unpacked
# extension. It stays stable once published to the Chrome Web Store.
_cors_raw = os.getenv("CORS_ORIGINS", "*")
cors_origins = ["*"] if _cors_raw.strip() == "*" else [
    o.strip() for o in _cors_raw.split(",") if o.strip()
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization", "X-DS-Key"],
)


# ── Request / Response Models ─────────────────────────────────────────────────

class ListingRequest(BaseModel):
    """
    What the React UI sends us.
    All fields except title and price are optional — we handle missing data gracefully.
    """
    title:          str
    price:          float
    raw_price_text: str  = ""
    description:    str  = ""
    location:       str  = ""
    condition:      str  = "Unknown"
    seller_name:    str  = ""
    listing_url:    str  = ""
    is_multi_item:  bool = False  # True for bundles/sets/lots — adjusts Claude's valuation logic
    is_vehicle:     bool = False  # True for motorcycles/cars/ATVs — suppresses irrelevant flags
    vehicle_details: Optional[dict] = None  # Structured vehicle attrs: mileage, transmission, title_status, owners
    seller_trust:   Optional[dict] = None   # Seller trust signals extracted by content script
    original_price: float = 0.0   # Crossed-out price if seller reduced it (from DOM dual-price container)
    shipping_cost:  float = 0.0   # Cost to ship — 0 means free or local pickup
    image_urls:     Optional[list] = None  # Listing photo URLs — first one sent to Claude Vision
    photo_count:    int  = 0               # True number of listing photos (carousel total, not just sent to API)
    platform:       str  = "facebook_marketplace"  # Source platform: facebook_marketplace | craigslist | ebay | offerup

    class Config:
        json_schema_extra = {
            "example": {
                "title":       "Orion SkyQuest XT8 Intelliscope Dobsonian Telescope",
                "price":       500.0,
                "raw_price_text": "$500",
                "description": "Like new condition, comes with solar filter and 3 eyepieces.",
                "location":    "Poway, CA",
                "condition":   "Used - Like New",
                "seller_name": "Tyler O'Connor-Hoy",
                "listing_url": "https://www.facebook.com/marketplace/item/123"
            }
        }


class RawListingRequest(BaseModel):
    """
    What the streaming /score/stream endpoint receives.
    The extension sends raw page text + DOM-extracted image URLs.
    Claude Haiku extracts all structured fields server-side.
    """
    raw_text:    str        # Truncated page text (max 4000 chars, client-side trimmed)
    image_urls:  list = []  # DOM-extracted image URLs (position-filtered, max 5)
    platform:    str = "facebook_marketplace"
    listing_url: str = ""


class DealScoreResponse(BaseModel):
    """
    What we send back to the React UI.
    Combines market value data + Claude's AI analysis into one response.
    """
    # Listing echo — so UI can display what was scored
    title:       str
    price:       float
    location:    str
    condition:   str

    # Market data (eBay or Google Shopping fallback)
    estimated_value:   float
    sold_avg:          float
    sold_count:        int
    sold_low:          float = 0.0   # Low end of price range
    sold_high:         float = 0.0   # High end of price range
    active_avg:        float
    active_low:        float = 0.0   # Lowest active listing price
    new_price:         float
    market_confidence: str
    data_source:       str = "ebay_live"  # "ebay_live" | "google_shopping" | "claude_knowledge" | "ebay_mock" | "correction_range" | "cargurus" | "craigslist"
    query_used:        str = ""       # The actual eBay/Google search query used for comps

    # Like Products — real eBay items surfaced as affiliate cards
    sold_items_sample:   list = []
    active_items_sample: list = []

    # DB row ID — returned so the extension can submit thumbs feedback
    score_id:          int   = 0

    # Claude's deal analysis
    score:             int
    verdict:           str
    summary:           str
    value_assessment:  str
    condition_notes:   str
    red_flags:         list[str]
    green_flags:       list[str]
    recommended_offer: float
    should_buy:        bool
    ai_confidence:     str
    model_used:        str
    image_analyzed:      bool  = False  # True when Claude Vision was used on listing photo
    affiliate_category:  str   = ""    # Category Claude picked for affiliate routing (e.g. "collectibles")
    negotiation_message: str   = ""    # Ready-to-copy buyer message — uses real price context
    bundle_items:        list  = []    # [{item, value}] breakdown for multi-item listings (empty if single item)
    original_price:      float = 0.0  # Seller's original price if reduced (strikethrough)
    shipping_cost:       float = 0.0  # Shipping cost extracted from listing (0 = free/pickup)

    # Product intelligence
    product_info:          dict = {}   # Extracted brand/model/search_query
    product_evaluation:    dict = {}   # Reliability tier, known issues
    affiliate_cards:       list = []   # Ranked affiliate recommendation cards
    buy_new_trigger:       bool = False
    buy_new_message:       str  = ""
    category_detected:     str  = ""
    # Gemini AI metadata — populated when data_source is gemini_search/gemini_knowledge
    ai_item_id:            str  = ""   # Product Gemini identified (e.g. "Celestron NexStar 6SE")
    ai_notes:              str  = ""   # Gemini's 1-sentence market context
    # Craigslist asking prices — supplementary comparison shown alongside eBay data
    craigslist_asking_avg:   float = 0.0
    craigslist_asking_low:   float = 0.0
    craigslist_asking_high:  float = 0.0
    craigslist_count:        int   = 0
    # Security scoring
    security_score:        dict = {}   # Scam/fraud risk assessment


# ── Endpoints ─────────────────────────────────────────────────────────────────

@app.get("/")
async def root():
    """Health check — confirms the API is running."""
    return {
        "status": "running",
        "service": "Personal Shopping Bot API",
        "version": "0.1.0-poc",
        "docs": f"http://localhost:{API_PORT}/docs",
    }


@app.post("/score", response_model=DealScoreResponse)
async def score_listing(listing: ListingRequest, request: Request):
    """
    Main endpoint — runs the full 5-step product intelligence pipeline.

    Step 1: Product extraction — Claude Haiku converts vague titles to specific queries
    Step 2: Parallel — eBay market value (extracted query) + product reliability eval
    Step 3: Claude deal scoring with reputation context injected into prompt
    Step 4: Suggestion engine — affiliate buy cards (same_cheaper / better_model / amazon)
    Step 5: Serialize and return
    """
    # Auth + rate limit — protects Claude API credits from abuse
    _check_api_key(request)
    client_ip = request.headers.get("x-forwarded-for", request.client.host if request.client else "unknown").split(",")[0].strip()
    _check_rate_limit(client_ip)

    log.info(f"Scoring request: '{listing.title}' @ ${listing.price}")
    _scoring_start_ts = _time.time()

    # ── Cache check ────────────────────────────────────────────────────────────
    _ck = _cache_key(listing.title, listing.price)
    _cached = _cache_get(_ck)
    if _cached:
        log.info(f"[Cache] HIT for '{listing.title}' @ ${listing.price} — returning cached score")
        return _cached  # intentionally not logged to score_log — only fresh scores are auditable

    # Guard: reject obviously bad titles that indicate a broken extraction
    _generic_titles = {"marketplace", "facebook marketplace", "facebook", "craigslist", "offerup", ""}
    if (listing.title or "").strip().lower() in _generic_titles:
        raise HTTPException(
            status_code=422,
            detail="Could not read the listing title — please wait for the page to fully load and try again."
        )

    # ── Step 1+2: OVERLAPPED — product extraction + preliminary eBay ────────────
    # WHY OVERLAP: product extraction (Haiku, ~1s) and eBay (~2-3s) were sequential.
    # We now launch both at the same time using the raw title as the preliminary eBay
    # query. When extraction finishes:
    #   • If extracted_query ≈ raw_title → eBay result is already waiting, 0 extra cost.
    #   • If extracted_query differs significantly → run a second refined eBay call.
    #     eBay has its own in-memory cache, so near-duplicate queries are instant.
    # This saves 1-2s on every score without any accuracy tradeoff.
    from scoring.product_extractor import _fallback_extraction

    raw_title_query = listing.title.strip()

    try:
        product_info, prelim_market, product_eval = await asyncio.gather(
            extract_product(listing.title, listing.description),
            get_market_value(
                listing_title     = raw_title_query,
                listing_condition = listing.condition,
                is_vehicle        = listing.is_vehicle,
                listing_price     = listing.price,
            ),
            evaluate_product(brand="", model="", category="", display_name=listing.title),
            return_exceptions=True,
        )
    except Exception as e:
        log.error(f"Parallel step 1+2 failed: {e}")
        raise HTTPException(status_code=500, detail=f"Initial data fetch failed: {e}")

    # Unpack exceptions from inner gather
    if isinstance(product_info, Exception):
        log.warning(f"Product extraction failed ({product_info}) — using title fallback")
        product_info = _fallback_extraction(listing.title)

    if isinstance(prelim_market, Exception):
        log.error(f"Preliminary eBay failed: {prelim_market}")
        raise HTTPException(status_code=500, detail=f"Market value lookup failed: {prelim_market}")

    if isinstance(product_eval, Exception):
        log.warning(f"Product evaluation failed ({product_eval}) — continuing without")
        from scoring.product_evaluator import _unknown_evaluation
        product_eval = _unknown_evaluation(product_info.display_name)

    # If extraction produced a meaningfully better query, refine eBay now.
    # "Meaningfully better" = not just whitespace/case difference.
    # eBay has its own cache so if the same query was recently used, this is instant.
    extracted_q = (product_info.search_query or "").strip().lower()
    raw_q       = raw_title_query.lower()
    # Skip refinement if eBay is rate-limited — a refined query returns the same
    # mock data, so the extra round-trip wastes 1-2s with zero accuracy gain.
    _ebay_mocked = getattr(prelim_market, "data_source", "") == "ebay_mock"
    need_refine = extracted_q and extracted_q != raw_q and len(extracted_q) > 4 and not _ebay_mocked
    if _ebay_mocked and extracted_q != raw_q:
        log.info(f"[Speed] Skipping eBay refinement — circuit open, mock data unchanged")

    try:
        if need_refine:
            log.info(f"[Speed] Refining eBay: '{raw_title_query}' → '{product_info.search_query}'")
            market_value = await get_market_value(
                listing_title     = product_info.search_query,
                listing_condition = listing.condition,
                is_vehicle        = listing.is_vehicle,
                listing_price     = listing.price,
            )
        else:
            log.info(f"[Speed] Using preliminary eBay result for '{raw_title_query}'")
            market_value = prelim_market
    except Exception as e:
        log.error(f"Refinement step failed: {e}")
        market_value = prelim_market  # fall back to preliminary result

    # FIX: Always re-run product evaluation with the correct brand/model once extracted.
    # Previously gated on `need_refine` — meaning it never ran when eBay was mocked,
    # causing reliabilityTier to always be "unknown" (preliminary call uses brand="").
    if product_info.brand:
        try:
            product_eval = await evaluate_product(
                brand        = product_info.brand,
                model        = product_info.model,
                category     = product_info.category,
                display_name = product_info.display_name,
            )
        except Exception as _eval_err:
            log.warning(f"Product eval refinement failed: {_eval_err}")

    # ── Step 3: Claude deal scoring ──────────────────────────────────────────
    from dataclasses import asdict as dc_asdict
    market_value_dict = dc_asdict(market_value)

    listing_dict = {
        "title":          listing.title,
        "price":          listing.price,
        "raw_price_text": listing.raw_price_text or f"${listing.price:.0f}",
        "description":    listing.description,
        "location":       listing.location,
        "condition":      listing.condition,
        "seller_name":    listing.seller_name,
        "listing_url":    listing.listing_url,
        "is_multi_item":  listing.is_multi_item,
        "is_vehicle":     listing.is_vehicle,
        "vehicle_details": listing.vehicle_details or {},
        "seller_trust":   listing.seller_trust,
        "original_price": listing.original_price,
        "shipping_cost":  listing.shipping_cost,
        "image_urls":     listing.image_urls or [],
        "photo_count":    listing.photo_count,
    }

    image_url = listing.image_urls[0] if listing.image_urls else None

    # ── Step 3 + 4b: Deal scoring AND security scoring run concurrently ─────────
    # WHY: security scoring is an independent Haiku call (~2s) that only needs
    # the listing + market_value — it doesn't depend on the deal score.
    # Launching it as a task at the same time as score_deal() (which includes
    # Claude vision at ~8-10s) means it finishes while vision is still running,
    # cutting ~2s from the total wall-clock time.
    # We use keyword-based category for security (fast, available now).
    # The final category from Claude may differ slightly but security accuracy
    # is not meaningfully affected by general vs specific category.
    from scoring.affiliate_router import detect_category, CATEGORY_PROGRAMS
    _prelim_category = detect_category(product_info)
    if listing.is_vehicle:
        _prelim_category = "vehicles"

    _security_task = asyncio.create_task(
        asyncio.wait_for(
            score_security(
                listing          = listing,
                category         = _prelim_category,
                market_value     = market_value,
                normalized_title = product_info.display_name,
            ),
            timeout=10.0,
        )
    )

    try:
        deal_score = await score_deal(
            listing_dict,
            market_value_dict,
            image_url          = image_url,
            product_evaluation = product_eval,
            photo_count        = listing.photo_count,
        )
    except RuntimeError as e:
        _security_task.cancel()
        real_error = str(e)
        log.error(f"Scoring failed: {real_error}")
        raise HTTPException(status_code=500, detail=real_error)
    except Exception as e:
        _security_task.cancel()
        log.error(f"Unexpected scoring exception: {type(e).__name__}: {e}")
        raise HTTPException(status_code=500, detail=f"{type(e).__name__}: {e}")

    if not deal_score:
        _security_task.cancel()
        raise HTTPException(status_code=500, detail="Scorer returned no result — check API terminal")

    log.info(f"Score: {deal_score.score}/10 — {deal_score.verdict}")

    # ── Score cap: listing priced at or above new retail ────────────────────────
    # WHY: Claude may still give a 6+ even when the listing is priced above new
    # retail (e.g. seller claims "new in box"). From a buyer's standpoint, paying
    # used-market price AT OR ABOVE new retail is objectively bad — no discount,
    # no warranty, no return protection. We hard-cap the score here so the UI
    # never shows "FAIR DEAL / Solid Deal — Confirm Price" for such listings.
    # Only applies when new_price is real data (not mock / zero).
    _np = market_value.new_price
    _lp = listing.price
    if _np > 0 and market_value.data_source not in ("ebay_mock",):
        _ratio = _lp / _np
        if _ratio >= 1.0 and deal_score.score > 4:
            log.info(
                f"[ScoreCap] Asking ${_lp:.0f} >= new retail ${_np:.0f} "
                f"— capping score {deal_score.score} → 4"
            )
            deal_score.score     = min(deal_score.score, 4)
            deal_score.should_buy = False
        elif _ratio >= 0.85 and deal_score.score > 5:
            log.info(
                f"[ScoreCap] Asking ${_lp:.0f} is {_ratio*100:.0f}% of new retail ${_np:.0f} "
                f"— capping score {deal_score.score} → 5"
            )
            deal_score.score     = min(deal_score.score, 5)
            deal_score.should_buy = False

    # ── Step 4: Generate affiliate recommendations ──────────────────────────────
    # Category detection priority:
    #   1. Claude's affiliate_category field (set by the scoring LLM — most accurate)
    #      Exception A: "general" is never accepted from Claude — it's the no-match
    #        fallback and causes the worst affiliate results. Fall back to keyword.
    #      Exception B: "soft" categories (outdoor/home/sports/camping) are overridden
    #        by keyword detection when keyword gives a more specific result. Prevents
    #        Claude returning "outdoor" for a lawnmower (→ REI) instead of "tools"
    #        (→ Home Depot/Lowes).
    #   2. is_vehicle override (content script explicitly flagged this as a vehicle)
    #   3. Keyword-based detect_category() (fast fallback for when Claude omits the field)
    _SOFT_CATS        = {"outdoor", "home", "sports", "camping"}
    _valid_categories = set(CATEGORY_PROGRAMS.keys())   # "general" intentionally excluded
    claude_category   = (deal_score.affiliate_category or "").strip().lower()
    if claude_category and claude_category in _valid_categories:
        # Accept Claude's category unless it's soft AND keyword gives something better
        if claude_category in _SOFT_CATS and _prelim_category not in _SOFT_CATS and _prelim_category != "general":
            log.info(f"[Category] Claude soft '{claude_category}' overridden by keyword '{_prelim_category}'")
            category_detected = _prelim_category
        else:
            category_detected = claude_category
            log.info(f"[Category] Claude → '{category_detected}'")
    else:
        if claude_category:
            log.warning(f"[Category] Claude returned '{claude_category}' (unknown or 'general') — falling back to keyword detection")
        category_detected = _prelim_category
        log.info(f"[Category] Keyword → '{category_detected}'")

    if listing.is_vehicle and category_detected not in ("vehicles", "cars", "trucks"):
        log.info(f"[Category] is_vehicle override: '{category_detected}' → 'vehicles'")
        category_detected = "vehicles"

    try:
        affiliate_cards = get_affiliate_recommendations(
            product_info      = product_info,
            listing_price     = listing.price,
            shipping_cost     = listing.shipping_cost,
            deal_score        = deal_score,
            market_value      = market_value,
            max_cards         = 3,
            category_override = category_detected,  # pass pre-computed (may be vehicle override)
        )
    except Exception as e:
        log.warning(f"Affiliate router failed ({e}) — returning empty cards")
        affiliate_cards = []

    # Buy-new trigger check
    # data_source guard: suppress for "ebay_mock" — mock prices are rough estimates,
    # not real market data. iPhone 15 Pro mock base=$350 vs real new ~$1100.
    buy_new, buy_new_msg = should_trigger_buy_new(
        listing_price = listing.price + listing.shipping_cost,
        new_price     = market_value.new_price,
        is_vehicle    = listing.is_vehicle,   # suppress for vehicles: eBay new_price = parts
        data_source   = market_value.data_source,  # suppress for mock data
    )

    # ── Step 4b: Await security task (was started concurrently with score_deal) ──
    # By the time we get here, score_deal() took ~8-10s, so security (~2s) is
    # almost certainly already done — this await is effectively instant.
    try:
        security = await _security_task
    except Exception as e:
        import traceback
        log.warning(f"Security scoring failed: {traceback.format_exc()}")
        from scoring.security_scorer import SecurityScore as _SS, _score_to_risk, _score_to_recommendation
        security = _SS(score=5, risk_level=_score_to_risk(5), flags=[], recommendation=_score_to_recommendation(5))

    # ── Step 4c: Security-based score cap ────────────────────────────────────
    _sec_score = getattr(security, 'score', 5)
    if _sec_score <= 3 and deal_score.score > 5:
        deal_score.score = min(deal_score.score, 5)
        deal_score.should_buy = False
        if not deal_score.red_flags:
            deal_score.red_flags = []
        deal_score.red_flags.insert(0, f"Score capped due to high security risk (security {_sec_score}/10)")
        log.info(f"[SecurityCap] Score capped to {deal_score.score} (security={_sec_score})")
    elif _sec_score <= 4 and deal_score.score > 6:
        deal_score.score = min(deal_score.score, 6)
        log.info(f"[SecurityCap] Score capped to {deal_score.score} (security={_sec_score})")

    # ── Step 5: Serialize ────────────────────────────────────────────────────
    from dataclasses import asdict as dc_asdict
    sold_items_sample   = [dc_asdict(i) for i in (market_value.sold_items_sample   or [])]
    active_items_sample = [dc_asdict(i) for i in (market_value.active_items_sample or [])]
    affiliate_dicts     = [dc_asdict(c) for c in affiliate_cards]

    response = DealScoreResponse(
        # Listing
        title          = listing.title,
        price          = listing.price,
        location       = listing.location,
        condition      = listing.condition,
        original_price = listing.original_price,
        shipping_cost  = listing.shipping_cost,

        # Market value
        estimated_value     = market_value.estimated_value,
        sold_avg            = market_value.sold_avg,
        sold_count          = market_value.sold_count,
        sold_low            = market_value.sold_low,
        sold_high           = market_value.sold_high,
        active_avg          = market_value.active_avg,
        active_low          = market_value.active_low,
        new_price           = market_value.new_price,
        market_confidence   = market_value.confidence,
        data_source         = market_value.data_source,
        query_used          = market_value.query_used,
        sold_items_sample   = sold_items_sample,
        active_items_sample = active_items_sample,

        # Deal score
        score             = deal_score.score,
        verdict           = deal_score.verdict,
        summary           = deal_score.summary,
        value_assessment  = deal_score.value_assessment,
        condition_notes   = deal_score.condition_notes,
        red_flags         = deal_score.red_flags,
        green_flags       = deal_score.green_flags,
        recommended_offer = deal_score.recommended_offer,
        should_buy        = deal_score.should_buy,
        ai_confidence     = deal_score.confidence,
        model_used          = deal_score.model_used,
        image_analyzed      = deal_score.image_analyzed,
        affiliate_category  = deal_score.affiliate_category,
        negotiation_message = deal_score.negotiation_message,
        bundle_items        = deal_score.bundle_items or [],

        # Product intelligence + affiliate
        product_info       = dc_asdict_top(product_info),
        product_evaluation = dc_asdict_top(product_eval),
        affiliate_cards    = affiliate_dicts,
        buy_new_trigger    = buy_new,
        buy_new_message    = buy_new_msg,
        category_detected  = category_detected,
        security_score     = dc_asdict_top(security),
        # Gemini AI metadata
        ai_item_id         = market_value.ai_item_id,
        ai_notes           = market_value.ai_notes,
        # Craigslist asking prices (supplementary comparison)
        craigslist_asking_avg   = market_value.craigslist_avg,
        craigslist_asking_low   = market_value.craigslist_low,
        craigslist_asking_high  = market_value.craigslist_high,
        craigslist_count        = market_value.craigslist_count,
    )

    # ── Step 6: Save full score to deal_scores for feedback/replay ───────────
    score_id = 0
    try:
        from scoring.data_pipeline import _get_pool
        pool = await _get_pool()
        if pool:
            # eBay comps: sold items used to calculate the market average —
            # stored in their own column so training queries can join on them
            # without parsing the entire score_json blob.
            _ebay_comps = {
                "sold":   sold_items_sample,
                "active": active_items_sample,
                "query":  market_value.search_query if hasattr(market_value, "search_query") else "",
                "data_source": market_value.data_source if hasattr(market_value, "data_source") else "",
            }

            # Affiliate impressions: each card shown, in display order.
            # Captures what was offered (not just what was clicked) for CTR training.
            _affil_impressions = [
                {
                    "position":        idx + 1,
                    "program_key":     c.get("program_key", ""),
                    "card_type":       c.get("card_type", ""),
                    "selection_reason": c.get("reason", ""),
                    "commission_live": c.get("commission_live", False),
                    "estimated_revenue": c.get("estimated_revenue", 0.0),
                    "price_hint":      c.get("price_hint", ""),
                }
                for idx, c in enumerate(affiliate_dicts)
            ]

            row = await pool.fetchrow(
                """INSERT INTO deal_scores
                   (platform, listing_url, listing_json, score_json, score,
                    ebay_comps_json, affiliate_impressions_json)
                   VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $6::jsonb, $7::jsonb)
                   RETURNING id""",
                listing.platform or "unknown",
                listing.listing_url or "",
                _json.dumps(listing.model_dump()),
                _json.dumps(response.model_dump()),
                deal_score.score,
                _json.dumps(_ebay_comps),
                _json.dumps(_affil_impressions),
            )
            if row:
                score_id = row["id"]
                response = response.model_copy(update={"score_id": score_id})
    except Exception as _db_err:
        log.warning(f"[deal_scores] save failed (non-fatal): {_db_err}")

    # ── Step 6b: Save full scorecard to score_log (non-blocking) ────────────
    try:
        _ext_ver = request.headers.get("x-ds-ext-version") or request.headers.get("x-extension-version")
        _scorecard = _build_scorecard(
            listing=listing, deal_score=deal_score, market_value=market_value,
            security=security, product_info=product_info, product_eval=product_eval,
            affiliate_dicts=affiliate_dicts, category_detected=category_detected,
            buy_new=buy_new, buy_new_msg=buy_new_msg,
            sold_items_sample=sold_items_sample, active_items_sample=active_items_sample,
            scoring_start_ts=_scoring_start_ts,
            extension_version=_ext_ver,
        )
        asyncio.create_task(_save_score_log(_scorecard))
    except Exception:
        pass

    # ── Step 7: Record anonymized market signal (non-blocking) ────────────────
    # Fires as a background task — API response is returned immediately.
    # Any DB error is swallowed inside record_signal; it never affects the user.
    try:
        from scoring.data_pipeline import record_signal
        _loc_parts  = [p.strip() for p in (listing.location or "").split(",")]
        _city       = _loc_parts[0] if _loc_parts else ""
        _state      = _loc_parts[1][:2].upper() if len(_loc_parts) > 1 else ""
        _gap_pct    = 0.0
        if market_value.sold_avg and market_value.sold_avg > 0:
            _gap_pct = round((listing.price - market_value.sold_avg) / market_value.sold_avg * 100, 1)
        _affil_shown = ",".join(c.get("program_key", "") for c in affiliate_dicts)
        asyncio.create_task(record_signal(
            category         = category_detected or "",
            item_label       = (market_value.ai_item_id or listing.title or "")[:120],
            condition        = listing.condition or "",
            city             = _city,
            state_code       = _state,
            asking_price     = listing.price,
            ebay_sold_avg    = market_value.sold_avg,
            ebay_active_avg  = market_value.active_avg,
            new_price        = market_value.new_price,
            cl_asking_avg    = market_value.craigslist_avg,
            price_gap_pct    = _gap_pct,
            deal_score       = deal_score.score,
            buy_new_trigger  = bool(buy_new),
            affiliate_programs = _affil_shown,
            platform         = listing.platform or "facebook_marketplace",
        ))
    except Exception:
        pass  # Signal recording must never affect the API response

    # ── Step 8: Background query validation (Task 4 — zero latency) ──────────
    # After the response is returned, Claude checks whether the eBay results
    # were actually relevant to this listing. If not, it auto-saves a correction
    # so NEXT TIME this type of listing is scored it uses the better query.
    # WHY asyncio.create_task: the result doesn't affect the current response —
    # this is purely a learning signal for future accuracy. Zero user wait time.
    try:
        _sample_titles = [s.get("title", "") for s in sold_items_sample[:3] if s.get("title")]
        _qused = market_value.query_used if market_value else ""
        if _qused and _sample_titles:
            asyncio.create_task(
                _validate_query_background(
                    listing_title  = listing.title,
                    query_used     = _qused,
                    sample_titles  = _sample_titles,
                )
            )
    except Exception:
        pass  # Validator must never block or crash the response

    # ── Cache the result for 20 min ──────────────────────────────────────────
    _cache_set(_ck, response)

    return response


# ── Streaming Endpoint ────────────────────────────────────────────────────────
# POST /score/stream — receives raw page text + DOM image URLs, runs the full
# pipeline, and streams SSE events back to the extension.
#
# SSE event types:
#   extracted  — Claude Haiku extracted structured listing data (t ≈ 1s)
#                Extension shows the panel with title/price immediately.
#   progress   — Pipeline step label (e.g. "Checking eBay market prices…")
#   score      — Complete DealScoreResponse dict (t ≈ 10–12s)
#   error      — Something went wrong; extension shows error state.
#
# WHY STREAMING:
#   The existing /score endpoint returns after 10-12 seconds with the full result.
#   Users see a spinner for 10 seconds with no feedback.
#   With streaming, the panel appears at t≈1s showing the listing title/price
#   and a progress label, then the full score arrives at t≈10-12s.
#   This makes the extension feel dramatically faster without changing back-end speed.

@app.post("/score/stream")
async def score_listing_stream(raw: RawListingRequest, request: Request):
    """
    Streaming deal-score endpoint using Server-Sent Events.
    Extension sends raw page text; Claude extracts fields then runs the full pipeline.
    """
    _check_api_key(request)
    client_ip = request.headers.get(
        "x-forwarded-for", request.client.host if request.client else "unknown"
    ).split(",")[0].strip()
    _check_rate_limit(client_ip)

    from scoring.listing_extractor import extract_listing_from_text
    from scoring.product_extractor import _fallback_extraction
    from scoring.affiliate_router import detect_category, CATEGORY_PROGRAMS
    from dataclasses import asdict as _dc_asdict

    def _sse(obj: dict) -> str:
        return f"data: {_json.dumps(obj)}\n\n"

    async def event_stream():
        _stream_scoring_start = _time.time()
        try:
            # ── Step 1: Claude Haiku extracts structured listing data ─────────
            extracted = await extract_listing_from_text(
                raw_text=raw.raw_text,
                platform=raw.platform,
                url=raw.listing_url,
            )

            # Merge DOM image_urls (position-filtered by the content script — better
            # than any URL Claude could infer from text).
            extracted["image_urls"] = raw.image_urls or []
            extracted["listing_url"] = raw.listing_url
            extracted["platform"]    = raw.platform
            extracted.setdefault("photo_count", len(raw.image_urls or []))

            title     = extracted.get("title", "").strip()
            price_raw = extracted.get("price")          # None means truly unknown
            price     = float(price_raw if price_raw is not None else 0)

            # price_raw is None only when Claude found no price at all.
            # price_raw == 0 means the item is FREE — that is valid, not an error.
            if not title or price_raw is None:
                yield _sse({"type": "error",
                            "message": "Could not read listing — page may still be loading"})
                return

            # Build seller_trust from extracted seller fields
            seller_trust = None
            if extracted.get("seller_joined") or extracted.get("seller_rating"):
                seller_trust = {
                    "joined_date":  extracted.get("seller_joined"),
                    "rating":       extracted.get("seller_rating"),
                    "rating_count": extracted.get("seller_rating_count", 0) or 0,
                }

            # Send extracted data immediately — panel shows title/price now
            yield _sse({"type": "extracted", "data": extracted})

            # ── Cache check ──────────────────────────────────────────────────
            _ck = _cache_key(title, price)
            _cached = _cache_get(_ck)
            if _cached:
                log.info(f"[Stream Cache] HIT for '{title}'")
                yield _sse({"type": "score", "data": _cached})
                return  # intentionally not logged to score_log — only fresh scores are auditable

            # Guard: reject generic titles
            _generic = {"marketplace", "facebook marketplace", "facebook",
                        "craigslist", "offerup", "ebay", ""}
            if title.lower() in _generic:
                yield _sse({"type": "error",
                            "message": "Could not read the listing title — wait for the page to fully load"})
                return

            # Build ListingRequest from extracted data
            listing = ListingRequest(
                title          = title,
                price          = price,
                raw_price_text = f"${price:.0f}",
                description    = extracted.get("description", ""),
                location       = extracted.get("location", ""),
                condition      = extracted.get("condition", "Unknown"),
                seller_name    = extracted.get("seller_name", ""),
                listing_url    = raw.listing_url,
                is_multi_item  = bool(extracted.get("is_multi_item", False)),
                is_vehicle     = bool(extracted.get("is_vehicle", False)),
                vehicle_details = None,
                seller_trust   = seller_trust,
                original_price = float(extracted.get("original_price", 0) or 0),
                shipping_cost  = float(extracted.get("shipping_cost", 0) or 0),
                image_urls     = raw.image_urls or [],
                photo_count    = int(extracted.get("photo_count", 0) or len(raw.image_urls or [])),
                platform       = raw.platform,
            )

            log.info(f"[Stream] Scoring '{listing.title}' @ ${listing.price}")

            # ── Step 2: Product extraction + eBay + product eval (concurrent) ─
            yield _sse({"type": "progress", "label": "Checking eBay market prices…"})

            raw_title_query = listing.title.strip()
            product_info, prelim_market, product_eval = await asyncio.gather(
                extract_product(listing.title, listing.description),
                get_market_value(
                    listing_title     = raw_title_query,
                    listing_condition = listing.condition,
                    is_vehicle        = listing.is_vehicle,
                    listing_price     = listing.price,
                ),
                evaluate_product(brand="", model="", category="", display_name=listing.title),
                return_exceptions=True,
            )

            if isinstance(product_info, Exception):
                log.warning(f"[Stream] Product extraction failed ({product_info})")
                product_info = _fallback_extraction(listing.title)

            if isinstance(prelim_market, Exception):
                yield _sse({"type": "error",
                            "message": f"Market value lookup failed: {prelim_market}"})
                return

            if isinstance(product_eval, Exception):
                from scoring.product_evaluator import _unknown_evaluation
                product_eval = _unknown_evaluation(product_info.display_name)

            # eBay refinement + product eval refinement (concurrent when both needed)
            extracted_q  = (product_info.search_query or "").strip().lower()
            raw_q        = raw_title_query.lower()
            _ebay_mocked = getattr(prelim_market, "data_source", "") == "ebay_mock"
            need_refine  = extracted_q and extracted_q != raw_q and len(extracted_q) > 4 and not _ebay_mocked
            need_eval_refine = bool(product_info.brand)

            if need_refine and need_eval_refine:
                _refine_market_task = get_market_value(
                    listing_title     = product_info.search_query,
                    listing_condition = listing.condition,
                    is_vehicle        = listing.is_vehicle,
                    listing_price     = listing.price,
                )
                _refine_eval_task = evaluate_product(
                    brand        = product_info.brand,
                    model        = product_info.model,
                    category     = product_info.category,
                    display_name = product_info.display_name,
                )
                _ref_results = await asyncio.gather(
                    _refine_market_task, _refine_eval_task, return_exceptions=True,
                )
                if isinstance(_ref_results[0], Exception):
                    log.warning(f"[Stream] eBay refinement failed: {_ref_results[0]}")
                    market_value = prelim_market
                else:
                    market_value = _ref_results[0]
                if isinstance(_ref_results[1], Exception):
                    log.warning(f"[Stream] Product eval refinement failed: {_ref_results[1]}")
                else:
                    product_eval = _ref_results[1]
            else:
                if need_refine:
                    try:
                        market_value = await get_market_value(
                            listing_title     = product_info.search_query,
                            listing_condition = listing.condition,
                            is_vehicle        = listing.is_vehicle,
                            listing_price     = listing.price,
                        )
                    except Exception as _ref_err:
                        log.warning(f"[Stream] eBay refinement failed: {_ref_err}")
                        market_value = prelim_market
                else:
                    market_value = prelim_market

                if need_eval_refine:
                    try:
                        product_eval = await evaluate_product(
                            brand        = product_info.brand,
                            model        = product_info.model,
                            category     = product_info.category,
                            display_name = product_info.display_name,
                        )
                    except Exception as _eval_err:
                        log.warning(f"[Stream] Product eval refinement failed: {_eval_err}")

            # ── Step 3: Deal scoring + security (concurrent) ─────────────────
            yield _sse({"type": "progress", "label": "AI deal analysis in progress…"})

            market_value_dict = _dc_asdict(market_value)
            listing_dict = {
                "title":          listing.title,
                "price":          listing.price,
                "raw_price_text": listing.raw_price_text or f"${listing.price:.0f}",
                "description":    listing.description,
                "location":       listing.location,
                "condition":      listing.condition,
                "seller_name":    listing.seller_name,
                "listing_url":    listing.listing_url,
                "is_multi_item":  listing.is_multi_item,
                "is_vehicle":     listing.is_vehicle,
                "vehicle_details": listing.vehicle_details or {},
                "seller_trust":   listing.seller_trust,
                "original_price": listing.original_price,
                "shipping_cost":  listing.shipping_cost,
                "image_urls":     listing.image_urls or [],
                "photo_count":    listing.photo_count,
            }
            image_url = listing.image_urls[0] if listing.image_urls else None

            _prelim_category = detect_category(product_info)
            if listing.is_vehicle:
                _prelim_category = "vehicles"

            _security_task = asyncio.create_task(
                asyncio.wait_for(
                    score_security(
                        listing          = listing,
                        category         = _prelim_category,
                        market_value     = market_value,
                        normalized_title = product_info.display_name,
                    ),
                    timeout=10.0,
                )
            )

            try:
                deal_score = await score_deal(
                    listing_dict, market_value_dict,
                    image_url          = image_url,
                    product_evaluation = product_eval,
                    photo_count        = listing.photo_count,
                )
            except Exception as _score_err:
                _security_task.cancel()
                yield _sse({"type": "error", "message": str(_score_err)})
                return

            if not deal_score:
                _security_task.cancel()
                yield _sse({"type": "error", "message": "Scorer returned no result"})
                return

            log.info(f"[Stream] Score: {deal_score.score}/10 — {deal_score.verdict}")

            # Score cap
            _np = market_value.new_price
            _lp = listing.price
            if _np > 0 and market_value.data_source not in ("ebay_mock",):
                _ratio = _lp / _np
                if _ratio >= 1.0 and deal_score.score > 4:
                    deal_score.score     = min(deal_score.score, 4)
                    deal_score.should_buy = False
                elif _ratio >= 0.85 and deal_score.score > 5:
                    deal_score.score     = min(deal_score.score, 5)
                    deal_score.should_buy = False

            # ── Step 4: Affiliate + security ──────────────────────────────────
            _SOFT_CATS_s  = {"outdoor", "home", "sports", "camping"}
            _valid_cats   = set(CATEGORY_PROGRAMS.keys())  # "general" excluded intentionally
            claude_cat    = (deal_score.affiliate_category or "").strip().lower()
            if claude_cat and claude_cat in _valid_cats:
                if claude_cat in _SOFT_CATS_s and _prelim_category not in _SOFT_CATS_s and _prelim_category != "general":
                    category_detected = _prelim_category
                else:
                    category_detected = claude_cat
            else:
                category_detected = _prelim_category
            if listing.is_vehicle and category_detected not in ("vehicles", "cars", "trucks"):
                category_detected = "vehicles"

            try:
                affiliate_cards = get_affiliate_recommendations(
                    product_info      = product_info,
                    listing_price     = listing.price,
                    shipping_cost     = listing.shipping_cost,
                    deal_score        = deal_score,
                    market_value      = market_value,
                    max_cards         = 3,
                    category_override = category_detected,
                )
            except Exception:
                affiliate_cards = []

            buy_new, buy_new_msg = should_trigger_buy_new(
                listing_price = listing.price + listing.shipping_cost,
                new_price     = market_value.new_price,
                is_vehicle    = listing.is_vehicle,
                data_source   = market_value.data_source,
            )

            try:
                security = await _security_task
            except Exception:
                from scoring.security_scorer import SecurityScore as _SS, _score_to_risk, _score_to_recommendation
                security = _SS(score=5, risk_level=_score_to_risk(5), flags=[], recommendation=_score_to_recommendation(5))

            # ── Step 4b: Security-based score cap ────────────────────────────
            _sec_score = getattr(security, 'score', 5)
            if _sec_score <= 3 and deal_score.score > 5:
                deal_score.score = min(deal_score.score, 5)
                deal_score.should_buy = False
                if not deal_score.red_flags:
                    deal_score.red_flags = []
                deal_score.red_flags.insert(0, f"Score capped due to high security risk (security {_sec_score}/10)")
                log.info(f"[SecurityCap] Score capped to {deal_score.score} (security={_sec_score})")
            elif _sec_score <= 4 and deal_score.score > 6:
                deal_score.score = min(deal_score.score, 6)
                log.info(f"[SecurityCap] Score capped to {deal_score.score} (security={_sec_score})")

            # ── Step 5: Serialize ─────────────────────────────────────────────
            sold_items_sample   = [_dc_asdict(i) for i in (market_value.sold_items_sample   or [])]
            active_items_sample = [_dc_asdict(i) for i in (market_value.active_items_sample or [])]
            affiliate_dicts     = [_dc_asdict(c) for c in affiliate_cards]

            response = DealScoreResponse(
                title             = listing.title,
                price             = listing.price,
                location          = listing.location,
                condition         = listing.condition,
                original_price    = listing.original_price,
                shipping_cost     = listing.shipping_cost,
                estimated_value   = market_value.estimated_value,
                sold_avg          = market_value.sold_avg,
                sold_count        = market_value.sold_count,
                sold_low          = market_value.sold_low,
                sold_high         = market_value.sold_high,
                active_avg        = market_value.active_avg,
                active_low        = market_value.active_low,
                new_price         = market_value.new_price,
                market_confidence = market_value.confidence,
                data_source       = market_value.data_source,
                query_used        = market_value.query_used,
                sold_items_sample   = sold_items_sample,
                active_items_sample = active_items_sample,
                score               = deal_score.score,
                verdict             = deal_score.verdict,
                summary             = deal_score.summary,
                value_assessment    = deal_score.value_assessment,
                condition_notes     = deal_score.condition_notes,
                red_flags           = deal_score.red_flags,
                green_flags         = deal_score.green_flags,
                recommended_offer   = deal_score.recommended_offer,
                should_buy          = deal_score.should_buy,
                ai_confidence       = deal_score.confidence,
                model_used          = deal_score.model_used,
                image_analyzed      = deal_score.image_analyzed,
                affiliate_category  = deal_score.affiliate_category,
                negotiation_message = deal_score.negotiation_message,
                bundle_items        = deal_score.bundle_items or [],
                product_info        = dc_asdict_top(product_info),
                product_evaluation  = dc_asdict_top(product_eval),
                affiliate_cards     = affiliate_dicts,
                buy_new_trigger     = buy_new,
                buy_new_message     = buy_new_msg,
                category_detected   = category_detected,
                security_score      = dc_asdict_top(security),
                ai_item_id          = market_value.ai_item_id,
                ai_notes            = market_value.ai_notes,
                craigslist_asking_avg   = market_value.craigslist_avg,
                craigslist_asking_low   = market_value.craigslist_low,
                craigslist_asking_high  = market_value.craigslist_high,
                craigslist_count        = market_value.craigslist_count,
            )

            # DB save (non-fatal)
            score_id = 0
            try:
                from scoring.data_pipeline import _get_pool
                pool = await _get_pool()
                if pool:
                    _ebay_comps = {
                        "sold": sold_items_sample, "active": active_items_sample,
                        "query": market_value.query_used, "data_source": market_value.data_source,
                    }
                    _affil_impr = [
                        {"position": idx+1, "program_key": c.get("program_key",""),
                         "card_type": c.get("card_type",""), "selection_reason": c.get("reason",""),
                         "commission_live": c.get("commission_live", False),
                         "estimated_revenue": c.get("estimated_revenue", 0.0),
                         "price_hint": c.get("price_hint","")}
                        for idx, c in enumerate(affiliate_dicts)
                    ]
                    row = await pool.fetchrow(
                        """INSERT INTO deal_scores
                           (platform, listing_url, listing_json, score_json, score,
                            ebay_comps_json, affiliate_impressions_json)
                           VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $6::jsonb, $7::jsonb)
                           RETURNING id""",
                        listing.platform or "unknown",
                        listing.listing_url or "",
                        _json.dumps(listing.model_dump()),
                        _json.dumps(response.model_dump()),
                        deal_score.score,
                        _json.dumps(_ebay_comps),
                        _json.dumps(_affil_impr),
                    )
                    if row:
                        score_id = row["id"]
                        response = response.model_copy(update={"score_id": score_id})
            except Exception as _db_err:
                log.warning(f"[Stream] deal_scores save failed (non-fatal): {_db_err}")

            response_dict = response.model_dump()
            _cache_set(_ck, response_dict)

            # ── Send the final score ──────────────────────────────────────────
            yield _sse({"type": "score", "data": response_dict})

            # Save full scorecard to score_log (fire and forget)
            try:
                _stream_ext_ver = request.headers.get("x-ds-ext-version") or request.headers.get("x-extension-version")
                _scorecard = _build_scorecard(
                    listing=listing, deal_score=deal_score, market_value=market_value,
                    security=security, product_info=product_info, product_eval=product_eval,
                    affiliate_dicts=affiliate_dicts, category_detected=category_detected,
                    buy_new=buy_new, buy_new_msg=buy_new_msg,
                    sold_items_sample=sold_items_sample, active_items_sample=active_items_sample,
                    scoring_start_ts=_stream_scoring_start,
                    extension_version=_stream_ext_ver,
                )
                asyncio.create_task(_save_score_log(_scorecard))
            except Exception:
                pass

            # Background analytics (fire and forget)
            try:
                from scoring.data_pipeline import record_signal
                _loc_parts = [p.strip() for p in (listing.location or "").split(",")]
                _city      = _loc_parts[0] if _loc_parts else ""
                _state     = _loc_parts[1][:2].upper() if len(_loc_parts) > 1 else ""
                _gap_pct   = 0.0
                if market_value.sold_avg and market_value.sold_avg > 0:
                    _gap_pct = round(
                        (listing.price - market_value.sold_avg) / market_value.sold_avg * 100, 1
                    )
                asyncio.create_task(record_signal(
                    category           = category_detected or "",
                    item_label         = (market_value.ai_item_id or listing.title or "")[:120],
                    condition          = listing.condition or "",
                    city               = _city,
                    state_code         = _state,
                    asking_price       = listing.price,
                    ebay_sold_avg      = market_value.sold_avg,
                    ebay_active_avg    = market_value.active_avg,
                    new_price          = market_value.new_price,
                    cl_asking_avg      = market_value.craigslist_avg,
                    price_gap_pct      = _gap_pct,
                    deal_score         = deal_score.score,
                    buy_new_trigger    = bool(buy_new),
                    affiliate_programs = ",".join(c.get("program_key","") for c in affiliate_dicts),
                    platform           = listing.platform or "facebook_marketplace",
                ))
            except Exception:
                pass

        except Exception as _outer_err:
            log.error(f"[Stream] Unhandled error: {_outer_err}")
            yield _sse({"type": "error", "message": str(_outer_err)})

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control":    "no-cache",
            "X-Accel-Buffering": "no",   # disables Nginx buffering
        },
    )


async def _validate_query_background(
    listing_title: str,
    query_used: str,
    sample_titles: list,
) -> None:
    """
    Background task: ask Claude Haiku whether eBay results are relevant comps.
    If not, auto-save a correction so future identical listings use the better query.

    WHY HAIKU (not Sonnet): this is a simple binary classification + rewrite task.
    Haiku costs ~10x less and is fast enough for a background job.

    WHY AUTO-SAVE: the user never sees this. If Claude flags a bad query AND
    suggests a better one, it gets written to corrections.jsonl and picked up
    on the next score for a similar listing — no manual admin intervention needed.
    """
    import anthropic as _anthropic
    from scoring.corrections import save_correction as _save_correction

    try:
        results_block = "\n".join(f"  - {t}" for t in sample_titles[:3])
        prompt = (
            f'Listing title: "{listing_title}"\n'
            f'eBay search query used: "{query_used}"\n'
            f"Top eBay results returned:\n{results_block}\n\n"
            "Are the eBay results relevant price comps for this listing?\n"
            "A result is relevant if it is the same product type, not an accessory, "
            "not a completely different item, and not a wildly different tier/brand.\n\n"
            'Respond ONLY with a JSON object:\n'
            '{"relevant": true/false, "reason": "<one sentence>", '
            '"better_query": "<improved eBay search query if not relevant, otherwise repeat the original>"}'
        )

        _client = _anthropic.Anthropic(
            api_key  = os.getenv("AI_INTEGRATIONS_ANTHROPIC_API_KEY", "placeholder"),
            base_url = os.getenv("AI_INTEGRATIONS_ANTHROPIC_BASE_URL"),
        )
        loop = asyncio.get_event_loop()
        resp = await loop.run_in_executor(
            None,
            lambda: _client.messages.create(
                model      = "claude-haiku-4-5",
                max_tokens = 120,
                messages   = [{"role": "user", "content": prompt}],
            ),
        )
        import json as _json2
        raw = resp.content[0].text.strip()
        # Strip markdown fences if present
        if "```" in raw:
            import re as _re2
            m = _re2.search(r"\{.*\}", raw, _re2.DOTALL)
            raw = m.group() if m else raw
        result = _json2.loads(raw)

        if result.get("relevant") is False:
            better = (result.get("better_query") or "").strip()
            if better and better.lower() != query_used.lower():
                _save_correction(
                    listing_title = listing_title,
                    bad_query     = query_used,
                    good_query    = better,
                    notes         = f"auto-detected · {result.get('reason', '')[:80]}",
                )
                log.info(
                    f"[QueryValidator] Auto-corrected: '{query_used}' → '{better}' "
                    f"({result.get('reason','')[:60]})"
                )
            else:
                log.debug(f"[QueryValidator] Bad query but no better suggestion — skipping save")
        else:
            log.debug(f"[QueryValidator] Query OK: '{query_used}'")

    except Exception as _ve:
        log.debug(f"[QueryValidator] Background check failed (non-fatal): {_ve}")


@app.get("/test-claude-connection")
async def test_claude_connection():
    """
    Directly tests the Claude API connection from inside the server.
    Visit http://localhost:8000/test-claude to diagnose key/credit issues.
    """
    import anthropic
    if not os.getenv("AI_INTEGRATIONS_ANTHROPIC_BASE_URL"):
        return {"status": "error", "detail": "AI Claude integration not configured"}

    try:
        loop = asyncio.get_event_loop()
        c = anthropic.Anthropic(
            api_key=os.getenv("AI_INTEGRATIONS_ANTHROPIC_API_KEY", "placeholder"),
            base_url=os.getenv("AI_INTEGRATIONS_ANTHROPIC_BASE_URL"),
        )
        r = await loop.run_in_executor(
            None,
            lambda: c.messages.create(
                model="claude-haiku-4-5",
                max_tokens=10,
                messages=[{"role": "user", "content": "say hi"}]
            )
        )
        return {
            "status": "ok",
            "response": r.content[0].text,
            "model": r.model,
            "integration": "replit-anthropic-proxy"
        }
    except anthropic.AuthenticationError as e:
        return {"status": "error", "detail": f"Auth failed: {e}"}
    except anthropic.BadRequestError as e:
        return {"status": "error", "detail": f"Bad request (likely billing): {e}"}
    except Exception as e:
        return {"status": "error", "detail": str(e)}


@app.get("/test-ebay")
async def test_ebay():
    """Debug endpoint — calls eBay directly, exposes raw response for diagnosis."""
    import httpx, os
    app_id = os.getenv("EBAY_APP_ID", "")
    url = "https://svcs.ebay.com/services/search/FindingService/v1"
    params = {
        "OPERATION-NAME": "findCompletedItems",
        "SERVICE-VERSION": "1.13.0",
        "SECURITY-APPNAME": app_id,
        "RESPONSE-DATA-FORMAT": "JSON",
        "REST-PAYLOAD": "",
        "keywords": "iPhone 13 Pro 256GB",
        "paginationInput.entriesPerPage": "3",
        "sortOrder": "BestMatch",
        "itemFilter(0).name": "SoldItemsOnly",
        "itemFilter(0).value": "true",
    }
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get(url, params=params)
        # Don't raise — read the body regardless of status code
        try:
            raw = resp.json()
        except Exception:
            raw = {"raw_text": resp.text[:500]}
        ebay_resp = raw.get("findCompletedItemsResponse", [{}])[0]
        return {
            "http_status": resp.status_code,
            "ack": ebay_resp.get("ack", ["?"])[0],
            "total_entries": ebay_resp.get("paginationOutput", [{}])[0].get("totalEntries", ["?"])[0],
            "item_count": len(ebay_resp.get("searchResult", [{}])[0].get("item", [])),
            "error_message": ebay_resp.get("errorMessage"),
            "app_id_used": app_id[:25] + "...",
            "raw_body_preview": str(raw)[:800],
        }
    except Exception as e:
        return {"error": str(e), "type": type(e).__name__}


@app.get("/test-claude")
async def test_claude(
    query:         str   = "Celestron NexStar 6SE telescope",
    condition:     str   = "Used",
    listing_price: float = 600.0,
):
    """Tests Claude AI pricing integration end-to-end."""
    from scoring.claude_pricer import get_claude_market_price, claude_is_configured
    if not claude_is_configured():
        return {
            "status": "not_configured",
            "detail": "AI_INTEGRATIONS_ANTHROPIC_BASE_URL not set.",
        }
    try:
        result = await get_claude_market_price(
            query=query, condition=condition, listing_price=listing_price,
        )
        if result:
            return {
                "status": "ok",
                "model": "claude-haiku-4-5",
                "avg_used_price": result["avg_used_price"],
                "confidence": result["confidence"],
                "data_source": result["data_source"],
                "item_id": result["item_id"],
                "notes": result["notes"],
            }
        return {"status": "no_result", "detail": "Claude returned no price estimate."}
    except Exception as e:
        return {"status": "error", "detail": str(e)}

BACKEND_VERSION = "0.26.6"  # bumped with each deploy — check /health to confirm Railway is running latest code

@app.get("/health")
async def health():
    """Detailed health check — confirms API keys are configured."""
    return {
        "api":           "ok",
        "version":       BACKEND_VERSION,
        "anthropic_key": "set" if os.getenv("AI_INTEGRATIONS_ANTHROPIC_BASE_URL") else "missing",
        "ebay_key":      "set" if os.getenv("EBAY_APP_ID") and "your_ebay" not in os.getenv("EBAY_APP_ID", "") else "missing",
    }


class AnalyticsEvent(BaseModel):
    """Privacy-safe analytics event from the extension."""
    event:             str
    program:           str   = ""
    category:          str   = ""
    price_bucket:      str   = ""
    card_type:         str   = ""
    deal_score:        int   = 0
    # Affiliate-specific training fields (added for affiliate scoring improvement)
    position:          int   = 0    # 1/2/3 — which card slot was clicked (position bias)
    selection_reason:  str   = ""   # The "reason" text the router attached to the card
    commission_live:   bool  = False  # Whether this click was earning real commission


@app.post("/event")
async def record_event(evt: AnalyticsEvent, request: Request):
    """
    Receive an anonymous analytics event from the extension.

    WHY THIS EXISTS:
      Affiliate click data is the foundation of the market intelligence product.
      Over time, aggregate data tells us: which categories have the biggest
      used-vs-new price gap, which affiliate programs convert best per category,
      which card positions get the most clicks, and what selection reasons drive action.

    PRIVACY:
      No user ID, IP, listing URL, or identifiable data is stored.
      Only category-level, price-bucketed, aggregated signals.
      GDPR/CCPA compliant by design — nothing to delete.
    """
    _check_api_key(request)
    record = {
        "event":            evt.event,
        "program":          evt.program,
        "category":         evt.category,
        "price_bucket":     evt.price_bucket,
        "card_type":        evt.card_type,
        "deal_score":       evt.deal_score,
        "position":         evt.position,
        "selection_reason": evt.selection_reason[:120] if evt.selection_reason else "",
        "commission_live":  evt.commission_live,
        "hour":             __import__("datetime").datetime.utcnow().strftime("%Y-%m-%dT%H:00"),
    }
    _event_buffer.append(record)

    # Flush to JSONL file every 10 events
    if len(_event_buffer) >= 10:
        try:
            # Snapshot first — don't clear until write succeeds.
            # If we cleared before writing and the write failed,
            # all buffered events would be silently lost.
            snapshot = list(_event_buffer)
            with open(_event_file, "a") as f:
                for r in snapshot:
                    f.write(_json.dumps(r) + "\n")
            _event_buffer.clear()
            log.debug(f"Flushed {len(snapshot)} events to {_event_file.name}")
        except Exception as e:
            log.warning(f"Event flush failed: {e}")

    return {"ok": True}


@app.get("/debug/vehicle")
async def debug_vehicle_pricer(title: str = "2018 Honda Accord LX Sedan 4D", zip_code: str = "92101"):
    """
    Debug endpoint — tests vehicle pricing pipeline end-to-end.
    Returns raw CarGurus API response + final market value result.
    Call: GET /debug/vehicle?title=2018+Honda+Accord&zip_code=92101
    """
    import traceback
    import httpx
    from scoring.vehicle_pricer import parse_vehicle_title, get_vehicle_market_value

    result = {"title": title, "zip_code": zip_code}

    # Step 1: title parsing
    parsed = parse_vehicle_title(title)
    result["parsed"] = parsed
    if not parsed:
        result["error"] = "title parsing failed"
        return result

    year, make, model = parsed["year"], parsed["make"], parsed["model"]
    keyword = f"{year} {make} {model}"

    # Step 2: Raw CarGurus API probe
    try:
        url = "https://www.cargurus.com/Cars/searchResults.action"
        params = {"zip": zip_code, "listingTypes": "USED", "sortDir": "ASC",
                  "sortType": "PRICE", "keyword": keyword, "offset": 0, "maxResults": 5}
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/121.0.0.0 Safari/537.36",
            "Accept": "application/json, text/javascript, */*; q=0.01",
            "Referer": "https://www.cargurus.com/Cars/new/nl/Cars/",
            "X-Requested-With": "XMLHttpRequest",
        }
        async with httpx.AsyncClient(timeout=10.0, follow_redirects=True) as client:
            resp = await client.get(url, params=params, headers=headers)
            result["cargurus_status"] = resp.status_code
            result["cargurus_content_type"] = resp.headers.get("content-type", "")
            if resp.status_code == 200:
                try:
                    data = resp.json()
                    listings = data if isinstance(data, list) else data.get("listings", [])
                    result["cargurus_listing_count"] = len(listings)
                    result["cargurus_sample"] = [
                        {"year": l.get("carYear"), "title": l.get("listingTitle", "")[:50], "price": l.get("price")}
                        for l in listings[:5]
                    ]
                except Exception as je:
                    result["cargurus_json_error"] = str(je)
                    result["cargurus_body_snippet"] = resp.text[:300]
            else:
                result["cargurus_body_snippet"] = resp.text[:300]
    except Exception as e:
        result["cargurus_error"] = f"{type(e).__name__}: {e}"

    # Step 3: Full pricer pipeline
    try:
        vdata = await get_vehicle_market_value(title, zip_code=zip_code)
        result["vehicle_data"] = vdata
        result["success"] = vdata is not None
    except Exception as e:
        result["vehicle_error"] = f"{type(e).__name__}: {e}"
        result["vehicle_traceback"] = traceback.format_exc()[-400:]

    return result


@app.get("/debug/query")
async def debug_query(title: str = "Kids pants Boys Size 12", description: str = "bundle of 3"):
    """
    Debug endpoint — shows the full query chain for a listing title.
    Reveals exactly what search_query Haiku generates and what build_search_query
    produces from it. Use this to catch comp-poisoning bugs before they reach scoring.

    Call: GET /debug/query?title=Kids+pants+Boys+Size+12&description=bundle+of+3
    """
    from scoring.product_extractor import extract_product
    from scoring.ebay_pricer import build_search_query

    product_info = await extract_product(title, description)
    final_query  = build_search_query(product_info.search_query)

    return {
        "input": {
            "title":       title,
            "description": description,
        },
        "haiku_output": {
            "search_query": product_info.search_query,   # what Haiku generated
            "amazon_query": product_info.amazon_query,
            "display_name": product_info.display_name,
            "category":     product_info.category,
            "brand":        product_info.brand,
            "confidence":   product_info.confidence,
            "method":       product_info.extraction_method,
        },
        "final_ebay_query": final_query,   # after build_search_query noise stripping
        "warning": (
            "bundle/lot/pack still in haiku query — noise_words fix didn't apply yet"
            if any(w in product_info.search_query.lower()
                   for w in ["bundle","lot","pack","set","pcs","pieces"])
            else None
        ),
    }


@app.get("/affiliate-status")
async def affiliate_status():
    """Shows which affiliate programs are active vs pending credentials."""
    programs = get_program_status()
    live     = [p for p in programs if p["has_tag"] and p["status"] == "live"]
    search   = [p for p in programs if not p["has_tag"] or p["status"] == "search"]
    return {
        "live_count":   len(live),
        "pending_count": len(search),
        "live":         live,
        "search_only":  search,
        "note":         "Add credentials to .env to activate commission earning on search-only programs",
    }


# ── Dev Entry Point ───────────────────────────────────────────────────────────

# ── User Issue Reports ─────────────────────────────────────────────────────────────────────

# On Railway: REPORTS_FILE is ephemeral (container resets on redeploy).
# That's fine — when DISCORD_WEBHOOK_URL is set, the file is never used.
# Locally: sits in project root next to .env
REPORTS_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "reports.jsonl")

class IssueReport(BaseModel):
    report: str
    ts: str = ""

@app.post("/report")
async def submit_report(body: IssueReport):
    """
    Receives bug reports from the extension popup.

    Routing logic:
      - DISCORD_WEBHOOK_URL set → posts to Discord channel (production)
      - fallback                → appends to reports.jsonl (local dev)

    To set up Discord:
      1. In your Discord server: channel settings → Integrations → Webhooks → New Webhook
      2. Copy the webhook URL
      3. Add to .env:  DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
      4. Add to Railway dashboard env vars (same key/value)
    """
    entry = {
        "ts":     body.ts or datetime.utcnow().isoformat(),
        "report": body.report.strip(),
    }

    discord_url = os.getenv("DISCORD_WEBHOOK_URL")
    if discord_url:
        # Discord webhook payload — embeds give us nice formatting in the channel
        payload = {
            "embeds": [{
                "title": "⚠️ Deal Scout — User Report",
                "description": entry["report"][:4000],  # Discord embed limit
                "color": 0xF59E0B,  # amber
                "footer": {"text": entry["ts"]},
            }]
        }
        try:
            import httpx
            async with httpx.AsyncClient() as client:
                r = await client.post(discord_url, json=payload, timeout=5.0)
                r.raise_for_status()
            log.info(f"[Report] Sent to Discord: {entry['report'][:60]}")
        except Exception as e:
            log.error(f"[Report] Discord delivery failed: {e}")
            # Fall through to local file as backup
            _save_report_local(entry)
    else:
        # Local dev fallback
        _save_report_local(entry)

    return {"ok": True}


def _save_report_local(entry: dict):
    """Append report to local JSONL file. Used when Discord webhook not configured."""
    try:
        os.makedirs(os.path.dirname(REPORTS_FILE), exist_ok=True)
        with open(REPORTS_FILE, "a", encoding="utf-8") as f:
            f.write(_json.dumps(entry) + "\n")
        log.info(f"[Report] Saved locally: {entry['report'][:60]}")
    except Exception as e:
        log.error(f"[Report] Local save failed: {e}")


# ── Feedback + Admin ─────────────────────────────────────────────────────────────────────

class FeedbackRequest(BaseModel):
    """
    Manual query correction submitted via the sidebar or /admin page.
    Tells the system: "for listings like this, use THIS query instead."
    """
    listing_title:       str
    bad_query:           str
    good_query:          str
    correct_price_low:   float = 0.0
    correct_price_high:  float = 0.0
    notes:               str   = ""


class ThumbsRequest(BaseModel):
    score_id: int
    thumbs:   int   # 1 = up, -1 = down
    reason:   str   = ""   # labeled reason for 👎 (e.g. "score_too_high", "price_wrong")


@app.post("/thumbs")
async def submit_thumbs(body: ThumbsRequest, request: Request):
    """
    Record a thumbs-up or thumbs-down on a scored listing.
    score_id comes from the /score response. thumbs: 1 or -1.
    reason is only expected on thumbs=-1 (down) — one of:
      score_too_high | score_too_low | price_wrong | wrong_category | missing_info
    Used to build a labeled training dataset for prompt improvement.
    """
    _check_api_key(request)
    if body.thumbs not in (1, -1):
        raise HTTPException(status_code=400, detail="thumbs must be 1 or -1")
    _valid_reasons = {"score_too_high", "score_too_low", "price_wrong", "wrong_category", "missing_info", ""}
    clean_reason = body.reason.strip().lower() if body.reason else ""
    if clean_reason not in _valid_reasons:
        clean_reason = ""
    try:
        from scoring.data_pipeline import _get_pool
        pool = await _get_pool()
        if not pool:
            raise HTTPException(status_code=503, detail="DB unavailable")
        result = await pool.execute(
            "UPDATE deal_scores SET thumbs=$1, thumbs_at=NOW(), thumbs_reason=$3 WHERE id=$2",
            body.thumbs, body.score_id, clean_reason or None,
        )
        if result == "UPDATE 0":
            raise HTTPException(status_code=404, detail=f"score_id {body.score_id} not found")
        log.info(f"[Thumbs] score_id={body.score_id} thumbs={body.thumbs} reason={clean_reason or '—'}")
        return {"ok": True}
    except HTTPException:
        raise
    except Exception as e:
        log.error(f"[Thumbs] DB error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/feedback")
async def submit_feedback(body: FeedbackRequest, request: Request):
    """
    Accepts a manual query correction from the sidebar or admin page.
    Saves to corrections.jsonl and immediately affects future scores.

    Example: GoPro listing gets compared to GoPro accessories instead of cameras.
    Submit: bad_query="GoPro accessories" good_query="GoPro HERO 12 Black camera"
    Next GoPro listing will use the corrected query automatically.
    """
    _check_api_key(request)
    from scoring.corrections import save_correction
    price_range = [body.correct_price_low, body.correct_price_high] if body.correct_price_low else []
    ok = save_correction(
        listing_title       = body.listing_title,
        bad_query           = body.bad_query,
        good_query          = body.good_query,
        correct_price_range = price_range,
        notes               = body.notes,
    )
    if not ok:
        raise HTTPException(status_code=500, detail="Failed to save correction")
    log.info(f"[Feedback] Correction saved: '{body.bad_query}' → '{body.good_query}'")
    return {"ok": True, "message": f"Correction saved. Future scores for similar listings will use: '{body.good_query}'"}


@app.get("/admin")
async def admin_page():
    """
    Admin page: recent scored listings with thumbs, correction log, links.
    """
    from scoring.corrections import get_all_corrections
    from scoring.data_pipeline import _get_pool
    corrections = get_all_corrections()

    # ── Fetch recent scored listings ─────────────────────────────────────────
    recent_scores = []
    score_stats = {"total": 0, "up": 0, "down": 0, "unrated": 0}
    try:
        pool = await _get_pool()
        if pool:
            rows = await pool.fetch(
                """SELECT id, created_at, platform, score, thumbs,
                          listing_json->>'title'   AS title,
                          listing_json->>'price'   AS price,
                          score_json->>'verdict'   AS verdict
                   FROM deal_scores
                   ORDER BY created_at DESC
                   LIMIT 50"""
            )
            recent_scores = [dict(r) for r in rows]
            stats_row = await pool.fetchrow(
                """SELECT COUNT(*) AS total,
                          COUNT(*) FILTER (WHERE thumbs=1)  AS up,
                          COUNT(*) FILTER (WHERE thumbs=-1) AS down,
                          COUNT(*) FILTER (WHERE thumbs IS NULL) AS unrated
                   FROM deal_scores"""
            )
            if stats_row:
                score_stats = dict(stats_row)
    except Exception as _e:
        log.warning(f"[admin] DB query failed: {_e}")

    # ── Affiliate analytics ───────────────────────────────────────────────────
    affiliate_stats   = {}   # program_key → {impressions, clicks, positions, categories}
    affiliate_by_pos  = {1: {"impressions": 0, "clicks": 0},
                         2: {"impressions": 0, "clicks": 0},
                         3: {"impressions": 0, "clicks": 0}}
    affiliate_by_type = {}   # card_type → {impressions, clicks}
    try:
        pool = await _get_pool()
        if pool:
            imp_rows = await pool.fetch(
                """
                SELECT
                    el->>'program_key'  AS program,
                    (el->>'position')::int AS pos,
                    el->>'card_type'    AS card_type
                FROM deal_scores,
                     jsonb_array_elements(affiliate_impressions_json) AS el
                WHERE affiliate_impressions_json IS NOT NULL
                  AND affiliate_impressions_json != 'null'::jsonb
                LIMIT 50000
                """
            )
            for row in imp_rows:
                prog = row["program"] or "unknown"
                pos  = row["pos"] or 0
                ctype = row["card_type"] or "unknown"
                if prog not in affiliate_stats:
                    affiliate_stats[prog] = {"impressions": 0, "clicks": 0, "positions": [], "categories": []}
                affiliate_stats[prog]["impressions"] += 1
                affiliate_stats[prog]["positions"].append(pos)
                if 1 <= pos <= 3:
                    affiliate_by_pos[pos]["impressions"] += 1
                if ctype not in affiliate_by_type:
                    affiliate_by_type[ctype] = {"impressions": 0, "clicks": 0}
                affiliate_by_type[ctype]["impressions"] += 1
    except Exception as _ae:
        log.warning(f"[admin] affiliate impressions query failed: {_ae}")

    # Read click events from JSONL
    events_path = "data/analytics_events.jsonl"
    try:
        import json as _json
        if os.path.exists(events_path):
            with open(events_path) as _ef:
                for line in _ef:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        ev = _json.loads(line)
                        if ev.get("event_type") != "AFFILIATE_CLICK":
                            continue
                        prog  = ev.get("program") or ev.get("program_key") or "unknown"
                        pos   = int(ev.get("position") or 0)
                        ctype = ev.get("card_type") or "unknown"
                        if prog not in affiliate_stats:
                            affiliate_stats[prog] = {"impressions": 0, "clicks": 0, "positions": [], "categories": []}
                        affiliate_stats[prog]["clicks"] += 1
                        if 1 <= pos <= 3:
                            affiliate_by_pos[pos]["clicks"] += 1
                        if ctype not in affiliate_by_type:
                            affiliate_by_type[ctype] = {"impressions": 0, "clicks": 0}
                        affiliate_by_type[ctype]["clicks"] += 1
                    except Exception:
                        pass
    except Exception as _ce:
        log.warning(f"[admin] click event read failed: {_ce}")

    def _ctr(clicks, impressions):
        if impressions == 0:
            return "—"
        return f"{(clicks/impressions*100):.1f}%"

    def _avg_pos(positions):
        return f"{sum(positions)/len(positions):.1f}" if positions else "—"

    # Build affiliate program table rows sorted by impressions desc
    aff_prog_rows = ""
    for prog, d in sorted(affiliate_stats.items(), key=lambda x: -x[1]["impressions"]):
        ctr_str = _ctr(d["clicks"], d["impressions"])
        pos_str = _avg_pos(d["positions"])
        ctr_color = "#22c55e" if d["clicks"] > 0 else "#6b7280"
        aff_prog_rows += (
            f"<tr>"
            f"<td style='font-weight:600;color:#7c8cf8'>{prog}</td>"
            f"<td style='text-align:right'>{d['impressions']}</td>"
            f"<td style='text-align:right'>{d['clicks']}</td>"
            f"<td style='text-align:right;color:{ctr_color}'>{ctr_str}</td>"
            f"<td style='text-align:right;color:#aaa'>{pos_str}</td>"
            f"</tr>"
        )

    # Build position table rows
    pos_rows = ""
    for pos in [1, 2, 3]:
        d = affiliate_by_pos[pos]
        pos_rows += (
            f"<tr>"
            f"<td style='text-align:center;font-weight:700;color:#fbbf24'>#{pos}</td>"
            f"<td style='text-align:right'>{d['impressions']}</td>"
            f"<td style='text-align:right'>{d['clicks']}</td>"
            f"<td style='text-align:right;color:#22c55e'>{_ctr(d['clicks'], d['impressions'])}</td>"
            f"</tr>"
        )

    # Build card type table rows
    type_rows = ""
    for ctype, d in sorted(affiliate_by_type.items(), key=lambda x: -x[1]["impressions"]):
        type_rows += (
            f"<tr>"
            f"<td style='color:#a0a0c0'>{ctype}</td>"
            f"<td style='text-align:right'>{d['impressions']}</td>"
            f"<td style='text-align:right'>{d['clicks']}</td>"
            f"<td style='text-align:right;color:#22c55e'>{_ctr(d['clicks'], d['impressions'])}</td>"
            f"</tr>"
        )

    has_aff_data = bool(affiliate_stats)
    aff_analytics_html = ""
    if has_aff_data:
        aff_analytics_html = f"""
  <div style='display:grid;grid-template-columns:2fr 1fr 1fr;gap:24px;margin-top:16px'>
    <div>
      <h3 style='color:#a0a0c0;margin-bottom:8px;font-size:13px'>By Program</h3>
      <table>
        <tr><th>Program</th><th style='text-align:right'>Shown</th>
            <th style='text-align:right'>Clicks</th><th style='text-align:right'>CTR</th>
            <th style='text-align:right'>Avg Pos</th></tr>
        {aff_prog_rows}
      </table>
    </div>
    <div>
      <h3 style='color:#a0a0c0;margin-bottom:8px;font-size:13px'>By Position</h3>
      <table>
        <tr><th>Pos</th><th style='text-align:right'>Shown</th>
            <th style='text-align:right'>Clicks</th><th style='text-align:right'>CTR</th></tr>
        {pos_rows}
      </table>
    </div>
    <div>
      <h3 style='color:#a0a0c0;margin-bottom:8px;font-size:13px'>By Card Type</h3>
      <table>
        <tr><th>Type</th><th style='text-align:right'>Shown</th>
            <th style='text-align:right'>Clicks</th><th style='text-align:right'>CTR</th></tr>
        {type_rows}
      </table>
    </div>
  </div>"""
    else:
        aff_analytics_html = "<p style='color:#6b7280'>No affiliate impression data yet. Score some listings to populate.</p>"

    rows = ""
    for c in corrections:
        rows += f"""
        <tr>
            <td style='color:#aaa;font-size:11px'>{c.get('ts','')[:16]}</td>
            <td style='max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap' title='{c.get("listing_title","")}'>{c.get('listing_title','')[:40]}</td>
            <td style='color:#ef4444'>{c.get('bad_query','')}</td>
            <td style='color:#22c55e'>{c.get('good_query','')}</td>
            <td style='color:#aaa;font-size:11px'>{c.get('notes','')[:40]}</td>
        </tr>"""

    # Build scores table separately to avoid nested f-string issues
    def _score_color(s):
        s = s or 0
        return "#22c55e" if s >= 7 else "#fbbf24" if s >= 5 else "#ef4444"

    def _score_row(r):
        t   = (r["title"]   or "")[:40].replace("'", "")
        v   = (r["verdict"] or "")[:30]
        sc  = r["score"] or 0
        th  = "👍" if r["thumbs"] == 1 else "👎" if r["thumbs"] == -1 else "—"
        col = _score_color(sc)
        return (
            "<tr>"
            f"<td style='color:#aaa;font-size:11px'>{str(r['created_at'])[:16]}</td>"
            f"<td style='font-size:11px;color:#7c8cf8'>{r['platform'] or ''}</td>"
            f"<td style='max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap' title='{t}'>{t}</td>"
            f"<td>${float(r['price'] or 0):.0f}</td>"
            f"<td style='font-weight:700;color:{col}'>{sc or '?'}</td>"
            f"<td style='font-size:12px;color:#aaa'>{v}</td>"
            f"<td style='font-size:16px'>{th}</td>"
            "</tr>"
        )
    scores_table_rows = "".join(_score_row(r) for r in recent_scores)
    scores_html = (
        f"<table><tr><th>Time</th><th>Platform</th><th>Title</th>"
        f"<th>Price</th><th>Score</th><th>Verdict</th><th>Feedback</th></tr>"
        f"{scores_table_rows}</table>"
    ) if recent_scores else "<p style='color:#6b7280'>No listings scored yet.</p>"

    html = f"""<!DOCTYPE html>
<html><head><title>Deal Scout — Admin</title>
<style>
  body {{ font-family: monospace; background: #0f0f1a; color: #e0e0e0; padding: 32px; }}
  h1 {{ color: #7c8cf8; }} h2 {{ color: #a0a0c0; margin-top:32px; }}
  table {{ border-collapse: collapse; width: 100%; margin-top: 16px; }}
  th {{ background:#1e1e38; color:#7c8cf8; padding:8px 12px; text-align:left; }}
  td {{ padding:8px 12px; border-bottom:1px solid #2a2a44; vertical-align:top; }}
  tr:hover td {{ background:#1a1a2e; }}
  input, textarea {{ background:#1e1e38; border:1px solid #3a3a5c; color:#e0e0e0;
    padding:8px; border-radius:4px; font-family:monospace; }}
  input {{ width:100%; margin-bottom:8px; }}
  button {{ background:#6366f1; color:white; border:none; padding:10px 24px;
    border-radius:4px; cursor:pointer; font-size:14px; margin-top:8px; }}
  button:hover {{ background:#4f52d4; }}
  .success {{ color:#22c55e; margin-top:8px; display:none; }}
  label {{ color:#a0a0c0; font-size:12px; display:block; margin-bottom:2px; }}
  .grid {{ display:grid; grid-template-columns:1fr 1fr; gap:12px; }}
  .hint {{ color:#6b7280; font-size:11px; margin-top:4px; }}
</style></head>
<body>
  <h1>🔍 Deal Scout — Market Comparison Admin</h1>
  <p style='color:#6b7280'>Fix bad eBay search queries to improve market comparison accuracy.<br>
  Corrections apply immediately to future scores — no redeploy needed.</p>

  <h2>Add Correction</h2>
  <div style='max-width:700px'>
    <label>Listing title (copy from FBM)</label>
    <input id='title' placeholder='e.g. Taylor 114ce acoustic electric guitar like new' />
    <div class='grid'>
      <div>
        <label>Bad query (what Deal Scout used)</label>
        <input id='bad' placeholder='e.g. Taylor acoustic electric guitar' />
        <p class='hint'>Find this in Railway logs or /debug/query endpoint</p>
      </div>
      <div>
        <label>Good query (what eBay should search)</label>
        <input id='good' placeholder='e.g. Taylor 114ce acoustic guitar' />
        <p class='hint'>Test at ebay.com first to verify comp quality</p>
      </div>
    </div>
    <div class='grid'>
      <div>
        <label>Correct price range — low ($)</label>
        <input id='plow' type='number' placeholder='e.g. 150' />
      </div>
      <div>
        <label>Correct price range — high ($)</label>
        <input id='phigh' type='number' placeholder='e.g. 350' />
      </div>
    </div>
    <label>Notes (optional)</label>
    <input id='notes' placeholder='e.g. 114ce is entry-level, not Artist series' />
    <br/>
    <button onclick='submitCorrection()'>Save Correction</button>
    <p class='success' id='success'>✅ Correction saved! Future scores will use the new query.</p>
  </div>

  <h2>Correction Log ({len(corrections)} total)</h2>
  {"<p style='color:#6b7280'>No corrections yet. Score some listings and fix the bad ones above.</p>" if not corrections else ""}
  {f"<table><tr><th>Time</th><th>Listing</th><th>Bad Query</th><th>Good Query</th><th>Notes</th></tr>{rows}</table>" if corrections else ""}

  <h2>Affiliate Card Analytics</h2>
  <p style='color:#6b7280;font-size:12px'>
    CTR = clicks ÷ impressions. Use this to reorder programs in the router when you have
    enough data (~50+ clicks per program). Position 1 always gets more clicks due to
    placement bias — compare within-position CTR across programs to spot winners.
  </p>
  {aff_analytics_html}

  <h2>Recent Scored Listings</h2>
  <p style='color:#6b7280;font-size:12px'>Total: {score_stats['total']} &nbsp;&middot;&nbsp;
    👍 {score_stats['up']} &nbsp;&middot;&nbsp; 👎 {score_stats['down']} &nbsp;&middot;&nbsp;
    ⬜ {score_stats['unrated']} unrated</p>
  {scores_html}

  <h2>Useful Debug Links</h2>
  <ul style='color:#7c8cf8;line-height:2'>
    <li><a href='/debug/query?title=YOUR+TITLE+HERE' style='color:#7c8cf8'>/debug/query</a> — see exactly what query Deal Scout generates for any title</li>
    <li><a href='/health' style='color:#7c8cf8'>/health</a> — API key status</li>
    <li><a href='/affiliate-status' style='color:#7c8cf8'>/affiliate-status</a> — which affiliate programs are live</li>
    <li><a href='/docs' style='color:#7c8cf8'>/docs</a> — full API docs</li>
  </ul>

<script>
async function submitCorrection() {{
  const body = {{
    listing_title: document.getElementById('title').value.trim(),
    bad_query:     document.getElementById('bad').value.trim(),
    good_query:    document.getElementById('good').value.trim(),
    correct_price_low:  parseFloat(document.getElementById('plow').value) || 0,
    correct_price_high: parseFloat(document.getElementById('phigh').value) || 0,
    notes: document.getElementById('notes').value.trim(),
  }};
  if (!body.listing_title || !body.good_query) {{
    alert('Listing title and good query are required');
    return;
  }}
  const r = await fetch('/feedback', {{
    method: 'POST',
    headers: {{'Content-Type': 'application/json'}},
    body: JSON.stringify(body)
  }});
  if (r.ok) {{
    document.getElementById('success').style.display = 'block';
    setTimeout(() => location.reload(), 1500);
  }} else {{
    alert('Save failed: ' + await r.text());
  }}
}}
</script>
</body></html>"""
    from fastapi.responses import HTMLResponse
    return HTMLResponse(content=html)


# ── Market Intelligence Data API ─────────────────────────────────────────────
# These endpoints expose the anonymized aggregate market signal data.
# Protect with MARKET_DATA_API_KEY env var before sharing with any buyer.
# Buyers call: GET /v1/market-data?category=electronics&days=30
# Admin view:  GET /admin/dashboard  (summary stats)

def _check_data_key(request: Request) -> None:
    """Simple API key gate for the market data endpoints."""
    required_key = os.getenv("MARKET_DATA_API_KEY", "")
    if not required_key:
        return  # Open access until you set the env var
    provided = request.headers.get("X-API-Key", "") or request.query_params.get("api_key", "")
    if provided != required_key:
        raise HTTPException(status_code=401, detail="Invalid or missing API key")


@app.get("/v1/market-data")
async def market_data_api(
    request:  Request,
    category: Optional[str] = None,
    days:     int = 30,
):
    """
    Returns anonymized aggregate market signal data.

    Query params:
      - category (str, optional): Filter to a single category (e.g. 'electronics')
      - days     (int, default 30): Lookback window in days

    Authentication:
      Set MARKET_DATA_API_KEY env var, then pass X-API-Key header or ?api_key= param.
      If no key is set, endpoint is open (useful during development).

    Only rows with >= 5 samples are returned to prevent any single listing
    from being identifiable in the output.
    """
    _check_data_key(request)
    from scoring.data_pipeline import get_aggregate_stats
    result = await get_aggregate_stats(category=category, days=days)
    return result


@app.get("/admin/dashboard")
async def admin_dashboard(request: Request):
    """
    Quick summary stats for the data pipeline admin view.
    Shows total signals collected, 24h and 7d counts, unique categories, etc.
    """
    _check_data_key(request)
    from scoring.data_pipeline import get_dashboard_summary
    summary = await get_dashboard_summary()
    return {
        "pipeline": "Deal Scout Market Intelligence",
        "description": "Anonymized used-market price signals. No PII collected.",
        "stats": summary,
    }


# ── Diagnostic report collection ─────────────────────────────────────────────
# The extension auto-POSTs window.__dealScoutDiag after each score.
# Reports are persisted to the diag_reports table in PostgreSQL so they
# survive API restarts. No auth required — dev-only endpoint.
# Schema: diag_reports(id serial, server_ts timestamptz, payload jsonb)

def _diag_summary_row(r: dict) -> dict:
    return {
        # Timing (raw events + derived pipeline segments)
        "nav":           r.get("nav"),
        "msPhase1":      r.get("navMsToExtract"),
        "msToExtracted": r.get("msToExtracted"),
        "msToScore":     r.get("msToScore"),
        "msExtraction":  r.get("msExtraction"),
        "msMarketLookup": r.get("msMarketLookup"),
        "msScoring":     r.get("msScoring"),
        # Navigation / readiness
        "v":             r.get("v"),
        "loadType":      r.get("loadType"),
        "strategy":      r.get("phase1Strategy"),
        "polls":         r.get("phase1Polls"),
        "blockers":      r.get("phase1Blockers"),
        "fpChanged":     r.get("fingerprintChanged"),
        # Score
        "finalTitle":    r.get("finalTitle"),
        "score":         r.get("finalScore"),
        "verdict":       r.get("verdict"),
        "aiConf":        r.get("aiConfidence"),
        "price":         r.get("price"),
        "condition":     r.get("condition"),
        # Market
        "dataSource":    r.get("dataSource"),
        "marketConf":    r.get("marketConf"),
        "queryUsed":     r.get("queryUsed"),
        "soldAvg":       r.get("soldAvg"),
        "soldLow":       r.get("soldLow"),
        "soldHigh":      r.get("soldHigh"),
        "newPrice":      r.get("newPrice"),
        "recOffer":      r.get("recommendedOffer"),
        # Flags
        "greenFlags":    r.get("greenFlagCount"),
        "redFlags":      r.get("redFlagCount"),
        # Affiliates
        "buyNew":        r.get("buyNewTrigger"),
        "affiliates":    r.get("affiliateCount"),
        "programs":      r.get("affiliatePrograms"),
        # Safety
        "security":      r.get("securityRisk"),
        "reliability":   r.get("reliabilityTier"),
        # Bleed guards
        "bleed":         r.get("postExtractBleed"),
        "guardC":        r.get("guardC"),
        "retries":       r.get("retries"),
        # v0.29.7 overlay/dialog diagnostics
        "prevTitle":     r.get("prevTitle"),
        "currentTitle":  r.get("currentTitle"),
        "containerSource": r.get("containerSource"),
        "dialogDetected": r.get("dialogDetected"),
        "hasRoleDialog": r.get("hasRoleDialog"),
        "hasAriaModal":  r.get("hasAriaModal"),
        "hasFullscreenOverlay": r.get("hasFullscreenOverlay"),
        "hasCloseBtn":   r.get("hasCloseBtn"),
        "overlayTextSnippet": r.get("overlayTextSnippet"),
        "overlayListingIds": r.get("overlayListingIds"),
        "pageListingId": r.get("pageListingId"),
        "mutationSettleMs": r.get("mutationSettleMs"),
        "titleCheckRetries": r.get("titleCheckRetries"),
        "contentTitleMatch": r.get("contentTitleMatch"),
        "h1AtExtract":   r.get("h1AtExtract"),
        "rawSnippet":    r.get("rawSnippet"),
        "titleWaitMs":   r.get("titleWaitMs"),
    }


_nav_debug_table_ensured = False

async def _ensure_nav_debug_table():
    global _nav_debug_table_ensured
    if _nav_debug_table_ensured:
        return
    from scoring.data_pipeline import _get_pool
    pool = await _get_pool()
    await pool.execute("""
        CREATE TABLE IF NOT EXISTS nav_debug_events (
            id serial PRIMARY KEY,
            server_ts timestamptz DEFAULT now(),
            payload jsonb NOT NULL
        )
    """)
    _nav_debug_table_ensured = True


@app.post("/nav-debug")
async def collect_nav_debug(request: Request):
    try:
        import json as _json
        from scoring.data_pipeline import _get_pool
        await _ensure_nav_debug_table()
        payload = await request.json()
        pool = await _get_pool()
        await pool.execute(
            "INSERT INTO nav_debug_events (payload) VALUES ($1::jsonb)",
            _json.dumps(payload),
        )
        return {"ok": True}
    except Exception as e:
        return {"ok": False, "error": str(e)}


@app.get("/nav-debug")
async def get_nav_debug():
    try:
        import json as _json
        from scoring.data_pipeline import _get_pool
        await _ensure_nav_debug_table()
        pool = await _get_pool()
        rows = await pool.fetch(
            "SELECT id, server_ts, payload FROM nav_debug_events ORDER BY server_ts DESC LIMIT 200"
        )
        events = []
        for r in rows:
            p = _json.loads(r["payload"])
            p["_id"] = r["id"]
            p["_server_ts"] = r["server_ts"].isoformat()
            events.append(p)
        events.reverse()
        return events
    except Exception as e:
        return []


@app.delete("/nav-debug")
async def clear_nav_debug():
    try:
        from scoring.data_pipeline import _get_pool
        await _ensure_nav_debug_table()
        pool = await _get_pool()
        result = await pool.execute("DELETE FROM nav_debug_events")
        n = int(result.split()[-1]) if result else 0
        return {"ok": True, "cleared": n}
    except Exception as e:
        return {"ok": False, "error": str(e)}


@app.post("/diag")
async def collect_diag(request: Request):
    try:
        import json as _json
        from scoring.data_pipeline import _get_pool
        payload = await request.json()
        payload["_server_ts"] = datetime.utcnow().isoformat()
        pool = await _get_pool()
        row = await pool.fetchrow(
            "INSERT INTO diag_reports (payload) VALUES ($1::jsonb) RETURNING id",
            _json.dumps(payload),
        )
        count = await pool.fetchval("SELECT COUNT(*) FROM diag_reports")
        return {"ok": True, "id": row["id"], "stored": count}
    except Exception as e:
        return {"ok": False, "error": str(e)}


@app.get("/diag")
async def get_diag():
    try:
        import json as _json
        from scoring.data_pipeline import _get_pool
        pool = await _get_pool()
        rows = await pool.fetch(
            "SELECT payload FROM diag_reports ORDER BY server_ts DESC LIMIT 500"
        )
        reports = [_json.loads(r["payload"]) for r in rows]
        summary = [_diag_summary_row(r) for r in reports]
        return {"count": len(reports), "summary": summary, "reports": reports}
    except Exception as e:
        return {"count": 0, "summary": [], "reports": [], "error": str(e)}


@app.delete("/diag")
async def clear_diag():
    try:
        from scoring.data_pipeline import _get_pool
        pool = await _get_pool()
        result = await pool.execute("DELETE FROM diag_reports")
        n = int(result.split()[-1]) if result else 0
        return {"ok": True, "cleared": n}
    except Exception as e:
        return {"ok": False, "error": str(e)}


_score_log_table_ensured = False

async def _ensure_score_log_table():
    global _score_log_table_ensured
    if _score_log_table_ensured:
        return
    from scoring.data_pipeline import _get_pool
    pool = await _get_pool()
    await pool.execute("""
        CREATE TABLE IF NOT EXISTS score_log (
            id serial PRIMARY KEY,
            server_ts timestamptz DEFAULT now(),
            payload jsonb NOT NULL
        )
    """)
    _score_log_table_ensured = True


def _build_scorecard(
    listing,
    deal_score,
    market_value,
    security,
    product_info,
    product_eval,
    affiliate_dicts: list,
    category_detected: str,
    buy_new: bool,
    buy_new_msg: str,
    sold_items_sample: list,
    active_items_sample: list,
    scoring_start_ts: float = 0.0,
    extension_version: str | None = None,
) -> dict:
    from dataclasses import asdict as _dc_asdict
    _sec = _dc_asdict(security) if hasattr(security, '__dataclass_fields__') else (security if isinstance(security, dict) else {})
    _pi  = _dc_asdict(product_info) if hasattr(product_info, '__dataclass_fields__') else (product_info if isinstance(product_info, dict) else {})
    _pe  = _dc_asdict(product_eval) if hasattr(product_eval, '__dataclass_fields__') else (product_eval if isinstance(product_eval, dict) else {})

    import re as _re
    _listing_id = ""
    if listing.listing_url:
        _m = _re.search(r'/item/(\d+)', listing.listing_url)
        if _m:
            _listing_id = _m.group(1)
        else:
            _m = _re.search(r'/itm/(\d+)', listing.listing_url)
            if _m:
                _listing_id = _m.group(1)
            elif '/detail/' in listing.listing_url:
                parts = listing.listing_url.rstrip('/').split('/')
                _listing_id = parts[-1] if parts else ""

    return {
        "listing": {
            "title":              listing.title,
            "price":              listing.price,
            "condition":          listing.condition,
            "platform":           listing.platform or "unknown",
            "listing_id":         _listing_id,
            "listing_url":        listing.listing_url or "",
            "location":           listing.location or "",
            "photo_count":        listing.photo_count,
            "is_vehicle":         listing.is_vehicle,
            "is_multi_item":      listing.is_multi_item,
            "seller_trust":       listing.seller_trust or {},
            "seller_name":        listing.seller_name or "",
            "original_price":     listing.original_price,
            "shipping_cost":      listing.shipping_cost,
            "vehicle_details":    listing.vehicle_details or {},
            "image_urls":         listing.image_urls or [],
            "raw_price_text":     listing.raw_price_text or "",
            "description_snippet": (listing.description or "")[:200],
        },
        "deal_score": {
            "score":               deal_score.score,
            "verdict":             deal_score.verdict,
            "should_buy":          deal_score.should_buy,
            "summary":             deal_score.summary,
            "value_assessment":    deal_score.value_assessment,
            "condition_notes":     deal_score.condition_notes,
            "green_flags":         deal_score.green_flags or [],
            "red_flags":           deal_score.red_flags or [],
            "recommended_offer":   deal_score.recommended_offer,
            "negotiation_message": deal_score.negotiation_message,
            "ai_confidence":       deal_score.confidence,
            "model_used":          deal_score.model_used,
            "image_analyzed":      deal_score.image_analyzed,
            "affiliate_category":  deal_score.affiliate_category,
            "bundle_items":        deal_score.bundle_items or [],
        },
        "price_comparison": {
            "data_source":         market_value.data_source,
            "market_confidence":   market_value.confidence,
            "reliability_tier":    product_eval.reliability_tier if hasattr(product_eval, 'reliability_tier') else (product_eval.get('reliability_tier', 'unknown') if isinstance(product_eval, dict) else 'unknown'),
            "estimated_value":     market_value.estimated_value,
            "new_price":           market_value.new_price,
            "sold_avg":            market_value.sold_avg,
            "sold_low":            market_value.sold_low,
            "sold_high":           market_value.sold_high,
            "sold_count":          market_value.sold_count,
            "active_avg":          market_value.active_avg,
            "active_low":          market_value.active_low,
            "active_count":        market_value.active_count if hasattr(market_value, 'active_count') else 0,
            "query_used":          market_value.query_used,
            "ai_item_id":          market_value.ai_item_id,
            "ai_notes":            market_value.ai_notes,
            "craigslist_asking_avg":  market_value.craigslist_avg,
            "craigslist_asking_low":  market_value.craigslist_low,
            "craigslist_asking_high": market_value.craigslist_high,
            "craigslist_count":      market_value.craigslist_count,
            "buy_new_trigger":     buy_new,
            "buy_new_message":     buy_new_msg,
            "sold_items_sample":   sold_items_sample[:4],
            "active_items_sample": active_items_sample[:4],
        },
        "security": _sec,
        "affiliate_cards": [
            {**card, "category_detected": category_detected, "affiliate_category": deal_score.affiliate_category or ""}
            for card in affiliate_dicts
        ],
        "affiliate_category": category_detected,
        "product_info": _pi,
        "product_evaluation": _pe,
        "metadata": {
            "server_ts": datetime.utcnow().isoformat(),
            "backend_version": BACKEND_VERSION,
            "extension_version": extension_version,
            "total_ms": round((_time.time() - scoring_start_ts) * 1000) if scoring_start_ts > 0 else None,
        },
    }


async def _save_score_log(scorecard: dict):
    try:
        import json as _json
        from scoring.data_pipeline import _get_pool
        await _ensure_score_log_table()
        pool = await _get_pool()
        await pool.execute(
            "INSERT INTO score_log (payload) VALUES ($1::jsonb)",
            _json.dumps(scorecard, default=str),
        )
        count = await pool.fetchval("SELECT COUNT(*) FROM score_log")
        if count > 500:
            await pool.execute(
                "DELETE FROM score_log WHERE id IN (SELECT id FROM score_log ORDER BY server_ts ASC LIMIT $1)",
                count - 500,
            )
    except Exception as e:
        log.warning(f"[score_log] save failed (non-fatal): {e}")


def _score_log_summary(r: dict) -> dict:
    listing = r.get("listing", {})
    ds = r.get("deal_score", {})
    pc = r.get("price_comparison", {})
    sec = r.get("security", {})
    aff = r.get("affiliate_cards", [])
    pe = r.get("product_evaluation", {})
    pi = r.get("product_info", {})
    return {
        "title":           listing.get("title"),
        "price":           listing.get("price"),
        "platform":        listing.get("platform"),
        "condition":       listing.get("condition"),
        "score":           ds.get("score"),
        "verdict":         ds.get("verdict"),
        "should_buy":      ds.get("should_buy"),
        "ai_confidence":   ds.get("ai_confidence"),
        "security_score":  sec.get("score"),
        "security_risk":   sec.get("risk_level"),
        "security_warnings_count": len(sec.get("warnings", [])),
        "data_source":     pc.get("data_source"),
        "market_confidence": pc.get("market_confidence"),
        "estimated_value": pc.get("estimated_value"),
        "sold_avg":        pc.get("sold_avg"),
        "new_price":       pc.get("new_price"),
        "affiliate_count": len(aff),
        "affiliate_programs": [c.get("program_key", "") for c in aff],
        "reliability_tier": pe.get("reliability_tier"),
        "brand":           pi.get("brand"),
        "model":           pi.get("model"),
        "category":        pi.get("category"),
    }


@app.get("/score-log")
async def get_score_log():
    try:
        import json as _json
        from scoring.data_pipeline import _get_pool
        await _ensure_score_log_table()
        pool = await _get_pool()
        rows = await pool.fetch(
            "SELECT id, server_ts, payload FROM score_log ORDER BY server_ts DESC LIMIT 500"
        )
        scorecards = []
        for r in rows:
            raw = r["payload"]
            p = _json.loads(raw) if isinstance(raw, str) else raw
            p["_id"] = r["id"]
            p["_server_ts"] = r["server_ts"].isoformat()
            scorecards.append(p)
        summary = [_score_log_summary(s) for s in scorecards]
        return {"count": len(scorecards), "summary": summary, "scorecards": scorecards}
    except Exception as e:
        return {"count": 0, "summary": [], "scorecards": [], "error": str(e)}


@app.delete("/score-log")
async def clear_score_log():
    try:
        from scoring.data_pipeline import _get_pool
        await _ensure_score_log_table()
        pool = await _get_pool()
        result = await pool.execute("DELETE FROM score_log")
        n = int(result.split()[-1]) if result else 0
        return {"ok": True, "cleared": n}
    except Exception as e:
        return {"ok": False, "error": str(e)}


from fastapi.responses import HTMLResponse

@app.get("/fbm-test", response_class=HTMLResponse)
async def fbm_test_page():
    return """<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>FBM SPA Simulator</title>
<style>
body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; margin: 0; background: #f0f2f5; }
[role="main"] { max-width: 900px; margin: 0 auto; padding: 20px; }
.nav { background: #1877f2; padding: 10px 20px; color: white; display: flex; gap: 10px; }
.nav button { background: white; color: #1877f2; border: none; padding: 8px 16px; border-radius: 6px; cursor: pointer; font-weight: 600; }
.nav button:hover { background: #e4e6eb; }
.listing-img { width: 400px; height: 300px; background: #ddd; display: flex; align-items: center; justify-content: center; border-radius: 8px; margin: 10px 0; font-size: 48px; }
.price { font-size: 28px; font-weight: 700; color: #1c1e21; }
.details { margin-top: 16px; padding: 16px; background: white; border-radius: 8px; }
.status { padding: 10px 20px; background: #fff3cd; font-family: monospace; font-size: 12px; }
img[src*="scontent"] { width: 400px; height: 300px; object-fit: cover; border-radius: 8px; }
</style></head>
<body>
<div class="status" id="status">Ready — click a listing button to simulate SPA navigation</div>
<div class="nav">
  <span style="font-weight:700;margin-right:10px;">FBM Test</span>
  <button onclick="navTo(0)">Listing 1: Telescope</button>
  <button onclick="navTo(1)">Listing 2: Arcade Cabinet</button>
  <button onclick="navTo(2)">Listing 3: Copper Kettle</button>
  <span style="margin-left:auto;font-size:12px;">Delay: <input id="delay" type="number" value="3000" style="width:60px">ms</span>
</div>
<div role="main" id="main-content">
  <p>Click a listing above to simulate Facebook Marketplace SPA navigation.</p>
  <p>The H1 title will update instantly, but the body content will update after the configured delay — simulating Facebook's React reconciliation lag.</p>
</div>
<script>
const listings = [
  {
    id: '111111111111111',
    title: '25" f/5 Obsession Telescope',
    price: '$8,000',
    condition: 'Good',
    img: 'https://upload.wikimedia.org/wikipedia/commons/thumb/4/4f/Roque_de_los_Muchachos_Observatory_2.jpg/320px-Roque_de_los_Muchachos_Observatory_2.jpg',
    desc: 'Selling my 25 inch f/5 Obsession Dobsonian telescope. This is a premium instrument for serious deep-sky observers. Mirror is in excellent condition with 96% reflectivity. Includes Servocad digital setting circles, Telrad finder, 2-inch Paracorr coma corrector, and custom shroud. Truss tubes are carbon fiber. Located in San Diego, local pickup only due to size. This scope regularly sells for $10,000+ new. Serious inquiries only please.'
  },
  {
    id: '222222222222222',
    title: 'Star Wars Arcade1up Cabinet',
    price: '$485',
    condition: 'Like New',
    img: 'https://upload.wikimedia.org/wikipedia/commons/thumb/6/6c/Star_Wars_-_arcadeflyer.png/220px-Star_Wars_-_arcadeflyer.png',
    desc: 'Star Wars Arcade1Up cabinet in like new condition. Barely used, bought 6 months ago. Includes the original riser and light-up marquee. Has Star Wars, Empire Strikes Back, and Return of the Jedi games. WiFi enabled for online leaderboards. Custom vinyl side panels in perfect condition. Retails for $599 new at Best Buy. Cash only, no trades.'
  },
  {
    id: '333333333333333',
    title: 'Vintage Copper Tea Kettle',
    price: '$45',
    condition: 'Good',
    img: 'https://upload.wikimedia.org/wikipedia/commons/thumb/3/33/Copper_Kettle.jpg/256px-Copper_Kettle.jpg',
    desc: 'Beautiful vintage copper tea kettle, likely from the 1960s or 1970s. Has a lovely patina and the copper is in great shape — no dents or major scratches. The handle is solid brass and the lid fits snugly. Holds about 2 quarts. Would make a great addition to a farmhouse kitchen or copper collection. I have several other copper pieces available if interested.'
  }
];
let currentIdx = -1;
function navTo(idx) {
  if (idx === currentIdx) return;
  const delay = parseInt(document.getElementById('delay').value) || 3000;
  const listing = listings[idx];
  const main = document.getElementById('main-content');
  const status = document.getElementById('status');
  const oldTitle = currentIdx >= 0 ? listings[currentIdx].title : '(none)';
  // Step 1: Update URL immediately (simulates pushState)
  history.pushState({}, '', '/marketplace/item/' + listing.id + '/?ref=product_details');
  // Step 2: Update H1 immediately (Facebook does this fast)
  status.textContent = `NAV: "${oldTitle}" → "${listing.title}" | H1 updated instantly, body updates in ${delay}ms...`;
  const h1 = main.querySelector('h1[dir="auto"]');
  if (h1) {
    h1.textContent = listing.title;
  } else {
    main.innerHTML = '<h1 dir="auto">' + listing.title + '</h1><div class="details" id="body-content"><p>Loading listing details...</p></div>';
  }
  // Step 3: Update body content AFTER delay (simulates React reconciliation lag)
  setTimeout(() => {
    const bodyEl = document.getElementById('body-content') || main;
    bodyEl.innerHTML = '<img src="' + listing.img + '" alt="' + listing.title + '">' +
      '<div class="price">' + listing.price + '</div>' +
      '<p><strong>Condition:</strong> ' + listing.condition + '</p>' +
      '<p>' + listing.desc + '</p>' +
      '<p><strong>Listed:</strong> 2 days ago</p>' +
      '<p><strong>Location:</strong> San Diego, CA</p>';
    status.textContent = `READY: "${listing.title}" fully loaded (body updated after ${delay}ms delay)`;
  }, delay);
  currentIdx = idx;
}
</script></body></html>"""


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "api.main:app",
        host="0.0.0.0",
        port=API_PORT,
        reload=True,
        log_level=os.getenv("LOG_LEVEL", "info").lower(),
    )
