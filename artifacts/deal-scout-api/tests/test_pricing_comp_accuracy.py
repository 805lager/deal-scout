"""
Task #109 — Pricing & comp accuracy.

Covers the three concrete tightenings added in this task:
  1. Accessory-noise floor in clean_browse_comps — a price-proportionate floor
     anchored to the LISTING price removes cheap accessories the median-only
     floor would keep, and never wipes a real comp set (fallback).
  2. Condition-aware used split — a premium/like-new listing anchors against
     premium-tier comps when enough exist.
  3. Recommended-offer clamp — the AI offer is bounded to a defensible range
     derived from the market data (no absurd lowball, no over-asking number),
     while thin comps fall back to asking-only bounds so the thin-comp guard
     is not undone.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from scoring.ebay_pricer import clean_browse_comps, _used_tier
from scoring.deal_scorer import _clamp_recommended_offer


# ── 1. Accessory-noise floor ──────────────────────────────────────────────────

def _comp(price, condition="Used"):
    return {"price": price, "condition": condition, "title": "comp"}


def test_accessory_floor_drops_cheap_noise_median_floor_would_keep():
    """$55 accessories sit ABOVE the median*0.25 floor (=$50) but BELOW the
    listing-proportionate floor (400*0.15=$60), so only the accessory floor
    removes them. The real $200 comps survive."""
    items = [_comp(55), _comp(55), _comp(55),
             _comp(200), _comp(200), _comp(200), _comp(200)]
    cleaned, summary = clean_browse_comps(items, listing_condition="Used",
                                          listing_price=400.0)
    assert summary["count"] == 4
    assert summary["low"] >= 60
    assert all(it["price"] == 200 for it in cleaned)


def test_without_listing_price_the_accessory_noise_survives():
    """Same comp set, no listing_price → only the median floor applies, so the
    $55 accessories are NOT removed (proves the new floor is what removed them)."""
    items = [_comp(55), _comp(55), _comp(55),
             _comp(200), _comp(200), _comp(200), _comp(200)]
    cleaned, summary = clean_browse_comps(items, listing_condition="Used",
                                          listing_price=0.0)
    assert summary["count"] == 7


def test_accessory_floor_never_wipes_a_real_comp_set():
    """A wildly overpriced listing (asking 100x real value) would push the
    accessory floor above every real comp — the fallback must keep them."""
    items = [_comp(100) for _ in range(5)]
    cleaned, summary = clean_browse_comps(items, listing_condition="Used",
                                          listing_price=10_000.0)
    assert summary["count"] == 5


# ── 2. Condition-aware used split ─────────────────────────────────────────────

def test_used_tier_classification():
    assert _used_tier("Very Good") == "premium"
    assert _used_tier("Like New") == "premium"
    assert _used_tier("Open box") == "premium"
    assert _used_tier("Seller refurbished") == "premium"
    assert _used_tier("Used") == "standard"
    assert _used_tier("Acceptable") == "standard"
    assert _used_tier("Good") == "standard"
    assert _used_tier("") == ""


def test_premium_listing_anchors_against_premium_comps():
    """A like-new listing with >=3 premium comps drops the standard 'Used'
    comps so the anchor reflects comparable quality."""
    items = [_comp(100, "Very Good"), _comp(100, "Very Good"), _comp(100, "Very Good"),
             _comp(100, "Used"), _comp(100, "Used"), _comp(100, "Used")]
    cleaned, summary = clean_browse_comps(items, listing_condition="Like New",
                                          listing_price=0.0)
    assert summary["count"] == 3
    assert all(_used_tier(it["condition"]) == "premium" for it in cleaned)


def test_premium_split_skipped_when_too_few_premium_comps():
    """With <3 premium comps the split must NOT fire (would create a thin set)."""
    items = [_comp(100, "Very Good"), _comp(100, "Very Good"),
             _comp(100, "Used"), _comp(100, "Used"), _comp(100, "Used")]
    cleaned, summary = clean_browse_comps(items, listing_condition="Like New",
                                          listing_price=0.0)
    assert summary["count"] == 5


def test_standard_listing_does_not_trigger_premium_split():
    """A plain 'Used' listing keeps the whole used range."""
    items = [_comp(100, "Very Good"), _comp(100, "Very Good"), _comp(100, "Very Good"),
             _comp(100, "Used"), _comp(100, "Used"), _comp(100, "Used")]
    cleaned, summary = clean_browse_comps(items, listing_condition="Used",
                                          listing_price=0.0)
    assert summary["count"] == 6


# ── 3. Recommended-offer clamp ────────────────────────────────────────────────

_STRONG = {"sold_avg": 380.0, "sold_count": 10, "estimated_value": 380.0}


def test_clamp_leaves_sane_offer_untouched():
    out, changed = _clamp_recommended_offer(340.0, 400.0, _STRONG)
    assert changed is False
    assert out == 340.0


def test_clamp_floors_absurd_lowball():
    out, changed = _clamp_recommended_offer(20.0, 400.0, _STRONG)
    assert changed is True
    assert out == round(0.5 * min(400.0, 380.0), 2)  # 190.0


def test_clamp_ceils_over_asking_offer():
    out, changed = _clamp_recommended_offer(500.0, 400.0, _STRONG)
    assert changed is True
    assert out == 400.0


def test_clamp_caps_overpriced_listing_near_market():
    """Asking far above market → offer ceiling is ~market, not the inflated ask."""
    mv = {"sold_avg": 200.0, "sold_count": 8, "estimated_value": 200.0}
    out, changed = _clamp_recommended_offer(850.0, 1000.0, mv)
    assert changed is True
    assert out == round(200.0 * 1.15, 2)  # 230.0


def test_clamp_thin_comps_use_asking_only_bounds():
    """sold_count<3 → anchor is untrustworthy, so we clamp to asking-relative
    bounds only and never pull the offer down toward the thin comp."""
    mv = {"sold_avg": 50.0, "sold_count": 1, "estimated_value": 50.0}
    # A $200 offer on a $400 asking must NOT be dragged to ~$57 (50*1.15).
    out, changed = _clamp_recommended_offer(200.0, 400.0, mv)
    assert changed is False
    assert out == 200.0
    # But an absurd lowball is still floored at 40% of asking.
    out2, changed2 = _clamp_recommended_offer(10.0, 400.0, mv)
    assert changed2 is True
    assert out2 == round(0.4 * 400.0, 2)  # 160.0


def test_clamp_noop_without_any_anchor():
    """No market data and no asking price → nothing to clamp against."""
    out, changed = _clamp_recommended_offer(100.0, 0.0, {})
    assert changed is False
    assert out == 100.0


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
    print("All pricing & comp accuracy tests passed.")
