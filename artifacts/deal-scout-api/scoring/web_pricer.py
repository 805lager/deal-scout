"""
Web Search Price Grounding — Real-Time Market Data via Web Search

WHY THIS EXISTS:
  Claude's pricing knowledge comes from training data, which can be months
  or years stale. A used iPhone 15 Pro price changes weekly.

  This module performs a quick web scrape of Google Shopping results to find
  current market prices and feeds the results into Claude's pricing prompt
  as grounding data.

FLOW:
  1. Search Google Shopping for the item
  2. Parse snippets for price signals ($XXX patterns)
  3. Return structured price context for the Claude pricer prompt

COST: Free (HTTP requests)
LATENCY: ~1-2s (runs concurrently with other pipeline steps)
"""

import asyncio
import logging
import re
import statistics
import urllib.parse
from typing import Optional

log = logging.getLogger(__name__)

_WEB_SEARCH_TIMEOUT = 6.0


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
        ]

        all_snippets = []
        all_prices = []

        async with httpx.AsyncClient(
            timeout=_WEB_SEARCH_TIMEOUT,
            follow_redirects=True,
            headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}
        ) as client:
            tasks = []
            for sq in search_queries:
                encoded = urllib.parse.quote_plus(sq)
                url = f"https://www.google.com/search?q={encoded}&num=5&hl=en&gl=us"
                tasks.append(client.get(url))

            results = await asyncio.gather(*tasks, return_exceptions=True)

            for result in results:
                if isinstance(result, Exception):
                    log.debug(f"[WebPricer] Search request failed: {result}")
                    continue

                if result.status_code != 200:
                    log.debug(f"[WebPricer] Search returned {result.status_code}")
                    continue

                text = result.text
                prices = _extract_prices(text)
                all_prices.extend(prices)

                snippets = _extract_snippets(text)
                all_snippets.extend(snippets)

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
            "snippets": all_snippets[:5],
            "source": "web_search",
        }

    except Exception as e:
        log.warning(f"[WebPricer] Failed: {type(e).__name__}: {e}")
        return None


def _extract_prices(html_text: str) -> list[float]:
    """Extract dollar prices from HTML/text content."""
    patterns = [
        r'\$\s*([\d,]+(?:\.\d{2})?)',
        r'(?:sold\s+for|sells?\s+for|price[ds]?\s+at|going\s+for)\s*\$?([\d,]+(?:\.\d{2})?)',
        r'([\d,]+(?:\.\d{2})?)\s*(?:dollars|USD)',
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
    snippet_pattern = re.compile(
        r'(?:sold|price|cost|worth|value|buy|used|market)[^<]{10,200}',
        re.IGNORECASE
    )
    matches = snippet_pattern.findall(html_text)

    cleaned = []
    for m in matches[:5]:
        clean = re.sub(r'<[^>]+>', '', m).strip()
        clean = re.sub(r'\s+', ' ', clean)
        if len(clean) > 15:
            cleaned.append(clean[:200])

    return cleaned


def _filter_outliers(prices: list[float], listing_price: float) -> list[float]:
    """Remove extreme outliers that are likely not relevant prices."""
    if not prices:
        return []

    if listing_price > 0:
        prices = [p for p in prices if 0.1 * listing_price <= p <= 10 * listing_price]

    prices = [p for p in prices if p >= 10.0]

    if not prices:
        return []

    if len(prices) >= 3:
        median = statistics.median(prices)
        prices = [p for p in prices if 0.2 * median <= p <= 5 * median]

    return prices if prices else []
