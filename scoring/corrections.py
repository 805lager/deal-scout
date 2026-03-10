"""
Query Correction System — Manual Training Loop for Market Comparisons

WHY THIS EXISTS:
  The #1 cause of bad market comparisons is a bad eBay search query.
  "Taylor acoustic electric guitar" → eBay query "Taylor acoustic electric"
  returns Taylor acoustic guitars at $800 avg instead of the $200 beginner
  model that was actually listed. One bad query = completely wrong score.

  This module provides a simple correction layer:
    1. `/feedback` endpoint accepts: bad_query, corrected_query, correct_price
    2. Corrections saved to corrections.jsonl (flat file, no database)
    3. ebay_pricer.py checks corrections BEFORE searching — overrides bad queries
    4. /admin page shows recent scores + lets you click to correct them

  After 10-20 corrections, the most common item types are locked in and
  market comparisons become dramatically more accurate.

CORRECTION FILE FORMAT (one JSON per line):
  {
    "ts": "2026-03-10T12:00:00",
    "listing_title": "Taylor 114ce acoustic electric guitar",
    "bad_query": "Taylor acoustic electric guitar",
    "good_query": "Taylor 114ce guitar",
    "correct_price_range": [150, 350],
    "notes": "114ce is entry-level, not pro — eBay was returning Artist series"
  }

LOOKUP STRATEGY:
  Token overlap between listing title and correction's listing_title.
  If >= 60% of meaningful tokens match, use that correction's good_query.
  This handles minor title variations without requiring exact matches.
"""

import json
import logging
import re
import time
from pathlib import Path
from typing import Optional

log = logging.getLogger(__name__)

CORRECTIONS_FILE = Path(__file__).parent.parent / "data" / "corrections.jsonl"

# In-memory cache — reloaded when file changes
_corrections_cache: list = []
_corrections_mtime: float = 0.0


def _load_corrections() -> list:
    """Load corrections from disk, using cache if file hasn't changed."""
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
    """Extract meaningful tokens for fuzzy matching."""
    STOP = {
        "the", "a", "an", "in", "on", "of", "for", "to", "and", "or",
        "is", "it", "with", "this", "that", "new", "used", "like",
        "good", "great", "nice", "set", "lot", "item", "oem", "obo",
        "selling", "sale", "price", "firm", "must",
    }
    tokens = re.sub(r"[^\w\s]", " ", text.lower()).split()
    return {t for t in tokens if len(t) > 2 and t not in STOP}


def lookup_correction(listing_title: str, current_query: str) -> Optional[str]:
    """
    Check if we have a manual correction for this listing type.
    Returns the corrected search query if found, None otherwise.

    Uses fuzzy title matching (>= 60% token overlap) so corrections
    generalize to similar listings without requiring exact matches.
    """
    corrections = _load_corrections()
    if not corrections:
        return None

    title_tokens = _tokenize(listing_title)
    if not title_tokens:
        return None

    best_score   = 0.0
    best_query   = None

    for c in corrections:
        corr_tokens = _tokenize(c.get("listing_title", ""))
        if not corr_tokens:
            continue

        # Bidirectional overlap: both titles should agree
        overlap = title_tokens & corr_tokens
        score   = len(overlap) / max(len(title_tokens), len(corr_tokens))

        if score > best_score:
            best_score = score
            best_query = c.get("good_query")

    MATCH_THRESHOLD = 0.60  # 60% token overlap required

    if best_score >= MATCH_THRESHOLD and best_query:
        log.info(f"[Corrections] Match (score={best_score:.2f}): '{listing_title}' → '{best_query}'")
        return best_query

    return None


def save_correction(
    listing_title: str,
    bad_query: str,
    good_query: str,
    correct_price_range: Optional[list] = None,
    notes: str = "",
) -> bool:
    """
    Save a new correction to disk.
    Returns True on success, False on failure.
    """
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

        # Invalidate cache so next lookup reads fresh data
        global _corrections_mtime
        _corrections_mtime = 0.0

        log.info(f"[Corrections] Saved: '{bad_query}' → '{good_query}'")
        return True
    except Exception as e:
        log.error(f"[Corrections] Save failed: {e}")
        return False


def get_all_corrections() -> list:
    """Return all corrections — used by /admin endpoint."""
    return list(reversed(_load_corrections()))  # newest first
