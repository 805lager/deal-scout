"""
Market Value Module — Google Shopping PRIMARY, eBay FALLBACK

PRICING PRIORITY (v0.5.0):
  1. Google Shopping (PRIMARY)
     - No API key required — Playwright scrapes real retail + used prices
     - Broad coverage across retailers, not just eBay sellers
     - Fast with persistent browser (~0.3s after warm-up)
     - Caveat: skews toward NEW retail prices, no completed/sold data
     - Claude is told the source and adjusts confidence accordingly

  2. eBay Finding API (FALLBACK — when Google returns < 3 prices)
     - Best source for SOLD/completed listings (what people actually paid)
     - Rate limit: 5,000 calls/day on free tier
     - Requires EBAY_APP_ID in .env
     - Falls back to mock data if rate limited (error 10001)

  3. eBay Mock Data (LAST RESORT)
     - Keyword-derived price range estimates
     - Confidence is always "low" — Claude will flag this explicitly
     - Better than returning 0 and crashing the scoring pipeline

WHY GOOGLE FIRST:
  During POC, eBay rate-limits after ~50 calls/day in practice.
  Google Shopping is available on every score with no quota.
  eBay stays available as the high-quality fallback when we need
  sold/completed data (better signal for unusual or niche items).

THREE DATA POINTS WE PULL:
  1. sold_avg    — average price of recently COMPLETED sales (ground truth)
  2. active_avg  — average price of current active listings (market pulse)
  3. new_price   — lowest current new condition price (ceiling)

HOW TO GET YOUR EBAY APP ID:
  1. Go to https://developer.ebay.com
  2. Create a free developer account
  3. My Account -> Application Access Keys
  4. Create new app -> select Production
  5. Copy the App ID (Client ID) into .env as EBAY_APP_ID

RUN STANDALONE:
  python scoring/ebay_pricer.py
  (uses the most recent listing from /data as a test)
"""

import asyncio
import json
import logging
import os
import re
import statistics
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Optional

import httpx
from dotenv import load_dotenv

load_dotenv()

logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO"),
    format="%(asctime)s [%(levelname)s] %(message)s"
)
log = logging.getLogger(__name__)

EBAY_APP_ID      = os.getenv("EBAY_APP_ID")
EBAY_FINDING_API = "https://svcs.ebay.com/services/search/FindingService/v1"
DATA_DIR         = Path(__file__).parent.parent / "data"

# In-memory cache: (query, operation) -> (timestamp, results)
# WHY: prevents hammering either Google or eBay on repeated scoring of the
# same item during a session. 10 min TTL keeps prices fresh enough.
import time as _time
_ebay_cache: dict = {}
EBAY_CACHE_TTL_SECONDS = 600  # 10 minutes


# ── Data Models ───────────────────────────────────────────────────────────────

@dataclass
class PricePoint:
    """A single eBay listing price."""
    title: str
    price: float
    condition: str
    url: str
    sold: bool  # True = completed sale, False = active listing


@dataclass
class EbayListingItem:
    """
    A single eBay listing to surface in the sidebar's 'Like Products' section.
    Each item becomes a clickable affiliate card — revenue per click-through to purchase.
    """
    title:         str
    price:         float
    condition:     str
    url:           str   # Direct eBay item URL with affiliate params appended
    sold:          bool  # True = completed sale, False = currently active
    image_url:     str   # Thumbnail from eBay (empty string if unavailable)


@dataclass
class MarketValue:
    """
    Full market value estimate for an item.
    This object gets passed directly to Claude for deal scoring.
    Every field here becomes context the AI uses to justify its score.
    """
    query_used:      str    # What we searched
    sold_avg:        float  # Average of recent completed sales (ground truth)
    sold_low:        float  # Lowest recent sold price
    sold_high:       float  # Highest recent sold price
    sold_count:      int    # How many sold comps we found
    active_avg:      float  # Average of current active listings
    active_low:      float  # Lowest current asking price
    active_count:    int    # How many active listings we found
    new_price:       float  # Lowest new-condition price (0 if not found)
    estimated_value: float  # Our best single-number estimate (weighted avg)
    confidence:      str    # "high" / "medium" / "low" based on data quality
    # Top matching eBay listings — shown as "Like Products" cards in the sidebar
    # Clicking through to buy generates affiliate revenue
    sold_items_sample:   list = None  # top 4 recent sold listings
    active_items_sample: list = None  # top 4 currently active listings
    # Which pricing source produced this data — surfaced in sidebar and used
    # by Claude to calibrate how much to trust the market comps.
    data_source: str = "claude_knowledge"  # "claude_knowledge" | "claude_knowledge" | "ebay" | "ebay_mock" | "correction_range"
    # Gemini AI metadata — only populated when data_source is claude_knowledge/claude_knowledge.
    # item_id: the specific product Gemini identified (e.g. "Celestron NexStar 6SE")
    # ai_notes: Gemini's 1-sentence market context (e.g. "Prices vary by condition")
    # These surface in the sidebar Market Comparison panel beneath the price rows.
    ai_item_id: str = ""
    ai_notes:   str = ""
    # Craigslist asking prices — supplementary comparison, never affects score
    craigslist_avg:   float = 0.0
    craigslist_low:   float = 0.0
    craigslist_high:  float = 0.0
    craigslist_count: int   = 0


# ── Search Query Builder ──────────────────────────────────────────────────────

def build_search_query(title: str) -> str:
    """
    Strip noise from a FBM listing title to build a clean search query.

    WHY THIS MATTERS:
    FBM titles contain fluff ("Awesome!!", location names, emoji) that confuses
    both Google Shopping and eBay search. Cleaning the query dramatically
    improves result quality.

    Example:
      "AMAZING Orion SkyQuest XT8 telescope Poway CA must sell OBO"
      -> "Orion SkyQuest XT8 telescope"
    """
    noise_words = {
        "awesome", "amazing", "great", "nice", "good", "excellent", "perfect",
        "must", "sell", "selling", "sold", "obo", "firm", "negotiable",
        "cheap", "deal", "steal", "price", "reduced", "moving", "sale",
        "used", "new", "like", "condition", "works", "working", "tested",
        "please", "offer", "asking", "willing", "posting",
        # Bundle/lot qualifiers: confuse eBay into returning multi-item bundle
        # pricing instead of per-item pricing. "boys pants bundle lot" pulls
        # adult Wrangler lots at $148 avg instead of kids shorts at $8-12 each.
        # Strip these so we get clean per-item comps for market comparison.
        "bundle", "lot", "lots", "pack", "pcs", "pieces", "set", "sets",
        "items", "listing", "collection",
    }

    cleaned = re.sub(r"[^\w\s]", " ", title)
    words   = [w for w in cleaned.split() if w.lower() not in noise_words]
    query   = " ".join(words[:8])  # Cap at 8 — more hurts search quality
    log.debug(f"Query: '{title}' -> '{query}'")
    return query


# ── Gemini AI Pricer (PRIMARY) ───────────────────────────────────────────────
#
# Replaced Google Shopping scraping (google_pricer.py) with Gemini + Search
# Grounding. Key reasons:
#   1. Google Shopping returns NEW retail prices — we need USED market prices
#   2. HTML scraping breaks whenever Google changes its layout
#   3. Gemini can price niche items (telescopes, e-bikes) that eBay API gets wrong
#
# Architecture:
#   Gemini (Search Grounding) → live Google search → used market price
#   Gemini (Training Knowledge) → fallback if search fails → still better than mock
#   eBay API → runs in parallel → ONLY used for sidebar affiliate cards now

async def _try_gemini_pricing(query: str, condition: str, listing_price: float = 0.0) -> Optional[dict]:
    """
    Attempt Gemini AI pricing. Returns a stats-format dict on success, None on failure.

    Output format matches the old Google Shopping stats dict so the rest of the
    pipeline (confidence, data_source, affiliate cards) needs minimal changes.
    """
    try:
        from scoring.gemini_pricer import get_claude_market_price
        result = await get_claude_market_price(query, condition=condition, listing_price=listing_price)
        if not result or not result.get("avg_used_price"):
            log.info(f"[Gemini PRIMARY] No price returned for '{query}' — falling back to eBay")
            return None

        avg = result["avg_used_price"]

        # Sanity guard: if Gemini's avg is > 4x the listing price, it likely
        # hallucinated a premium product substitution (e.g. returned Celestron
        # NexStar $650 for a Gskyer $150 query). Discard and fall back to eBay.
        # WHY 4x (not 2x): legitimate deals can be 60-70% below market, so
        # a $250 listing with a $650 market value IS plausible for premium items.
        # 4x catches clear substitutions while allowing real deep discounts.
        if listing_price > 20 and avg > listing_price * 4:
            log.warning(
                f"[Gemini PRIMARY] Sanity fail for '{query}': "
                f"avg=${avg:.0f} is {avg/listing_price:.1f}x listing=${listing_price:.0f} "
                f"— likely brand substitution, discarding"
            )
            return None

        # Translate Gemini result into the stats dict format used by the rest of the pipeline
        # WHY TRANSLATE: keeps the downstream code unchanged; only the source changes
        stats = {
            "avg":        avg,
            "low":        result["price_low"],
            "high":       result["price_high"],
            "count":      10 if result["confidence"] == "high" else 5 if result["confidence"] == "medium" else 3,
            "new_retail": result["new_retail"],  # bonus: Gemini knows new retail too
            "confidence": result["confidence"],
            "data_source": result["data_source"],  # "claude_knowledge" | "claude_knowledge"
            "item_id":    result["item_id"],
            "notes":      result["notes"],
        }
        log.info(
            f"[Gemini PRIMARY] '{query}' → avg=${avg:.0f} "
            f"[{result['price_low']:.0f}–{result['price_high']:.0f}] "
            f"conf={result['confidence']} src={result['data_source']}"
        )
        return stats
    except Exception as e:
        log.warning(f"[Gemini PRIMARY] Error for '{query}': {e} — falling back to eBay")
        return None


# ── eBay API (FALLBACK) ───────────────────────────────────────────────────────

async def search_ebay(
    query: str,
    operation: str,
    max_results: int = 20,
    condition_filter: Optional[list] = None,
) -> list[dict]:
    """
    eBay Finding API call — used as fallback when Google Shopping has < 3 results.

    operation options:
      findCompletedItems — sold/ended listings (best for valuation)
      findItemsAdvanced  — currently active listings
    """
    if not EBAY_APP_ID or "your_ebay" in EBAY_APP_ID:
        log.warning("No eBay API key — using mock data. Get your key at developer.ebay.com")
        return _mock_ebay_response(query, operation)

    cache_key = (query.lower().strip(), operation)
    cached = _ebay_cache.get(cache_key)
    if cached and (_time.time() - cached[0]) < EBAY_CACHE_TTL_SECONDS:
        log.info(f"eBay cache hit for '{query}' ({operation})")
        return cached[1]

    params = {
        "OPERATION-NAME":         operation,
        "SERVICE-VERSION":        "1.13.0",
        "SECURITY-APPNAME":       EBAY_APP_ID,
        "RESPONSE-DATA-FORMAT":   "JSON",
        "REST-PAYLOAD":           "",
        "keywords":               query,
        "paginationInput.entriesPerPage": str(max_results),
        "sortOrder":              "BestMatch",
    }

    if operation == "findCompletedItems":
        params["itemFilter(0).name"]  = "SoldItemsOnly"
        params["itemFilter(0).value"] = "true"

    if condition_filter:
        offset = 1 if operation == "findCompletedItems" else 0
        for i, cond_id in enumerate(condition_filter):
            params[f"itemFilter({offset + i}).name"]  = "Condition"
            params[f"itemFilter({offset + i}).value"] = cond_id

    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get(EBAY_FINDING_API, params=params)
            resp.raise_for_status()
            data = resp.json()

        result = data.get(f"{operation}Response", [{}])[0]
        ack = result.get("ack", [""])[0]

        if ack != "Success":
            errors   = result.get("errorMessage", [{}])[0].get("error", [])
            error_ids = [e.get("errorId", ["0"])[0] for e in errors]
            if "10001" in error_ids:
                log.warning(f"eBay rate limited — falling back to mock for '{query}'")
                result = _mock_ebay_response(query, operation)
                for item in result:
                    item["_is_mock"] = True
                return result
            log.warning(f"eBay API non-success ack={ack}")
            return []

        items = result.get("searchResult", [{}])[0].get("item", [])
        log.info(f"[eBay FALLBACK] {operation}: {len(items)} results for '{query}'")
        _ebay_cache[cache_key] = (_time.time(), items)
        return items

    except httpx.HTTPStatusError as e:
        log.error(f"eBay HTTP error {e.response.status_code}")
        if e.response.status_code >= 500:
            result = _mock_ebay_response(query, operation)
            for item in result:
                item["_is_mock"] = True
            return result
        return []
    except Exception as e:
        log.error(f"eBay API error: {e}")
        return []


def parse_ebay_items(items: list[dict], sold: bool) -> list[PricePoint]:
    """Parse raw eBay API response items into PricePoint objects."""
    points = []
    for item in items:
        try:
            selling   = item.get("sellingStatus", [{}])[0]
            price_str = (
                selling.get("convertedCurrentPrice", [{}])[0].get("__value__")
                or selling.get("currentPrice", [{}])[0].get("__value__", "0")
            )
            price = float(price_str)
            if price < 5:
                continue
            points.append(PricePoint(
                title     = item.get("title",  ["Unknown"])[0],
                price     = price,
                condition = item.get("condition", [{}])[0].get("conditionDisplayName", ["Unknown"])[0],
                url       = item.get("viewItemURL", [""])[0],
                sold      = sold,
            ))
        except (KeyError, IndexError, ValueError) as e:
            log.debug(f"Skipping malformed eBay item: {e}")
    return points


# ── Affiliate URL Builder ─────────────────────────────────────────────────────

EBAY_AFFILIATE_PARAMS = (
    "mkevt=1"
    "&mkcid=1"
    "&mkrid=711-53200-19255-0"
    "&campid={campaign_id}"
    "&toolid=10001"
    "&customid=dealscout"
)

def build_item_affiliate_url(item_url: str, campaign_id: str) -> str:
    """
    Append eBay Partner Network params to a direct item URL.
    WHY PER-ITEM (not search page): direct item links convert ~10x better.
    User sees the exact product → clicks → buys → we earn commission.
    """
    if not item_url:
        return ""
    sep = "&" if "?" in item_url else "?"
    return item_url + sep + EBAY_AFFILIATE_PARAMS.format(campaign_id=campaign_id or "0")


# ── Relevance Filtering ───────────────────────────────────────────────────────

def _title_relevance_score(ebay_title: str, search_query: str) -> float:
    """
    Token-overlap similarity between an eBay result title and our search query.

    WHY THIS EXISTS:
    eBay's BestMatch returns results that match the query keywords individually
    but may not be the same product. A search for "Ryobi 40V chainsaw 10 inch"
    can return Ryobi batteries, Ryobi drills, generic chains, etc.

    We score each result by what fraction of the search query's meaningful tokens
    appear in the eBay title. Tokens under 2 chars and generic stop-words are
    excluded so "the", "in", "a" don't inflate the score.

    Threshold guidance:
      >= 0.50  Strong match — same product, possibly different variant
      >= 0.35  Reasonable match — probably same category/brand
      <  0.35  Likely mismatch — filter out

    Returns 0.0-1.0.
    """
    STOP = {
        "the", "a", "an", "in", "on", "of", "for", "to", "and", "or",
        "is", "it", "with", "this", "that", "new", "used", "like",
        "good", "great", "nice", "set", "lot", "item", "oem", "obo",
    }

    def tokenize(text: str) -> set:
        tokens = re.sub(r"[^\w\s]", " ", text.lower()).split()
        return {t for t in tokens if len(t) > 2 and t not in STOP}

    query_tokens = tokenize(search_query)
    if not query_tokens:
        return 1.0  # nothing to filter against — let it through

    title_tokens = tokenize(ebay_title)
    if not title_tokens:
        return 0.0

    # Jaccard-style: intersect / query (not union — we care about query coverage)
    overlap = query_tokens & title_tokens
    score   = len(overlap) / len(query_tokens)

    # Bonus: if model number tokens (all-digit or alphanumeric) match, boost score
    # WHY: "40V" or "XT8" appearing in both is a very strong signal of same product
    model_tokens = {t for t in query_tokens if re.search(r"\d", t)}
    if model_tokens and model_tokens.issubset(title_tokens):
        score = min(1.0, score + 0.25)

    return score


def _filter_by_relevance(
    items: list[dict],
    search_query: str,
    threshold: float = 0.35,
    max_items: int = 4,
) -> list[dict]:
    """
    Filter raw eBay API items by title relevance to the search query.
    Returns up to max_items items that score above threshold.

    WHY FILTER BEFORE PARSING (not after):
    Scoring is done on raw title strings — cheaper than fully parsing each item.
    We preserve the raw dict so parse_ebay_items_with_images() can still do
    all its normal image/url/condition extraction on the filtered set.
    """
    scored = []
    for item in items:
        title = item.get("title", [""])[0] if isinstance(item.get("title"), list) else ""
        if not title:
            continue
        score = _title_relevance_score(title, search_query)
        log.debug(f"  relevance {score:.2f}: {title[:60]}")
        if score >= threshold:
            scored.append((score, item))

    # Sort by relevance DESC so highest matches surface first
    scored.sort(key=lambda x: x[0], reverse=True)
    return [item for _, item in scored[:max_items]]


def parse_ebay_items_with_images(
    items: list[dict],
    sold: bool,
    campaign_id: str,
    max_items: int = 4,
    search_query: str = "",  # used for relevance filtering — pass product_info.search_query
) -> list[EbayListingItem]:
    """
    Parse eBay items into sidebar-ready EbayListingItem objects with affiliate URLs.

    WHY search_query param:
    Without it we return the first N results eBay gives us, which are often
    mismatched (same brand, wrong product). With it we filter to only items
    whose title meaningfully overlaps with what we actually searched for.
    Falls back to no filtering when search_query is empty.
    """
    # Apply relevance filter first — removes mismatched items before we parse
    filtered = _filter_by_relevance(items, search_query, threshold=0.35, max_items=max_items * 2) \
               if search_query else items

    if search_query and len(filtered) < len(items):
        log.info(f"[eBay relevance] {len(filtered)}/{len(items)} items passed filter for '{search_query}'")

    result = []
    for item in filtered:
        try:
            selling   = item.get("sellingStatus", [{}])[0]
            price_str = (
                selling.get("convertedCurrentPrice", [{}])[0].get("__value__")
                or selling.get("currentPrice", [{}])[0].get("__value__", "0")
            )
            price = float(price_str)
            if price < 5:
                continue

            raw_url   = item.get("viewItemURL", [""])[0]
            title     = item.get("title", ["Unknown"])[0]
            condition = item.get("condition", [{}])[0].get("conditionDisplayName", ["Used"])[0]

            gallery   = item.get("galleryInfoContainer", [{}])[0]
            image_url = (
                gallery.get("hostedImgUrl", [""])[0]
                or item.get("galleryURL", [""])[0]
                or ""
            )

            result.append(EbayListingItem(
                title     = title[:80],
                price     = round(price, 2),
                condition = condition,
                url       = build_item_affiliate_url(raw_url, campaign_id),
                sold      = sold,
                image_url = image_url,
            ))
            if len(result) >= max_items:
                break
        except (KeyError, IndexError, ValueError) as e:
            log.debug(f"Skipping item in sample parse: {e}")

    return result


# ── Main Entry Point ──────────────────────────────────────────────────────────

async def get_market_value(listing_title: str, listing_condition: str = "Used", is_vehicle: bool = False, listing_price: float = 0.0) -> MarketValue:
    """
    Main entry point. Given a listing title, return a full MarketValue estimate.

    FLOW (v0.5.0 — Google first):
      1. Try Google Shopping → fast, no quota
      2. If Google < 3 results → try eBay (sold + active + new-only in parallel)
      3. If eBay rate-limited → eBay mock data
      4. If both available → use Google for pricing, eBay items for sidebar cards

    WHY BOTH IN STEP 4:
      Google gives us better price signal (broader market).
      eBay gives us clickable affiliate cards for "Like Products" sidebar section.
      Running eBay in parallel means we get both with no extra latency.
    """
    query       = build_search_query(listing_title)
    campaign_id = os.getenv("EBAY_CAMPAIGN_ID", "")

    # Check manual corrections — may fix the query AND/OR provide a locked
    # price range to use when live data fails (mock fallback override).
    # See scoring/corrections.py for the full format.
    _locked_price_low  = 0.0
    _locked_price_high = 0.0
    try:
        from scoring.corrections import lookup_correction
        _corr = lookup_correction(listing_title, query)
        if _corr:
            if _corr["good_query"] and _corr["good_query"] != query:
                log.info(f"[Corrections] Query override: '{query}' → '{_corr['good_query']}'"
                )
                query = _corr["good_query"]
            _locked_price_low  = _corr.get("price_low",  0.0)
            _locked_price_high = _corr.get("price_high", 0.0)
            if _locked_price_low and _locked_price_high:
                log.info(
                    f"[Corrections] Locked price range: "
                    f"${_locked_price_low}–${_locked_price_high}"
                )
    except Exception as e:
        log.debug(f"[Corrections] Lookup skipped: {e}")

    log.info(f"Fetching market value for: '{listing_title}' → query: '{query}'")

    # ── Vehicle pricing — CarGurus/Craigslist instead of eBay ────────────────
    # WHY: eBay returns parts prices for vehicle searches (spark plugs not cars).
    # vehicle_pricer.py scrapes CarGurus for real comps by year/make/model/zip,
    # falls back to Craigslist if CarGurus returns < 3 results, and falls back
    # to the stub below if scraping fails entirely — never blocks the pipeline.
    if is_vehicle:
        try:
            from scoring.vehicle_pricer import get_vehicle_market_value
            vdata = await get_vehicle_market_value(
                listing_title = listing_title,
                zip_code      = "92101",  # TODO: pass real zip from listing.location
            )
            if vdata:
                return MarketValue(
                    query_used      = vdata["query_used"],
                    sold_avg        = vdata["sold_avg"],
                    sold_low        = vdata["sold_low"],
                    sold_high       = vdata["sold_high"],
                    sold_count      = vdata["sold_count"],
                    active_avg      = vdata["active_avg"],
                    active_low      = vdata["active_low"],
                    active_count    = vdata["active_count"],
                    new_price       = 0.0,
                    estimated_value = vdata["estimated_value"],
                    confidence      = vdata["confidence"],
                    data_source     = vdata["data_source"],  # "cargurus" | "craigslist"
                )
        except Exception as e:
            log.warning(f"[Vehicle] vehicle_pricer failed: {e} — using stub")

        # Stub fallback — pipeline never breaks even if scraping is down
        log.info("[Vehicle] vehicle_not_applicable stub")
        return MarketValue(
            query_used=query,
            sold_avg=0.0, sold_low=0.0, sold_high=0.0, sold_count=0,
            active_avg=0.0, active_low=0.0, active_count=0,
            new_price=0.0, estimated_value=0.0,
            confidence="none", data_source="vehicle_not_applicable",
        )

    # ── Step 1: Try Gemini AI pricing first ─────────────────────────────────────
    # Gemini uses Google Search grounding to find actual USED selling prices.
    # Falls back to its training knowledge if grounding fails.
    # See scoring/gemini_pricer.py for full details.
    gemini_stats = await _try_gemini_pricing(query, condition=listing_condition, listing_price=listing_price)
    # Capture Gemini metadata before it goes out of scope — MarketValue will carry it
    # to the API response and eventually to the sidebar for display.
    _gemini_ai_item_id = gemini_stats.get("item_id", "") if gemini_stats else ""
    _gemini_ai_notes   = gemini_stats.get("notes",   "") if gemini_stats else ""

    # ── Step 2: Always fetch eBay + Craigslist in parallel ───────────────────
    # WHY ALWAYS: Even when Gemini succeeds, we want eBay listing cards for
    # the "Like Products" sidebar section. Running them in parallel means
    # zero extra latency. eBay is now ONLY used for affiliate cards + price fallback.
    # Craigslist runs concurrently — it's purely informational and never blocks.
    from scoring.craigslist_pricer import get_craigslist_asking_prices
    sold_raw, active_raw, new_raw, _cl_result = await asyncio.gather(
        search_ebay(query, "findCompletedItems", max_results=20),
        search_ebay(query, "findItemsAdvanced",  max_results=20),
        search_ebay(query, "findItemsAdvanced",  max_results=10, condition_filter=["1000"]),
        _safe_craigslist(query),
    )

    ebay_is_mock = any(item.get("_is_mock") for item in sold_raw + active_raw)
    sold_items   = parse_ebay_items(sold_raw,   sold=True)
    active_items = parse_ebay_items(active_raw, sold=False)
    new_items    = parse_ebay_items(new_raw,    sold=False)

    # ── Step 3: Build market stats from whichever source won ──────────────────
    if gemini_stats:
        # Gemini is primary — it returns USED market prices, not retail
        sold_avg        = gemini_stats["avg"]
        sold_low        = gemini_stats["low"]
        sold_high       = gemini_stats["high"]
        sold_count      = gemini_stats["count"]
        # Use eBay active data for the asking-price column if we have it
        if active_items and not ebay_is_mock:
            active_prices = [p.price for p in active_items]
            active_avg    = statistics.mean(active_prices)
            active_low    = min(active_prices)
            active_count  = len(active_items)
        else:
            active_avg   = round(gemini_stats["avg"] * 1.05, 2)
            active_low   = gemini_stats["low"]
            active_count = 0

        # Gemini knows new retail too — use it if eBay new-condition data is missing
        new_price       = min(p.price for p in new_items) if new_items else gemini_stats.get("new_retail", 0.0)
        estimated_value = gemini_stats["avg"]
        confidence      = gemini_stats["confidence"]
        data_source     = gemini_stats["data_source"]  # "claude_knowledge" | "claude_knowledge"

    else:
        # eBay fallback — use its data directly
        sold_prices  = [p.price for p in sold_items]
        sold_avg     = statistics.mean(sold_prices) if sold_prices else 0.0
        sold_low     = min(sold_prices)             if sold_prices else 0.0
        sold_high    = max(sold_prices)             if sold_prices else 0.0
        sold_count   = len(sold_items)

        active_prices = [p.price for p in active_items]
        active_avg    = statistics.mean(active_prices) if active_prices else 0.0
        active_low    = min(active_prices)             if active_prices else 0.0
        active_count  = len(active_items)

        new_price = min(p.price for p in new_items) if new_items else 0.0

        # Sold data weighted 2x — sold = reality, active = wishful thinking
        if sold_avg > 0 and active_avg > 0:
            estimated_value = (sold_avg * 2 + active_avg) / 3
        elif sold_avg > 0:
            estimated_value = sold_avg
        elif active_avg > 0:
            estimated_value = active_avg * 0.85
        else:
            estimated_value = 0.0

        if len(sold_items) >= 10 and not ebay_is_mock:
            confidence = "high"
        elif len(sold_items) >= 3 and not ebay_is_mock:
            confidence = "medium"
        else:
            confidence = "low"

        data_source = "ebay_mock" if ebay_is_mock else "ebay"

    # ── Locked price range override (when mock fired) ───────────────────────────
    # WHY data_source == "ebay_mock" (not just ebay_is_mock):
    #   ebay_is_mock is True whenever eBay sidebar cards are mock — including
    #   the case where Google Shopping SUCCEEDED but eBay failed. In that case
    #   data_source = "google_shopping" and we have real Google pricing.
    #   We must not clobber that with the locked range. Only override when the
    #   pricing source itself is mock (i.e. both Google AND eBay failed).
    if data_source == "ebay_mock" and _locked_price_low > 0 and _locked_price_high > _locked_price_low:
        locked_mid      = (_locked_price_low + _locked_price_high) / 2
        sold_avg        = locked_mid
        sold_low        = _locked_price_low
        sold_high       = _locked_price_high
        active_avg      = locked_mid * 1.05
        active_low      = _locked_price_low
        active_count    = 0   # not real eBay data — avoid showing misleading count
        sold_count      = 0   # not real sold comps — sidebar will show "correction range"
        estimated_value = locked_mid
        confidence      = "medium"   # better than mock, but still not live data
        data_source     = "correction_range"
        log.info(
            f"[Corrections] Using locked price range ${_locked_price_low}–"
            f"${_locked_price_high} (mid=${locked_mid:.0f}) instead of mock"
        )

    # ── Suspect flag: mock data + price far outside mock range ────────────────
    # Only fires when: (a) both live sources failed, AND (b) no locked range.
    if data_source == "ebay_mock" and estimated_value > 0:
        ratio = listing_price / estimated_value if listing_price > 0 else 1.0
        if ratio > 3.0 or ratio < 0.3:
            confidence = "suspect"
            log.warning(
                f"[Market] Suspect comps: listing=${listing_price:.0f} vs "
                f"mock_est=${estimated_value:.0f} (ratio={ratio:.1f}x) — "
                f"query='{query}' likely returned wrong category"
            )

    # ── Step 4: Build sidebar affiliate cards from eBay items ─────────────────
    # WHY pass search_query: filters out mismatched results (e.g. "Ryobi battery"
    # appearing in results for "Ryobi 40V chainsaw") before building sidebar cards.
    sold_items_sample   = parse_ebay_items_with_images(sold_raw,   sold=True,  campaign_id=campaign_id, max_items=4, search_query=query)
    active_items_sample = parse_ebay_items_with_images(active_raw, sold=False, campaign_id=campaign_id, max_items=4, search_query=query)

    return MarketValue(
        query_used           = query,
        sold_avg             = round(sold_avg,        2),
        sold_low             = round(sold_low,         2),
        sold_high            = round(sold_high,        2),
        sold_count           = sold_count,
        active_avg           = round(active_avg,       2),
        active_low           = round(active_low,       2),
        active_count         = active_count,
        new_price            = round(new_price,        2),
        estimated_value      = round(estimated_value,  2),
        confidence           = confidence,
        sold_items_sample    = sold_items_sample,
        active_items_sample  = active_items_sample,
        data_source          = data_source,
        ai_item_id           = _gemini_ai_item_id,
        ai_notes             = _gemini_ai_notes,
    )


# ── Mock Data ─────────────────────────────────────────────────────────────────

def _mock_ebay_response(query: str, operation: str) -> list[dict]:
    """
    Returns plausible mock eBay data scaled to the item's likely price range.
    Used as last resort when both Google and eBay are unavailable.
    Confidence is always "low" — Claude will note this in its analysis.
    """
    q = query.lower()

    # Phone sub-tiers: modern flagships sell for much more than older/budget models
    # iPhone 15 Pro / 14 Pro / 13 Pro = $600-900 used; base iPhone = $250-400
    if any(w in q for w in ["iphone 15 pro", "iphone 14 pro", "iphone 13 pro", "iphone 15 plus", "iphone 15 max"]):
        base = 700
    elif any(w in q for w in ["iphone 15", "iphone 14", "galaxy s24", "galaxy s23", "pixel 8", "pixel 7"]):
        base = 500
    elif any(w in q for w in ["iphone", "samsung galaxy", "pixel"]):
        base = 350
    elif any(w in q for w in ["ipad", "tablet"]):
        base = 300
    elif any(w in q for w in ["macbook", "laptop", "notebook"]):
        base = 600
    elif any(w in q for w in ["ps5", "xbox", "playstation", "nintendo switch"]):
        base = 350
    elif any(w in q for w in ["surron", "sur-ron", "talaria", "super73", "super 73", "light bee", "storm bee", "ultra bee", "x160", "x260"]):
        base = 3000
    elif any(w in q for w in ["electric bike", "electric dirt bike", "electric moto", "ebike", "e-bike"]):
        base = 2000
    elif any(w in q for w in ["bike", "bicycle", "scooter", "moped"]):
        base = 900
    elif any(w in q for w in ["car", "truck", "suv", "van", "vehicle"]):
        base = 8000
    elif any(w in q for w in ["camera", "lens", "dslr", "mirrorless"]):
        base = 500
    elif any(w in q for w in ["guitar", "piano", "keyboard", "drums"]):
        base = 400
    elif any(w in q for w in ["sofa", "couch", "desk", "chair", "table", "furniture"]):
        base = 250
    # Optics / astronomy — NexStar 6SE ~$800, 8SE ~$1100, small refractors ~$200
    # Without this, all telescopes fall to $150 base which is wildly wrong
    elif any(w in q for w in ["nexstar 8", "nexstar 9", "nexstar 11", "celestron 8", "orion xt8", "orion xt10"]):
        base = 900
    elif any(w in q for w in ["telescope", "nexstar", "celestron", "orion skyquest", "meade", "dobsonian", "reflector", "refractor", "schmidt"]):
        base = 650
    elif any(w in q for w in ["binoculars", "spotting scope", "rangefinder"]):
        base = 200
    # Power tools
    elif any(w in q for w in ["dewalt", "milwaukee", "makita", "ryobi", "bosch"]):
        base = 200
    elif any(w in q for w in ["drill", "saw", "sander", "grinder", "compressor"]):
        base = 150
    # Fitness
    elif any(w in q for w in ["peloton", "treadmill", "elliptical", "rowing machine"]):
        base = 800
    elif any(w in q for w in ["weights", "dumbbells", "barbell", "kettlebell"]):
        base = 100
    else:
        base = 150

    import random
    random.seed(hash(query) % 10000)
    spread = 0.25
    sold_prices   = [int(base * random.uniform(1 - spread, 1 + spread)) for _ in range(10)]
    active_prices = [int(base * random.uniform(1.0, 1 + spread * 1.5)) for _ in range(10)]
    prices = sold_prices if operation == "findCompletedItems" else active_prices

    items = []
    for i, price in enumerate(prices):
        is_new      = (operation == "findItemsAdvanced" and i == 0)
        mock_item_id = abs(hash(f"{query}{i}{operation}")) % 999999999
        items.append({
            "title":         [f"{query[:40]} {'New' if is_new else 'Used'} (estimated comp)"],
            "sellingStatus": [{"convertedCurrentPrice": [{"__value__": str(price)}]}],
            "condition":     [{"conditionDisplayName":  ["New" if is_new else "Used"]}],
            "viewItemURL":   [f"https://www.ebay.com/sch/i.html?_nkw={query.replace(' ', '+')}&LH_Sold={'1' if operation == 'findCompletedItems' else '0'}&LH_Complete={'1' if operation == 'findCompletedItems' else '0'}&_udlo={int(price*0.7)}&_udhi={int(price*1.3)}&_sop=12"],
            "galleryURL":    [""],
        })
    return items


# ── Output Helpers ────────────────────────────────────────────────────────────

def print_market_report(mv: MarketValue, listing_price: float):
    """Print a clean market value report to the console."""
    diff  = listing_price - mv.estimated_value
    pct   = (diff / mv.estimated_value * 100) if mv.estimated_value > 0 else 0
    emoji = "🔴" if diff > 0 else "🟢"
    label = "OVERPRICED" if diff > 0 else "GOOD DEAL"

    print("\n" + "="*60)
    print("  MARKET VALUE REPORT")
    print("="*60)
    print(f"  Source:          {mv.data_source.upper()}")
    print(f"  Search query:    '{mv.query_used}'")
    print(f"  Confidence:      {mv.confidence.upper()} ({mv.sold_count} comps)")
    print()
    print(f"  Price avg:       ${mv.sold_avg:.2f}  (range: ${mv.sold_low:.2f} - ${mv.sold_high:.2f})")
    print(f"  Active ask avg:  ${mv.active_avg:.2f}  (lowest: ${mv.active_low:.2f})")
    if mv.new_price:
        print(f"  New retail:      ${mv.new_price:.2f}")
    print()
    print(f"  Estimated value: ${mv.estimated_value:.2f}")
    print(f"  Listing price:   ${listing_price:.2f}")
    print()
    print(f"  {emoji}  {label} by ${abs(diff):.2f} ({abs(pct):.1f}%)")
    print("="*60)


def save_market_value(mv: MarketValue, listing_title: str) -> Path:
    """Save market value to /data — consumed by Claude scoring."""
    safe  = "".join(c for c in listing_title if c.isalnum() or c in " _-")[:40]
    fpath = DATA_DIR / f"market_value_{safe.strip().replace(' ', '_')}.json"
    fpath.write_text(json.dumps(asdict(mv), indent=2))
    log.info(f"Saved: {fpath}")
    return fpath


# ── Standalone Entry Point ────────────────────────────────────────────────────

async def main():
    """
    Test the market pricer against the most recently scraped listing in /data.
    """
    listing_files = list(DATA_DIR.glob("listing_*.json"))
    if not listing_files:
        log.error("No listing files in /data — run the scraper first")
        return

    listing_file = max(listing_files, key=lambda f: f.stat().st_mtime)
    log.info(f"Using listing: {listing_file.name}")
    listing = json.loads(listing_file.read_text())

    print(f"\n  Listing:   {listing['title']}")
    print(f"  FBM Price: ${listing['price']:.2f}")
    print(f"  Condition: {listing.get('condition', 'Unknown')}")
    print(f"  Location:  {listing.get('location', 'Unknown')}")

    mv = await get_market_value(
        listing_title     = listing["title"],
        listing_condition = listing.get("condition", "Used"),
    )

    print_market_report(mv, listing["price"])
    output = save_market_value(mv, listing["title"])
    print(f"\n  Data saved to: {output}")
    print(f"  Data source: {mv.data_source}")


if __name__ == "__main__":
    asyncio.run(main())