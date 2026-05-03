"""
Confidence Bucketer — Task #58

Single source of truth for the score-line "confidence" badge shown to
the user. The score number alone hides whether it was backed by 14
tight comps or 3 wildly divergent ones; this module turns the cleaned
comp set + extraction confidence into one of four buckets:

    high    — strong signal, render green chip, no caveats
    medium  — usable signal, render amber chip
    low     — thin signal, render red chip; user should treat as a hint
    none    — not enough data to score honestly. Caller flips can_price=False
              and replaces the score number with the "can't price" verdict.

Lowest-signal-wins is intentional: a pricing pipeline that found 12
tight comps but identified the wrong product (extraction confidence
"low") is still a "low" overall — if we don't know what the product is,
we certainly don't know its price.

Used by /score and /score/stream after market_value + product_info are
in hand. Pure function, no I/O — easy to test and reason about.
"""

from __future__ import annotations

from typing import Tuple


def determine_anchor_source(comp_count: int, new_price: float) -> str:
    """
    Single source of truth for which price reference anchors the score.

    Task #78 — when used-comp count is too thin (<3) BUT we know the typical
    new-retail price (from Google Shopping, Claude, or Amazon), we fall back
    to scoring against new-retail with a forced "low" confidence + a
    server-built disclaimer.

    Task #84 — when used-comp count is 1 or 2 AND no new-retail price is
    available, we anchor on the thin used comp set (rather than dead-ending
    with CAN'T PRICE) and surface a server-built disclaimer telling the user
    the score rests on very few sales. Only the genuine "0 used comps AND
    no new-retail" case keeps anchor_source="none".

    Returns one of:
        "sold_comps"       — normal path, ≥3 cleaned used comps
        "sold_comps_thin"  — 1-2 cleaned used comps, no new-retail (force low)
        "new_retail"       — 0 cleaned used comps, new-retail known (force low)
        "none"             — no anchor at all; can_price will be False
    """
    if comp_count >= 3:
        return "sold_comps"
    if new_price and new_price > 0:
        return "new_retail"
    if comp_count >= 1:
        return "sold_comps_thin"
    return "none"


def derive_confidence(
    comp_count: int,
    comp_low: float,
    comp_high: float,
    comp_median: float,
    extraction_confidence: str = "medium",
    market_confidence: str = "",
    new_price: float = 0.0,
) -> Tuple[str, dict]:
    """
    Compute the overall confidence bucket and per-signal reasons.

    Args:
        comp_count: Number of comps after cleaning. <3 forces fallback to
            new-retail anchor (when available) or "none".
        comp_low / comp_high / comp_median: Cleaned comp stats. Used to compute
            spread = (high-low)/median. comp_median == 0 disables the spread
            signal (we treat it as "low" rather than crashing).
        extraction_confidence: "high" | "medium" | "low" from product_extractor.
            Anything outside this set is normalised to "medium".
        market_confidence: Optional `MarketValue.confidence` string. Used as a
            ceiling so we don't claim "high" when the pricing pipeline itself
            said "low" (e.g. AI-knowledge-only fallback). Empty string disables.
        new_price: Task #78 — typical new-retail price ($) when known.
            When comp_count<3 AND new_price>0, we return bucket="low" with
            anchor_source="new_retail" instead of "none", so the score panel
            still shows a useful (low-confidence) score against new retail.

    Returns:
        (bucket, signals)
        bucket   — "high" | "medium" | "low" | "none"
        signals  — dict with the per-signal buckets so the UI / logs can
                   explain WHICH signal pulled it down. Always includes
                   `anchor_source` ∈ {"sold_comps", "new_retail", "none"}.
    """
    # ── Signal 1: Comp count after cleaning ────────────────────────────────
    if comp_count >= 10:
        comp_signal = "high"
    elif comp_count >= 5:
        comp_signal = "medium"
    elif comp_count >= 3:
        comp_signal = "low"
    else:
        # <3 comps. Try fallbacks in order before bailing to "none":
        #   1. new-retail price known           → anchor_source=new_retail (Task #78)
        #   2. 1-2 used comps, no new-retail    → anchor_source=sold_comps_thin (Task #84)
        #   3. zero anchor of any kind          → "none" / CAN'T PRICE
        if new_price and new_price > 0:
            return "low", {
                "comp_count":      "low",   # we have AN anchor, just not from used sales
                "spread":          "n/a",
                "extraction":      _normalise_conf(extraction_confidence),
                "market":          (market_confidence or "n/a").lower(),
                "anchor_source":   "new_retail",
                "winning_signal":  "new_retail_anchor",
            }
        if comp_count >= 1:
            return "low", {
                "comp_count":      "low",   # 1-2 sold comps — anchor exists, just thin
                "spread":          "n/a",   # spread on n=1 is meaningless
                "extraction":      _normalise_conf(extraction_confidence),
                "market":          (market_confidence or "n/a").lower(),
                "anchor_source":   "sold_comps_thin",
                "winning_signal":  "sold_comps_thin_anchor",
            }
        return "none", {
            "comp_count":     "none",
            "spread":         "n/a",
            "extraction":     _normalise_conf(extraction_confidence),
            "market":         (market_confidence or "n/a").lower(),
            "anchor_source":  "none",
            "winning_signal": "comp_count",
        }

    # ── Signal 2: Spread (max-min)/median ──────────────────────────────────
    if comp_median > 0:
        spread = (comp_high - comp_low) / comp_median
        if spread < 0.3:
            spread_signal = "high"
        elif spread <= 0.6:
            spread_signal = "medium"
        else:
            spread_signal = "low"
    else:
        # No median → can't compute spread → don't claim high on spread alone
        spread = 0.0
        spread_signal = "low"

    # ── Signal 3: Product extraction confidence ────────────────────────────
    extraction_signal = _normalise_conf(extraction_confidence)

    # ── Optional ceiling: don't exceed market_confidence ───────────────────
    # MarketValue.confidence reflects the source quality (real eBay sold
    # vs AI-knowledge-only). If the pipeline itself only achieved "low",
    # the user shouldn't see "high confidence" just because the LLM picked
    # a tight range.
    market_signal = (market_confidence or "").lower()
    if market_signal not in {"high", "medium", "low"}:
        market_signal = ""  # ignore unknown buckets like "insufficient_data"

    # ── Lowest signal wins ─────────────────────────────────────────────────
    rank = {"high": 3, "medium": 2, "low": 1}
    signals_to_consider = [comp_signal, spread_signal, extraction_signal]
    if market_signal:
        signals_to_consider.append(market_signal)

    bucket = min(signals_to_consider, key=lambda s: rank.get(s, 0))

    # Identify the WINNING (lowest) signal name for explanation
    label_for = {
        comp_signal: "comp_count",
        spread_signal: "spread",
        extraction_signal: "extraction",
    }
    if market_signal:
        label_for[market_signal] = "market"
    # ties: prefer comp_count > spread > extraction > market for "what to fix first"
    winning = "comp_count" if comp_signal == bucket else (
        "spread" if spread_signal == bucket else (
            "extraction" if extraction_signal == bucket else "market"
        )
    )

    return bucket, {
        "comp_count":     comp_signal,
        "spread":         spread_signal,
        "extraction":     extraction_signal,
        "market":         market_signal or "n/a",
        "spread_pct":     round(spread * 100, 1) if comp_median > 0 else 0.0,
        "anchor_source":  "sold_comps",
        "winning_signal": winning,
    }


def new_retail_disclaimer(new_price: float) -> str:
    """
    Server-built (NEVER LLM-authored) disclaimer rendered on the score
    panel whenever a score is anchored on new-retail price instead of
    used comps. Fixed template so a malicious listing cannot fake or
    strip the warning, per the project's Cybersecurity-first principles.
    """
    if new_price and new_price > 0:
        return (
            f"Score based on new-retail price (~${new_price:.0f}); "
            f"no used sales found — confidence is low."
        )
    return ""


def thin_comps_disclaimer(comp_count: int, comp_median: float) -> str:
    """
    Task #84 — server-built (NEVER LLM-authored) disclaimer for the
    "1-2 used comps, no new-retail" case. Same fixed-template guarantee
    as new_retail_disclaimer so a malicious listing cannot strip or
    fake the warning.
    """
    if comp_count <= 0:
        return ""
    sale_word = "sale" if comp_count == 1 else "sales"
    if comp_median and comp_median > 0:
        return (
            f"Score anchored on only {comp_count} comparable {sale_word} "
            f"(~${comp_median:.0f}); confidence is low — treat as a "
            f"starting point."
        )
    return (
        f"Score anchored on only {comp_count} comparable {sale_word}; "
        f"confidence is low — treat as a starting point."
    )


def _normalise_conf(value: str) -> str:
    """Map any extraction-confidence string to one of {high, medium, low}."""
    v = (value or "").strip().lower()
    if v in {"high", "medium", "low"}:
        return v
    return "medium"


def cant_price_message(asking_price: float) -> str:
    """
    Standardised verdict copy when can_price is False.
    The asking-price reference is what the user actually decides against.
    """
    if asking_price and asking_price > 0:
        return (
            f"Not enough comparable sales to score this confidently. "
            f"Asking price is ${asking_price:.0f} — treat as your reference."
        )
    return (
        "Not enough comparable sales to score this confidently. "
        "Use the asking price as your reference."
    )
