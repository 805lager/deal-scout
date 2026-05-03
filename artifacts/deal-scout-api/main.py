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
from fastapi.responses import StreamingResponse, HTMLResponse
from pydantic import BaseModel, Field
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
from scoring.affiliate_router import get_affiliate_recommendations, should_trigger_buy_new, get_program_status, build_affiliate_event, filter_affiliate_cards
from scoring.security_scorer import score_security, SecurityScore
from scoring.confidence import derive_confidence, cant_price_message
from dataclasses import asdict as dc_asdict_top
import time as _time
import json as _json
from datetime import datetime


try:
    Path(__file__).parent.parent.joinpath("data").mkdir(parents=True, exist_ok=True)
except Exception:
    pass

_affiliate_events_table_ensured = False

async def _ensure_affiliate_events_table():
    global _affiliate_events_table_ensured
    if _affiliate_events_table_ensured:
        return
    from scoring.data_pipeline import _get_pool
    pool = await _get_pool()
    if not pool:
        return
    await pool.execute("""
        CREATE TABLE IF NOT EXISTS affiliate_events (
            id serial PRIMARY KEY,
            created_at timestamptz DEFAULT now(),
            event text NOT NULL,
            program text DEFAULT '',
            category text DEFAULT '',
            price_bucket text DEFAULT '',
            card_type text DEFAULT '',
            deal_score int DEFAULT 0,
            position int DEFAULT 0,
            selection_reason text DEFAULT '',
            commission_live boolean DEFAULT false
        )
    """)
    _affiliate_events_table_ensured = True

_affiliate_flags_table_ensured = False

async def _ensure_affiliate_flags_table():
    """v0.46.0 — store user-reported wrong/spammy affiliate cards per listing."""
    global _affiliate_flags_table_ensured
    if _affiliate_flags_table_ensured:
        return
    from scoring.data_pipeline import _get_pool
    pool = await _get_pool()
    if not pool:
        return
    await pool.execute("""
        CREATE TABLE IF NOT EXISTS affiliate_flags (
            id serial PRIMARY KEY,
            flagged_at timestamptz DEFAULT now(),
            listing_url text NOT NULL,
            program_key text NOT NULL,
            brand text DEFAULT '',
            model text DEFAULT '',
            retailer text DEFAULT '',
            url text DEFAULT '',
            install_id text DEFAULT NULL,
            reason text DEFAULT ''
        )
    """)
    await pool.execute(
        "CREATE INDEX IF NOT EXISTS idx_affiliate_flags_listing ON affiliate_flags (listing_url)"
    )
    _affiliate_flags_table_ensured = True


async def _get_flagged_programs(listing_url: str) -> set:
    """Return {program_key} previously flagged for this listing."""
    if not listing_url:
        return set()
    try:
        from scoring.data_pipeline import _get_pool
        pool = await _get_pool()
        if not pool:
            return set()
        rows = await pool.fetch(
            "SELECT DISTINCT program_key FROM affiliate_flags WHERE listing_url=$1",
            listing_url,
        )
        return {r["program_key"] for r in rows if r.get("program_key")}
    except Exception:
        return set()


_corrections_table_ensured = False

async def _ensure_corrections_table():
    global _corrections_table_ensured
    if _corrections_table_ensured:
        return
    from scoring.data_pipeline import _get_pool
    pool = await _get_pool()
    if not pool:
        return
    await pool.execute("""
        CREATE TABLE IF NOT EXISTS query_corrections (
            id serial PRIMARY KEY,
            created_at timestamptz DEFAULT now(),
            listing_title text NOT NULL,
            bad_query text DEFAULT '',
            good_query text DEFAULT '',
            correct_price_low float DEFAULT 0,
            correct_price_high float DEFAULT 0,
            notes text DEFAULT ''
        )
    """)
    _corrections_table_ensured = True

logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO"),
    format="%(asctime)s [%(levelname)s] %(message)s"
)
log = logging.getLogger(__name__)

API_PORT = int(os.getenv("PORT", os.getenv("API_PORT", "8000")))
UI_PORT  = int(os.getenv("UI_PORT",  "3000"))

# ── In-memory score cache ─────────────────────────────────────────────────────
# Keyed by (title.lower(), price) or listing_url when available.
# URL-matched results get a longer 2-hour TTL since the same listing rarely changes.
# Title+price matches keep 20-minute TTL as a fallback for listings without URLs.
_score_cache: dict = {}
_SCORE_CACHE_TTL = 1200  # 20 minutes (title+price keyed)
_SCORE_CACHE_TTL_URL = 7200  # 2 hours (URL-keyed)

def _cache_key(title: str, price: float, listing_url: str = "") -> str:
    import hashlib
    if listing_url and listing_url.startswith("http"):
        raw = listing_url.strip()
    else:
        raw = f"{title.strip().lower()}|{price:.2f}"
    return hashlib.md5(raw.encode()).hexdigest()

def _cache_get(key: str):
    entry = _score_cache.get(key)
    if not entry:
        return None
    ttl = entry.get("ttl", _SCORE_CACHE_TTL)
    if _time.time() - entry["ts"] > ttl:
        del _score_cache[key]
        return None
    return entry["payload"]

def _cache_set(key: str, payload, url_keyed: bool = False):
    """
    Store a cache payload. We coerce Pydantic models to dicts at write time
    so every consumer of `_cache_get(...)` can rely on getting a plain dict
    back (and can safely use `{**cached, "cached": True}` to stamp the flag
    without a TypeError on model objects).
    """
    if hasattr(payload, "model_dump"):
        payload = payload.model_dump()
    if len(_score_cache) > 500:
        oldest = min(_score_cache, key=lambda k: _score_cache[k]["ts"])
        del _score_cache[oldest]
    ttl = _SCORE_CACHE_TTL_URL if url_keyed else _SCORE_CACHE_TTL
    _score_cache[key] = {"ts": _time.time(), "payload": payload, "ttl": ttl}


# ── Persistent score cache (Postgres) ────────────────────────────────────────
# Reproducibility-grade cache: keyed by sha256(url + listing_hash + asking_price)
# so a relisted, re-priced, or photo-edited listing reprices automatically while
# an unchanged scrape always returns the same score. Survives server restart
# (the in-memory _score_cache above does not). 24-hour TTL — long enough that
# casual repeat scrolls never repay Claude, short enough that stale market data
# (eBay sold comps drift over a few days) gets refreshed.
#
# Two layers (in-memory above + persistent here) coexist intentionally:
#   • in-memory: ~1ms, 20min/2hr TTL, survives nothing — protects against burst
#     re-scrapes from the same browser tab
#   • persistent: ~5ms DB read, 24h TTL, survives restarts — guarantees a user
#     who scores the same unchanged listing tomorrow gets the same number
import hashlib as _hashlib

_score_cache_table_ensured = False
_SCORE_CACHE_PERSIST_TTL_SECONDS = 86400  # 24h
# Hit/miss counters drive the /admin/dashboard hit-rate metric. Process-local
# so they reset on restart — that's fine, the dashboard reads them as
# "since-restart" stats, not all-time.
_score_cache_stats = {"hits": 0, "misses": 0}

def _listing_content_hash(title: str, description: str, image_urls: list) -> str:
    """
    Stable fingerprint of the listing's user-visible content. Same scrape →
    same hash. We deliberately include the first 5 image URLs (not raw bytes)
    because a relisted item with new photos almost always means new condition
    info and should reprice; URL-string equality is a cheap proxy that catches
    that case without paying to fetch images.
    """
    parts = [
        (title or "").strip().lower(),
        (description or "").strip()[:1000],   # cap so 8k descriptions don't dominate hashing time
        "|".join((image_urls or [])[:5]),
    ]
    return _hashlib.sha256("|".join(parts).encode("utf-8")).hexdigest()[:16]

def _persistent_cache_key(url: str, listing_hash: str, asking_price: float) -> str:
    """
    Reproducibility key. URL alone isn't enough (relistings) and content alone
    isn't enough (price-only edits). All three combined make a stable identity.
    """
    raw = f"{(url or '').strip()}|{listing_hash}|{float(asking_price or 0):.2f}"
    return _hashlib.sha256(raw.encode("utf-8")).hexdigest()

async def _ensure_score_cache_table():
    """Lazy-create the score_cache table on first use (same pattern as
    affiliate_events / score_log / nav_debug above). Idempotent."""
    global _score_cache_table_ensured
    if _score_cache_table_ensured:
        return
    from scoring.data_pipeline import _get_pool
    pool = await _get_pool()
    if not pool:
        return
    await pool.execute("""
        CREATE TABLE IF NOT EXISTS score_cache (
            cache_key     text PRIMARY KEY,
            listing_url   text DEFAULT '',
            asking_price  float DEFAULT 0,
            response_json jsonb NOT NULL,
            created_at    timestamptz DEFAULT now(),
            expires_at    timestamptz NOT NULL
        )
    """)
    # url index supports targeted invalidation via /admin/score-cache/clear?url=...
    # expires_at index keeps cleanup queries fast.
    await pool.execute("CREATE INDEX IF NOT EXISTS idx_score_cache_url     ON score_cache(listing_url)")
    await pool.execute("CREATE INDEX IF NOT EXISTS idx_score_cache_expires ON score_cache(expires_at)")
    _score_cache_table_ensured = True

async def _persist_cache_get(cache_key: str) -> Optional[dict]:
    """
    Returns cached score payload if non-expired, else None. Failures are
    swallowed (warning-logged) — a cache lookup must never break scoring.
    """
    try:
        await _ensure_score_cache_table()
        from scoring.data_pipeline import _get_pool
        pool = await _get_pool()
        if not pool:
            return None
        row = await pool.fetchrow(
            "SELECT response_json FROM score_cache WHERE cache_key = $1 AND expires_at > now()",
            cache_key,
        )
        if not row:
            _score_cache_stats["misses"] += 1
            return None
        _score_cache_stats["hits"] += 1
        # asyncpg returns jsonb as a JSON string by default (no custom codec
        # registered in this project), hence the json.loads.
        raw = row["response_json"]
        return _json.loads(raw) if isinstance(raw, str) else dict(raw)
    except Exception as e:
        log.warning(f"[ScoreCache] read failed (non-fatal): {e}")
        return None

async def _persist_cache_set(cache_key: str, payload: dict, listing_url: str = "", asking_price: float = 0.0):
    """Upsert (cache_key conflict ⇒ refresh response + bump expires_at)."""
    try:
        await _ensure_score_cache_table()
        from scoring.data_pipeline import _get_pool
        pool = await _get_pool()
        if not pool:
            return
        from datetime import timedelta, timezone
        expires = datetime.now(timezone.utc) + timedelta(seconds=_SCORE_CACHE_PERSIST_TTL_SECONDS)
        await pool.execute(
            """INSERT INTO score_cache (cache_key, listing_url, asking_price, response_json, expires_at)
               VALUES ($1, $2, $3, $4::jsonb, $5)
               ON CONFLICT (cache_key) DO UPDATE SET
                   response_json = EXCLUDED.response_json,
                   expires_at    = EXCLUDED.expires_at,
                   created_at    = now()""",
            cache_key, listing_url or "", float(asking_price or 0.0),
            _json.dumps(payload), expires,
        )
    except Exception as e:
        log.warning(f"[ScoreCache] write failed (non-fatal): {e}")

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

def _build_confidence_payload(market_value, product_info, asking_price: float) -> dict:
    """
    Task #58 — Assemble the confidence + comp_summary + can_price block
    that both /score and /score/stream attach to DealScoreResponse.

    Single source of truth so the streaming and non-streaming paths can't
    drift. Uses MarketValue.comp_summary when the Browse pipeline emitted
    one; otherwise synthesises a summary from the aggregate sold stats so
    Google/AI-only paths still surface a comp count to the UI.

    Returns a dict ready to splat into DealScoreResponse(**payload, ...).
    """
    # Prefer the cleaned summary surfaced by ebay_pricer.clean_browse_comps.
    comp_summary = getattr(market_value, "comp_summary", None)
    if not comp_summary:
        # Synthesise from aggregate stats — no item-level cleaning happened
        # (Google-only / AI-knowledge / Craigslist path), but we still want
        # SOMETHING in the chip rather than a confusing empty state.
        comp_summary = {
            "count":                        int(getattr(market_value, "sold_count", 0) or 0),
            "median":                       float(getattr(market_value, "sold_avg", 0.0) or 0.0),
            "low":                          float(getattr(market_value, "sold_low", 0.0) or 0.0),
            "high":                         float(getattr(market_value, "sold_high", 0.0) or 0.0),
            "outliers_removed":             0,
            "condition_mismatches_removed": 0,
            "recency_window":               "",
        }

    bucket, signals = derive_confidence(
        comp_count            = int(comp_summary.get("count", 0) or 0),
        comp_low              = float(comp_summary.get("low", 0.0) or 0.0),
        comp_high             = float(comp_summary.get("high", 0.0) or 0.0),
        comp_median           = float(comp_summary.get("median", 0.0) or 0.0),
        extraction_confidence = getattr(product_info, "confidence", "medium") or "medium",
        market_confidence     = getattr(market_value, "confidence", "") or "",
    )

    can_price   = bucket != "none"
    cp_message  = "" if can_price else cant_price_message(asking_price)

    # "What we tried" expandable — minimal payload from what we have on hand.
    queries_attempted = []
    q_used = (getattr(market_value, "query_used", "") or "").strip()
    if q_used:
        queries_attempted.append({
            "query":  q_used,
            "count":  int(comp_summary.get("count", 0) or 0),
            "source": getattr(market_value, "data_source", "") or "",
        })

    return {
        "confidence":         bucket,
        "confidence_signals": signals,
        "comp_summary":       comp_summary,
        "can_price":          can_price,
        "cant_price_message": cp_message,
        "queries_attempted":  queries_attempted,
    }


def _check_rate_limit(client_ip: str):
    now = _time.time()
    window_start = now - RATE_LIMIT_WINDOW
    # Prune timestamps outside window
    _rate_limit_store[client_ip] = [
        t for t in _rate_limit_store[client_ip] if t > window_start
    ]
    if len(_rate_limit_store[client_ip]) >= RATE_LIMIT_REQUESTS:
        retry_after = int(RATE_LIMIT_WINDOW - (now - _rate_limit_store[client_ip][0])) + 1
        raise HTTPException(
            status_code=429,
            detail=f"Rate limit: {RATE_LIMIT_REQUESTS} scores per day. Try again tomorrow.",
            headers={"Retry-After": str(max(retry_after, 60))},
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

# ── Admin Auth ─────────────────────────────────────────────────────────────────
# Separate secret from DS_API_KEY. The extension's user-facing key (DS_API_KEY)
# would be exposed in every install of the extension if shared with admin —
# admin endpoints (dashboards, audit, telemetry, manual triggers) MUST use a
# distinct token that never ships in client code.
#
# FAIL CLOSED: if ADMIN_TOKEN is unset, admin endpoints return 503. Previously
# the absence of a key meant "open access" — that footgun let unauthenticated
# users hit /admin/dashboard, /admin/audit/*, /admin/daily-summary in any env
# where the operator forgot to configure a key.
_DS_ADMIN_TOKEN = os.getenv("ADMIN_TOKEN", "")

def _check_admin_token(request: Request):
    """
    Gate for /admin/* routes. Requires the ADMIN_TOKEN secret to be set AND
    a matching value supplied via the X-Admin-Token (preferred) or X-DS-Key
    (legacy compat — remove next release) header.

    URL/query-param auth was intentionally NOT included: tokens passed via
    ?admin_token= would leak into request logs, browser history, referrer
    headers, and any link a dashboard renders. Header auth has none of
    those failure modes.
    """
    if not _DS_ADMIN_TOKEN:
        raise HTTPException(
            status_code=503,
            detail="Admin endpoints disabled — set ADMIN_TOKEN env var to enable.",
        )
    provided = (
        request.headers.get("X-Admin-Token", "")
        or request.headers.get("X-DS-Key", "")  # legacy compat — remove next release
    )
    if provided != _DS_ADMIN_TOKEN:
        raise HTTPException(status_code=401, detail="Unauthorized")

# CORS — configurable via CORS_ORIGINS env var
#
# Content scripts run in the context of facebook.com, so every API request
# carries Origin: https://www.facebook.com. Popup requests carry the
# chrome-extension:// origin. Both must be allowed.
#
# Default:     Restricted to marketplace domains + production app
# Production:  Override via CORS_ORIGINS env var to add extension origin:
#   CORS_ORIGINS=https://www.facebook.com,https://www.craigslist.org,https://www.ebay.com,https://offerup.com,https://www.offerup.com,https://deal-scout-805lager.replit.app,chrome-extension://YOUR_EXTENSION_ID
#
# Get your extension ID from chrome://extensions after loading the unpacked
# extension. It stays stable once published to the Chrome Web Store.
# IMPORTANT: Add chrome-extension://ID to CORS_ORIGINS in production.
_CORS_DEFAULT = ",".join([
    "https://www.facebook.com",
    "https://www.craigslist.org",
    "https://www.ebay.com",
    "https://offerup.com",
    "https://www.offerup.com",
    "https://deal-scout-805lager.replit.app",
    "chrome-extension://mbkhagpggkmefaompfjkbbnbmmameapk",
])
_cors_raw = os.getenv("CORS_ORIGINS", _CORS_DEFAULT)
cors_origins = ["*"] if _cors_raw.strip() == "*" else [
    o.strip() for o in _cors_raw.split(",") if o.strip()
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization", "X-DS-Key", "X-Admin-Token",
                    "X-DS-Ext-Version", "X-DS-Install-Id",
                    "Accept", "Accept-Language", "Content-Language"],
)


# ── Request / Response Models ─────────────────────────────────────────────────

class ListingRequest(BaseModel):
    """
    What the React UI sends us.
    All fields except title and price are optional — we handle missing data gracefully.
    """
    # NOTE: max_length caps below are intentional defense-in-depth. They are
    # generous (5x the largest legitimate value we've ever seen) so they never
    # block a real listing — they only stop pathological payloads that would
    # blow up token cost on the Claude calls.
    title:          str  = Field(..., max_length=500)
    price:          float
    raw_price_text: str  = Field("", max_length=120)
    description:    str  = Field("", max_length=8000)
    location:       str  = Field("", max_length=200)
    condition:      str  = Field("Unknown", max_length=80)
    seller_name:    str  = Field("", max_length=200)
    listing_url:    str  = Field("", max_length=2000)
    is_multi_item:  bool = False  # True for bundles/sets/lots — adjusts Claude's valuation logic
    is_vehicle:     bool = False  # True for motorcycles/cars/ATVs — suppresses irrelevant flags
    vehicle_details: Optional[dict] = None  # Structured vehicle attrs: mileage, transmission, title_status, owners
    seller_trust:   Optional[dict] = None   # Seller trust signals extracted by content script
    # Task #59 — optional client-supplied seller account age. The trust
    # evaluator falls back to parsing `seller_trust.joined_date` when this
    # is absent, so content scripts that don't compute it (eBay, Craigslist)
    # need no changes — FBM/OfferUp can ship the integer when known.
    seller_account_age_days: Optional[int] = None
    # Task #60 — negotiation leverage inputs. All optional, all defensive.
    # `price_history` is a list of {date, price} dicts when the extension
    # can extract it; the leverage evaluator falls back to a single-step
    # drop derived from `original_price` → `price` otherwise. `listed_at`
    # is the raw "Listed N days ago" / ISO date string from the DOM —
    # parsed server-side. `days_listed` is the extension's pre-parsed
    # integer when available (preferred over re-parsing `listed_at`).
    price_history:  Optional[list] = None
    listed_at:      Optional[str]  = None
    days_listed:    Optional[int]  = None
    original_price: float = 0.0   # Crossed-out price if seller reduced it (from DOM dual-price container)
    shipping_cost:  float = 0.0   # Cost to ship — 0 means free or local pickup
    image_urls:     Optional[list] = None  # Listing photo URLs — first one sent to Claude Vision
    photo_count:    int  = 0               # True number of listing photos (carousel total, not just sent to API)
    platform:       str  = "facebook_marketplace"  # Source platform: facebook_marketplace | craigslist | ebay | offerup

    # Allow ad-hoc attributes (auction_current_bid, raw_text, etc.) to be
    # attached to instances via setattr after construction. Pydantic v2
    # rejects unknown-field setattr by default — without extra="allow", the
    # try/except blocks in the streaming pipeline silently swallow the
    # failure and the security scorer never sees the data. This is a v2
    # behavior change vs v1, hence the explicit override.
    model_config = {
        "extra": "allow",
        "json_schema_extra": {
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
        },
    }


class RawListingRequest(BaseModel):
    """
    What the streaming /score/stream endpoint receives.
    The extension sends raw page text + DOM-extracted image URLs.
    Claude Haiku extracts all structured fields server-side.
    """
    # Server-side cap is 16k (4x the client-side trim) so legitimate larger
    # pages still go through, but a 1MB payload is rejected before hitting
    # Claude or the database.
    raw_text:    str  = Field(..., max_length=16000)
    image_urls:  list = []  # DOM-extracted image URLs (position-filtered, max 5)
    photo_count: int  = 0   # True carousel photo count from DOM (may be > len(image_urls))
    platform:    str = "facebook_marketplace"
    listing_url: str = ""
    # ── eBay auction-specific fields (DOM-detected by ebay.js) ──────────
    # When is_auction=True, the price Claude extracts will be the *current bid*,
    # which is misleading: it will rise. The backend uses these fields to switch
    # into Auction Mode — suppressing low-price scam flags and returning bid
    # guidance derived from the eBay sold market average.
    is_auction:       bool  = False  # True if listing has Place Bid / Current bid / Time left signals
    current_bid:      float = 0.0    # Current bid in $ (auctions only)
    bid_count:        int   = 0      # Number of bids placed so far
    time_left_text:   str   = ""     # Raw "Time left:" text, e.g. "2d 14h", "3h 22m"
    has_buy_it_now:   bool  = False  # True for hybrid listings (auction + Buy It Now)
    buy_it_now_price: float = 0.0    # Buy It Now price in $ (hybrid listings only)
    # ── Task #60: negotiation leverage inputs ────────────────────────────
    # All optional and defensively typed. Server still accepts payloads
    # from older extension builds that don't send these fields. The /score
    # path Pydantic model uses the same shape — we keep them ad-hoc here
    # but plumb them into ListingRequest in the stream handler so
    # evaluate_leverage() sees identical inputs on both endpoints.
    listed_at:      Optional[str]   = None   # raw ("3 days ago", ISO date)
    days_listed:    Optional[int]   = None   # client-derived integer when available
    original_price: float           = 0.0    # strikethrough peak (FBM/eBay)
    price_history:  Optional[list]  = None   # [{date, price}] when extension can extract


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
    active_count:      int   = 0
    active_low:        float = 0.0   # Lowest active listing price
    new_price:         float
    market_confidence: str
    data_source:       str = "ebay_live"  # "ebay_browse" | "ebay_live" | "google_shopping" | "claude_knowledge" | "ebay_mock" | "correction_range" | "cargurus" | "craigslist"
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
    negotiation_message: str   = ""    # Ready-to-copy buyer message — kept for back-compat
    bundle_items:        list  = []    # [{item, value}] breakdown for multi-item listings (empty if single item)
    bundle_confidence:   str   = "unknown"  # v0.46.0 — high|medium|low|unknown
    negotiation:         dict  = {}    # v0.46.0 Negotiation v2 — see DealScore.negotiation schema
    is_multi_item:       bool  = False # Echoed from listing so the UI can hard-render the bundle line
    score_rationale:     str   = ""    # ≤140 char one-liner explaining the score's main driver (rendered under score circle)
    cached:              bool  = False # True ⇒ this response was served from the in-memory or
                                       # persistent score-cache (not freshly scored). Lets the
                                       # extension surface a "cached" badge and tells QA tooling
                                       # to ignore latency from these responses.
    # ── Task #58: confidence + comp transparency + can't-price verdict ──
    # confidence is the OVERALL bucket the user sees as a chip beside the
    # score (high|medium|low|none). Distinct from `ai_confidence` (Claude's
    # self-rated certainty) and `market_confidence` (raw pricing-pipeline
    # signal). It is derived in scoring/confidence.py from the lowest of:
    # cleaned comp count, cleaned comp spread, product extraction confidence,
    # and the market_confidence ceiling.
    confidence:          str   = ""    # "high" | "medium" | "low" | "none"
    confidence_signals:  dict  = {}    # per-signal breakdown for QA/logs
    comp_summary:        dict  = {}    # {count, median, low, high, outliers_removed,
                                       #  condition_mismatches_removed, recency_window}
    can_price:           bool  = True  # False when confidence is "none" — UI replaces
                                       # the score with cant_price_message + "What we tried"
    cant_price_message:  str   = ""    # Verdict copy shown instead of score when can_price=False
    queries_attempted:   list  = []    # [{query, count, source}] for the "What we tried" expandable
    # ── Task #59: composite trust / scam digest line ──
    # `trust_signals` is the list of fired heuristics. Each entry is
    # {id, label, why}. UI renders one digest line per item plus a
    # color-coded chip from `trust_severity`. Empty list / "none" means
    # no line is shown — silence is a feature.
    trust_signals:       list  = []    # [{id, label, why}]
    trust_severity:      str   = "none"  # "none" | "info" | "warn" | "alert"
    # ── Task #60: negotiation leverage digest ──
    # `leverage_signals` is a single dict (not a list — only one composite
    # value per response). Shape:
    #   {price_drop_summary, drop_count, drop_total_amount, drop_total_pct,
    #    days_listed, typical_days_to_sell, days_listed_summary,
    #    motivation_level: "low"|"medium"|"high"}
    # The UI renders up to two digest lines (price-drop + time-on-market)
    # when the corresponding summary string is non-empty. `motivation_level`
    # is also surfaced top-level so a future Negotiation v2 (Task #53) can
    # read it without digging into the dict.
    leverage_signals:    dict  = {}
    motivation_level:    str   = "low"   # "low" | "medium" | "high"
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
    # Auction Mode (eBay auctions only) — present when listing is an auction
    # without a Buy It Now option. Contains current bid, time left, and a
    # market-derived bid range so the user knows when to stop bidding.
    # Empty dict for fixed-price listings (Buy It Now or other platforms).
    auction_advice:        dict = {}


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
    _is_audit_rescore = getattr(request.state, '_audit_rescore', False)
    if not _is_audit_rescore:
        _check_api_key(request)
        client_ip = request.headers.get("x-forwarded-for", request.client.host if request.client else "unknown").split(",")[0].strip()
        _check_rate_limit(client_ip)

    log.info(f"Scoring request: '{listing.title}' @ ${listing.price}{' [AUDIT RESCORE]' if _is_audit_rescore else ''}")
    _scoring_start_ts = _time.time()

    if not _is_audit_rescore:
        _url_keyed = bool(listing.listing_url and listing.listing_url.startswith("http"))
        _ck = _cache_key(listing.title, listing.price, listing.listing_url)
        _cached = _cache_get(_ck)
        if _cached:
            log.info(f"[Cache] HIT for '{listing.title}' @ ${listing.price} — returning cached score")
            # Stamp `cached: True` at return time so the canonical score in the
            # cache stays as-scored (cached=False). This means we never have to
            # worry about a previously-served-as-cached payload being re-cached
            # with a stale flag.
            return {**_cached, "cached": True}
        # Persistent (DB) reproducibility cache — survives restart, content-keyed.
        # Falls through silently on any DB issue so scoring still works.
        _listing_h = _listing_content_hash(
            listing.title, listing.description or "", listing.image_urls or [],
        )
        _persist_key = _persistent_cache_key(listing.listing_url, _listing_h, listing.price)
        _persist_cached = await _persist_cache_get(_persist_key)
        if _persist_cached:
            log.info(f"[ScoreCache] persistent HIT for '{listing.title}' @ ${listing.price}")
            # Warm the in-memory layer with the canonical (un-flagged) payload —
            # the next in-memory hit will stamp cached=True at its own return.
            _cache_set(_ck, _persist_cached, url_keyed=_url_keyed)
            return {**_persist_cached, "cached": True}

    # Begin per-run Anthropic token accounting. ContextVar lives on the
    # current asyncio task and is reclaimed when the request task ends, so
    # no explicit reset is required (and try/finally would force a giant
    # indent of the rest of this function).
    from scoring import claude_usage as _claude_usage
    _claude_usage.start_run()

    # Guard: reject obviously bad titles that indicate a broken extraction
    _generic_titles = {"marketplace", "facebook marketplace", "facebook", "craigslist", "offerup", ""}
    if (listing.title or "").strip().lower() in _generic_titles:
        raise HTTPException(
            status_code=422,
            detail="Could not read the listing title — please wait for the page to fully load and try again."
        )

    if listing.price <= 0:
        log.info(f"[ZeroPrice] Listing '{listing.title}' has ${listing.price} — returning low-confidence score")
        return DealScoreResponse(
            title=listing.title, price=0,
            condition=listing.condition or "", location=listing.location or "",
            score=3, verdict="Price missing or $0 — cannot evaluate deal value",
            summary="This listing has no price or a $0 price. Without a price, we can't determine if this is a good deal.",
            value_assessment="Cannot assess value without a price",
            condition_notes="",
            should_buy=False, ai_confidence="low", model_used="none",
            security_score={},
            data_source="none", market_confidence="none",
            estimated_value=0, sold_avg=0, sold_low=0, sold_high=0,
            active_avg=0, active_low=0, new_price=0,
            sold_count=0,
            sold_items_sample=[], active_items_sample=[],
            red_flags=["Price is $0 — cannot score deal value"],
            green_flags=[],
            recommended_offer=0,
            score_rationale="Listing has no price — cannot compare to market. Wait for price to appear or refresh.",
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
                description       = (listing.description or "")[:2000],
                listing_location  = listing.location or "",
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

    # ── Task #74 perf: launch security scoring NOW (in parallel with refinement
    # AND deal scoring) using prelim_market. Security only needs the listing
    # + market_value snapshot for context — using prelim_market vs the refined
    # value has no measurable effect on the security verdict (it cares about
    # seller trust, listing red flags, photo coverage, etc.), and starting it
    # this early lets it overlap with the ~1.5-3s of refinement work below
    # plus the ~8-10s deal scorer (vision) call. The await happens after the
    # deal scorer (existing code at the original site).
    from scoring.affiliate_router import detect_category, CATEGORY_PROGRAMS
    _prelim_category = detect_category(product_info)
    _SPECIFIC_VEHICLE_CATS = {"cars", "trucks", "rvs", "trailers", "boats"}
    if listing.is_vehicle and _prelim_category not in _SPECIFIC_VEHICLE_CATS:
        _prelim_category = "vehicles"

    _security_task = asyncio.create_task(
        asyncio.wait_for(
            score_security(
                listing          = listing,
                category         = _prelim_category,
                market_value     = prelim_market,
                normalized_title = product_info.display_name,
            ),
            timeout=10.0,
        )
    )
    # ── Task #77: drain orphaned security task on early errors ──
    try:

        # If extraction produced a meaningfully better query, refine eBay now.
        # "Meaningfully better" = not just whitespace/case difference.
        # eBay has its own cache so if the same query was recently used, this is instant.
        extracted_q = (product_info.search_query or "").strip().lower()
        raw_q       = raw_title_query.lower()
        # Skip refinement if eBay is rate-limited — a refined query returns the same
        # mock data, so the extra round-trip wastes 1-2s with zero accuracy gain.
        _ebay_rate_limited = getattr(prelim_market, "data_source", "") == "ebay_mock"
        _raw_words = set(raw_q.split())
        _ext_words = set(extracted_q.split())
        _word_overlap = len(_raw_words & _ext_words) / max(len(_raw_words | _ext_words), 1)
        _queries_similar = _word_overlap > 0.8

        # v0.43.4 — short-circuit refinement when the preliminary pass already
        # returned plenty of real sold comps AND the refined query is recognizably
        # related to the preliminary one (≥50% token overlap). This covers the
        # common case where the seller-written title was already specific enough
        # (e.g. "Orion XT8 Telescope") and Claude's tweak ("Orion XT8 Dobsonian
        # telescope") would just return the same comps with one less filler word.
        # Saves ~1.5-2.5s per score on average without dropping any accuracy —
        # if eBay already gave us 5+ sold comps, a different word-permutation of
        # the same query won't beat that.
        _prelim_sold_count = int(getattr(prelim_market, "sold_count", 0) or 0)
        _prelim_strong = _prelim_sold_count >= 5 and _word_overlap >= 0.5

        need_refine = (extracted_q and extracted_q != raw_q and len(extracted_q) > 4
                       and not _ebay_rate_limited and not _queries_similar
                       and not _prelim_strong)
        if _ebay_rate_limited and extracted_q != raw_q:
            log.info(f"[Speed] Skipping eBay refinement — rate-limited, mock data unchanged")
        elif _queries_similar and extracted_q != raw_q:
            log.info(f"[Speed] Skipping market refinement — queries {_word_overlap:.0%} similar")
        elif _prelim_strong and extracted_q != raw_q:
            log.info(
                f"[Speed] Skipping market refinement — preliminary already strong "
                f"(sold_count={_prelim_sold_count}, overlap={_word_overlap:.0%})"
            )

        _refine_coro = None
        _eval_coro = None
        if need_refine:
            log.info(f"[Speed] Refining eBay: '{raw_title_query}' → '{product_info.search_query}'")
            _refine_coro = get_market_value(
                listing_title     = product_info.search_query,
                listing_condition = listing.condition,
                is_vehicle        = listing.is_vehicle,
                listing_price     = listing.price,
                description       = (listing.description or "")[:2000],
                category          = product_info.category,
                listing_location  = listing.location or "",
            )
        if product_info.brand or product_info.display_name:
            _eval_coro = evaluate_product(
                brand        = product_info.brand,
                model        = product_info.model,
                category     = product_info.category,
                display_name = product_info.display_name,
            )

        if _refine_coro and _eval_coro:
            _refined_mv, _refined_eval = await asyncio.gather(
                _refine_coro, _eval_coro, return_exceptions=True,
            )
            if not isinstance(_refined_mv, Exception):
                market_value = _refined_mv
            else:
                log.error(f"Refinement step failed: {_refined_mv}")
                market_value = prelim_market
            if not isinstance(_refined_eval, Exception):
                product_eval = _refined_eval
        elif _refine_coro:
            try:
                market_value = await _refine_coro
            except Exception as e:
                log.error(f"Refinement step failed: {e}")
                market_value = prelim_market
        elif _eval_coro:
            log.info(f"[Speed] Using preliminary eBay result for '{raw_title_query}'")
            market_value = prelim_market
            try:
                product_eval = await _eval_coro
            except Exception as _eval_err:
                log.warning(f"Product eval refinement failed: {_eval_err}")
        else:
            log.info(f"[Speed] Using preliminary eBay result for '{raw_title_query}'")
            market_value = prelim_market

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

        all_image_urls_sync = listing.image_urls or []
    except BaseException:
        # Cancel and drain the orphaned security task so uvicorn does not
        # log 'Task was destroyed but it is pending!' warnings. The
        # try/except around score_deal below has its own cancel sites for
        # the deal-scorer error paths; this guard covers earlier failures
        # (dataclass conversion, dict-build, refinement gather, etc.).
        if not _security_task.done():
            _security_task.cancel()
        try:
            await _security_task
        except BaseException:
            pass
        raise

    # ── Step 3 + 4b: Deal scoring (security task already launched above
    # right after the gather unpack, Task #74). The await happens after the
    # deal scorer finishes so we still get to surface security findings, but
    # the task started ~1.5-3s earlier so it's almost certainly done by then.
    try:
        effective_photo_count = max(listing.photo_count or 0, len(listing.image_urls or []))
        deal_score = await score_deal(
            listing_dict,
            market_value_dict,
            image_urls         = all_image_urls_sync,
            product_evaluation = product_eval,
            photo_count        = effective_photo_count,
        )
    except RuntimeError as e:
        # Task #77: drain so uvicorn doesn't warn 'Task was destroyed but it is pending!'
        _security_task.cancel()
        try:
            await _security_task
        except BaseException:
            pass
        real_error = str(e)
        log.error(f"Scoring failed: {real_error}")
        raise HTTPException(status_code=500, detail=real_error)
    except Exception as e:
        _security_task.cancel()
        try:
            await _security_task
        except BaseException:
            pass
        log.error(f"Unexpected scoring exception: {type(e).__name__}: {e}")
        raise HTTPException(status_code=500, detail=f"{type(e).__name__}: {e}")

    if not deal_score:
        _security_task.cancel()
        try:
            await _security_task
        except BaseException:
            pass
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
    if _np > 0 and market_value.data_source not in ("ebay_mock", "insufficient_data", "correction_range"):
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
    _BROAD_VEHICLE    = {"vehicles"}
    _SPECIFIC_VEHICLE = {"cars", "trucks", "rvs", "trailers", "boats"}
    _valid_categories = set(CATEGORY_PROGRAMS.keys())
    claude_category   = (deal_score.affiliate_category or "").strip().lower()
    if claude_category and claude_category in _valid_categories:
        if claude_category in _SOFT_CATS and _prelim_category not in _SOFT_CATS and _prelim_category != "general":
            log.info(f"[Category] Claude soft '{claude_category}' overridden by keyword '{_prelim_category}'")
            category_detected = _prelim_category
        elif claude_category in _BROAD_VEHICLE and _prelim_category in _SPECIFIC_VEHICLE:
            log.info(f"[Category] Claude broad '{claude_category}' overridden by keyword '{_prelim_category}'")
            category_detected = _prelim_category
        else:
            category_detected = claude_category
            log.info(f"[Category] Claude → '{category_detected}'")
    else:
        if claude_category:
            log.warning(f"[Category] Claude returned '{claude_category}' (unknown or 'general') — falling back to keyword detection")
        category_detected = _prelim_category
        log.info(f"[Category] Keyword → '{category_detected}'")

    _VEHICLE_CATS = {"vehicles", "cars", "trucks", "rvs", "trailers", "boats"}
    if listing.is_vehicle and category_detected not in _VEHICLE_CATS:
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
            category_override = category_detected,
            active_items_sample = market_value.active_items_sample or [],
            google_prices     = getattr(market_value, '_google_prices', []),
        )
    except Exception as e:
        log.warning(f"Affiliate router failed ({e}) — returning empty cards")
        affiliate_cards = []

    # v0.46.0 — defense layer: prune bogus items, stamp confidence_label
    try:
        affiliate_cards = filter_affiliate_cards(
            affiliate_cards,
            asking_price = listing.price,
            query        = (product_info.search_query if hasattr(product_info, "search_query") else "") or "",
            category     = category_detected,
            is_multi_item = bool(listing.is_multi_item),
        )
    except Exception as _fe:
        log.warning(f"filter_affiliate_cards failed (non-fatal): {_fe}")

    # v0.46.0 — read-path suppression for previously flagged cards on this listing
    try:
        flagged = await _get_flagged_programs(listing.listing_url)
        if flagged:
            affiliate_cards = [c for c in affiliate_cards if c.get("program_key") not in flagged]
    except Exception as _se:
        log.warning(f"flag-suppression failed (non-fatal): {_se}")

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
    if _sec_score <= 3:
        deal_score.should_buy = False
        if deal_score.score > 5:
            deal_score.score = min(deal_score.score, 5)
        if not deal_score.red_flags:
            deal_score.red_flags = []
        deal_score.red_flags.insert(0, f"Score capped due to high security risk (security {_sec_score}/10)")
        log.info(f"[SecurityCap] Score capped to {deal_score.score}, should_buy=False (security={_sec_score})")
    elif _sec_score <= 4 and deal_score.score > 6:
        deal_score.score = min(deal_score.score, 6)
        log.info(f"[SecurityCap] Score capped to {deal_score.score} (security={_sec_score})")

    # ── Step 4c.5: No-data guard ─────────────────────────────────────────────
    # If pricing pipeline returned no usable market data (vehicle_not_applicable
    # stub, confidence="none", or estimated_value=0), Claude's score is purely
    # speculative — never recommend buying. Cap score at 5 and force should_buy=False.
    if (market_value.data_source == "vehicle_not_applicable"
        or market_value.confidence == "none"
        or market_value.estimated_value <= 0):
        if deal_score.should_buy or deal_score.score > 5:
            _old = deal_score.score
            deal_score.score = min(deal_score.score, 5)
            deal_score.should_buy = False
            if not deal_score.red_flags:
                deal_score.red_flags = []
            deal_score.red_flags.insert(0, "No reliable market comps available — score is uncertain")
            log.info(f"[NoDataGuard] No market data (source={market_value.data_source}, conf={market_value.confidence}, ev=${market_value.estimated_value:.0f}) — score {_old} → {deal_score.score}, should_buy=False")

    # ── Step 4d: Price-to-market ratio adjustment ────────────────────────────
    # Catches cases where AI scored opposite to the objective price gap.
    # Example: listing at $175 vs market $85 → overpriced, but AI gave 7/10.
    _ev = market_value.estimated_value
    if _ev > 0 and listing.price > 0 and market_value.confidence not in ("suspect", "none"):
        _price_ratio = listing.price / _ev
        if _price_ratio > 1.5 and deal_score.score > 5:
            _old = deal_score.score
            deal_score.score = min(deal_score.score, 5)
            deal_score.should_buy = False
            log.info(f"[RatioAdj] Overpriced {_price_ratio:.1f}x market — score {_old} → {deal_score.score}")
        elif _price_ratio > 1.2 and deal_score.score > 6:
            _old = deal_score.score
            deal_score.score = min(deal_score.score, 6)
            log.info(f"[RatioAdj] Above market {_price_ratio:.1f}x — score {_old} → {deal_score.score}")
        elif _price_ratio < 0.4 and deal_score.score < 6 and _sec_score > 5:
            _old = deal_score.score
            deal_score.score = max(deal_score.score, 7)
            deal_score.should_buy = True
            log.info(f"[RatioAdj] Deep discount {_price_ratio:.1f}x market — score {_old} → {deal_score.score}")
        elif _price_ratio < 0.6 and deal_score.score < 5 and _sec_score > 5:
            _old = deal_score.score
            deal_score.score = max(deal_score.score, 6)
            log.info(f"[RatioAdj] Good discount {_price_ratio:.1f}x market — score {_old} → {deal_score.score}")

    # ── Step 4e: Trust / scam composite (Task #59) ───────────────────────────
    # Combine vision-derived signals (stock photo, photo/text contradiction)
    # with pure-Python heuristics (vague description, price-too-good + new
    # account, dup seller listing) into a severity bucket. The evaluator
    # mutates the deal_score in place when 2+ signals fire (cap to 5) or
    # all 6 fire (floor to 1) and overrides the verdict accordingly.
    from scoring.trust import evaluate_trust, apply_trust_to_score
    _trust_comp_median = float(
        (getattr(market_value, "comp_summary", None) or {}).get("median", 0.0)
        or market_value.sold_avg or 0.0
    )
    trust_result = evaluate_trust(
        listing                   = listing.model_dump(),
        comp_median               = _trust_comp_median,
        is_stock_photo            = deal_score.is_stock_photo,
        stock_photo_reason        = deal_score.stock_photo_reason,
        photo_text_contradiction  = deal_score.photo_text_contradiction,
        contradiction_reason      = deal_score.contradiction_reason,
        reverse_image_match_count = None,  # graceful no-op — lookup not wired yet
    )
    apply_trust_to_score(deal_score, trust_result)

    # ── Step 4f: Negotiation leverage (Task #60) ─────────────────────────────
    # Combine the listing's price-drop history (from extension or derived
    # from `original_price`) with its days-on-market into a composite
    # `motivation_level`. Purely additive — no score mutation. The
    # extension renders up to two digest lines from the result. A future
    # Negotiation v2 (Task #53) is intended to consume motivation_level
    # to adjust opening offer + walk-away threshold; until #53 ships,
    # this is informational on the digest only.
    from scoring.leverage import evaluate_leverage, derive_typical_days_to_sell
    _typical_dts = derive_typical_days_to_sell(getattr(market_value, "comp_summary", None))
    leverage_result = evaluate_leverage(
        listing              = listing.model_dump(),
        typical_days_to_sell = _typical_dts,
    )

    # ── Step 5: Serialize ────────────────────────────────────────────────────
    from dataclasses import asdict as dc_asdict
    def _to_dict(i):
        return i if isinstance(i, dict) else dc_asdict(i)
    sold_items_sample   = [_to_dict(i) for i in (market_value.sold_items_sample   or [])]
    active_items_sample = [_to_dict(i) for i in (market_value.active_items_sample or [])]
    affiliate_dicts     = [dc_asdict(c) for c in affiliate_cards]

    # Task #58 — derive confidence + comp_summary + can_price block
    _confidence_payload = _build_confidence_payload(market_value, product_info, listing.price)

    response = DealScoreResponse(
        # Listing
        title          = listing.title,
        price          = listing.price,
        location       = listing.location,
        condition      = listing.condition,
        original_price = listing.original_price,
        shipping_cost  = listing.shipping_cost,
        # Task #58 — splat the confidence fields
        **_confidence_payload,
        # Task #59 — composite trust signals + severity
        **trust_result.to_response_dict(),
        # Task #60 — negotiation leverage signals
        **leverage_result.to_response_dict(),
        motivation_level    = leverage_result.motivation_level,

        # Market value
        estimated_value     = market_value.estimated_value,
        sold_avg            = market_value.sold_avg,
        sold_count          = market_value.sold_count,
        sold_low            = market_value.sold_low,
        sold_high           = market_value.sold_high,
        active_avg          = market_value.active_avg,
        active_count        = market_value.active_count if hasattr(market_value, 'active_count') else 0,
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
        bundle_confidence   = getattr(deal_score, "bundle_confidence", "unknown"),
        negotiation         = getattr(deal_score, "negotiation", None) or {},
        is_multi_item       = bool(listing.is_multi_item),
        score_rationale     = deal_score.score_rationale,

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

    if not _is_audit_rescore:
        score_id = 0
        try:
            from scoring.data_pipeline import _get_pool
            pool = await _get_pool()
            if pool:
                _ebay_comps = {
                    "sold":   sold_items_sample,
                    "active": active_items_sample,
                    "query":  market_value.search_query if hasattr(market_value, "search_query") else "",
                    "data_source": market_value.data_source if hasattr(market_value, "data_source") else "",
                }

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

                _install_id = request.headers.get("x-ds-install-id")
                row = await pool.fetchrow(
                    """INSERT INTO deal_scores
                       (platform, listing_url, listing_json, score_json, score,
                        ebay_comps_json, affiliate_impressions_json, install_id)
                       VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $6::jsonb, $7::jsonb, $8)
                       RETURNING id""",
                    listing.platform or "unknown",
                    listing.listing_url or "",
                    _json.dumps(listing.model_dump()),
                    _json.dumps(response.model_dump()),
                    deal_score.score,
                    _json.dumps(_ebay_comps),
                    _json.dumps(_affil_impressions),
                    _install_id,
                )
                if row:
                    score_id = row["id"]
                    response = response.model_copy(update={"score_id": score_id})
        except Exception as _db_err:
            log.warning(f"[deal_scores] save failed (non-fatal): {_db_err}")

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
            pass

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
            pass

        # Store the cache entry as a plain dict (not the Pydantic model) so
        # the `{**_cached, "cached": True}` stamp on hit-paths can't raise
        # `TypeError: 'DealScoreResponse' object is not a mapping`. This
        # also keeps both cache layers (in-memory + persistent) symmetric:
        # they always round-trip through the same dict shape.
        _response_dict = response.model_dump() if hasattr(response, "model_dump") else dict(response)
        _cache_set(_ck, _response_dict, url_keyed=_url_keyed)
        # Persistent reproducibility cache write-through. _persist_key is in
        # scope here because Python doesn't have block scope and both this
        # branch and the cache-check branch above are gated by the same
        # `if not _is_audit_rescore:` condition. Audit-rescores intentionally
        # bypass cache (purpose is to re-evaluate, not reuse).
        await _persist_cache_set(
            _persist_key,
            _response_dict,
            listing_url=listing.listing_url,
            asking_price=listing.price,
        )

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

@app.post("/score-stream")
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

    from scoring.listing_extractor import extract_listing_and_product
    from scoring.product_extractor import _fallback_extraction
    from scoring.affiliate_router import detect_category, CATEGORY_PROGRAMS
    from dataclasses import asdict as _dc_asdict

    def _sse(obj: dict) -> str:
        return f"data: {_json.dumps(obj)}\n\n"

    async def event_stream():
        _stream_scoring_start = _time.time()
        # Begin per-run Anthropic token accounting (see /score for details).
        from scoring import claude_usage as _claude_usage
        _claude_usage.start_run()
        try:
            # ── Step 1: Claude Haiku extracts listing fields + product identity ─
            # Single Haiku call returns both shapes (v0.43.4) — saves ~1s vs the
            # old two-call sequence (extract_listing_from_text → extract_product).
            extracted, product_info = await extract_listing_and_product(
                raw_text=raw.raw_text,
                platform=raw.platform,
                url=raw.listing_url,
            )

            # Merge DOM image_urls (position-filtered by the content script — better
            # than any URL Claude could infer from text).
            extracted["image_urls"] = raw.image_urls or []
            extracted["listing_url"] = raw.listing_url
            extracted["platform"]    = raw.platform
            claude_photo_count = int(extracted.get("photo_count", 0) or 0)
            dom_image_count    = len(raw.image_urls or [])
            dom_carousel_count = raw.photo_count or 0
            extracted["photo_count"] = max(claude_photo_count, dom_image_count, dom_carousel_count)

            title     = extracted.get("title", "").strip()
            price_raw = extracted.get("price")          # None means truly unknown
            price     = float(price_raw if price_raw is not None else 0)

            # price_raw is None only when Claude found no price at all.
            # price_raw == 0 means the item is FREE — that is valid, not an error.
            if not title or price_raw is None:
                yield _sse({"type": "error",
                            "message": "Could not read listing — page may still be loading"})
                return

            seller_trust = None
            _has_trust = any(extracted.get(k) for k in (
                "seller_joined", "seller_rating", "seller_highly_rated",
                "seller_response_time", "seller_identity_verified", "seller_items_sold",
            ))
            if _has_trust:
                seller_trust = {
                    "joined_date":       extracted.get("seller_joined"),
                    "rating":            extracted.get("seller_rating"),
                    "rating_count":      extracted.get("seller_rating_count", 0) or 0,
                    "highly_rated":      extracted.get("seller_highly_rated", False),
                    "response_time":     extracted.get("seller_response_time"),
                    "identity_verified": extracted.get("seller_identity_verified", False),
                    "items_sold":        extracted.get("seller_items_sold", 0) or 0,
                }

            # Send extracted data immediately — panel shows title/price now
            yield _sse({"type": "extracted", "data": extracted})

            # Guard: $0 price — cannot evaluate deal value
            if price <= 0:
                log.info(f"[ZeroPrice][Stream] '{title}' has ${price} — returning low-confidence score")
                yield _sse({"type": "score", "data": {
                    "title": title, "price": 0,
                    "condition": extracted.get("condition", ""), "location": extracted.get("location", ""),
                    "score": 3, "verdict": "Price missing or $0 — cannot evaluate deal value",
                    "summary": "This listing has no price or a $0 price. Without a price, we can't determine if this is a good deal.",
                    "value_assessment": "Cannot assess value without a price",
                    "condition_notes": "",
                    "should_buy": False, "ai_confidence": "low", "model_used": "none",
                    "security_score": {},
                    "data_source": "none", "market_confidence": "none",
                    "estimated_value": 0, "sold_avg": 0, "sold_low": 0, "sold_high": 0,
                    "active_avg": 0, "active_low": 0, "new_price": 0,
                    "sold_count": 0,
                    "sold_items_sample": [], "active_items_sample": [],
                    "red_flags": ["Price is $0 — cannot score deal value"],
                    "green_flags": [],
                    "recommended_offer": 0,
                    "score_rationale": "Listing has no price — cannot compare to market. Wait for price to appear or refresh.",
                }})
                return

            # ── Cache check ──────────────────────────────────────────────────
            _url_keyed = bool(raw.listing_url and raw.listing_url.startswith("http"))
            _ck = _cache_key(title, price, raw.listing_url)
            _cached = _cache_get(_ck)
            if _cached:
                log.info(f"[Stream Cache] HIT for '{title}'")
                # Add cached=True at yield time (not in the cache itself) so
                # the stored canonical payload always reflects "as scored".
                yield _sse({"type": "score", "data": {**_cached, "cached": True}})
                return  # intentionally not logged to score_log — only fresh scores are auditable
            # Persistent reproducibility cache — keyed by url + listing-content hash + price.
            # Hits here when the same listing was scored within the past 24h (across restarts).
            #
            # Hash input choice: we deliberately use `raw.raw_text` (the scraper-
            # captured page text) instead of `extracted["description"]` because
            # the latter is LLM-generated and slightly varies between identical
            # scrapes — that variation would silently destroy reproducibility
            # by yielding different keys for the same physical listing.
            # raw_text is capped at 1000 chars inside the hash helper anyway,
            # so it's safe to pass the whole thing here.
            #
            # Price-key semantics: we key on the user-visible page price (`price`
            # extracted from the page), not the auction-mode rewritten price
            # used internally for scoring further down. This is intentional —
            # the cache stores "the response we'd give for THIS scrape," so
            # the same scrape (same visible price) must produce the same key.
            _stream_listing_h = _listing_content_hash(
                title, raw.raw_text or extracted.get("description", "") or "", raw.image_urls or [],
            )
            _stream_persist_key = _persistent_cache_key(raw.listing_url, _stream_listing_h, price)
            _stream_persist_cached = await _persist_cache_get(_stream_persist_key)
            if _stream_persist_cached:
                log.info(f"[Stream ScoreCache] persistent HIT for '{title}' @ ${price}")
                # Warm in-memory with the canonical un-flagged payload so the
                # next in-memory hit stamps cached=True at its own yield.
                _cache_set(_ck, _stream_persist_cached, url_keyed=_url_keyed)
                yield _sse({"type": "score", "data": {**_stream_persist_cached, "cached": True}})
                return

            # Guard: reject generic titles
            _generic = {"marketplace", "facebook marketplace", "facebook",
                        "craigslist", "offerup", "ebay", ""}
            if title.lower() in _generic:
                yield _sse({"type": "error",
                            "message": "Could not read the listing title — wait for the page to fully load"})
                return

            # ── Auction Mode pre-processing (eBay only) ──────────────────────
            # If this is an auction with no Buy It Now, the "price" Claude
            # extracted is the current bid — meaningless for deal scoring (it
            # will rise). We defer the real scoring price until after market
            # data lookup, when we can derive a suggested max bid from sold_avg.
            #
            # If it's a hybrid (auction + BIN), use the BIN price as the
            # scoring price — that's the actual "asking price" the user can
            # take right now.
            _is_auction = bool(getattr(raw, "is_auction", False))
            _has_bin    = bool(getattr(raw, "has_buy_it_now", False))
            _bin_price  = float(getattr(raw, "buy_it_now_price", 0) or 0)
            _current_bid = float(getattr(raw, "current_bid", 0) or 0)
            _auction_only_mode = _is_auction and not (_has_bin and _bin_price > 0)

            if _is_auction and _has_bin and _bin_price > 0:
                # Hybrid: prefer BIN price (it's the real "you can buy this now" price)
                if abs(_bin_price - price) / max(_bin_price, 1) > 0.05:
                    log.info(f"[Auction][Hybrid] Overriding price ${price:.0f} → BIN ${_bin_price:.0f}")
                price = _bin_price
            elif _auction_only_mode and _current_bid > 0:
                # Pure auction: ensure price reflects current bid (Claude usually
                # gets this right but be defensive)
                if abs(_current_bid - price) / max(_current_bid, 1) > 0.10:
                    log.info(f"[Auction] Aligning price ${price:.0f} → current bid ${_current_bid:.0f}")
                    price = _current_bid

            # Build ListingRequest from extracted data.
            # Task #60 — leverage inputs (listed_at / days_listed / price_history /
            # original_price) come from the DOM-side extractor, NOT from Claude
            # extraction. The extension sends them on the raw payload alongside
            # raw_text. We prefer raw.original_price (DOM strikethrough) over
            # whatever Claude inferred, since the DOM source is authoritative.
            _orig_price = float(getattr(raw, "original_price", 0) or extracted.get("original_price", 0) or 0)
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
                original_price = _orig_price,
                shipping_cost  = float(extracted.get("shipping_cost", 0) or 0),
                image_urls     = raw.image_urls or [],
                photo_count    = int(extracted.get("photo_count", 0) or len(raw.image_urls or [])),
                platform       = raw.platform,
                # Task #60 — pass leverage inputs straight through.
                listed_at      = getattr(raw, "listed_at", None),
                days_listed    = getattr(raw, "days_listed", None),
                price_history  = getattr(raw, "price_history", None),
            )

            # Task #60 — snapshot the asking price BEFORE any downstream
            # mutation. The auction-only flow may overwrite listing.price
            # with suggested_max_bid (line ~1705), which would skew leverage
            # drop math against the wrong baseline. Leverage must always
            # compute drops vs the original asking price the buyer sees.
            _asking_price_for_leverage = float(listing.price or 0)

            log.info(f"[Stream] Scoring '{listing.title}' @ ${listing.price}")

            # ── Task #76 perf: launch security scoring NOW (before the eBay
            # call) so it overlaps with eBay pricing + product eval + deal
            # scoring instead of just deal scoring. Mirrors Task #74's win #4
            # in /score. Security only needs the listing context (seller trust,
            # red flags, photo coverage, etc.); passing market_value=None is
            # fine — security_scorer handles a missing market_value gracefully
            # (Layer 1 simply skips the price-anomaly check) and the is_auction
            # flag below already protects against false low-price flags on
            # auctions where listing.price gets rewritten later. Estimated
            # 1-2s saving per stream score on the common path.
            #
            # Surface raw_text on the listing object first so the security
            # scorer's Layer 2 prompt can quote item specifics directly and
            # stop hallucinating "no specs / no return policy" when the page
            # actually contains them.
            try:
                setattr(listing, "raw_text", raw.raw_text)
            except Exception:
                pass

            _prelim_category = detect_category(product_info)
            _SPECIFIC_VEHICLE_CATS_S = {"cars", "trucks", "rvs", "trailers", "boats"}
            if listing.is_vehicle and _prelim_category not in _SPECIFIC_VEHICLE_CATS_S:
                _prelim_category = "vehicles"

            # Surface auction current_bid on the listing object so the security
            # scorer's Layer 2 prompt can show "Current bid: $X (auction; ~$Y typical)"
            # instead of the override price, which Claude would otherwise read as
            # "$344 vs $800-1200 retail = severe price anomaly".
            if _auction_only_mode and _current_bid > 0:
                try:
                    setattr(listing, "auction_current_bid", float(_current_bid))
                except Exception:
                    pass

            _security_task = asyncio.create_task(
                asyncio.wait_for(
                    score_security(
                        listing          = listing,
                        category         = _prelim_category,
                        market_value     = None,
                        normalized_title = product_info.display_name,
                        is_auction       = _auction_only_mode,
                    ),
                    timeout=10.0,
                )
            )

            # ── Step 2: eBay market value + product eval (concurrent) ─────────
            # product_info was already produced by the merged extract above, so
            # we don't run a preliminary-then-refined pair like /score does. The
            # extracted search_query is already the query we want eBay to use.
            yield _sse({"type": "progress", "label": "Checking eBay market prices…"})

            _ebay_query   = (product_info.search_query or "").strip() or listing.title.strip()
            _eval_brand   = product_info.brand
            _eval_model   = product_info.model
            _eval_category = product_info.category
            _eval_display = product_info.display_name or listing.title

            market_value, product_eval = await asyncio.gather(
                get_market_value(
                    listing_title     = _ebay_query,
                    listing_condition = listing.condition,
                    is_vehicle        = listing.is_vehicle,
                    listing_price     = listing.price,
                    description       = (listing.description or "")[:2000],
                    category          = product_info.category,
                    listing_location  = listing.location or "",
                ),
                evaluate_product(
                    brand        = _eval_brand,
                    model        = _eval_model,
                    category     = _eval_category,
                    display_name = _eval_display,
                ),
                return_exceptions=True,
            )

            if isinstance(market_value, Exception):
                # Task #76 — security task was launched earlier (before the
                # eBay gather), so we must clean it up on this error path to
                # avoid an orphan in-flight task and a "task exception was
                # never retrieved" warning.
                _security_task.cancel()
                yield _sse({"type": "error",
                            "message": f"Market value lookup failed: {market_value}"})
                return

            if isinstance(product_eval, Exception):
                from scoring.product_evaluator import _unknown_evaluation
                log.warning(f"[Stream] Product eval failed: {product_eval}")
                product_eval = _unknown_evaluation(product_info.display_name)

            # ── Auction Mode: derive bid range from market data ──────────────
            # For PURE auctions (no BIN), once we have sold_avg, we calculate:
            #   suggested_max_bid = sold_avg * 0.85  (= "great deal" threshold)
            #   walk_away_price   = sold_avg * 1.05  (= no longer a deal)
            # and OVERRIDE listing.price with suggested_max_bid for the rest of
            # the pipeline. This means:
            #   1. Security scorer no longer sees "$87 vs $379 = scam" — it sees
            #      "$322 vs $379 = fair" and the false low-price flag is suppressed.
            #   2. Deal scorer rates "if you win at $322, here's how good a deal".
            #
            # For HYBRID listings (auction + BIN), the BIN price is already used
            # for primary scoring (set above). We still emit auction_advice as
            # SECONDARY info — `mode: "secondary"` tells the UI to render it
            # below the normal score panel rather than replacing the score.
            auction_advice = {}
            if _is_auction:
                _sold_avg = float(getattr(market_value, "sold_avg", 0) or 0)
                _bid_count = int(getattr(raw, "bid_count", 0) or 0)
                _time_left = (getattr(raw, "time_left_text", "") or "").strip()
                _mode = "primary" if _auction_only_mode else "secondary"

                if _sold_avg > 0:
                    _suggested_max = round(_sold_avg * 0.85)
                    _walk_away     = round(_sold_avg * 1.05)
                    if _mode == "secondary":
                        _reasoning = (
                            f"Auction option also available: bid up to ${_suggested_max} "
                            f"to beat the Buy It Now price (${round(_bin_price)}). "
                            f"Walk away above ${_walk_away}."
                        )
                    else:
                        _reasoning = (
                            f"Bid up to ${_suggested_max} for a strong deal "
                            f"(15% under ${round(_sold_avg)} market avg). "
                            f"Walk away above ${_walk_away}."
                        )
                    auction_advice = {
                        "is_auction":        True,
                        "mode":              _mode,
                        "current_bid":       _current_bid,
                        "bid_count":         _bid_count,
                        "time_left":         _time_left,
                        "suggested_max_bid": _suggested_max,
                        "walk_away_price":   _walk_away,
                        "market_avg":        round(_sold_avg),
                        "has_buy_it_now":    bool(_has_bin),
                        "buy_it_now_price":  round(_bin_price) if _bin_price > 0 else 0,
                        "reasoning":         _reasoning,
                    }
                    log.info(
                        f"[Auction] mode={_mode} cur_bid=${_current_bid:.0f} "
                        f"market=${_sold_avg:.0f} max_bid=${_suggested_max} "
                        f"walk=${_walk_away}"
                    )
                    if _auction_only_mode:
                        # Override listing.price → suggested_max_bid so
                        # downstream scoring reflects "deal at the bid ceiling"
                        # not "deal at current bid". This kills the false scam
                        # flag (defense-in-depth alongside is_auction passed
                        # to the security scorer).
                        listing.price = float(_suggested_max)
                        listing.raw_price_text = f"${_suggested_max}"
                else:
                    # No market data — still flag as auction so UI can show a
                    # banner, but no bid range available.
                    auction_advice = {
                        "is_auction":        True,
                        "mode":              _mode,
                        "current_bid":       _current_bid,
                        "bid_count":         _bid_count,
                        "time_left":         _time_left,
                        "suggested_max_bid": 0,
                        "walk_away_price":   0,
                        "market_avg":        0,
                        "has_buy_it_now":    bool(_has_bin),
                        "buy_it_now_price":  round(_bin_price) if _bin_price > 0 else 0,
                        "reasoning":         "Auction in progress. Not enough market data to suggest a bid range — bid based on what the item is worth to you.",
                    }
                    log.info(f"[Auction] mode={_mode} but no market data — banner only")

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
                # Pass the raw page text through so the deal scorer can see
                # item specifics, return policy, shipping etc. that were
                # stripped from the summarized `description`.
                "raw_text":       raw.raw_text,
            }
            all_image_urls = listing.image_urls or []

            try:
                effective_photo_count = max(listing.photo_count or 0, len(listing.image_urls or []))
                deal_score = await score_deal(
                    listing_dict, market_value_dict,
                    image_urls         = all_image_urls,
                    product_evaluation = product_eval,
                    photo_count        = effective_photo_count,
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
            if _np > 0 and market_value.data_source not in ("ebay_mock", "insufficient_data", "correction_range"):
                _ratio = _lp / _np
                if _ratio >= 1.0 and deal_score.score > 4:
                    deal_score.score     = min(deal_score.score, 4)
                    deal_score.should_buy = False
                elif _ratio >= 0.85 and deal_score.score > 5:
                    deal_score.score     = min(deal_score.score, 5)
                    deal_score.should_buy = False

            # ── Step 4: Affiliate + security ──────────────────────────────────
            _SOFT_CATS_s  = {"outdoor", "home", "sports", "camping"}
            _BROAD_VEHICLE_s = {"vehicles"}
            _SPECIFIC_VEHICLE_s = {"cars", "trucks", "rvs", "trailers", "boats"}
            _valid_cats   = set(CATEGORY_PROGRAMS.keys())
            claude_cat    = (deal_score.affiliate_category or "").strip().lower()
            if claude_cat and claude_cat in _valid_cats:
                if claude_cat in _SOFT_CATS_s and _prelim_category not in _SOFT_CATS_s and _prelim_category != "general":
                    category_detected = _prelim_category
                elif claude_cat in _BROAD_VEHICLE_s and _prelim_category in _SPECIFIC_VEHICLE_s:
                    category_detected = _prelim_category
                else:
                    category_detected = claude_cat
            else:
                category_detected = _prelim_category
            _VEHICLE_CATS_S = {"vehicles", "cars", "trucks", "rvs", "trailers", "boats"}
            if listing.is_vehicle and category_detected not in _VEHICLE_CATS_S:
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
                    active_items_sample = market_value.active_items_sample or [],
                    google_prices     = getattr(market_value, '_google_prices', []),
                )
            except Exception:
                affiliate_cards = []

            # v0.46.0 — defense layer + flag suppression
            try:
                affiliate_cards = filter_affiliate_cards(
                    affiliate_cards,
                    asking_price = listing.price,
                    query        = (product_info.search_query if hasattr(product_info, "search_query") else "") or "",
                    category     = category_detected,
                    is_multi_item = bool(listing.is_multi_item),
                )
            except Exception as _fe:
                log.warning(f"filter_affiliate_cards (stream) failed (non-fatal): {_fe}")
            try:
                flagged = await _get_flagged_programs(listing.listing_url)
                if flagged:
                    affiliate_cards = [c for c in affiliate_cards if c.get("program_key") not in flagged]
            except Exception as _se:
                log.warning(f"flag-suppression (stream) failed (non-fatal): {_se}")

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
            if _sec_score <= 3:
                deal_score.should_buy = False
                if deal_score.score > 5:
                    deal_score.score = min(deal_score.score, 5)
                if not deal_score.red_flags:
                    deal_score.red_flags = []
                deal_score.red_flags.insert(0, f"Score capped due to high security risk (security {_sec_score}/10)")
                log.info(f"[SecurityCap] Score capped to {deal_score.score}, should_buy=False (security={_sec_score})")
            elif _sec_score <= 4 and deal_score.score > 6:
                deal_score.score = min(deal_score.score, 6)
                log.info(f"[SecurityCap] Score capped to {deal_score.score} (security={_sec_score})")

            # ── Step 4b.5: No-data guard ──────────────────────────────────────
            # Mirror of Step 4c.5 in /score: never recommend buying when the
            # pricing pipeline returned no usable market data.
            if (market_value.data_source == "vehicle_not_applicable"
                or market_value.confidence == "none"
                or market_value.estimated_value <= 0):
                if deal_score.should_buy or deal_score.score > 5:
                    _old = deal_score.score
                    deal_score.score = min(deal_score.score, 5)
                    deal_score.should_buy = False
                    if not deal_score.red_flags:
                        deal_score.red_flags = []
                    deal_score.red_flags.insert(0, "No reliable market comps available — score is uncertain")
                    log.info(f"[NoDataGuard] No market data (source={market_value.data_source}, conf={market_value.confidence}, ev=${market_value.estimated_value:.0f}) — score {_old} → {deal_score.score}, should_buy=False")

            # ── Step 4c: Price-to-market ratio adjustment ─────────────────────
            _ev = market_value.estimated_value
            if _ev > 0 and listing.price > 0 and market_value.confidence not in ("suspect", "none"):
                _price_ratio = listing.price / _ev
                if _price_ratio > 1.5 and deal_score.score > 5:
                    _old = deal_score.score
                    deal_score.score = min(deal_score.score, 5)
                    deal_score.should_buy = False
                    log.info(f"[RatioAdj] Overpriced {_price_ratio:.1f}x market — score {_old} → {deal_score.score}")
                elif _price_ratio > 1.2 and deal_score.score > 6:
                    _old = deal_score.score
                    deal_score.score = min(deal_score.score, 6)
                    log.info(f"[RatioAdj] Above market {_price_ratio:.1f}x — score {_old} → {deal_score.score}")
                elif _price_ratio < 0.4 and deal_score.score < 6 and _sec_score > 5:
                    _old = deal_score.score
                    deal_score.score = max(deal_score.score, 7)
                    deal_score.should_buy = True
                    log.info(f"[RatioAdj] Deep discount {_price_ratio:.1f}x market — score {_old} → {deal_score.score}")
                elif _price_ratio < 0.6 and deal_score.score < 5 and _sec_score > 5:
                    _old = deal_score.score
                    deal_score.score = max(deal_score.score, 6)
                    log.info(f"[RatioAdj] Good discount {_price_ratio:.1f}x market — score {_old} → {deal_score.score}")

            # ── Step 5: Serialize ─────────────────────────────────────────────
            def _to_dict_s(i):
                return i if isinstance(i, dict) else _dc_asdict(i)
            sold_items_sample   = [_to_dict_s(i) for i in (market_value.sold_items_sample   or [])]
            active_items_sample = [_to_dict_s(i) for i in (market_value.active_items_sample or [])]
            affiliate_dicts     = [_dc_asdict(c) for c in affiliate_cards]

            # For auction-only listings, the displayed "price" should be the
            # current bid (what's shown on eBay right now), not the
            # suggested_max_bid we used internally for scoring purposes.
            _display_price = listing.price
            if _auction_only_mode and _current_bid > 0:
                _display_price = _current_bid

            # ── Step 4d: Trust / scam composite (Task #59) ────────────────────
            # Mirror of the /score wire-up: combine vision-derived signals
            # with pure-Python heuristics, mutate deal_score in place when
            # severity warrants a cap/floor + verdict override.
            from scoring.trust import evaluate_trust as _eval_trust_s
            from scoring.trust import apply_trust_to_score as _apply_trust_s
            _trust_comp_median_s = float(
                (getattr(market_value, "comp_summary", None) or {}).get("median", 0.0)
                or market_value.sold_avg or 0.0
            )
            trust_result_s = _eval_trust_s(
                listing                   = listing.model_dump(),
                comp_median               = _trust_comp_median_s,
                is_stock_photo            = deal_score.is_stock_photo,
                stock_photo_reason        = deal_score.stock_photo_reason,
                photo_text_contradiction  = deal_score.photo_text_contradiction,
                contradiction_reason      = deal_score.contradiction_reason,
                reverse_image_match_count = None,
            )
            _apply_trust_s(deal_score, trust_result_s)

            # ── Step 4e: Negotiation leverage (Task #60) ──────────────────────
            # Mirror of /score wire-up. Purely additive — no deal_score
            # mutation. Reads price_history / listed_at / days_listed from
            # the listing payload (all optional) and pairs with the comp
            # summary's typical_days_to_sell when available.
            from scoring.leverage import evaluate_leverage as _eval_leverage_s
            from scoring.leverage import derive_typical_days_to_sell as _derive_typical_s
            _typical_dts_s = _derive_typical_s(getattr(market_value, "comp_summary", None))
            # Task #60 — overlay the pre-auction asking price into the dump
            # so leverage drop math uses what the buyer sees, not the
            # internal auction max-bid override. This keeps /score and
            # /score/stream functionally equivalent for leverage signals
            # on identical DOM inputs.
            _leverage_listing_s = listing.model_dump()
            _leverage_listing_s["price"] = _asking_price_for_leverage
            leverage_result_s = _eval_leverage_s(
                listing              = _leverage_listing_s,
                typical_days_to_sell = _typical_dts_s,
            )

            # Task #58 — derive confidence + comp_summary + can_price block.
            # Use the listing's actual asking price (not _display_price which
            # may be the auction current bid) so the can't-price verdict copy
            # references what the user is deciding against.
            _confidence_payload_s = _build_confidence_payload(market_value, product_info, listing.price)

            response = DealScoreResponse(
                title             = listing.title,
                price             = _display_price,
                location          = listing.location,
                condition         = listing.condition,
                original_price    = listing.original_price,
                shipping_cost     = listing.shipping_cost,
                # Task #58 — splat the confidence fields
                **_confidence_payload_s,
                # Task #59 — composite trust signals + severity
                **trust_result_s.to_response_dict(),
                # Task #60 — negotiation leverage signals
                **leverage_result_s.to_response_dict(),
                motivation_level  = leverage_result_s.motivation_level,
                estimated_value   = market_value.estimated_value,
                sold_avg          = market_value.sold_avg,
                sold_count        = market_value.sold_count,
                sold_low          = market_value.sold_low,
                sold_high         = market_value.sold_high,
                active_avg        = market_value.active_avg,
                active_count      = market_value.active_count if hasattr(market_value, 'active_count') else 0,
                active_low        = market_value.active_low,
                new_price         = market_value.new_price,
                market_confidence = market_value.confidence,
                data_source       = market_value.data_source,
                query_used        = market_value.query_used,
                sold_items_sample   = sold_items_sample,
                active_items_sample = active_items_sample,
                score               = deal_score.score,
                verdict             = deal_score.verdict,
                # For pure auctions, the deal-scorer's summary text references
                # the override price (suggested_max_bid) and is misleading
                # ("priced at $344 which is 10% above market"). Replace it
                # with the auction_advice reasoning so the user sees a
                # consistent message about the bid range.
                summary             = (
                    auction_advice.get("reasoning") or deal_score.summary
                    if _auction_only_mode and auction_advice.get("reasoning")
                    else deal_score.summary
                ),
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
                bundle_confidence   = getattr(deal_score, "bundle_confidence", "unknown"),
                negotiation         = getattr(deal_score, "negotiation", None) or {},
                is_multi_item       = bool(listing.is_multi_item),
                score_rationale     = deal_score.score_rationale,
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
                auction_advice          = auction_advice,
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
                    _install_id = request.headers.get("x-ds-install-id")
                    row = await pool.fetchrow(
                        """INSERT INTO deal_scores
                           (platform, listing_url, listing_json, score_json, score,
                            ebay_comps_json, affiliate_impressions_json, install_id)
                           VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $6::jsonb, $7::jsonb, $8)
                           RETURNING id""",
                        listing.platform or "unknown",
                        listing.listing_url or "",
                        _json.dumps(listing.model_dump()),
                        _json.dumps(response.model_dump()),
                        deal_score.score,
                        _json.dumps(_ebay_comps),
                        _json.dumps(_affil_impr),
                        _install_id,
                    )
                    if row:
                        score_id = row["id"]
                        response = response.model_copy(update={"score_id": score_id})
            except Exception as _db_err:
                log.warning(f"[Stream] deal_scores save failed (non-fatal): {_db_err}")

            response_dict = response.model_dump()
            _cache_set(_ck, response_dict, url_keyed=_url_keyed)
            # Also write through to the persistent cache so a same-content
            # rescore within 24h returns the identical score without paying Claude.
            # Uses the key we computed before the pipeline ran (price wasn't
            # rewritten between then and now for non-auction flows).
            await _persist_cache_set(_stream_persist_key, response_dict,
                                     listing_url=raw.listing_url, asking_price=price)

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
    from scoring._prompt_safety import (
        wrap as _wrap_untrusted,
        sanitize_for_prompt as _sanitize_untrusted,
        UNTRUSTED_SYSTEM_MESSAGE as _UNTRUSTED_SYS_MSG,
    )

    try:
        results_block = "\n".join(
            f"  - {_sanitize_untrusted((t or '')[:200])}" for t in sample_titles[:3]
        )
        prompt = (
            f'Listing title: {_wrap_untrusted("listing_title", listing_title[:200])}\n'
            f'eBay search query used: {_wrap_untrusted("listing_search_query", query_used[:200])}\n'
            f"Top eBay results returned (each title is UNTRUSTED seller text):\n{results_block}\n\n"
            "Are the eBay results relevant price comps for this listing?\n"
            "A result is relevant if it is the same product type, not an accessory, "
            "not a completely different item, and not a wildly different tier/brand.\n\n"
            "IMPORTANT for better_query: If the listing has a franchise/license name "
            "(NFL, MLB, NBA, Disney, Marvel, etc.) that is DECORATIVE on a standalone "
            "product (e.g. 'NFL Raiders massage chair'), do NOT include the franchise "
            "name in better_query. Search by product type + features instead "
            "(e.g. 'zero gravity massage chair heated'). Only keep franchise names "
            "when the franchise IS the product (e.g. '49ers hat', 'Raiders jersey').\n\n"
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
                system     = _UNTRUSTED_SYS_MSG,
                messages   = [{"role": "user", "content": prompt}],
            ),
        )
        try:
            from scoring import claude_usage as _cu
            _cu.record(resp, label="QueryValidator")
        except Exception:
            pass
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
                await _save_correction(
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
async def test_claude_connection(request: Request):
    """
    Directly tests the Claude API connection from inside the server.
    Visit http://localhost:8000/test-claude to diagnose key/credit issues.

    SECURITY: gated behind DS_API_KEY — when the key is set, this endpoint
    cannot be used by random callers to burn through Anthropic credits or
    confirm the integration is wired up.
    """
    _check_api_key(request)
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
    request:       Request,
    query:         str   = "Celestron NexStar 6SE telescope",
    condition:     str   = "Used",
    listing_price: float = 600.0,
):
    """Tests Claude AI pricing integration end-to-end.

    SECURITY: gated behind DS_API_KEY (see test_claude_connection) so the
    endpoint can't be abused as an unauthenticated proxy to Claude.
    """
    _check_api_key(request)
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

def _read_backend_version() -> str:
    """Read API version from the VERSION file (single source of truth).

    Updated by `scripts/bump-version.sh` so the audit dashboard, score
    metadata, and /health endpoint never drift behind a hand-edited constant.
    """
    from pathlib import Path as _P
    try:
        return (_P(__file__).parent / "VERSION").read_text().strip() or "unknown"
    except Exception:
        return "unknown"


# Resolved at import-time from artifacts/deal-scout-api/VERSION.
# Bumped to v0.44.0 with the Approach A score-panel layout (Task #68) —
# kept in lock-step with extension/manifest.json so the workspace
# header and /admin/audit telemetry agree on the running build.
BACKEND_VERSION = _read_backend_version()

@app.get("/privacy", response_class=HTMLResponse)
async def privacy_policy():
    return """<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Deal Scout — Privacy Policy</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;max-width:720px;margin:40px auto;padding:0 20px;line-height:1.6;color:#222}
h1{font-size:1.6em}h2{font-size:1.2em;margin-top:1.5em}ul{padding-left:1.4em}</style></head>
<body>
<h1>Deal Scout Privacy Policy</h1>
<p><strong>Effective date:</strong> March 26, 2026</p>
<p>Deal Scout is a Chrome extension that helps shoppers evaluate deals on Facebook Marketplace, Craigslist, eBay, and OfferUp.</p>

<h2>Data We Collect</h2>
<ul>
<li><strong>Listing data you view:</strong> When you browse a supported listing page, the extension sends the listing title, price, description, condition, location, seller name, and listing photos to our scoring API for analysis. This data is used solely to generate your deal score and is not stored permanently.</li>
<li><strong>Anonymized market signals:</strong> We record aggregated, anonymized pricing data (category, condition, city-level location, price ranges) to improve our market intelligence. No personally identifiable information (PII) is included.</li>
<li><strong>Affiliate click events:</strong> When you click an affiliate link (e.g., Amazon, eBay), we record the click event (program name, category, price bucket) to measure performance. No user IDs or browsing history are stored.</li>
</ul>

<h2>Data We Do NOT Collect</h2>
<ul>
<li>We do not collect your name, email, IP address, or any account credentials.</li>
<li>We do not track your browsing history outside of supported listing pages.</li>
<li>We do not sell or share personal data with third parties.</li>
<li>We do not use cookies or fingerprinting.</li>
</ul>

<h2>Third-Party Services</h2>
<ul>
<li><strong>Claude AI (Anthropic):</strong> Listing text and photos are sent to Claude AI for deal analysis. Anthropic's privacy policy applies to data processed by their models.</li>
<li><strong>eBay Finding API:</strong> Product titles are sent to eBay's API to fetch comparable sold/active listings for price comparison.</li>
<li><strong>Affiliate links:</strong> Clicking a "Compare" or "Buy New" card opens Amazon, eBay, Back Market, or other retailer sites via affiliate links. Those sites have their own privacy policies.</li>
</ul>

<h2>Data Retention</h2>
<p>Scoring results are cached in memory for up to 30 minutes to speed up repeat views, then discarded. Anonymized market signals are retained indefinitely. Affiliate click events are retained for analytics purposes.</p>

<h2>Your Rights</h2>
<p>Since we do not collect PII, there is no personal data to delete. If you have questions, contact us at <strong>dealscout@proton.me</strong>.</p>

<h2>Changes</h2>
<p>We may update this policy occasionally. Changes will be posted on this page.</p>
</body></html>"""

@app.get("/health")
async def health():
    """Detailed health check — confirms API keys are configured."""
    return {
        "api":           "ok",
        "version":       BACKEND_VERSION,
        "anthropic_key": "set" if os.getenv("AI_INTEGRATIONS_ANTHROPIC_BASE_URL") else "missing",
        "ebay_key":      "set" if os.getenv("EBAY_APP_ID") and "your_ebay" not in os.getenv("EBAY_APP_ID", "") else "missing",
        "ebay_browse":   "set" if os.getenv("EBAY_APP_ID") and os.getenv("EBAY_CERT_ID") else "missing",
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
    Persists to PostgreSQL affiliate_events table.
    """
    _check_api_key(request)
    try:
        from scoring.data_pipeline import _get_pool
        await _ensure_affiliate_events_table()
        pool = await _get_pool()
        if pool:
            await pool.execute(
                """INSERT INTO affiliate_events
                   (event, program, category, price_bucket, card_type,
                    deal_score, position, selection_reason, commission_live)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)""",
                evt.event,
                evt.program or "",
                evt.category or "",
                evt.price_bucket or "",
                evt.card_type or "",
                evt.deal_score or 0,
                evt.position or 0,
                (evt.selection_reason or "")[:120],
                evt.commission_live or False,
            )
            log.debug(f"[Event] Saved affiliate event: {evt.event} / {evt.program}")
        else:
            log.warning("[Event] No DB pool — event not persisted")
            raise HTTPException(status_code=503, detail="Database unavailable")
    except HTTPException:
        raise
    except Exception as e:
        log.warning(f"[Event] DB insert failed: {e}")
        raise HTTPException(status_code=500, detail="Failed to persist event")

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
    # 4000-char cap matches Discord embed's description limit — anything
    # larger gets sliced anyway. Caps prevent abuse of the Discord webhook
    # as a free relay.
    report: str = Field(..., max_length=4000)
    ts: str = Field("", max_length=64)

@app.post("/report")
async def submit_report(body: IssueReport, request: Request):
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
    _check_api_key(request)
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

    SECURITY: max_length caps prevent a malicious caller from posting
    multi-MB payloads that would either bloat the corrections.jsonl file
    or be echoed verbatim into a future Claude prompt.
    """
    listing_title:       str   = Field(..., max_length=500)
    bad_query:           str   = Field(..., max_length=300)
    good_query:          str   = Field(..., max_length=300)
    correct_price_low:   float = 0.0
    correct_price_high:  float = 0.0
    notes:               str   = Field("",  max_length=2000)


class ThumbsRequest(BaseModel):
    score_id: int
    thumbs:   int   # 1 = up, -1 = down
    reason:   str   = ""   # labeled reason for 👎 (e.g. "score_too_high", "price_wrong")


class AffiliateFlagRequest(BaseModel):
    listing_url: str    = Field(..., max_length=1000)
    program_key: str    = Field(..., max_length=64)
    brand:       str    = Field("", max_length=128)
    model:       str    = Field("", max_length=256)
    retailer:    str    = Field("", max_length=64)
    url:         str    = Field("", max_length=1000)
    reason:      str    = Field("", max_length=200)


_flag_rate = {}  # install_id → (window_start_ts, count)

@app.post("/affiliate/flag")
async def flag_affiliate_card(body: AffiliateFlagRequest, request: Request):
    """v0.46.0 — user marks an affiliate card as wrong/spam for a listing.

    Persisted in `affiliate_flags`; subsequent /score calls for the same
    listing_url filter the card out before returning. Rate-limited per
    install (10/min) and key-gated like every other write endpoint.
    """
    _check_api_key(request)
    install_id = request.headers.get("x-ds-install-id") or "anon"
    now = _time.time()
    win_start, n = _flag_rate.get(install_id, (now, 0))
    if now - win_start > 60:
        win_start, n = now, 0
    if n >= 10:
        raise HTTPException(status_code=429, detail="Too many flags — slow down")
    _flag_rate[install_id] = (win_start, n + 1)

    try:
        # Table is created at @app.on_event("startup"); no per-request DDL.
        from scoring.data_pipeline import _get_pool
        pool = await _get_pool()
        if not pool:
            raise HTTPException(status_code=503, detail="DB unavailable")
        await pool.execute(
            """INSERT INTO affiliate_flags
               (listing_url, program_key, brand, model, retailer, url, install_id, reason)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8)""",
            body.listing_url, body.program_key, body.brand, body.model,
            body.retailer, body.url, install_id, body.reason,
        )
        log.info(f"[AffiliateFlag] {body.program_key} for {body.listing_url[:60]} (install={install_id[:8]})")
        return {"ok": True}
    except HTTPException:
        raise
    except Exception as e:
        log.error(f"[AffiliateFlag] DB error: {e}")
        raise HTTPException(status_code=500, detail="Flag write failed")


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
    Saves to PostgreSQL query_corrections table and immediately affects future scores.
    """
    _check_api_key(request)
    from scoring.corrections import save_correction
    price_range = [body.correct_price_low, body.correct_price_high] if body.correct_price_low else []
    ok = await save_correction(
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


def _check_admin_auth(request: Request):
    """
    Legacy alias kept so existing /admin/* call sites don't have to change in
    this PR. Delegates to _check_admin_token, which fails closed when
    ADMIN_TOKEN is unset (vs the old behavior of opening admin to the world).
    """
    _check_admin_token(request)


@app.get("/admin")
async def admin_page(request: Request):
    """
    Admin page: recent scored listings with thumbs, correction log, links.
    """
    _check_admin_auth(request)
    from scoring.corrections import get_all_corrections
    from scoring.data_pipeline import _get_pool
    await _ensure_corrections_table()
    corrections = await get_all_corrections()

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

    try:
        await _ensure_affiliate_events_table()
        pool2 = await _get_pool()
        if pool2:
            click_rows = await pool2.fetch(
                "SELECT program, position, card_type FROM affiliate_events WHERE event = 'affiliate_click'"
            )
            for row in click_rows:
                prog  = row["program"] or "unknown"
                pos   = row["position"] or 0
                ctype = row["card_type"] or "unknown"
                if prog not in affiliate_stats:
                    affiliate_stats[prog] = {"impressions": 0, "clicks": 0, "positions": [], "categories": []}
                affiliate_stats[prog]["clicks"] += 1
                if 1 <= pos <= 3:
                    affiliate_by_pos[pos]["clicks"] += 1
                if ctype not in affiliate_by_type:
                    affiliate_by_type[ctype] = {"impressions": 0, "clicks": 0}
                affiliate_by_type[ctype]["clicks"] += 1
    except Exception as _ce:
        log.warning(f"[admin] affiliate click query failed: {_ce}")

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
    """API key gate for the market data endpoints.

    SECURITY (v0.45.2 hardening): previously this fell open when
    MARKET_DATA_API_KEY was unset, leaking the aggregate market signal table
    to any anonymous caller. Now it falls back to the standard `_check_api_key`
    (DS_API_KEY) so the endpoint shares the same auth as every other
    extension-facing route — and `_check_api_key` itself only falls open
    when DS_API_KEY is unset (development mode).
    """
    required_key = os.getenv("MARKET_DATA_API_KEY", "")
    if not required_key:
        # Fall back to the shared extension key so the endpoint isn't
        # silently open in production when MARKET_DATA_API_KEY is forgotten.
        _check_api_key(request)
        return
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

    SECURITY: this is admin-only data, so it uses ADMIN_TOKEN — not the
    weaker MARKET_DATA_API_KEY which is open-by-default when unset.
    """
    _check_admin_token(request)
    from scoring.data_pipeline import get_dashboard_summary
    summary = await get_dashboard_summary()
    # Score-cache hit rate metric (process-local since-restart counters).
    # Surfaces whether the persistent reproducibility cache is paying off —
    # a low hit rate suggests either listings are short-lived or content
    # hashes are too fine-grained.
    _hits   = _score_cache_stats["hits"]
    _misses = _score_cache_stats["misses"]
    _total  = _hits + _misses
    score_cache_metric = {
        "hits":         _hits,
        "misses":       _misses,
        "total_lookups": _total,
        "hit_rate_pct": round((_hits / _total) * 100, 1) if _total else 0.0,
        "ttl_hours":    _SCORE_CACHE_PERSIST_TTL_SECONDS // 3600,
    }
    # Also try to surface live row count + size from the table itself so
    # operators can sanity-check growth. Best-effort; failures are silent.
    try:
        await _ensure_score_cache_table()
        from scoring.data_pipeline import _get_pool
        pool = await _get_pool()
        if pool:
            row = await pool.fetchrow(
                "SELECT COUNT(*) AS total, "
                "COUNT(*) FILTER (WHERE expires_at > now()) AS live "
                "FROM score_cache"
            )
            if row:
                score_cache_metric["rows_total"] = int(row["total"])
                score_cache_metric["rows_live"]  = int(row["live"])
    except Exception:
        pass
    claude_cache_metric = await _claude_cache_summary()
    return {
        "pipeline": "Deal Scout Market Intelligence",
        "description": "Anonymized used-market price signals. No PII collected.",
        "stats": summary,
        "score_cache": score_cache_metric,
        "claude_cache": claude_cache_metric,
    }


async def _claude_cache_summary(hours: int = 24) -> dict:
    """
    Aggregate prompt-cache telemetry from score_log over the last N hours
    (Task #75). Walks every row's claude_usage.by_label and sums input_tokens,
    cache_read_input_tokens, cache_creation_input_tokens, calls, and
    cache_hit_calls per label. Returns per-label hit_rate_pct (cache_hit_calls
    / calls) and token_read_pct (cache_read / (cache_read + input)).

    A <10% hit_rate_pct on a label that should be cacheable (DealScorer /
    *Extractor) means cache_control is being stripped or the system text is
    shifting between calls. Best-effort; returns {"error": ...} on DB failure.
    """
    out = {"window_hours": hours, "rows_scanned": 0, "by_label": {}, "totals": {}}
    try:
        await _ensure_score_log_table()
        from scoring.data_pipeline import _get_pool
        pool = await _get_pool()
        if not pool:
            out["error"] = "DB unavailable"
            return out

        rows = await pool.fetch(
            f"""SELECT (payload->'claude_usage'->'by_label') AS by_label
                FROM score_log
                WHERE server_ts > now() - interval '{int(hours)} hours'
                  AND payload ? 'claude_usage'
                  AND payload->'claude_usage' ? 'by_label'"""
        )
        out["rows_scanned"] = len(rows)

        import json as _json
        agg: dict = {}
        for r in rows:
            raw = r["by_label"]
            if raw is None:
                continue
            if isinstance(raw, str):
                try:
                    raw = _json.loads(raw)
                except Exception:
                    continue
            if not isinstance(raw, dict):
                continue
            for label, b in raw.items():
                if not isinstance(b, dict):
                    continue
                bucket = agg.setdefault(label, {
                    "calls": 0,
                    "input_tokens": 0,
                    "cache_read_input_tokens": 0,
                    "cache_creation_input_tokens": 0,
                    "cache_hit_calls": 0,
                })
                bucket["calls"]                       += int(b.get("calls", 0) or 0)
                bucket["input_tokens"]                += int(b.get("input_tokens", 0) or 0)
                bucket["cache_read_input_tokens"]     += int(b.get("cache_read_input_tokens", 0) or 0)
                bucket["cache_creation_input_tokens"] += int(b.get("cache_creation_input_tokens", 0) or 0)
                bucket["cache_hit_calls"]             += int(b.get("cache_hit_calls", 0) or 0)

        totals = {
            "calls": 0,
            "input_tokens": 0,
            "cache_read_input_tokens": 0,
            "cache_creation_input_tokens": 0,
            "cache_hit_calls": 0,
        }
        for label, b in agg.items():
            calls = b["calls"]
            cache_r = b["cache_read_input_tokens"]
            in_tok = b["input_tokens"]
            denom_tok = cache_r + in_tok
            b["hit_rate_pct"]   = round((b["cache_hit_calls"] / calls) * 100, 1) if calls else 0.0
            b["token_read_pct"] = round((cache_r / denom_tok) * 100, 1) if denom_tok else 0.0
            for k in totals:
                totals[k] += b[k]

        t_calls = totals["calls"]
        t_denom = totals["cache_read_input_tokens"] + totals["input_tokens"]
        totals["hit_rate_pct"]   = round((totals["cache_hit_calls"] / t_calls) * 100, 1) if t_calls else 0.0
        totals["token_read_pct"] = round((totals["cache_read_input_tokens"] / t_denom) * 100, 1) if t_denom else 0.0

        out["by_label"] = dict(sorted(agg.items()))
        out["totals"]   = totals
    except Exception as e:
        out["error"] = str(e)
    return out


@app.post("/admin/score-cache/clear")
async def clear_score_cache(request: Request, url: str = "", all: bool = False):
    """
    Invalidate persistent score_cache entries.

    Usage:
      POST /admin/score-cache/clear?url=https://...   → drop one listing's cache
      POST /admin/score-cache/clear?all=true          → drop the whole table

    SECURITY: header-only admin auth (ADMIN_TOKEN). Requires explicit `url=` or
    `all=true` so an empty curl can't accidentally wipe the cache.
    """
    _check_admin_token(request)
    if not url and not all:
        raise HTTPException(
            status_code=400,
            detail="Specify ?url=<listing url> to clear one listing, or ?all=true to clear all.",
        )
    try:
        await _ensure_score_cache_table()
        from scoring.data_pipeline import _get_pool
        pool = await _get_pool()
        if not pool:
            return {"ok": False, "cleared": 0, "error": "DB unavailable"}
        if all:
            result = await pool.execute("DELETE FROM score_cache")
        else:
            result = await pool.execute("DELETE FROM score_cache WHERE listing_url = $1", url)
        # asyncpg returns "DELETE <n>" — pull the count off the tail.
        try:
            n = int(result.split()[-1])
        except Exception:
            n = 0
        log.info(f"[ScoreCache] cleared {n} rows (url='{url}', all={all})")
        return {"ok": True, "cleared": n, "scope": "all" if all else "url"}
    except Exception as e:
        log.error(f"[ScoreCache] clear failed: {e}")
        return {"ok": False, "cleared": 0, "error": str(e)}


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
            "bundle_confidence":   getattr(deal_score, "bundle_confidence", "unknown"),
            "negotiation":         getattr(deal_score, "negotiation", None) or {},
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
        "claude_usage": _current_claude_usage(),
    }


def _current_claude_usage() -> dict:
    """Snapshot Anthropic token usage for the in-flight scoring run."""
    try:
        from scoring import claude_usage as _cu
        return _cu.totals() or {}
    except Exception:
        return {}


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
    cu = r.get("claude_usage", {}) or {}
    return {
        "title":           listing.get("title"),
        "claude_input_tokens":  cu.get("input_tokens"),
        "claude_output_tokens": cu.get("output_tokens"),
        "claude_calls":         cu.get("calls"),
        "claude_cost_usd":      cu.get("cost_usd"),
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
        try:
            thumbs_rows = await pool.fetch(
                "SELECT listing_url, thumbs FROM deal_scores WHERE thumbs IS NOT NULL ORDER BY created_at DESC LIMIT 200"
            )
            thumbs_map = {}
            for tr in thumbs_rows:
                url = tr["listing_url"]
                if url:
                    thumbs_map[url] = "up" if tr["thumbs"] == 1 else "down"
            for sc in scorecards:
                listing_url = sc.get("listing", {}).get("listing_url", "")
                if listing_url and listing_url in thumbs_map:
                    if not sc.get("metadata"):
                        sc["metadata"] = {}
                    sc["metadata"]["user_feedback"] = thumbs_map[listing_url]
        except Exception:
            pass

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


@app.get("/admin/audit", response_class=HTMLResponse)
async def audit_dashboard(request: Request):
    _check_admin_auth(request)
    from pathlib import Path as _P
    html = (_P(__file__).parent / "templates" / "audit_dashboard.html").read_text()
    html = html.replace("{{API_KEY}}", _DS_API_KEY or "")
    html = html.replace("{{CURRENT_VERSION}}", BACKEND_VERSION)
    return HTMLResponse(html)


@app.get("/admin/audit/telemetry")
async def audit_telemetry(request: Request):
    _check_admin_auth(request)
    try:
        from scoring.data_pipeline import _get_pool
        from scoring.audit import get_telemetry
        await _ensure_score_log_table()
        pool = await _get_pool()
        return await get_telemetry(pool)
    except Exception as e:
        log.warning(f"[audit/telemetry] failed: {e}")
        return {"error": str(e)}


@app.get("/admin/audit/review")
async def audit_review(request: Request, version: str = None, since_id: int = 0):
    _check_admin_auth(request)
    try:
        import json as _json
        from scoring.data_pipeline import _get_pool
        from scoring.audit import build_review_packet
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

        try:
            thumbs_rows = await pool.fetch(
                "SELECT listing_url, thumbs, created_at FROM deal_scores WHERE thumbs IS NOT NULL ORDER BY created_at DESC LIMIT 200"
            )
            thumbs_map = {}
            for tr in thumbs_rows:
                url = tr["listing_url"]
                if url:
                    thumbs_map[url] = tr["thumbs"]
            for sc in scorecards:
                listing_url = sc.get("listing", {}).get("listing_url", "")
                if listing_url and listing_url in thumbs_map:
                    if not sc.get("metadata"):
                        sc["metadata"] = {}
                    sc["metadata"]["user_feedback"] = "up" if thumbs_map[listing_url] == 1 else "down"
        except Exception:
            pass

        return build_review_packet(scorecards, version_filter=version, since_id=since_id)
    except Exception as e:
        log.warning(f"[audit/review] failed: {e}")
        return {"error": str(e)}


@app.post("/admin/audit/check")
async def audit_check(request: Request):
    _check_admin_auth(request)
    try:
        import json as _json
        from scoring.data_pipeline import _get_pool
        from scoring.audit import run_llm_check
        await _ensure_score_log_table()
        pool = await _get_pool()

        body = await request.json()
        limit = body.get("limit", 50)
        version = body.get("version") or None
        review_all = body.get("review_all", False)
        explicit_since_id = body.get("since_id")

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

        from scoring.audit import _last_reviewed_id
        if explicit_since_id is not None:
            since_id = int(explicit_since_id)
        elif review_all:
            since_id = 0
        else:
            since_id = _last_reviewed_id

        return await run_llm_check(scorecards, version_filter=version, since_id=since_id, limit=limit)
    except Exception as e:
        log.error(f"[audit/check] failed: {e}")
        return {"error": str(e), "findings": []}


@app.post("/admin/audit/rescore")
async def audit_rescore(request: Request):
    _check_admin_auth(request)
    try:
        import json as _json
        from scoring.data_pipeline import _get_pool
        from scoring.audit import build_rescore_diff
        await _ensure_score_log_table()
        pool = await _get_pool()

        body = await request.json()
        score_log_id = body.get("score_log_id")
        if not score_log_id:
            return {"error": "score_log_id required"}

        row = await pool.fetchrow(
            "SELECT payload FROM score_log WHERE id = $1", score_log_id
        )
        if not row:
            return {"error": f"Score log entry {score_log_id} not found"}

        old_scorecard = _json.loads(row["payload"]) if isinstance(row["payload"], str) else row["payload"]
        old_listing = old_scorecard.get("listing", {})

        listing_req = ListingRequest(
            title=old_listing.get("title", ""),
            price=float(old_listing.get("price", 0)),
            raw_price_text=old_listing.get("raw_price_text", ""),
            description=old_listing.get("description_snippet", ""),
            location=old_listing.get("location", ""),
            condition=old_listing.get("condition", "Unknown"),
            seller_name=old_listing.get("seller_name", ""),
            listing_url="",
            is_multi_item=old_listing.get("is_multi_item", False),
            is_vehicle=old_listing.get("is_vehicle", False),
            vehicle_details=old_listing.get("vehicle_details"),
            seller_trust=old_listing.get("seller_trust"),
            original_price=float(old_listing.get("original_price", 0) or 0),
            shipping_cost=float(old_listing.get("shipping_cost", 0) or 0),
            image_urls=old_listing.get("image_urls", []),
            photo_count=old_listing.get("photo_count", 0),
            platform=old_listing.get("platform", "facebook_marketplace"),
        )

        request.state._audit_rescore = True
        new_response = await score_listing(listing_req, request)
        if isinstance(new_response, dict):
            new_response_dict = new_response
        else:
            new_response_dict = new_response.model_dump() if hasattr(new_response, 'model_dump') else dict(new_response)

        new_response_dict["backend_version"] = BACKEND_VERSION

        diff = build_rescore_diff(old_scorecard, new_response_dict)

        return {
            "old_scorecard_id": score_log_id,
            "original_scorecard": old_scorecard,
            "new_response": new_response_dict,
            "diff": diff,
        }
    except Exception as e:
        log.error(f"[audit/rescore] failed: {e}")
        return {"error": str(e)}


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


import asyncio as _asyncio

# --- Cost estimation constants ---------------------------------------------
# Each "score" in the deal_scores table corresponds to roughly 3-4 Anthropic
# Claude Haiku 4.5 calls across the full scoring pipeline (deal_scorer,
# product_extractor, product_evaluator, occasionally vision + claude_pricer).
# Calibrated against typical token usage ~7000 in / ~800 out per scoring run.
# Haiku 4.5 pricing: $1/Mtok input, $5/Mtok output.
# 7000 * $1/M + 800 * $5/M = $0.007 + $0.004 = ~$0.011, rounded up for vision.
CLAUDE_CALLS_PER_SCORE = 3.5         # avg main + extractor + evaluator (+ sometimes vision)
COST_PER_SCORE_USD     = 0.015       # estimated all-in Anthropic spend per score
# Anthropic monthly soft limit (set this to your actual plan limit if known).
ANTHROPIC_MONTHLY_LIMIT_USD = 100.0  # adjust to match your Anthropic credit balance

async def _build_daily_summary() -> dict:
    from scoring.data_pipeline import _get_pool
    pool = await _get_pool()
    if not pool:
        return {}

    summary = {}
    try:
        row = await pool.fetchrow(
            """SELECT
                 COUNT(*) AS total,
                 COUNT(*) FILTER (WHERE platform='facebook_marketplace') AS fbm,
                 COUNT(*) FILTER (WHERE platform='craigslist') AS cl,
                 COUNT(*) FILTER (WHERE platform='ebay') AS ebay,
                 COUNT(*) FILTER (WHERE platform='offerup') AS ou,
                 ROUND(AVG(score)::numeric, 1) AS avg_score,
                 COUNT(*) FILTER (WHERE thumbs=1) AS thumbs_up,
                 COUNT(*) FILTER (WHERE thumbs=-1) AS thumbs_down,
                 COUNT(*) FILTER (WHERE (score_json->'security_score'->>'score')::int <= 3) AS high_risk
               FROM deal_scores
               WHERE created_at > now() - interval '24 hours'"""
        )
        if row:
            summary["scores"] = dict(row)
    except Exception as e:
        log.warning(f"[DailySummary] Scores query failed: {e}")

    try:
        await _ensure_affiliate_events_table()
        imp_rows = await pool.fetch(
            """SELECT el->>'program_key' AS program, COUNT(*) AS impressions
               FROM deal_scores,
                    jsonb_array_elements(affiliate_impressions_json) AS el
               WHERE affiliate_impressions_json IS NOT NULL
                 AND affiliate_impressions_json != 'null'::jsonb
                 AND created_at > now() - interval '24 hours'
               GROUP BY el->>'program_key'
               ORDER BY impressions DESC"""
        )
        imps_by_program = {r["program"]: r["impressions"] for r in imp_rows}
        total_imps = sum(imps_by_program.values())

        click_rows = await pool.fetch(
            """SELECT program, COUNT(*) AS clicks
               FROM affiliate_events
               WHERE event = 'affiliate_click'
                 AND created_at > now() - interval '24 hours'
               GROUP BY program
               ORDER BY clicks DESC"""
        )
        clicks_by_program = {r["program"]: r["clicks"] for r in click_rows}
        total_clicks = sum(clicks_by_program.values())

        all_programs = sorted(
            set(list(imps_by_program.keys()) + list(clicks_by_program.keys())),
            key=lambda p: clicks_by_program.get(p, 0),
            reverse=True,
        )
        program_breakdown = {}
        for prog in all_programs:
            p_imps = imps_by_program.get(prog, 0)
            p_clicks = clicks_by_program.get(prog, 0)
            p_ctr = f"{(p_clicks/p_imps*100):.1f}%" if p_imps > 0 else "—"
            program_breakdown[prog] = {"impressions": p_imps, "clicks": p_clicks, "ctr": p_ctr}

        overall_ctr = f"{(total_clicks/total_imps*100):.1f}%" if total_imps > 0 else "—"

        position_rows = await pool.fetch(
            """SELECT position, COUNT(*) AS clicks
               FROM affiliate_events
               WHERE event = 'affiliate_click'
                 AND created_at > now() - interval '24 hours'
                 AND position IS NOT NULL
               GROUP BY position
               ORDER BY clicks DESC
               LIMIT 5"""
        )

        summary["affiliate"] = {
            "impressions": total_imps,
            "clicks": total_clicks,
            "ctr": overall_ctr,
            "by_program": program_breakdown,
            "by_position": {f"pos {r['position']}": r["clicks"] for r in position_rows},
        }
    except Exception as e:
        log.warning(f"[DailySummary] Affiliate query failed: {e}")

    try:
        await _ensure_corrections_table()
        corr_row = await pool.fetchrow(
            "SELECT COUNT(*) AS cnt FROM query_corrections WHERE created_at > now() - interval '24 hours'"
        )
        summary["corrections"] = corr_row["cnt"] if corr_row else 0
    except Exception as e:
        log.warning(f"[DailySummary] Corrections query failed: {e}")

    try:
        cat_rows = await pool.fetch(
            """SELECT score_json->>'category_detected' AS cat, COUNT(*) AS cnt
               FROM deal_scores
               WHERE created_at > now() - interval '24 hours'
                 AND score_json->>'category_detected' IS NOT NULL
                 AND score_json->>'category_detected' != ''
               GROUP BY score_json->>'category_detected'
               ORDER BY cnt DESC
               LIMIT 5"""
        )
        summary["top_categories"] = {r["cat"]: r["cnt"] for r in cat_rows}
    except Exception as e:
        log.warning(f"[DailySummary] Categories query failed: {e}")

    # --- Anthropic cost / API-call (from real token usage) ------------------
    # Per-score Claude token totals are persisted into score_log.payload
    # under the "claude_usage" key (see _build_scorecard / claude_usage.py).
    # We sum those for accurate $$ instead of multiplying by a flat estimate.
    # Falls back to the legacy COST_PER_SCORE_USD multiplier for any score
    # that pre-dates this tracking.
    try:
        await _ensure_score_log_table()

        deal_row = await pool.fetchrow(
            """SELECT
                 COUNT(*) FILTER (WHERE created_at > now() - interval '24 hours') AS scores_24h,
                 COUNT(*) FILTER (WHERE created_at > date_trunc('month', now())) AS scores_mtd,
                 COUNT(*) FILTER (WHERE created_at > now() - interval '30 days') AS scores_30d
               FROM deal_scores"""
        )
        scores_24h = (deal_row and deal_row["scores_24h"]) or 0
        scores_mtd = (deal_row and deal_row["scores_mtd"]) or 0
        scores_30d = (deal_row and deal_row["scores_30d"]) or 0

        async def _usage_window(interval_sql: str) -> dict:
            row = await pool.fetchrow(
                f"""SELECT
                       COUNT(*)                                                       AS rows_with_usage,
                       COALESCE(SUM((payload->'claude_usage'->>'input_tokens')::bigint),  0) AS in_tok,
                       COALESCE(SUM((payload->'claude_usage'->>'output_tokens')::bigint), 0) AS out_tok,
                       COALESCE(SUM((payload->'claude_usage'->>'calls')::bigint),         0) AS calls,
                       COALESCE(SUM((payload->'claude_usage'->>'cost_usd')::numeric),     0) AS cost_usd
                     FROM score_log
                     WHERE server_ts > now() - interval '{interval_sql}'
                       AND payload ? 'claude_usage'
                       AND payload->'claude_usage' ? 'input_tokens'"""
            )
            return {
                "rows":     int(row["rows_with_usage"] or 0) if row else 0,
                "in_tok":   int(row["in_tok"] or 0) if row else 0,
                "out_tok":  int(row["out_tok"] or 0) if row else 0,
                "calls":    int(row["calls"] or 0) if row else 0,
                "cost_usd": float(row["cost_usd"] or 0.0) if row else 0.0,
            }

        async def _usage_mtd() -> dict:
            row = await pool.fetchrow(
                """SELECT
                       COUNT(*)                                                       AS rows_with_usage,
                       COALESCE(SUM((payload->'claude_usage'->>'input_tokens')::bigint),  0) AS in_tok,
                       COALESCE(SUM((payload->'claude_usage'->>'output_tokens')::bigint), 0) AS out_tok,
                       COALESCE(SUM((payload->'claude_usage'->>'calls')::bigint),         0) AS calls,
                       COALESCE(SUM((payload->'claude_usage'->>'cost_usd')::numeric),     0) AS cost_usd
                     FROM score_log
                     WHERE server_ts > date_trunc('month', now())
                       AND payload ? 'claude_usage'
                       AND payload->'claude_usage' ? 'input_tokens'"""
            )
            return {
                "rows":     int(row["rows_with_usage"] or 0) if row else 0,
                "in_tok":   int(row["in_tok"] or 0) if row else 0,
                "out_tok":  int(row["out_tok"] or 0) if row else 0,
                "calls":    int(row["calls"] or 0) if row else 0,
                "cost_usd": float(row["cost_usd"] or 0.0) if row else 0.0,
            }

        u_24h = await _usage_window("24 hours")
        u_mtd = await _usage_mtd()

        # Blend real token cost with legacy estimate for any scores still
        # missing claude_usage (e.g. pre-rollout entries).
        legacy_24h = max(scores_24h - u_24h["rows"], 0) * COST_PER_SCORE_USD
        legacy_mtd = max(scores_mtd - u_mtd["rows"], 0) * COST_PER_SCORE_USD
        cost_today_usd = u_24h["cost_usd"] + legacy_24h
        cost_mtd_usd   = u_mtd["cost_usd"] + legacy_mtd

        from datetime import datetime as _dt
        day_of_month  = _dt.utcnow().day or 1
        days_in_month = 30  # rough — good enough for projection
        cost_projected_usd = (cost_mtd_usd / day_of_month) * days_in_month
        limit_pct = (cost_projected_usd / ANTHROPIC_MONTHLY_LIMIT_USD * 100) if ANTHROPIC_MONTHLY_LIMIT_USD else 0

        # Real Claude call counts (from token usage), with legacy estimate
        # filling in for scores that lack tracked usage.
        calls_24h = u_24h["calls"] + int(max(scores_24h - u_24h["rows"], 0) * CLAUDE_CALLS_PER_SCORE)
        calls_mtd = u_mtd["calls"] + int(max(scores_mtd - u_mtd["rows"], 0) * CLAUDE_CALLS_PER_SCORE)

        # Per-score actuals (only over scores with real tracking) help us
        # see if a code change is making each run cheaper or more expensive.
        per_score_today = round(u_24h["cost_usd"] / u_24h["rows"], 4) if u_24h["rows"] else None
        per_score_mtd   = round(u_mtd["cost_usd"] / u_mtd["rows"], 4) if u_mtd["rows"] else None

        coverage_24h = (u_24h["rows"] / scores_24h * 100) if scores_24h else 0.0
        coverage_mtd = (u_mtd["rows"] / scores_mtd * 100) if scores_mtd else 0.0

        summary["costs"] = {
            "scores_24h":         scores_24h,
            "scores_mtd":         scores_mtd,
            "scores_30d":         scores_30d,
            "claude_calls_24h":   calls_24h,
            "claude_calls_mtd":   calls_mtd,
            "input_tokens_24h":   u_24h["in_tok"],
            "output_tokens_24h":  u_24h["out_tok"],
            "input_tokens_mtd":   u_mtd["in_tok"],
            "output_tokens_mtd":  u_mtd["out_tok"],
            "cost_today_usd":     round(cost_today_usd, 2),
            "cost_mtd_usd":       round(cost_mtd_usd, 2),
            "cost_projected_usd": round(cost_projected_usd, 2),
            "monthly_limit_usd":  ANTHROPIC_MONTHLY_LIMIT_USD,
            "limit_pct":          round(limit_pct, 1),
            "per_score_today_usd": per_score_today,
            "per_score_mtd_usd":   per_score_mtd,
            "tracked_coverage_24h_pct": round(coverage_24h, 1),
            "tracked_coverage_mtd_pct": round(coverage_mtd, 1),
        }
    except Exception as e:
        log.warning(f"[DailySummary] Costs query failed: {e}")

    try:
        user_row = await pool.fetchrow(
            """SELECT
                 COUNT(DISTINCT install_id) FILTER (WHERE created_at > now() - interval '24 hours') AS active_today,
                 COUNT(DISTINCT install_id) FILTER (
                     WHERE created_at > now() - interval '24 hours'
                       AND install_id NOT IN (
                           SELECT DISTINCT install_id FROM deal_scores
                           WHERE install_id IS NOT NULL
                             AND created_at <= now() - interval '24 hours'
                       )
                 ) AS new_today,
                 COUNT(DISTINCT install_id) FILTER (
                     WHERE created_at BETWEEN now() - interval '48 hours' AND now() - interval '24 hours'
                       AND install_id NOT IN (
                           SELECT DISTINCT install_id FROM deal_scores
                           WHERE install_id IS NOT NULL
                             AND created_at > now() - interval '24 hours'
                       )
                 ) AS dropped_today
               FROM deal_scores
               WHERE install_id IS NOT NULL"""
        )
        total_row = await pool.fetchrow(
            "SELECT COUNT(DISTINCT install_id) AS total FROM deal_scores WHERE install_id IS NOT NULL"
        )
        summary["users"] = {
            "active_today": user_row["active_today"] if user_row else 0,
            "new_today": user_row["new_today"] if user_row else 0,
            "dropped_today": user_row["dropped_today"] if user_row else 0,
            "total_all_time": total_row["total"] if total_row else 0,
        }
    except Exception as e:
        log.warning(f"[DailySummary] Users query failed: {e}")

    return summary


async def _send_daily_discord_summary():
    discord_url = os.getenv("DISCORD_WEBHOOK_URL")
    if not discord_url:
        log.debug("[DailySummary] No DISCORD_WEBHOOK_URL set — skipping")
        return

    summary = await _build_daily_summary()
    if not summary:
        return

    s = summary.get("scores", {})
    a = summary.get("affiliate", {})
    corr_count = summary.get("corrections", 0)
    cats = summary.get("top_categories", {})
    u = summary.get("users", {})
    c = summary.get("costs", {})

    total = s.get("total", 0)

    platform_line = f"FBM: {s.get('fbm',0)} · CL: {s.get('cl',0)} · eBay: {s.get('ebay',0)} · OfferUp: {s.get('ou',0)}"
    thumbs_line = f"👍 {s.get('thumbs_up',0)}  ·  👎 {s.get('thumbs_down',0)}"
    risk_line = f"🚨 {s.get('high_risk',0)} high-risk flagged" if s.get("high_risk", 0) > 0 else ""

    aff_lines = []
    if a.get("clicks", 0) > 0:
        aff_lines.append(f"**Overall:** {a['impressions']} imps · {a['clicks']} clicks · {a['ctr']} CTR")
        by_prog = a.get("by_program", {})
        for prog, stats in list(by_prog.items())[:5]:
            if isinstance(stats, dict):
                aff_lines.append(f"  {prog}: {stats['impressions']} imps · {stats['clicks']} clicks · {stats['ctr']} CTR")
            else:
                aff_lines.append(f"  {prog}: {stats} clicks")
        by_pos = a.get("by_position", {})
        if by_pos:
            pos_parts = [f"{k}: {v}" for k, v in by_pos.items()]
            aff_lines.append(f"**Positions:** {' · '.join(pos_parts)}")
    else:
        aff_lines.append("No affiliate clicks today")

    cat_line = " · ".join(f"{c}: {n}" for c, n in cats.items()) if cats else "—"

    active = u.get("active_today", 0)
    new_u = u.get("new_today", 0)
    dropped = u.get("dropped_today", 0)
    total_users = u.get("total_all_time", 0)
    users_line = f"**{active}** active today · **{new_u}** new · **{dropped}** dropped\n**{total_users}** total all-time"

    fields = [
        {"name": "👥 Users", "value": users_line, "inline": False},
        {"name": "📊 Scores", "value": f"**{total}** total  ·  avg **{s.get('avg_score', '—')}**/10\n{platform_line}", "inline": False},
        {"name": "👍 Feedback", "value": thumbs_line, "inline": True},
    ]

    if c:
        limit_emoji = "🟢" if c["limit_pct"] < 70 else ("🟡" if c["limit_pct"] < 90 else "🔴")
        coverage = c.get("tracked_coverage_24h_pct", 0.0)
        title_suffix = "" if coverage >= 99 else f" ({coverage:.0f}% measured)"
        cost_lines = [
            f"**Today:** ${c['cost_today_usd']:.2f}  ·  **MTD:** ${c['cost_mtd_usd']:.2f}",
            f"**Projected month:** ${c['cost_projected_usd']:.2f} / ${c['monthly_limit_usd']:.0f} limit  {limit_emoji} **{c['limit_pct']:.0f}%**",
        ]
        per_score = c.get("per_score_today_usd")
        if per_score is not None:
            cost_lines.append(f"**Avg / score:** ${per_score:.4f}  ·  Claude calls: {c['claude_calls_24h']:,} today · {c['claude_calls_mtd']:,} MTD")
        else:
            cost_lines.append(f"**Claude calls:** ~{c['claude_calls_24h']:,} today  ·  ~{c['claude_calls_mtd']:,} MTD")
        in_tok = c.get("input_tokens_24h", 0)
        out_tok = c.get("output_tokens_24h", 0)
        if in_tok or out_tok:
            cost_lines.append(f"**Tokens today:** {in_tok:,} in · {out_tok:,} out")
        cost_lines.append(f"**Scoring runs:** {c['scores_24h']:,} today  ·  {c['scores_mtd']:,} MTD  ·  {c['scores_30d']:,} last 30d")
        fields.append({"name": f"💰 Cost & Usage{title_suffix}", "value": "\n".join(cost_lines), "inline": False})

    fields.extend([
        {"name": "🔗 Affiliate", "value": "\n".join(aff_lines), "inline": False},
        {"name": "📁 Top Categories", "value": cat_line, "inline": False},
        {"name": "✏️ Corrections", "value": f"{corr_count} new today", "inline": True},
    ])
    if risk_line:
        fields.append({"name": "⚠️ Security", "value": risk_line, "inline": True})

    payload = {
        "embeds": [{
            "title": "📈 Deal Scout — Daily Summary",
            "color": 0x6366f1,
            "fields": fields,
            "footer": {"text": f"Period: last 24 hours · {datetime.utcnow().strftime('%Y-%m-%d %H:%M UTC')} · Daily at 9:00 AM PST"},
        }]
    }

    try:
        import httpx
        async with httpx.AsyncClient() as client:
            r = await client.post(discord_url, json=payload, timeout=10.0)
            if r.status_code < 300:
                log.info(f"[DailySummary] Discord summary posted ({total} scores)")
            else:
                log.warning(f"[DailySummary] Discord responded {r.status_code}: {r.text[:200]}")
    except Exception as e:
        log.warning(f"[DailySummary] Discord post failed: {e}")


async def _daily_summary_scheduler():
    from datetime import timedelta, timezone
    PST = timezone(timedelta(hours=-8))
    TARGET_HOUR = 9
    while True:
        try:
            now_pst = datetime.now(PST)
            target_today = now_pst.replace(hour=TARGET_HOUR, minute=0, second=0, microsecond=0)
            if now_pst >= target_today:
                target = target_today + timedelta(days=1)
            else:
                target = target_today
            wait_seconds = (target - now_pst).total_seconds()
            log.info(f"[DailySummary] Next summary at 9:00 AM PST in {wait_seconds/3600:.1f}h")
            await _asyncio.sleep(wait_seconds)
            await _send_daily_discord_summary()
        except Exception as e:
            log.error(f"[DailySummary] Scheduler error: {e}")
            await _asyncio.sleep(60)


@app.on_event("startup")
async def _ensure_db_tables_at_startup():
    """
    Run table-ensure DDL once at startup so the first user request doesn't
    pay for it (~50-150ms each). The in-request _ensure_*_table() guards are
    kept as defense-in-depth — once the module-level flag is set here, those
    calls early-out for free.
    """
    try:
        await _ensure_affiliate_events_table()
    except Exception as e:
        log.warning(f"[Startup] _ensure_affiliate_events_table failed (non-fatal): {e}")
    try:
        await _ensure_affiliate_flags_table()
    except Exception as e:
        log.warning(f"[Startup] _ensure_affiliate_flags_table failed (non-fatal): {e}")
    try:
        await _ensure_corrections_table()
    except Exception as e:
        log.warning(f"[Startup] _ensure_corrections_table failed (non-fatal): {e}")
    log.info("[Startup] affiliate_events + query_corrections tables ensured")


@app.on_event("startup")
async def _migrate_install_id_column():
    try:
        from scoring.data_pipeline import _get_pool
        pool = await _get_pool()
        if pool:
            await pool.execute(
                "ALTER TABLE deal_scores ADD COLUMN IF NOT EXISTS install_id TEXT DEFAULT NULL"
            )
            await pool.execute(
                "CREATE INDEX IF NOT EXISTS idx_deal_scores_install_id ON deal_scores (install_id)"
            )
            log.info("[Migration] install_id column ensured on deal_scores")
    except Exception as e:
        log.warning(f"[Migration] install_id column migration failed (non-fatal): {e}")


@app.on_event("startup")
async def _start_daily_summary_task():
    if os.getenv("REPLIT_DEPLOYMENT", "") != "1":
        log.info("[DailySummary] Skipping scheduler in dev (only runs in production)")
        return
    _asyncio.create_task(_daily_summary_scheduler())
    log.info("[DailySummary] Background scheduler started")


@app.get("/admin/daily-summary")
async def trigger_daily_summary(request: Request):
    """Manual trigger for the daily Discord summary — useful for testing."""
    _check_admin_auth(request)
    await _send_daily_discord_summary()
    return {"ok": True, "message": "Daily summary sent to Discord (if DISCORD_WEBHOOK_URL is set)"}


_is_production = os.getenv("REPLIT_DEPLOYMENT", "") == "1"
if _is_production:
    _root_app = FastAPI()
    # Reuse the same explicit allowlist the dev `app` middleware uses.
    # Previously this was `allow_origins=["*"]`, which let any origin call
    # the production API — including authenticated endpoints. The allowlist
    # covers the 4 marketplace content-script origins, the dashboard,
    # and the published Chrome extension ID. Override via CORS_ORIGINS env var
    # if a new extension ID or marketplace gets added.
    _root_app.add_middleware(
        CORSMiddleware,
        allow_origins=cors_origins,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["Content-Type", "Authorization", "X-DS-Key", "X-Admin-Token",
                        "X-DS-Ext-Version", "X-DS-Install-Id",
                        "Accept", "Accept-Language", "Content-Language"],
    )
    _root_app.mount("/api/ds", app)

    @_root_app.on_event("startup")
    async def _prod_startup():
        log.info("[Prod] Root app startup — running migrations and scheduler")
        await _migrate_install_id_column()
        # Starlette does not propagate startup events to mounted sub-apps
        # reliably, so the table-ensure registered on `app` may never fire
        # in prod. Re-run it here so the first user request after deploy
        # doesn't pay the DDL roundtrip cost. Both ensure functions are
        # async — they MUST be awaited or the coroutines never run.
        try:
            await _ensure_affiliate_events_table()
        except Exception as _e:
            log.warning(f"[Prod] _ensure_affiliate_events_table failed (non-fatal): {_e}")
        try:
            await _ensure_affiliate_flags_table()
        except Exception as _e:
            log.warning(f"[Prod] _ensure_affiliate_flags_table failed (non-fatal): {_e}")
        try:
            await _ensure_corrections_table()
        except Exception as _e:
            log.warning(f"[Prod] _ensure_corrections_table failed (non-fatal): {_e}")
        log.info("[Prod] affiliate_events + query_corrections tables ensured")
        _asyncio.create_task(_daily_summary_scheduler())
        log.info("[Prod] Daily summary scheduler started (9:00 AM PST)")

    app = _root_app

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "api.main:app",
        host="0.0.0.0",
        port=API_PORT,
        reload=True,
        log_level=os.getenv("LOG_LEVEL", "info").lower(),
    )
