"""
Claude Deal Scoring Engine — Week 3

WHY THIS IS THE CORE VALUE PROPOSITION:
  Anyone can compare a price to eBay averages. What makes this product
  valuable is the AI layer that reasons about the WHOLE picture:
    - Is the condition claim believable given the description?
    - Are the accessories included worth extra?
    - Is the dent mentioned a real concern or irrelevant?
    - Is $500 actually bad given current market conditions?
    - What should the buyer do — offer, pass, or jump on it?

  That nuanced reasoning is what users will pay for.

WHAT THIS MODULE DOES:
  1. Loads a listing + its market value data from /data
  2. Sends both to Claude with a structured scoring prompt
  3. Parses Claude's response into a clean DealScore object
  4. Saves the result and prints a final report

DEAL SCORE SCALE (1-10):
  9-10  Exceptional deal — act immediately
  7-8   Good deal — worth buying at asking price
  5-6   Fair — priced at market, negotiate if possible
  3-4   Overpriced — only buy with significant discount
  1-2   Bad deal — avoid or lowball heavily

RUN STANDALONE:
  python scoring/deal_scorer.py
  (uses most recent listing + market value files from /data)
"""

import asyncio
import json
import logging
import os
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Optional

import anthropic
from dotenv import load_dotenv

load_dotenv()

logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO"),
    format="%(asctime)s [%(levelname)s] %(message)s"
)
log = logging.getLogger(__name__)

DATA_DIR = Path(__file__).parent.parent / "data"

# Lazy-initialized client — not created until first API call.
# WHY LAZY (not module-level eager init):
#   1. Consistent with product_extractor.py and suggestion_engine.py
#   2. If API key is rotated after server start, next call picks it up from os.getenv
#   3. Avoids a client object with api_key=None if .env isn't loaded at import time
_scoring_client: Optional[anthropic.Anthropic] = None

def _get_scoring_client() -> anthropic.Anthropic:
    global _scoring_client
    if _scoring_client is None:
        _scoring_client = anthropic.Anthropic(api_key=os.getenv("AI_INTEGRATIONS_ANTHROPIC_API_KEY", "placeholder"), base_url=os.getenv("AI_INTEGRATIONS_ANTHROPIC_BASE_URL"))
    return _scoring_client


# ── Data Model ────────────────────────────────────────────────────────────────

@dataclass
class DealScore:
    """
    Complete AI-generated deal analysis.
    This is the final output of the entire POC pipeline.
    Every field here maps directly to something shown in the Week 4 UI.
    """
    score:              int     # 1-10 deal score
    verdict:            str     # One-line verdict: "Good Deal", "Overpriced", etc.
    summary:            str     # 2-3 sentence plain English explanation
    value_assessment:   str     # What Claude thinks the item is actually worth
    condition_notes:    str     # Claude's read on the condition claim
    red_flags:          list    # List of concerns (empty if none)
    green_flags:        list    # List of positive signals
    recommended_offer:  float   # What price Claude recommends offering
    should_buy:         bool    # Simple yes/no recommendation
    confidence:         str     # "high" / "medium" / "low"
    model_used:         str     # Which Claude model scored this
    image_analyzed:     bool    = False  # True if Claude Vision analyzed the listing photo
    affiliate_category: str     = ""    # Claude's read on what product category this is for affiliate routing
    negotiation_message: str    = ""    # Ready-to-send buyer message referencing price context
    bundle_items:        list   = None  # [{item, value}] breakdown for multi-item listings


# ── Prompt Builder ────────────────────────────────────────────────────────────

def _format_seller_trust(trust: dict) -> str:
    """
    Format seller trust data for the Claude prompt.

    WHY A HELPER:
    The trust dict may be empty (e.g. listing came from the web UI, not the
    extension). We centralise the formatting logic here so the prompt builder
    stays clean and we never crash on missing keys.

    KEY MAPPING — FBM content script (fbm.js) sends:
      joined_date, rating, rating_count
    Legacy / other platforms may use:
      member_since, seller_rating, trust_tier, response_rate, other_listings
    We check both so neither key set silently drops data.
    """
    if not trust:
        return "No seller trust data available (listing scored via web UI)"

    lines = []

    # Join date — FBM sends "joined_date", older code used "member_since"
    joined = trust.get('joined_date') or trust.get('member_since')
    if joined:
        lines.append(f"Member since: {joined}")

    # Rating — FBM sends "rating" + "rating_count", older code used "seller_rating"
    rating = trust.get('rating') or trust.get('seller_rating')
    count  = trust.get('rating_count', 0) or 0
    if rating is not None:
        rating_str = f"{float(rating):.1f}/5"
        if count:
            rating_str += f" ({count} ratings)"
        lines.append(f"Seller rating: {rating_str}")

    # Additional signals (older / platform-specific)
    tier = trust.get('trust_tier')
    if tier:
        lines.append(f"Trust tier: {tier.upper()}")
    if trust.get('response_rate') is not None:
        lines.append(f"Response rate: {trust['response_rate']}%")
    if trust.get('other_listings') is not None:
        lines.append(f"Other active listings: {trust['other_listings']}")

    if not lines:
        return "Seller profile visible but no trust details extracted"

    return "\n".join(lines)


def _price_direction_hint(asking_price: float, estimated_value: float) -> str:
    if estimated_value <= 0 or asking_price <= 0:
        return ""
    ratio = asking_price / estimated_value
    pct = abs(1 - ratio) * 100
    if ratio < 0.5:
        return f"\n>>> PRICE DIRECTION: Asking ${asking_price:.0f} is {pct:.0f}% BELOW estimated value ${estimated_value:.0f}. This is a DISCOUNTED listing — do NOT say overpriced."
    elif ratio < 0.85:
        return f"\n>>> PRICE DIRECTION: Asking ${asking_price:.0f} is {pct:.0f}% BELOW estimated value ${estimated_value:.0f}. This is a good discount."
    elif ratio <= 1.15:
        return f"\n>>> PRICE DIRECTION: Asking ${asking_price:.0f} is roughly AT estimated value ${estimated_value:.0f} (within 15%)."
    else:
        return f"\n>>> PRICE DIRECTION: Asking ${asking_price:.0f} is {pct:.0f}% ABOVE estimated value ${estimated_value:.0f}. This is overpriced."


def _category_specific_rules(listing: dict) -> str:
    """Generate category-specific scoring rules based on listing attributes."""
    rules = []

    category = (listing.get("affiliate_category") or "").lower()
    title_lower = (listing.get("title") or "").lower()
    is_vehicle = listing.get("is_vehicle", False)

    if is_vehicle or category == "vehicles":
        return ""

    if category in ("phones", "tablets") or any(w in title_lower for w in ["iphone", "samsung galaxy", "pixel", "ipad"]):
        rules.append("""## CATEGORY RULES: PHONES/TABLETS
- Storage capacity matters hugely: 64GB vs 256GB can mean $200+ price difference
- Carrier unlocked is worth 10-15% more than carrier-locked
- Battery health below 80% is a significant red flag — mention it
- Check for mentions of screen burn-in (OLED), water damage, or Face ID issues
- iCloud/activation lock = DO NOT BUY (score 1-2)""")

    elif category in ("electronics", "computers") or any(w in title_lower for w in ["laptop", "macbook", "desktop", "gpu", "monitor"]):
        rules.append("""## CATEGORY RULES: ELECTRONICS/COMPUTERS
- Model year matters: a 2021 laptop is worth 30-50% less than a 2024 model
- Check RAM and storage specs — they heavily affect value
- "Refurbished" from a seller vs certified refurbished are very different
- Missing power adapter/charger reduces value by $20-50
- Check for signs of heavy use: worn keycaps, screen scratches, fan noise mentions""")

    elif category == "furniture" or any(w in title_lower for w in ["sofa", "couch", "desk", "table", "chair", "bed", "dresser"]):
        rules.append("""## CATEGORY RULES: FURNITURE
- Dimensions are critical — buyers need to know if it fits
- Solid wood vs particle board/MDF is a major quality & value difference
- Pet damage, smoke exposure, and stains permanently reduce value
- Delivery/disassembly complexity affects real cost to buyer
- Brand matters less than material quality and condition""")

    elif category == "tools" or any(w in title_lower for w in ["drill", "saw", "dewalt", "milwaukee", "makita", "ryobi"]):
        rules.append("""## CATEGORY RULES: POWER TOOLS
- Battery platform matters: check if batteries/charger are included
- Bare tool vs kit (with batteries) is a 40-60% price difference
- Brushless motors are worth 20-30% more than brushed
- Check if it's a corded vs cordless version — very different values
- Professional-grade (Milwaukee FUEL, DeWalt XR) vs consumer-grade pricing""")

    elif category in ("gaming",) or any(w in title_lower for w in ["ps5", "xbox", "nintendo", "switch", "steam deck"]):
        rules.append("""## CATEGORY RULES: GAMING
- Console ban status is critical — banned consoles lose 50%+ value
- Digital vs disc edition consoles have different values
- Check for controller drift or stick issues
- Game bundles: value each game separately, most used games are worth $5-15
- Limited editions and special colors hold value better""")

    elif category in ("cameras",) or any(w in title_lower for w in ["camera", "lens", "dslr", "mirrorless", "telescope"]):
        rules.append("""## CATEGORY RULES: CAMERAS/OPTICS
- Shutter count on DSLRs/mirrorless is like mileage on a car
- Lens glass condition (fungus, haze, scratches) is the #1 value factor
- Check if the item is the latest version — older camera bodies depreciate fast
- For telescopes: collimation quality and mirror condition are critical
- Aftermarket accessories (tripods, eyepieces) add modest value""")

    return "\n".join(rules)


def build_scoring_prompt(listing: dict, market_value: dict, product_evaluation=None, photo_count: int = 0) -> str:
    """
    Build the prompt that Claude uses to score the deal.

    WHY STRUCTURED OUTPUT (JSON):
    The Week 4 UI needs to parse Claude's response programmatically.
    Asking Claude to respond in strict JSON lets us map its reasoning
    directly to UI components without fragile text parsing.

    WHY WE INCLUDE BOTH LISTING AND MARKET DATA:
    Claude needs both to reason well. Market data alone misses
    listing-specific signals (condition, extras, red flags).
    Listing data alone has no price anchor.

    WHY MULTI-ITEM HANDLING:
    A "Ryobi 6-tool set for $290" should NOT be compared against
    single Ryobi tool eBay comps (~$80 each). Without this flag,
    Claude would wrongly call a $290 bundle overpriced.
    When is_multi_item=True we tell Claude to reason about
    aggregate value — what would each item cost individually.
    """
    is_multi = listing.get('is_multi_item', False)

    # Build a context-specific instruction block for multi-item listings
    multi_item_instruction = ""
    if is_multi:
        multi_item_instruction = """
## IMPORTANT: MULTI-ITEM / BUNDLE LISTING
This listing contains multiple items, a set, lot, kit, or bundle.
The eBay market data below reflects SINGLE-ITEM prices, not bundle prices.

Adjust your analysis accordingly:
- Estimate what each included item would cost individually on eBay
- Sum those individual values to get total bundle market value
- Compare the asking price against that aggregate value, NOT single-item comps
- Note which items in the bundle drive most of the value
- Flag if key items (like batteries, chargers, or cases) appear missing
"""

    is_vehicle = listing.get('is_vehicle', False)
    vehicle_instruction = ""
    if is_vehicle:
        vehicle_instruction = """
## IMPORTANT: VEHICLE / POWERSPORTS / MOTORCYCLE LISTING
This listing is for a vehicle, motorcycle, dirt bike, ATV, or similar.
Apply vehicle-specific reasoning:
- DO NOT flag 'no accessories mentioned' — vehicles don't come with accessories by default
- DO NOT flag 'no original packaging' — N/A for vehicles
- DO NOT flag 'unknown condition' if the description mentions mechanical state, mileage, or wear
- Standard attributes (mileage, transmission type, exterior color) are expected, NOT suspicious
- Clean title is a STRONG green flag — always mention it if present
- Red flags specific to vehicles: salvage/rebuilt title, no title, flood/fire damage, no VIN, non-running
- Mileage context: under 5,000 miles on a used dirt bike is very low; over 50,000 on a car is high
- eBay comps for vehicles vary widely — use the price RANGE, not just the average
- Modifications / aftermarket parts: assess whether they add or detract from value for this item type
"""

    # ── Shipping cost context ─────────────────────────────────────────────────
    # WHY: $275 item + $46.68 shipping = $321.68 true cost to buyer.
    # Without this Claude evaluates item price alone vs eBay avg, which
    # dramatically understates how bad the deal is for shipped listings.
    shipping_cost = listing.get('shipping_cost', 0) or 0
    price         = listing.get('price', 0) or 0
    total_cost    = price + shipping_cost

    if shipping_cost > 0:
        shipping_line = (
            f"\nShipping:     ${shipping_cost:.2f}"
            f"\nTotal cost:   ${total_cost:.2f}  ← USE THIS for price-to-market comparison, NOT the item price alone"
        )
    else:
        shipping_line = "\nShipping:     Free / local pickup (no additional cost)"

    if photo_count > 1:
        photos_line = f"\nPhotos:       {photo_count} available (you are analyzing photo 1 of {photo_count} — do NOT flag limited photo count as a red flag)"
    elif photo_count == 1:
        photos_line = "\nPhotos:       1 available"
    else:
        photos_line = "\nPhotos:       Not provided"

    category_rules = _category_specific_rules(listing)

    return f"""You are an expert deal evaluator for a personal shopping assistant.
Your job is to analyze a second-hand marketplace listing and produce a structured deal score.
{multi_item_instruction}{vehicle_instruction}{category_rules}
## LISTING DETAILS
Title:        {listing['title']}
Price:        {listing['raw_price_text']}{f" (reduced from ${listing['original_price']:.0f} — seller has already dropped the price)" if listing.get('original_price') and listing['original_price'] > listing.get('price', 0) else ''}{shipping_line}
Condition:    {listing.get('condition', 'Not specified')}
Location:     {listing.get('location', 'Unknown')}
Seller:       {listing.get('seller_name', 'Unknown')}
Bundle/Set:   {'Yes — see multi-item instructions above' if is_multi else 'No — single item'}{photos_line}
Description:  {listing.get('description', 'No description provided')}

## SELLER TRUST
{_format_seller_trust(listing.get('seller_trust', {}))}

## MARKET VALUE DATA (from eBay — single-item comps)
eBay sold avg:       ${market_value['sold_avg']:.2f}  ({market_value['sold_count']} completed sales)
eBay sold range:     ${market_value['sold_low']:.2f} - ${market_value['sold_high']:.2f}
eBay active avg:     ${market_value['active_avg']:.2f}  ({market_value['active_count']} active listings)
eBay lowest active:  ${market_value['active_low']:.2f}
New retail price:    ${market_value['new_price']:.2f}
Estimated value:     ${market_value['estimated_value']:.2f}
Data confidence:     {market_value['confidence']}
{_price_direction_hint(total_cost, market_value['estimated_value'])}

## YOUR TASK
Analyze this listing holistically. Consider:
- How does the asking price compare to real sold comps (adjusted for bundles if applicable)?
- Does the condition description match the claimed condition?
- Are there red flags (vague description, suspicious claims, missing accessories)?
- Are there positive signals (extras included, detailed description, honest disclosure)?
- What does the seller trust tier tell you about risk? A low-trust seller warrants more caution.
- What is a reasonable offer price if the buyer wants to negotiate?
- Would YOU recommend buying this at the listed price?

## PRODUCT REPUTATION
{product_evaluation.to_prompt_text() if product_evaluation else 'No product reputation data available for this model.'}

## CRITICAL RULES FOR DATA QUALITY
- If Data confidence is "low", do NOT flag price-to-comp mismatch as a red flag. State in value_assessment that comps are limited and you cannot confirm fair pricing, but do not penalize the score for it.
- Only fire a "price above market" red flag when confidence is "medium" or "high" AND the gap is significant.
- Red flags should be grounded in the listing text itself (vague description, implausible claims, inconsistent details), NOT in weak eBay comp data.
- Never flag standard vehicle attributes (mileage, transmission, color, battery specs) as suspicious.
- Do not flag missing accessories or original packaging for vehicles, motorcycles, or powersports items.

## CRITICAL RULES FOR NEW RETAIL COMPARISON
When the "New retail price" above is > 0, apply these hard scoring limits:
- Asking price >= new retail:         score MUST be ≤ 4. Buying used at or above new retail price is objectively a bad deal — the buyer gets no discount, no warranty, no return protection.
- Asking price >= 85% of new retail:  score MUST be ≤ 5. The savings vs. buying new are marginal and don't justify the risks of a used purchase.
These caps apply regardless of condition claimed or accessories included. A "new in box" item from a private seller is still riskier than buying new from a retailer at the same price.

## RESPONSE FORMAT
Respond ONLY with a valid JSON object. No preamble, no explanation, no markdown fences.
Use exactly this structure:

{{
  "score": <integer 1-10>,
  "verdict": "<10 words or less — e.g. 'Good bundle deal, 30% below aggregate value'>",
  "summary": "<2-3 sentences explaining the score in plain English>",
  "value_assessment": "<1-2 sentences on what this item or bundle is actually worth>",
  "condition_notes": "<1-2 sentences on your read of the condition claim>",
  "red_flags": ["<flag 1>", "<flag 2>"],
  "green_flags": ["<flag 1>", "<flag 2>"],
  "recommended_offer": <float — the price you'd recommend offering>,
  "should_buy": <true or false>,
  "confidence": "<high|medium|low>",
  "affiliate_category": "<one of the exact strings below>",
  "negotiation_message": "<see NEGOTIATION MESSAGE instructions below>",
  "bundle_items": [<see BUNDLE BREAKDOWN instructions below>]
}}

If red_flags or green_flags are empty, use an empty array [].
recommended_offer should be realistic — not insultingly low, not full ask if overpriced.

## AFFILIATE CATEGORY
Pick exactly ONE affiliate_category from this list that best describes what is being sold.
This tells our affiliate engine which stores to recommend — pick the most specific match.

  electronics       — TVs, monitors, speakers, projectors, general electronics
  computers         — laptops, desktops, PC components, graphics cards, monitors, peripherals
  tablets           — iPads, Android tablets, e-readers
  phones            — smartphones, cell phones, smartwatches
  cameras           — DSLR, mirrorless, action cams, lenses, tripods
  gaming            — consoles, video games, controllers, gaming headsets, gaming chairs
  audio             — headphones, earbuds, studio monitors, turntables, hi-fi equipment, guitar amps
  tools             — power tools, hand tools, tool sets, drills, saws
  appliances        — refrigerators, washing machines, dishwashers, microwaves, vacuums
  furniture         — sofas, beds, desks, chairs, tables, shelving
  home              — home decor, lighting, rugs, kitchenware, small appliances
  outdoor           — patio furniture, garden tools, lawn equipment, outdoor recreation
  camping           — tents, sleeping bags, camping gear, hiking equipment, backpacks
  bikes             — bicycles, e-bikes, bike parts, cycling gear
  fitness           — treadmills, weights, gym equipment, yoga mats, sports clothing
  sports            — sporting goods, team sports equipment, water sports, winter sports
  vehicles          — cars, trucks, motorcycles, ATVs, boats, RVs, jet skis, snowmobiles
  auto_parts        — car parts, car accessories, floor mats, dash cams, car stereos, jump starters, wiper blades
  baby              — car seats, strollers, cribs, baby monitors, infant gear
  kids              — children's clothing, school supplies, backpacks, kids' bikes
  toys              — toys, games, puzzles, RC cars, Hot Wheels, diecast models, LEGO, action figures
  musical_instruments — guitars, pianos, keyboards, drums, brass, woodwind instruments
  pets              — pets themselves, pet food, pet grooming
  pet_supplies      — pet accessories, crates, leashes, toys, litter boxes
  collectibles      — trading cards (Pokemon, sports, MTG, Yu-Gi-Oh), graded cards, coins, stamps, action figures (collectible grade)
  general           — anything that doesn't clearly fit the above categories

## NEGOTIATION MESSAGE
Write a 1–2 sentence negotiation_message the buyer can copy and send to the seller.
Rules:
- Sound like a real person, not a bot. Casual but respectful.
- Reference a specific dollar figure from the market data (eBay sold avg or recommended_offer).
- Never mention "Deal Scout", AI, or apps — the buyer is sending this themselves.
- If the deal is already excellent (score ≥ 8) or the listing asks below market, say so briefly
  and suggest paying asking or close to it.
- If is_vehicle=True, reference mileage context or "similar listed at $X" instead of eBay comps.
Examples:
  Good: "Hey, I'm interested — I've been seeing similar ones sell for around $180 on eBay. Any chance you'd take $160?"
  Good: "Love the listing! I saw a couple others in the same condition go for about $95. Would you do $90?"
  Bad: "According to market data analysis, the recommended offer price is $160.00."

## BUNDLE BREAKDOWN
bundle_items: If this is a multi-item bundle (is_multi_item=True in the listing), list each
distinct item with your best estimate of its individual used market value. Use this structure:
  [{{"item": "Dewalt 20V drill", "value": 75}}, {{"item": "circular saw", "value": 60}}]

If NOT a bundle listing, return an empty array: []
Aim for 2–8 items. Lump minor accessories (charger, case, manual) into a parent item's value
rather than listing them separately. Values should reflect realistic used eBay sold prices.
"""


# ── Claude API Call ───────────────────────────────────────────────────────────

def _is_safe_image_url(url: str) -> bool:
    """Validate image URL to prevent SSRF attacks."""
    from urllib.parse import urlparse
    try:
        parsed = urlparse(url)
        if parsed.scheme not in ("http", "https"):
            return False
        host = parsed.hostname or ""
        if not host:
            return False
        blocked = (
            host in ("localhost", "127.0.0.1", "0.0.0.0", "[::1]", "metadata.google.internal")
            or host.startswith("10.")
            or host.startswith("172.") and 16 <= int(host.split(".")[1]) <= 31
            or host.startswith("192.168.")
            or host.startswith("169.254.")
            or host.endswith(".local")
            or host.endswith(".internal")
        )
        return not blocked
    except Exception:
        return False


async def _fetch_image_base64(image_url: str) -> Optional[tuple[str, str]]:
    """
    Fetch an image URL and return (base64_data, media_type).
    Returns None if fetch fails — caller falls back to text-only scoring.
    """
    if not _is_safe_image_url(image_url):
        log.warning(f"Image URL blocked (SSRF protection): {image_url[:80]}")
        return None
    try:
        import httpx
        import base64
        MAX_IMAGE_SIZE = 10 * 1024 * 1024
        async with httpx.AsyncClient(timeout=6.0, follow_redirects=True, max_redirects=3) as http:
            resp = await http.get(
                image_url,
                headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}
            )
        if resp.status_code != 200:
            log.warning(f"Image fetch failed: HTTP {resp.status_code} for {image_url[:80]}")
            return None
        if len(resp.content) > MAX_IMAGE_SIZE:
            log.warning(f"Image too large: {len(resp.content)//1024}KB for {image_url[:80]}")
            return None
        media_type = resp.headers.get("content-type", "image/jpeg").split(";")[0].strip()
        if not media_type.startswith("image/"):
            return None
        b64 = base64.standard_b64encode(resp.content).decode()
        log.info(f"Image fetched: {len(resp.content)//1024}KB, {media_type}")
        return b64, media_type
    except Exception as e:
        log.warning(f"Image fetch error: {type(e).__name__}: {e}")
        return None


async def _fetch_multiple_images(image_urls: list[str], max_images: int = 3) -> list[tuple[str, str]]:
    """
    Fetch up to max_images concurrently. Returns list of (base64_data, media_type) tuples.
    Skips failed fetches gracefully.
    """
    if not image_urls:
        return []

    urls_to_fetch = image_urls[:max_images]
    tasks = [_fetch_image_base64(url) for url in urls_to_fetch]
    results = await asyncio.gather(*tasks, return_exceptions=True)

    fetched = []
    for r in results:
        if isinstance(r, tuple) and len(r) == 2:
            fetched.append(r)

    log.info(f"[Vision] Fetched {len(fetched)}/{len(urls_to_fetch)} images for multi-image analysis")
    return fetched


def _market_fallback_score(listing: dict, market_value: dict, image_analyzed: bool = False) -> DealScore:
    """
    Rule-based deal score using only market data — returned when Claude is unavailable.
    No AI call. Uses price vs estimated_value ratio to produce a simple score.

    Score bands:
      < 50% of market  → 9  (exceptional)
      50–65%           → 8  (great)
      65–80%           → 7  (good)
      80–90%           → 6  (fair)
      90–100%          → 5  (at market)
      100–115%         → 4  (slightly above)
      > 115%           → 3  (overpriced)
      no market data   → 5  (neutral)
    """
    price = float(listing.get("price", 0))
    est   = float(market_value.get("estimated_value", 0) or 0)

    if est > 0 and price > 0:
        ratio = price / est
        if ratio < 0.50:
            score, verdict = 9, "Exceptional Deal"
            summary = f"Asking ${price:.0f} vs ~${est:.0f} market — well below market value."
            should_buy = True
        elif ratio < 0.65:
            score, verdict = 8, "Great Deal"
            summary = f"Asking ${price:.0f} vs ~${est:.0f} market — significantly below market."
            should_buy = True
        elif ratio < 0.80:
            score, verdict = 7, "Good Deal"
            summary = f"Asking ${price:.0f} vs ~${est:.0f} market — priced below market."
            should_buy = True
        elif ratio < 0.90:
            score, verdict = 6, "Fair Deal"
            summary = f"Asking ${price:.0f} vs ~${est:.0f} market — slightly below market."
            should_buy = True
        elif ratio < 1.00:
            score, verdict = 5, "At Market"
            summary = f"Asking ${price:.0f} vs ~${est:.0f} market — at market price."
            should_buy = False
        elif ratio < 1.15:
            score, verdict = 4, "Slightly Overpriced"
            summary = f"Asking ${price:.0f} vs ~${est:.0f} market — slightly above market."
            should_buy = False
        else:
            score, verdict = 3, "Overpriced"
            summary = f"Asking ${price:.0f} vs ~${est:.0f} market — above market value."
            should_buy = False
    else:
        score, verdict = 5, "Unable to Score"
        summary = "No market data available for comparison."
        should_buy = False

    offer = price * 0.88 if should_buy else price * 0.80

    return DealScore(
        score             = score,
        verdict           = verdict,
        summary           = summary + " (AI scoring temporarily unavailable — market data only.)",
        value_assessment  = f"Market estimate: ~${est:.0f}" if est > 0 else "No market data",
        condition_notes   = "Condition analysis unavailable (AI offline)",
        red_flags         = [],
        green_flags       = [],
        recommended_offer = round(offer, -1),
        should_buy        = should_buy,
        confidence        = "low",
        model_used        = "market-data-fallback",
        image_analyzed    = False,
    )


async def score_deal(
    listing: dict,
    market_value: dict,
    image_url: Optional[str] = None,
    image_urls: Optional[list[str]] = None,
    product_evaluation=None,
    photo_count: int = 0,
) -> Optional[DealScore]:
    """
    Send listing + market data to Claude and parse the deal score response.

    image_urls: list of image URLs for multi-image vision analysis (up to 3).
    image_url: legacy single URL fallback (used if image_urls not provided).
    """
    if not os.getenv("AI_INTEGRATIONS_ANTHROPIC_BASE_URL"):
        log.error("ANTHROPIC_API_KEY not set in .env")
        log.error("Get your key at: https://console.anthropic.com")
        return None

    prompt = build_scoring_prompt(listing, market_value, product_evaluation, photo_count=photo_count)

    all_urls = image_urls or ([image_url] if image_url else [])
    image_results = []
    if all_urls:
        log.info(f"Fetching {min(len(all_urls), 3)} listing image(s) for vision analysis...")
        image_results = await _fetch_multiple_images(all_urls, max_images=3)

    image_analyzed = len(image_results) > 0
    num_images = len(image_results)

    if image_analyzed:
        message_content = []
        for idx, (b64_data, media_type) in enumerate(image_results):
            message_content.append({
                "type": "image",
                "source": {
                    "type":       "base64",
                    "media_type": media_type,
                    "data":       b64_data,
                }
            })

        vision_instruction = (
            f"These {num_images} photo(s) are for a listing titled: '{listing.get('title', 'unknown item')}'\n\n"
        )
        if photo_count > num_images:
            vision_instruction += (
                f"NOTE: This listing has {photo_count} total photo(s). You are analyzing {num_images} of {photo_count}. "
                "Do NOT flag limited photo quantity as a red flag — additional photos exist.\n\n"
            )
        vision_instruction += (
            "IMPORTANT: Focus ONLY on the PRIMARY SUBJECT of these photos (the item being sold). "
            "Background objects, room decor, and other items visible in the environment are "
            "INCIDENTAL — they are NOT the listing item and should NOT affect your analysis. "
            "If you see multiple objects, the item matching the listing title is the one being sold.\n\n"
            "Analyze the primary item (the one being sold) across ALL provided photos:\n"
            "- Is the visible condition consistent with the seller's claimed condition?\n"
            "- Are there signs of damage, wear, or missing parts not mentioned in ANY photo?\n"
            "- Are any included accessories visible?\n"
            "- Do different angles reveal issues not visible in the first photo?\n\n"
        )

        message_content.append({
            "type": "text",
            "text": vision_instruction + prompt
        })
        log.info(f"Sending listing + {num_images} photo(s) to Claude Vision...")
    else:
        message_content = prompt
        log.info("Sending listing to Claude (text-only)...")

    try:
        from scoring import claude_call_with_retry
        response = await claude_call_with_retry(
            lambda: _get_scoring_client().messages.create(
                model="claude-haiku-4-5",
                max_tokens=1024,
                messages=[{"role": "user", "content": message_content}]
            ),
            label="DealScorer",
        )

        raw_text = response.content[0].text.strip()
        log.debug(f"Claude raw response:\n{raw_text}")

        # Strip markdown fences — Claude often wraps JSON in ```json ... ```
        # even when told not to. This is the most common silent failure point.
        clean_text = raw_text
        if "```" in clean_text:
            # Extract content between first { and last }
            import re
            json_match = re.search(r'\{.*\}', clean_text, re.DOTALL)
            if json_match:
                clean_text = json_match.group()
            else:
                log.error(f"Claude returned markdown but no JSON object found:\n{raw_text}")
                return None

        try:
            data = json.loads(clean_text)
        except json.JSONDecodeError as e:
            # Claude sometimes puts unescaped double quotes inside string values
            # (e.g. the word "Unknown" in a summary). json_repair handles this.
            try:
                import json_repair
                data = json_repair.loads(clean_text)
                log.warning(f"JSON repaired after initial parse failure: {e}")
            except Exception as e2:
                log.error(f"JSON parse failed: {e}\nRepair also failed: {e2}\nRaw text was:\n{raw_text}")
                return None

        # WHY `or 0` not default=0:
        #   data.get("recommended_offer", 0) returns None when the key EXISTS
        #   but has JSON value null — the default only fires when the key is absent.
        #   float(None) → TypeError. Using `or 0` collapses both None and 0 correctly.
        raw_offer = data.get("recommended_offer")
        # Use 0.0 when Claude returns null/None (signal: don't score, fallback to 85% of price)
        # Use -1.0 when Claude explicitly returns 0 (signal: do not buy / listing is a scam)
        # The UI reads -1 as 'Not recommended' instead of displaying '$0.00'
        if raw_offer is None:
            safe_offer = float(listing.get("price", 0) * 0.85)
        elif float(raw_offer) == 0.0:
            safe_offer = -1.0  # Sentinel: tells UI to display 'Not recommended'
        else:
            safe_offer = float(raw_offer)

        raw_aff_cat    = (data.get("affiliate_category") or "").strip().lower()
        raw_neg_msg    = (data.get("negotiation_message") or "").strip()
        raw_bundle     = data.get("bundle_items")
        # bundle_items must be a list of {item, value} dicts; coerce anything else to []
        if isinstance(raw_bundle, list) and raw_bundle:
            bundle_items = [
                {"item": str(b.get("item", "")), "value": float(b.get("value", 0))}
                for b in raw_bundle if isinstance(b, dict) and b.get("item")
            ]
        else:
            bundle_items = []

        return DealScore(
            score               = int(data.get("score", 5)),
            verdict             = data.get("verdict", "No verdict"),
            summary             = data.get("summary", ""),
            value_assessment    = data.get("value_assessment", ""),
            condition_notes     = data.get("condition_notes", ""),
            red_flags           = data.get("red_flags") or [],
            green_flags         = data.get("green_flags") or [],
            recommended_offer   = safe_offer,
            should_buy          = bool(data.get("should_buy", False)),
            confidence          = data.get("confidence", "medium"),
            model_used          = response.model,
            image_analyzed      = image_analyzed,
            affiliate_category  = raw_aff_cat,
            negotiation_message = raw_neg_msg,
            bundle_items        = bundle_items,
        )

    except anthropic.AuthenticationError as e:
        # Surface the real error so FastAPI can show it in the sidebar
        raise RuntimeError(f"Anthropic auth failed — check ANTHROPIC_API_KEY in .env ({e})") from e
    except anthropic.RateLimitError as e:
        log.warning(f"[Scorer] Claude rate limit — using market-data fallback: {e}")
        return _market_fallback_score(listing, market_value, image_analyzed)
    except anthropic.BadRequestError as e:
        # This usually means billing issue or model not available
        raise RuntimeError(f"Anthropic bad request — likely billing or model issue ({e})") from e
    except anthropic.NotFoundError as e:
        raise RuntimeError(f"Anthropic model not found — check model string ({e})") from e
    except anthropic.InternalServerError as e:
        # Transient server-side outage — return a market-data-only fallback score
        # so the user still gets a result instead of a hard error.
        log.warning(f"[Scorer] Claude 500 (server outage) — using market-data fallback: {e}")
        return _market_fallback_score(listing, market_value, image_analyzed)
    except Exception as e:
        # Any other unexpected error — also fall back gracefully
        log.warning(f"[Scorer] Unexpected Claude error ({type(e).__name__}) — using market-data fallback: {e}")
        return _market_fallback_score(listing, market_value, image_analyzed)


# ── Output ────────────────────────────────────────────────────────────────────

def print_deal_score(score: DealScore, listing: dict):
    """Print the full deal analysis report to console."""
    score_bar = "█" * score.score + "░" * (10 - score.score)
    buy_label = "✅ BUY" if score.should_buy else "❌ PASS"

    print("\n" + "="*60)
    print("  AI DEAL SCORE REPORT")
    print("="*60)
    print(f"  Item:      {listing['title']}")
    print(f"  Price:     {listing['raw_price_text']}")
    print()
    print(f"  Score:     {score.score}/10  [{score_bar}]")
    print(f"  Verdict:   {score.verdict}")
    print(f"  Decision:  {buy_label}")
    print()
    print(f"  Summary:")
    # Word-wrap the summary at 55 chars for clean console output
    words = score.summary.split()
    line = "    "
    for word in words:
        if len(line) + len(word) > 57:
            print(line)
            line = "    "
        line += word + " "
    if line.strip():
        print(line)
    print()
    print(f"  Value:     {score.value_assessment}")
    print(f"  Condition: {score.condition_notes}")
    print()
    if score.green_flags:
        print("  ✅ Green flags:")
        for flag in score.green_flags:
            print(f"     • {flag}")
    if score.red_flags:
        print("  ⚠️  Red flags:")
        for flag in score.red_flags:
            print(f"     • {flag}")
    print()
    print(f"  Recommended offer: ${score.recommended_offer:.2f}")
    print(f"  Confidence:        {score.confidence.upper()}")
    print(f"  Scored by:         {score.model_used}")
    print("="*60)


def save_deal_score(score: DealScore, listing_title: str) -> Path:
    """Save the deal score to /data — consumed by the Week 4 React UI."""
    safe  = "".join(c for c in listing_title if c.isalnum() or c in " _-")[:40]
    fpath = DATA_DIR / f"deal_score_{safe.strip().replace(' ', '_')}.json"
    fpath.write_text(json.dumps(asdict(score), indent=2))
    log.info(f"Deal score saved: {fpath}")
    return fpath


# ── Full Pipeline Runner ──────────────────────────────────────────────────────

async def run_full_pipeline(listing_file: Path, market_value_file: Path):
    """
    Run the complete scoring pipeline for a single listing.
    This is the function the FastAPI endpoint will call in Week 4.
    """
    listing      = json.loads(listing_file.read_text())
    market_value = json.loads(market_value_file.read_text())

    print(f"\n  Scoring: {listing['title']}")
    print(f"  Price:   ${listing['price']:.2f}")
    print(f"  eBay est value: ${market_value['estimated_value']:.2f}")
    print(f"\n  Sending to Claude...")

    deal_score = await score_deal(listing, market_value)

    if deal_score:
        print_deal_score(deal_score, listing)
        output = save_deal_score(deal_score, listing["title"])
        print(f"\n  Saved to: {output}")
        print(f"  Ready for Week 4 — React UI")
        return deal_score
    else:
        log.error("Scoring failed — check your ANTHROPIC_API_KEY in .env")
        return None


# ── Standalone Entry Point ────────────────────────────────────────────────────

async def main():
    """
    Test the scorer against the most recent listing + market value in /data.
    Requires ANTHROPIC_API_KEY to be set in .env.
    """
    # Find most recent listing file
    listing_files = list(DATA_DIR.glob("listing_*.json"))
    if not listing_files:
        log.error("No listing files in /data — run the scraper first")
        return

    listing_file = max(listing_files, key=lambda f: f.stat().st_mtime)

    # Find matching market value file
    # Match by looking for market_value_ file with same item name stem
    market_files = list(DATA_DIR.glob("market_value_*.json"))
    if not market_files:
        log.error("No market value files in /data — run ebay_pricer.py first")
        return

    market_file = max(market_files, key=lambda f: f.stat().st_mtime)

    log.info(f"Listing file:      {listing_file.name}")
    log.info(f"Market value file: {market_file.name}")

    await run_full_pipeline(listing_file, market_file)


if __name__ == "__main__":
    asyncio.run(main())
