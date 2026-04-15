"""
Claude Market Pricer — AI-Powered Used Price Estimation

Replaces gemini_pricer.py. Uses Claude (via Replit AI integration) to estimate
used market prices based on its training data.

Compared to the old Gemini approach:
  - Same JSON output format — drop-in replacement
  - Uses Claude Haiku for speed (same model used elsewhere in the pipeline)
  - No Google Search Grounding (Claude uses training data for pricing)
  - data_source = "claude_knowledge" instead of gemini_knowledge/gemini_search

Price cache:
  - PostgreSQL `price_cache` table stores Claude estimates for 48 hours
  - Avoids redundant Claude calls for similar items across users/sessions
  - Falls back to in-memory cache if DB is unavailable
"""

import asyncio
import json
import logging
import os
import re
import time
from typing import Optional

log = logging.getLogger(__name__)

_CACHE_TTL = 600  # 10 minutes (in-memory fallback)
_DB_CACHE_TTL_HOURS = 48
_cache: dict = {}

CLAUDE_MODEL = "claude-haiku-4-5"

_price_cache_table_ready = False
_price_cache_table_lock = None


def _get_client():
    import anthropic
    return anthropic.Anthropic(
        api_key=os.getenv("AI_INTEGRATIONS_ANTHROPIC_API_KEY", "placeholder"),
        base_url=os.getenv("AI_INTEGRATIONS_ANTHROPIC_BASE_URL"),
    )


def claude_is_configured() -> bool:
    return bool(os.getenv("AI_INTEGRATIONS_ANTHROPIC_BASE_URL"))


async def _ensure_price_cache_table():
    """Create the price_cache table if it doesn't exist."""
    global _price_cache_table_ready, _price_cache_table_lock
    if _price_cache_table_ready:
        return
    if _price_cache_table_lock is None:
        _price_cache_table_lock = asyncio.Lock()
    async with _price_cache_table_lock:
        if _price_cache_table_ready:
            return
        try:
            return await _create_price_cache_table()
        except Exception as e:
            log.debug(f"[ClaudePricer] price_cache table setup failed (non-fatal): {e}")


async def _create_price_cache_table():
    global _price_cache_table_ready
    from scoring.data_pipeline import _get_pool
    pool = await _get_pool()
    if not pool:
        return
    await pool.execute("""
        CREATE TABLE IF NOT EXISTS price_cache (
            id SERIAL PRIMARY KEY,
            query_key TEXT NOT NULL,
            condition TEXT NOT NULL DEFAULT 'Used',
            avg_used_price DOUBLE PRECISION,
            price_low DOUBLE PRECISION,
            price_high DOUBLE PRECISION,
            new_retail DOUBLE PRECISION DEFAULT 0,
            confidence TEXT DEFAULT 'medium',
            item_id TEXT DEFAULT '',
            notes TEXT DEFAULT '',
            data_source TEXT DEFAULT 'claude_knowledge',
            created_at TIMESTAMPTZ DEFAULT NOW()
        )
    """)
    await pool.execute("""
        CREATE INDEX IF NOT EXISTS idx_price_cache_query
        ON price_cache (query_key, condition)
    """)
    _price_cache_table_ready = True
    log.info("[ClaudePricer] price_cache table ready")


def _normalize_query_key(query: str) -> str:
    """Normalize a query string for cache matching."""
    q = query.lower().strip()
    q = re.sub(r'[^\w\s]', ' ', q)
    q = re.sub(r'\s+', ' ', q).strip()
    return q


def _query_word_overlap(a: str, b: str) -> float:
    """Compute word overlap ratio between two normalized query keys."""
    words_a = set(a.split())
    words_b = set(b.split())
    union = words_a | words_b
    if not union:
        return 0.0
    return len(words_a & words_b) / len(union)


async def _db_cache_get(query: str, condition: str) -> Optional[dict]:
    """Check PostgreSQL price cache for an exact or similar entry within TTL."""
    try:
        await _ensure_price_cache_table()
        from scoring.data_pipeline import _get_pool
        pool = await _get_pool()
        if not pool:
            return None

        query_key = _normalize_query_key(query)
        row = await pool.fetchrow(
            """
            SELECT avg_used_price, price_low, price_high, new_retail,
                   confidence, item_id, notes, data_source
            FROM price_cache
            WHERE query_key = $1 AND condition = $2
              AND created_at > NOW() - make_interval(hours => $3)
            ORDER BY created_at DESC
            LIMIT 1
            """,
            query_key, condition, _DB_CACHE_TTL_HOURS,
        )
        if row:
            log.info(f"[ClaudePricer] DB cache hit (exact): {query}")
            return _row_to_dict(row)

        rows = await pool.fetch(
            """
            SELECT query_key, avg_used_price, price_low, price_high, new_retail,
                   confidence, item_id, notes, data_source
            FROM price_cache
            WHERE condition = $1
              AND created_at > NOW() - make_interval(hours => $2)
            ORDER BY created_at DESC
            LIMIT 50
            """,
            condition, _DB_CACHE_TTL_HOURS,
        )
        best_row = None
        best_overlap = 0.0
        for r in rows:
            overlap = _query_word_overlap(query_key, r["query_key"])
            if overlap > best_overlap:
                best_overlap = overlap
                best_row = r
        if best_row and best_overlap >= 0.75:
            log.info(f"[ClaudePricer] DB cache hit (similar {best_overlap:.0%}): "
                     f"'{query}' matched '{best_row['query_key']}'")
            return _row_to_dict(best_row)

        return None
    except Exception as e:
        log.debug(f"[ClaudePricer] DB cache lookup failed (non-fatal): {e}")
        return None


def _row_to_dict(row) -> dict:
    return {
        "avg_used_price": row["avg_used_price"],
        "price_low": row["price_low"],
        "price_high": row["price_high"],
        "new_retail": row["new_retail"] or 0,
        "confidence": row["confidence"] or "medium",
        "item_id": row["item_id"] or "",
        "notes": row["notes"] or "",
        "data_source": row["data_source"] or "claude_knowledge",
    }


async def _db_cache_set(query: str, condition: str, result: dict):
    """Store a Claude pricing result in the PostgreSQL cache."""
    try:
        await _ensure_price_cache_table()
        from scoring.data_pipeline import _get_pool
        pool = await _get_pool()
        if not pool:
            return

        query_key = _normalize_query_key(query)
        await pool.execute(
            """
            INSERT INTO price_cache
                (query_key, condition, avg_used_price, price_low, price_high,
                 new_retail, confidence, item_id, notes, data_source)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            """,
            query_key, condition,
            result.get("avg_used_price", 0),
            result.get("price_low", 0),
            result.get("price_high", 0),
            result.get("new_retail", 0),
            result.get("confidence", "medium"),
            result.get("item_id", ""),
            result.get("notes", ""),
            result.get("data_source", "claude_knowledge"),
        )
        log.debug(f"[ClaudePricer] DB cache stored: {query}")
    except Exception as e:
        log.debug(f"[ClaudePricer] DB cache write failed (non-fatal): {e}")


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
    category: str = "",
    description: str = "",
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

    cache_key = f"{query}|{condition}|{category}" if category else f"{query}|{condition}"
    now = time.time()
    if cache_key in _cache and now - _cache[cache_key]["ts"] < _CACHE_TTL:
        log.debug(f"[ClaudePricer] Memory cache hit: {query}")
        cached = _cache[cache_key]["result"].copy()
        if cached.get("data_source") != "claude_web_grounded":
            cached["confidence"] = "low"
        return cached

    db_cached = await _db_cache_get(query, condition)
    if db_cached and db_cached.get("data_source") == "claude_web_grounded":
        _cache[cache_key] = {"result": db_cached, "ts": now}
        return db_cached

    web_context = ""
    data_source = "claude_knowledge"
    _web_grounding_succeeded = False
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
            _web_grounding_succeeded = True
            log.info(f"[ClaudePricer] Web grounding: {len(prices)} prices, avg=${web_data['price_avg']:.0f}")
        else:
            log.info(f"[ClaudePricer] Web grounding returned no prices for '{query}' — proceeding with knowledge only (confidence capped at low)")
    except Exception as e:
        log.warning(f"[ClaudePricer] Web search grounding failed: {e} — proceeding with knowledge only (confidence capped at low)")

    condition_guide = _condition_price_guide(condition)

    category_context = ""
    if category:
        category_context = f"\nProduct Category: {category}"
        cat_lower = category.lower()
        if any(kw in cat_lower for kw in ["electronics", "phone", "laptop", "tablet", "computer", "gaming", "console"]):
            category_context += "\nDEPRECIATION NOTE: Electronics depreciate 20-40% per year. A 2-year-old device is worth 40-60% of original retail."
        elif any(kw in cat_lower for kw in ["furniture", "sofa", "couch", "table", "desk", "chair"]):
            category_context += "\nDEPRECIATION NOTE: Furniture depreciates 50-70% immediately. Used furniture typically sells for 25-40% of retail unless it's a premium/designer brand."
        elif any(kw in cat_lower for kw in ["appliance", "washer", "dryer", "refrigerator", "dishwasher"]):
            category_context += "\nDEPRECIATION NOTE: Major appliances depreciate ~15% per year. 5-year-old appliances are worth 30-50% of retail."
        elif any(kw in cat_lower for kw in ["tool", "power tool", "drill", "saw"]):
            category_context += "\nDEPRECIATION NOTE: Quality power tools hold value well. Used professional-grade tools retain 50-70% of retail."
        elif any(kw in cat_lower for kw in ["bike", "bicycle", "e-bike", "electric bike"]):
            category_context += "\nDEPRECIATION NOTE: Bikes depreciate 30-50% in year one, then slowly. Premium brands (Trek, Specialized) hold value better."
        elif any(kw in cat_lower for kw in ["instrument", "guitar", "piano", "drum"]):
            category_context += "\nDEPRECIATION NOTE: Musical instruments hold value well, especially name brands. Vintage instruments may appreciate."
        elif any(kw in cat_lower for kw in ["camera", "lens", "dslr", "mirrorless"]):
            category_context += "\nDEPRECIATION NOTE: Camera bodies depreciate 20-30% per year. Lenses hold value much better (retain 60-80%)."

    description_context = ""
    if description:
        desc_trimmed = description[:2000].strip()
        description_context = f"""
## LISTING DESCRIPTION (from seller)
{desc_trimmed}

Use this description to identify: exact model/variant, included accessories, signs of wear,
modifications, missing parts, or any details that affect pricing.
"""

    prompt = f"""You are a used marketplace pricing expert. Provide accurate used/secondhand market pricing for:

Item: {query}
Condition: {condition}
{f"Seller is asking: ${listing_price:.0f}" if listing_price > 0 else ""}{category_context}
{web_context}{description_context}
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
        raw = re.sub(r"^```(?:json)?\s*", "", raw)
        raw = re.sub(r"\s*```$", "", raw)

        json_match = re.search(r"\{[^{}]*\}", raw)
        if json_match:
            raw = json_match.group(0)

        data = json.loads(raw)
        result = _validate_and_normalize(data, listing_price, data_source)

        if result:
            if not _web_grounding_succeeded and result["confidence"] != "low":
                log.info(f"[ClaudePricer] Capping confidence to 'low' — web grounding failed/empty")
                result["confidence"] = "low"
            _cache[cache_key] = {"result": result, "ts": now}
            asyncio.create_task(_db_cache_set(query, condition, result))
            log.info(
                f"[ClaudePricer] {query}: avg=${result['avg_used_price']:.0f} "
                f"({result['price_low']:.0f}-{result['price_high']:.0f}) "
                f"conf={result['confidence']} web_grounded={_web_grounding_succeeded}"
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
