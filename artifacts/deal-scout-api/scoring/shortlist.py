"""
FBM Search Shortlist — Task #103

Triage tool for Facebook Marketplace search-results pages. Takes a deck of
visible listing cards (title / price / thumbnail / listing_url) plus the
user's search query, asks Claude Haiku to pick the top 10 most promising
candidates using the user-confirmed tiered rubric, and returns the picks
with a one-line `why` per row.

This is a TRIAGE TOOL, NOT A VERDICT TOOL. The real verdict still comes
from the existing per-listing /score/stream flow, which the user kicks
off by clicking "Score this" on a row.

DESIGN NOTES (do not collapse without re-reading the task plan):
  * URL canonicalization happens BEFORE Claude sees the deck and BEFORE
    dedupe — FBM listing URLs carry transient tracking params that would
    otherwise break the popup's "already scored" tracking.
  * Every scraped title/snippet flows through scoring._prompt_safety.wrap()
    so a malicious seller cannot inject instructions via their title.
  * In-process response cache (hash of query + sorted canonical URLs)
    with a 5-minute TTL — trending searches hit the same listings; we
    must not pay for the Claude call twice in a row.
  * Returns {picks, skipped_count, reason_if_short, cached} — never
    raises on malformed Claude output; the route handler returns 200
    with empty picks + a reason so the UI can show a clean error state.
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
import time
from typing import Any
from urllib.parse import urlparse

from scoring._anthropic_client import get_anthropic_client
from scoring._prompt_safety import UNTRUSTED_SYSTEM_MESSAGE, wrap

log = logging.getLogger(__name__)

# ── Tunables ──────────────────────────────────────────────────────────────────
MAX_DECK_SIZE = 50          # Drop extras server-side to bound token cost.
MAX_TITLE_CHARS = 200       # Per-row title truncation.
MAX_QUERY_CHARS = 120       # User-supplied search query cap.
MAX_PICKS = 10              # Top-N to return.
MIN_SCORE_THRESHOLD = 40    # Below this, Claude is told to drop the row rather
                            # than force-fill 10 slots with junk.

CACHE_TTL_SECONDS = 300     # 5 minutes — long enough for trending searches,
                            # short enough that stale picks don't haunt users.
_CACHE_MAX_ENTRIES = 256    # Hard ceiling; oldest entries evicted past this.

# Process-local cache keyed by hash(query + sorted canonical URLs).
# Value: (expires_at_epoch_seconds, response_dict).
_response_cache: dict[str, tuple[float, dict]] = {}


# ── URL canonicalization ──────────────────────────────────────────────────────
# FBM listing URLs come in shapes like:
#   https://www.facebook.com/marketplace/item/1234567890/?ref=search&referral_code=...
#   https://www.facebook.com/marketplace/sanfrancisco/item/9876/?surface=...
# All we care about is /marketplace/item/<id>. Stripping locale prefix and
# all query/hash garbage gives us a stable identity so the popup's
# "already scored" map doesn't fragment on cosmetic differences.
_ITEM_ID_RE = re.compile(r"/marketplace/(?:[^/]+/)?item/(\d+)")


def canonicalize_url(url: str) -> str:
    """
    Return the canonical bare-item form, e.g.
    'https://www.facebook.com/marketplace/item/1234567890'

    SECURITY (per code review of Task #103): this is a strict allowlist.
    URLs that don't resolve to an FBM marketplace item id return "" so the
    deck-normalizer drops them. This prevents a malicious page (or an
    extension MITM) from sneaking a non-FBM URL into the deck and getting
    the popup's "Score this" button to open it in a new tab.
    """
    if not url or not isinstance(url, str):
        return ""
    url = url.strip()
    m = _ITEM_ID_RE.search(url)
    if not m:
        return ""
    # Belt-and-suspenders: also verify the host parses as facebook.com so a
    # path like "/marketplace/item/123" on attacker.com can't match the regex
    # via an open redirect.
    try:
        parsed = urlparse(url)
        host = (parsed.netloc or "").lower()
        if host and not (host == "facebook.com" or host.endswith(".facebook.com")):
            return ""
    except Exception:
        return ""
    return f"https://www.facebook.com/marketplace/item/{m.group(1)}"


# ── Deck normalization ────────────────────────────────────────────────────────
def normalize_deck(raw_deck: list[dict]) -> list[dict]:
    """
    Cap the deck, canonicalize URLs, dedupe, and truncate text fields.

    Returns a list of `{title, price, thumbnail_url, listing_url}` ready
    to embed in the prompt. Rows missing a usable URL or title are dropped.
    """
    if not isinstance(raw_deck, list):
        return []
    seen_urls: set[str] = set()
    out: list[dict] = []
    for raw in raw_deck:
        if not isinstance(raw, dict):
            continue
        url = canonicalize_url(str(raw.get("listing_url") or ""))
        if not url or url in seen_urls:
            continue
        title = str(raw.get("title") or "").strip()
        if not title:
            continue
        if len(title) > MAX_TITLE_CHARS:
            title = title[: MAX_TITLE_CHARS - 1] + "…"
        try:
            price = float(raw.get("price") or 0.0)
        except (TypeError, ValueError):
            price = 0.0
        thumb = str(raw.get("thumbnail_url") or "").strip()
        seen_urls.add(url)
        out.append({
            "title": title,
            "price": price,
            "thumbnail_url": thumb,
            "listing_url": url,
        })
        if len(out) >= MAX_DECK_SIZE:
            break
    return out


# ── Cache helpers ─────────────────────────────────────────────────────────────
def _cache_key(query: str, deck: list[dict]) -> str:
    """Hash query + sorted canonical URLs. Order-independent."""
    urls = sorted(d["listing_url"] for d in deck)
    payload = (query or "").strip().lower() + "|" + "|".join(urls)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _cache_get(key: str) -> dict | None:
    entry = _response_cache.get(key)
    if not entry:
        return None
    expires_at, value = entry
    if time.time() >= expires_at:
        _response_cache.pop(key, None)
        return None
    # Return a shallow copy with `cached=True` flag for telemetry.
    out = dict(value)
    out["cached"] = True
    return out


def _cache_put(key: str, value: dict) -> None:
    # Evict oldest entries (by expiry) if we're over the soft ceiling. This
    # is a process-local cache, not a hot path — O(n) evict is fine.
    if len(_response_cache) >= _CACHE_MAX_ENTRIES:
        oldest_key = min(
            _response_cache.keys(),
            key=lambda k: _response_cache[k][0],
        )
        _response_cache.pop(oldest_key, None)
    _response_cache[key] = (time.time() + CACHE_TTL_SECONDS, value)


def reset_cache_for_tests() -> None:
    """Clear the in-process cache. Test-only."""
    _response_cache.clear()


# ── Prompt construction ───────────────────────────────────────────────────────
_SYSTEM_PROMPT = (
    UNTRUSTED_SYSTEM_MESSAGE
    + "\n\n"
    + "You are triaging Facebook Marketplace search results to surface the most "
    "promising deals for a buyer. You ONLY see what fits on a search card: a "
    "title, an asking price, and an optional thumbnail URL. You do NOT have "
    "access to the full listing description, photos, seller history, or real "
    "market data. Your job is to RANK candidates so the user can decide which "
    "to inspect in detail — not to produce a final verdict.\n\n"
    "Scoring rubric (each listing scored 0–100 against the user's search query):\n"
    "  • 45% — Retail Value vs Asking Price: estimate a plausible new-retail "
    "    range from the title alone. Recognized brand+model = tight estimate; "
    "    vague title = wide range (and a lower score). A solid, believable "
    "    discount (asking roughly 35–70% of plausible retail) earns the top of "
    "    this band. BUT a discount that is too good to be true is a RED FLAG, "
    "    not a green one: if asking is below ~25–30% of plausible retail for a "
    "    recognized, in-demand model, treat it as likely bait, a scam, a typo, "
    "    or a wrong/parts item and CAP this component low rather than maxing it. "
    "    Real screaming deals at that price almost never survive on a public "
    "    search card.\n"
    "  • 25% — Model Tier: specific brand/model with version/year beats "
    "    generic descriptions (e.g. \"Sony WH-1000XM5\" > \"nice headphones\").\n"
    "  • 20% — Capacity / Features: concrete specs in the title (storage size, "
    "    screen size, year, model number, variant) score higher than featureless "
    "    titles.\n"
    "  • 10% — Signal Words: positive cues (\"new in box\", \"sealed\", "
    "    \"barely used\", \"OEM\") boost; negative cues (\"for parts\", "
    "    \"as-is\", \"must sell today\", \"DM only\", \"no scammers\") suppress.\n\n"
    "OFF-TARGET PENALTY: if the listing clearly does not match the user's "
    "search query (e.g. user searched 'iPhone 14 Pro' but the title is "
    "'iPhone 14' or 'iPhone case'), apply a heavy penalty regardless of "
    "other signals.\n\n"
    "QUALITY BAR: drop any listing scoring below "
    f"{MIN_SCORE_THRESHOLD}. Do NOT force-fill the top-10 with junk. It is "
    "better to return 4 strong picks than 10 mediocre ones.\n\n"
    f"Return AT MOST {MAX_PICKS} picks, ranked highest score first. "
    "Respond with VALID JSON ONLY (no markdown fences, no prose) in this exact shape:\n"
    "{\n"
    "  \"picks\": [{\"listing_url\": \"<url>\", \"score\": <0-100>, "
    "\"why\": \"<one short sentence, max 90 chars>\"}, ...],\n"
    "  \"reason_if_short\": \"<empty string OR a short explanation if returning fewer than 10>\"\n"
    "}"
)


def build_prompt(query: str, deck: list[dict]) -> str:
    """
    Render the user-message text. The deck arrives already normalized.
    Every untrusted field (title, query) is wrapped via _prompt_safety.wrap()
    so a malicious seller can't break out of the envelope.
    """
    safe_query = wrap("text", query, empty_placeholder="(no query)")
    lines = [
        f"User search query: {safe_query}",
        "",
        f"Listings on this page (up to {MAX_DECK_SIZE}):",
    ]
    for i, row in enumerate(deck, start=1):
        safe_title = wrap("listing_title", row["title"], empty_placeholder="(no title)")
        price_str = f"${row['price']:.0f}" if row["price"] > 0 else "$?"
        lines.append(f"{i}. price={price_str} url={row['listing_url']} title={safe_title}")
    return "\n".join(lines)


# ── Response parsing ──────────────────────────────────────────────────────────
def parse_response(raw_text: str, valid_urls: set[str]) -> tuple[list[dict], str]:
    """
    Parse Claude's JSON response defensively.

    Returns (picks, reason_if_short). On any parse failure returns
    ([], "Could not read Claude's response — try again.") — never raises.

    `valid_urls` is the canonical-URL set from the input deck; any pick
    whose URL isn't in this set is dropped (defends against Claude
    hallucinating listings or rewriting URLs).
    """
    if not raw_text or not isinstance(raw_text, str):
        return [], "Empty response from Claude."

    # Robust extraction — fences, prose, trailing commentary, json_repair.
    # See scoring/__init__.py extract_claude_json for the full strategy.
    from scoring import extract_claude_json
    data = extract_claude_json(raw_text, label="Shortlist")
    if data is None:
        log.error(f"[Shortlist] JSON extraction failed after all fallbacks. Raw: {raw_text[:300]}")
        return [], "Could not read Claude's response — try again."

    if not isinstance(data, dict):
        return [], "Could not read Claude's response — try again."

    raw_picks = data.get("picks") if isinstance(data.get("picks"), list) else []
    reason = str(data.get("reason_if_short") or "").strip()

    picks: list[dict] = []
    for raw in raw_picks:
        if not isinstance(raw, dict):
            continue
        url = canonicalize_url(str(raw.get("listing_url") or ""))
        if not url or url not in valid_urls:
            continue
        try:
            score = int(round(float(raw.get("score") or 0)))
        except (TypeError, ValueError):
            score = 0
        score = max(0, min(100, score))
        if score < MIN_SCORE_THRESHOLD:
            continue
        why = str(raw.get("why") or "").strip()
        if len(why) > 120:
            why = why[:117] + "…"
        picks.append({
            "listing_url": url,
            "score": score,
            "why": why,
        })
        if len(picks) >= MAX_PICKS:
            break

    # Sort by score descending — Claude is asked to do this but we
    # double-enforce so the UI never has to.
    picks.sort(key=lambda p: p["score"], reverse=True)

    return picks, reason


# ── Main entry point ──────────────────────────────────────────────────────────
async def run_shortlist(query: str, raw_deck: list[dict]) -> dict:
    """
    Top-level: normalize → cache lookup → Claude → parse → cache put.

    Always returns a dict with:
      {
        picks: [{listing_url, score, why}, ...],   # 0..MAX_PICKS
        skipped_count: int,                        # cards dropped by quality bar
        reason_if_short: str,                      # human-readable when len(picks) < MAX_PICKS
        cached: bool,                              # true on cache hit
        deck_size: int,                            # post-dedupe input size
      }

    Never raises on malformed Claude output. Surface a clean error to the
    UI via reason_if_short instead. The caller is responsible for auth
    and rate-limit checks BEFORE invoking this.
    """
    import asyncio

    # 1. Normalize first so the cache key is stable.
    query = (query or "")[:MAX_QUERY_CHARS].strip()
    deck = normalize_deck(raw_deck)
    deck_size = len(deck)

    if deck_size < 5:
        return {
            "picks": [],
            "skipped_count": 0,
            "reason_if_short": (
                "Not enough listings visible on this page — scroll to load more "
                "results, then click Shortlist again."
            ),
            "cached": False,
            "deck_size": deck_size,
        }

    # 2. Cache lookup BEFORE hitting Claude.
    key = _cache_key(query, deck)
    cached = _cache_get(key)
    if cached:
        return cached

    # 3. Claude call.
    valid_urls = {d["listing_url"] for d in deck}
    user_prompt = build_prompt(query, deck)

    t0 = time.time()
    try:
        client = get_anthropic_client()
        loop = asyncio.get_running_loop()
        response = await loop.run_in_executor(
            None,
            lambda: client.messages.create(
                model="claude-haiku-4-5",
                max_tokens=1024,
                system=_SYSTEM_PROMPT,
                messages=[{"role": "user", "content": user_prompt}],
            ),
        )
    except Exception as e:
        log.error(f"[Shortlist] Claude call failed: {type(e).__name__}: {e}")
        return {
            "picks": [],
            "skipped_count": 0,
            "reason_if_short": "Couldn't reach Claude right now — please try again.",
            "cached": False,
            "deck_size": deck_size,
        }

    raw_text = ""
    try:
        raw_text = response.content[0].text.strip()
    except Exception:
        log.error("[Shortlist] Claude response had no text content")

    duration_ms = int((time.time() - t0) * 1000)
    picks, reason = parse_response(raw_text, valid_urls)

    # Skipped = deck cards that didn't make the cut. Useful telemetry,
    # also helps the UI render "Showed N of M listings" if we want it later.
    skipped = max(0, deck_size - len(picks))
    # If Claude gave a reason but we hit MAX_PICKS anyway, drop the reason.
    if len(picks) >= MAX_PICKS:
        reason = ""
    elif not reason and len(picks) < MAX_PICKS:
        if not picks:
            reason = "No listings on this page met the quality bar."
        else:
            reason = f"Only {len(picks)} of {deck_size} listings met the quality bar."

    result = {
        "picks": picks,
        "skipped_count": skipped,
        "reason_if_short": reason,
        "cached": False,
        "deck_size": deck_size,
    }
    log.info(
        f"[Shortlist] q='{query[:40]}' deck={deck_size} picks={len(picks)} "
        f"skipped={skipped} duration_ms={duration_ms}"
    )

    _cache_put(key, result)
    return result
