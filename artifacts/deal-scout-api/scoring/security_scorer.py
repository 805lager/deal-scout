"""
Security Scorer — Scam & Fraud Detection for Used Marketplace Listings

WHY THIS EXISTS:
  A listing can score 8/10 on deal quality and still be a scam.
  Price-only analysis misses the most dangerous listings entirely:
    - Stolen goods priced slightly below market (looks like a good deal)
    - Phishing/account-harvesting via off-platform contact requests
    - iCloud/carrier-locked devices that become bricks after purchase
    - Classic advance-fee patterns ("I'll ship it, send payment first")

  This module runs as a SECOND, PARALLEL Claude call — cheap (Haiku),
  fast (~1s), and completely independent from deal scoring so a scam
  listing can't "pass" just because the price looks good.

DETECTION LAYERS (in order of reliability):

  Layer 1 — RULE-BASED (free, instant, high confidence)
    Regex/keyword patterns extracted directly from the listing text.
    These fire before Claude is called — if Layer 1 finds hard red flags,
    the security score is already low before AI even runs.
    Catches: Zelle/Venmo, off-platform contact, moving/deployed stories,
    too-good-to-be-true pricing, shipping scams on local-only items.

  Layer 2 — AI ANALYSIS (Claude Haiku, ~$0.0003/call)
    Sends listing text to Claude with a scam-detection system prompt.
    Returns structured JSON: score, risk_level, flags[], recommendation.
    Catches: subtle manipulation language, inconsistency between
    condition claim and description, social engineering patterns that
    don't match exact regex patterns.

  Layer 3 — ITEM-SPECIFIC RISKS (Claude knows these from training)
    Prompted to check category-specific risks:
    - Electronics: iCloud lock, IMEI blacklist, serial number missing
    - Vehicles: VIN missing/altered, salvage title, odometer
    - Designer goods: counterfeit indicators
    - Baby gear: recall status

COST:
  Layer 1: $0.00 (regex, no API call)
  Layer 2+3: ~$0.0003 per listing (Claude Haiku, ~300 input tokens)
  Total: negligible. At 10,000 listings/day = ~$3/day.

OUTPUT:
  SecurityScore dataclass — serialized into the API response as
  `security_score` dict. Rendered as a shield card in the sidebar.
"""

import asyncio
import json
import logging
import os
import re
import time
from dataclasses import dataclass, field
from typing import Optional

import anthropic
from dotenv import load_dotenv

load_dotenv()
log = logging.getLogger(__name__)

_cache: dict = {}
_CACHE_TTL = 300  # 5 min — scam patterns are session-level, not long-lived


# ── Data Model ────────────────────────────────────────────────────────────────

@dataclass
class SecurityScore:
    """
    Security / scam risk assessment for a single listing.

    score:          1–10 (10 = very safe, 1 = almost certainly a scam)
    risk_level:     "low" | "medium" | "high" | "critical"
    flags:          List of specific red flags found (human-readable)
    recommendation: One of: "safe to proceed" | "proceed with caution" | "likely scam"
    layer1_flags:   Rule-based flags (fired before AI call)
    ai_flags:       Additional flags found by Claude
    item_risks:     Item-specific risks (iCloud lock, missing VIN, etc.)
    confidence:     "high" | "medium" | "low" — how sure we are of the score
    """
    score:          int
    risk_level:     str
    flags:          list
    recommendation: str
    warnings:       list = field(default_factory=list)
    positives:      list = field(default_factory=list)
    layer1_flags:   list = field(default_factory=list)
    ai_flags:       list = field(default_factory=list)
    item_risks:     list = field(default_factory=list)
    confidence:     str  = "medium"
    model_used:     str  = ""
    checks_run:     list = field(default_factory=list)


# ── Layer 1: Rule-Based Pattern Detection ─────────────────────────────────────

# Each tuple: (pattern, flag_message, severity)
# severity: "critical" | "high" | "medium" | "low"
SCAM_PATTERNS = [
    # Payment method red flags — highest signal
    (r'\b(zelle|cashapp|cash\s*app|venmo|western\s*union|wire\s*transfer|moneygram|crypto|bitcoin|gift\s*card)\b',
     "Requests suspicious payment method (Zelle/Venmo/wire/crypto/gift card)", "critical"),

    (r'\bpaypal\s*(friends?\s*and\s*family|f&f|f\/f|ff)\b',
     "Requests PayPal Friends & Family (no buyer protection)", "critical"),

    # Off-platform contact — almost always a scam vector
    (r'(text|call|email|whatsapp|telegram|signal|kik)\s*(me\s*)?(at|on|@|\+1|\()',
     "Requests off-platform contact (text/email/WhatsApp)", "high"),

    (r'contact\s*me\s*(directly|outside|off)',
     "Asks to contact outside the platform", "high"),

    # Shipping scams on items that shouldn't ship.
    # WHY NOT "can deliver" alone: many FBM sellers of large items (furniture,
    # appliances, boats) legitimately offer local delivery for a small fee.
    # "Local delivery" or "deliver within X miles" is normal, not a red flag.
    # We target seller-initiated shipping of high-value goods to remote buyers —
    # that's the actual scam vector (pay first, never ships).
    # Reduced from "high" to "medium": shipping offer alone isn't high-risk;
    # it's only suspicious in combination with other signals.
    (r'\b(i\s*can\s*ship|willing\s*to\s*ship|will\s*ship)\b(?!.*local)',
     "Offers to ship (verify in-person pickup option before sending payment)", "medium"),

    # Classic advance-fee / social engineering stories.
    # WHY "moving" is intentionally excluded from this pattern:
    # "Moving sale" is one of the most common legitimate FBM listing types —
    # flagging every seller who mentions moving destroys scorer credibility.
    # Scam-specific relocating language uses "relocating", "deployed", "military",
    # "overseas", "out of country" — these are rare in legitimate listings.
    (r'\b(relocating|deployed|military|overseas|out\s*of\s*country|out\s*of\s*state\s+(cannot|can\'t|unable))\b',
     "Uses relocation/deployment story (common scam narrative)", "medium"),

    # Emotional/hardship stories — death and divorce are real scam signals;
    # "estate sale" is explicitly excluded because it's a completely legitimate
    # and common FBM listing type (selling items from a deceased relative's estate
    # is normal and not inherently suspicious).
    (r'\b(divorce|death|passed\s*away|deceased|inheritance)\b',
     "Uses emotional hardship story (common scam narrative)", "medium"),

    (r'\b(my\s*(son|daughter|kid|child|husband|wife)\s*(left|moved|going\s*to\s*college))\b',
     "Uses family story to justify urgency (common pressure tactic)", "medium"),

    # Urgency / pressure tactics
    (r'\b(must\s*sell|need\s*(to\s*sell|gone|cash)\s*(today|asap|fast|quick|now)|first\s*come\s*first\s*served|price\s*firm)\b',
     "High urgency language (pressure tactic)", "low"),

    (r'\bno\s*(returns?|refunds?|trades?|lowball|low\s*offers?|bs\s*offers?)\b',
     "Refuses returns/trades/negotiation — limits buyer recourse", "low"),

    # Too good to be true pricing signals (checked separately via market data)
    # These are description-based signals, not price-based
    (r'\b(stolen|hot|fell\s*off\s*(a\s*)?truck|found\s*it|not\s*mine)\b',
     "Description suggests item may be stolen", "critical"),

    # Identity/account verification requests
    (r'\b(verify|verification|confirm\s*your\s*(identity|account|info))\b',
     "Requests identity/account verification (phishing risk)", "critical"),

    # Escrow scams
    (r'\b(escrow|middleman|third\s*party\s*payment)\b',
     "Mentions escrow or third-party payment (common escrow scam setup)", "high"),
]

# Item-specific risk patterns — checked against category
ITEM_RISK_PATTERNS = {
    "phones": [
        (r'\b(icloud|find\s*my\s*iphone|activation\s*lock)\b',
         "Possible iCloud activation lock — verify before purchase"),
        (r'(no\s*imei|imei\s*not|carrier\s*locked|locked\s*to)',
         "Carrier locked or IMEI issue mentioned"),
        (r'(cracked|broken\s*screen|screen\s*issues)',
         "Screen damage mentioned — verify repair cost"),
    ],
    "electronics": [
        (r'(no\s*box|missing\s*accessories|sold\s*as\s*is)',
         "Missing accessories or sold as-is — no warranty recourse"),
        (r'(powers?\s*on|turns?\s*on)\s*(but|however)',
         "Qualified power-on claim — may have hidden issues"),
    ],
    "vehicles": [
        (r'(no\s*title|title\s*(issues?|problems?|pending|missing))',
         "Title issues mentioned — cannot legally transfer ownership"),
        # WHY 'lemon law' not bare 'lemon': The word 'lemon' alone matches city
        # names like 'Lemon Grove, CA' or 'Lemon Heights, CA', triggering a false
        # 'Salvage/rebuilt/flood damage' flag on clean-title cars. (Bug B-S4)
        # Sellers who invoke 'lemon law' are the actual risk signal.
        (r'(salvage|rebuilt|flood\s*damage|lemon\s+law)',
         "Salvage/rebuilt/flood damage mentioned"),
        (r'(no\s*vin|vin\s*(removed|altered|missing))',
         "VIN issues — potential stolen vehicle"),
    ],
    "bikes": [
        (r'(no\s*serial|serial\s*(number\s*)?(missing|removed|filed))',
         "Serial number missing — possible stolen bike"),
    ],
    "computers": [
        (r'(bios\s*password|locked\s*(bios|laptop)|corporate\s*(device|laptop|asset))',
         "Device may be corporate-locked or BIOS-locked"),
    ],
    "gaming": [
        (r'(banned\s*(account|console)|account\s*banned)',
         "Console/account ban mentioned — verify online functionality"),
    ],
    "baby": [
        (r'(expired|old|used\s*car\s*seat)',
         "Car seat safety: verify not expired and no accident history"),
    ],
}


def run_layer1(listing_text: str, title: str, category: str, listing_price: float, market_value) -> list:
    """
    Fast regex scan — runs in <1ms, no API call.
    Returns list of (flag_message, severity) tuples.
    """
    combined = f"{title} {listing_text}".lower()
    found = []
    seen = set()

    for pattern, message, severity in SCAM_PATTERNS:
        if re.search(pattern, combined, re.IGNORECASE) and message not in seen:
            found.append({"flag": message, "severity": severity})
            seen.add(message)

    # Item-specific risks
    cat_patterns = ITEM_RISK_PATTERNS.get(category, [])
    for pattern, message in cat_patterns:
        if re.search(pattern, combined, re.IGNORECASE) and message not in seen:
            found.append({"flag": message, "severity": "medium"})
            seen.add(message)

    # Price-based check — category-aware thresholds
    PRICE_THRESHOLDS = {
        "phones":      (0.30, "critical"),
        "electronics": (0.25, "high"),
        "computers":   (0.25, "high"),
        "gaming":      (0.25, "high"),
        "cameras":     (0.25, "high"),
        "tools":       (0.15, "medium"),
        "bikes":       (0.15, "medium"),
        "furniture":   (0.10, "low"),
        "outdoor":     (0.15, "medium"),
        "sports":      (0.15, "medium"),
        "vehicles":    (0.40, "high"),
        "_default":    (0.20, "high"),
    }
    if market_value and listing_price > 0:
        est = getattr(market_value, "estimated_value", 0) or 0
        if est > 0:
            thresh, severity = PRICE_THRESHOLDS.get(category, PRICE_THRESHOLDS["_default"])
            if listing_price < est * thresh:
                pct_below = 100 - int(listing_price / est * 100)
                found.append({
                    "flag": f"Price is {pct_below}% below market estimate — verify legitimacy",
                    "severity": severity,
                })

    HARD_FLOOR_PRICES = {
        "phones":    100,
        "computers": 75,
        "gaming":    50,
        "vehicles":  500,
        "cameras":   40,
    }
    floor = HARD_FLOOR_PRICES.get(category, 0)
    if floor > 0 and 0 < listing_price < floor and "too good" not in str(seen).lower():
        found.append({
            "flag": f"Price ${listing_price:.0f} is unusually low for {category} — verify legitimacy",
            "severity": "high",
        })

    return found


# ── Layer 1 Score Calculator ──────────────────────────────────────────────────

def _layer1_score(flags: list) -> int:
    """Convert rule-based flags to a preliminary score."""
    if not flags: return 10

    severity_weights = {"critical": 4, "high": 2, "medium": 1, "low": 0.5}
    deduction = sum(severity_weights.get(f["severity"], 1) for f in flags)

    # Layer 1 alone never gives 1/10 — AI confirmation needed for the floor.
    # Cap at 9 deduction so minimum score is 1, but in practice the cap keeps
    # pure regex scores at 2 minimum (gives AI room to lower further if needed).
    # WHY 2 minimum: regex patterns can't assess intent or context — a seller
    # mentioning "PayPal F&F" may be legitimate; only Claude can confirm scam.
    score = max(2, 10 - int(deduction))
    return score


# ── Layer 2+3: Claude AI Analysis ─────────────────────────────────────────────

SECURITY_PROMPT = """You are a fraud detection expert specializing in used marketplace scams.
Analyze this listing and return ONLY valid JSON with no markdown, no explanation outside the JSON.

Listing to analyze:
Title: {title}
Price: ${price}
Description: {description}
Condition: {condition}
Seller joined: {seller_joined}
Seller rating: {seller_rating}
Photos provided: {photo_count}
Category: {category}
Layer 1 flags already detected: {layer1_flags}

Return this exact JSON structure:
{{
  "score": <integer 1-10, where 10=very safe, 1=definite scam>,
  "risk_level": "<low|medium|high|critical>",
  "flags": ["<specific flag 1>", "<specific flag 2>"],
  "positives": ["<positive signal 1>", "<positive signal 2>"],
  "item_risks": ["<item-specific risk 1>"],
  "recommendation": "<safe to proceed|proceed with caution|likely scam>",
  "confidence": "<high|medium|low>"
}}

For "positives", identify trust signals such as:
- Detailed description with specifics (model numbers, measurements, history)
- Seller provides many clear photos
- In-person pickup available
- Legitimate reason for selling mentioned
- Good seller rating/history
Do NOT include "reasonable price" as a positive — you do not have market comparison data. Pricing analysis is handled separately.
Return 1-4 positives. If nothing positive stands out, return an empty list.

Scoring guide:
- 9-10: No red flags, legitimate-looking listing
- 7-8: Minor concerns, worth verifying but likely fine
- 5-6: Notable red flags, buyer should be cautious
- 3-4: Multiple serious red flags, likely problematic
- 1-2: Almost certainly a scam or stolen goods

Check specifically for:
1. Payment method manipulation (Zelle, Venmo, wire, gift cards)
2. Off-platform contact requests (text me, email me, WhatsApp)
3. Scam narrative patterns (military/deployed, moving, death/divorce)
4. Price anomalies relative to condition claims
5. Vague or evasive description language
6. Item-specific risks: iCloud lock (phones), VIN issues (vehicles), 
   serial number removal (bikes), BIOS lock (laptops), account bans (gaming)
7. Pressure tactics and urgency language
8. Condition contradictions (claims "like new" but describes damage)

Photo count guidance (only flag when genuinely suspicious, not just "many"):
- Vehicles/RVs/boats: 20-50 photos is normal and desirable — do NOT flag
- Furniture, appliances, large items: 10-20 photos is normal — do NOT flag
- Small items (tools, clothing, accessories, electronics <$200): flag only if >25 photos AND description is vague
- ANY category: 0-1 photos for items priced over $50 is a significant red flag — flag it
- ANY category: flag if photos look like stock/catalog images (perfectly lit white background, no personal context)
- Never use photo count as a standalone flag — only combine it with other concerns

Keep flags concise (under 12 words each). Return 0-5 flags total."""


async def run_layer2(
    listing,
    category: str,
    layer1_flags: list,
    client: anthropic.Anthropic,
    effective_title: str = "",  # normalized title from product_extractor — fixes NameError
) -> dict:
    """
    Claude Haiku security analysis. Returns parsed JSON dict or raises.
    Runs in executor to avoid blocking the async event loop.
    """
    layer1_summary = "; ".join(f["flag"] for f in layer1_flags) if layer1_flags else "None"

    # Extract seller trust signals from the dict the content script sends.
    # FBM sends: { joined_date, rating, rating_count }
    # Some older code used "member_since" — check both keys for compatibility.
    seller_trust_dict = (getattr(listing, "seller_trust", None) or {})
    seller_joined = (
        seller_trust_dict.get("joined_date")       # FBM key (fbm.js v0.19+)
        or seller_trust_dict.get("member_since")   # legacy / other platforms
        or "unknown"
    )

    raw_rating   = seller_trust_dict.get("rating")
    raw_count    = seller_trust_dict.get("rating_count", 0) or 0
    highly_rated = seller_trust_dict.get("highly_rated", False)
    if raw_rating:
        suffix = " · Highly rated on Marketplace" if highly_rated else ""
        seller_rating = f"{float(raw_rating):.1f}/5 ({raw_count} reviews){suffix}"
    elif highly_rated:
        seller_rating = f"Highly rated on Marketplace ({raw_count} reviews)" if raw_count else "Highly rated on Marketplace"
    elif seller_joined != "unknown":
        seller_rating = f"not displayed (established member since {seller_joined})"
    else:
        seller_rating = "unknown"

    raw_photo_count = getattr(listing, "photo_count", 0) or 0
    raw_image_urls  = len(getattr(listing, "image_urls", None) or [])
    photo_count     = max(raw_photo_count, raw_image_urls)
    if photo_count == 0:
        photo_str = "unknown (not available from DOM extraction)"
    elif raw_photo_count > raw_image_urls:
        photo_str = f"{photo_count} photo(s)"
    else:
        photo_str = f"{photo_count} photo(s) extracted (listing may have more — DOM extraction is limited)"

    # Use effective_title if passed, fall back to raw listing title
    title_for_prompt = (effective_title or listing.title or "")[:100]
    prompt = SECURITY_PROMPT.format(
        title         = title_for_prompt,  # normalized title, not raw seller text
        price         = listing.price,
        description   = (listing.description or "")[:600],
        condition     = listing.condition or "unknown",
        seller_joined = seller_joined,
        seller_rating = seller_rating,
        photo_count   = photo_str,
        category      = category,
        layer1_flags  = layer1_summary,
    )

    from scoring import claude_call_with_retry
    response = await claude_call_with_retry(
        lambda: client.messages.create(
            model      = "claude-haiku-4-5",
            max_tokens = 400,
            messages   = [{"role": "user", "content": prompt}],
        ),
        label="SecurityScorer",
    )

    raw = response.content[0].text.strip()

    # Strip markdown fences if Claude added them despite instructions
    raw = re.sub(r'^```(?:json)?\s*', '', raw)
    raw = re.sub(r'\s*```$', '', raw)

    return json.loads(raw)


# ── Main Entry Point ──────────────────────────────────────────────────────────

async def score_security(
    listing,
    category: str,
    market_value,
    anthropic_client=None,   # Optional — creates its own client from env if not passed
    normalized_title: str = "",  # product_info.display_name — normalized by product_extractor
    # WHY: listing.title is the raw seller text (e.g. "taylor electrostatic guitar").
    # After product_extractor runs, we know the correct name. Passing it here stops
    # Claude from flagging the seller's typo as a product-authenticity red flag.
) -> SecurityScore:
    """
    Full two-layer security scoring.

    Runs Layer 1 (regex) always.
    Runs Layer 2 (Claude) always for comprehensive analysis.
    Both layers contribute to the final score — Layer 1 anchors it,
    Layer 2 can raise or lower based on AI analysis.

    Never raises — returns a "medium" score on any failure so the
    main scoring pipeline is never blocked by security analysis.
    """
    cache_key = f"sec:{hash(str(listing.title) + str(listing.price) + str(listing.description or '')[:100])}"
    now = time.time()

    if cache_key in _cache and now - _cache[cache_key]["ts"] < _CACHE_TTL:
        log.info("[Security] Cache hit")
        return _cache[cache_key]["data"]

    # Use normalized title if available — falls back to raw listing title.
    # normalized_title comes from product_extractor (e.g. "Taylor Acoustic Electric Guitar")
    # raw listing.title is the seller's text (e.g. "taylor electrostatic guitar")
    effective_title = normalized_title.strip() if normalized_title.strip() else (listing.title or "")
    log.info(f"[Security] Scoring: '{effective_title}' (raw: '{listing.title}') @ ${listing.price} cat={category}")

    # Build client if not passed in
    if anthropic_client is None:
        base_url = os.getenv("AI_INTEGRATIONS_ANTHROPIC_BASE_URL", "")
        api_key  = os.getenv("AI_INTEGRATIONS_ANTHROPIC_API_KEY", "placeholder")
        if not base_url:
            log.warning("[Security] No AI integration configured — layer1 only")
            anthropic_client = None
        else:
            anthropic_client = anthropic.Anthropic(api_key=api_key, base_url=base_url)

    # Layer 1 — always runs
    l1_flags = run_layer1(
        listing_text  = listing.description or "",
        title         = effective_title,  # normalized, not raw seller text
        category      = category,
        listing_price = listing.price,
        market_value  = market_value,
    )
    l1_score = _layer1_score(l1_flags)
    log.info(f"[Security] Layer 1: {len(l1_flags)} flags, score={l1_score}")

    # Layer 2 — Claude Haiku (skipped if no API key)
    ai_result = {}
    if anthropic_client is not None:
        try:
            ai_result = await asyncio.wait_for(
                run_layer2(listing, category, l1_flags, anthropic_client, effective_title),
                timeout=8.0,
            )
            log.info(f"[Security] Layer 2: score={ai_result.get('score')} risk={ai_result.get('risk_level')}")
        except asyncio.TimeoutError:
            log.warning("[Security] Layer 2 timeout — using Layer 1 result only")
        except json.JSONDecodeError as e:
            log.warning(f"[Security] Layer 2 JSON parse error: {e}")
        except Exception as e:
            log.warning(f"[Security] Layer 2 failed: {type(e).__name__}: {e}")
    else:
        log.info("[Security] Skipping Layer 2 (no API client)")


    # Merge scores: Layer 1 anchors, AI adjusts.
    # WHY DYNAMIC WEIGHTING by AI risk level:
    #   When AI sees a clear scam (score 1-3), trust it heavily — regex can't
    #   detect social engineering or subtle manipulation. Giving L1 35% weight
    #   when AI says 2/10 but L1 is clean would produce a misleadingly safe 5/10.
    #   When AI gives a high score (8-10), it agrees with a clean L1, so the
    #   exact blend doesn't matter much — the result is high either way.
    ai_score = ai_result.get("score")
    if ai_score and isinstance(ai_score, (int, float)):
        if ai_score <= 3:
            weight_ai = 0.85   # AI detects critical scam signal — trust it
        elif ai_score <= 5:
            weight_ai = 0.75   # AI sees notable risk — lean toward AI
        else:
            weight_ai = 0.65   # Normal blend
        final_score = round((l1_score * (1 - weight_ai)) + (ai_score * weight_ai))
    else:
        final_score = l1_score

    final_score = max(1, min(10, final_score))

    # Merge flags — deduplicate
    ai_flags   = ai_result.get("flags", []) or []
    ai_positives = ai_result.get("positives", []) or []
    item_risks = ai_result.get("item_risks", []) or []
    l1_messages = [f["flag"] for f in l1_flags]

    def _is_covered_by_l1(ai_flag: str) -> bool:
        ai_low = ai_flag.lower()
        for l1 in l1_messages:
            keywords = [w for w in l1.lower().split() if len(w) > 3][:4]
            if sum(1 for kw in keywords if kw in ai_low) >= 2:
                return True
        return False

    deduped_ai_flags = [f for f in ai_flags if not _is_covered_by_l1(f)]
    all_flags = list(dict.fromkeys(l1_messages + deduped_ai_flags))

    risk_level     = _score_to_risk(final_score)
    recommendation = _score_to_recommendation(final_score)
    confidence = ai_result.get("confidence", "medium") if ai_result else "low"

    warnings = all_flags[:5] + item_risks[:2]

    positives = list(ai_positives)[:4]

    seller_trust_dict = (getattr(listing, "seller_trust", None) or {})
    seller_joined   = seller_trust_dict.get("joined_date") or seller_trust_dict.get("member_since")
    highly_rated    = seller_trust_dict.get("highly_rated", False)
    raw_rating      = seller_trust_dict.get("rating")
    try:
        parsed_rating = float(raw_rating) if raw_rating else 0.0
    except (ValueError, TypeError):
        parsed_rating = 0.0
    try:
        raw_count = int(seller_trust_dict.get("rating_count", 0) or 0)
    except (ValueError, TypeError):
        raw_count = 0

    if highly_rated or (parsed_rating >= 4.5 and raw_count >= 3):
        rating_str = f"{parsed_rating:.0f}/5" if parsed_rating > 0 else "Highly rated"
        positives.insert(0, f"Seller rated {rating_str} ({raw_count} reviews)")
    elif seller_joined:
        positives.append(f"Seller profile since {seller_joined}")

    raw_pc2 = getattr(listing, "photo_count", 0) or 0
    raw_iu2 = len(getattr(listing, "image_urls", None) or [])
    photo_count = max(raw_pc2, raw_iu2)
    if photo_count >= 4:
        positives.append(f"{photo_count} photos provided")

    if market_value:
        est = getattr(market_value, "estimated_value", 0) or 0
        if est > 0 and listing.price > 0:
            ratio = listing.price / est
            if 0.5 <= ratio <= 1.15:
                positives.append("Price is within normal market range")

    positives = list(dict.fromkeys(positives))[:4]

    checks_run = ["Pattern scan (payment, contact, urgency)"]
    if category in ITEM_RISK_PATTERNS:
        checks_run.append(f"Category-specific risks ({category})")
    if market_value:
        checks_run.append("Price vs market anomaly check")
    if ai_result:
        checks_run.append("AI scam language analysis")

    result = SecurityScore(
        score          = final_score,
        risk_level     = risk_level,
        flags          = all_flags[:6],
        recommendation = recommendation,
        warnings       = warnings,
        positives      = positives,
        layer1_flags   = l1_messages,
        ai_flags       = ai_flags,
        item_risks     = item_risks[:3],
        confidence     = confidence,
        model_used     = "claude-haiku-4-5" if ai_result else "layer1-only",
        checks_run     = checks_run,
    )

    _cache[cache_key] = {"data": result, "ts": now}
    log.info(f"[Security] Final: {final_score}/10 — {risk_level} — {recommendation}")
    return result


def _score_to_risk(score: int) -> str:
    # B-S5 FIX: lowered from 8→7 to align with _score_to_recommendation.
    # _score_to_recommendation returns "safe to proceed" at score >= 7, so
    # risk must also be "low" at 7. Old code: score 7 → medium/CAUTION +
    # "safe to proceed" — contradictory in the sidebar UI.
    if score >= 7: return "low"
    if score >= 4: return "medium"
    if score >= 2: return "high"
    return "critical"


def _score_to_recommendation(score: int) -> str:
    if score >= 7: return "safe to proceed"
    if score >= 4: return "proceed with caution"
    return "likely scam"
