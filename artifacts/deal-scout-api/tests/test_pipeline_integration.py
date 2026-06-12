"""
Integration tests for the /score pipeline orchestration + the Task #113
admin/security hardening.

WHAT THIS GUARDS
----------------
These tests drive the REAL POST /score handler via FastAPI's TestClient with
every heavy dependency (Haiku product extraction, eBay pricer, product
evaluator, deal scorer, security scorer, affiliate router, DB pool, score
cache) monkeypatched to deterministic fakes. They lock in the *orchestration*
logic that lives in main.py — the score caps and adjustments applied AFTER the
individual scorers return — which unit tests on the scorers can't see:

  • happy path           — a clean listing returns the AI score untouched.
  • security cap         — a critical security score (<=3) forces should_buy
                           False and caps the deal score (main.py ~1283).
  • price-ratio cap      — asking >> market caps the score / clears should_buy
                           (main.py ~1316).
  • thin-comp path       — a single sold comp / low confidence still returns a
                           coherent response and surfaces market_confidence.
  • error response       — a pricing-pipeline failure surfaces as HTTP 500
                           rather than a 200 with garbage (main.py ~936).

Plus regression guards for Task #113:

  • /score-log GET + DELETE now require the admin token (were unauthenticated,
    exposing every scorecard's URLs/seller data and allowing a wipe).
  • the audit dashboard HTML no longer embeds the shared client API key.

If a future refactor drops a cap, re-opens an admin endpoint, or re-injects the
client key into admin HTML, one of these fails.
"""
import sys
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi.testclient import TestClient  # noqa: E402

import main as api_main  # noqa: E402
from scoring.deal_scorer import DealScore  # noqa: E402
from scoring.ebay_pricer import MarketValue  # noqa: E402
from scoring.product_evaluator import ProductEvaluation  # noqa: E402
from scoring.product_extractor import ProductInfo  # noqa: E402
from scoring.security_scorer import (  # noqa: E402
    SecurityScore,
    _score_to_recommendation,
    _score_to_risk,
)


# ── Deterministic fakes for the heavy pipeline pieces ────────────────────────


def _market(
    *,
    estimated_value: float = 200.0,
    sold_avg: float = 200.0,
    sold_count: int = 12,
    confidence: str = "high",
    new_price: float = 0.0,
    data_source: str = "ebay_browse",
    query: str = "Nikon F3 35mm film camera body",
) -> MarketValue:
    """A market-value snapshot. new_price defaults to 0 so the new-retail cap
    (main.py ~1156, only fires on real new_price) never interferes with the
    security / price-ratio caps these tests target."""
    return MarketValue(
        query_used          = query,
        sold_avg            = sold_avg,
        sold_low            = round(sold_avg * 0.8, 2),
        sold_high           = round(sold_avg * 1.2, 2),
        sold_count          = sold_count,
        active_avg          = round(sold_avg * 1.05, 2),
        active_low          = round(sold_avg * 0.9, 2),
        active_count        = max(sold_count - 2, 0),
        new_price           = new_price,
        estimated_value     = estimated_value,
        confidence          = confidence,
        sold_items_sample   = [],
        active_items_sample = [],
        data_source         = data_source,
        comp_summary        = {
            "count":  sold_count,
            "median": sold_avg,
            "low":    round(sold_avg * 0.8, 2),
            "high":   round(sold_avg * 1.2, 2),
            "outliers_removed": 0,
            "condition_mismatches_removed": 0,
            "recency_window": "last 90 days",
            "median_sold_age_days": 7,
        },
    )


def _product_info(title: str) -> ProductInfo:
    # search_query == the raw title so the handler's refinement step is skipped
    # (it only refines when the extracted query differs from the title).
    return ProductInfo(
        brand             = "Nikon",
        model             = "F3",
        category          = "Film camera",
        search_query      = title,
        amazon_query      = title,
        display_name      = title,
        confidence        = "high",
        raw_title         = title,
        extraction_method = "claude",
    )


def _product_eval() -> ProductEvaluation:
    return ProductEvaluation(
        product_name      = "Nikon F3",
        overall_rating    = 4.7,
        review_count      = 0,
        reliability_tier  = "excellent",
        known_issues      = [],
        strengths         = ["legendary build quality"],
        reddit_sentiment  = None,
        reddit_post_count = 0,
        sources_used      = ["test"],
        confidence        = "high",
    )


def _deal(*, score: int = 7, should_buy: bool = True, recommended_offer: float = 140.0) -> DealScore:
    return DealScore(
        score             = score,
        verdict           = "Good Deal",
        summary           = "Reasonable price vs sold comps.",
        value_assessment  = "Around market average.",
        condition_notes   = "Used but functional per description.",
        red_flags         = [],
        green_flags       = ["Strong reliability tier"],
        recommended_offer = recommended_offer,
        should_buy        = should_buy,
        confidence        = "medium",
        model_used        = "fake-test-model",
    )


def _security(score: int = 8) -> SecurityScore:
    return SecurityScore(
        score          = score,
        risk_level     = _score_to_risk(score),
        flags          = [],
        recommendation = _score_to_recommendation(score),
    )


# ── Clean listing payload (no trust-composite signals so the AI score passes
#    through untouched in the happy path) ──────────────────────────────────────


def _clean_payload(*, title: str, price: float, listing_url: str) -> dict:
    return {
        "title":        title,
        "price":        price,
        "description":  (
            "Classic 1980s Nikon F3 35mm film camera body in excellent working "
            "condition. Shutter fires accurately at all speeds, meter is "
            "responsive, comes with the original strap and body cap. From a "
            "smoke-free home, happy to answer questions."
        ),
        "location":     "Brooklyn, NY",
        "condition":    "Used",
        "seller_name":  "vintage_camera_works",
        "listing_url":  listing_url,
        "shipping_cost": 12.0,
        "photo_count":  8,
        # Established seller — keeps the new-account trust signal from firing.
        "seller_account_age_days": 1500,
        "platform":     "ebay",
    }


def _run_score(
    payload: dict,
    *,
    market: MarketValue = None,
    deal: DealScore = None,
    security: SecurityScore = None,
    market_raises: bool = False,
):
    """Drive the real POST /score handler with all heavy deps patched."""
    market = market if market is not None else _market()
    deal = deal if deal is not None else _deal()
    security = security if security is not None else _security()

    async def _fake_extract_product(title, description="", *a, **k):
        return _product_info(title)

    async def _fake_get_market_value(*a, **k):
        if market_raises:
            raise RuntimeError("eBay pricing pipeline unavailable")
        return market

    async def _fake_evaluate_product(*a, **k):
        return _product_eval()

    async def _fake_score_deal(listing_dict, market_value_dict, *a, **k):
        return deal

    async def _fake_score_security(*a, **k):
        return security

    async def _fake_get_pool():
        return None

    async def _fake_persist_get(*a, **k):
        return None

    client = TestClient(api_main.app)
    with \
        patch.object(api_main, "_check_api_key", new=lambda *a, **k: None), \
        patch.object(api_main, "_check_rate_limit", new=lambda *a, **k: None), \
        patch.object(api_main, "_cache_get", new=lambda *a, **k: None), \
        patch.object(api_main, "_persist_cache_get", new=_fake_persist_get), \
        patch.object(api_main, "extract_product", new=_fake_extract_product), \
        patch.object(api_main, "get_market_value", new=_fake_get_market_value), \
        patch.object(api_main, "evaluate_product", new=_fake_evaluate_product), \
        patch.object(api_main, "score_deal", new=_fake_score_deal), \
        patch.object(api_main, "score_security", new=_fake_score_security), \
        patch.object(api_main, "get_affiliate_recommendations", new=lambda *a, **k: []), \
        patch("scoring.data_pipeline._get_pool", new=_fake_get_pool):
        return client.post("/score", json=payload)


# ── Pipeline orchestration tests ─────────────────────────────────────────────


def test_score_happy_path_passes_ai_score_through():
    """Clean listing, safe seller, fair price (0.7x market): the AI's 7/10 and
    should_buy=True survive the cap/adjust gauntlet untouched, and the response
    echoes the market snapshot."""
    payload = _clean_payload(
        title="Vintage Nikon F3 35mm Film Camera Body — Happy",
        price=140.0,
        listing_url="https://www.ebay.com/itm/pipeline-happy-1",
    )
    resp = _run_score(
        payload,
        market=_market(estimated_value=200.0, sold_avg=200.0, sold_count=12, confidence="high"),
        deal=_deal(score=7, should_buy=True),
        security=_security(8),
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["score"] == 7, f"AI score should pass through, got {body['score']}"
    assert body["should_buy"] is True
    assert body["estimated_value"] == 200.0
    assert body["sold_count"] == 12
    assert body["market_confidence"] == "high"
    assert body["security_score"]["score"] == 8


def test_score_security_cap_forces_no_buy():
    """A critical security score (<=3) must force should_buy=False, cap the deal
    score at <=5, and surface a security-risk red flag — even when the AI scored
    it 8/10 and the price looks fair."""
    payload = _clean_payload(
        title="Too-Good iPhone 15 Pro Max Sealed — SecurityCap",
        price=200.0,
        listing_url="https://www.ebay.com/itm/pipeline-seccap-1",
    )
    resp = _run_score(
        payload,
        # price == estimated_value → price_ratio 1.0, so ONLY the security cap
        # is exercised (no ratio adjustment).
        market=_market(estimated_value=200.0, sold_avg=200.0, confidence="high"),
        deal=_deal(score=8, should_buy=True),
        security=_security(2),
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["should_buy"] is False, "critical security must clear should_buy"
    assert body["score"] <= 5, f"score should be capped <=5, got {body['score']}"
    assert any("security risk" in (f or "").lower() for f in body["red_flags"]), (
        f"expected a security-risk red flag, got {body['red_flags']}"
    )


def test_score_price_ratio_cap_when_overpriced():
    """Asking 2x market with a safe seller: the price-ratio adjustment caps the
    score at <=5 and clears should_buy even though the AI scored it 8/10."""
    payload = _clean_payload(
        title="Overpriced Nikon F3 Body — RatioCap",
        price=200.0,
        listing_url="https://www.ebay.com/itm/pipeline-ratio-1",
    )
    resp = _run_score(
        payload,
        market=_market(estimated_value=100.0, sold_avg=100.0, confidence="high"),
        deal=_deal(score=8, should_buy=True),
        security=_security(8),
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["score"] <= 5, f"overpriced (2x) should cap score <=5, got {body['score']}"
    assert body["should_buy"] is False


def test_score_thin_comp_path_returns_coherent_response():
    """A single sold comp + low market confidence must still produce a coherent
    200 response that surfaces the thin-comp state (does not crash or 500)."""
    payload = _clean_payload(
        title="Obscure Vintage Lens — ThinComp",
        price=100.0,
        listing_url="https://www.ebay.com/itm/pipeline-thin-1",
    )
    resp = _run_score(
        payload,
        market=_market(estimated_value=100.0, sold_avg=100.0, sold_count=1, confidence="low"),
        deal=_deal(score=6, should_buy=True),
        security=_security(8),
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["sold_count"] == 1
    assert body["market_confidence"] == "low"
    assert isinstance(body["score"], int) and 1 <= body["score"] <= 10


def test_score_pricing_failure_returns_500():
    """If the pricing pipeline raises, the handler surfaces HTTP 500 rather than
    returning a 200 with bogus market data."""
    payload = _clean_payload(
        title="Nikon F3 — PricingFailure",
        price=140.0,
        listing_url="https://www.ebay.com/itm/pipeline-err-1",
    )
    resp = _run_score(payload, market_raises=True)
    assert resp.status_code == 500, f"expected 500 on pricing failure, got {resp.status_code}"


# ── Task #113 hardening regression guards ────────────────────────────────────


def test_score_log_get_requires_admin_auth():
    """GET /score-log was unauthenticated — it exposed every scorecard (listing
    URLs / seller data). It must now require the admin token."""
    client = TestClient(api_main.app)
    resp = client.get("/score-log")  # no admin header
    assert resp.status_code in (401, 403, 503), (
        f"/score-log GET must be admin-gated, got {resp.status_code} (open access!)"
    )


def test_score_log_delete_requires_admin_auth():
    """DELETE /score-log was unauthenticated — anyone could wipe the audit log.
    It must now require the admin token."""
    client = TestClient(api_main.app)
    resp = client.delete("/score-log")  # no admin header
    assert resp.status_code in (401, 403, 503), (
        f"/score-log DELETE must be admin-gated, got {resp.status_code} (open access!)"
    )


def test_audit_dashboard_does_not_embed_client_key():
    """The audit dashboard must collect the admin token client-side and send it
    as X-Admin-Token. It must NOT embed the shared client API key (the old
    {{API_KEY}} injection) nor send the legacy X-DS-Key header."""
    client = TestClient(api_main.app)
    with patch.object(api_main, "_check_admin_auth", new=lambda *a, **k: None):
        resp = client.get("/admin/audit")
    assert resp.status_code == 200, resp.text
    html = resp.text
    assert "{{API_KEY}}" not in html, "unreplaced client-key placeholder leaked into admin HTML"
    assert "X-DS-Key" not in html, "admin dashboard still references the legacy client-key header"
    assert "X-Admin-Token" in html, "admin dashboard should authenticate via X-Admin-Token"
    # Strongest guard: the actual client key value must never appear in the
    # rendered HTML. (Asserting only on the {{API_KEY}} placeholder would pass
    # even if the injection were re-added, since the placeholder would be
    # replaced by the real key.) Guarded for the unset/empty case because
    # "" in html is always True.
    if api_main._DS_API_KEY:
        assert api_main._DS_API_KEY not in html, "client API key value leaked into admin HTML"


def test_nav_debug_get_requires_admin_auth():
    """GET /nav-debug was unauthenticated — it dumped raw extension navigation
    payloads (listing URLs). It must now require the admin token."""
    client = TestClient(api_main.app)
    resp = client.get("/nav-debug")  # no admin header
    assert resp.status_code in (401, 403, 503), (
        f"/nav-debug GET must be admin-gated, got {resp.status_code} (open access!)"
    )


def test_nav_debug_delete_requires_admin_auth():
    """DELETE /nav-debug was unauthenticated — anyone could wipe the events."""
    client = TestClient(api_main.app)
    resp = client.delete("/nav-debug")  # no admin header
    assert resp.status_code in (401, 403, 503), (
        f"/nav-debug DELETE must be admin-gated, got {resp.status_code} (open access!)"
    )


def test_diag_get_requires_admin_auth():
    """GET /diag was unauthenticated — it dumped full diagnostic reports
    (listing titles, prices, verdicts, queries). It must now require the admin
    token."""
    client = TestClient(api_main.app)
    resp = client.get("/diag")  # no admin header
    assert resp.status_code in (401, 403, 503), (
        f"/diag GET must be admin-gated, got {resp.status_code} (open access!)"
    )


def test_diag_delete_requires_admin_auth():
    """DELETE /diag was unauthenticated — anyone could wipe the reports."""
    client = TestClient(api_main.app)
    resp = client.delete("/diag")  # no admin header
    assert resp.status_code in (401, 403, 503), (
        f"/diag DELETE must be admin-gated, got {resp.status_code} (open access!)"
    )


if __name__ == "__main__":
    test_score_happy_path_passes_ai_score_through()
    test_score_security_cap_forces_no_buy()
    test_score_price_ratio_cap_when_overpriced()
    test_score_thin_comp_path_returns_coherent_response()
    test_score_pricing_failure_returns_500()
    test_score_log_get_requires_admin_auth()
    test_score_log_delete_requires_admin_auth()
    test_audit_dashboard_does_not_embed_client_key()
    test_nav_debug_get_requires_admin_auth()
    test_nav_debug_delete_requires_admin_auth()
    test_diag_get_requires_admin_auth()
    test_diag_delete_requires_admin_auth()
    print("All pipeline integration + Task #113 hardening tests passed.")
