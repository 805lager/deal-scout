"""
Tests for Security Check — Photo & Seller Trust weighting
(.local/tasks/security-check-photo-seller-weighting.md).

Covers four behaviours the task requires:
  1. Stock-photo penalty + warning — the vision-derived `is_stock_photo`
     signal, reconciled into the security card, drops the "N photos provided"
     positive, adds a warning, and applies a MODERATE (non-critical) score
     deduction.
  2. Low-rating penalty + warning — a low displayed seller rating over a
     meaningful review count produces a warning + a score deduction.
  3. Aged-account-with-poor-reviews NOT shown as a positive — bare account
     age ("Seller profile since {year}") is suppressed when the rating is
     weak/low.
  4. A clean, well-rated, real-photo listing stays high-scoring and keeps its
     legitimate positives.

The seller-rating tests run score_security() in Layer-1-only mode (Layer 2
Claude call disabled) so they are deterministic and offline.
"""
import asyncio
import sys
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from scoring.security_scorer import (  # noqa: E402
    SecurityScore,
    reconcile_stock_photo,
    score_security,
    _score_to_risk,
    _score_to_recommendation,
    _STOCK_PHOTO_DEDUCTION,
    _LOW_RATING_DEDUCTION,
)


# ── Helpers ───────────────────────────────────────────────────────────────────

def _market_value(estimated_value: float = 100.0):
    """Minimal market_value stub (only attributes score_security reads)."""
    return SimpleNamespace(
        estimated_value = estimated_value,
        sold_avg        = estimated_value,
    )


def _listing(title: str, *, seller_trust=None, photo_count=6, price=100.0):
    """
    A clean, scam-pattern-free listing object. Distinct titles keep the
    score_security in-memory cache from colliding across tests.
    """
    return SimpleNamespace(
        title        = title,
        price        = price,
        description  = "Solid condition, local pickup available. Model X, 256GB.",
        condition    = "Used - Good",
        seller_trust = seller_trust or {},
        photo_count  = photo_count,
        image_urls   = [],
        raw_text     = "",
        auction_current_bid = 0.0,
    )


def _run_security(monkeypatch, listing, category="misc", market_value=None):
    """Run score_security with Layer 2 (Claude) disabled — deterministic."""
    # No AI base url → score_security keeps anthropic_client=None → Layer 2 skipped.
    monkeypatch.setenv("AI_INTEGRATIONS_ANTHROPIC_BASE_URL", "")
    return asyncio.run(
        score_security(
            listing      = listing,
            category     = category,
            market_value = market_value or _market_value(),
            anthropic_client = None,
        )
    )


# ── 1. Stock-photo reconciliation ─────────────────────────────────────────────

def test_stock_photo_penalty_and_warning():
    """Stock photos drop the photo-count positive, add a warning, deduct score."""
    sec = SecurityScore(
        score          = 8,
        risk_level     = _score_to_risk(8),
        flags          = [],
        recommendation = _score_to_recommendation(8),
        warnings       = [],
        positives      = ["6 photos provided", "Seller rated 5/5 (30 reviews)"],
    )

    changed = reconcile_stock_photo(
        sec,
        is_stock_photo     = True,
        stock_photo_reason = "white-background studio render, no personal context",
    )

    assert changed is True

    # Photo-count positive removed; the unrelated rating positive is preserved.
    assert not any("photos provided" in p.lower() for p in sec.positives)
    assert any("seller rated" in p.lower() for p in sec.positives)

    # A concise stock-photo warning is surfaced.
    assert any("stock image" in w.lower() for w in sec.warnings)
    assert any("stock image" in f.lower() for f in sec.flags)

    # Moderate deduction (not a critical 1/10 nuke) + recomputed derived fields.
    assert sec.score == 8 - _STOCK_PHOTO_DEDUCTION
    assert sec.score >= 4  # stays out of "critical" territory on its own
    assert sec.risk_level == _score_to_risk(sec.score)
    assert sec.recommendation == _score_to_recommendation(sec.score)


def test_stock_photo_noop_when_not_stock():
    """Real photos → reconcile is a no-op (positive + score untouched)."""
    sec = SecurityScore(
        score          = 9,
        risk_level     = _score_to_risk(9),
        flags          = [],
        recommendation = _score_to_recommendation(9),
        warnings       = [],
        positives      = ["6 photos provided"],
    )
    changed = reconcile_stock_photo(sec, is_stock_photo=False, stock_photo_reason="")
    assert changed is False
    assert sec.score == 9
    assert sec.positives == ["6 photos provided"]
    assert not sec.warnings


# ── 2. Low-rating penalty + warning ───────────────────────────────────────────

def test_low_seller_rating_penalty_and_warning(monkeypatch):
    """A low displayed rating over enough reviews → warning + score deduction."""
    listing = _listing(
        "Low-rated seller widget alpha",
        seller_trust={"rating": 2.5, "rating_count": 20},
    )
    result = _run_security(monkeypatch, listing)

    # Layer-1-only clean listing would be 10; low rating pulls it down.
    assert result.score == 10 - _LOW_RATING_DEDUCTION
    assert result.score < 10
    assert any("low rating" in w.lower() for w in result.warnings)
    assert any("2.5/5" in w and "20 reviews" in w for w in result.warnings)
    # A low rating must NOT also be presented as a "Seller rated …" positive.
    assert not any("seller rated" in p.lower() for p in result.positives)


# ── 3. Aged account + poor reviews not shown as a positive ─────────────────────

def test_aged_account_with_poor_reviews_not_a_positive(monkeypatch):
    """An old account with a poor rating must not read as a green check."""
    listing = _listing(
        "Aged poorly-rated seller widget beta",
        seller_trust={"joined_date": "2015", "rating": 2.0, "rating_count": 40},
    )
    result = _run_security(monkeypatch, listing)

    # Bare account age is suppressed when the rating is weak/low.
    assert not any("seller profile since" in p.lower() for p in result.positives)
    assert not any("seller rated" in p.lower() for p in result.positives)
    # The poor rating is surfaced as a warning + deduction.
    assert any("low rating" in w.lower() for w in result.warnings)
    assert result.score < 10


def test_aged_account_with_strong_rating_keeps_rating_positive(monkeypatch):
    """An old account WITH a strong rating still earns the rating positive."""
    listing = _listing(
        "Aged well-rated seller widget gamma",
        seller_trust={"joined_date": "2015", "rating": 4.9, "rating_count": 120},
    )
    result = _run_security(monkeypatch, listing)
    assert any("seller rated" in p.lower() for p in result.positives)
    assert not any("low rating" in w.lower() for w in result.warnings)
    assert result.score >= 8


# ── 4. Clean, well-rated, real-photo listing stays high ────────────────────────

def test_clean_well_rated_real_photo_listing_stays_high(monkeypatch):
    """A clean listing with real photos + a strong rating is unaffected."""
    listing = _listing(
        "Clean well-rated real-photo widget delta",
        seller_trust={"joined_date": "2016", "rating": 4.8, "rating_count": 30},
        photo_count=6,
    )
    result = _run_security(monkeypatch, listing)

    assert result.score >= 8
    assert result.risk_level == "low"
    assert any("seller rated" in p.lower() for p in result.positives)
    assert any("photos provided" in p.lower() for p in result.positives)
    # No spurious negatives.
    assert not any("low rating" in w.lower() for w in result.warnings)
    assert not any("stock image" in w.lower() for w in result.warnings)

    # And a real-photo listing is NOT touched by stock-photo reconciliation.
    changed = reconcile_stock_photo(result, is_stock_photo=False, stock_photo_reason="")
    assert changed is False


def test_clean_listing_then_stock_photo_reconcile_drops_high_score(monkeypatch):
    """End-to-end: clean high score, then a stock-photo hit reduces it + warns."""
    listing = _listing(
        "Clean listing stock photo combo widget epsilon",
        seller_trust={"joined_date": "2016", "rating": 4.8, "rating_count": 30},
        photo_count=6,
    )
    result = _run_security(monkeypatch, listing)
    assert result.score >= 8
    high = result.score

    reconcile_stock_photo(result, is_stock_photo=True,
                          stock_photo_reason="catalog render, perfectly lit white bg")
    assert result.score == high - _STOCK_PHOTO_DEDUCTION
    assert any("stock image" in w.lower() for w in result.warnings)
    assert not any("photos provided" in p.lower() for p in result.positives)
