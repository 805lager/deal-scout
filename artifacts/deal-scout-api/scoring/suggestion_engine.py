"""
Suggestion Engine — Actionable Buy Recommendations

WHY THIS IS THE MONETIZATION CORE:
  Every suggestion card in the sidebar links to eBay or Amazon with
  affiliate parameters embedded. When a user acts on a deal warning by
  clicking a suggestion card, that click earns commission.

  The fundamental insight: a user scoring a bad deal has ALREADY decided
  to spend money. They just haven't decided where. Showing them a better
  option at that moment of decision is the highest-intent affiliate
  placement possible. No cold traffic, no banner blindness.

  Revenue model:
    - eBay Partner Network: earn when user purchases within 24h of click
    - Amazon Associates: earn when user purchases within 24h of click

TWO SCENARIOS:
  Bad deal (score < 5):
    User: "Should I buy this $500 telescope?"
    Deal Scout: "No — here's the same on eBay for $340, and a better scope
    for $380 with higher reviews."
    → User saves money, we earn affiliate commission on redirect. Win-win.

  Good deal (score >= 7):
    User: "Is this $340 telescope a good deal?"
    Deal Scout: "Yes — great deal. Here's the Amazon price for reference."
    → Validates the purchase. Surfaces Amazon for comparison. Lower conversion
    but builds trust in the product.

SUGGESTION TYPES:
  "same_cheaper"  — Same product, lower price on eBay (from existing market data)
  "better_model"  — Claude recommends a better alternative product
  "same_amazon"   — New retail on Amazon (always shown for context)

AMAZON PA API NOTE:
  Currently uses search links + affiliate tag (no Product Advertising API yet).
  PA API requires 3 qualifying purchases before activation. Apply at:
  https://affiliate-program.amazon.com/help/node/topic/G202049090
  Once approved, replace search links with real product cards (ASIN, image,
  Prime badge) for dramatically better conversion.
"""

import asyncio
import json
import logging
import os
import re
import urllib.parse
from dataclasses import dataclass
from typing import Optional

import anthropic
from dotenv import load_dotenv

load_dotenv()

log = logging.getLogger(__name__)

AMAZON_TAG  = os.getenv("AMAZON_ASSOCIATE_TAG", "dealscout03f-20")
EBAY_CAMPID = os.getenv("EBAY_CAMPAIGN_ID", "5339144027")

_client: Optional[anthropic.Anthropic] = None


def _get_client() -> anthropic.Anthropic:
    global _client
    if _client is None:
        _client = anthropic.Anthropic(
            api_key=os.getenv("AI_INTEGRATIONS_ANTHROPIC_API_KEY", "placeholder"),
            base_url=os.getenv("AI_INTEGRATIONS_ANTHROPIC_BASE_URL"),
        )
    return _client


# ── Data Model ────────────────────────────────────────────────────────────────

@dataclass
class Suggestion:
    """
    A single actionable buy recommendation shown as a card in the sidebar.
    Each card is a revenue opportunity — url always includes affiliate params.
    """
    suggestion_type: str   # "same_cheaper" | "better_model" | "same_amazon"
    title:           str   # Display: "Orion SkyQuest XT8 — eBay Used"
    reason:          str   # Value prop: "Save $120 vs this listing"
    price_label:     str   # "$340" or "From $340" or "New retail"
    url:             str   # Affiliate URL — always embedded
    platform:        str   # "ebay" | "amazon"
    badge:           str   # "Same Model" | "Better Option" | "New on Amazon"
    badge_color:     str   # Hex for badge background
    image_url:       str   # eBay thumbnail or ""
    price:           float # Numeric for sorting


# ── Main Entry Point ──────────────────────────────────────────────────────────

async def get_suggestions(
    product_info,           # ProductInfo from product_extractor
    market_value,           # MarketValue dataclass from ebay_pricer
    deal_score,             # DealScore dataclass from deal_scorer
    listing_price: float,
    shipping_cost: float = 0.0,  # Extracted from listing — adds to true cost
) -> list:
    """
    Generate actionable buy suggestions based on deal score and market data.

    Runs eBay search reuse + Claude recommendation + Amazon link concurrently.
    Always returns a list — empty list on total failure.
    Capped at 3 suggestions for sidebar space.
    """
    suggestions = []

    try:
        # True cost = listed price + shipping. Suggestions compare against this.
        true_cost   = listing_price + shipping_cost
        ebay_task   = _find_ebay_alternatives(product_info, listing_price, true_cost, market_value)
        claude_task = _get_claude_recommendation(product_info, deal_score, listing_price, true_cost)
        amazon_task = _build_amazon_suggestion(product_info, deal_score)

        ebay_suggs, claude_sugg, amazon_sugg = await asyncio.gather(
            ebay_task, claude_task, amazon_task,
            return_exceptions=True,
        )

        if isinstance(ebay_suggs, list):
            suggestions.extend(ebay_suggs)
        if isinstance(claude_sugg, Suggestion) and claude_sugg:
            suggestions.append(claude_sugg)
        if isinstance(amazon_sugg, Suggestion) and amazon_sugg:
            suggestions.append(amazon_sugg)

        # Priority order: direct cheaper listing → better model → amazon → browse fallback
        # WHY browse_ebay IS LAST: it's a generic search link, not a specific recommendation.
        # better_model and same_amazon are higher-value, higher-converting card types.
        priority = {"same_cheaper": 0, "better_model": 1, "same_amazon": 2, "browse_ebay": 3}
        suggestions.sort(key=lambda s: priority.get(s.suggestion_type, 9))

        # Cap at 3 — sidebar is 310px, each card is ~70px
        suggestions = suggestions[:3]
        log.info(f"[Suggestions] {len(suggestions)} suggestions for '{product_info.display_name}'")

    except Exception as e:
        log.warning(f"[Suggestions] Pipeline failed: {type(e).__name__}: {e}")

    return suggestions


# ── eBay Alternatives (reuse existing market data) ────────────────────────────

async def _find_ebay_alternatives(
    product_info,
    listing_price: float,
    true_cost: float,       # listing_price + shipping_cost
    market_value,
) -> list:
    """
    Surface cheaper eBay listings from the market data we already fetched.

    WHY REUSE market_value DATA:
    We already called eBay for pricing and have active_items_sample in hand.
    Filtering those for cheaper options costs zero extra API calls.
    One new eBay search link (sorted by lowest price) is always included
    as a fallback even when no cheaper sample items exist.
    """
    suggestions = []

    # ── Relevance helper (local import to avoid circular dep) ────────────────────────
    # WHY import here not top-level:
    #   suggestion_engine is imported by main.py which also imports ebay_pricer.
    #   A module-level import of ebay_pricer from suggestion_engine would create
    #   a circular dependency at startup. Local import avoids this.
    from scoring.ebay_pricer import _title_relevance_score
    search_query = getattr(product_info, "search_query", "") or ""

    # Check active_items_sample for listings cheaper than true_cost (includes shipping).
    # WHY compare against true_cost not listing_price:
    #   A $187 eBay listing vs $275 listed price looks like $88 savings.
    #   But if the listing ships for $46.68, true cost is $321.68 —
    #   the real saving is $134. Using listing_price understates the deal quality.
    # WHY relevance check: active_items_sample is already filtered by ebay_pricer,
    #   but suggestion cards need to be high-confidence matches because they show
    #   a specific "Save $X vs this listing" claim. We use a stricter threshold (0.50)
    #   so we only make that claim when we're confident it's the same product.
    if market_value and market_value.active_items_sample:
        for item in market_value.active_items_sample:
            # Skip if title doesn't look like the same product
            if search_query:
                relevance = _title_relevance_score(item.title, search_query)
                if relevance < 0.50:
                    log.debug(f"[Suggestions] Skipping low-relevance active item ({relevance:.2f}): {item.title[:50]}")
                    continue
            if item.price < true_cost * 0.92:  # At least 8% cheaper than total cost
                savings = true_cost - item.price
                cost_note = f" (incl. ${true_cost - listing_price:.0f} shipping)" if true_cost > listing_price else ""
                suggestions.append(Suggestion(
                    suggestion_type = "same_cheaper",
                    title           = item.title[:65],
                    reason          = f"Save ${savings:.0f} vs this listing's total cost{cost_note}",
                    price_label     = f"${item.price:.0f}",
                    url             = item.url,  # affiliate params already embedded by ebay_pricer
                    platform        = "ebay",
                    badge           = "Same Model",
                    badge_color     = "#15803d",
                    image_url       = item.image_url or "",
                    price           = item.price,
                ))
                if len(suggestions) >= 1:
                    break  # One direct listing is enough; let Claude add the upgrade

    # If no cheaper active listings, check sold items as "what it should sell for"
    if not suggestions and market_value and market_value.sold_items_sample:
        for sold in market_value.sold_items_sample[:3]:
            if search_query:
                relevance = _title_relevance_score(sold.title, search_query)
                if relevance < 0.50:
                    log.debug(f"[Suggestions] Skipping low-relevance sold item ({relevance:.2f}): {sold.title[:50]}")
                    continue
            if sold.price < true_cost * 0.88:
                diff = true_cost - sold.price
                cost_note = f" (vs ${true_cost:.0f} total with shipping)" if true_cost > listing_price else ""
                suggestions.append(Suggestion(
                    suggestion_type = "same_cheaper",
                    title           = sold.title[:65],
                    reason          = f"Similar recently sold for ${diff:.0f} less{cost_note} — use as leverage",
                    price_label     = f"Sold: ${sold.price:.0f}",
                    url             = sold.url,
                    platform        = "ebay",
                    badge           = "Recent Sale",
                    badge_color     = "#0369a1",
                    image_url       = sold.image_url or "",
                    price           = sold.price,
                ))
                break  # one sold comp is enough

    # Append a Browse eBay search link as the lowest-priority fallback.
    # WHY "browse_ebay" TYPE (not "same_cheaper"):
    #   Priority sort order is: same_cheaper(0) > better_model(1) > same_amazon(2) > browse_ebay(3)
    #   If we gave this "same_cheaper" it would bump the Amazon suggestion off the
    #   3-card cap every time, which defeats the purpose of the Amazon affiliate card.
    #   "Browse eBay" is a fallback/convenience link — Amazon is more valuable per card.
    if product_info.search_query:
        encoded = urllib.parse.quote_plus(product_info.search_query)
        low_price = (market_value.active_low if market_value and market_value.active_low else 0)
        suggestions.append(Suggestion(
            suggestion_type = "browse_ebay",
            title           = f"Browse: {product_info.display_name}",
            reason          = "All eBay listings sorted by lowest price",
            price_label     = f"From ${low_price:.0f}" if low_price > 0 else "See prices",
            url             = (
                f"https://www.ebay.com/sch/i.html"
                f"?_nkw={encoded}"
                f"&LH_ItemCondition=3000"
                f"&_sop=15"
                f"&mkevt=1&mkcid=1&mkrid=711-53200-19255-0"
                f"&campid={EBAY_CAMPID}&toolid=10001&customid=dealscout"
            ),
            platform        = "ebay",
            badge           = "Browse eBay",
            badge_color     = "#e53e3e",
            image_url       = "",
            price           = low_price,
        ))

    return suggestions[:2]


# ── Claude Better-Model Recommendation ───────────────────────────────────────

async def _get_claude_recommendation(
    product_info,
    deal_score,
    listing_price: float,
    true_cost: float = 0.0,  # listing + shipping
) -> Optional[Suggestion]:
    """
    Ask Claude Haiku to recommend one specific better alternative product.

    WHY CLAUDE FOR THIS:
    "What's a better 8-inch Dobsonian than the Orion XT8 at the same price?"
    requires cross-category domain knowledge that no rule-based system has.
    Claude knows product landscapes across thousands of categories.

    WHY ONE RECOMMENDATION ONLY:
    Specificity drives action. "The Sky-Watcher 8-inch Classic is better
    and costs $20 less" → user clicks. "Consider alternatives" → user ignores.

    ONLY FOR BAD/FAIR DEALS:
    For good deals (score >= 7), the user should buy the listing — we don't
    want to distract them with alternatives when they've found a real deal.
    """
    if not os.getenv("AI_INTEGRATIONS_ANTHROPIC_BASE_URL"):
        return None

    # Don't suggest alternatives when the deal is already good
    if deal_score and deal_score.score >= 7:
        return None

    product_name = f"{product_info.brand} {product_info.model}".strip()
    if not product_name or len(product_name) < 4:
        return None

    effective_price = true_cost if true_cost > listing_price else listing_price
    shipping_note   = f" (plus ${true_cost - listing_price:.0f} shipping = ${true_cost:.0f} total)" if true_cost > listing_price else ""

    prompt = f"""You are a product recommendation expert with current 2026 market knowledge.

A buyer is evaluating a used "{product_name}" ({product_info.category}) listed at ${listing_price:.0f}{shipping_note}.
The deal score indicates this is overpriced or a poor value.

Recommend exactly ONE specific alternative product that:
1. Is better value or more reliable at a similar or lower price point
2. Is a real, currently available product that can be found on eBay or Amazon TODAY
3. Is from the same product category (don't suggest a laptop when they're looking at a tablet)
4. Has a well-known brand name that buyers would recognize

Respond ONLY with JSON (no preamble, no markdown):
{{
  "brand": "<manufacturer brand>",
  "model": "<specific model name or number>",
  "why_better": "<one specific sentence — e.g. better optics, more reliable motor, higher rated>",
  "approx_used_price": <estimated used market price as integer>,
  "search_query": "<4-6 word eBay/Amazon search query>"
}}

CRITICAL RULES:
- The approx_used_price MUST be realistic for the USED market, not new retail
- Do NOT suggest discontinued or obsolete products
- Do NOT suggest a product more expensive than the current listing unless it's clearly superior
- If you cannot confidently name a specific real alternative, return empty strings

If you cannot confidently name a specific real alternative, return:
{{"brand": "", "model": "", "why_better": "", "approx_used_price": 0, "search_query": ""}}"""

    try:
        from scoring import claude_call_with_retry
        response = await claude_call_with_retry(
            lambda: _get_client().messages.create(
                model="claude-haiku-4-5-20251001",
                max_tokens=200,
                messages=[{"role": "user", "content": prompt}]
            ),
            label="SuggestionEngine",
        )

        raw = response.content[0].text.strip()
        if "```" in raw:
            match = re.search(r'\{.*\}', raw, re.DOTALL)
            if match:
                raw = match.group()

        data = json.loads(raw)

        if not data.get("brand") and not data.get("model"):
            return None

        alt_name     = f"{data.get('brand', '')} {data.get('model', '')}".strip()
        search_query = data.get("search_query") or alt_name
        approx_price = float(data.get("approx_used_price") or 0)

        if approx_price > 0 and approx_price > effective_price * 4:
            log.warning(
                f"[Suggestions] Claude alt price ${approx_price:.0f} is >4x listing "
                f"${effective_price:.0f} — likely model confusion, discarding"
            )
            return None

        if approx_price > 0 and approx_price > effective_price * 1.5:
            log.info(
                f"[Suggestions] Claude alt price ${approx_price:.0f} is notably higher "
                f"than listing ${effective_price:.0f} — demoting"
            )
            approx_price = 0

        encoded = urllib.parse.quote_plus(search_query)
        ebay_url = (
            f"https://www.ebay.com/sch/i.html"
            f"?_nkw={encoded}"
            f"&LH_ItemCondition=3000"
            f"&mkevt=1&mkcid=1&mkrid=711-53200-19255-0"
            f"&campid={EBAY_CAMPID}&toolid=10001&customid=dealscout_alt"
        )

        price_label = f"~${approx_price:.0f} used" if approx_price > 0 else "See prices"
        reason      = data.get("why_better") or f"Better alternative to {product_name}"

        log.info(f"[Suggestions] Claude recommends: '{alt_name}' (~${approx_price:.0f})")
        return Suggestion(
            suggestion_type = "better_model",
            title           = alt_name[:65],
            reason          = reason[:100],
            price_label     = price_label,
            url             = ebay_url,
            platform        = "ebay",
            badge           = "Better Option",
            badge_color     = "#7c3aed",
            image_url       = "",
            price           = approx_price,
        )

    except Exception as e:
        log.debug(f"[Suggestions] Claude recommendation failed: {e}")
        return None


# ── Amazon Suggestion ─────────────────────────────────────────────────────────

async def _build_amazon_suggestion(
    product_info,
    deal_score,
) -> Optional[Suggestion]:
    """
    Build an Amazon affiliate search link for the product.

    WHY ALWAYS INCLUDE AMAZON:
    Amazon prices serve as a "new retail ceiling" — seeing that a $500 used
    item costs $480 new on Amazon is compelling context for any score.
    The click earns commission whether or not the user ends up buying.

    FUTURE: Replace with PA API product cards once 3 qualifying sales
    are made through the dealscout03f-20 associate tag.
    """
    if not product_info.amazon_query:
        return None

    encoded = urllib.parse.quote_plus(product_info.amazon_query)
    url = f"https://www.amazon.com/s?k={encoded}&tag={AMAZON_TAG}"

    if deal_score and deal_score.score < 5:
        reason = "Consider buying new from Amazon for warranty protection"
        badge  = "Buy New Instead"
    elif deal_score and deal_score.score >= 7:
        reason = "Compare with new retail price"
        badge  = "Compare New"
    else:
        reason = "Check new retail price on Amazon"
        badge  = "Amazon Price"

    return Suggestion(
        suggestion_type = "same_amazon",
        title           = f"{product_info.display_name} — Amazon",
        reason          = reason,
        price_label     = "New retail",
        url             = url,
        platform        = "amazon",
        badge           = badge,
        badge_color     = "#f59e0b",
        image_url       = "",
        price           = 0,
    )
