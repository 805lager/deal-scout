"""
FastAPI Backend — Personal Shopping Bot

Exposes a single endpoint for the POC:
  POST /score  — accepts listing details, runs the full pipeline, returns a deal score

The pipeline it runs:
  1. Receives listing data from the React UI
  2. Calls ebay_pricer.py to get market value
  3. Calls deal_scorer.py to get Claude's AI analysis
  4. Returns the combined result as JSON

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
    title:       str
    price:       float
    raw_price_text: str = ""
    description: str   = ""
    location:    str   = ""
    condition:   str   = "Unknown"
    seller_name: str   = ""
    listing_url: str   = ""

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

    # Market value from eBay
    estimated_value:  float
    sold_avg:         float
    sold_count:       int
    active_avg:       float
    new_price:        float
    market_confidence: str

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
    Main endpoint — runs the full pipeline for a single listing.

    Takes listing details from the UI, returns a complete deal score.
    The React UI calls this when the user hits 'Score This Deal'.

    Pipeline:
      1. Build a listing dict from the request
      2. Call eBay pricer to get market value
      3. Call Claude scorer to get AI analysis
      4. Combine and return
    """
    log.info(f"Scoring request: '{listing.title}' @ ${listing.price}")

    # Build listing dict — matches the format our scorer expects
    listing_dict = {
        "title":          listing.title,
        "price":          listing.price,
        "raw_price_text": listing.raw_price_text or f"${listing.price:.0f}",
        "description":    listing.description,
        "location":       listing.location,
        "condition":      listing.condition,
        "seller_name":    listing.seller_name,
        "listing_url":    listing.listing_url,
        "image_urls":     [],
    }

    # Step 1: Get eBay market value
    try:
        market_value = await get_market_value(
            listing_title=listing.title,
            listing_condition=listing.condition,
        )
    except Exception as e:
        log.error(f"eBay pricing failed: {e}")
        raise HTTPException(status_code=500, detail=f"Market value lookup failed: {str(e)}")

    # Step 2: Get Claude deal score
    # WHY asdict: MarketValue is a dataclass — asdict converts it cleanly to
    # a plain dict that score_deal expects. The inline vars() approach was brittle.
    from dataclasses import asdict as dc_asdict
    market_value_dict = dc_asdict(market_value)

    try:
        deal_score = await score_deal(listing_dict, market_value_dict)
    except Exception as e:
        log.error(f"Claude scoring exception: {e}")
        raise HTTPException(status_code=500, detail=f"AI scoring exception: {str(e)}")

    if not deal_score:
        # score_deal returns None on failure — check the API server terminal
        # for the detailed error logged by deal_scorer.py
        raise HTTPException(
            status_code=500,
            detail="AI scoring returned None — check API terminal for the real error"
        )

    log.info(f"Score: {deal_score.score}/10 — {deal_score.verdict}")

    return DealScoreResponse(
        # Listing
        title     = listing.title,
        price     = listing.price,
        location  = listing.location,
        condition = listing.condition,

        # Market value
        estimated_value   = market_value.estimated_value,
        sold_avg          = market_value.sold_avg,
        sold_count        = market_value.sold_count,
        active_avg        = market_value.active_avg,
        new_price         = market_value.new_price,
        market_confidence = market_value.confidence,

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
