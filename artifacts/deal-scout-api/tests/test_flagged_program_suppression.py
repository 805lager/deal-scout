"""
Regression test for Task #96 — flagged-card suppression on /score and
/score/stream.

WHAT THIS GUARDS
----------------
Both endpoints look up `_get_flagged_programs(listing.listing_url)` and
filter the affiliate cards list to remove any card whose `program_key`
the user previously flagged on that listing. Until Task #94 the filter
called `c.get("program_key")` on AffiliateCard *dataclass* instances,
which raised AttributeError, was swallowed by a broad except, and the
suppression silently never fired in production.

This test pins both code paths end-to-end:
  - Mocks `_get_flagged_programs` to return {"amazon"}.
  - Mocks `get_affiliate_recommendations` to return two AffiliateCard
    *dataclass* instances (the real production shape) — one with
    program_key="amazon" (should be suppressed), one with
    program_key="ebay" (should remain).
  - Asserts the response's affiliate_cards excludes the flagged
    program_key and still includes the other.
"""
import json
import sys
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi.testclient import TestClient  # noqa: E402

import main as api_main  # noqa: E402
from scoring.affiliate_router import AffiliateCard  # noqa: E402
from scoring.deal_scorer import DealScore  # noqa: E402
from scoring.ebay_pricer import MarketValue  # noqa: E402
from scoring.product_evaluator import ProductEvaluation  # noqa: E402
from scoring.product_extractor import ProductInfo  # noqa: E402
from scoring.security_scorer import SecurityScore  # noqa: E402


FLAGGED_LISTING_URL = "https://example.com/itm/task-96-suppression"


def _amazon_card() -> AffiliateCard:
    return AffiliateCard(
        program_key="amazon",
        title="Amazon — buy new",
        subtitle="From $199",
        reason="Compare to your asking price",
        url="https://amazon.com/s?k=widget",
        badge_label="Amazon",
        badge_color="#FF9900",
        icon="🛒",
        card_type="lead",
        commission_live=False,
        estimated_revenue=0.0,
        price_hint="From $199",
    )


def _ebay_card() -> AffiliateCard:
    return AffiliateCard(
        program_key="ebay",
        title="eBay — used comps",
        subtitle="Recent sold prices",
        reason="See what similar items sold for",
        url="https://ebay.com/sch/?q=widget",
        badge_label="eBay",
        badge_color="#0064D2",
        icon="🏷️",
        card_type="lead",
        commission_live=False,
        estimated_revenue=0.0,
        price_hint="Around $180",
    )


def _fake_product_info() -> ProductInfo:
    return ProductInfo(
        brand            = "Generic",
        model            = "Widget",
        category         = "general",
        search_query     = "generic widget",
        amazon_query     = "generic widget",
        display_name     = "Generic Widget",
        confidence       = "high",
        raw_title        = "Generic Widget for sale",
        extraction_method= "claude",
    )


def _fake_market_value() -> MarketValue:
    return MarketValue(
        query_used          = "generic widget",
        sold_avg            = 200.0,
        sold_low            = 180.0,
        sold_high           = 220.0,
        sold_count          = 10,
        active_avg          = 210.0,
        active_low          = 190.0,
        active_count        = 5,
        new_price           = 0.0,
        estimated_value     = 200.0,
        confidence          = "high",
        sold_items_sample   = [],
        active_items_sample = [],
        data_source         = "ebay_browse",
        comp_summary        = {"count": 10, "median": 200.0, "low": 180.0, "high": 220.0,
                               "outliers_removed": 0, "condition_mismatches_removed": 0,
                               "recency_window": "last 90 days"},
    )


def _fake_eval() -> ProductEvaluation:
    return ProductEvaluation(
        product_name      = "Generic Widget",
        overall_rating    = 4.0,
        review_count      = 0,
        reliability_tier  = "good",
        known_issues      = [],
        strengths         = [],
        reddit_sentiment  = None,
        reddit_post_count = 0,
        sources_used      = ["test"],
        confidence        = "high",
    )


def _fake_security() -> SecurityScore:
    return SecurityScore(score=8, risk_level="low", flags=[], recommendation="safe")


def _fake_deal_score() -> DealScore:
    return DealScore(
        score=7, verdict="Fair Deal",
        summary="Reasonably priced.", value_assessment="OK", condition_notes="",
        red_flags=[], green_flags=[], recommended_offer=180.0, should_buy=True,
        confidence="high", model_used="test",
        affiliate_category="general",
    )


async def _fake_extract_product(*_a, **_kw) -> ProductInfo:
    return _fake_product_info()


async def _fake_get_market_value(*_a, **_kw) -> MarketValue:
    return _fake_market_value()


async def _fake_evaluate_product(*_a, **_kw) -> ProductEvaluation:
    return _fake_eval()


async def _fake_score_security(*_a, **_kw) -> SecurityScore:
    return _fake_security()


async def _fake_score_deal(*_a, **_kw) -> DealScore:
    return _fake_deal_score()


async def _fake_get_flagged_programs(listing_url: str) -> set:
    if listing_url == FLAGGED_LISTING_URL:
        return {"amazon"}
    return set()


async def _fake_persist_cache_get(*_a, **_kw):
    return None


async def _no_pool(*_a, **_kw):
    # Returning None short-circuits every DB writer in main.py
    # (deal_scores save, ScoreCache write, score_log save, etc.) so
    # the test doesn't trip "Event loop is closed" / asyncpg warnings
    # when TestClient tears down between requests.
    return None


async def _fake_extract_listing_and_product(*_a, **_kw):
    extracted = {
        "title":          "Generic Widget for sale",
        "price":          200.0,
        "description":    "A widget.",
        "location":       "Anywhere",
        "condition":      "Used",
        "seller_name":    "test_seller",
        "is_multi_item":  False,
        "is_vehicle":     False,
        "shipping_cost":  0,
        "photo_count":    1,
    }
    return extracted, _fake_product_info()


def _get_affiliate_recs(**_kw) -> list:
    # Real call site is sync; return both cards as dataclass instances —
    # the production shape that the original bug never accepted.
    return [_amazon_card(), _ebay_card()]


def _score_payload(url: str = FLAGGED_LISTING_URL) -> dict:
    return {
        "title":          "Generic Widget for sale",
        "price":          200.0,
        "raw_price_text": "$200",
        "description":    "A widget.",
        "location":       "Anywhere",
        "condition":      "Used",
        "seller_name":    "test_seller",
        "listing_url":    url,
        "image_urls":     [],
        "photo_count":    1,
        "platform":       "ebay",
    }


def _stream_payload(url: str = FLAGGED_LISTING_URL) -> dict:
    return {
        "raw_text":    "Generic Widget for sale\n$200\nUsed\nAnywhere",
        "image_urls":  [],
        "photo_count": 1,
        "platform":    "ebay",
        "listing_url": url,
    }


def _common_patches():
    from scoring import data_pipeline as _dp
    return [
        patch.object(api_main, "_check_api_key", new=lambda *_a, **_k: None),
        patch.object(api_main, "_check_rate_limit", new=lambda *_a, **_k: None),
        patch.object(api_main, "_cache_get", new=lambda *_a, **_k: None),
        patch.object(api_main, "_persist_cache_get", new=_fake_persist_cache_get),
        patch.object(api_main, "extract_product", new=_fake_extract_product),
        patch.object(api_main, "get_market_value", new=_fake_get_market_value),
        patch.object(api_main, "evaluate_product", new=_fake_evaluate_product),
        patch.object(api_main, "score_security", new=_fake_score_security),
        patch.object(api_main, "score_deal", new=_fake_score_deal),
        patch.object(api_main, "get_affiliate_recommendations",
                     new=_get_affiliate_recs),
        patch.object(api_main, "_get_flagged_programs",
                     new=_fake_get_flagged_programs),
        # Silence DB persistence noise (deal_scores save, ScoreCache
        # write, score_log save) — they all defensively check the
        # pool and skip cleanly when it's None.
        patch.object(_dp, "_get_pool", new=_no_pool),
    ]


def test_score_endpoint_suppresses_flagged_program():
    client = TestClient(api_main.app)
    patches = _common_patches()
    for p in patches:
        p.start()
    try:
        resp = client.post("/score", json=_score_payload())
    finally:
        for p in patches:
            p.stop()

    assert resp.status_code == 200, f"got {resp.status_code}: {resp.text[:500]}"
    body = resp.json()
    cards = body.get("affiliate_cards") or []
    keys = [c.get("program_key") for c in cards]
    assert "amazon" not in keys, (
        f"flagged 'amazon' card was not suppressed by /score; cards={keys}"
    )
    assert "ebay" in keys, (
        f"non-flagged 'ebay' card was wrongly dropped by /score; cards={keys}"
    )


def test_score_endpoint_keeps_all_cards_when_nothing_flagged():
    """Sanity guard: with no flags, both cards must come through —
    proves the test plumbing isn't dropping cards on its own."""
    client = TestClient(api_main.app)
    patches = _common_patches()
    for p in patches:
        p.start()
    try:
        resp = client.post(
            "/score",
            json=_score_payload(url="https://example.com/itm/no-flags-here"),
        )
    finally:
        for p in patches:
            p.stop()

    assert resp.status_code == 200, f"got {resp.status_code}: {resp.text[:500]}"
    keys = [c.get("program_key") for c in (resp.json().get("affiliate_cards") or [])]
    assert "amazon" in keys and "ebay" in keys, (
        f"unflagged URL must keep both cards; got {keys}"
    )


def _parse_sse_score_event(text: str) -> dict:
    """Pull the final 'score' event payload out of an SSE body."""
    score_data = None
    for line in text.splitlines():
        if not line.startswith("data: "):
            continue
        try:
            obj = json.loads(line[len("data: "):])
        except json.JSONDecodeError:
            continue
        if obj.get("type") == "score":
            score_data = obj.get("data") or {}
    assert score_data is not None, f"no 'score' SSE event in stream:\n{text[:2000]}"
    return score_data


def test_score_stream_endpoint_suppresses_flagged_program():
    client = TestClient(api_main.app)
    # /score/stream uses extract_listing_and_product (imported inside the
    # handler from scoring.listing_extractor) instead of extract_product.
    from scoring import listing_extractor as _le
    patches = _common_patches() + [
        patch.object(_le, "extract_listing_and_product",
                     new=_fake_extract_listing_and_product),
    ]

    for p in patches:
        p.start()
    try:
        resp = client.post("/score/stream", json=_stream_payload())
    finally:
        for p in patches:
            p.stop()

    assert resp.status_code == 200, f"got {resp.status_code}: {resp.text[:500]}"
    score_data = _parse_sse_score_event(resp.text)
    cards = score_data.get("affiliate_cards") or []
    keys = [c.get("program_key") for c in cards]
    assert "amazon" not in keys, (
        f"flagged 'amazon' card was not suppressed by /score/stream; cards={keys}"
    )
    assert "ebay" in keys, (
        f"non-flagged 'ebay' card was wrongly dropped by /score/stream; cards={keys}"
    )


if __name__ == "__main__":
    fns = [v for k, v in list(globals().items()) if k.startswith("test_")]
    for fn in fns:
        fn()
        print(f"OK  {fn.__name__}")
    print(f"\n{len(fns)}/{len(fns)} passed")
