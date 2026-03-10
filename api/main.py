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
from pydantic import BaseModel
from dotenv import load_dotenv
from typing import Optional
from collections import defaultdict

load_dotenv()

# Add project root to path so we can import from /scoring
sys.path.append(str(Path(__file__).parent.parent))

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

API_PORT = int(os.getenv("API_PORT", "8000"))
UI_PORT  = int(os.getenv("UI_PORT",  "3000"))

app = FastAPI(
    title="Personal Shopping Bot API",
    description="AI-powered deal scoring for second-hand marketplace listings",
    version="0.1.0-poc",
)

# ── Rate Limiting ─────────────────────────────────────────────────────────────
# Simple in-memory IP rate limiter — no Redis needed for POC.
# Protects Claude API credits from abuse if someone discovers the Railway URL.
# Limits: 30 scores/hour per IP (generous for a real user, blocks scrapers).
_rate_limit_store: dict = defaultdict(list)
RATE_LIMIT_REQUESTS = 30
RATE_LIMIT_WINDOW   = 3600  # seconds (1 hour)

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
            detail=f"Rate limit: {RATE_LIMIT_REQUESTS} scores per hour. Try again later."
        )
    _rate_limit_store[client_ip].append(now)

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
    allow_headers=["Content-Type", "Authorization"],
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
    data_source:       str = "ebay"  # "ebay" | "google_shopping" | "ebay_mock" | "cargurus" | "craigslist"
    query_used:        str = ""       # The actual eBay/Google search query used for comps

    # Like Products — real eBay items surfaced as affiliate cards
    sold_items_sample:   list = []
    active_items_sample: list = []

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
    image_analyzed:    bool = False  # True when Claude Vision was used on listing photo
    original_price:    float = 0.0  # Seller's original price if reduced (strikethrough)
    shipping_cost:     float = 0.0  # Shipping cost extracted from listing (0 = free/pickup)

    # Product intelligence
    product_info:          dict = {}   # Extracted brand/model/search_query
    product_evaluation:    dict = {}   # Reliability tier, known issues
    affiliate_cards:       list = []   # Ranked affiliate recommendation cards
    buy_new_trigger:       bool = False
    buy_new_message:       str  = ""
    category_detected:     str  = ""
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
    # Rate limit by IP — protects Claude API credits from abuse
    client_ip = request.headers.get("x-forwarded-for", request.client.host if request.client else "unknown").split(",")[0].strip()
    _check_rate_limit(client_ip)

    log.info(f"Scoring request: '{listing.title}' @ ${listing.price}")

    # ── Step 1: Extract product identity ────────────────────────────────────────
    # "Telescope" → "Orion SkyQuest XT8 Intelliscope" — this single step
    # is the biggest accuracy improvement in the entire pipeline.
    try:
        product_info = await extract_product(listing.title, listing.description)
    except Exception as e:
        log.warning(f"Product extraction failed ({e}) — using title fallback")
        from scoring.product_extractor import _fallback_extraction
        product_info = _fallback_extraction(listing.title)

    # ── Step 2: Parallel — eBay market value + product evaluation ────────────
    # Both are I/O-bound. Running concurrently saves ~1-2s vs sequential.
    try:
        market_value, product_eval = await asyncio.gather(
            get_market_value(
                listing_title     = product_info.search_query,  # extracted query, not raw title
                listing_condition = listing.condition,
                is_vehicle        = listing.is_vehicle,
                listing_price     = listing.price,  # for plausibility guard in ebay_pricer
            ),
            evaluate_product(
                brand        = product_info.brand,
                model        = product_info.model,
                category     = product_info.category,
                display_name = product_info.display_name,
            ),
            return_exceptions=True,
        )

        if isinstance(market_value, Exception):
            log.error(f"eBay pricing failed: {market_value}")
            raise HTTPException(status_code=500, detail=f"Market value lookup failed: {market_value}")

        if isinstance(product_eval, Exception):
            log.warning(f"Product evaluation failed ({product_eval}) — continuing without")
            from scoring.product_evaluator import _unknown_evaluation
            product_eval = _unknown_evaluation(product_info.display_name)

    except HTTPException:
        raise
    except Exception as e:
        log.error(f"Parallel fetch failed: {e}")
        raise HTTPException(status_code=500, detail=f"Market data fetch failed: {e}")

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
    }

    image_url = listing.image_urls[0] if listing.image_urls else None

    try:
        deal_score = await score_deal(
            listing_dict,
            market_value_dict,
            image_url          = image_url,
            product_evaluation = product_eval,
        )
    except RuntimeError as e:
        real_error = str(e)
        log.error(f"Scoring failed: {real_error}")
        raise HTTPException(status_code=500, detail=real_error)
    except Exception as e:
        log.error(f"Unexpected scoring exception: {type(e).__name__}: {e}")
        raise HTTPException(status_code=500, detail=f"{type(e).__name__}: {e}")

    if not deal_score:
        raise HTTPException(status_code=500, detail="Scorer returned no result — check API terminal")

    log.info(f"Score: {deal_score.score}/10 — {deal_score.verdict}")

    # ── Step 4: Generate affiliate recommendations ──────────────────────────────
    from scoring.affiliate_router import detect_category
    # Compute category here so it can be passed to both the affiliate router
    # and the security scorer. Override to 'vehicles' when is_vehicle=True:
    # detect_category() text-matches product_info and returns 'general' for
    # car listings (BMW 328i has no word 'vehicle' in its description),
    # which then triggers the Amazon safety net. (Bug B-V4)
    category_detected = detect_category(product_info)
    if listing.is_vehicle and category_detected not in ("vehicles", "cars", "trucks"):
        log.info(f"[Category] Overriding '{category_detected}' → 'vehicles' (is_vehicle=True)")
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

    # ── Step 4b: Security / scam scoring (runs concurrently with affiliate routing) ──
    # WHY CONCURRENT: security scoring is a separate Haiku call (~1s).
    # Running it after deal scoring (not before) means it never delays the score.
    # Both affiliate routing and security scoring are post-score steps.
    try:
        security = await asyncio.wait_for(
            score_security(
                listing          = listing,
                category         = category_detected,
                market_value     = market_value,
                normalized_title = product_info.display_name,  # corrected name from product_extractor
            ),
            timeout=10.0,
        )
    except Exception as e:
        import traceback
        err_detail = traceback.format_exc()
        log.warning(f"Security scoring failed: {err_detail}")
        from scoring.security_scorer import SecurityScore as _SS
        security = _SS(score=5, risk_level="unknown", flags=[], recommendation="unable to assess")

    # ── Step 5: Serialize ────────────────────────────────────────────────────
    from dataclasses import asdict as dc_asdict
    sold_items_sample   = [dc_asdict(i) for i in (market_value.sold_items_sample   or [])]
    active_items_sample = [dc_asdict(i) for i in (market_value.active_items_sample or [])]
    affiliate_dicts     = [dc_asdict(c) for c in affiliate_cards]

    return DealScoreResponse(
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
        model_used        = deal_score.model_used,
        image_analyzed    = deal_score.image_analyzed,

        # Product intelligence + affiliate
        product_info       = dc_asdict_top(product_info),
        product_evaluation = dc_asdict_top(product_eval),
        affiliate_cards    = affiliate_dicts,
        buy_new_trigger    = buy_new,
        buy_new_message    = buy_new_msg,
        category_detected  = category_detected,
        security_score     = dc_asdict_top(security),
    )


@app.get("/test-claude")
async def test_claude():
    """
    Directly tests the Claude API connection from inside the server.
    Visit http://localhost:8000/test-claude to diagnose key/credit issues.
    """
    import anthropic
    api_key = os.getenv("ANTHROPIC_API_KEY", "")
    if not api_key:
        return {"status": "error", "detail": "ANTHROPIC_API_KEY not set in .env"}

    try:
        loop = asyncio.get_event_loop()
        c = anthropic.Anthropic(api_key=api_key)
        r = await loop.run_in_executor(
            None,
            lambda: c.messages.create(
                model="claude-haiku-4-5-20251001",
                max_tokens=10,
                messages=[{"role": "user", "content": "say hi"}]
            )
        )
        return {
            "status": "ok",
            "response": r.content[0].text,
            "model": r.model,
            "key_prefix": api_key[:20] + "..."
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


@app.get("/test-gemini")
async def test_gemini():
    """
    Tests Gemini API + Search Grounding end-to-end.
    Visit /test-gemini after deploying to Railway to confirm the new pricer works.
    Tests with a Celestron NexStar 6SE — a product with a well-known used market.
    """
    from scoring.gemini_pricer import get_gemini_market_price, gemini_is_configured, GEMINI_MODEL
    api_key = os.getenv("GOOGLE_AI_API_KEY", "")
    if not api_key:
        return {
            "status": "not_configured",
            "detail": "GOOGLE_AI_API_KEY not set. Add it to Railway environment variables.",
            "get_key_at": "https://aistudio.google.com/",
        }
    try:
        result = await get_gemini_market_price(
            query         = "Celestron NexStar 6SE telescope",
            condition     = "Used",
            listing_price = 600.0,
        )
        if result:
            return {
                "status":          "ok",
                "model":           GEMINI_MODEL,
                "key_prefix":      api_key[:20] + "...",
                "avg_used_price":  result["avg_used_price"],
                "price_range":     f"${result['price_low']:.0f}–${result['price_high']:.0f}",
                "new_retail":      result["new_retail"],
                "confidence":      result["confidence"],
                "data_source":     result["data_source"],
                "item_id":         result["item_id"],
                "notes":           result["notes"],
            }
        else:
            return {
                "status": "no_result",
                "detail": "Gemini returned no price — check logs for prompt/parse errors.",
                "model":  GEMINI_MODEL,
            }
    except Exception as e:
        return {
            "status": "error",
            "detail": str(e),
            "type":   type(e).__name__,
        }


@app.get("/health")
async def health():
    """Detailed health check — confirms API keys are configured."""
    return {
        "api":          "ok",
        "anthropic_key": "set" if os.getenv("ANTHROPIC_API_KEY") else "missing",
        "ebay_key":      "set" if os.getenv("EBAY_APP_ID") and "your_ebay" not in os.getenv("EBAY_APP_ID", "") else "missing — using mock data",
    }


class AnalyticsEvent(BaseModel):
    """Privacy-safe analytics event from the extension."""
    event:        str
    program:      str   = ""
    category:     str   = ""
    price_bucket: str   = ""
    card_type:    str   = ""
    deal_score:   int   = 0


@app.post("/event")
async def record_event(evt: AnalyticsEvent):
    """
    Receive an anonymous analytics event from the extension.

    WHY THIS EXISTS:
      Affiliate click data is the foundation of the market intelligence product.
      Over time, aggregate data tells us: which categories have the biggest
      used-vs-new price gap, which affiliate programs convert best per category,
      and which item types are most in-demand on used marketplaces.

    PRIVACY:
      No user ID, IP, listing URL, or identifiable data is stored.
      Only category-level, price-bucketed, aggregated signals.
      GDPR/CCPA compliant by design — nothing to delete.
    """
    record = {
        "event":        evt.event,
        "program":      evt.program,
        "category":     evt.category,
        "price_bucket": evt.price_bucket,
        "card_type":    evt.card_type,
        "deal_score":   evt.deal_score,
        "hour":         __import__("datetime").datetime.utcnow().strftime("%Y-%m-%dT%H:00"),
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


@app.post("/feedback")
async def submit_feedback(body: FeedbackRequest, request: Request):
    """
    Accepts a manual query correction from the sidebar or admin page.
    Saves to corrections.jsonl and immediately affects future scores.

    Example: GoPro listing gets compared to GoPro accessories instead of cameras.
    Submit: bad_query="GoPro accessories" good_query="GoPro HERO 12 Black camera"
    Next GoPro listing will use the corrected query automatically.
    """
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
    Simple HTML admin page for reviewing and correcting market comparison queries.
    Visit: https://deal-scout-production.up.railway.app/admin

    Shows the correction log and a form to add new corrections.
    No auth (obscurity only) — add HTTP Basic Auth before sharing publicly.
    """
    from scoring.corrections import get_all_corrections
    corrections = get_all_corrections()

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


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "api.main:app",
        host="0.0.0.0",
        port=API_PORT,
        reload=True,
        log_level=os.getenv("LOG_LEVEL", "info").lower(),
    )
