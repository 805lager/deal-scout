"""
Tests for the Security Scoring Upgrade
(.local/tasks/security-scoring-upgrade.md).

Covers the pieces wired into security_scorer.py on top of the photo/seller
weighting work:
  1. Expanded rule-based scam coverage (verification-code/Google-Voice
     account-takeover, courier/agent payment, "business account" upgrade) with
     veto flags.
  2. Hard veto — a strong rule scam signal caps the merged final score even
     when other signals are clean.
  3. Trust positives the scorer never used: identity_verified (+ small nudge)
     and items_sold (positive only).
  4. Graduated new-account penalty (bounded, decays to zero by 90 days).
  5. Slow-response vs urgency contradiction warning.
  6. Injection robustness — page-text prioritization keeps item specifics over
     boilerplate when truncating, and the expected-AI-fields allow-list exists.

The score_security tests run in Layer-1-only mode (Claude disabled) so they
are deterministic and offline. The new-account tests monkeypatch the shared
account-age parser so they do not depend on the wall clock.
"""
import asyncio
import sys
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import scoring.trust as _trust_mod  # noqa: E402
from scoring.security_scorer import (  # noqa: E402
    run_layer1,
    score_security,
    _prioritize_page_text,
    _score_to_risk,
    _VETO_SCORE_CAP,
    _IDENTITY_VERIFIED_BONUS,
    _ESTABLISHED_ITEMS_SOLD,
    _NEW_ACCT_WINDOW_DAYS,
    _EXPECTED_AI_FIELDS,
)


# ── Helpers ───────────────────────────────────────────────────────────────────

def _market_value(estimated_value: float = 100.0):
    return SimpleNamespace(estimated_value=estimated_value, sold_avg=estimated_value)


def _listing(title: str, *, description="Solid condition, local pickup available.",
             seller_trust=None, photo_count=6, price=100.0, raw_text=""):
    return SimpleNamespace(
        title        = title,
        price        = price,
        description  = description,
        condition    = "Used - Good",
        seller_trust = seller_trust or {},
        photo_count  = photo_count,
        image_urls   = [],
        raw_text     = raw_text,
        auction_current_bid = 0.0,
    )


def _run_security(monkeypatch, listing, category="misc", market_value=None):
    """Run score_security with Layer 2 (Claude) disabled — deterministic."""
    monkeypatch.setenv("AI_INTEGRATIONS_ANTHROPIC_BASE_URL", "")
    return asyncio.run(
        score_security(
            listing      = listing,
            category     = category,
            market_value = market_value or _market_value(),
            anthropic_client = None,
        )
    )


# ── 1. Expanded scam-pattern coverage ─────────────────────────────────────────

def test_new_scam_patterns_detected_with_veto():
    """Each new high-confidence scam phrasing fires a veto-marked Layer-1 flag."""
    cases = [
        "please send me the google voice verification code i just texted you",
        "i'll have my own courier come pick it up once you've paid",
        "you'll need to upgrade to a zelle business account to receive payment",
    ]
    for txt in cases:
        flags = run_layer1(
            listing_text  = txt,
            title         = "",
            category      = "misc",
            listing_price = 100.0,
            market_value  = None,
        )
        assert any(f.get("veto") for f in flags), f"no veto flag for: {txt!r}"


def test_will_ship_escalates_for_heavy_local_only_category():
    """A 'will ship' offer is a stronger flag for heavy/local-only goods."""
    txt = "I can ship this to you, just pay first."
    heavy = run_layer1(listing_text=txt, title="", category="furniture",
                       listing_price=100.0, market_value=None)
    assert any("heavy/local-pickup" in f["flag"].lower() or f["severity"] == "high"
               for f in heavy)


# ── 2. Hard veto caps the merged score ────────────────────────────────────────

def test_veto_caps_score_even_with_strong_rating(monkeypatch):
    """A strong rule scam signal caps the final score below the veto ceiling."""
    listing = _listing(
        "Veto widget theta",
        description="Great phone. Please pay via Zelle to reserve it.",
        seller_trust={"rating": 4.9, "rating_count": 80},  # clean otherwise
    )
    result = _run_security(monkeypatch, listing)
    assert result.score <= _VETO_SCORE_CAP
    assert result.risk_level in ("high", "critical")


def test_no_veto_keeps_clean_listing_high(monkeypatch):
    """A clean listing without any veto pattern is not capped."""
    listing = _listing(
        "Clean no-veto widget kappa",
        seller_trust={"rating": 4.8, "rating_count": 40},
    )
    result = _run_security(monkeypatch, listing)
    assert result.score > _VETO_SCORE_CAP


# ── 3. Identity-verified + items-sold positives ───────────────────────────────

def test_identity_verified_bonus_and_positive(monkeypatch):
    """identity_verified adds a positive and a small upward nudge."""
    monkeypatch.setattr(_trust_mod, "_parse_joined_date_to_age_days", lambda s: 800)
    base = _run_security(
        monkeypatch,
        _listing("Identity base widget lam", seller_trust={"rating": 4.6, "rating_count": 30}),
    )
    verified = _run_security(
        monkeypatch,
        _listing("Identity verified widget mu",
                 seller_trust={"rating": 4.6, "rating_count": 30, "identity_verified": True}),
    )
    assert any("identity verified" in p.lower() for p in verified.positives)
    assert verified.score >= min(10, base.score + _IDENTITY_VERIFIED_BONUS)


def test_items_sold_positive(monkeypatch):
    """A seller with a meaningful sales history earns a positive (no penalty)."""
    monkeypatch.setattr(_trust_mod, "_parse_joined_date_to_age_days", lambda s: 800)
    listing = _listing(
        "Established seller widget nu",
        seller_trust={"rating": 4.7, "rating_count": 30, "items_sold": _ESTABLISHED_ITEMS_SOLD + 10},
    )
    result = _run_security(monkeypatch, listing)
    assert any("items sold" in p.lower() for p in result.positives)


# ── 4. Graduated new-account penalty ──────────────────────────────────────────

def test_new_account_graduated_penalty(monkeypatch):
    """A brand-new account incurs a bounded standalone deduction + warning."""
    monkeypatch.setattr(_trust_mod, "_parse_joined_date_to_age_days", lambda s: 10)
    listing = _listing("Brand new account widget xi",
                       seller_trust={"joined_date": "recently"})
    result = _run_security(monkeypatch, listing)
    assert any("new seller account" in w.lower() for w in result.warnings)
    assert result.score < 10
    # New account must NOT also read as a "Seller profile since…" positive.
    assert not any("seller profile since" in p.lower() for p in result.positives)


def test_established_account_no_new_account_penalty(monkeypatch):
    """An aged account gets no new-account penalty/warning."""
    monkeypatch.setattr(_trust_mod, "_parse_joined_date_to_age_days",
                        lambda s: _NEW_ACCT_WINDOW_DAYS * 5)
    listing = _listing("Aged account widget omicron",
                       seller_trust={"joined_date": "2015"})
    result = _run_security(monkeypatch, listing)
    assert not any("new seller account" in w.lower() for w in result.warnings)


# ── 5. Slow-response vs urgency contradiction ─────────────────────────────────

def test_slow_response_with_urgency_flagged(monkeypatch):
    """Slow documented response + urgency language → contradiction warning."""
    monkeypatch.setattr(_trust_mod, "_parse_joined_date_to_age_days", lambda s: 800)
    listing = _listing(
        "Slow urgent widget pi",
        description="Must sell today, act now, it won't last!",
        seller_trust={"rating": 4.8, "rating_count": 30, "response_time": "within a few days"},
    )
    result = _run_security(monkeypatch, listing)
    assert any("bait pattern" in w.lower() or "slow seller response" in w.lower()
               for w in result.warnings)


def test_fast_response_no_contradiction(monkeypatch):
    """Urgency alone (with a fast responder) does not raise the contradiction."""
    monkeypatch.setattr(_trust_mod, "_parse_joined_date_to_age_days", lambda s: 800)
    listing = _listing(
        "Fast urgent widget rho",
        description="Act now, won't last!",
        seller_trust={"rating": 4.8, "rating_count": 30, "response_time": "within minutes"},
    )
    result = _run_security(monkeypatch, listing)
    assert not any("bait pattern" in w.lower() for w in result.warnings)


# ── 6. Injection robustness ───────────────────────────────────────────────────

def test_prioritize_page_text_keeps_specifics_over_boilerplate():
    """Item specifics survive truncation even when buried under boilerplate."""
    boiler_lines = [
        "Privacy policy and cookie notice. All rights reserved.",
        "Sign in to your account to subscribe to our newsletter.",
        "You may also like these related items. Back to top.",
    ] * 30
    specifics_lines = [
        "Item specifics",
        "Brand: Sony",
        "Model: WH-1000XM4",
        "Color: Black",
    ]
    raw = "\n".join(boiler_lines + specifics_lines)
    out = _prioritize_page_text(raw, budget=300)
    assert "brand" in out.lower()
    assert "model" in out.lower()


def test_expected_ai_fields_allowlist_present():
    """The off-schema rejection allow-list is defined and sane."""
    assert "score" in _EXPECTED_AI_FIELDS
    assert "flags" in _EXPECTED_AI_FIELDS
    # A surprise key like 'note' (a classic injection steer) is NOT allowed.
    assert "note" not in _EXPECTED_AI_FIELDS
