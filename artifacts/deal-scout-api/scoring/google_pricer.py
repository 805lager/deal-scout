"""
Google Shopping Price Module — httpx-based (no Playwright)

WHY REWRITTEN FROM PLAYWRIGHT TO HTTPX (v2.0):
  The original Playwright version launched a Chromium browser to execute
  Google Shopping's JavaScript. On Windows + uvicorn, spawning a subprocess
  from inside an asyncio event loop repeatedly crashes the server process.
  This is the same root cause as Bug B-V5 (vehicle_pricer Playwright crash).

  The fix: Google Shopping's initial HTML response contains price data in
  two machine-readable formats that don't require JS execution:
    1. JSON-LD structured data (<script type="application/ld+json">)
       — most stable, schema.org/Product format
    2. Inline price spans with data attributes
       — fallback for queries where JSON-LD is sparse

  httpx makes the request in ~300ms (vs 3-4s for Playwright) and never
  crashes uvicorn because it's pure async I/O with no subprocess.

BOT DETECTION NOTES:
  At POC scale (1 query per listing, 10-min cache), Google won't block us.
  We mimic a real browser via:
    - Realistic User-Agent string
    - Accept-Language / Accept headers
    - Referer header (appears to be clicking from google.com)
  If Google starts returning captchas, the diagnostic log will show
  "Before you continue" in the page title and we'll know to rotate UA.

CACHE:
  10-minute in-memory cache per query. Prevents hammering on re-scores.
"""

import asyncio
import json
import logging
import re
import time
import urllib.parse
from typing import Optional

import httpx
from dotenv import load_dotenv

load_dotenv()

log = logging.getLogger(__name__)

# ── Cache ─────────────────────────────────────────────────────────────────────
# (query_lower) -> {"data": [...], "ts": float}
_cache: dict = {}
_CACHE_TTL = 600  # 10 minutes — prices don't change faster than this


# ── Browser-like headers ──────────────────────────────────────────────────────
# WHY THESE HEADERS:
#   Without them, Google returns a consent/captcha page or stripped HTML.
#   These match what Chrome 122 sends for a normal Shopping search.
_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Referer": "https://www.google.com/",
    "DNT": "1",
    "Connection": "keep-alive",
    "Upgrade-Insecure-Requests": "1",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "same-origin",
    "Sec-Ch-Ua": '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    "Sec-Ch-Ua-Mobile": "?0",
    "Sec-Ch-Ua-Platform": '"Windows"',
}

_blocked_count = 0


# ── Public API ─────────────────────────────────────────────────────────────────

async def get_google_shopping_prices(
    query: str,
    max_results: int = 12,
    min_price: float = 0.0,
) -> list[dict]:
    """
    Fetch price data from Google Shopping for a search query.

    Returns a list of dicts: [{"price": float, "title": str, "condition": str}]
    Returns [] on any failure — caller treats this as "Google unavailable".

    WHY NO EXCEPTION RAISE:
      This is a best-effort fallback. If Google blocks or the parse fails,
      scoring proceeds with eBay data (or mock if eBay also fails).
    """
    cache_key = query.lower().strip()
    now = time.time()

    if cache_key in _cache:
        entry = _cache[cache_key]
        if now - entry["ts"] < _CACHE_TTL:
            log.info(f"[GooglePricer] Cache hit: '{query}' ({len(entry['data'])} prices)")
            return entry["data"]

    try:
        prices = await asyncio.wait_for(
            _fetch_google_shopping(query, max_results, min_price=min_price),
            timeout=8.0,  # Hard cap — never block scoring more than 8s
        )
        _cache[cache_key] = {"data": prices, "ts": now}
        log.info(f"[GooglePricer] '{query}' → {len(prices)} prices")
        return prices

    except asyncio.TimeoutError:
        log.warning(f"[GooglePricer] Timeout for '{query}'")
        return []
    except Exception as e:
        log.warning(f"[GooglePricer] Failed for '{query}': {type(e).__name__}: {e}")
        return []


def prices_to_market_stats(prices: list[dict]) -> Optional[dict]:
    """
    Convert raw price list into market stats dict for use in scoring.

    Returns:
      {"count": int, "avg": float, "low": float, "high": float}
      or None if not enough data.

    WHY 3-ITEM MINIMUM:
      Fewer than 3 prices is noise, not signal. One outlier ($50 listing
      for a $2,000 bike) can swing the average wildly. We'd rather admit
      low confidence than score on bad data.

    WHY TRIM OUTLIERS:
      Google Shopping mixes clearance prices, bundle deals, and retail.
      Trimming the top and bottom 10% gives a more representative center.
    """
    if not prices:
        return None

    valid = sorted(p["price"] for p in prices if p.get("price", 0) > 1)
    if len(valid) < 3:
        return None

    # Trim outliers — top and bottom 10% (at least 1 item each side)
    trim = max(1, len(valid) // 10)
    trimmed = valid[trim:-trim] if len(valid) > 4 else valid

    avg = round(sum(trimmed) / len(trimmed), 2)

    return {
        "count": len(valid),
        "avg":   avg,
        "low":   round(valid[0], 2),
        "high":  round(valid[-1], 2),
    }


# ── Internal fetch + parse ─────────────────────────────────────────────────────

async def _fetch_google_shopping(query: str, max_results: int, min_price: float = 0.0) -> list[dict]:
    """
    HTTP fetch + parse Google Shopping results without a browser.

    Strategy (in priority order):
      1. JSON-LD structured data  — most stable, schema.org format
      2. window.google.data / AF_initDataCallback inline JS blobs
      3. Regex over raw HTML price patterns

    WHY THREE STRATEGIES:
      Google A/B tests their Shopping page layout constantly.
      No single parsing strategy works 100% of the time.
      We try all three and merge results, deduplicating by price.
    """
    # udm=28 = Google Shopping tab (current parameter, tbm=shop is deprecated)
    # tbs=mr:1 = show all sellers/price options
    encoded = urllib.parse.quote_plus(query)
    url = f"https://www.google.com/search?udm=28&q={encoded}&hl=en&gl=us&num=20&tbs=mr:1"

    async with httpx.AsyncClient(
        headers=_HEADERS,
        follow_redirects=True,
        timeout=7.0,
    ) as client:
        resp = await client.get(url)
        html = resp.text

    log.info(f"[GooglePricer] HTTP {resp.status_code}, {len(html)} chars for '{query}'")

    # Detect consent/captcha pages — Google serves these before Shopping results
    title_match = re.search(r"<title[^>]*>([^<]+)</title>", html, re.I)
    page_title = title_match.group(1).strip() if title_match else "unknown"
    log.info(f"[GooglePricer] Page title: '{page_title}'")

    _block_keywords = ["before you continue", "captcha", "unusual traffic", "consent", "sorry", "blocked", "verify"]
    if any(t in page_title.lower() for t in _block_keywords):
        global _blocked_count
        _blocked_count += 1
        log.warning(f"[GooglePricer] Blocked/captcha page detected (count={_blocked_count}): title='{page_title}'")
        return []

    if resp.status_code == 429:
        log.warning(f"[GooglePricer] HTTP 429 rate limited for '{query}'")
        return []

    results: list[dict] = []
    seen_prices: set = set()

    # Floor: reject prices below min_price * 0.15 (15% of listing price).
    # WHY 15%: A $400 guitar listing should never match $5 guitar picks.
    # At 15%, a $400 guitar accepts comps >= $60 (covers badly worn instruments).
    # For min_price=0 (no context), the floor is $5 (hard minimum for any item).
    _price_floor = max(5.0, min_price * 0.15) if min_price > 0 else 5.0

    def add_price(price: float, title: str = "Unknown", condition: str = "new"):
        """Deduplicate by price value (rounded to nearest dollar)."""
        key = round(price)
        if key in seen_prices or price < _price_floor or price > 500_000:
            return
        seen_prices.add(key)
        results.append({"price": price, "title": title[:100], "condition": condition})

    # ── Strategy 1: JSON-LD structured data ───────────────────────────────────
    # Google Shopping includes schema.org/Product or schema.org/ItemList JSON-LD.
    # This is the most reliable source — schema is stable even when CSS changes.
    jsonld_blocks = re.findall(
        r'<script[^>]+type=["\']application/ld\+json["\'][^>]*>(.*?)</script>',
        html, re.DOTALL | re.I
    )
    for block in jsonld_blocks:
        try:
            data = json.loads(block)
            _extract_jsonld_prices(data, add_price)
        except (json.JSONDecodeError, Exception):
            continue

    log.info(f"[GooglePricer] Strategy 1 (JSON-LD): {len(results)} prices")

    # ── Strategy 2: Inline price data from Google's JS data blobs ─────────────
    # Google embeds pricing in window.__shoppingData or AF_initDataCallback calls.
    # We extract raw price strings from these blobs using a price regex.
    if len(results) < 3:
        _extract_js_blob_prices(html, add_price)
        log.info(f"[GooglePricer] Strategy 2 (JS blobs): {len(results)} prices total")

    # ── Strategy 3: aria-label and data-attribute prices ─────────────────────
    # Google Shopping product cards often embed prices in aria-label or
    # data-price attributes even when JSON-LD and JS blobs are absent.
    if len(results) < 3:
        _extract_aria_prices(html, add_price)
        log.info(f"[GooglePricer] Strategy 3 (aria/data): {len(results)} prices total")

    # ── Strategy 4: Raw HTML price regex ──────────────────────────────────────
    # Broadest fallback — finds any $X.XX or $X,XXX pattern in the HTML.
    # Less accurate (may include non-product prices) but better than nothing.
    if len(results) < 3:
        _extract_regex_prices(html, add_price)
        log.info(f"[GooglePricer] Strategy 4 (regex): {len(results)} prices total")

    if not results:
        # Log a snippet to help debug what Google actually returned
        body_text = re.sub(r"<[^>]+>", " ", html)
        body_text = re.sub(r"\s+", " ", body_text).strip()
        log.warning(f"[GooglePricer] 0 prices found. Body snippet: {body_text[:300]!r}")

    return results[:max_results]


def _extract_jsonld_prices(data, add_price):
    """Recursively extract prices from a JSON-LD object."""
    if isinstance(data, list):
        for item in data:
            _extract_jsonld_prices(item, add_price)
        return
    if not isinstance(data, dict):
        return

    # schema.org/Offer has "price" and "priceCurrency"
    if data.get("@type") in ("Offer", "AggregateOffer"):
        try:
            price = float(str(data.get("price", 0)).replace(",", ""))
            name  = data.get("name", "") or data.get("description", "")
            cond_raw = str(data.get("itemCondition", "")).lower()
            condition = "used" if any(w in cond_raw for w in ["used", "refurb", "second"]) else "new"
            if price > 0:
                add_price(price, name, condition)
        except (ValueError, TypeError):
            pass

    # schema.org/Product has "offers" (single or list)
    if data.get("@type") == "Product":
        offers = data.get("offers", {})
        name = data.get("name", "")
        if isinstance(offers, dict):
            offers = [offers]
        for offer in (offers if isinstance(offers, list) else []):
            try:
                price = float(str(offer.get("price", 0)).replace(",", ""))
                cond_raw = str(offer.get("itemCondition", "")).lower()
                condition = "used" if any(w in cond_raw for w in ["used", "refurb"]) else "new"
                if price > 0:
                    add_price(price, name, condition)
            except (ValueError, TypeError):
                pass

    # Recurse into nested objects
    for val in data.values():
        if isinstance(val, (dict, list)):
            _extract_jsonld_prices(val, add_price)


def _extract_js_blob_prices(html: str, add_price):
    """
    Extract prices from Google's inline JS data structures.
    Google embeds product data as large JS variable assignments.
    We scan for price patterns within those blobs.
    """
    # Find AF_initDataCallback or similar large data blobs
    blob_re = re.compile(
        r'AF_initDataCallback\s*\(\s*\{.*?\}\s*\)',
        re.DOTALL
    )
    # Extract all quoted price strings: "$X.XX", "$X,XXX"
    price_re = re.compile(r'\\?\"\\\$(\d[\d,]*\.?\d*)\\"')

    for blob in blob_re.finditer(html):
        for m in price_re.finditer(blob.group()):
            try:
                price = float(m.group(1).replace(",", ""))
                add_price(price)
            except ValueError:
                continue


def _extract_aria_prices(html: str, add_price):
    """
    Extract prices from aria-label attributes and data-price attributes.
    Google Shopping cards often have aria-label="Product Name $XX.XX" or
    data-price="XX.XX" even when other structured data is missing.
    """
    aria_re = re.compile(r'aria-label="[^"]*\$(\d[\d,]*\.?\d*)[^"]*"', re.I)
    for m in aria_re.finditer(html):
        try:
            price = float(m.group(1).replace(",", ""))
            if 2 <= price <= 50_000:
                add_price(price)
        except ValueError:
            continue

    data_price_re = re.compile(r'data-price="(\d[\d,]*\.?\d*)"', re.I)
    for m in data_price_re.finditer(html):
        try:
            price = float(m.group(1).replace(",", ""))
            if 2 <= price <= 50_000:
                add_price(price)
        except ValueError:
            continue

    price_span_re = re.compile(
        r'<span[^>]*class="[^"]*(?:price|a8Pemb|HRLxBb)[^"]*"[^>]*>\s*\$(\d[\d,]*\.?\d*)',
        re.I
    )
    for m in price_span_re.finditer(html):
        try:
            price = float(m.group(1).replace(",", ""))
            if 2 <= price <= 50_000:
                add_price(price)
        except ValueError:
            continue


def _extract_regex_prices(html: str, add_price):
    """
    Broadest fallback: find all $X.XX patterns in the HTML source.
    Strips HTML tags first to avoid matching CSS/JS dollar signs.
    """
    # Only scan within what looks like product listing sections
    # to reduce false positives from page chrome (nav, footer, etc.)
    body_match = re.search(r'<body[^>]*>(.*?)</body>', html, re.DOTALL | re.I)
    body = body_match.group(1) if body_match else html

    # Remove script and style blocks — they contain JS/CSS $ signs
    body = re.sub(r'<script[^>]*>.*?</script>', ' ', body, flags=re.DOTALL | re.I)
    body = re.sub(r'<style[^>]*>.*?</style>', ' ', body, flags=re.DOTALL | re.I)

    # Match: $X, $X.XX, $X,XXX, $X,XXX.XX
    price_re = re.compile(r'\$(\d{1,3}(?:,\d{3})*(?:\.\d{2})?)\b')
    for m in price_re.finditer(body):
        try:
            price = float(m.group(1).replace(",", ""))
            # Sanity range: $2 - $50,000 (avoids matching version numbers, etc.)
            if 2 <= price <= 50_000:
                add_price(price)
        except ValueError:
            continue