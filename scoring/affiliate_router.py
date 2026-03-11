"""
Affiliate Router — Config-Driven Multi-Program Affiliate Link Engine

ARCHITECTURE PHILOSOPHY:
  Adding a new affiliate program = adding ONE entry to AFFILIATE_PROGRAMS dict.
  No code changes needed. The router handles everything else:
    - Category detection → best programs for that category
    - Commission-weighted program ranking
    - Link generation (direct API, search-based, or network redirect)
    - Graceful fallback to Amazon/eBay when credentials are missing

MONETIZATION STRATEGY:
  Two revenue streams that reinforce each other:

  1. AFFILIATE COMMISSIONS — earn on every click-through that converts.
     Programs are ranked by expected revenue = commission_rate × avg_item_price.
     A 3% commission on a $500 TV beats 8% on a $30 toy.

  2. MARKET INTELLIGENCE DATA — anonymized aggregate signals collected
     per listing scored: category, price gap (used vs new), affiliate clicked.
     This dataset has standalone value for retailers and market researchers.

ADDING A NEW PROGRAM:
  When you get new affiliate credentials, add an entry to AFFILIATE_PROGRAMS:
  {
    "my_program": {
      "name":        "Display Name",
      "tag":         os.getenv("MY_PROGRAM_TAG", ""),   # empty = fallback mode
      "base_url":    "https://...",
      "link_format": "search",   # or "direct" or "network"
      "network":     None,       # "cj", "shareasale", "awin", or None
      "commission":  0.05,       # 5%
      "categories":  ["electronics", "appliances"],
      "badge_label": "My Store",
      "badge_color": "#hex",
      "trusted":     True,
    }
  }

  The router automatically starts using it on next restart.
  In fallback mode (no tag), it generates a search URL — still useful,
  just not tracked for commission until credentials are live.

LINK TYPES:
  "search"  — generates a search results page URL (works without credentials)
  "direct"  — requires a real product ASIN/ID (needs product lookup API)
  "network" — routes through CJ/ShareASale/Awin network (needs publisher ID)

FALLBACK HIERARCHY:
  1. Best program for category with active credentials
  2. Best program for category in search-only mode (no commission)
  3. Amazon Associates (universal fallback — covers everything)
  4. eBay EPN (secondary universal fallback)

COMMISSION DATA SOURCES:
  Commissions are estimates based on public program information.
  Actual rates depend on your publisher tier and merchant agreements.
  Update these as you get actual numbers from each program.
"""

import logging
import os
import urllib.parse
from dataclasses import dataclass, field
from typing import Optional

from dotenv import load_dotenv

load_dotenv()

log = logging.getLogger(__name__)

# ── Affiliate Program Registry ────────────────────────────────────────────────
# This is the ONLY place you need to touch to add a new program.
# All routing, ranking, and link generation is driven by this config.
#
# Status field guide:
#   "live"     — credentials active, earning commissions now
#   "search"   — no credentials yet, generating search links (no commission)
#   "pending"  — applied, awaiting approval
#   "inactive" — do not use

AFFILIATE_PROGRAMS = {

    # ── UNIVERSAL (covers all categories) ────────────────────────────────────

    "amazon": {
        "name":         "Amazon",
        "tag":          os.getenv("AMAZON_ASSOCIATE_TAG", "dealscout03f-20"),
        "base_url":     "https://www.amazon.com/s",
        "link_format":  "search",
        "network":      None,
        "commission":   0.04,    # 4% avg across categories (1-10% varies by category)
        "categories":   ["*"],   # Universal — covers everything as fallback
        "badge_label":  "Amazon",
        "badge_color":  "#f59e0b",
        "icon":         "🛒",
        "trusted":      True,
        "status":       "live",
        "notes":        "Universal fallback. Already integrated.",
    },

    "ebay": {
        "name":         "eBay",
        "tag":          os.getenv("EBAY_CAMPAIGN_ID", "5339144027"),
        "base_url":     "https://www.ebay.com/sch/i.html",
        "link_format":  "search",
        "network":      None,
        "commission":   0.04,    # ~4% of final value via EPN
        "categories":   ["*"],   # Universal
        "badge_label":  "eBay",
        "badge_color":  "#e53e3e",
        "icon":         "🏷️",
        "trusted":      True,
        "status":       "live",
        "notes":        "Already integrated. Best for used/refurb comparisons.",
    },

    # ── ELECTRONICS ───────────────────────────────────────────────────────────

    "best_buy": {
        "name":         "Best Buy",
        "tag":          os.getenv("BEST_BUY_AFFILIATE_TAG", ""),
        "base_url":     "https://www.bestbuy.com/site/searchpage.jsp",
        "link_format":  "search",
        "network":      "cj",    # Commission Junction — apply at cj.com
        "commission":   0.01,    # 1% but high-ticket items make it worthwhile
        "categories":   ["electronics", "phones", "gaming", "appliances", "cameras"],
        "badge_label":  "Best Buy",
        "badge_color":  "#0046be",
        "icon":         "🔵",
        "trusted":      True,
        "status":       "search",   # No tag yet → search-only mode
        "notes":        "Apply via CJ. Especially strong for TVs, laptops, consoles.",
    },

    "newegg": {
        "name":         "Newegg",
        "tag":          os.getenv("NEWEGG_AFFILIATE_TAG", ""),
        "base_url":     "https://www.newegg.com/p/pl",
        "link_format":  "search",
        "network":      "cj",
        "commission":   0.005,   # 0.5% — low rate but tech-savvy audience, high AOV
        "categories":   ["electronics", "gaming", "computers"],
        "badge_label":  "Newegg",
        "badge_color":  "#ff6600",
        "icon":         "💻",
        "trusted":      True,
        "status":       "search",
        "notes":        "Best for PC components, GPUs, RAM. Apply via CJ.",
    },

    "back_market": {
        "name":         "Back Market",
        "tag":          os.getenv("BACK_MARKET_AFFILIATE_TAG", ""),
        "base_url":     "https://www.backmarket.com/en-us/search",
        "link_format":  "search",
        "network":      "impact",  # Impact.com
        "commission":   0.07,    # 7% — best rate in refurb electronics
        "categories":   ["phones", "electronics", "computers", "tablets"],
        "badge_label":  "Back Market",
        "badge_color":  "#15803d",
        "icon":         "♻️",
        "trusted":      True,
        "status":       "search",
        "notes":        "Best commission for refurb phones/laptops. Priority to activate.",
    },

    # ── HOME & TOOLS ──────────────────────────────────────────────────────────

    "home_depot": {
        "name":         "Home Depot",
        "tag":          os.getenv("HOME_DEPOT_AFFILIATE_TAG", ""),
        "base_url":     "https://www.homedepot.com/s",
        "link_format":  "search",
        "network":      "impact",
        "commission":   0.03,    # 3% — strong on large appliances and tools
        "categories":   ["tools", "appliances", "outdoor", "furniture", "home"],
        "badge_label":  "Home Depot",
        "badge_color":  "#f96302",
        "icon":         "🏠",
        "trusted":      True,
        "status":       "search",
        "notes":        "Apply via Impact.com. Strong for power tools, appliances.",
    },

    "lowes": {
        "name":         "Lowe's",
        "tag":          os.getenv("LOWES_AFFILIATE_TAG", ""),
        "base_url":     "https://www.lowes.com/search",
        "link_format":  "search",
        "network":      "cj",
        "commission":   0.02,    # 2%
        "categories":   ["tools", "appliances", "outdoor", "home"],
        "badge_label":  "Lowe's",
        "badge_color":  "#004990",
        "icon":         "🔨",
        "trusted":      True,
        "status":       "search",
        "notes":        "Competitor to Home Depot. Apply via CJ.",
    },

    "walmart": {
        "name":         "Walmart",
        "tag":          os.getenv("WALMART_AFFILIATE_TAG", ""),
        "base_url":     "https://www.walmart.com/search",
        "link_format":  "search",
        "network":      "impact",
        "commission":   0.04,    # 4%
        "categories":   ["*"],   # Very broad coverage
        "badge_label":  "Walmart",
        "badge_color":  "#0071ce",
        "icon":         "🏪",
        "trusted":      True,
        "status":       "search",
        "notes":        "Apply via Impact.com. Good universal fallback to Amazon.",
    },

    "wayfair": {
        "name":         "Wayfair",
        "tag":          os.getenv("WAYFAIR_AFFILIATE_TAG", ""),
        "base_url":     "https://www.wayfair.com/keyword.php",
        "link_format":  "search",
        "network":      "cj",
        "commission":   0.06,    # 6% — strong on furniture
        "categories":   ["furniture", "home", "appliances"],
        "badge_label":  "Wayfair",
        "badge_color":  "#7b2d8b",
        "icon":         "🛋️",
        "trusted":      True,
        "status":       "search",
        "notes":        "Best for furniture. 6% on big-ticket items = strong revenue.",
    },

    # ── BABY / KIDS ───────────────────────────────────────────────────────────

    "target": {
        "name":         "Target",
        "tag":          os.getenv("TARGET_AFFILIATE_TAG", ""),
        "base_url":     "https://www.target.com/s",
        "link_format":  "search",
        "network":      "impact",
        "commission":   0.05,    # 5%
        "categories":   ["baby", "kids", "toys", "clothing", "home"],
        "badge_label":  "Target",
        "badge_color":  "#cc0000",
        "icon":         "🎯",
        "trusted":      True,
        "status":       "search",
        "notes":        "Strong for baby/kids. Parents prefer new. Apply via Impact.",
    },

    # ── OUTDOOR / SPORTING ────────────────────────────────────────────────────

    "rei": {
        "name":         "REI",
        "tag":          os.getenv("REI_AFFILIATE_TAG", ""),
        "base_url":     "https://www.rei.com/search",
        "link_format":  "search",
        "network":      "awin",
        "commission":   0.05,    # 5%
        "categories":   ["outdoor", "sports", "bikes", "fitness", "camping"],
        "badge_label":  "REI",
        "badge_color":  "#4a7c59",
        "icon":         "🏕️",
        "trusted":      True,
        "status":       "search",
        "notes":        "Best for outdoor/camping. High-trust brand, good conversion.",
    },

    # ── AUTOMOTIVE ────────────────────────────────────────────────────────────

    "autotrader": {
        "name":         "Autotrader",
        "tag":          os.getenv("AUTOTRADER_AFFILIATE_TAG", ""),
        "base_url":     "https://www.autotrader.com/cars-for-sale",
        "link_format":  "search",
        "network":      "cj",
        "commission":   0.0,     # CPA: $50-150 per lead (not % of sale)
        "cpa_value":    100.0,   # Estimated CPA value for ranking
        "categories":   ["vehicles", "cars", "trucks"],
        "badge_label":  "Autotrader",
        "badge_color":  "#1a5276",
        "icon":         "🚗",
        "trusted":      True,
        "status":       "search",
        "notes":        "Lead-based ($50-150/lead). High value for vehicle listings.",
    },

    # ── MUSICAL INSTRUMENTS ───────────────────────────────────────────────────

    "sweetwater": {
        "name":         "Sweetwater",
        "tag":          os.getenv("SWEETWATER_AFFILIATE_TAG", ""),
        "base_url":     "https://www.sweetwater.com/store/search.php",
        "link_format":  "search",
        "network":      "shareasale",
        "commission":   0.06,    # 6%
        "categories":   ["musical_instruments", "audio"],
        "badge_label":  "Sweetwater",
        "badge_color":  "#e67e22",
        "icon":         "🎸",
        "trusted":      True,
        "status":       "search",
        "notes":        "Best affiliate for musical instruments. High AOV.",
    },

    # ── FITNESS ───────────────────────────────────────────────────────────────

    "dicks": {
        "name":         "Dick's Sporting Goods",
        "tag":          os.getenv("DICKS_AFFILIATE_TAG", ""),
        "base_url":     "https://www.dickssportinggoods.com/s",
        "link_format":  "search",
        "network":      "cj",
        "commission":   0.05,    # 5%
        "categories":   ["fitness", "sports", "outdoor", "bikes"],
        "badge_label":  "Dick's",
        "badge_color":  "#1e3a5f",
        "icon":         "🏋️",
        "trusted":      True,
        "status":       "search",
        "notes":        "Good for fitness equipment, sporting goods.",
    },

    # ── PET SUPPLIES ─────────────────────────────────────────────────────────

    "chewy": {
        "name":         "Chewy",
        "tag":          os.getenv("CHEWY_AFFILIATE_TAG", ""),
        "base_url":     "https://www.chewy.com/s",
        "link_format":  "search",
        "network":      "impact",
        "commission":   0.04,    # 4%
        "categories":   ["pets", "pet_supplies"],
        "badge_label":  "Chewy",
        "badge_color":  "#0c6bb1",
        "icon":         "🐾",
        "trusted":      True,
        "status":       "search",
        "notes":        "Best pet affiliate. High repurchase rate builds cookie value.",
    },
}


# ── Category Taxonomy ─────────────────────────────────────────────────────────
# Maps Claude-extracted categories to our internal category keys.
# Claude returns free-form strings ("power drill", "cordless drill", "Ryobi drill")
# — this table normalizes them to the 25 keys the router understands.
#
# Add new synonyms here as you encounter them in production.

CATEGORY_MAP = {
    # Electronics
    "electronics":         "electronics",
    "laptop":              "computers",
    "computer":            "computers",
    "desktop":             "computers",
    "tablet":              "tablets",
    "ipad":                "tablets",
    "monitor":             "electronics",
    "tv":                  "electronics",
    "television":          "electronics",
    "camera":              "cameras",
    "dslr":                "cameras",
    "mirrorless":          "cameras",
    "drone":               "electronics",
    "headphones":          "electronics",
    "speaker":             "electronics",
    "audio":               "audio",
    "stereo":              "audio",

    # Optics / Astronomy — no dedicated affiliate, route to cameras (Best Buy, Amazon)
    "telescope":           "cameras",
    "binocular":           "cameras",
    "spotting scope":      "cameras",
    "monocular":           "cameras",
    "refractor":           "cameras",
    "reflector":           "cameras",
    "dobsonian":           "cameras",
    "optics":              "cameras",
    "astronomy":           "cameras",
    "microscope":          "electronics",
    "night vision":        "cameras",

    # Phones
    "phone":               "phones",
    "smartphone":          "phones",
    "iphone":              "phones",
    "android":             "phones",
    "samsung":             "phones",

    # Gaming
    "gaming":              "gaming",
    "console":             "gaming",
    "playstation":         "gaming",
    "xbox":                "gaming",
    "nintendo":            "gaming",
    "video game":          "gaming",

    # Tools & Home
    "tool":                "tools",
    "drill":               "tools",
    "saw":                 "tools",
    "mower":               "tools",
    "lawn mower":          "tools",
    "chainsaw":            "tools",
    "power tool":          "tools",
    "appliance":           "appliances",
    "washer":              "appliances",
    "dryer":               "appliances",
    "refrigerator":        "appliances",
    "dishwasher":          "appliances",
    "microwave":           "appliances",

    # Furniture / Home
    "furniture":           "furniture",
    "sofa":                "furniture",
    "couch":               "furniture",
    "chair":               "furniture",
    "desk":                "furniture",
    "table":               "furniture",
    "bed":                 "furniture",
    "dresser":             "furniture",
    "home":                "home",
    "home goods":          "home",

    # Outdoor / Sports
    "outdoor":             "outdoor",
    "camping":             "camping",
    "hiking":              "outdoor",
    "fishing":             "outdoor",
    "bicycle":             "bikes",
    "bike":                "bikes",
    "ebike":               "bikes",
    "electric bike":       "bikes",
    "scooter":             "bikes",
    "fitness":             "fitness",
    "treadmill":           "fitness",
    "exercise":            "fitness",
    "sports":              "sports",

    # Vehicles
    "vehicle":             "vehicles",
    "car":                 "cars",
    "truck":               "trucks",
    "motorcycle":          "vehicles",
    "atv":                 "vehicles",
    "dirt bike":           "vehicles",
    "golf cart":           "vehicles",
    "boat":                "vehicles",

    # Baby / Kids
    "baby":                "baby",
    "infant":              "baby",
    "toddler":             "kids",
    "kids":                "kids",
    "toy":                 "toys",
    "stroller":            "baby",
    "car seat":            "baby",

    # Musical Instruments
    "guitar":              "musical_instruments",
    "bass":                "musical_instruments",
    "piano":               "musical_instruments",
    "keyboard":            "musical_instruments",
    "drums":               "musical_instruments",
    "instrument":          "musical_instruments",
    "amplifier":           "audio",
    "amp":                 "audio",

    # Pets
    "pet":                 "pets",
    "dog":                 "pets",
    "cat":                 "pets",
}

# Which programs serve each category — ordered by priority (best first)
# "live" programs with credentials come before "search" mode programs
CATEGORY_PROGRAMS = {
    "electronics":          ["back_market", "best_buy", "newegg", "amazon", "ebay"],
    "computers":            ["back_market", "best_buy", "newegg", "amazon", "ebay"],
    "tablets":              ["back_market", "best_buy", "amazon", "ebay"],
    "phones":               ["back_market", "best_buy", "amazon", "ebay"],
    "cameras":              ["best_buy", "amazon", "ebay"],
    "gaming":               ["best_buy", "newegg", "amazon", "ebay"],
    "audio":                ["sweetwater", "best_buy", "amazon", "ebay"],
    "tools":                ["home_depot", "lowes", "amazon", "ebay"],
    "appliances":           ["home_depot", "lowes", "best_buy", "amazon", "ebay"],
    "furniture":            ["wayfair", "walmart", "amazon", "ebay"],
    "home":                 ["home_depot", "wayfair", "walmart", "amazon"],
    "outdoor":              ["rei", "amazon", "ebay"],
    "camping":              ["rei", "amazon", "ebay"],
    "bikes":                ["rei", "dicks", "amazon", "ebay"],
    "fitness":              ["dicks", "amazon", "ebay", "walmart"],
    "sports":               ["dicks", "rei", "amazon", "ebay"],
    # WHY no amazon for vehicles: Amazon cannot sell used cars.
    # Showing "2011 BMW 328i — New at Amazon" destroys user trust in the
    # affiliate section and makes the whole product look low-quality.
    "vehicles":             ["autotrader", "ebay"],
    "cars":                 ["autotrader", "ebay"],
    "trucks":               ["autotrader", "ebay"],
    "baby":                 ["target", "amazon", "walmart"],
    "kids":                 ["target", "amazon", "walmart"],
    "toys":                 ["target", "amazon", "walmart"],
    "musical_instruments":  ["sweetwater", "amazon", "ebay"],
    "pets":                 ["chewy", "amazon", "walmart"],
    "pet_supplies":         ["chewy", "amazon", "walmart"],
}


# ── Data Models ───────────────────────────────────────────────────────────────

@dataclass
class AffiliateCard:
    """
    A single affiliate recommendation card for the sidebar.

    program_key:  Key into AFFILIATE_PROGRAMS — used for click tracking
    title:        What we're recommending ("RYOBI 40V Mower — New at Amazon")
    subtitle:     Context line ("New from $152 · Free shipping")
    reason:       Why this card is shown ("Compare to your $321 total cost")
    url:          Affiliate link (with tracking params)
    badge_label:  Text in the colored badge ("Amazon", "Home Depot")
    badge_color:  Hex color for the badge
    icon:         Emoji icon for the program
    card_type:    "new_retail" | "refurb" | "used_comp" | "lead"
    commission_live: True if this click earns real commission now
    estimated_revenue: commission_rate × item_price (for internal ranking)
    price_hint:   Display price if known ("From $152") or "" if unknown
"""
    program_key:        str
    title:              str
    subtitle:           str
    reason:             str
    url:                str
    badge_label:        str
    badge_color:        str
    icon:               str
    card_type:          str
    commission_live:    bool
    estimated_revenue:  float
    price_hint:         str = ""


# ── Link Generators ───────────────────────────────────────────────────────────

def _build_amazon_link(query: str, tag: str) -> str:
    encoded = urllib.parse.quote_plus(query)
    return f"https://www.amazon.com/s?k={encoded}&tag={tag}"


def _build_ebay_link(query: str, campaign_id: str, new_only: bool = False) -> str:
    encoded = urllib.parse.quote_plus(query)
    cond = "&LH_ItemCondition=1000" if new_only else "&LH_ItemCondition=3000"
    return (
        f"https://www.ebay.com/sch/i.html?_nkw={encoded}{cond}&_sop=15"
        f"&mkevt=1&mkcid=1&mkrid=711-53200-19255-0"
        f"&campid={campaign_id}&toolid=10001&customid=dealscout_rec"
    )


def _build_search_link(program_key: str, query: str, tag: str) -> str:
    """
    Build a search link for any program using its base_url pattern.
    Each program has a slightly different query param name — handled here.
    """
    p = AFFILIATE_PROGRAMS[program_key]
    encoded = urllib.parse.quote_plus(query)
    base = p["base_url"]

    param_map = {
        "amazon":      f"?k={encoded}&tag={tag}",
        "ebay":        f"?_nkw={encoded}&mkevt=1&mkcid=1&mkrid=711-53200-19255-0&campid={tag}&toolid=10001&customid=dealscout",
        "best_buy":    f"?st={encoded}",
        "newegg":      f"?d={encoded}",
        "back_market": f"?q={encoded}",
        "home_depot":  f"/{encoded}",
        "lowes":       f"?searchTerm={encoded}",
        "walmart":     f"?q={encoded}",
        "wayfair":     f"?keyword={encoded}",
        "target":      f"?searchTerm={encoded}",
        "rei":         f"?q={encoded}",
        "autotrader":  f"/all-cars?makeCodeList=&searchRadius=50&zip=92101&query={encoded}",
        "sweetwater":  f"?s={encoded}",
        "dicks":       f"/{encoded}",
        "chewy":       f"?query={encoded}",
    }

    suffix = param_map.get(program_key, f"?q={encoded}")

    # Append network tracking params where we have them
    if tag and p.get("network") == "cj":
        suffix += f"&cjevent=dealscout"
    elif tag and p.get("network") == "impact":
        suffix += f"&irclickid=dealscout"

    return base + suffix


# ── Category Detection ────────────────────────────────────────────────────────

def detect_category(product_info) -> str:
    """
    Map a ProductInfo object to one of our internal category keys.

    Tries (in order):
      1. product_info.category (Claude-extracted, e.g. "cordless drill")
      2. product_info.brand    (e.g. "RYOBI" → tools)
      3. product_info.model    (partial match)
      4. raw_title             (last resort substring scan)
    Returns "general" if nothing matches — Amazon handles general.
    """
    candidates = [
        getattr(product_info, "category",    "") or "",
        getattr(product_info, "brand",       "") or "",
        getattr(product_info, "model",       "") or "",
        getattr(product_info, "raw_title",   "") or "",
        getattr(product_info, "display_name","") or "",
    ]

    combined = " ".join(candidates).lower()

    # Exact + substring matching against CATEGORY_MAP
    for keyword, cat_key in sorted(CATEGORY_MAP.items(), key=lambda x: -len(x[0])):
        if keyword in combined:
            return cat_key

    return "general"


# ── Revenue Estimator ─────────────────────────────────────────────────────────

def _estimate_revenue(program_key: str, listing_price: float) -> float:
    """
    Estimate expected revenue per click for ranking purposes.
    Uses commission × listing_price as a proxy for conversion value.
    CPA programs use their fixed cpa_value instead.
    """
    p = AFFILIATE_PROGRAMS.get(program_key, {})
    commission = p.get("commission", 0)
    cpa        = p.get("cpa_value", 0)

    if cpa > 0:
        return cpa  # Lead-based — fixed value regardless of price
    return commission * listing_price


# ── Main Entry Point ──────────────────────────────────────────────────────────

def get_affiliate_recommendations(
    product_info,
    listing_price: float,
    shipping_cost: float = 0.0,
    deal_score=None,
    market_value=None,
    max_cards: int = 3,
    category_override: str = "",  # When set, skips detect_category() — used by main.py to force
                                   # "vehicles" when listing.is_vehicle=True, since product_info
                                   # text for a BMW 328i won't contain the word "vehicle"
) -> list:
    """
    Generate ranked affiliate recommendation cards for the sidebar.

    CARD SELECTION LOGIC:
      1. Detect category → get program priority list for that category
      2. Score each program by expected revenue (commission × price)
      3. "Live" programs (with real credentials) rank above "search" mode
      4. Pick top max_cards programs, generate links + card copy
      5. Always include at least one Amazon card as safety net

    CARD TYPES:
      - "new_retail"  — Buy new from a retailer (most common)
      - "refurb"      — Certified refurbished (Back Market, Best Buy Outlet)
      - "used_comp"   — Used comparison (eBay)
      - "lead"        — Service inquiry (Autotrader for vehicles)

    WHY max_cards=3:
      Sidebar is 310px wide. Each card is ~70px tall.
      3 cards = reasonable without scrolling. Quality over quantity.
    """
    category   = category_override if category_override else detect_category(product_info)
    true_cost  = listing_price + shipping_cost
    query      = getattr(product_info, "search_query", "") or getattr(product_info, "display_name", "") or ""
    amazon_q   = getattr(product_info, "amazon_query", query) or query
    # Extract new retail price from market_value so _build_card can show dollar gap
    # and populate price_hint. Guarded: market_value may be None if pricing failed.
    mv_new_price = getattr(market_value, "new_price", 0.0) or 0.0

    log.info(f"[AffiliateRouter] Category='{category}'{' (override)' if category_override else ''} for '{query}' @ ${listing_price:.0f}")

    # Get program priority list for this category
    program_keys = CATEGORY_PROGRAMS.get(category, ["amazon", "ebay"])

    # Build scored candidates
    candidates = []
    for key in program_keys:
        p = AFFILIATE_PROGRAMS.get(key)
        if not p or p.get("status") == "inactive":
            continue

        tag            = p.get("tag", "")
        commission_live = bool(tag) and p.get("status") == "live"
        est_revenue    = _estimate_revenue(key, listing_price)

        # Rank live programs above search-only; within tier, rank by revenue
        live_bonus = 1000 if commission_live else 0
        rank_score = live_bonus + est_revenue

        candidates.append({
            "key":              key,
            "program":          p,
            "tag":              tag,
            "commission_live":  commission_live,
            "est_revenue":      est_revenue,
            "rank_score":       rank_score,
        })

    # Sort by rank score descending
    candidates.sort(key=lambda c: c["rank_score"], reverse=True)

    # Deduplicate — never show the same program twice
    seen_keys = set()
    cards     = []

    for cand in candidates:
        if len(cards) >= max_cards:
            break

        key = cand["key"]
        if key in seen_keys:
            continue
        seen_keys.add(key)

        p   = cand["program"]
        tag = cand["tag"] or ""

        # Generate the affiliate link
        if key == "amazon":
            url = _build_amazon_link(amazon_q, tag or "dealscout03f-20")
        elif key == "ebay":
            url = _build_ebay_link(query, tag or "5339144027", new_only=False)
        else:
            url = _build_search_link(key, query, tag)

        # Build card copy based on program type and deal context
        card = _build_card(
            key            = key,
            p              = p,
            url            = url,
            query          = query,
            listing_price  = listing_price,
            true_cost      = true_cost,
            deal_score     = deal_score,
            commission_live= cand["commission_live"],
            est_revenue    = cand["est_revenue"],
            category       = category,
            new_price      = mv_new_price,
        )
        cards.append(card)

    # Safety net: ensure Amazon is always present (except vehicles — Amazon
    # is useless for cars and harms credibility of the affiliate section)
    is_vehicle_cat = category in ("vehicles", "cars", "trucks")
    if not is_vehicle_cat and not any(c.program_key == "amazon" for c in cards) and len(cards) < max_cards:
        p   = AFFILIATE_PROGRAMS["amazon"]
        url = _build_amazon_link(amazon_q, p["tag"] or "dealscout03f-20")
        cards.append(_build_card(
            key="amazon", p=p, url=url, query=amazon_q,
            listing_price=listing_price, true_cost=true_cost,
            deal_score=deal_score, commission_live=bool(p["tag"]),
            est_revenue=_estimate_revenue("amazon", listing_price),
            category=category,
            new_price=mv_new_price,
        ))

    # Vehicle safety net: always show Autotrader even in search-only mode
    if is_vehicle_cat and not any(c.program_key == "autotrader" for c in cards):
        p   = AFFILIATE_PROGRAMS.get("autotrader", {})
        if p:
            url = _build_search_link("autotrader", query, p.get("tag", ""))
            cards.insert(0, _build_card(
                key="autotrader", p=p, url=url, query=query,
                listing_price=listing_price, true_cost=true_cost,
                deal_score=deal_score, commission_live=bool(p.get("tag")),
                est_revenue=_estimate_revenue("autotrader", listing_price),
                category=category,
            ))
    # Trim back to max_cards after insertions
    cards = cards[:max_cards]

    log.info(f"[AffiliateRouter] Generated {len(cards)} cards: {[c.program_key for c in cards]}")
    return cards


def _build_card(
    key, p, url, query, listing_price, true_cost,
    deal_score, commission_live, est_revenue, category,
    new_price: float = 0.0,  # new retail price from market_value — enables price_hint on cards
) -> AffiliateCard:
    """Build the display copy for a single affiliate card."""

    score_val   = deal_score.score if deal_score else 5
    is_bad_deal = score_val < 5
    is_vehicle  = category in ("vehicles", "cars", "trucks")
    is_refurb   = key in ("back_market",)

    # Card type
    if is_vehicle:
        card_type = "lead"
    elif is_refurb:
        card_type = "refurb"
    elif key == "ebay":
        card_type = "used_comp"
    else:
        card_type = "new_retail"

    # Title — use clean action-oriented copy, not raw search query.
    # WHY: raw query like "boys pants bundle lot — New at Amazon" is ugly and
    # defeats the purpose. The store badge already shows the retailer name.
    # Clean titles drive higher CTR and look more professional.
    display = query[:40] if query else "this item"
    if is_vehicle:
        title = f"Find similar at {p['name']}"
    elif is_refurb:
        title = f"Shop certified refurb on {p['name']}"
    elif card_type == "used_comp":
        title = f"Compare prices on eBay"
    else:
        title = f"Shop new on {p['name']}"

    # Subtitle
    if is_vehicle:
        subtitle = "Browse certified dealers · Free listing search"
    elif is_refurb:
        subtitle = f"Certified refurbished · warranty included"
    elif card_type == "used_comp":
        subtitle = "Compare used prices · seller ratings"
    else:
        subtitle = f"New condition · {p['name']} pricing"

    # Reason — context-aware copy that tells the user why this card matters.
    # WHY: Generic "compare before deciding" adds no value. Specific dollar
    # context ("only $7 more for new") is what drives affiliate clicks.
    if is_bad_deal and card_type == "new_retail":
        if listing_price > 0:
            reason = f"Listing is ${true_cost:.0f} used — verify new retail price first"
        else:
            reason = "Deal scores low — compare to new retail price"
    elif is_bad_deal and card_type == "refurb":
        reason = "Certified refurb may cost less with full warranty"
    elif card_type == "used_comp":
        reason = "See what others actually paid for similar items"
    elif is_vehicle:
        reason = "Browse certified inventory · verified sellers"
    elif new_price > 0 and listing_price > 0:
        # We have real new_price data — show the dollar gap
        gap = new_price - listing_price
        if gap <= 0:
            reason = "New retail is comparable — worth checking"
        elif gap <= 20:
            reason = f"Only ${gap:.0f} more to buy new with full warranty"
        else:
            reason = f"New from ~${new_price:.0f} · {listing_price/new_price*100:.0f}% savings used"
    else:
        reason = "Compare new retail price before buying used"

    # Price hint — shown inline on the card subtitle when we have real data.
    # Only populate for new_retail cards. Two-sided sanity guard:
    #   LOW end:  new_price < listing_price * 0.5 → data is probably wrong
    #             (why would new cost less than half the used price?)
    #   HIGH end: new_price > listing_price * 15 → data is probably wrong
    #             (a $15 kids shirt shouldn't comp to a $500 designer jacket)
    # WHY 15x not 5x: 5x was too aggressive — it suppressed hints for items
    # where new really IS much more expensive (e.g., $80 used guitar vs $600 new).
    # 15x catches the obvious garbage (eBay adult pants $155 vs kids $15 = 10.3x,
    # which is still under 15 — that's why the noiseword fix is the real fix).
    price_hint = ""
    if card_type == "new_retail" and new_price > 0 and listing_price > 0:
        ratio_np = new_price / listing_price
        if 0.5 <= ratio_np <= 15:
            price_hint = f"From ~${new_price:.0f}"

    return AffiliateCard(
        program_key     = key,
        title           = title,
        subtitle        = subtitle,
        reason          = reason,
        url             = url,
        badge_label     = p["badge_label"],
        badge_color     = p["badge_color"],
        icon            = p["icon"],
        card_type       = card_type,
        commission_live = commission_live,
        estimated_revenue = est_revenue,
        price_hint      = price_hint,
    )


# ── "Buy New Instead" Trigger ─────────────────────────────────────────────────

def should_trigger_buy_new(
    listing_price: float,
    new_price:     float,
    is_vehicle:    bool = False,
    data_source:   str  = "",
) -> tuple[bool, str]:
    """
    Returns (should_trigger, reason_string) for the "Buy New Instead" banner.

    WHY THIS MATTERS FOR REVENUE:
    When a used price is within 25% of new, buyers almost always prefer new
    (warranty, returns, condition certainty). Surfacing this converts at
    a very high rate — user is already in buying mode, we just redirect them.

    Thresholds (aligned with frontend renderAffiliateCards isDealParity):
      ≥ 90% of new  → strong trigger: "you're almost paying new price"
      65–90% of new → moderate trigger: show dollar savings gap
      < 65% of new  → no trigger (meaningful savings — used is clearly better value)

    WHY 65% (not the old 75%):
      The frontend parity banner fires at 65% (parityRatio >= 0.65).
      The backend banner was at 75%, creating a dead zone (65-74%) where the
      frontend showed a parity section but the backend returned buy_new_trigger=False.
      Both systems now use 65% as the threshold for consistency.

    GUARDS:
      is_vehicle=True → always suppress. eBay "new price" for vehicles is
        parts/accessory pricing (~$150 for a car), not the vehicle itself.
        Showing "4172% of new" destroys credibility.
      data_source == "ebay_mock" → suppress. Mock prices are rough estimates
        seeded from keywords, not real sales. iPhone 15 Pro mock base=$350
        vs real $1,100+ new — banner would say "150% of new" and be wrong.
        Better to show nothing than to mislead the user.
      ratio > 2.5 → new_price is bad data (listing is MORE than 2.5× "new").
        Suppress to avoid embarrassing false triggers.
    """
    if new_price <= 0 or listing_price <= 0:
        return False, ""

    # Vehicles: eBay new_price reflects parts, not the car — always suppress
    if is_vehicle:
        return False, ""

    # Mock / AI-estimate data: prices are not real market data — never trigger
    # this banner when pricing is estimated. Reasons by source:
    #   ebay_mock        — seeded from keywords, not real sales data
    #   correction_range — user locked in used value; new_price still from mock
    #   gemini_knowledge — AI training-data estimate, not live search grounding
    if data_source in ("ebay_mock", "correction_range", "gemini_knowledge"):
        return False, ""

    ratio = listing_price / new_price

    # Sanity check: if listed > 2.5× "new price", the new_price data is junk
    if ratio > 2.5:
        return False, ""

    if ratio >= 0.90:
        return True, f"⚠️ Used price is {ratio*100:.0f}% of new — consider buying new with warranty"
    elif ratio >= 0.65:
        gap = new_price - listing_price
        if gap > 0:
            return True, f"💡 Only ${gap:.0f} more to buy new — may be worth it for warranty + returns"
        else:
            return True, f"New retail is comparable — consider buying new for warranty"

    return False, ""


# ── Analytics Event Builder ───────────────────────────────────────────────────

def build_affiliate_event(
    program_key: str,
    category: str,
    listing_price: float,
    card_type: str,
    deal_score_value: int,
) -> dict:
    """
    Build a privacy-safe analytics event to fire when a card is clicked.

    WHAT WE COLLECT (all aggregate, no PII):
      - Which affiliate program was clicked
      - Product category (not the specific item)
      - Price bucket (not exact price)
      - Card type (new_retail, refurb, etc.)
      - Deal score at time of click

    WHAT WE NEVER COLLECT:
      - User ID, IP address, location
      - Listing URL or item title
      - Any identifiable information

    This event goes to POST /event on our API, gets batched in the
    background script, and is never sent until there are 5+ events
    to batch (further anonymizing individual behavior).
    """
    # Bucket the price to prevent reverse-engineering specific items
    if listing_price < 50:
        price_bucket = "under_50"
    elif listing_price < 200:
        price_bucket = "50_200"
    elif listing_price < 500:
        price_bucket = "200_500"
    elif listing_price < 1000:
        price_bucket = "500_1000"
    elif listing_price < 5000:
        price_bucket = "1000_5000"
    else:
        price_bucket = "over_5000"

    return {
        "event":        "affiliate_click",
        "program":      program_key,
        "category":     category,
        "price_bucket": price_bucket,
        "card_type":    card_type,
        "deal_score":   deal_score_value,
        "ts_bucket":    None,  # filled by API with hour-of-day bucket (not exact ts)
    }


# ── Program Status Summary (for debugging / admin) ───────────────────────────

def get_program_status() -> list[dict]:
    """Return a summary of all programs and their activation status."""
    return [
        {
            "key":     key,
            "name":    p["name"],
            "status":  p["status"],
            "has_tag": bool(p.get("tag")),
            "commission": p.get("commission", 0),
            "categories": p.get("categories", []),
            "network": p.get("network"),
            "notes":   p.get("notes", ""),
        }
        for key, p in AFFILIATE_PROGRAMS.items()
    ]
