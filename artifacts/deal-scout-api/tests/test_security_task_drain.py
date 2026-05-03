"""
Regression test for Task #77 — drain orphaned security tasks on early
/score errors.

WHAT THIS GUARDS
----------------
The /score handler launches `score_security` as an asyncio.create_task
~30 lines before the deal scorer is awaited (Task #74 win #4). If any
code between the launch and the existing cancel sites (dataclass
conversion, dict-build, refinement gather, the score_deal await itself)
raises, the security task can be left pending — uvicorn's GC then logs
"Task was destroyed but it is pending!" which pollutes prod logs and
masks real issues.

The fix wraps the body in a try/except that cancels AND awaits the task
on any error path, plus drains the task at the existing cancel sites
around the score_deal await.

This test mocks `score_deal` to raise immediately AND uses a long-
running `score_security` fake so that, without the drain, the security
task would still be pending when the request unwinds. We capture the
asyncio logger and assert no pending-task error is emitted.
"""
import asyncio
import logging
import sys
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi.testclient import TestClient  # noqa: E402

import main as api_main  # noqa: E402
from scoring.ebay_pricer import MarketValue  # noqa: E402
from scoring.product_evaluator import ProductEvaluation  # noqa: E402
from scoring.product_extractor import ProductInfo  # noqa: E402
from scoring.security_scorer import SecurityScore  # noqa: E402


def _fake_product_info() -> ProductInfo:
    return ProductInfo(
        brand            = "Generic",
        model            = "Widget",
        category         = "misc",
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
        sold_avg            = 100.0,
        sold_low            = 80.0,
        sold_high           = 120.0,
        sold_count          = 10,
        active_avg          = 110.0,
        active_low          = 90.0,
        active_count        = 5,
        new_price           = 0.0,
        estimated_value     = 100.0,
        confidence          = "high",
        sold_items_sample   = [],
        active_items_sample = [],
        data_source         = "ebay_browse",
        comp_summary        = {"count": 10, "median": 100.0, "low": 80.0, "high": 120.0,
                               "outliers_removed": 0, "condition_mismatches_removed": 0,
                               "recency_window": "last 90 days"},
    )


async def _fake_extract_product(*_a, **_kw) -> ProductInfo:
    return _fake_product_info()


async def _fake_get_market_value(*_a, **_kw) -> MarketValue:
    return _fake_market_value()


async def _fake_evaluate_product(*_a, **_kw) -> ProductEvaluation:
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


# Long-running security task — without the drain fix this is still
# pending when the handler unwinds and uvicorn's GC fires the warning.
async def _slow_score_security(*_a, **_kw) -> SecurityScore:
    await asyncio.sleep(5.0)
    return SecurityScore(score=8, risk_level="low", flags=[], recommendation="safe")


async def _raising_score_deal(*_a, **_kw):
    raise RuntimeError("forced failure for Task #77 regression test")


def _payload() -> dict:
    return {
        "title":          "Generic Widget for sale",
        "price":          50.0,
        "raw_price_text": "$50",
        "description":    "Some description.",
        "location":       "Anywhere",
        "condition":      "Used",
        "seller_name":    "test_seller",
        "listing_url":    "https://example.com/itm/task-77-regression",
        "image_urls":     [],
        "photo_count":    1,
        "platform":       "ebay",
    }


class _PendingTaskCapture(logging.Handler):
    """Captures records mentioning 'Task was destroyed but it is pending'."""
    def __init__(self):
        super().__init__(level=logging.DEBUG)
        self.matches: list[str] = []

    def emit(self, record: logging.LogRecord) -> None:
        msg = record.getMessage()
        if "Task was destroyed but it is pending" in msg:
            self.matches.append(msg)


def test_early_score_deal_failure_does_not_orphan_security_task():
    """
    Force score_deal to raise — the security task (intentionally slow)
    must be cancelled AND drained so asyncio doesn't log
    'Task was destroyed but it is pending!' when it gets GC'd.
    """
    capture = _PendingTaskCapture()
    asyncio_logger = logging.getLogger("asyncio")
    asyncio_logger.addHandler(capture)
    prev_level = asyncio_logger.level
    asyncio_logger.setLevel(logging.DEBUG)

    try:
        client = TestClient(api_main.app)
        with \
            patch.object(api_main, "_check_api_key", new=lambda *_a, **_k: None), \
            patch.object(api_main, "_check_rate_limit", new=lambda *_a, **_k: None), \
            patch.object(api_main, "extract_product", new=_fake_extract_product), \
            patch.object(api_main, "get_market_value", new=_fake_get_market_value), \
            patch.object(api_main, "evaluate_product", new=_fake_evaluate_product), \
            patch.object(api_main, "score_security", new=_slow_score_security), \
            patch.object(api_main, "score_deal", new=_raising_score_deal):
            resp = client.post("/score", json=_payload())

        # The forced RuntimeError is converted to HTTP 500 by the handler's
        # existing except RuntimeError branch.
        assert resp.status_code == 500, (
            f"expected 500 from forced score_deal failure, got {resp.status_code}: "
            f"{resp.text[:500]}"
        )

        # Force GC so any orphaned task __del__ runs and logs the warning.
        import gc
        gc.collect()
        gc.collect()

        assert not capture.matches, (
            "Security task was orphaned — asyncio logged "
            "'Task was destroyed but it is pending!'. The drain at the "
            "existing cancel sites (or the new try/except wrapper around "
            "the security launch body) is missing or broken.\n"
            f"records:\n  " + "\n  ".join(capture.matches)
        )
    finally:
        asyncio_logger.removeHandler(capture)
        asyncio_logger.setLevel(prev_level)


async def _raising_get_market_value(*_a, **_kw):
    # Simulates an exception path AFTER the security task launches but
    # BEFORE the existing cancel sites — exercises the new try/except
    # wrapper specifically (not the score_deal cancel branches).
    #
    # NOTE: get_market_value is called twice in /score — first in the
    # initial gather (before the security task launches, so this raise
    # would short-circuit before we even create the task), and again
    # during refinement (after the task launches). We need a fake that
    # succeeds on the first call and fails on the second.
    raise RuntimeError("forced refinement failure for Task #77 wrapper test")


def test_refinement_failure_does_not_orphan_security_task():
    """
    Force the refinement-stage get_market_value to raise — exercises the
    new try/except wrapper around the security launch body (not the
    pre-existing cancel sites near score_deal). Same drain assertion.
    """
    call_count = {"n": 0}

    async def _mv(*_a, **_kw):
        call_count["n"] += 1
        if call_count["n"] == 1:
            return _fake_market_value()
        raise RuntimeError("forced refinement failure for Task #77 wrapper test")

    # Force the refinement branch to fire by giving extract_product a
    # search_query that's clearly different from the raw title.
    async def _diverging_extract(*_a, **_kw):
        pi = _fake_product_info()
        pi.search_query = "completely different refined query string here"
        return pi

    capture = _PendingTaskCapture()
    asyncio_logger = logging.getLogger("asyncio")
    asyncio_logger.addHandler(capture)
    prev_level = asyncio_logger.level
    asyncio_logger.setLevel(logging.DEBUG)

    try:
        client = TestClient(api_main.app)
        with \
            patch.object(api_main, "_check_api_key", new=lambda *_a, **_k: None), \
            patch.object(api_main, "_check_rate_limit", new=lambda *_a, **_k: None), \
            patch.object(api_main, "extract_product", new=_diverging_extract), \
            patch.object(api_main, "get_market_value", new=_mv), \
            patch.object(api_main, "evaluate_product", new=_fake_evaluate_product), \
            patch.object(api_main, "score_security", new=_slow_score_security), \
            patch.object(api_main, "score_deal", new=_raising_score_deal):
            resp = client.post("/score", json={**_payload(), "title": "Short raw"})

        # Refinement failure is caught and falls back to prelim — request
        # then continues to score_deal, which raises → 500.
        assert resp.status_code == 500

        import gc
        gc.collect()
        gc.collect()

        assert not capture.matches, (
            "Security task was orphaned on a refinement-stage failure path. "
            "The new try/except wrapper around the security launch body is "
            "missing or not draining the cancelled task.\n"
            f"records:\n  " + "\n  ".join(capture.matches)
        )
    finally:
        asyncio_logger.removeHandler(capture)
        asyncio_logger.setLevel(prev_level)
