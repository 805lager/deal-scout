"""
Google Shopping Price Fallback

WHY THIS EXISTS:
  eBay's Finding API rate-limits aggressively during development.
  When we're rate-limited, scores are based on keyword-guessed mock data.
  Google Shopping gives us real current retail prices with no API key or
  rate limits — Playwright renders the page exactly as a browser would.

HOW IT INTEGRATES:
  Called from ebay_pricer.get_market_value() when eBay returns mock data.
  Returns price data that replaces mock eBay stats, improving score accuracy.

LIMITATIONS:
  - Google Shopping skews toward NEW retail prices (not used marketplace)
  - No "sold" data — only current asking prices
  - 1-4s latency (persistent browser minimizes cold-start cost after first use)
  - Google may block if hit aggressively — in-memory cache prevents hammering

BOT DETECTION NOTES (relevant since Shaun works in AI security):
  Google detects headless Chrome via:
    1. navigator.webdriver = true  →  mitigated via --disable-blink-features
    2. Missing plugins list        →  low risk at POC query rate
    3. IP velocity (calls/minute)  →  mitigated via 10-min cache
  At POC scale (1 query per listing, cached 10 min), Google won't trigger
  automated blocking. Rate-limited eBay means we hit this ~once per session.
"""

import asyncio
import logging
import time
import urllib.parse
from typing import Optional

log = logging.getLogger(__name__)


# ── Persistent Browser ─────────────────────────────────────────────────────────
# WHY PERSISTENT: Launching Chromium takes ~1-2s. Keeping the browser alive
# between requests drops subsequent calls to ~0.3s page load + JS eval.
# The process is reclaimed automatically when uvicorn exits.

_playwright_handle = None
_browser_instance  = None


async def _ensure_browser():
    """
    Return a live Playwright Browser instance, launching if needed.
    Reconnects automatically if the browser crashes or is killed.
    """
    global _playwright_handle, _browser_instance
    try:
        if _browser_instance and _browser_instance.is_connected():
            return _browser_instance
    except Exception:
        pass  # Browser died — fall through to relaunch

    log.info("[GooglePricer] Launching headless Chromium (cold start)...")
    from playwright.async_api import async_playwright
    _playwright_handle = await async_playwright().start()
    _browser_instance  = await _playwright_handle.chromium.launch(
        headless=True,
        args=[
            "--no-sandbox",
            "--disable-dev-shm-usage",
            # Disable the webdriver flag that triggers bot detection
            "--disable-blink-features=AutomationControlled",
            "--disable-extensions",
        ]
    )
    log.info("[GooglePricer] Browser ready")
    return _browser_instance


# ── In-Memory Cache ─────────────────────────────────────────────────────────────

_cache: dict = {}
_CACHE_TTL = 600  # 10 minutes — Google prices don't change that fast


# ── Public API ─────────────────────────────────────────────────────────────────

async def get_google_shopping_prices(
    query: str,
    max_results: int = 12,
) -> list[dict]:
    """
    Scrape Google Shopping and return a list of price dicts.

    Return format:
      [{"price": 2499.0, "title": "Sur-Ron X260 2023", "condition": "new"}, ...]

    Returns an empty list on any failure — caller handles fallback gracefully.

    WHY NO EXCEPTION RAISE:
      This is a best-effort fallback. If Google blocks us or the scrape fails,
      we still want scoring to proceed (with mock data) rather than crash.
    """
    cache_key = f"gshop:{query.lower().strip()}"
    now = time.time()

    if cache_key in _cache:
        entry = _cache[cache_key]
        if now - entry["ts"] < _CACHE_TTL:
            log.info(f"[GooglePricer] Cache hit: '{query}' ({len(entry['data'])} prices)")
            return entry["data"]

    try:
        prices = await asyncio.wait_for(
            _scrape_google_shopping(query, max_results),
            timeout=10.0,  # Hard cap — don't block scoring more than 10s
        )
        _cache[cache_key] = {"data": prices, "ts": now}
        log.info(f"[GooglePricer] '{query}' → {len(prices)} prices scraped")
        return prices
    except asyncio.TimeoutError:
        log.warning(f"[GooglePricer] Timeout scraping '{query}'")
        return []
    except Exception as e:
        log.warning(f"[GooglePricer] Scrape failed for '{query}': {type(e).__name__}: {e}")
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


# ── Scraper ────────────────────────────────────────────────────────────────────

async def _scrape_google_shopping(query: str, max_results: int) -> list[dict]:
    """
    Navigate to Google Shopping, extract prices via in-page JavaScript.

    WHY JS EXTRACTION (page.evaluate) OVER PYTHON HTML PARSING:
      Google Shopping loads prices via JavaScript after the initial HTML response.
      A simple HTTP GET returns a skeleton page with no product data.
      Playwright runs real Chromium, which executes the JS and builds the full DOM.
      page.evaluate() then runs our extraction code inside that live DOM —
      same APIs as a browser extension content script.

    WHY TreeWalker OVER CSS SELECTORS:
      Google changes their CSS class names frequently (minified, obfuscated).
      A TreeWalker that matches text by regex pattern ($X,XXX format) is robust
      against class name changes — the price text itself doesn't change.
    """
    browser = await _ensure_browser()

    # WHY new_context per request (not reuse tab):
    # Each request should start with a clean cookie/session state.
    # Reusing tabs could leak session state between queries.
    context = await browser.new_context(
        user_agent=(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/122.0.0.0 Safari/537.36"
        ),
        locale="en-US",
        viewport={"width": 1280, "height": 800},
    )
    page = await context.new_page()

    try:
        encoded = urllib.parse.quote_plus(query)
        url = f"https://www.google.com/search?tbm=shop&q={encoded}&hl=en&gl=us&num=20"

        await page.goto(url, wait_until="domcontentloaded", timeout=15000)

        # Give JS a moment to render product cards
        # WHY 1500ms not 3000ms: we only need prices to be injected, not lazy images
        await page.wait_for_timeout(1500)

        raw_items = await page.evaluate(
            """
            (maxResults) => {
                const results = [];
                const seen    = new Set();

                // Google Shopping prices match "$X", "$X,XXX", "$X,XXX.XX"
                const priceRe = /^\\$[\\d,]+(\\.[\\d]{2})?$/;

                // WHY TreeWalker: scans ONLY text nodes, skipping element overhead.
                // It's faster than querySelectorAll on the whole page and more
                // resilient to class name obfuscation.
                const walker = document.createTreeWalker(
                    document.body,
                    NodeFilter.SHOW_TEXT,
                    {
                        acceptNode(node) {
                            const t = node.textContent.trim();
                            return priceRe.test(t)
                                ? NodeFilter.FILTER_ACCEPT
                                : NodeFilter.FILTER_SKIP;
                        }
                    }
                );

                while (walker.nextNode() && results.length < maxResults) {
                    const priceText = walker.currentNode.textContent.trim();
                    if (seen.has(priceText)) continue;
                    seen.add(priceText);

                    const price = parseFloat(priceText.replace(/[^0-9.]/g, ''));
                    if (!price || price < 1 || price > 500000) continue;

                    // Walk up the ancestor chain to find title + condition context.
                    // WHY 10 levels: Google Shopping nests prices deep in card components.
                    let el          = walker.currentNode.parentElement;
                    let title       = '';
                    let condition   = 'new';

                    for (let depth = 0; depth < 10 && el; depth++) {
                        const elText = (el.innerText || '').toLowerCase();

                        // Detect used/refurbished condition hints
                        if (!condition || condition === 'new') {
                            if (elText.includes('used') || elText.includes('refurb') ||
                                elText.includes('pre-owned') || elText.includes('open box')) {
                                condition = 'used';
                            }
                        }

                        // Grab the first reasonable-looking title from an anchor
                        if (!title) {
                            const anchor = el.querySelector('a[href]');
                            if (anchor) {
                                const anchorText = (anchor.innerText || '').trim();
                                if (anchorText.length > 8 && anchorText.length < 200 &&
                                    !priceRe.test(anchorText)) {
                                    title = anchorText.split('\\n')[0].substring(0, 100);
                                }
                            }
                        }

                        el = el.parentElement;
                    }

                    results.push({
                        price,
                        title:     title || 'Unknown',
                        condition: condition,
                    });
                }
                return results;
            }
            """,
            max_results,
        )

        return raw_items or []

    finally:
        # Close context (releases cookies/cache) but keep browser alive
        await context.close()
