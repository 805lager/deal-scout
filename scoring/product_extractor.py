"""
Product Extractor — Accurate Product Identification via Claude

WHY THIS EXISTS:
  FBM listing titles are written by humans for humans. "Telescope" tells eBay
  nothing useful. "Orion SkyQuest XT8 Intelliscope" tells eBay exactly what
  to search — and returns tight, accurate price comps.

  Without this module, a listing titled "Telescope for sale - great deal!"
  searches eBay for "Telescope great deal" and gets results ranging from
  $30 toy scopes to $3,000 research telescopes. Every score built on that
  data will be wrong.

  With this module:
    Input:  title="Telescope", description="Orion SkyQuest XT8 Intelliscope,
            8-inch mirror, like new, bought in 2022..."
    Output: brand="Orion", model="SkyQuest XT8 Intelliscope",
            search_query="Orion SkyQuest XT8 Dobsonian",
            confidence="high"

WHY CLAUDE (not regex/NLP):
  Brand and model naming conventions are wildly inconsistent across categories.
  "Sur-Ron X260", "Orion XT8", "Milwaukee M18 2767-20", "Canon EOS R5" —
  each has a completely different structure. A single Claude prompt handles
  all of them correctly without category-specific rules.

WHY HAIKU (not Sonnet):
  This is a lightweight extraction task — short input, short JSON output.
  Haiku returns in ~0.3s and costs ~$0.0002 per call. Runs concurrently
  with other pipeline steps so it adds near-zero wall time.

FALLBACK STRATEGY:
  If Claude is unavailable or returns unparseable output, falls back to
  the same title-cleaning logic used before this module existed. Scores
  still work — they're just less accurate on vague titles.
"""

import asyncio
import json
import logging
import os
import re
from dataclasses import dataclass, asdict
from typing import Optional

import anthropic
from dotenv import load_dotenv

load_dotenv()

log = logging.getLogger(__name__)

# Module-level client — reuse across calls, never create per-request
_client: Optional[anthropic.Anthropic] = None

def _get_client() -> anthropic.Anthropic:
    global _client
    if _client is None:
        _client = anthropic.Anthropic(api_key=os.getenv("ANTHROPIC_API_KEY"))
    return _client


# ── Data Model ────────────────────────────────────────────────────────────────

@dataclass
class ProductInfo:
    """
    Structured product identity extracted from a listing.

    Every downstream module consumes this instead of the raw listing title:
      - ebay_pricer uses search_query for eBay API calls
      - google_pricer uses search_query for Shopping scrape
      - product_evaluator uses brand + model for Reddit/rating lookups
      - suggestion_engine uses display_name for recommendation prompt
    """
    brand:             str   # "Orion", "Sur-Ron", "Milwaukee", "" if unknown
    model:             str   # "SkyQuest XT8 Intelliscope", "X260", "M18 Fuel"
    category:          str   # "Dobsonian telescope", "electric dirt bike"
    search_query:      str   # Best 3-6 word eBay/Google query
    amazon_query:      str   # Amazon-optimized (may include category terms)
    display_name:      str   # "Orion SkyQuest XT8 Intelliscope" — shown in UI
    confidence:        str   # "high" | "medium" | "low"
    raw_title:         str   # Original listing title — preserved for fallback
    extraction_method: str   # "claude" | "fallback" — for diagnostics


# ── Main Entry Point ──────────────────────────────────────────────────────────

async def extract_product(title: str, description: str = "") -> ProductInfo:
    """
    Extract structured product identity from listing title + description.

    Pipeline:
      1. Send title + first 500 chars of description to Claude Haiku
      2. Parse JSON response into ProductInfo
      3. Fall back to title-cleaning if Claude fails

    Never raises — always returns a ProductInfo, even if low-confidence.
    """
    if not os.getenv("ANTHROPIC_API_KEY"):
        log.warning("[ProductExtractor] No API key — using title-cleaning fallback")
        return _fallback_extraction(title)

    # Cap description — we don't need the whole listing essay for extraction
    desc_snippet = description[:600].strip() if description else ""

    prompt = f"""You are a product identification expert for a marketplace deal scoring app.
Your output drives eBay and Amazon search queries — accuracy directly affects deal score quality.

LISTING TITLE: {title}
LISTING DESCRIPTION: {desc_snippet if desc_snippet else "(no description provided)"}

Extract the product identity. Rules:
- If a model number appears (XT8, X260, M18, EOS R5), ALWAYS include it in search_query
- search_query: 3-6 words — best eBay sold-listings search string for this exact product
- amazon_query: 3-7 words — best Amazon search string (can include brand + model number)
- display_name: "Brand Model" format, human-readable, shown in the UI
- confidence: "high" if brand+model clearly identifiable; "medium" if probable; "low" if guessing
- Do NOT hallucinate model numbers. If unsure of the model, omit it and use category terms
- brand/model can be empty strings if genuinely unknown

Respond ONLY with valid JSON, no preamble, no fences:
{{
  "brand": "<brand name or empty string>",
  "model": "<model name/number or empty string>",
  "category": "<2-4 word category, e.g. Dobsonian telescope>",
  "search_query": "<3-6 word eBay search query>",
  "amazon_query": "<3-7 word Amazon search query>",
  "display_name": "<Brand Model — human readable>",
  "confidence": "<high|medium|low>"
}}"""

    try:
        loop = asyncio.get_running_loop()
        response = await loop.run_in_executor(
            None,
            lambda: _get_client().messages.create(
                model="claude-haiku-4-5-20251001",
                max_tokens=300,
                messages=[{"role": "user", "content": prompt}]
            )
        )

        raw = response.content[0].text.strip()

        # Claude occasionally wraps JSON in fences despite instructions
        if "```" in raw:
            match = re.search(r'\{.*\}', raw, re.DOTALL)
            raw = match.group() if match else raw

        data = json.loads(raw)

        # Defensive defaults — never let a missing key crash the pipeline
        search_query = (data.get("search_query") or "").strip() or _clean_title(title)
        amazon_query = (data.get("amazon_query") or "").strip() or search_query
        display_name = (data.get("display_name") or "").strip() or title[:60]

        info = ProductInfo(
            brand             = (data.get("brand")    or "").strip(),
            model             = (data.get("model")    or "").strip(),
            category          = (data.get("category") or "").strip(),
            search_query      = search_query,
            amazon_query      = amazon_query,
            display_name      = display_name,
            confidence        = data.get("confidence", "medium"),
            raw_title         = title,
            extraction_method = "claude",
        )

        log.info(f"[ProductExtractor] '{info.display_name}' (confidence={info.confidence})")
        log.info(f"  eBay:   '{info.search_query}'")
        log.info(f"  Amazon: '{info.amazon_query}'")
        return info

    except json.JSONDecodeError as e:
        log.warning(f"[ProductExtractor] JSON parse failed: {e} — using fallback")
        return _fallback_extraction(title)
    except Exception as e:
        log.warning(f"[ProductExtractor] Failed ({type(e).__name__}: {e}) — using fallback")
        return _fallback_extraction(title)


# ── Helpers ───────────────────────────────────────────────────────────────────

# Noise words commonly found in FBM listing titles — remove before searching
_NOISE_WORDS = {
    "awesome", "amazing", "great", "nice", "good", "excellent", "perfect",
    "must", "sell", "selling", "sold", "obo", "firm", "negotiable",
    "cheap", "deal", "steal", "price", "reduced", "moving", "sale",
    "used", "new", "like", "condition", "works", "working", "tested",
    "please", "offer", "asking", "willing", "posting", "make", "offer",
    "take", "home", "today", "quick", "fast", "cash", "only", "local",
}

def _clean_title(title: str) -> str:
    """
    Fallback title cleaner — strips noise words and caps at 8 terms.
    Same logic as ebay_pricer.build_search_query() — kept here so
    product_extractor has no circular dependency on ebay_pricer.
    """
    cleaned = re.sub(r"[^\w\s]", " ", title)
    words = [w for w in cleaned.split() if w.lower() not in _NOISE_WORDS and len(w) > 1]
    return " ".join(words[:8])


def _fallback_extraction(title: str) -> ProductInfo:
    """
    Returns a low-confidence ProductInfo from title-cleaning alone.
    Used when: no API key, Claude call fails, JSON unparseable.
    Scores still work — just less accurate on vague titles.
    """
    query = _clean_title(title)
    return ProductInfo(
        brand             = "",
        model             = "",
        category          = "",
        search_query      = query,
        amazon_query      = query,
        display_name      = title[:60],
        confidence        = "low",
        raw_title         = title,
        extraction_method = "fallback",
    )
