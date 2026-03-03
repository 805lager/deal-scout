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

        if result.get("ack", [""])[0] != "Success":
            log.warning(f"eBay API non-success: {result.get('errorMessage', 'unknown')}")
            return []

        items = result.get("searchResult", [{}])[0].get("item", [])
        log.info(f"eBay {operation}: found {len(items)} results for '{query}'")
        return items

    except httpx.HTTPStatusError as e:
        log.error(f"eBay HTTP error {e.response.status_code}: {e.response.text[:200]}")
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
    if len(sold_items) >= 10:
        confidence = "high"
    elif len(sold_items) >= 3:
        confidence = "medium"
    else:
        confidence = "low"

    return MarketValue(
        query_used      = query,
        sold_avg        = round(sold_avg,        2),
        sold_low        = round(sold_low,         2),
        sold_high       = round(sold_high,        2),
        sold_count      = len(sold_items),
        active_avg      = round(active_avg,       2),
        active_low      = round(active_low,       2),
        active_count    = len(active_items),
        new_price       = round(new_price,        2),
        estimated_value = round(estimated_value,  2),
        confidence      = confidence,
    )


# ── Mock Data (no API key needed for testing) ─────────────────────────────────

def _mock_ebay_response(query: str, operation: str) -> list[dict]:
    """
    Realistic mock eBay data for the Orion XT8 telescope.
    Lets you test the full pipeline before getting an eBay key.
    Prices based on real eBay comps for this model.
    """
    mock_prices = {
        "findCompletedItems": [350, 375, 400, 420, 380, 390, 410, 360, 395, 405],
        "findItemsAdvanced":  [399, 425, 450, 380, 415, 440, 395, 460, 420, 435],
    }
    prices = mock_prices.get(operation, [400])
    items  = []
    for i, price in enumerate(prices):
        is_new = (operation == "findItemsAdvanced" and i == 0)
        items.append({
            "title":         [f"Orion SkyQuest XT8 Dobsonian {'New' if is_new else 'Used'}"],
            "sellingStatus": [{"convertedCurrentPrice": [{"__value__": str(price)}]}],
            "condition":     [{"conditionDisplayName":  ["New" if is_new else "Used"]}],
            "viewItemURL":   [f"https://www.ebay.com/itm/mock-{i}"],
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
