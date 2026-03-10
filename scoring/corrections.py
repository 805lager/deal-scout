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

CORRECTION FILE FORMAT (one JSON per line):
  {
    "ts": "2026-03-10T12:00:00",
    "listing_title": "Celestron NexStar 6SE telescope bundle",
    "bad_query": "Celestron NexStar 6SE telescope",
    "good_query": "Celestron NexStar 6SE telescope",   ← same = query was fine
    "correct_price_range": [600, 950],                 ← this is the real fix
    "notes": "from sidebar · source=ebay_mock"
  }

LOOKUP STRATEGY:
  Token overlap between incoming listing title and stored correction title.
  >= 60% overlap → use that correction's query and/or price range.
  One correction generalizes to many similar listings without exact matching.
"""

import json
import logging
import re
import time
from pathlib import Path
from typing import Optional

log = logging.getLogger(__name__)

CORRECTIONS_FILE = Path(__file__).parent.parent / "data" / "corrections.jsonl"

# In-memory cache — reloaded when file changes on disk
_corrections_cache: list = []
_corrections_mtime: float = 0.0


def _load_corrections() -> list:
    """Load corrections from disk, using in-memory cache if unchanged."""
    global _corrections_cache, _corrections_mtime

    if not CORRECTIONS_FILE.exists():
        return []

    mtime = CORRECTIONS_FILE.stat().st_mtime
    if mtime == _corrections_mtime:
        return _corrections_cache

    corrections = []
    try:
        for line in CORRECTIONS_FILE.read_text().splitlines():
            line = line.strip()
            if line:
                corrections.append(json.loads(line))
        _corrections_cache = corrections
        _corrections_mtime = mtime
        log.info(f"[Corrections] Loaded {len(corrections)} corrections from disk")
    except Exception as e:
        log.warning(f"[Corrections] Failed to load: {e}")

    return _corrections_cache


def _tokenize(text: str) -> set:
    """Extract meaningful tokens for fuzzy title matching."""
    STOP = {
        "the", "a", "an", "in", "on", "of", "for", "to", "and", "or",
        "is", "it", "with", "this", "that", "new", "used", "like",
        "good", "great", "nice", "set", "lot", "item", "oem", "obo",
        "selling", "sale", "price", "firm", "must",
    }
    tokens = re.sub(r"[^\w\s]", " ", text.lower()).split()
    return {t for t in tokens if len(t) > 2 and t not in STOP}


def lookup_correction(listing_title: str, current_query: str) -> Optional[dict]:
    """
    Check if we have a manual correction for this listing type.

    Returns a dict with:
      good_query  (str)            — corrected search query (may equal current)
      price_low   (float)          — locked-in price range low  (0 = not set)
      price_high  (float)          — locked-in price range high (0 = not set)

    Returns None if no match found.

    Uses fuzzy title matching (>= 60% token overlap) so one correction
    generalizes to similar listings without requiring exact title matches.
    """
    corrections = _load_corrections()
    if not corrections:
        return None

    title_tokens = _tokenize(listing_title)
    if not title_tokens:
        return None

    best_score      = 0.0
    best_correction = None

    for c in corrections:
        corr_tokens = _tokenize(c.get("listing_title", ""))
        if not corr_tokens:
            continue

        overlap = title_tokens & corr_tokens
        score   = len(overlap) / max(len(title_tokens), len(corr_tokens))

        if score > best_score:
            best_score      = score
            best_correction = c

    MATCH_THRESHOLD = 0.60

    if best_score >= MATCH_THRESHOLD and best_correction:
        price_range = best_correction.get("correct_price_range") or []
        result = {
            "good_query":  best_correction.get("good_query", current_query),
            "price_low":   float(price_range[0]) if len(price_range) >= 1 else 0.0,
            "price_high":  float(price_range[1]) if len(price_range) >= 2 else 0.0,
        }
        log.info(
            f"[Corrections] Match (score={best_score:.2f}): '{listing_title}' → "
            f"query='{result['good_query']}' "
            f"price_range=[{result['price_low']}, {result['price_high']}]"
        )
        return result

    return None


def save_correction(
    listing_title: str,
    bad_query: str,
    good_query: str,
    correct_price_range: Optional[list] = None,
    notes: str = "",
) -> bool:
    """Save a correction to disk. Returns True on success."""
    try:
        CORRECTIONS_FILE.parent.mkdir(parents=True, exist_ok=True)
        entry = {
            "ts":                  time.strftime("%Y-%m-%dT%H:%M:%S"),
            "listing_title":       listing_title.strip(),
            "bad_query":           bad_query.strip(),
            "good_query":          good_query.strip(),
            "correct_price_range": correct_price_range or [],
            "notes":               notes.strip(),
        }
        with open(CORRECTIONS_FILE, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry) + "\n")

        # Invalidate cache so next lookup re-reads
        global _corrections_mtime
        _corrections_mtime = 0.0

        log.info(f"[Corrections] Saved: '{bad_query}' → '{good_query}' range={correct_price_range}")
        return True
    except Exception as e:
        log.error(f"[Corrections] Save failed: {e}")
        return False


def get_all_corrections() -> list:
    """Return all corrections newest-first — used by /admin endpoint."""
    return list(reversed(_load_corrections()))
