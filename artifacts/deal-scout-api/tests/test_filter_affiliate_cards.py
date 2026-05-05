"""
Regression tests for filter_affiliate_cards.

Background: shipped v0.46.0 as a defense-in-depth pass to prune bogus
affiliate items (negative keywords, refurb mismatches, sub-50%-asking
prices, weak title overlap) and stamp a confidence label. Was silently
no-op in production for months because it called `card.get(...)` on
AffiliateCard *dataclass* instances, which threw `AttributeError` and
fell into the broad `except` branch for every card.

These tests lock in:
- Works on AffiliateCard dataclass instances (the real production path)
- Works on plain dicts (legacy / future flexibility)
- Negative-keyword pruning fires
- Sub-50% asking pruning fires
- Items re-sorted by closeness to asking price
- Empty cards (all items pruned, no fallback) get dropped
- Lead cards and price_hint cards survive even with empty items
- Malformed item rows do not crash the function
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from scoring.affiliate_router import (
    AffiliateCard,
    card_get,
    card_set,
    filter_affiliate_cards,
)


def _make_card(items=None, card_type="new_retail", price_hint="",
               program_key="amazon"):
    return AffiliateCard(
        program_key=program_key,
        title="Test card",
        subtitle="",
        reason="",
        url="https://example.com",
        badge_label="Amazon",
        badge_color="#000",
        icon="🛒",
        card_type=card_type,
        commission_live=False,
        estimated_revenue=0.0,
        price_hint=price_hint,
        items=list(items or []),
    )


def test_dataclass_input_no_attribute_error():
    """The original bug: dataclass instances must not throw `'AffiliateCard'
    object has no attribute 'get'`. Negative-keyword filter must actually
    prune the case item, not let it through via the except branch."""
    card = _make_card(items=[
        {"title": "iPhone 13 Pro Case Cover", "price": 4.99},
        {"title": "Apple iPhone 13 Pro 256GB Unlocked", "price": 480.0},
    ])
    out = filter_affiliate_cards([card], asking_price=520.0,
                                 query="iPhone 13 Pro 256GB")
    assert len(out) == 1
    items = card_get(out[0], "items")
    titles = [card_get(it, "title") for it in items]
    assert "iPhone 13 Pro Case Cover" not in titles
    assert "Apple iPhone 13 Pro 256GB Unlocked" in titles
    assert card_get(out[0], "confidence_label") in ("exact", "approximate")


def test_dict_input_still_supported():
    card = {
        "program_key": "ebay",
        "card_type": "used_comp",
        "items": [
            {"title": "iPhone 13 Pro 256GB", "price": 510.0},
            {"title": "iPhone 13 case cheap", "price": 7.0},
        ],
        "price_hint": "",
    }
    out = filter_affiliate_cards([card], asking_price=500.0,
                                 query="iPhone 13 Pro")
    assert len(out) == 1
    assert out[0]["confidence_label"] == "exact"
    assert all("case" not in it["title"].lower() for it in out[0]["items"])


def test_sub_half_asking_items_pruned():
    card = _make_card(items=[
        {"title": "RYOBI 40V Mower", "price": 40.0},   # too cheap
        {"title": "RYOBI 40V Mower", "price": 200.0},  # ok
    ])
    out = filter_affiliate_cards([card], asking_price=320.0,
                                 query="RYOBI 40V Mower")
    items = card_get(out[0], "items")
    assert len(items) == 1
    assert card_get(items[0], "price") == 200.0


def test_items_resorted_by_price_fit():
    """Top item should be closest to asking, not whichever came back first."""
    card = _make_card(items=[
        {"title": "Formlabs Form 3B printer", "price": 2200.0},  # far
        {"title": "Formlabs Form 3B printer", "price": 1505.0},  # close
        {"title": "Formlabs Form 3B printer", "price": 800.0},   # mid
    ])
    out = filter_affiliate_cards([card], asking_price=1500.0,
                                 query="Formlabs Form 3B")
    items = card_get(out[0], "items")
    assert card_get(items[0], "price") == 1505.0


def test_empty_card_dropped_when_no_fallback():
    """All items pruned, not a lead, no price_hint → dropped from response."""
    card = _make_card(items=[
        {"title": "iPhone case", "price": 5.0},  # gets pruned
    ])
    out = filter_affiliate_cards([card], asking_price=500.0,
                                 query="iPhone 13 Pro")
    assert out == []


def test_lead_card_kept_with_empty_items():
    """Lead cards (autotrader CPA etc.) drive value with no item rows."""
    card = _make_card(items=[], card_type="lead")
    out = filter_affiliate_cards([card], asking_price=15000.0,
                                 query="Toyota Camry 2018")
    assert len(out) == 1
    assert card_get(out[0], "confidence_label") in ("browse", "search")


def test_price_hint_card_kept_with_empty_items():
    card = _make_card(items=[], price_hint="From $152")
    out = filter_affiliate_cards([card], asking_price=200.0,
                                 query="RYOBI mower")
    assert len(out) == 1


def test_malformed_items_do_not_crash():
    card = _make_card(items=[
        None,
        {"title": None, "price": "not-a-number"},
        {"price": 100.0},
        {"title": "iPhone 13 Pro 256GB", "price": 480.0},
    ])
    out = filter_affiliate_cards([card], asking_price=500.0,
                                 query="iPhone 13 Pro")
    assert len(out) <= 1


def test_empty_cards_list():
    assert filter_affiliate_cards([], asking_price=500.0, query="x") == []


def test_confidence_label_survives_asdict_serialization():
    """Reviewer-flagged regression guard: `confidence_label` must be a
    declared dataclass field, otherwise dataclasses.asdict() (used in
    main.py /score and /score/stream) drops it and the extension never
    sees the exact/approximate/browse/search tiering."""
    from dataclasses import asdict
    card = _make_card(items=[
        {"title": "Apple iPhone 13 Pro 256GB Unlocked", "price": 510.0},
    ])
    out = filter_affiliate_cards([card], asking_price=500.0,
                                 query="iPhone 13 Pro 256GB")
    serialized = asdict(out[0])
    assert "confidence_label" in serialized, \
        "confidence_label dropped by asdict — must be a declared field"
    assert serialized["confidence_label"] == "exact"


def test_default_confidence_label_on_unfiltered_card():
    """A freshly-built AffiliateCard (before filter runs) should already
    serialize with a confidence_label so the response shape is stable
    even if filter_affiliate_cards is bypassed for any reason."""
    from dataclasses import asdict
    card = _make_card()
    serialized = asdict(card)
    assert serialized.get("confidence_label") == "search"


if __name__ == "__main__":
    fns = [v for k, v in list(globals().items()) if k.startswith("test_")]
    for fn in fns:
        fn()
        print(f"OK  {fn.__name__}")
    print(f"\n{len(fns)}/{len(fns)} passed")
