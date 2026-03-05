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

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from dotenv import load_dotenv

load_dotenv()

# Add project root to path so we can import from /scoring
sys.path.append(str(Path(__file__).parent.parent))

from scoring.ebay_pricer import get_market_value
from scoring.deal_scorer import score_deal
from scoring.product_extractor import extract_product, ProductInfo
from scoring.product_evaluator import evaluate_product
from scoring.suggestion_engine import get_suggestions
from dataclasses import asdict as dc_asdict_top

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

# CORS — allow the React UI to call this API
# WHY explicit origins: wildcard (*) is fine for POC but we scope it
# to our known UI port so it's easy to tighten later
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        f"http://localhost:{UI_PORT}",
        f"http://127.0.0.1:{UI_PORT}",
    ],
    allow_methods=["*"],
    allow_headers=["*"],
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
    seller_trust:   dict = {}     # Seller trust signals extracted by content script
    original_price: float = 0.0   # Crossed-out price if seller reduced it (from DOM dual-price container)
    shipping_cost:  float = 0.0   # Cost to ship — 0 means free or local pickup
    image_urls:     list = []     # Listing photo URLs — first one sent to Claude Vision

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
    active_avg:        float
    new_price:         float
    market_confidence: str
    data_source:       str = "ebay"  # "ebay" | "google_shopping" | "ebay_mock"

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

    # Product intelligence — new modules
    product_info:       dict = {}   # Extracted brand/model/search_query from ProductExtractor
    product_evaluation: dict = {}   # Reliability tier, known issues from ProductEvaluator
    suggestions:        list = []   # Actionable buy recommendations from SuggestionEngine


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
async def score_listing(listing: ListingRequest):
    """
    Main endpoint — runs the full 5-step product intelligence pipeline.

    Step 1: Product extraction — Claude Haiku converts vague titles to specific queries
    Step 2: Parallel — eBay market value (extracted query) + product reliability eval
    Step 3: Claude deal scoring with reputation context injected into prompt
    Step 4: Suggestion engine — affiliate buy cards (same_cheaper / better_model / amazon)
    Step 5: Serialize and return
    """
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

    # ── Step 4: Generate suggestions ──────────────────────────────────────────
    try:
        suggestions = await get_suggestions(
            product_info  = product_info,
            market_value  = market_value,
            deal_score    = deal_score,
            listing_price = listing.price,
        )
    except Exception as e:
        log.warning(f"Suggestion engine failed ({e}) — returning empty suggestions")
        suggestions = []

    # ── Step 5: Serialize ────────────────────────────────────────────────
    sold_items_sample   = [dc_asdict(i) for i in (market_value.sold_items_sample   or [])]
    active_items_sample = [dc_asdict(i) for i in (market_value.active_items_sample or [])]
    suggestions_dicts   = [dc_asdict(s) for s in suggestions]

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
        active_avg          = market_value.active_avg,
        new_price           = market_value.new_price,
        market_confidence   = market_value.confidence,
        data_source         = market_value.data_source,
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

        # Product intelligence
        product_info       = dc_asdict_top(product_info),
        product_evaluation = dc_asdict_top(product_eval),
        suggestions        = suggestions_dicts,
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


@app.get("/health")
async def health():
    """Detailed health check — confirms API keys are configured."""
    return {
        "api":          "ok",
        "anthropic_key": "set" if os.getenv("ANTHROPIC_API_KEY") else "missing",
        "ebay_key":      "set" if os.getenv("EBAY_APP_ID") and "your_ebay" not in os.getenv("EBAY_APP_ID", "") else "missing — using mock data",
    }


# ── Dev Entry Point ───────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "api.main:app",
        host="0.0.0.0",
        port=API_PORT,
        reload=True,  # Auto-restart on code changes during dev
        log_level=os.getenv("LOG_LEVEL", "info").lower(),
    )
