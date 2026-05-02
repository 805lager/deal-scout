"""
Regression test for the auction-only price-snapshot in /score/stream
(Task #60 follow-up, Task #64).

WHAT THIS GUARDS
----------------
For pure eBay auctions, /score/stream overwrites `listing.price` with the
derived `suggested_max_bid` so downstream scoring (security + deal scorer)
sees "fair price at the bid ceiling" instead of "$current_bid vs market =
scam." See main.py ~line 1712.

That mutation is correct for SCORING. It is wrong for NEGOTIATION
LEVERAGE — the leverage evaluator computes price-drop magnitude from
`original_price` (strikethrough peak) → `price` (current asking). If we
hand it the post-mutation price, motivation_level can flip silently
between /score and /score/stream on the same DOM payload, driving the
buyer to lowball based on a fake mega-drop.

The fix (main.py ~1608 + ~1976) snapshots `_asking_price_for_leverage`
BEFORE the override and overlays it back into the listing dump used for
the leverage call. This test locks that contract in by:

  1. Driving the REAL /score/stream endpoint via FastAPI's TestClient
     with all heavy deps (Claude extraction, eBay pricer, deal scorer,
     security scorer, affiliate router, DB pool) monkeypatched to
     deterministic fakes.
  2. Sending an eBay auction-only payload tuned so the auction override
     would produce a different leverage result than the buyer's seen
     asking price.
  3. Asserting the streamed response's `leverage_signals` and
     `motivation_level` match what evaluate_leverage produces directly
     on the equivalent /score listing payload (i.e. with `price` set to
     the buyer-visible asking price, not the override).

If a future refactor removes the snapshot or the overlay in main.py,
the streamed leverage_signals will diverge from the direct evaluation
and this test fails.
"""
import asyncio
import json
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

# Imported here so the test file can be run standalone (python tests/...)
# without pytest. The fastapi TestClient is already a dependency
# (fastapi >= 0.111 in requirements.txt).
from fastapi.testclient import TestClient  # noqa: E402

import main as api_main  # noqa: E402
from scoring.deal_scorer import DealScore  # noqa: E402
from scoring.ebay_pricer import MarketValue  # noqa: E402
from scoring.leverage import evaluate_leverage  # noqa: E402
from scoring.product_evaluator import ProductEvaluation  # noqa: E402
from scoring.product_extractor import ProductInfo  # noqa: E402
from scoring.security_scorer import SecurityScore  # noqa: E402


# ── Fixed inputs that exercise the auction snapshot meaningfully ─────────────
#
# The buyer sees an asking price of $87 (current bid). The strikethrough
# original_price is $300 — a real, prior reduction the seller chose. The
# listing has been up 20 days (stale at typical-time-to-sell of 7).
#
# /score's leverage path will see price=$87, original_price=$300 → 71% drop
# → motivation_level="high" (stale + big drop).
#
# /score/stream's auction-only override sets listing.price to
# round(sold_avg * 0.85) = round(450 * 0.85) = $382 BEFORE the leverage
# call. Without the snapshot+overlay, evaluate_leverage would see
# price=$382 with original_price=$300, the synthetic drop fallback would
# not fire (peak=max($300, $382)=$382 == current), and motivation_level
# would degrade to "medium" (stale alone, no drop). The snapshot is what
# keeps the streaming output at "high".
ASKING_PRICE_BUYER_SEES = 87.0
ORIGINAL_PRICE          = 300.0
DAYS_LISTED             = 20
SOLD_AVG                = 450.0
EXPECTED_SUGGESTED_MAX  = round(SOLD_AVG * 0.85)  # 382 — what main.py computes
TYPICAL_DAYS_TO_SELL    = 7

LISTING_URL = "https://www.ebay.com/itm/auction-test-12345"


# ── Fakes for the heavy pipeline pieces ──────────────────────────────────────


def _fake_product_info() -> ProductInfo:
    return ProductInfo(
        brand            = "Nikon",
        model            = "F3",
        category         = "Film camera",
        search_query     = "Nikon F3 35mm film camera body",
        amazon_query     = "Nikon F3 film camera",
        display_name     = "Nikon F3 Film Camera",
        confidence       = "high",
        raw_title        = "Vintage Nikon F3 35mm Film Camera Body",
        extraction_method= "claude",
    )


def _fake_extracted() -> dict:
    """Shape that extract_listing_and_product would normally return."""
    return {
        "title":          "Vintage Nikon F3 35mm Film Camera Body",
        "price":          ASKING_PRICE_BUYER_SEES,  # current bid (auction)
        "description":    "Classic 1980s Nikon F3 in working condition. Comes with original strap.",
        "location":       "Brooklyn, NY",
        "condition":      "Used",
        "seller_name":    "vintage_camera_works",
        "shipping_cost":  15.0,
        "photo_count":    8,
        "is_multi_item":  False,
        "is_vehicle":     False,
        "original_price": ORIGINAL_PRICE,  # strikethrough peak
    }


async def _fake_extract_listing_and_product(*_args, **_kwargs):
    return _fake_extracted(), _fake_product_info()


async def _fake_get_market_value(*_args, **_kwargs) -> MarketValue:
    return MarketValue(
        query_used      = "Nikon F3 35mm film camera body",
        sold_avg        = SOLD_AVG,
        sold_low        = 380.0,
        sold_high       = 520.0,
        sold_count      = 14,
        active_avg      = 470.0,
        active_low      = 410.0,
        active_count    = 9,
        new_price       = 0.0,
        estimated_value = SOLD_AVG,
        confidence      = "high",
        sold_items_sample   = [],
        active_items_sample = [],
        data_source     = "ebay_browse",
        comp_summary    = {
            "count":  14,
            "median": SOLD_AVG,
            "low":    380.0,
            "high":   520.0,
            "outliers_removed": 0,
            "condition_mismatches_removed": 0,
            "recency_window": "last 90 days",
            # leverage.derive_typical_days_to_sell pulls from this:
            "median_sold_age_days": TYPICAL_DAYS_TO_SELL,
        },
    )


async def _fake_evaluate_product(*_args, **_kwargs) -> ProductEvaluation:
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


async def _fake_score_deal(listing_dict, market_value_dict, **_kwargs) -> DealScore:
    # The deal scorer ordinarily reads listing_dict["price"] (post-override
    # in the streaming path). For this test we don't care what score it
    # returns — only that the leverage signals attached to the response
    # respect the original asking price. Return a benign mid-range deal.
    return DealScore(
        score             = 6,
        verdict           = "Fair Deal",
        summary           = "Bid ceiling looks reasonable vs sold comps.",
        value_assessment  = "Around market average.",
        condition_notes   = "Used but functional per description.",
        red_flags         = [],
        green_flags       = ["Strong reliability tier"],
        recommended_offer = float(listing_dict.get("price", 0)),
        should_buy        = True,
        confidence        = "medium",
        model_used        = "fake-test-model",
    )


async def _fake_score_security(*_args, **_kwargs) -> SecurityScore:
    return SecurityScore(
        score          = 8,
        risk_level     = "low",
        flags          = [],
        recommendation = "safe to proceed",
    )


def _fake_get_affiliate_recommendations(*_args, **_kwargs):
    return []


async def _fake_get_pool():
    """No DB in tests. Streaming endpoint's DB save block is wrapped in
    try/except so a None pool is handled gracefully (it skips the insert)."""
    return None


# ── Helpers ──────────────────────────────────────────────────────────────────


def _parse_sse_score_event(body: str) -> dict:
    """Pull the final {type:"score"} event out of an SSE stream body."""
    score_payload = None
    for line in body.splitlines():
        if not line.startswith("data: "):
            continue
        try:
            evt = json.loads(line[len("data: "):])
        except json.JSONDecodeError:
            continue
        if evt.get("type") == "score":
            score_payload = evt.get("data") or {}
    if score_payload is None:
        raise AssertionError(
            f"No 'score' event found in SSE stream. Body was:\n{body[:2000]}"
        )
    return score_payload


def _expected_leverage_for_score_endpoint() -> dict:
    """
    What /score's leverage path produces on the same DOM payload — i.e.
    evaluate_leverage with `price` set to what the buyer sees (no
    auction override). This is the parity reference.
    """
    listing_for_score = {
        "title":          "Vintage Nikon F3 35mm Film Camera Body",
        "price":          ASKING_PRICE_BUYER_SEES,
        "original_price": ORIGINAL_PRICE,
        "days_listed":    DAYS_LISTED,
        "platform":       "ebay",
    }
    return evaluate_leverage(
        listing              = listing_for_score,
        typical_days_to_sell = TYPICAL_DAYS_TO_SELL,
    ).to_response_dict()["leverage_signals"]


def _run_stream_with_patches(raw_payload: dict) -> dict:
    """
    Drive the real /score/stream handler with all heavy deps patched.
    Returns the parsed score-event data dict.
    """
    client = TestClient(api_main.app)

    # NOTE on patch targets:
    #   - extract_listing_and_product is imported lazily inside the handler
    #     from scoring.listing_extractor — patch the source module.
    #   - get_market_value, evaluate_product, score_deal, score_security,
    #     get_affiliate_recommendations are bound onto `main` at module
    #     import time — patch them on `api_main`.
    #   - _get_pool is imported lazily inside the handler from
    #     scoring.data_pipeline — patch the source module.
    with \
        patch.object(api_main, "_check_api_key", new=lambda *_a, **_k: None), \
        patch.object(api_main, "_check_rate_limit", new=lambda *_a, **_k: None), \
        patch("scoring.listing_extractor.extract_listing_and_product",
              new=_fake_extract_listing_and_product), \
        patch.object(api_main, "get_market_value", new=_fake_get_market_value), \
        patch.object(api_main, "evaluate_product", new=_fake_evaluate_product), \
        patch.object(api_main, "score_deal", new=_fake_score_deal), \
        patch.object(api_main, "score_security", new=_fake_score_security), \
        patch.object(api_main, "get_affiliate_recommendations",
                     new=_fake_get_affiliate_recommendations), \
        patch("scoring.data_pipeline._get_pool", new=_fake_get_pool):
        # Use a unique URL so the in-memory + persistent caches both miss.
        resp = client.post("/score/stream", json=raw_payload)
    assert resp.status_code == 200, f"non-200 from /score/stream: {resp.status_code} {resp.text[:500]}"
    return _parse_sse_score_event(resp.text)


def _auction_only_raw_payload() -> dict:
    """RawListingRequest payload for the streaming endpoint."""
    return {
        "raw_text":         "Vintage Nikon F3 35mm Film Camera Body. Current bid $87. Time left 2d 14h. Originally $300.",
        "image_urls":       [],
        "platform":         "ebay",
        "listing_url":      LISTING_URL,
        "is_auction":       True,
        "current_bid":      ASKING_PRICE_BUYER_SEES,
        "bid_count":        3,
        "time_left_text":   "2d 14h",
        "has_buy_it_now":   False,
        "buy_it_now_price": 0.0,
        # Task #60 leverage inputs from the DOM extractor:
        "original_price":   ORIGINAL_PRICE,
        "days_listed":      DAYS_LISTED,
        "listed_at":        f"{DAYS_LISTED} days ago",
        "price_history":    None,
    }


# ── Tests ────────────────────────────────────────────────────────────────────


def test_auction_stream_leverage_matches_score_endpoint_baseline():
    """
    REAL /score/stream end-to-end: leverage_signals + motivation_level on
    an auction-only listing must equal what evaluate_leverage produces on
    the same DOM payload at the buyer's seen asking price.

    If main.py drops the asking-price snapshot or the overlay before
    calling evaluate_leverage, this assertion fails.
    """
    expected_signals = _expected_leverage_for_score_endpoint()
    score_data = _run_stream_with_patches(_auction_only_raw_payload())

    actual_signals = score_data.get("leverage_signals") or {}
    assert actual_signals == expected_signals, (
        "Streaming /score/stream leverage_signals diverged from the /score "
        "baseline on an identical eBay auction payload. The asking-price "
        "snapshot (main.py ~1608) or its overlay into the leverage call "
        "(main.py ~1977) was likely dropped or refactored.\n"
        f"expected={expected_signals}\n"
        f"actual  ={actual_signals}"
    )

    # motivation_level is also surfaced top-level on the response — must match.
    assert score_data.get("motivation_level") == expected_signals["motivation_level"], (
        f"top-level motivation_level={score_data.get('motivation_level')!r} "
        f"diverged from leverage_signals.motivation_level="
        f"{expected_signals['motivation_level']!r}"
    )

    # Sanity guard on the fixture: the parity assertion is only meaningful
    # if the auction override would actually move the price. Verify the
    # streamed response reflects the override in the deal-side fields
    # (auction_advice surfaces the suggested_max we expect main.py to derive).
    advice = score_data.get("auction_advice") or {}
    assert advice.get("is_auction") is True, (
        "auction_advice.is_auction is False — the auction-only branch did "
        "not fire, so this test isn't actually exercising the snapshot. "
        "Check that the raw payload sets is_auction=True with no BIN."
    )
    assert advice.get("suggested_max_bid") == EXPECTED_SUGGESTED_MAX, (
        f"auction override changed: expected suggested_max_bid="
        f"{EXPECTED_SUGGESTED_MAX}, got {advice.get('suggested_max_bid')}. "
        f"If the formula in main.py changed, update EXPECTED_SUGGESTED_MAX "
        f"and the fixture so the snapshot is still meaningfully tested."
    )

    # Sanity guard: the expected motivation must be "high" — that's the
    # outcome that DEPENDS on the snapshot. If this ever drifts to
    # "medium"/"low" on this fixture, the parity test above can pass
    # vacuously (because the broken & correct paths would happen to
    # collapse to the same bucket).
    assert expected_signals["motivation_level"] == "high", (
        f"Expected motivation_level=='high' on the test fixture (stale "
        f"listing + 71% drop), got {expected_signals['motivation_level']!r}. "
        f"Re-tune the fixture so the snapshot is meaningfully tested."
    )


def test_dropping_the_snapshot_would_change_leverage_output():
    """
    Negative guard. We re-derive what evaluate_leverage WOULD return if
    the snapshot were dropped (i.e. it saw the post-override price), and
    assert it differs from the /score baseline. If this test fails, the
    main parity assertion above is no longer meaningfully guarding the
    snapshot — the broken path and the correct path collapse to the
    same output for this fixture and we need to re-tune.
    """
    baseline = _expected_leverage_for_score_endpoint()

    listing_post_override = {
        "title":          "Vintage Nikon F3 35mm Film Camera Body",
        "price":          float(EXPECTED_SUGGESTED_MAX),  # what listing.price becomes
        "original_price": ORIGINAL_PRICE,
        "days_listed":    DAYS_LISTED,
        "platform":       "ebay",
    }
    broken = evaluate_leverage(
        listing              = listing_post_override,
        typical_days_to_sell = TYPICAL_DAYS_TO_SELL,
    ).to_response_dict()["leverage_signals"]

    assert broken != baseline, (
        "Without the snapshot, leverage_signals would be IDENTICAL to /score "
        "on this fixture — meaning the parity test above can't actually "
        "catch the regression. Adjust the fixture (raise ORIGINAL_PRICE or "
        "lower SOLD_AVG so the override moves price further) until the "
        "broken path produces a different motivation_level / drop_pct."
    )
    assert broken["motivation_level"] != baseline["motivation_level"], (
        "Without the snapshot, motivation_level would still match "
        f"({broken['motivation_level']!r}). The fixture needs to be tuned "
        f"so the override actually flips the bucket."
    )


if __name__ == "__main__":
    test_auction_stream_leverage_matches_score_endpoint_baseline()
    test_dropping_the_snapshot_would_change_leverage_output()
    print("All auction-leverage snapshot regression tests passed.")
