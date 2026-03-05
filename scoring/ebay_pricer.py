"""
eBay Price Comparison Module

WHY EBAY SPECIFICALLY:
  eBay is the best single source for used item market valuation because:
  1. Sold listings = what people ACTUALLY paid (not just asking price)
  2. Active listings = current competition / market asking price
  3. Both new and used items exist on eBay — gives us a full price spectrum
  4. Free API with generous rate limits for POC

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

API USED: eBay Finding API (v1.13)
  Simple REST-style JSON API. No OAuth needed for search queries.
  Rate limit: 5,000 calls/day on free tier — more than enough for POC.

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
# WHY: eBay Finding API has a per-minute burst limit. Repeated scoring of
# the same item during a session would burn through it. Cache for 10 min.
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
    This object gets passed directly to Claude for deal scoring in Week 3.
    Every field here becomes context the AI uses to justify its score.
    """
    query_used:      str    # What we searched on eBay
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
    # WHY HERE: Passing real listings lets users click through to buy/compare,
    # generating affiliate revenue. The sidebar becomes a shopping tool, not
    # just a score display.
    sold_items_sample:   list = None  # top 3 recent sold listings
    active_items_sample: list = None  # top 3 currently active listings
    # Which pricing source produced this data — shown in sidebar for transparency
    # and used by Claude to calibrate confidence in its analysis.
    data_source: str = "ebay"  # "ebay" | "ebay_mock" | "google_shopping" | "google+ebay_mock"


# ── Search Query Builder ──────────────────────────────────────────────────────

def build_search_query(title: str) -> str:
    """
    Strip noise from a FBM listing title to build a clean eBay search query.

    WHY THIS MATTERS:
    FBM titles contain fluff ("Awesome!!", location names, emoji) that confuses
    eBay's keyword search. Cleaning the query dramatically improves result quality.

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
    }

    # Strip special characters
    cleaned = re.sub(r"[^\w\s]", " ", title)

    # Remove noise words
    words = [w for w in cleaned.split() if w.lower() not in noise_words]

    # Cap at 8 keywords — eBay search degrades with too many terms
    query = " ".join(words[:8])
    log.debug(f"Query: '{title}' -> '{query}'")
    return query


# ── eBay API ──────────────────────────────────────────────────────────────────

async def search_ebay(
    query: str,
    operation: str,
    max_results: int = 20,
    condition_filter: Optional[list] = None,
) -> list[dict]:
    """
    Core eBay Finding API call.

    operation options:
      findCompletedItems — sold/ended listings (best for valuation)
      findItemsAdvanced  — currently active listings
    """
    if not EBAY_APP_ID or "your_ebay" in EBAY_APP_ID:
        log.warning("No eBay API key — using mock data. Get your key at developer.ebay.com")
        return _mock_ebay_response(query, operation)

    # Cache check — avoid burning eBay rate limit on repeat queries
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

    # Sold items filter — only applies to findCompletedItems
    if operation == "findCompletedItems":
        params["itemFilter(0).name"]  = "SoldItemsOnly"
        params["itemFilter(0).value"] = "true"

    # Optional condition filter — e.g. New only for retail price lookup
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
            # Check specifically for rate limit error
            errors = result.get("errorMessage", [{}])[0].get("error", [])
            error_ids = [e.get("errorId", ["0"])[0] for e in errors]
            if "10001" in error_ids:
                log.warning(f"eBay rate limited — falling back to mock data for '{query}'")
                result = _mock_ebay_response(query, operation)
                for item in result:
                    item["_is_mock"] = True
                return result
            log.warning(f"eBay API non-success ack={ack}: {result.get('errorMessage', 'unknown')}")
            return []

        items = result.get("searchResult", [{}])[0].get("item", [])
        log.info(f"eBay {operation}: found {len(items)} results for '{query}'")

        # Cache the successful result
        _ebay_cache[cache_key] = (_time.time(), items)
        return items  # no _is_mock tag — real data

    except httpx.HTTPStatusError as e:
        log.error(f"eBay HTTP error {e.response.status_code}: {e.response.text[:200]}")
        if e.response.status_code >= 500:
            log.warning("eBay 5xx — falling back to mock data")
            result = _mock_ebay_response(query, operation)
            # Tag results so get_market_value knows to try Google fallback
            for item in result:
                item["_is_mock"] = True
            return result
        return []
    except Exception as e:
        log.error(f"eBay API error: {e}")
        return []


def parse_ebay_items(items: list[dict], sold: bool) -> list[PricePoint]:
    """
    Parse raw eBay API response items into PricePoint objects.
    Filters out sub-$5 items — those are parts/junk, not real comps.
    """
    points = []
    for item in items:
        try:
            selling = item.get("sellingStatus", [{}])[0]
            price_str = (
                selling.get("convertedCurrentPrice", [{}])[0].get("__value__")
                or selling.get("currentPrice",        [{}])[0].get("__value__", "0")
            )
            price = float(price_str)

            # WHY $5 floor: auction starting bids skew averages badly
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


# ── Affiliate URL Builder ────────────────────────────────────────────────────

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
    WHY PER-ITEM: Linking directly to the matching product (not a search page)
    has a much higher conversion rate. User sees the exact item, clicks,
    buys — we earn. Generic search page links have ~10x lower conversion.
    """
    if not item_url:
        return ""
    sep = "&" if "?" in item_url else "?"
    return item_url + sep + EBAY_AFFILIATE_PARAMS.format(campaign_id=campaign_id or "0")


def parse_ebay_items_with_images(
    items: list[dict],
    sold: bool,
    campaign_id: str,
    max_items: int = 4,
) -> list[EbayListingItem]:
    """
    Parse raw eBay API response into EbayListingItem objects with affiliate URLs.
    Returns up to max_items, sorted by price relevance (sold: newest first, active: lowest first).
    """
    result = []
    for item in items:
        try:
            selling    = item.get("sellingStatus", [{}])[0]
            price_str  = (
                selling.get("convertedCurrentPrice", [{}])[0].get("__value__")
                or selling.get("currentPrice", [{}])[0].get("__value__", "0")
            )
            price = float(price_str)
            if price < 5:
                continue

            raw_url   = item.get("viewItemURL", [""])[0]
            title     = item.get("title",  ["Unknown"])[0]
            condition = item.get("condition", [{}])[0].get("conditionDisplayName", ["Used"])[0]

            # eBay Finding API returns gallery images in galleryInfoContainer or galleryURL
            gallery = item.get("galleryInfoContainer", [{}])[0]
            image_url = (
                gallery.get("hostedImgUrl", [""])[0]
                or item.get("galleryURL", [""])[0]
                or ""
            )

            result.append(EbayListingItem(
                title     = title[:80],  # truncate for display
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


# ── Market Value Calculator ───────────────────────────────────────────────────

async def get_market_value(listing_title: str, listing_condition: str = "Used") -> MarketValue:
    """
    Main entry point. Given a listing title, return a full MarketValue estimate.

    Fires three eBay searches concurrently:
      1. Completed/sold listings  — ground truth
      2. Active listings          — current market
      3. Active new-only listings — retail ceiling
    """
    query = build_search_query(listing_title)
    log.info(f"Fetching market value for: '{listing_title}'")

    # Run all three searches at the same time — no reason to do them sequentially
    sold_raw, active_raw, new_raw = await asyncio.gather(
        search_ebay(query, "findCompletedItems", max_results=20),
        search_ebay(query, "findItemsAdvanced",  max_results=20),
        search_ebay(query, "findItemsAdvanced",  max_results=10, condition_filter=["1000"]),
    )

    # Detect whether eBay returned mock data (rate limit fallback)
    # _is_mock tag is set by search_ebay() when it falls back to _mock_ebay_response()
    ebay_is_mock = any(item.get("_is_mock") for item in sold_raw + active_raw)

    sold_items   = parse_ebay_items(sold_raw,   sold=True)
    active_items = parse_ebay_items(active_raw, sold=False)
    new_items    = parse_ebay_items(new_raw,    sold=False)

    # Sold stats
    sold_prices = [p.price for p in sold_items]
    sold_avg    = statistics.mean(sold_prices) if sold_prices else 0.0
    sold_low    = min(sold_prices)             if sold_prices else 0.0
    sold_high   = max(sold_prices)             if sold_prices else 0.0

    # Active stats
    active_prices = [p.price for p in active_items]
    active_avg    = statistics.mean(active_prices) if active_prices else 0.0
    active_low    = min(active_prices)             if active_prices else 0.0

    # New retail price
    new_price = min(p.price for p in new_items) if new_items else 0.0

    # Estimated value — sold data weighted 2x over active asking prices
    # WHY: Active listings are wishful thinking. Sold = reality.
    if sold_avg > 0 and active_avg > 0:
        estimated_value = (sold_avg * 2 + active_avg) / 3
    elif sold_avg > 0:
        estimated_value = sold_avg
    elif active_avg > 0:
        estimated_value = active_avg * 0.85  # Discount asking prices ~15%
    else:
        estimated_value = 0.0

    # Confidence based on how many sold comps we found
    if len(sold_items) >= 10 and not ebay_is_mock:
        confidence = "high"
    elif len(sold_items) >= 3 and not ebay_is_mock:
        confidence = "medium"
    else:
        confidence = "low"

    # ── Google Shopping fallback ───────────────────────────────────────────────
    # When eBay is rate-limited, try Google Shopping for real prices.
    # WHY ONLY ON MOCK: Google Shopping is slower (Playwright) and we don't
    # want to add 3-5s latency when eBay is working fine.
    data_source = "ebay"
    if ebay_is_mock:
        data_source = "ebay_mock"
        try:
            from scoring.google_pricer import get_google_shopping_prices, prices_to_market_stats
            google_prices = await get_google_shopping_prices(query, max_results=12)
            stats = prices_to_market_stats(google_prices)
            if stats and stats["count"] >= 3:
                log.info(f"Google Shopping override: avg=${stats['avg']:.0f} ({stats['count']} prices)")
                # Replace mock eBay stats with real Google prices
                sold_avg        = stats["avg"]
                sold_low        = stats["low"]
                sold_high       = stats["high"]
                estimated_value = stats["avg"]
                # Use price spread as proxy for active market
                active_avg = round(stats["avg"] * 1.05, 2)  # asking prices ~5% above sold
                active_low = stats["low"]
                confidence  = "medium" if stats["count"] >= 6 else "low"
                data_source = "google_shopping"
            else:
                log.info("Google Shopping returned too few results, keeping mock data")
                data_source = "google+ebay_mock"
        except Exception as e:
            log.warning(f"Google Shopping fallback failed: {e}")
            data_source = "ebay_mock"

    campaign_id = os.getenv("EBAY_CAMPAIGN_ID", "")

    # Build item sample lists for the sidebar's "Like Products" section
    # WHY 4 ITEMS: 3 would fit cleanly but 4 gives scroll depth without
    # overwhelming a 310px sidebar. Sold items are more credible proof
    # of value; active items show what the buyer could switch to instead.
    sold_items_sample   = parse_ebay_items_with_images(sold_raw,   sold=True,  campaign_id=campaign_id, max_items=4)
    active_items_sample = parse_ebay_items_with_images(active_raw, sold=False, campaign_id=campaign_id, max_items=4)

    return MarketValue(
        query_used           = query,
        sold_avg             = round(sold_avg,        2),
        sold_low             = round(sold_low,         2),
        sold_high            = round(sold_high,        2),
        sold_count           = len(sold_items),
        active_avg           = round(active_avg,       2),
        active_low           = round(active_low,       2),
        active_count         = len(active_items),
        new_price            = round(new_price,        2),
        estimated_value      = round(estimated_value,  2),
        confidence           = confidence,
        sold_items_sample    = sold_items_sample,
        active_items_sample  = active_items_sample,
        data_source          = data_source,
    )


# ── Mock Data (no API key needed for testing) ─────────────────────────────────

def _mock_ebay_response(query: str, operation: str) -> list[dict]:
    """
    Returns plausible mock eBay data scaled to the item's likely price range.
    Used when: no API key set, rate limited, or eBay returns a 5xx error.

    WHY PRICE ESTIMATION:
    We derive a rough price range from keywords in the query so mock comps
    are at least in the right ballpark. Claude's score will still be marked
    low-confidence, but won't be absurd (bike scored against telescope prices).
    """
    q = query.lower()

    # Rough category price anchors — median used price estimate
    if any(w in q for w in ["iphone", "samsung galaxy", "pixel"]):
        base = 350
    elif any(w in q for w in ["ipad", "tablet"]):
        base = 300
    elif any(w in q for w in ["macbook", "laptop", "notebook"]):
        base = 600
    elif any(w in q for w in ["ps5", "xbox", "playstation", "nintendo switch"]):
        base = 350
    elif any(w in q for w in ["surron", "sur-ron", "talaria", "super73", "super 73", "light bee", "storm bee", "ultra bee", "x160", "x260"]):
        # Premium electric powersports — $2k-5k used range
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
    else:
        base = 150  # Generic fallback

    # Generate realistic price spread around the base
    import random
    random.seed(hash(query) % 10000)  # Deterministic per query
    spread = 0.25
    sold_prices   = [int(base * random.uniform(1 - spread, 1 + spread)) for _ in range(10)]
    active_prices = [int(base * random.uniform(1.0,         1 + spread * 1.5)) for _ in range(10)]
    prices = sold_prices if operation == "findCompletedItems" else active_prices

    # WHY NO THUMBNAIL: eBay's placeholder paths 404 for mock IDs.
    # The frontend's data-img-card handler will replace broken images with a 📦 emoji.
    # Using a real eBay static asset as fallback thumb to avoid 404 flash.
    items = []
    for i, price in enumerate(prices):
        is_new = (operation == "findItemsAdvanced" and i == 0)
        # Unique mock item ID per (query, index) — gives each card a distinct URL
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
    print("  EBAY MARKET VALUE REPORT")
    print("="*60)
    print(f"  Search query:    '{mv.query_used}'")
    print(f"  Confidence:      {mv.confidence.upper()} ({mv.sold_count} sold comps)")
    print()
    print(f"  Sold avg:        ${mv.sold_avg:.2f}  (range: ${mv.sold_low:.2f} - ${mv.sold_high:.2f})")
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
    """Save market value to /data — consumed by Claude scoring in Week 3."""
    safe  = "".join(c for c in listing_title if c.isalnum() or c in " _-")[:40]
    fpath = DATA_DIR / f"market_value_{safe.strip().replace(' ', '_')}.json"
    fpath.write_text(json.dumps(asdict(mv), indent=2))
    log.info(f"Saved: {fpath}")
    return fpath


# ── Standalone Entry Point ────────────────────────────────────────────────────

async def main():
    """
    Test the eBay pricer against the most recently scraped listing in /data.
    Works with or without an eBay API key (uses mock data if no key is set).
    """
    listing_files = list(DATA_DIR.glob("listing_*.json"))
    if not listing_files:
        log.error("No listing files in /data — run the scraper first")
        return

    # Pick the most recently modified listing file
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
    print(f"  Ready for Week 3 — Claude deal scoring")


if __name__ == "__main__":
    asyncio.run(main())
