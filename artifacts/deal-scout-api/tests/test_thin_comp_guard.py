"""
Regression test for the thin-comp guard in scoring/deal_scorer.py.

When a listing's market data has confidence="low" and sold_count <= 2, the
scorer must strip comp-driven language from red_flags / summary / verdict,
floor the score if it was anchored to thin comps, and floor
recommended_offer at 50% of asking price.

Real-world payload: user-reported nephrite jade money toad listing
($399 + $60.51 ship, 25 lb hand-carved stone, 1 comp at $50, confidence=low)
that was scored 2/10 AVOID with red_flag "Price 819% above eBay sold
average" and recommended_offer $85.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from scoring.deal_scorer import _apply_thin_comp_guard, _is_comp_driven


def test_is_comp_driven_detects_known_phrasings():
    assert _is_comp_driven("Price 819% above eBay sold average")
    assert _is_comp_driven("Asking price far exceeds what buyers pay")
    assert _is_comp_driven("Massively overpriced; 819% above market comp.")
    assert _is_comp_driven("price-to-value ratio is indefensible")
    assert _is_comp_driven("Markup of over 800% vs asking")
    assert _is_comp_driven("$459 vs. asking $50 retail")


def test_is_comp_driven_leaves_real_red_flags_alone():
    assert not _is_comp_driven("Seller account brand-new (joined 2025)")
    assert not _is_comp_driven("Material claimed as jade but unverified")
    assert not _is_comp_driven("No returns accepted")
    assert not _is_comp_driven("Multiple photos show detail")


def test_jade_toad_payload_is_rewritten():
    """Faithful reproduction of the failing production response."""
    listing = {"price": 399.0, "title": "Nephrite Jade Money Toad 25 lb"}
    market_value = {"confidence": "low", "sold_count": 1, "estimated_value": 50.0}
    data = {
        "score": 2,
        "verdict": "AVOID",
        "summary": "Massively overpriced; 819% above market comp.",
        "value_assessment": "This listing asks $459.51 — a markup of over 800%.",
        "condition_notes": "New; seller provided multiple photos.",
        "red_flags": [
            "Price 819% above eBay sold average ($50 vs. asking $459.51)",
            "Seller account brand-new (joined 2025)",
            "Material claimed as nephrite jade but unverified",
            "No returns accepted on high-priced item",
        ],
        "green_flags": ["Multiple high-quality photos"],
        "recommended_offer": 85.0,
        "should_buy": False,
        "confidence": "medium",
    }

    out, modified = _apply_thin_comp_guard(data, listing, market_value)
    assert modified is True

    combined = " ".join(str(x).lower() for x in out["red_flags"])
    assert "above" not in combined or "market" not in combined
    assert "overpriced" not in combined
    assert "819" not in combined

    assert len(out["red_flags"]) == 3
    assert any("seller account" in f.lower() for f in out["red_flags"])
    assert any("nephrite" in f.lower() for f in out["red_flags"])
    assert any("return" in f.lower() for f in out["red_flags"])

    assert out["score"] >= 4
    assert "overpriced" not in out["summary"].lower()
    assert "% above" not in out["summary"]
    assert "indefensible" not in out["value_assessment"].lower()

    # Verdict must be neutralized — plain "AVOID" does not match the comp
    # patterns but is still a comp-anchored verdict and must be rewritten.
    vlow = out["verdict"].lower()
    for forbidden in ("avoid", "overpriced", "do not buy", "walk away"):
        assert forbidden not in vlow, f"Verdict still contains '{forbidden}': {out['verdict']!r}"

    assert out["recommended_offer"] >= 0.5 * listing["price"]


def test_score_floor_when_only_summary_is_comp_driven():
    """Score floor should fire when comp anchoring lives in summary/verdict
    only (no comp-driven red_flag present)."""
    listing = {"price": 200.0}
    market_value = {"confidence": "low", "sold_count": 1, "estimated_value": 30.0}
    data = {
        "score": 2,
        "verdict": "Poor value",
        "summary": "Price is 566% above the eBay sold average.",
        "value_assessment": "price-to-value ratio is indefensible",
        "red_flags": [],
        "recommended_offer": 30.0,
        "confidence": "low",
    }
    out, modified = _apply_thin_comp_guard(data, listing, market_value)
    assert modified is True
    assert out["score"] >= 4, f"Score should be floored to 4, got {out['score']}"
    assert "566" not in out["summary"]
    assert "indefensible" not in out["value_assessment"].lower()
    assert out["recommended_offer"] >= 0.5 * listing["price"]


def test_verdict_neutralized_even_when_not_comp_phrased():
    """A plain 'AVOID' verdict must be rewritten when the guard fires."""
    listing = {"price": 300.0}
    market_value = {"confidence": "low", "sold_count": 1, "estimated_value": 40.0}
    data = {
        "score": 2,
        "verdict": "AVOID",
        "summary": "Price 650% above eBay sold average.",
        "red_flags": ["Price 650% above market"],
        "recommended_offer": 40.0,
        "confidence": "low",
    }
    out, modified = _apply_thin_comp_guard(data, listing, market_value)
    assert modified is True
    assert out["verdict"].lower() != "avoid"
    assert "avoid" not in out["verdict"].lower()
    assert "overpriced" not in out["verdict"].lower()


def test_high_confidence_listing_is_untouched():
    """When comps are strong, the guard must not rewrite anything."""
    listing = {"price": 500.0, "title": "iPhone 13 Pro"}
    market_value = {"confidence": "high", "sold_count": 20, "estimated_value": 380.0}
    data = {
        "score": 3,
        "verdict": "Overpriced",
        "summary": "Price is 32% above market average.",
        "value_assessment": "Fair value ~$380 based on 20 sold comps.",
        "red_flags": ["Price 32% above market average"],
        "green_flags": [],
        "recommended_offer": 380.0,
        "should_buy": False,
        "confidence": "high",
    }

    out, modified = _apply_thin_comp_guard(data, listing, market_value)
    assert modified is False
    assert out["score"] == 3
    assert out["red_flags"] == ["Price 32% above market average"]
    assert out["recommended_offer"] == 380.0


def test_medium_confidence_with_three_comps_is_untouched():
    """Guard only fires at sold_count <= 2."""
    listing = {"price": 200.0}
    market_value = {"confidence": "low", "sold_count": 3, "estimated_value": 100.0}
    data = {
        "score": 3,
        "verdict": "Overpriced",
        "summary": "Asking price 100% above market comps.",
        "red_flags": ["100% above market"],
        "recommended_offer": 80.0,
        "confidence": "low",
    }
    out, modified = _apply_thin_comp_guard(data, listing, market_value)
    assert modified is False
    assert out["score"] == 3


def test_real_non_comp_red_flags_do_not_trigger_score_floor():
    """If Claude's low score is due to real issues (not comps), leave it alone."""
    listing = {"price": 100.0}
    market_value = {"confidence": "low", "sold_count": 1, "estimated_value": 50.0}
    data = {
        "score": 2,
        "verdict": "AVOID",
        "summary": "Seller account is brand new with multiple scam indicators.",
        "red_flags": [
            "Seller requests Zelle payment before shipping",
            "Listing asks for contact via WhatsApp only",
        ],
        "recommended_offer": 60.0,
        "confidence": "low",
    }
    out, modified = _apply_thin_comp_guard(data, listing, market_value)
    assert modified is False
    assert out["score"] == 2
    assert len(out["red_flags"]) == 2


if __name__ == "__main__":
    test_is_comp_driven_detects_known_phrasings()
    test_is_comp_driven_leaves_real_red_flags_alone()
    test_jade_toad_payload_is_rewritten()
    test_high_confidence_listing_is_untouched()
    test_medium_confidence_with_three_comps_is_untouched()
    test_real_non_comp_red_flags_do_not_trigger_score_floor()
    print("All thin-comp guard tests passed.")
