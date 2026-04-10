"""
Web Search Price Grounding — Real-Time Market Data via Web Search

WHY THIS EXISTS:
  Claude's pricing knowledge comes from training data, which can be months
  or years stale. A used iPhone 15 Pro price changes weekly.

  This module performs a quick web search via DuckDuckGo HTML to find
  current market prices and feeds the results into Claude's pricing prompt
  as grounding data.

FLOW:
  1. Search DuckDuckGo HTML for the item (4 query variations)
  2. Parse snippets for price signals ($XXX patterns)
  3. Return structured price context for the Claude pricer prompt

COST: Free (HTTP requests, no API key needed)
LATENCY: ~1-2s (runs concurrently with other pipeline steps)
"""

import asyncio
import logging
import re
import statistics
import urllib.parse
from typing import Optional

log = logging.getLogger(__name__)

_WEB_SEARCH_TIMEOUT = 8.0

_USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
]

_ua_index = 0


def _next_ua() -> str:
    global _ua_index
    ua = _USER_AGENTS[_ua_index % len(_USER_AGENTS)]
    _ua_index += 1
    return ua


async def search_market_prices(
    query: str,
    condition: str = "Used",
    listing_price: float = 0.0,
) -> Optional[dict]:
    """
    Search the web for current market prices of an item.

    Returns dict with:
      prices_found: list[float]
      price_avg:    float
      price_low:    float
      price_high:   float
      snippets:     list[str]
      source:       str

    Returns None if search fails or no prices found.
    """
    try:
        import httpx

        search_queries = [
            f"{query} used price sold",
            f"{query} {condition.lower()} eBay sold price",
            f"{query} used for sale price range",
            f"{query} marketplace value worth",
        ]

        all_snippets = []
        all_prices = []

        async with httpx.AsyncClient(
            timeout=_WEB_SEARCH_TIMEOUT,
            follow_redirects=True,
            headers={
                "User-Agent": _next_ua(),
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Accept-Language": "en-US,en;q=0.9",
            }
        ) as client:
            tasks = []
            for sq in search_queries:
                tasks.append(client.get(
                    "https://lite.duckduckgo.com/lite/",
                    params={"q": sq},
                ))

            results = await asyncio.gather(*tasks, return_exceptions=True)

            success_count = 0
            for i, result in enumerate(results):
                if isinstance(result, Exception):
                    log.debug(f"[WebPricer] Query {i+1} failed: {result}")
                    continue

                if result.status_code == 202:
                    log.debug(f"[WebPricer] Query {i+1} got 202 (CAPTCHA/rate limit)")
                    continue

                if result.status_code >= 300:
                    log.debug(f"[WebPricer] Query {i+1} returned {result.status_code}")
                    continue

                success_count += 1
                text = result.text
                prices = _extract_prices(text)
                all_prices.extend(prices)

                snippets = _extract_snippets(text)
                all_snippets.extend(snippets)

            log.info(f"[WebPricer] {success_count}/{len(search_queries)} queries succeeded, {len(all_prices)} raw prices")

        if not all_prices:
            log.info(f"[WebPricer] No prices found in search results for: {query}")
            return None

        all_prices = _filter_outliers(all_prices, listing_price)

        if not all_prices:
            return None

        all_prices = sorted(set(all_prices))
        avg_price = statistics.mean(all_prices)
        log.info(
            f"[WebPricer] {query}: found {len(all_prices)} prices, "
            f"avg=${avg_price:.0f} (${min(all_prices):.0f}-${max(all_prices):.0f})"
        )

        return {
            "prices_found": all_prices,
            "price_avg": round(avg_price, 2),
            "price_low": round(min(all_prices), 2),
            "price_high": round(max(all_prices), 2),
            "snippets": all_snippets[:8],
            "source": "web_search",
        }

    except Exception as e:
        log.warning(f"[WebPricer] Failed: {type(e).__name__}: {e}")
        return None


def _extract_prices(html_text: str) -> list[float]:
    """Extract dollar prices from HTML/text content."""
    patterns = [
        r'\$\s*([\d,]+(?:\.\d{2})?)',
        r'(?:sold\s+for|sells?\s+for|price[ds]?\s+at|going\s+for|listed\s+(?:at|for)|bought\s+for|paid)\s*\$?([\d,]+(?:\.\d{2})?)',
        r'([\d,]+(?:\.\d{2})?)\s*(?:dollars|USD)',
        r'(?:average|avg|median|typical|market)\s*(?:price|value|cost)?\s*(?:is|of|around|about|:)?\s*\$?([\d,]+(?:\.\d{2})?)',
        r'(?:worth|valued?\s+at|retail(?:s|ing)?)\s+(?:about|around|approximately)?\s*\$?([\d,]+(?:\.\d{2})?)',
    ]

    prices = []
    for pattern in patterns:
        matches = re.findall(pattern, html_text, re.IGNORECASE)
        for match in matches:
            try:
                price = float(match.replace(",", ""))
                if 5.0 <= price <= 500000:
                    prices.append(price)
            except ValueError:
                continue

    return prices


def _extract_snippets(html_text: str) -> list[str]:
    """Extract text snippets that contain price-related information."""
    snippet_patterns = [
        re.compile(r'class="result-snippet"[^>]*>(.*?)</td>', re.IGNORECASE | re.DOTALL),
        re.compile(r'class="result__snippet"[^>]*>(.*?)</a>', re.IGNORECASE | re.DOTALL),
        re.compile(r'<td[^>]*class="result-snippet"[^>]*>(.*?)</td>', re.IGNORECASE | re.DOTALL),
        re.compile(r'<span[^>]*class="[^"]*snippet[^"]*"[^>]*>(.*?)</span>', re.IGNORECASE | re.DOTALL),
    ]

    matches = []
    for pattern in snippet_patterns:
        found = pattern.findall(html_text)
        if found:
            matches.extend(found)
            break

    if not matches:
        price_context = re.compile(
            r'(?:sold|price|cost|worth|value|buy|used|market|average|paid|retail)[^<]{10,300}',
            re.IGNORECASE
        )
        matches = price_context.findall(html_text)

    cleaned = []
    seen = set()
    for m in matches[:10]:
        clean = re.sub(r'<[^>]+>', '', m).strip()
        clean = re.sub(r'\s+', ' ', clean)
        if len(clean) > 15:
            key = clean[:50].lower()
            if key not in seen:
                seen.add(key)
                cleaned.append(clean[:250])

    return cleaned


def _filter_outliers(prices: list[float], listing_price: float) -> list[float]:
    """Remove extreme outliers that are likely not relevant prices."""
    if not prices:
        return []

    if listing_price > 0:
        lower_bound = max(5.0, 0.05 * listing_price)
        upper_bound = 15 * listing_price
        prices = [p for p in prices if lower_bound <= p <= upper_bound]
    else:
        prices = [p for p in prices if p >= 5.0]

    if not prices:
        return []

    if len(prices) >= 3:
        median = statistics.median(prices)
        prices = [p for p in prices if 0.15 * median <= p <= 6 * median]

    return prices if prices else []
