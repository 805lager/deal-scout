"""
Gemini Market Pricer — AI-Powered Used Price Estimation

WHY GEMINI INSTEAD OF SCRAPING:

  google_pricer.py (the old approach) had three structural problems:
    1. Google Shopping is dominated by NEW retail prices — skews high for used comparisons
    2. The HTML scraping breaks whenever Google A/B tests a layout change
    3. No scraper can handle niche items that don't have dense product pages

  Gemini with Google Search Grounding fixes all three:
    - Explicitly asks for USED/secondhand prices (not retail)
    - Uses Google's own search index — no scraping, no bot detection
    - AI interprets varied sources (Reddit, eBay, FBM posts) into a coherent estimate
    - Handles niche items like telescopes, Sur-Rons, vintage guitars

TWO MODES:

  1. SEARCH GROUNDING (primary):
     Gemini searches Google in real-time to answer the pricing question.
     Returns live market data from current listings and sold comps.
     data_source = "gemini_search"

  2. KNOWLEDGE ONLY (fallback):
     Gemini uses its training data — extensive e-commerce pricing knowledge.
     No live search, but better than keyword mock for most items.
     Confidence is capped at "medium".
     data_source = "gemini_knowledge"

COST (Google AI Studio):
  - 1,500 grounded queries/day FREE (generous for POC)
  - After free tier: ~$35 per 1,000 queries ($0.035/score)
  - Knowledge-only fallback: ~$0.0001/query (effectively free)

SETUP:
  1. Go to https://aistudio.google.com/ and create an API key
  2. Add to .env:         GOOGLE_AI_API_KEY=AIzaSy...
  3. Add to Railway env:  GOOGLE_AI_API_KEY=AIzaSy...
  4. pip install google-generativeai (added to requirements.txt)
"""

import asyncio
import json
import logging
import os
import re
import time
from typing import Optional

from dotenv import load_dotenv

load_dotenv()

log = logging.getLogger(__name__)

GOOGLE_AI_API_KEY = os.getenv("GOOGLE_AI_API_KEY", "")

# Which Gemini model to use — configurable for easy upgrades
# gemini-2.0-flash is fast, cheap, and has search grounding
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-2.0-flash")

# In-memory cache: cache_key → (timestamp, result_dict)
# WHY 10 MIN: used prices don't change meaningfully in 10 minutes.
# Prevents re-querying Gemini when the same item is scored multiple times.
_cache: dict = {}
_CACHE_TTL = 600  # 10 minutes


# ── Public API ─────────────────────────────────────────────────────────────────

async def get_gemini_market_price(
    query: str,
    condition: str = "Used",
    listing_price: float = 0.0,
) -> Optional[dict]:
    """
    Get AI-powered used market price for an item using Gemini + Google Search.

    Returns a dict with:
      avg_used_price (float)    — typical used selling price
      price_low     (float)    — low end of used price range
      price_high    (float)    — high end of used price range
      new_retail    (float)    — new retail price (0 if unknown)
      confidence    (str)      — "high" | "medium" | "low"
      item_id       (str)      — specific product Gemini identified
      notes         (str)      — 1-sentence pricing context
      data_source   (str)      — "gemini_search" | "gemini_knowledge"

    Returns None if Gemini is not configured or completely fails.
    Caller falls back to eBay API data in that case.
    """
    if not GOOGLE_AI_API_KEY or GOOGLE_AI_API_KEY.startswith("your_"):
        log.debug("[GeminiPricer] GOOGLE_AI_API_KEY not set — skipping")
        return None

    cache_key = f"{query.lower().strip()}|{condition.lower()}"
    now = time.time()

    if cache_key in _cache:
        ts, result = _cache[cache_key]
        if now - ts < _CACHE_TTL:
            log.info(f"[GeminiPricer] Cache hit: '{query}'")
            return result

    try:
        result = await asyncio.wait_for(
            _call_gemini_async(query, condition, listing_price),
            timeout=18.0,  # Generous — search grounding can be slow on first call
        )
        if result:
            _cache[cache_key] = (now, result)
            log.info(
                f"[GeminiPricer] '{query}' → "
                f"avg=${result['avg_used_price']:.0f} "
                f"[{result['price_low']:.0f}–{result['price_high']:.0f}] "
                f"conf={result['confidence']} src={result['data_source']}"
            )
        return result

    except asyncio.TimeoutError:
        log.warning(f"[GeminiPricer] Timeout (18s) for '{query}'")
        return None
    except Exception as e:
        log.warning(f"[GeminiPricer] Unexpected error for '{query}': {type(e).__name__}: {e}")
        return None


def gemini_is_configured() -> bool:
    """Quick check — used by /health and /test-gemini endpoints."""
    return bool(GOOGLE_AI_API_KEY and not GOOGLE_AI_API_KEY.startswith("your_"))


# ── Gemini API Call ───────────────────────────────────────────────────────────

async def _call_gemini_async(
    query: str,
    condition: str,
    listing_price: float,
) -> Optional[dict]:
    """
    Attempt Gemini call: search grounding first, training-knowledge fallback.
    Uses run_in_executor because the google-generativeai SDK is synchronous.
    """
    loop = asyncio.get_event_loop()

    # Strategy 1: Search grounding — Gemini searches Google in real-time
    # WHY PRIMARY: live data from actual current listings, not training knowledge
    try:
        result = await loop.run_in_executor(
            None,
            _gemini_with_search,
            query, condition, listing_price
        )
        if result and result.get("avg_used_price"):
            return result
        log.info(f"[GeminiPricer] Search grounding returned no price for '{query}' — trying knowledge fallback")
    except Exception as e:
        log.warning(f"[GeminiPricer] Search grounding failed: {type(e).__name__}: {e}")

    # Strategy 2: Training knowledge — no live search, uses model's training data
    # WHY FALLBACK (not primary): training data has a cutoff; live search is better
    # WHY KEEP: still far better than keyword-based mock data for most items
    try:
        result = await loop.run_in_executor(
            None,
            _gemini_knowledge_only,
            query, condition, listing_price
        )
        if result and result.get("avg_used_price"):
            # Cap confidence — without live data, "high" is overconfident
            if result.get("confidence") == "high":
                result["confidence"] = "medium"
            result["data_source"] = "gemini_knowledge"
            return result
    except Exception as e:
        log.warning(f"[GeminiPricer] Knowledge fallback failed: {type(e).__name__}: {e}")

    return None


def _gemini_with_search(query: str, condition: str, listing_price: float) -> Optional[dict]:
    """
    Synchronous Gemini call with Google Search grounding.
    Runs in thread pool executor.
    """
    try:
        import google.generativeai as genai
    except ImportError:
        log.error("[GeminiPricer] google-generativeai not installed. Run: pip install google-generativeai")
        return None

    genai.configure(api_key=GOOGLE_AI_API_KEY)
    prompt = _build_prompt(query, condition, listing_price)

    # Search grounding tells Gemini to search Google before answering
    # The model reads current listings and sold comps to price the item
    try:
        model = genai.GenerativeModel(
            model_name=GEMINI_MODEL,
            tools=["google_search"],  # enables real-time Google search
        )
        response = model.generate_content(prompt)
        result = _parse_response(response.text, data_source="gemini_search")

        # Log grounding sources for debugging
        try:
            if hasattr(response, "candidates") and response.candidates:
                meta = response.candidates[0].grounding_metadata
                if meta and hasattr(meta, "web_search_queries"):
                    log.info(f"[GeminiPricer] Search queries used: {meta.web_search_queries}")
        except Exception:
            pass  # grounding metadata is optional, not critical

        return result

    except Exception as e:
        # Common failure: quota exceeded, network error, model unavailable
        raise RuntimeError(f"search grounding error: {e}") from e


def _gemini_knowledge_only(query: str, condition: str, listing_price: float) -> Optional[dict]:
    """
    Synchronous Gemini call without search grounding.
    Uses training data only — no live web search.
    Runs in thread pool executor.
    """
    try:
        import google.generativeai as genai
    except ImportError:
        return None

    genai.configure(api_key=GOOGLE_AI_API_KEY)
    prompt = _build_prompt(query, condition, listing_price)

    # No tools — pure language model inference
    model = genai.GenerativeModel(model_name=GEMINI_MODEL)
    response = model.generate_content(prompt)
    return _parse_response(response.text, data_source="gemini_knowledge")


# ── Prompt Engineering ────────────────────────────────────────────────────────

def _build_prompt(query: str, condition: str, listing_price: float) -> str:
    """
    Build the pricing prompt for Gemini.

    WHY THIS PROMPT STRUCTURE:
    - "used/secondhand market value" explicitly excludes retail pricing
    - "completed sales" focuses on what people actually paid, not asking prices
    - JSON-only response makes parsing reliable
    - Fallback fields (price_low/high) prevent null crashes in the pipeline

    The most important instruction: "USED selling prices, not manufacturer MSRP."
    Most AI models default to retail pricing — this overrides that tendency.
    """
    price_context = (
        f"\nA seller is asking ${listing_price:.0f} for this item on Facebook Marketplace."
        f" Use this as context for whether their price is reasonable."
    ) if listing_price > 0 else ""

    return f"""You are a used goods market pricing expert specializing in Facebook Marketplace, eBay sold listings, and Craigslist valuations in the United States.

Item: {query}
Condition: {condition}{price_context}

Task: Find the USED/secondhand market value for this specific item. Search for:
- Completed eBay sold listings (what buyers actually paid)
- Current Facebook Marketplace asking prices
- What a fair used price is for this item in this condition

Return ONLY a valid JSON object with exactly these fields (no markdown, no explanation outside JSON):
{{
  "avg_used_price": <number — the typical used SELLING price, NOT MSRP>,
  "price_low": <number — low end of realistic used price range>,
  "price_high": <number — high end of realistic used price range>,
  "new_retail": <number — current new retail price, 0 if not applicable>,
  "confidence": "<high|medium|low>",
  "item_id": "<specific product model you identified, e.g. Celestron NexStar 6SE>",
  "notes": "<1 sentence about key price factors>"
}}

Confidence guide:
- "high": well-known product, stable pricing, multiple sources confirm
- "medium": reasonable estimate from general market knowledge
- "low": niche/unusual item, rapidly changing market, or uncertain identification

CRITICAL: avg_used_price must reflect realistic used SELLING prices, not what stores charge new.
If you cannot identify a specific product, return avg_used_price: 0."""


# ── Response Parsing ──────────────────────────────────────────────────────────

def _parse_response(text: str, data_source: str) -> Optional[dict]:
    """
    Parse Gemini's JSON response into a standardized pricing dict.

    WHY REGEX EXTRACTION (not direct json.loads):
      Gemini sometimes wraps the JSON in a ```json code fence or adds
      a sentence before/after. We extract the JSON object even if it's
      not the entire response.
    """
    if not text:
        return None

    # Strip markdown code fences if present
    text = re.sub(r"```(?:json)?\s*", "", text.strip())
    text = re.sub(r"```", "", text)

    # Find the JSON object — handle nested braces
    json_start = text.find("{")
    json_end   = text.rfind("}") + 1
    if json_start == -1 or json_end == 0:
        log.warning(f"[GeminiPricer] No JSON object found in response: {text[:200]!r}")
        return None

    json_str = text[json_start:json_end]

    try:
        data = json.loads(json_str)
    except json.JSONDecodeError as e:
        log.warning(f"[GeminiPricer] JSON parse error ({e}): {json_str[:200]!r}")
        return None

    # Extract and validate avg price
    try:
        avg = float(data.get("avg_used_price") or 0)
    except (TypeError, ValueError):
        avg = 0.0

    if avg <= 0:
        log.info(f"[GeminiPricer] avg_used_price=0 from response — item unidentified or no data")
        return None

    # Build safe defaults for optional fields
    try:
        low = float(data.get("price_low") or avg * 0.75)
    except (TypeError, ValueError):
        low = avg * 0.75

    try:
        high = float(data.get("price_high") or avg * 1.30)
    except (TypeError, ValueError):
        high = avg * 1.30

    try:
        new_retail = float(data.get("new_retail") or 0)
    except (TypeError, ValueError):
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


# ── Test / Standalone ──────────────────────────────────────────────────────────

async def _test():
    """Quick test — run with: python scoring/gemini_pricer.py"""
    import sys
    query = " ".join(sys.argv[1:]) if len(sys.argv) > 1 else "Celestron NexStar 6SE telescope"

    print(f"\nTesting Gemini pricer for: '{query}'")
    print(f"API key set: {gemini_is_configured()}")
    print(f"Model: {GEMINI_MODEL}\n")

    result = await get_gemini_market_price(query, condition="Used", listing_price=0)

    if result:
        print(f"  avg_used_price: ${result['avg_used_price']:.0f}")
        print(f"  range:          ${result['price_low']:.0f} – ${result['price_high']:.0f}")
        print(f"  new_retail:     ${result['new_retail']:.0f}")
        print(f"  confidence:     {result['confidence']}")
        print(f"  item_id:        {result['item_id']}")
        print(f"  notes:          {result['notes']}")
        print(f"  data_source:    {result['data_source']}")
    else:
        print("  No result — check API key and model name")


if __name__ == "__main__":
    asyncio.run(_test())
