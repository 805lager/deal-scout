"""
Query Correction System — Manual Training Loop for Market Comparisons

TWO FAILURE MODES THIS SYSTEM FIXES:

  MODE A — Wrong query:
    eBay/Google returned mismatched results because the auto-generated query
    pulled accessories, parts, or a different product tier.
    Fix: save a better query → used on next score for similar listings.
    Example: "Taylor acoustic electric guitar" → "Taylor 114ce acoustic guitar"

  MODE B — Mock data fallback (query was right, but live sources failed):
    Both Google Shopping and eBay rate-limited/failed. Mock price guessed wrong
    category (e.g. Celestron NexStar 6SE → $150 base instead of ~$800).
    Fix: lock in a real price range → used instead of mock when both fail again.
    Example: NexStar 6SE → price_range=[600, 950]

STORAGE: PostgreSQL query_corrections table (persists across deploys).

LOOKUP STRATEGY:
  Token overlap between incoming listing title and stored correction title.
  >= 60% overlap → use that correction's query and/or price range.
  One correction generalizes to many similar listings without exact matching.
"""

import logging
import re
import time
from typing import Optional

log = logging.getLogger(__name__)

_corrections_cache: list = []
_corrections_cache_ts: float = 0.0
_CACHE_TTL = 120
_corrections_table_ok = False


def _tokenize(text: str) -> set:
    STOP = {
        "the", "a", "an", "in", "on", "of", "for", "to", "and", "or",
        "is", "it", "with", "this", "that", "new", "used", "like",
        "good", "great", "nice", "set", "lot", "item", "oem", "obo",
        "selling", "sale", "price", "firm", "must",
    }
    tokens = re.sub(r"[^\w\s]", " ", text.lower()).split()
    return {t for t in tokens if len(t) > 2 and t not in STOP}


async def _load_corrections() -> list:
    global _corrections_cache, _corrections_cache_ts

    now = time.time()
    if _corrections_cache and (now - _corrections_cache_ts) < _CACHE_TTL:
        return _corrections_cache

    try:
        global _corrections_table_ok
        from scoring.data_pipeline import _get_pool
        pool = await _get_pool()
        if not pool:
            return _corrections_cache
        await _ensure_table(pool)
        rows = await pool.fetch(
            "SELECT listing_title, bad_query, good_query, correct_price_low, correct_price_high, notes, created_at FROM query_corrections ORDER BY id"
        )
        _corrections_cache = [
            {
                "ts": str(r["created_at"])[:16] if r["created_at"] else "",
                "listing_title": r["listing_title"],
                "bad_query": r["bad_query"],
                "good_query": r["good_query"],
                "correct_price_range": [r["correct_price_low"], r["correct_price_high"]] if r["correct_price_low"] else [],
                "notes": r["notes"] or "",
            }
            for r in rows
        ]
        _corrections_cache_ts = now
        log.info(f"[Corrections] Loaded {len(_corrections_cache)} corrections from DB")
    except Exception as e:
        log.warning(f"[Corrections] DB load failed: {e}")

    return _corrections_cache


async def lookup_correction(listing_title: str, current_query: str) -> Optional[dict]:
    corrections = await _load_corrections()
    if not corrections:
        return None

    title_tokens = _tokenize(listing_title)
    if not title_tokens:
        return None

    best_score = 0.0
    best_correction = None

    for c in corrections:
        corr_tokens = _tokenize(c.get("listing_title", ""))
        if not corr_tokens:
            continue
        overlap = title_tokens & corr_tokens
        score = len(overlap) / max(len(title_tokens), len(corr_tokens))
        if score > best_score:
            best_score = score
            best_correction = c

    MATCH_THRESHOLD = 0.60

    if best_score >= MATCH_THRESHOLD and best_correction:
        price_range = best_correction.get("correct_price_range") or []
        result = {
            "good_query": best_correction.get("good_query", current_query),
            "price_low": float(price_range[0]) if len(price_range) >= 1 else 0.0,
            "price_high": float(price_range[1]) if len(price_range) >= 2 else 0.0,
        }
        log.info(
            f"[Corrections] Match (score={best_score:.2f}): '{listing_title}' → "
            f"query='{result['good_query']}' "
            f"price_range=[{result['price_low']}, {result['price_high']}]"
        )
        return result

    return None


async def _ensure_table(pool):
    global _corrections_table_ok
    if _corrections_table_ok:
        return
    await pool.execute("""
        CREATE TABLE IF NOT EXISTS query_corrections (
            id serial PRIMARY KEY,
            created_at timestamptz DEFAULT now(),
            listing_title text NOT NULL,
            bad_query text DEFAULT '',
            good_query text DEFAULT '',
            correct_price_low float DEFAULT 0,
            correct_price_high float DEFAULT 0,
            notes text DEFAULT ''
        )
    """)
    _corrections_table_ok = True


async def save_correction(
    listing_title: str,
    bad_query: str,
    good_query: str,
    correct_price_range: Optional[list] = None,
    notes: str = "",
) -> bool:
    try:
        from scoring.data_pipeline import _get_pool
        pool = await _get_pool()
        if not pool:
            log.warning("[Corrections] No DB pool — correction not saved")
            return False
        await _ensure_table(pool)
        price_low = float(correct_price_range[0]) if correct_price_range and len(correct_price_range) >= 1 else 0.0
        price_high = float(correct_price_range[1]) if correct_price_range and len(correct_price_range) >= 2 else 0.0
        await pool.execute(
            """INSERT INTO query_corrections
               (listing_title, bad_query, good_query, correct_price_low, correct_price_high, notes)
               VALUES ($1,$2,$3,$4,$5,$6)""",
            listing_title.strip(),
            bad_query.strip(),
            good_query.strip(),
            price_low,
            price_high,
            notes.strip(),
        )
        global _corrections_cache_ts
        _corrections_cache_ts = 0.0
        log.info(f"[Corrections] Saved: '{bad_query}' → '{good_query}' range={correct_price_range}")
        return True
    except Exception as e:
        log.error(f"[Corrections] Save failed: {e}")
        return False


async def get_all_corrections() -> list:
    corrections = await _load_corrections()
    return list(reversed(corrections))
