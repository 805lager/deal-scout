"""
trust.py — Composite trust / scam signal evaluator (Task #59).

Combines several cheap, independent fraud heuristics into a single
`trust_severity` bucket and a `trust_signals` list the UI renders as
one digest line. Severity drives a score cap so a glowing 9/10 can't
ride out next to "stock photos + new account + vague description".

Signals (each is a single boolean check; any one fires the line):
  1. is_stock_photo            — vision-extracted (passed in)
  2. reverse_image_matches     — vague: count from external lookup
                                 (graceful no-op if unavailable)
  3. vague_description         — pure-Python heuristic
  4. price_too_good_new_acct   — comp ratio + seller age
  5. duplicate_seller_listing  — placeholder; awaits seller-listings DOM data
  6. photo_text_contradiction  — vision-extracted (passed in)

Severity buckets (per task spec):
  0 fired      → "none"   (no UI line, no score change)
  1 fired      → "info"   (line shown, score untouched)
  2-3 fired    → "warn"   (line shown, score capped at 5,
                            verdict overridden)
  4-5 fired    → "alert"  (line shown, same cap/verdict as warn —
                            distinct color only)
  6 fired      → "alert"  (score floored at 1, verdict
                            "Likely scam — do not engage.")
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field, asdict
from datetime import datetime
from typing import Any

log = logging.getLogger(__name__)


# Spec / model words that, when present, mean a "short" description is
# probably still an honest-but-terse listing rather than a vague one.
# Includes common units, capacities, and category-agnostic hints.
_SPEC_TOKEN_RE = re.compile(
    r"\b("
    r"capacity|size|sized|dimensions?|model|brand|year|inches|inch|"
    r"\d+\s*(?:in|gb|tb|mb|w|watts?|kw|hp|amp|amps|v|volts?|"
    r"lb|lbs|oz|kg|kilo|mile|miles|km|mph|rpm|ft|feet|cm|mm|m\b)|"
    r"mileage|warranty|serial|sku|mpn|upc|made\s+in|imei"
    r")\b",
    re.IGNORECASE,
)


# Severity → score cap / floor / verdict (per task spec).
# Per the task: 2+ signals → cap 5, all 6 → floor 1. The "alert" UI color
# (4-5 signals) shares the same score-cap rules as "warn" (2-3 signals);
# only the chip color differs.
SEVERITY_RULES: dict[str, dict[str, Any]] = {
    "none":  {"cap": None, "floor": None, "verdict": None},
    "info":  {"cap": None, "floor": None, "verdict": None},
    "warn":  {
        "cap":     5,
        "floor":   None,
        "verdict": "Verify before buying — multiple trust concerns.",
    },
    "alert": {
        # Same caps as warn — spec only differentiates by chip color.
        "cap":     5,
        "floor":   None,
        "verdict": "Verify before buying — multiple trust concerns.",
    },
    # Special case: ALL signals firing — strongest negative the model can emit.
    "alert_all": {
        "cap":     1,
        "floor":   1,
        "verdict": "Likely scam — do not engage.",
    },
}


@dataclass
class TrustSignal:
    """One fired trust signal in the form the UI consumes."""
    id:    str   # stable machine id (e.g. "stock_photo")
    label: str   # short user-facing label (e.g. "Stock photos")
    why:   str   # one-line explanation, ≤120 chars

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class TrustResult:
    """
    Output of evaluate_trust(). Caller splats `to_response_dict()` into
    DealScoreResponse and uses `cap_score` / `override_verdict` to mutate
    the deal score before serializing.
    """
    signals:         list[TrustSignal] = field(default_factory=list)
    severity:        str               = "none"
    score_cap:       int | None        = None
    score_floor:     int | None        = None
    verdict_override: str | None       = None

    def to_response_dict(self) -> dict:
        return {
            "trust_signals":  [s.to_dict() for s in self.signals],
            "trust_severity": self.severity,
        }


# ── Helpers ───────────────────────────────────────────────────────────────────


def _parse_joined_date_to_age_days(joined: str | None) -> int | None:
    """
    Best-effort parse of marketplace "joined" strings into account age (days).

    Recognised inputs (case-insensitive, whitespace-tolerant):
      "Dec 2017"   "December 2017"   "2017"   "Jan. 2024"
    Returns None when the input is missing or unparseable. We deliberately
    DO NOT raise — every signal must fail open so a parse miss can never
    surface a misleading "new account" badge on a 10-year-old seller.
    """
    if not joined or not isinstance(joined, str):
        return None
    s = joined.strip().rstrip(".").lower()
    # Strip leading "joined", "in", "since"
    s = re.sub(r"^(joined|in|since)\s+", "", s).strip()

    fmts = ("%b %Y", "%B %Y", "%Y", "%b. %Y")
    parsed = None
    for fmt in fmts:
        try:
            parsed = datetime.strptime(s.title(), fmt) if "%b" in fmt or "%B" in fmt \
                     else datetime.strptime(s, fmt)
            break
        except ValueError:
            continue
    if parsed is None:
        return None

    delta = datetime.utcnow() - parsed
    return max(0, int(delta.days))


def _seller_account_age_days(listing: dict) -> int | None:
    """
    Pull seller account age from any of the supported listing payload keys.
    Prefers an explicit numeric `seller_account_age_days` (extension may
    compute it client-side); otherwise derives from `joined_date` strings.
    """
    explicit = listing.get("seller_account_age_days")
    if isinstance(explicit, (int, float)) and explicit >= 0:
        return int(explicit)

    trust = listing.get("seller_trust") or {}
    joined = (
        trust.get("joined_date")
        or trust.get("member_since")
        or listing.get("seller_joined")
    )
    return _parse_joined_date_to_age_days(joined)


# ── Individual heuristics ─────────────────────────────────────────────────────


def _vague_description_signal(listing: dict) -> TrustSignal | None:
    """
    Fires when a high-priced listing has a short description with no
    spec/model tokens. Catches generic copy-paste scam listings that
    say "Brand new in box, ships fast" with no other detail.
    """
    asking = float(listing.get("price") or 0)
    if asking < 200:
        return None
    desc = (listing.get("description") or "").strip()
    if len(desc) >= 80:
        return None
    if _SPEC_TOKEN_RE.search(desc):
        return None
    return TrustSignal(
        id    = "vague_description",
        label = "Vague description",
        why   = (
            f"Asking ${asking:.0f} but description is only "
            f"{len(desc)} chars with no specs/model details."
        )[:120],
    )


def _price_too_good_new_acct_signal(
    listing: dict,
    comp_median: float,
    age_days: int | None,
) -> TrustSignal | None:
    """
    Fires when asking < 60% of cleaned comp median AND the seller account
    is < 14 days old. Either signal alone is fine; the combination is the
    classic "throwaway account flips one too-cheap listing" pattern.
    """
    asking = float(listing.get("price") or 0)
    if asking <= 0 or comp_median <= 0:
        return None
    if age_days is None or age_days >= 14:
        return None
    ratio = asking / comp_median
    if ratio >= 0.6:
        return None
    return TrustSignal(
        id    = "price_too_good_new_acct",
        label = "Cheap listing, new account",
        why   = (
            f"Asking ${asking:.0f} is {ratio*100:.0f}% of the "
            f"${comp_median:.0f} median; seller joined {age_days} day(s) ago."
        )[:120],
    )


def _stock_photo_signal(
    is_stock_photo: bool,
    why: str,
) -> TrustSignal | None:
    if not is_stock_photo:
        return None
    return TrustSignal(
        id    = "stock_photo",
        label = "Stock photos",
        why   = (why or "Photos look like marketing/stock imagery, not a real item.")[:120],
    )


def _photo_text_contradiction_signal(
    contradiction: bool,
    why: str,
) -> TrustSignal | None:
    if not contradiction:
        return None
    return TrustSignal(
        id    = "photo_text_contradiction",
        label = "Photo/text mismatch",
        why   = (why or "Photos and listing text describe different items.")[:120],
    )


def _reverse_image_signal(match_count: int | None) -> TrustSignal | None:
    """
    Fires when the lookup returned > 2 unrelated marketplace matches for
    the primary photo. None / negative / lookup-skipped values silently
    no-op (graceful degradation per spec).
    """
    if match_count is None or match_count <= 2:
        return None
    return TrustSignal(
        id    = "reverse_image_match",
        label = "Photo found elsewhere",
        why   = f"Primary photo appears on {match_count} other listings — possible reuse.",
    )


def _duplicate_seller_listing_signal(listing: dict) -> TrustSignal | None:
    """
    Fires when the extension reports the same seller has another listing
    with the same primary photo at a different price. Extension surfaces
    the bool as `seller_dup_listing_detected` in the payload; absent →
    silently doesn't fire.
    """
    if not listing.get("seller_dup_listing_detected"):
        return None
    return TrustSignal(
        id    = "duplicate_seller_listing",
        label = "Same photo, different price",
        why   = "Seller is showing the same photo at a different price elsewhere.",
    )


# ── Public entry point ───────────────────────────────────────────────────────


def evaluate_trust(
    *,
    listing: dict,
    comp_median: float = 0.0,
    is_stock_photo: bool = False,
    stock_photo_reason: str = "",
    photo_text_contradiction: bool = False,
    contradiction_reason: str = "",
    reverse_image_match_count: int | None = None,
) -> TrustResult:
    """
    Evaluate every trust signal and bucket into a severity.

    Each signal is independent and `None`-tolerant — a missing input
    silently doesn't fire, never surfaces a false-positive line.
    """
    age_days = _seller_account_age_days(listing)

    candidates = [
        _stock_photo_signal(is_stock_photo, stock_photo_reason),
        _reverse_image_signal(reverse_image_match_count),
        _vague_description_signal(listing),
        _price_too_good_new_acct_signal(listing, comp_median, age_days),
        _duplicate_seller_listing_signal(listing),
        _photo_text_contradiction_signal(photo_text_contradiction, contradiction_reason),
    ]
    fired = [s for s in candidates if s is not None]
    n = len(fired)

    # Total signal slots considered for "all firing" detection.
    TOTAL_SIGNAL_SLOTS = 6

    if n == 0:
        severity_key = "none"
    elif n == 1:
        severity_key = "info"
    elif n <= 3:
        severity_key = "warn"
    elif n >= TOTAL_SIGNAL_SLOTS:
        severity_key = "alert_all"
    else:
        severity_key = "alert"

    rules = SEVERITY_RULES[severity_key]
    # Map alert_all back to "alert" externally — UI only cares about 4 buckets.
    public_severity = "alert" if severity_key == "alert_all" else severity_key

    if n > 0:
        log.info(
            f"[Trust] {n}/{TOTAL_SIGNAL_SLOTS} signals fired → "
            f"severity={public_severity} cap={rules['cap']} floor={rules['floor']} "
            f"ids={[s.id for s in fired]}"
        )

    return TrustResult(
        signals          = fired,
        severity         = public_severity,
        score_cap        = rules["cap"],
        score_floor      = rules["floor"],
        verdict_override = rules["verdict"],
    )


def apply_trust_to_score(deal_score, trust: TrustResult) -> bool:
    """
    Mutate `deal_score` (a DealScore dataclass) in place per the trust
    severity rules. Returns True if anything changed.

    Behaviour:
      • cap reduces score to min(score, cap), clears should_buy
      • floor raises score to max(score, floor) (only used for alert_all,
        which also caps to the same number — net effect: score = floor)
      • verdict_override replaces verdict + prepends to red_flags
    """
    if trust.severity in ("none", "info"):
        return False

    changed = False
    original = deal_score.score

    if trust.score_cap is not None and deal_score.score > trust.score_cap:
        deal_score.score = trust.score_cap
        deal_score.should_buy = False
        changed = True

    if trust.score_floor is not None and deal_score.score < trust.score_floor:
        deal_score.score = trust.score_floor
        deal_score.should_buy = False
        changed = True

    if trust.verdict_override:
        deal_score.verdict = trust.verdict_override
        # Surface in red_flags too so users with the line collapsed still
        # see the concern in the existing flag list.
        if not isinstance(deal_score.red_flags, list):
            deal_score.red_flags = []
        flag_text = f"Trust check: {trust.verdict_override}"
        if flag_text not in deal_score.red_flags:
            deal_score.red_flags.insert(0, flag_text)
        changed = True

    if changed:
        log.info(
            f"[Trust] Applied severity={trust.severity}: "
            f"score {original} → {deal_score.score}, verdict='{deal_score.verdict}'"
        )
    return changed
