"""
Craigslist Asking Price Scraper — No API Key Required

WHY THIS EXISTS:
  eBay sold prices tell you what people PAY. Craigslist asking prices tell
  you what sellers in the real world are EXPECTING. Showing both side-by-side
  gives the user context: if CL sellers are asking $400 but eBay buyers only
  pay $280, the user knows there's a seller-expectation gap they can negotiate.

  This is purely informational — Craigslist data never affects the deal score
  or estimated_value. It's a supplementary price comparison line only.

HOW IT WORKS:
  Craigslist exposes a public RSS feed for nationwide for-sale searches:
    https://www.craigslist.org/search/sss?query=telescope&format=rss
  No API key. No auth. Just an HTTP GET + RSS XML parse.

LIMITATIONS:
  - Asking prices only (not sold prices)
  - Results quality varies — noisy listings, duplicate posts, overpricing
  - Outlier filtering is critical (a $50k spam post would wreck the average)
  - Craigslist may throttle or block if we hammer it; the 10-min cache prevents that

CACHE:
  10-minute in-memory cache per query. Craigslist doesn't change faster than this.
"""

import asyncio
import logging
import re
import statistics
import time
import urllib.parse
import xml.etree.ElementTree as ET
from typing import Optional

import httpx

log = logging.getLogger(__name__)

_CACHE_TTL = 600   # 10 minutes
_cache: dict = {}

_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/122.0.0.0 Safari/537.36"
    ),
    "Accept": "application/rss+xml, application/xml, text/xml, */*",
    "Accept-Language": "en-US,en;q=0.9",
}

_PRICE_RE = re.compile(r"\$\s*(\d{1,6}(?:,\d{3})*(?:\.\d{1,2})?)")


async def get_craigslist_asking_prices(
    query: str,
    max_results: int = 20,
) -> Optional[dict]:
    """
    Fetch Craigslist asking prices for a search query.

    Returns dict with:
      avg    (float)  — mean asking price after outlier removal
      low    (float)  — lowest asking price after outlier removal
      high   (float)  — highest asking price after outlier removal
      count  (int)    — number of listings with parseable prices
      sample (list)   — up to 5 listings with {title, price, url}

    Returns None on network error or if fewer than 2 prices found.
    """
    if not query or not query.strip():
        return None

    cache_key = query.lower().strip()
    now = time.time()
    if cache_key in _cache and now - _cache[cache_key]["ts"] < _CACHE_TTL:
        log.debug(f"[Craigslist] Cache hit: {query}")
        return _cache[cache_key]["result"]

    url = "https://www.craigslist.org/search/sss"
    params = {
        "query":  query,
        "format": "rss",
        "sort":   "date",
    }

    try:
        async with httpx.AsyncClient(
            timeout=8.0,
            headers=_HEADERS,
            follow_redirects=True,
        ) as client:
            resp = await client.get(url, params=params)

        if resp.status_code != 200:
            log.debug(f"[Craigslist] HTTP {resp.status_code} for '{query}'")
            return None

        result = _parse_rss(resp.text, max_results)
        if result:
            _cache[cache_key] = {"result": result, "ts": now}
            log.info(
                f"[Craigslist] '{query}': "
                f"avg=${result['avg']:.0f} ({result['count']} listings)"
            )
        return result

    except httpx.TimeoutException:
        log.debug(f"[Craigslist] Timeout for '{query}'")
        return None
    except Exception as e:
        log.debug(f"[Craigslist] Failed for '{query}': {type(e).__name__}: {e}")
        return None


def _parse_rss(xml_text: str, max_results: int) -> Optional[dict]:
    """
    Parse Craigslist RSS XML, extract prices from listing titles,
    remove outliers, compute avg/low/high.
    """
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError as e:
        log.debug(f"[Craigslist] XML parse error: {e}")
        return None

    # Handle RSS namespaces
    ns = {"enc": "http://purl.org/rss/1.0/modules/enclosure/"}
    items = root.findall(".//item")
    if not items:
        return None

    listings = []
    for item in items[:max_results]:
        title_el = item.find("title")
        link_el  = item.find("link")
        title = title_el.text.strip() if title_el is not None and title_el.text else ""
        link  = link_el.text.strip()  if link_el  is not None and link_el.text  else ""

        price = _extract_price(title)
        if price is not None:
            listings.append({"title": title, "price": price, "url": link})

    if len(listings) < 2:
        return None

    prices = [l["price"] for l in listings]
    filtered = _remove_outliers(prices)

    if len(filtered) < 2:
        return None

    avg  = round(statistics.mean(filtered), 2)
    low  = round(min(filtered), 2)
    high = round(max(filtered), 2)

    # Build a sample of up to 5 listings, filtered to sane price range
    valid_listings = [l for l in listings if l["price"] in filtered][:5]

    return {
        "avg":    avg,
        "low":    low,
        "high":   high,
        "count":  len(filtered),
        "sample": valid_listings,
    }


def _extract_price(text: str) -> Optional[float]:
    """
    Extract the first dollar-sign price from a Craigslist listing title.
    Returns None if no valid price found.

    Examples:
      "$350 Orion XT8 Telescope" → 350.0
      "Telescope - $350 obo"     → 350.0
      "Free telescope"           → None
    """
    match = _PRICE_RE.search(text)
    if not match:
        return None
    try:
        price = float(match.group(1).replace(",", ""))
        if price < 1 or price > 500_000:
            return None
        return price
    except ValueError:
        return None


def _remove_outliers(prices: list[float]) -> list[float]:
    """
    Remove statistical outliers using IQR fencing.

    WHY IQR (not mean ± 2σ):
      Craigslist has extreme outliers — a $0 mislisting or a $50,000
      spam post would collapse a mean-based filter. IQR fencing is
      robust to even a few extreme values.

    Fence: Q1 - 1.5*IQR  to  Q3 + 1.5*IQR
    """
    if len(prices) < 4:
        return prices  # too few to filter meaningfully

    sorted_p = sorted(prices)
    n = len(sorted_p)
    q1 = statistics.median(sorted_p[:n // 2])
    q3 = statistics.median(sorted_p[(n + 1) // 2:])
    iqr = q3 - q1

    if iqr == 0:
        return prices  # all same price — no outliers

    lower = q1 - 1.5 * iqr
    upper = q3 + 1.5 * iqr
    return [p for p in prices if lower <= p <= upper]
