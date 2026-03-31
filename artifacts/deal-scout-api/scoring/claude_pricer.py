"""
Claude Market Pricer — AI-Powered Used Price Estimation

Replaces gemini_pricer.py. Uses Claude (via Replit AI integration) to estimate
used market prices based on its training data.

Compared to the old Gemini approach:
  - Same JSON output format — drop-in replacement
  - Uses Claude Haiku for speed (same model used elsewhere in the pipeline)
  - No Google Search Grounding (Claude uses training data for pricing)
  - data_source = "claude_knowledge" instead of gemini_knowledge/gemini_search
"""

import asyncio
import json
import logging
import os
import re
import time
from typing import Optional

log = logging.getLogger(__name__)

_CACHE_TTL = 600  # 10 minutes
_cache: dict = {}

CLAUDE_MODEL = "claude-haiku-4-5"


def _get_client():
    import anthropic
    return anthropic.Anthropic(
        api_key=os.getenv("AI_INTEGRATIONS_ANTHROPIC_API_KEY", "placeholder"),
        base_url=os.getenv("AI_INTEGRATIONS_ANTHROPIC_BASE_URL"),
    )


def claude_is_configured() -> bool:
    return bool(os.getenv("AI_INTEGRATIONS_ANTHROPIC_BASE_URL"))


def _condition_price_guide(condition: str) -> str:
    """Return explicit condition-based pricing rules for the Claude prompt."""
    condition_lower = condition.lower().strip()
    guides = {
        "new": """## CONDITION PRICING GUIDE
Condition: NEW (sealed/unused). Price should be 85-95% of new retail — full value but no warranty.""",
        "like new": """## CONDITION PRICING GUIDE
Condition: LIKE NEW (opened but pristine, minimal use). Price should be 75-85% of new retail.
Apply a 15-25% discount from new retail price.""",
        "good": """## CONDITION PRICING GUIDE
Condition: GOOD (normal wear, fully functional). Price should be 55-70% of new retail.
Apply a 30-45% discount from new retail. This is the most common used condition.""",
        "fair": """## CONDITION PRICING GUIDE
Condition: FAIR (visible wear, cosmetic issues, but functional). Price should be 35-55% of new retail.
Apply a 45-65% discount from new retail. Buyer accepts cosmetic issues for a deeper discount.""",
        "used": """## CONDITION PRICING GUIDE
Condition: USED (condition unspecified — assume moderate wear). Price should be 50-65% of new retail.
When condition is just "Used" with no details, assume GOOD condition for pricing.""",
    }
    return guides.get(condition_lower, guides["used"])


async def get_claude_market_price(
    query: str,
    condition: str = "Used",
    listing_price: float = 0.0,
) -> Optional[dict]:
    """
    Get AI-powered used market price estimate for an item using Claude,
    optionally grounded with real-time web search data.

    Returns a dict with:
      avg_used_price (float)    — typical used selling price
      price_low     (float)    — low end of used price range
      price_high    (float)    — high end of used price range
      new_retail    (float)    — new retail price (0 if unknown)
      confidence    (str)      — "high" | "medium" | "low"
      item_id       (str)      — specific product Claude identified
      notes         (str)      — 1-sentence pricing context
      data_source   (str)      — "claude_web_grounded" or "claude_knowledge"

    Returns None if Claude is not configured or completely fails.
    """
    if not claude_is_configured():
        log.debug("[ClaudePricer] AI integration not configured — skipping")
        return None

    cache_key = f"{query}|{condition}"
    now = time.time()
    if cache_key in _cache and now - _cache[cache_key]["ts"] < _CACHE_TTL:
        log.debug(f"[ClaudePricer] Cache hit: {query}")
        return _cache[cache_key]["result"]

    web_context = ""
    data_source = "claude_knowledge"
    try:
        from scoring.web_pricer import search_market_prices
        web_data = await search_market_prices(query, condition, listing_price)
        if web_data and web_data.get("prices_found"):
            prices = web_data["prices_found"]
            snippets = web_data.get("snippets", [])[:3]
            web_context = f"""
## REAL-TIME WEB SEARCH DATA (use this to ground your estimate)
Web search found {len(prices)} recent price points for this item:
  Prices found: {', '.join(f'${p:.0f}' for p in prices[:10])}
  Average: ${web_data['price_avg']:.0f}
  Range: ${web_data['price_low']:.0f} - ${web_data['price_high']:.0f}

Relevant search snippets:
{chr(10).join(f'  - {s[:200]}' for s in snippets)}

IMPORTANT: Weight these real-time prices heavily in your estimate. They reflect
current 2026 market conditions, which may differ from your training data.
"""
            data_source = "claude_web_grounded"
            log.info(f"[ClaudePricer] Web grounding: {len(prices)} prices, avg=${web_data['price_avg']:.0f}")
    except Exception as e:
        log.debug(f"[ClaudePricer] Web search grounding failed (non-fatal): {e}")

    condition_guide = _condition_price_guide(condition)

    prompt = f"""You are a used marketplace pricing expert. Provide accurate used/secondhand market pricing for:

Item: {query}
Condition: {condition}
{f"Seller is asking: ${listing_price:.0f}" if listing_price > 0 else ""}
{web_context}
{condition_guide}

Return ONLY a JSON object with this exact structure:
{{
  "avg_used_price": <typical used selling price as a number>,
  "price_low": <low end of the used price range as a number>,
  "price_high": <high end of the used price range as a number>,
  "new_retail": <current new street price for THIS EXACT model on Amazon/Walmart, or 0 if unsure>,
  "confidence": "<high|medium|low>",
  "item_id": "<specific product model you identified, e.g. 'Orion SkyQuest XT8 Intelliscope'>",
  "notes": "<one sentence about what drives pricing for this item>"
}}

Rules:
- Base your answer on typical US marketplace prices (eBay, Facebook Marketplace, Craigslist).
- For used prices, reflect what items actually SELL for — not asking prices.
- For new_retail: use the EXACT current Amazon/street price for this specific model. Budget/entry-level items typically retail for $50–300. If you are confusing this model with a premium variant, use 0 instead.
- If the item name contains a likely MISSPELLING, correct it (e.g. "Jakery" → Jackery, "Sonos" → Sonos) and price the corrected product. Note the correction in item_id.
- If the item does NOT EXIST yet (unreleased product, future model), still provide a rough estimate based on the closest existing model and use "low" confidence.
- If you're uncertain about this specific item, use "low" confidence and provide your best rough estimate rather than returning 0.
- Do NOT return avg_used_price: 0 unless the item is truly unidentifiable. A rough estimate is always better than no estimate.
- Do NOT hallucinate prices — if genuinely unknown, return avg_used_price: 0 and confidence: "low".
- Apply the condition-based pricing adjustments described above.
Return ONLY the JSON, no explanation."""

    try:
        client = _get_client()
        from scoring import claude_call_with_retry
        response = await claude_call_with_retry(
            lambda: client.messages.create(
                model=CLAUDE_MODEL,
                max_tokens=300,
                messages=[{"role": "user", "content": prompt}],
            ),
            label="ClaudePricer",
        )

        raw = response.content[0].text.strip()
        # Strip markdown code fences if present
        raw = re.sub(r"^```(?:json)?\s*", "", raw)
        raw = re.sub(r"\s*```$", "", raw)

        data = json.loads(raw)
        result = _validate_and_normalize(data, listing_price, data_source)

        if result:
            _cache[cache_key] = {"result": result, "ts": now}
            log.info(
                f"[ClaudePricer] {query}: avg=${result['avg_used_price']:.0f} "
                f"({result['price_low']:.0f}-{result['price_high']:.0f}) "
                f"conf={result['confidence']}"
            )
        return result

    except json.JSONDecodeError as e:
        log.warning(f"[ClaudePricer] JSON parse error: {e}")
        return None
    except Exception as e:
        log.warning(f"[ClaudePricer] Failed: {type(e).__name__}: {e}")
        return None


def _validate_and_normalize(data: dict, listing_price: float, data_source: str = "claude_knowledge") -> Optional[dict]:
    try:
        avg = float(data.get("avg_used_price") or 0)
        low = float(data.get("price_low") or 0)
        high = float(data.get("price_high") or 0)
    except (TypeError, ValueError):
        return None

    if avg <= 0:
        return None

    # Sanity: if Claude returns absurdly high (>10x listing price), discard
    if listing_price > 0 and avg > listing_price * 10:
        log.warning(f"[ClaudePricer] Sanity check failed: avg={avg} vs listing={listing_price}")
        return None

    if low <= 0:
        low = avg * 0.70
    if high <= 0 or high <= low:
        high = avg * 1.30

    try:
        new_retail = float(data.get("new_retail") or 0)
    except (TypeError, ValueError):
        new_retail = 0.0

    # Sanity: new retail should not be more than 5× the used market avg.
    # If it is, Claude likely confused this model with a premium variant
    # (e.g. returned a $600 Celestron price for a $100 Gskyer query).
    # Set to 0 so the affiliate cards don't display a misleading price.
    if new_retail > 0 and avg > 0 and new_retail > avg * 5:
        log.warning(
            f"[ClaudePricer] new_retail=${new_retail:.0f} is {new_retail/avg:.1f}× avg=${avg:.0f} "
            f"— likely model confusion, discarding new_retail"
        )
        new_retail = 0.0

    confidence = str(data.get("confidence", "medium")).lower()
    if confidence not in ("high", "medium", "low"):
        confidence = "medium"

    return {
        "avg_used_price": round(avg, 2),
        "price_low":      round(low, 2),
        "price_high":     round(high, 2),
        "new_retail":     round(new_retail, 2),
        "confidence":     confidence,
        "item_id":        str(data.get("item_id", "") or ""),
        "notes":          str(data.get("notes", "") or ""),
        "data_source":    data_source,
    }
