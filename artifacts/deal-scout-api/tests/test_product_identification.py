"""
Task #110 — Product identification accuracy.

Covers the three deterministic tightenings added in this task:
  1. Value-defining brand whitelist — a hype/luxury/collectible brand that
     Haiku drops from the search query is re-injected when it appears in the
     listing title (so comps reflect the real item's worth), without inventing
     brands or touching manufacturer-brand queries.
  2. Category sanity routing — e-transport (e-bikes, Surron, e-scooters,
     hoverboards…) is forced out of the gas-vehicle pricing pipeline via an
     enforced keyword check, not just a prompt instruction.
  3. Recall status classification — recall mentions that are historical/resolved
     or pertain to an older version are not raised as active safety alerts.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from scoring.product_extractor import ProductInfo, _retain_value_brands
from scoring.listing_extractor import _enforce_vehicle_routing
from scoring.product_evaluator import _recall_is_resolved


def _info(search_query, amazon_query="", display_name="item"):
    return ProductInfo(
        brand="", model="", category="",
        search_query=search_query,
        amazon_query=amazon_query or search_query,
        display_name=display_name,
        confidence="medium", raw_title="", extraction_method="test",
    )


# ── 1. Value-defining brand whitelist ─────────────────────────────────────────

def test_dropped_value_brand_reinjected():
    info = _info("submariner dive watch")
    out = _retain_value_brands(info, "Rolex Submariner dive watch like new")
    assert "rolex" in out.search_query.lower()
    assert "rolex" in out.amazon_query.lower()


def test_supreme_reinjected():
    info = _info("box logo hoodie red")
    out = _retain_value_brands(info, "Supreme Box Logo Hoodie Red FW20")
    assert out.search_query.lower().startswith("supreme")


def test_lego_reinjected():
    info = _info("millennium falcon ucs set")
    out = _retain_value_brands(info, "LEGO Star Wars Millennium Falcon UCS 75192")
    assert "lego" in out.search_query.lower()


def test_brand_already_present_not_duplicated():
    info = _info("rolex submariner watch")
    out = _retain_value_brands(info, "Rolex Submariner watch")
    assert out.search_query.lower().count("rolex") == 1


def test_brand_not_in_title_not_injected():
    info = _info("generic dive watch")
    out = _retain_value_brands(info, "Vintage dive watch 40mm")
    assert "rolex" not in out.search_query.lower()
    assert out.search_query == "generic dive watch"


def test_manufacturer_brand_query_untouched():
    """Canon is a manufacturer brand kept by the prompt — not in the whitelist,
    so the helper must leave its query completely unchanged."""
    info = _info("Canon EOS R5 body")
    out = _retain_value_brands(info, "Canon EOS R5 mirrorless camera body")
    assert out.search_query == "Canon EOS R5 body"


def test_multiword_brand_reinjected():
    info = _info("neverfull mm tote bag")
    out = _retain_value_brands(info, "Louis Vuitton Neverfull MM tote bag")
    assert "louis vuitton" in out.search_query.lower()


# ── 2. Category sanity routing ────────────────────────────────────────────────

def test_ebike_forced_non_vehicle():
    d = {"is_vehicle": True, "title": "Rad Power RadRover e-bike", "description": ""}
    _enforce_vehicle_routing(d)
    assert d["is_vehicle"] is False


def test_surron_forced_non_vehicle():
    d = {"is_vehicle": True, "title": "Sur-Ron Light Bee X", "description": "electric off-road"}
    _enforce_vehicle_routing(d)
    assert d["is_vehicle"] is False


def test_electric_scooter_forced_non_vehicle():
    d = {"is_vehicle": True, "title": "Segway Ninebot Max electric scooter", "description": ""}
    _enforce_vehicle_routing(d)
    assert d["is_vehicle"] is False


def test_hoverboard_forced_non_vehicle():
    d = {"is_vehicle": True, "title": "Hoverboard self balancing", "description": ""}
    _enforce_vehicle_routing(d)
    assert d["is_vehicle"] is False


def test_real_car_stays_vehicle():
    d = {"is_vehicle": True, "title": "2015 Honda Civic LX sedan", "description": "120k miles, clean title"}
    _enforce_vehicle_routing(d)
    assert d["is_vehicle"] is True


def test_electric_start_motorcycle_not_tripped():
    """A gas motorcycle that merely mentions 'electric start' must NOT be
    reclassified — the regex requires a real e-transport compound term."""
    d = {"is_vehicle": True, "title": "Harley Davidson Sportster", "description": "electric start, runs great"}
    _enforce_vehicle_routing(d)
    assert d["is_vehicle"] is True


def test_already_non_vehicle_left_alone():
    d = {"is_vehicle": False, "title": "Canon EOS R5", "description": ""}
    _enforce_vehicle_routing(d)
    assert d["is_vehicle"] is False


# ── 3. Recall status classification ───────────────────────────────────────────

def test_historical_previous_version_recall_is_resolved():
    assert _recall_is_resolved("the previous version was recalled for a battery defect") is True


def test_recall_since_fixed_is_resolved():
    assert _recall_is_resolved("the recall was fixed in the current model") is True
    assert _recall_is_resolved("this issue was corrected after the recall") is True


def test_older_year_model_recall_is_resolved():
    assert _recall_is_resolved("the 2019 model recall was addressed in later units") is True


def test_this_version_not_affected_is_resolved():
    assert _recall_is_resolved("this version is not affected by the earlier recall") is True


def test_active_recall_not_marked_resolved():
    assert _recall_is_resolved("this product is recalled due to fire hazard") is False
    assert _recall_is_resolved("CPSC recall notice: stop using immediately") is False


def test_empty_text_not_resolved():
    assert _recall_is_resolved("") is False
    assert _recall_is_resolved(None) is False


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
    print("All product identification tests passed.")
