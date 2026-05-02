"""
leverage.py — Negotiation leverage signals (Task #60).

Two cheap DOM-derived signals that hand the buyer real negotiation power
without needing any new backend pipelines:

  1. Price-drop history of the listing itself
     - If the seller has dropped from $500 → $450 → $425 over 18 days,
       that tells the buyer the seller is motivated and they can be
       aggressive. We accept a list of {date, price} when the extension
       can extract it, OR fall back to a single-step drop derived from
       the existing `original_price` field (FBM strikethrough, eBay
       crossed-out price, etc.).

  2. Time-on-market
     - "Listed 23 days ago" vs "Just listed 2 hours ago" are completely
       different deals at the same asking price. We accept either an
       integer `days_listed` from the extension OR a `listed_at` raw
       string we parse server-side ("3 days ago", "2 weeks ago", an
       ISO date, etc.).

Composite output:
    motivation_level ∈ {"low", "medium", "high"}
    + a price_drop_summary string and the typical_days_to_sell when
      we can derive one from the comp set.

Negotiation v2 (Task #53) is intended to read motivation_level and
adjust opening offer + walk-away threshold. #53 is unmerged at the
time of writing this module — we still emit motivation_level so it
plugs in cleanly when #53 lands. Until then the field is purely
informational on the digest line.

Every input is treated as untrusted/optional. Any parse failure or
missing field silently degrades — leverage signals must NEVER fire
on bad data and surface a misleading "stale listing, lowball harder"
recommendation.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from typing import Any, Optional

log = logging.getLogger(__name__)


# ── Tunables (single source of truth for thresholds) ─────────────────────────

# Days-listed buckets (used when we cannot compare to typical_days_to_sell).
FRESH_DAYS_MAX  = 3      # 0-3 days listed → "fresh"
STALE_DAYS_MIN  = 14     # 14+ days listed → "stale"

# Ratio buckets when we DO have typical_days_to_sell from comp data.
# days_listed / typical < 0.5 → fresh; > 1.5 → stale.
FRESH_RATIO_MAX = 0.5
STALE_RATIO_MIN = 1.5

# Drop magnitude — pct of original price below which we consider it a
# meaningful drop worth surfacing (small reductions like $300 → $295
# aren't real motivation evidence).
MIN_DROP_PCT = 0.03   # 3%


@dataclass
class LeverageResult:
    """
    Output of evaluate_leverage(). Caller splats `to_response_dict()`
    into DealScoreResponse — all fields land under `leverage_signals`.
    """
    price_drop_summary:    str           = ""    # human-readable, "" when no drop
    drop_count:            int           = 0     # how many distinct drops we know about
    drop_total_amount:     float         = 0.0   # cumulative $ reduction from peak
    drop_total_pct:        float         = 0.0   # 0.0–1.0 of peak price
    days_listed:           Optional[int] = None
    typical_days_to_sell:  Optional[int] = None
    days_listed_summary:   str           = ""    # "" when we know nothing
    motivation_level:      str           = "low"  # low | medium | high

    def to_response_dict(self) -> dict:
        """Shape consumed by DealScoreResponse.leverage_signals."""
        return {
            "leverage_signals": {
                "price_drop_summary":   self.price_drop_summary,
                "drop_count":           self.drop_count,
                "drop_total_amount":    round(self.drop_total_amount, 2),
                "drop_total_pct":       round(self.drop_total_pct, 4),
                "days_listed":          self.days_listed,
                "typical_days_to_sell": self.typical_days_to_sell,
                "days_listed_summary":  self.days_listed_summary,
                "motivation_level":     self.motivation_level,
            }
        }


# ── Helpers ──────────────────────────────────────────────────────────────────


_RELATIVE_TIME_RE = re.compile(
    r"(?:listed|posted|published|updated)?\s*"
    r"(\d+)\s*"
    r"(minute|min|hour|hr|day|d|week|wk|month|mo|year|yr)s?"
    r"\s*ago",
    re.IGNORECASE,
)
_TODAY_RE     = re.compile(r"\b(?:listed|posted)\s+(?:today|just\s+now|moments?\s+ago)\b", re.IGNORECASE)
_YESTERDAY_RE = re.compile(r"\b(?:listed|posted)\s+yesterday\b", re.IGNORECASE)


def _parse_listed_at_to_days(value: str | None) -> Optional[int]:
    """
    Parse listed_at into days-since-listing.

    Accepts (case-insensitive, whitespace-tolerant):
      relative:   "3 days ago", "Listed 2 weeks ago", "Posted 4 hours ago"
      anchors:    "Listed today", "Posted yesterday", "Just now"
      ISO date:   "2024-04-15", "2024-04-15T10:30:00Z"

    Returns None when input is missing or unparseable. NEVER raises —
    every caller depends on graceful degradation.
    """
    if not value or not isinstance(value, str):
        return None
    s = value.strip()
    if not s:
        return None

    if _TODAY_RE.search(s) or re.search(r"\bjust\s+now\b", s, re.IGNORECASE):
        return 0
    if _YESTERDAY_RE.search(s):
        return 1

    m = _RELATIVE_TIME_RE.search(s)
    if m:
        try:
            n = int(m.group(1))
        except (TypeError, ValueError):
            n = 0
        unit = m.group(2).lower()
        if unit in ("minute", "min", "hour", "hr"):
            return 0
        if unit in ("day", "d"):
            return max(0, n)
        if unit in ("week", "wk"):
            return max(0, n * 7)
        if unit in ("month", "mo"):
            return max(0, n * 30)
        if unit in ("year", "yr"):
            return max(0, n * 365)

    iso = s.replace("Z", "+00:00")
    # Strip a leading weekday + comma so eBay's "Mon, Apr 1, 2024" form
    # parses against our month-first patterns. The extension's regex
    # already drops it, but be defensive in case other surfaces don't.
    s_no_wkday = re.sub(
        r"^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\.?,?\s+",
        "",
        s,
        flags=re.IGNORECASE,
    )
    for fmt in (None, "%Y-%m-%d", "%Y/%m/%d", "%m/%d/%Y", "%B %d, %Y", "%b %d, %Y"):
        try:
            if fmt is None:
                dt = datetime.fromisoformat(iso)
            else:
                dt = datetime.strptime(s_no_wkday, fmt)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            delta = datetime.now(timezone.utc) - dt
            return max(0, int(delta.days))
        except (ValueError, TypeError):
            continue
    return None


def _normalize_price_history(history: Any, original_price: float, current_price: float) -> list[dict]:
    """
    Normalize the price-history payload from the extension into a sorted
    list of {price, date} dicts (date may be None). Falls back to a
    synthetic single-step drop from `original_price` → `current_price`
    when no explicit history is available — this keeps the signal alive
    on FBM/eBay where the DOM only exposes a strikethrough peak price,
    not the full drop timeline.
    """
    out: list[dict] = []
    if isinstance(history, list):
        for entry in history:
            if not isinstance(entry, dict):
                continue
            try:
                price = float(entry.get("price") or 0)
            except (TypeError, ValueError):
                continue
            if price <= 0:
                continue
            date = entry.get("date") if isinstance(entry.get("date"), str) else None
            out.append({"price": price, "date": date})

    if not out and original_price and current_price and original_price > current_price:
        out = [
            {"price": float(original_price), "date": None},
            {"price": float(current_price),  "date": None},
        ]

    return out


def _compute_drop_summary(normalized: list[dict], current_price: float) -> tuple[str, int, float, float]:
    """
    Returns (summary_text, drop_count, total_amount_dropped, total_pct_dropped).
    Empty summary string when no meaningful drop was observed.
    """
    if not normalized or current_price <= 0:
        return "", 0, 0.0, 0.0

    peak = max(p["price"] for p in normalized)
    if peak <= current_price:
        return "", 0, 0.0, 0.0

    total_drop = peak - current_price
    pct        = total_drop / peak if peak > 0 else 0.0
    if pct < MIN_DROP_PCT:
        return "", 0, 0.0, 0.0

    drop_count = max(1, len(normalized) - 1)

    if drop_count == 1:
        summary = f"Asking dropped ${total_drop:.0f} from ${peak:.0f} \u2014 seller is motivated."
    else:
        summary = (
            f"Asking dropped ${total_drop:.0f} over {drop_count} reductions "
            f"(from ${peak:.0f} \u2192 ${current_price:.0f}) \u2014 seller is motivated."
        )
    return summary, drop_count, total_drop, pct


def _classify_days_listed(days_listed: Optional[int], typical: Optional[int]) -> str:
    """
    Bucket the listing into 'fresh' | 'normal' | 'stale' | 'unknown'.
    Prefers ratio-vs-typical when typical is available; falls back to
    absolute-days buckets otherwise.
    """
    if days_listed is None:
        return "unknown"
    if typical and typical > 0:
        ratio = days_listed / typical
        if ratio < FRESH_RATIO_MAX:
            return "fresh"
        if ratio > STALE_RATIO_MIN:
            return "stale"
        return "normal"
    if days_listed <= FRESH_DAYS_MAX:
        return "fresh"
    if days_listed >= STALE_DAYS_MIN:
        return "stale"
    return "normal"


def _days_listed_summary(days_listed: Optional[int], typical: Optional[int], bucket: str) -> str:
    """
    Render the human-readable time-on-market line. Empty string when we
    have nothing meaningful to say (no days_listed extracted).
    """
    if days_listed is None:
        return ""
    if days_listed == 0:
        base = "Just listed today \u2014 seller is fresh, expect little budge."
    elif days_listed == 1:
        base = "Listed yesterday \u2014 seller is fresh, expect little budge."
    else:
        base = f"Listed {days_listed} days ago"
        if typical and typical > 0:
            base += (
                f" \u2014 typical time-to-sell here is ~{typical} days. "
                f"Negotiation room is {'wide' if bucket == 'stale' else 'narrow' if bucket == 'fresh' else 'moderate'}."
            )
        elif bucket == "stale":
            base += " \u2014 well past fresh, negotiation room is wide."
        elif bucket == "fresh":
            base += " \u2014 still fresh, expect little budge."
        else:
            base += "."
    return base


def _derive_motivation_level(drop_count: int, drop_pct: float, bucket: str) -> str:
    """
    Compose motivation_level from drops + days bucket. Ordered low → high.

    Rules (deliberately conservative — we'd rather under-call than tell
    the buyer to lowball a fresh listing where the seller will just walk):
      - Stale listing AND a big drop (≥10% off peak)   → high
      - Stale listing OR a meaningful drop alone       → medium
      - Otherwise (fresh / normal w/ no drop)          → low

    Important: a stale-only listing with NO drop history is medium (not
    high) — staleness alone might just mean overpriced or niche, not a
    motivated seller. The "high" tier requires BOTH price-drop evidence
    AND extended time on market.
    """
    big_drop = drop_pct >= 0.10
    has_drop = drop_count > 0
    if bucket == "stale" and big_drop:
        return "high"
    if bucket == "stale" or has_drop:
        return "medium"
    return "low"


# ── Public entry point ───────────────────────────────────────────────────────


def evaluate_leverage(
    *,
    listing: dict,
    typical_days_to_sell: Optional[int] = None,
) -> LeverageResult:
    """
    Composite leverage evaluator. Reads from the listing payload:
      price                  — current asking price
      original_price         — strikethrough peak (FBM/eBay)
      price_history          — [{date, price}] when extension can extract it
      days_listed            — int when extension has computed it
      listed_at              — raw string ("3 days ago", ISO date) otherwise

    Returns a LeverageResult — empty/quiet when no signals available.
    """
    try:
        current_price = float(listing.get("price") or 0)
    except (TypeError, ValueError):
        current_price = 0.0

    try:
        original_price = float(listing.get("original_price") or 0)
    except (TypeError, ValueError):
        original_price = 0.0

    normalized = _normalize_price_history(listing.get("price_history"), original_price, current_price)
    drop_summary, drop_count, drop_amount, drop_pct = _compute_drop_summary(normalized, current_price)

    explicit_days = listing.get("days_listed")
    if isinstance(explicit_days, (int, float)) and explicit_days >= 0:
        days_listed = int(explicit_days)
    else:
        days_listed = _parse_listed_at_to_days(listing.get("listed_at"))

    typical = typical_days_to_sell if (typical_days_to_sell and typical_days_to_sell > 0) else None
    bucket  = _classify_days_listed(days_listed, typical)
    days_summary = _days_listed_summary(days_listed, typical, bucket)
    motivation   = _derive_motivation_level(drop_count, drop_pct, bucket)

    return LeverageResult(
        price_drop_summary   = drop_summary,
        drop_count           = drop_count,
        drop_total_amount    = drop_amount,
        drop_total_pct       = drop_pct,
        days_listed          = days_listed,
        typical_days_to_sell = typical,
        days_listed_summary  = days_summary,
        motivation_level     = motivation,
    )


def derive_typical_days_to_sell(comp_summary: dict | None) -> Optional[int]:
    """
    Pull a "typical time-to-sell" integer from the cleaned comp_summary
    when the comp pipeline exposed one. The eBay Browse path stores
    sold-comp ages in `comp_summary['median_sold_age_days']` if available
    (Task #58 cleaner). Returns None when not derivable so the leverage
    line gracefully degrades into days-only mode.
    """
    if not isinstance(comp_summary, dict):
        return None
    val = (
        comp_summary.get("typical_days_to_sell")
        or comp_summary.get("median_sold_age_days")
    )
    if isinstance(val, (int, float)) and val > 0:
        return int(val)
    return None
