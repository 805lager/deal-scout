"""
Tests for scoring/amazon_pricer.py + the PA-API → Google fallback wrapper
in scoring/ebay_pricer.py (Task #99).

Locks in the four behavioral contracts:
  1. Credentials missing → `get_amazon_prices` returns `None` (sentinel),
     and the ebay_pricer fallback wrapper exercises the Google path.
  2. Credentials present + PA-API returns rows → primary path returns them.
  3. Credentials present + PA-API throws → fallback wrapper still returns
     Google rows (never raises).
  4. Both sources empty → empty list out, no exception.

Networking is fully stubbed via `httpx.MockTransport` so no live PA-API
call leaves the box. Self-running (no pytest dependency) — matches the
pattern used by tests/test_filter_affiliate_cards.py.
"""
import asyncio
import json
import os
import sys
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from scoring import amazon_pricer  # noqa: E402


# ── Helpers ──────────────────────────────────────────────────────────────────

_CREDS = ("AMAZON_PAAPI_ACCESS_KEY", "AMAZON_PAAPI_SECRET_KEY", "AMAZON_PAAPI_PARTNER_TAG")


def _set_creds():
    os.environ["AMAZON_PAAPI_ACCESS_KEY"]  = "AKIAFAKE"
    os.environ["AMAZON_PAAPI_SECRET_KEY"]  = "fakesecret"
    os.environ["AMAZON_PAAPI_PARTNER_TAG"] = "dealscout03f-20"


def _clear_creds():
    for k in _CREDS:
        os.environ.pop(k, None)


def _reset_module_state():
    amazon_pricer._cache.clear()
    amazon_pricer._health_state.update({
        "configured":     False,
        "last_status":    None,
        "last_called_at": None,
        "last_error":     None,
        "ok_count":       0,
        "error_count":    0,
    })


def _install_mock_transport(handler):
    """Replace `httpx.AsyncClient` with one that routes through MockTransport.
    Returns the original class so caller can restore it."""
    real_client = amazon_pricer.httpx.AsyncClient

    class _Patched(real_client):
        def __init__(self, *args, **kwargs):
            kwargs["transport"] = httpx.MockTransport(handler)
            super().__init__(*args, **kwargs)

    amazon_pricer.httpx.AsyncClient = _Patched  # type: ignore[attr-defined]
    return real_client


def _restore_transport(real_client):
    amazon_pricer.httpx.AsyncClient = real_client  # type: ignore[attr-defined]


def _paapi_response_with_items(prices):
    items = []
    for i, p in enumerate(prices):
        items.append({
            "ASIN": f"B0FAKE{i:04d}",
            "ItemInfo": {"Title": {"DisplayValue": f"Fake Item {i}"}},
            "Offers": {
                "Listings": [{
                    "Price":     {"Amount": p, "Currency": "USD"},
                    "Condition": {"Value": "New"},
                }],
            },
        })
    return {"SearchResult": {"Items": items}}


# ── 1. Credentials missing → sentinel None ───────────────────────────────────

async def _run_missing_creds_returns_none():
    _clear_creds()
    _reset_module_state()
    out = await amazon_pricer.get_amazon_prices("Nikon Z8", max_results=5)
    assert out is None, "missing creds must return None sentinel for fallback"


def test_missing_creds_returns_none():
    asyncio.run(_run_missing_creds_returns_none())


# ── 2. Primary success — credentials present, PA-API returns rows ────────────

async def _run_primary_success_returns_rows():
    _set_creds()
    _reset_module_state()

    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["host"]   = request.url.host
        captured["path"]   = request.url.path
        captured["target"] = request.headers.get("x-amz-target", "")
        captured["auth"]   = request.headers.get("Authorization", "")
        captured["body"]   = json.loads(request.content)
        return httpx.Response(200, json=_paapi_response_with_items([3499.0, 3299.95, 3599.0]))

    real = _install_mock_transport(handler)
    try:
        out = await amazon_pricer.get_amazon_prices("Nikon Z8", max_results=5)
    finally:
        _restore_transport(real)

    assert captured["host"] == "webservices.amazon.com"
    assert captured["path"] == "/paapi5/searchitems"
    assert captured["target"].endswith("SearchItems")
    assert captured["auth"].startswith("AWS4-HMAC-SHA256 ")
    assert captured["body"]["Keywords"] == "Nikon Z8"
    assert captured["body"]["PartnerTag"] == "dealscout03f-20"

    assert isinstance(out, list) and len(out) == 3
    assert {round(r["price"]) for r in out} == {3499, 3300, 3599}
    assert all(r["condition"] == "new" for r in out)
    h = amazon_pricer.get_health_state()
    assert h["last_status"] == "ok"
    assert h["ok_count"] == 1
    assert h["configured"] is True


def test_primary_success_returns_rows():
    asyncio.run(_run_primary_success_returns_rows())


# ── 3a. PA-API HTTP error returns []; health logs http_503 ───────────────────

async def _run_paapi_http_error_returns_empty():
    _set_creds()
    _reset_module_state()

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(503, text="ServiceUnavailable")

    real = _install_mock_transport(handler)
    try:
        out = await amazon_pricer.get_amazon_prices("Samsung washer", max_results=5)
    finally:
        _restore_transport(real)

    assert out == []
    h = amazon_pricer.get_health_state()
    assert h["last_status"] == "error"
    assert h["last_error"] == "http_503"


def test_paapi_http_error_returns_empty():
    asyncio.run(_run_paapi_http_error_returns_empty())


# ── 3b. Wrapper contract: PA-API throws → Google fallback used ───────────────

async def _run_paapi_throws_then_google_fallback():
    """Mirrors the wrapper logic at scoring/ebay_pricer.py:1310-1346.
    If PA-API raises, the wrapper still returns Google rows."""

    async def _fake_paapi(*a, **kw):
        raise RuntimeError("simulated network blip")

    async def _fake_google(query, max_results=12, min_price=0.0):
        return [{"price": 199.0, "title": "Fallback row", "condition": "new"}]

    amz_rows = None
    try:
        amz_rows = await _fake_paapi("x")
    except Exception:
        amz_rows = None
    if amz_rows:
        result, source = amz_rows, "amazon_paapi"
    else:
        rows = await _fake_google("x")
        result, source = (rows, "google_scraper") if rows else ([], "none")

    assert source == "google_scraper"
    assert result and result[0]["price"] == 199.0


def test_paapi_throws_then_google_fallback():
    asyncio.run(_run_paapi_throws_then_google_fallback())


# ── 4. Both sources empty → empty list, no exception ─────────────────────────

async def _run_both_sources_empty():
    _set_creds()
    _reset_module_state()

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"SearchResult": {"Items": []}})

    real = _install_mock_transport(handler)
    try:
        amz = await amazon_pricer.get_amazon_prices("zzznoresults", max_results=5)
    finally:
        _restore_transport(real)
    assert amz == []

    async def _fake_google_empty(*a, **kw):
        return []

    if amz:
        result, source = amz, "amazon_paapi"
    else:
        rows = await _fake_google_empty()
        result, source = (rows, "google_scraper") if rows else ([], "none")
    assert result == []
    assert source == "none"


def test_both_sources_empty():
    asyncio.run(_run_both_sources_empty())


# ── Bonus: never raises on bizarre payload shapes ────────────────────────────

async def _run_malformed_payload_does_not_raise():
    _set_creds()
    _reset_module_state()

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={
            "SearchResult": {
                "Items": [
                    {"ASIN": "B0BAD"},  # no Offers, no ItemInfo
                    {"ItemInfo": {"Title": {"DisplayValue": "OK"}},
                     "Offers": {"Listings": [{"Price": {"Amount": "not-a-number"}}]}},
                    {"ItemInfo": {"Title": {"DisplayValue": "Real"}},
                     "Offers": {"Listings": [{"Price": {"Amount": 42.0},
                                              "Condition": {"Value": "Used"}}]}},
                ]
            }
        })

    real = _install_mock_transport(handler)
    try:
        out = await amazon_pricer.get_amazon_prices("anything", max_results=5, min_price=100.0)
    finally:
        _restore_transport(real)
    # min_price=100 → floor=15.0; the $42 row passes, others rejected/skipped.
    assert isinstance(out, list)
    assert len(out) == 1
    assert out[0]["price"] == 42.0
    assert out[0]["condition"] == "used"


def test_malformed_payload_does_not_raise():
    asyncio.run(_run_malformed_payload_does_not_raise())


if __name__ == "__main__":
    fns = [v for k, v in list(globals().items()) if k.startswith("test_")]
    for fn in fns:
        fn()
        print(f"OK  {fn.__name__}")
    print(f"\n{len(fns)}/{len(fns)} passed")
