"""
Amazon Product Advertising API (PA-API 5) Price Module — SDK-free, HMAC-signed.

WHY THIS MODULE EXISTS:
  Google Shopping scraping in `google_pricer.py` is degraded in production —
  Google now serves anti-bot interstitials and HTTP 429s for many queries
  (`Nikon Z8`, `Samsung washer/dryer`, `Dell Latitude`, etc.) and all four
  extraction strategies return 0 prices. PA-API 5 is Amazon's free, official,
  structured replacement for the Amazon side of that data.

  GATING: PA-API requires 3 qualifying Associate sales in a 180-day window
  before Amazon issues credentials. Until that happens, the three secrets
  below are unset and `get_amazon_prices` returns `None` (the "not
  configured" sentinel) — the caller falls back to the Google pricer.

  The moment Amazon issues credentials, the user sets the three secrets
  and live Amazon prices start flowing on the next request — no code
  change, no redeploy.

SHAPE CONTRACT:
  `get_amazon_prices(query, max_results, min_price)` returns the SAME
  shape as `google_pricer.get_google_shopping_prices` so it slots into
  `ebay_pricer.py` without callers caring about the source:
    list[{"price": float, "title": str, "condition": str}]
  …with one extra sentinel value: `None` means "PA-API is not
  configured — caller should fall back". An empty list `[]` means
  "PA-API was called and returned nothing useful".

CACHE:
  10-minute in-memory cache per query, mirroring `google_pricer.py`.
  PA-API has a free-tier quota that scales with affiliate revenue
  (1 TPS / 8640/day for new accounts). The cache keeps us well under it.

OUTBOUND CALL:
  HTTPS POST to webservices.amazon.com/paapi5/searchitems, signed with
  AWS Signature V4 (HMAC-SHA256). No PII, no install_id, no listing URL
  leaves the box — only the product search query already used for
  Google Shopping today.

SECRETS:
  AMAZON_PAAPI_ACCESS_KEY    — Amazon-issued access key id
  AMAZON_PAAPI_SECRET_KEY    — Amazon-issued secret (used to derive
                               signing key in-process; never persisted)
  AMAZON_PAAPI_PARTNER_TAG   — Associates tracking tag (same value as
                               AMAZON_ASSOCIATE_TAG used in
                               affiliate_router.py for URL building)
"""

import asyncio
import datetime as _dt
import hashlib
import hmac
import json
import logging
import os
import time
from typing import Optional

import httpx

log = logging.getLogger(__name__)

# ── PA-API endpoint constants (US marketplace) ────────────────────────────────
_HOST     = "webservices.amazon.com"
_REGION   = "us-east-1"
_SERVICE  = "ProductAdvertisingAPI"
_URI_PATH = "/paapi5/searchitems"
_TARGET   = "com.amazon.paapi5.v1.ProductAdvertisingAPIv1.SearchItems"
_MARKETPLACE = "www.amazon.com"

# ── In-memory TTL cache (mirrors google_pricer.py) ────────────────────────────
_cache: dict = {}
_CACHE_TTL = 600  # 10 minutes

# ── Health-surface state (consumed by /admin/dashboard) ───────────────────────
# Process-local since-restart counters. No PII, no prices.
_health_state: dict = {
    "configured":     False,
    "last_status":    None,    # "ok" | "empty" | "error" | None
    "last_called_at": None,    # epoch seconds
    "last_error":     None,    # short error class name, no body
    "ok_count":       0,
    "error_count":    0,
}


def get_health_state() -> dict:
    """Read-only snapshot for /admin/dashboard. Recomputes `configured`
    on every call so newly-added secrets show up without a restart."""
    return {
        "configured":     _all_creds_present(),
        "last_status":    _health_state["last_status"],
        "last_called_at": _health_state["last_called_at"],
        "last_error":     _health_state["last_error"],
        "ok_count":       _health_state["ok_count"],
        "error_count":    _health_state["error_count"],
    }


# ── Public API ────────────────────────────────────────────────────────────────

async def get_amazon_prices(
    query: str,
    max_results: int = 12,
    min_price: float = 0.0,
) -> Optional[list[dict]]:
    """
    Fetch live retail prices from Amazon PA-API 5 SearchItems.

    Returns:
      - `None` when any of the three credentials is missing (sentinel
        meaning "not configured — caller should fall back").
      - `list[dict]` of `{"price", "title", "condition"}` rows on
        success (may be empty if PA-API returned no priced results).

    Never raises. On HTTP error, parse error, or timeout, returns `[]`
    so the caller's fallback path kicks in.
    """
    if not _all_creds_present():
        return None

    cache_key = query.lower().strip()
    now = time.time()
    entry = _cache.get(cache_key)
    if entry and (now - entry["ts"]) < _CACHE_TTL:
        log.info(f"[AmazonPricer] Cache hit: '{query}' ({len(entry['data'])} prices)")
        return entry["data"]

    try:
        prices = await asyncio.wait_for(
            _fetch_paapi(query, max_results, min_price),
            timeout=8.0,
        )
        _cache[cache_key] = {"data": prices, "ts": now}
        _health_state["last_called_at"] = now
        if prices:
            _health_state["last_status"] = "ok"
            _health_state["last_error"] = None
            _health_state["ok_count"] += 1
        elif _health_state["last_status"] != "error":
            # Only flip to "empty" when _fetch_paapi didn't already record an
            # HTTP/JSON error (which returns [] but stamps last_status="error").
            _health_state["last_status"] = "empty"
        log.info(f"[AmazonPricer] '{query}' → {len(prices)} prices")
        return prices
    except asyncio.TimeoutError:
        _record_error("timeout")
        log.warning(f"[AmazonPricer] Timeout for '{query}'")
        return []
    except Exception as e:
        _record_error(type(e).__name__)
        log.warning(f"[AmazonPricer] Failed for '{query}': {type(e).__name__}: {e}")
        return []


# ── Internals ─────────────────────────────────────────────────────────────────

def _all_creds_present() -> bool:
    return bool(
        os.getenv("AMAZON_PAAPI_ACCESS_KEY")
        and os.getenv("AMAZON_PAAPI_SECRET_KEY")
        and os.getenv("AMAZON_PAAPI_PARTNER_TAG")
    )


def _record_error(name: str) -> None:
    _health_state["last_status"]    = "error"
    _health_state["last_error"]     = name
    _health_state["last_called_at"] = time.time()
    _health_state["error_count"]   += 1


async def _fetch_paapi(query: str, max_results: int, min_price: float) -> list[dict]:
    access_key  = os.getenv("AMAZON_PAAPI_ACCESS_KEY", "")
    secret_key  = os.getenv("AMAZON_PAAPI_SECRET_KEY", "")
    partner_tag = os.getenv("AMAZON_PAAPI_PARTNER_TAG", "")

    payload = {
        "Keywords":     query,
        "Resources": [
            "ItemInfo.Title",
            "Offers.Listings.Price",
            "Offers.Listings.Condition",
            "Offers.Summaries.LowestPrice",
        ],
        "SearchIndex":  "All",
        "ItemCount":    max(1, min(int(max_results), 10)),  # PA-API caps SearchItems at 10
        "PartnerTag":   partner_tag,
        "PartnerType":  "Associates",
        "Marketplace":  _MARKETPLACE,
    }
    body = json.dumps(payload, separators=(",", ":"))

    headers = _sign_request(body, access_key, secret_key)

    url = f"https://{_HOST}{_URI_PATH}"
    async with httpx.AsyncClient(timeout=7.0) as client:
        resp = await client.post(url, content=body, headers=headers)

    if resp.status_code != 200:
        # Common cases: 401 invalid creds, 429 throttle, 503 over-quota.
        # Log status only — never log body (may echo signed headers/keys).
        log.warning(f"[AmazonPricer] PA-API HTTP {resp.status_code} for '{query}'")
        _record_error(f"http_{resp.status_code}")
        return []

    try:
        data = resp.json()
    except Exception as e:
        _record_error(f"json_{type(e).__name__}")
        return []

    return _parse_items(data, min_price)


def _parse_items(data: dict, min_price: float) -> list[dict]:
    """Pull priced rows out of a SearchItems response. Tolerates
    missing fields — PA-API frequently omits Offers for unavailable items."""
    out: list[dict] = []
    seen: set = set()
    floor = max(5.0, min_price * 0.15) if min_price > 0 else 5.0

    items = (data.get("SearchResult") or {}).get("Items") or []
    for it in items:
        try:
            title = (((it.get("ItemInfo") or {}).get("Title") or {}).get("DisplayValue") or "")
            offers = it.get("Offers") or {}
            listings = offers.get("Listings") or []

            # Prefer the Listing price; fall back to Summaries.LowestPrice.
            price = None
            condition = "new"
            if listings:
                first = listings[0]
                p = (first.get("Price") or {}).get("Amount")
                if p is not None:
                    price = float(p)
                cond_raw = ((first.get("Condition") or {}).get("Value") or "").lower()
                if cond_raw in ("used", "refurbished", "collectible"):
                    condition = "used" if cond_raw != "refurbished" else "refurbished"

            if price is None:
                summaries = offers.get("Summaries") or []
                for s in summaries:
                    lp = (s.get("LowestPrice") or {}).get("Amount")
                    if lp is not None:
                        price = float(lp)
                        break

            if price is None or price < floor or price > 500_000:
                continue
            key = round(price)
            if key in seen:
                continue
            seen.add(key)
            out.append({
                "price":     price,
                "title":     (title or "")[:100],
                "condition": condition,
            })
        except Exception:
            continue
    return out


# ── AWS SigV4 signing (no boto3) ──────────────────────────────────────────────
# Reference: https://webservices.amazon.com/paapi5/documentation/sending-request.html

def _sign_request(body: str, access_key: str, secret_key: str) -> dict:
    now = _dt.datetime.utcnow()
    amz_date    = now.strftime("%Y%m%dT%H%M%SZ")
    date_stamp  = now.strftime("%Y%m%d")

    payload_hash = hashlib.sha256(body.encode("utf-8")).hexdigest()

    canonical_headers = (
        f"content-encoding:amz-1.0\n"
        f"content-type:application/json; charset=utf-8\n"
        f"host:{_HOST}\n"
        f"x-amz-date:{amz_date}\n"
        f"x-amz-target:{_TARGET}\n"
    )
    signed_headers = "content-encoding;content-type;host;x-amz-date;x-amz-target"

    canonical_request = (
        f"POST\n{_URI_PATH}\n\n{canonical_headers}\n{signed_headers}\n{payload_hash}"
    )
    cr_hash = hashlib.sha256(canonical_request.encode("utf-8")).hexdigest()

    scope = f"{date_stamp}/{_REGION}/{_SERVICE}/aws4_request"
    string_to_sign = f"AWS4-HMAC-SHA256\n{amz_date}\n{scope}\n{cr_hash}"

    signing_key = _derive_signing_key(secret_key, date_stamp, _REGION, _SERVICE)
    signature   = hmac.new(signing_key, string_to_sign.encode("utf-8"), hashlib.sha256).hexdigest()

    authorization = (
        f"AWS4-HMAC-SHA256 Credential={access_key}/{scope}, "
        f"SignedHeaders={signed_headers}, Signature={signature}"
    )

    return {
        "content-encoding": "amz-1.0",
        "content-type":     "application/json; charset=utf-8",
        "host":             _HOST,
        "x-amz-date":       amz_date,
        "x-amz-target":     _TARGET,
        "Authorization":    authorization,
    }


def _derive_signing_key(secret: str, date_stamp: str, region: str, service: str) -> bytes:
    def _hmac(key: bytes, msg: str) -> bytes:
        return hmac.new(key, msg.encode("utf-8"), hashlib.sha256).digest()
    k_date    = _hmac(("AWS4" + secret).encode("utf-8"), date_stamp)
    k_region  = _hmac(k_date,    region)
    k_service = _hmac(k_region,  service)
    return _hmac(k_service, "aws4_request")
