"""
eBay Browse API — Real Sold/Completed Listing Prices

Uses eBay's Browse API (v1) with OAuth2 client credentials to search for
sold items. This is the highest-quality pricing source:
  - Returns ACTUAL sold prices (what buyers paid, not what sellers asked)
  - 5,000 calls/day on free tier (vs Finding API which is permanently rate-limited)
  - Structured JSON response with item details, images, prices

REQUIREMENTS:
  EBAY_APP_ID   — eBay developer App ID (Client ID)
  EBAY_CERT_ID  — eBay developer Cert ID (Client Secret)
  Both from https://developer.ebay.com → Application Keys

OAUTH2 FLOW:
  POST https://api.ebay.com/identity/v1/oauth2/token
  Body: grant_type=client_credentials&scope=https://api.ebay.com/oauth/api_scope
  Auth: Basic base64(APP_ID:CERT_ID)
  Returns: access_token valid for 7200s (2 hours)

BROWSE API ENDPOINT:
  GET https://api.ebay.com/buy/browse/v1/item_summary/search
  Headers: Authorization: Bearer <token>
  Params: q, filter (buyingOptions, conditions, price), limit, sort
"""

import asyncio
import base64
import logging
import os
import statistics
import time
from typing import Optional

import httpx
from dotenv import load_dotenv

load_dotenv()

log = logging.getLogger(__name__)

EBAY_APP_ID = os.getenv("EBAY_APP_ID", "")
EBAY_CERT_ID = os.getenv("EBAY_CERT_ID", "")

_TOKEN_URL = "https://api.ebay.com/identity/v1/oauth2/token"
_BROWSE_URL = "https://api.ebay.com/buy/browse/v1/item_summary/search"
_SCOPE = "https://api.ebay.com/oauth/api_scope"

_cached_token: Optional[str] = None
_token_expires_at: float = 0.0
_token_lock: Optional[asyncio.Lock] = None

_browse_cache: dict = {}
_CACHE_TTL = 3600


def browse_api_configured() -> bool:
    return bool(EBAY_APP_ID and EBAY_CERT_ID and "your_ebay" not in EBAY_APP_ID)


async def _get_token() -> Optional[str]:
    global _cached_token, _token_expires_at, _token_lock

    if _cached_token and time.time() < _token_expires_at - 60:
        return _cached_token

    if _token_lock is None:
        _token_lock = asyncio.Lock()

    async with _token_lock:
        if _cached_token and time.time() < _token_expires_at - 60:
            return _cached_token

        if not browse_api_configured():
            log.debug("[BrowseAPI] Not configured (missing EBAY_APP_ID or EBAY_CERT_ID)")
            return None

        credentials = base64.b64encode(f"{EBAY_APP_ID}:{EBAY_CERT_ID}".encode()).decode()

        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.post(
                    _TOKEN_URL,
                    headers={
                        "Content-Type": "application/x-www-form-urlencoded",
                        "Authorization": f"Basic {credentials}",
                    },
                    data={
                        "grant_type": "client_credentials",
                        "scope": _SCOPE,
                    },
                )
                resp.raise_for_status()
                data = resp.json()
                _cached_token = data["access_token"]
                _token_expires_at = time.time() + data.get("expires_in", 7200)
                log.info(f"[BrowseAPI] OAuth2 token acquired (expires in {data.get('expires_in', 7200)}s)")
                return _cached_token
        except Exception as e:
            log.warning(f"[BrowseAPI] OAuth2 token failed: {type(e).__name__}: {e}")
            _cached_token = None
            return None


async def search_ebay_browse(
    query: str,
    sold: bool = True,
    limit: int = 20,
    condition: str = "",
) -> Optional[dict]:
    """
    Search eBay Browse API for items.

    Args:
        query: Search keywords
        sold: If True, search completed/sold items only
        limit: Max results (up to 200)
        condition: Filter by condition ("USED", "NEW", etc.)

    Returns dict with:
        items: list of {title, price, condition, url, image_url, sold}
        avg_price: float
        low_price: float
        high_price: float
        count: int
        data_source: "ebay_browse"

    Returns None if not configured or search fails.
    """
    if not browse_api_configured():
        return None

    cache_key = f"{query.lower().strip()}|{sold}|{condition}"
    cached = _browse_cache.get(cache_key)
    if cached and (time.time() - cached["ts"]) < _CACHE_TTL:
        log.info(f"[BrowseAPI] Cache hit: '{query}' (sold={sold})")
        return cached["data"]

    token = await _get_token()
    if not token:
        return None

    params = {
        "q": query,
        "limit": str(min(limit, 200)),
    }

    filter_parts = []
    if sold:
        filter_parts.append("soldItemsOnly:{true}")
    filter_parts.append("buyingOptions:{FIXED_PRICE}")
    if condition:
        cond_map = {
            "new": "NEW",
            "used": "USED",
            "like new": "USED",
            "good": "USED",
            "fair": "USED",
        }
        mapped = cond_map.get(condition.lower().strip(), "")
        if mapped:
            filter_parts.append(f"conditions:{{{mapped}}}")

    if filter_parts:
        params["filter"] = ",".join(filter_parts)

    try:
        async with httpx.AsyncClient(timeout=12.0) as client:
            resp = await client.get(
                _BROWSE_URL,
                headers={
                    "Authorization": f"Bearer {token}",
                    "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
                    "Content-Type": "application/json",
                },
                params=params,
            )

        if resp.status_code == 401:
            global _cached_token
            _cached_token = None
            log.warning("[BrowseAPI] Token expired (401) — will refresh on next call")
            return None

        if resp.status_code == 429:
            log.warning("[BrowseAPI] Rate limited (429) — skipping")
            return None

        if resp.status_code >= 400:
            body_snippet = resp.text[:300] if resp.text else "(empty)"
            log.warning(f"[BrowseAPI] HTTP {resp.status_code} for '{query}': {body_snippet}")
            return None

        resp.raise_for_status()
        data = resp.json()

        raw_items = data.get("itemSummaries", [])
        if not raw_items:
            log.info(f"[BrowseAPI] No results for '{query}' (sold={sold})")
            return None

        items = []
        prices = []
        for item in raw_items:
            try:
                price_data = item.get("price", {})
                price_val = float(price_data.get("value", "0"))
                if price_val < 5:
                    continue

                title = item.get("title", "Unknown")
                item_condition = item.get("condition", "Used")
                item_url = item.get("itemWebUrl", "")
                image = item.get("image", {})
                image_url = image.get("imageUrl", "")
                thumbnails = item.get("thumbnailImages", [])
                if not image_url and thumbnails:
                    image_url = thumbnails[0].get("imageUrl", "")

                # Capture sold date when present. The Browse API does NOT
                # universally expose a sold-date field on completed items —
                # `itemEndDate` is the closest stable signal, with
                # `lastSoldDate` as a fallback for the rare items that have
                # it. clean_browse_comps() uses this for recency weighting
                # (Task #58 — 30/90/180-day tiers, drop >180); when absent
                # the cleaner gracefully falls back to uniform weighting.
                sold_date = (
                    item.get("itemEndDate")
                    or item.get("lastSoldDate")
                    or item.get("itemCreationDate")
                    or ""
                )
                items.append({
                    "title": title[:100],
                    "price": round(price_val, 2),
                    "condition": item_condition,
                    "url": item_url,
                    "image_url": image_url,
                    "sold": sold,
                    "sold_date": sold_date,
                })
                prices.append(price_val)
            except (KeyError, ValueError, TypeError):
                continue

        if not prices:
            log.info(f"[BrowseAPI] No valid prices for '{query}' (sold={sold})")
            return None

        prices = _remove_outliers(prices)
        if not prices:
            return None

        result = {
            "items": items,
            "avg_price": round(statistics.mean(prices), 2),
            "low_price": round(min(prices), 2),
            "high_price": round(max(prices), 2),
            "count": len(prices),
            "data_source": "ebay_browse",
        }

        _browse_cache[cache_key] = {"data": result, "ts": time.time()}
        log.info(
            f"[BrowseAPI] '{query}' (sold={sold}): {len(prices)} prices, "
            f"avg=${result['avg_price']:.0f} "
            f"[${result['low_price']:.0f}-${result['high_price']:.0f}]"
        )
        return result

    except httpx.HTTPStatusError as e:
        log.warning(f"[BrowseAPI] HTTP {e.response.status_code} for '{query}': {e}")
        return None
    except Exception as e:
        log.warning(f"[BrowseAPI] Failed for '{query}': {type(e).__name__}: {e}")
        return None


def _remove_outliers(prices: list[float]) -> list[float]:
    if len(prices) < 4:
        return prices
    med = statistics.median(prices)
    floor = med * 0.20
    ceil = med * 5.0
    cleaned = [p for p in prices if floor <= p <= ceil]
    removed = len(prices) - len(cleaned)
    if removed:
        log.debug(f"[BrowseAPI] Removed {removed} outlier(s) (median=${med:.0f})")
    return cleaned if cleaned else prices
