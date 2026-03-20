"""
Product Evaluator — Reliability & Reputation Signals

WHY THIS EXISTS:
  Price is only half the picture. A listing at 30% below market is still a
  bad buy if that product model is known for failing after 6 months.

  This module gathers real owner sentiment from two sources:
    1. Reddit public search — enthusiast communities are brutally honest
       about product failures, build quality, and hidden issues
    2. Google Shopping aggregate ratings — star scores pulled from the same
       page we're already scraping for pricing (near-zero extra latency)

  The output does two things:
    a) Enriches Claude's scoring prompt so it can factor in known issues
       ("this telescope is known for collimation problems out of the box")
    b) Powers the suggestion cards — we can say why an alternative is better
       ("Sky-Watcher 8" has better build quality and fewer reported issues")

WHY NOT Consumer Reports / Wirecutter:
  No public API. Scraping carries legal risk. Reddit + Google Shopping
  provides comparable signal for the product categories we care about
  (consumer electronics, power tools, outdoor gear, sporting goods)
  completely for free.

REDDIT API NOTES:
  Uses the public JSON endpoint (no OAuth required for read-only search).
  Rate limit: ~30 requests/minute unauthenticated. At POC scale (1 call
  per unique product, cached 30 min) this is never an issue.

  For production: register a free Reddit app at https://www.reddit.com/prefs/apps
  and add REDDIT_CLIENT_ID + REDDIT_CLIENT_SECRET to .env for 100 req/min.

LATENCY:
  Reddit: ~0.5-1.5s (two parallel HTTP requests)
  Google rating: ~1-2s (Playwright page already loaded for pricing)
  Both run concurrently with eBay pricing — net added latency: ~0s
"""

import asyncio
import logging
import re
import time
from dataclasses import dataclass, field
from typing import Optional

import httpx
from dotenv import load_dotenv

load_dotenv()

log = logging.getLogger(__name__)

_cache: dict = {}
_CACHE_TTL = 1800  # 30 min — reliability data doesn't change minute-to-minute


# ── Data Model ────────────────────────────────────────────────────────────────

@dataclass
class ProductEvaluation:
    """
    Aggregated reliability and reputation signal for a product model.

    Consumed by:
      - deal_scorer.build_scoring_prompt() — Claude gets the reputation context
      - suggestion_engine — cards show reliability tier alongside price
      - fbm.js renderScore() — sidebar shows reliability badge
    """
    product_name:      str
    overall_rating:    Optional[float]  # 1-5 stars aggregated; None if unknown
    review_count:      int
    reliability_tier:  str              # "excellent"|"good"|"mixed"|"poor"|"unknown"
    known_issues:      list             # ["motor noise above 50%", "battery issues"]
    strengths:         list             # ["excellent optics for price", "easy setup"]
    reddit_sentiment:  Optional[str]    # 1-2 sentence owner consensus summary
    reddit_post_count: int
    sources_used:      list             # ["reddit", "google_shopping", "gemini"]
    confidence:        str              # "high" | "medium" | "low"
    ai_powered:        bool = False     # True when Gemini AI contributed to this assessment

    def to_prompt_text(self) -> str:
        """
        Format for inclusion in Claude's scoring prompt.
        Concise and direct — Claude reasons better from conclusions than raw data.
        """
        if self.reliability_tier == "unknown" or self.confidence == "low":
            return "Product reputation: Insufficient data to assess reliability for this model."

        lines = [f"Product reputation: {self.reliability_tier.upper()} reliability tier"]

        if self.overall_rating and self.review_count >= 10:
            lines.append(f"Aggregate rating: {self.overall_rating:.1f}/5 stars ({self.review_count:,} reviews)")

        if self.known_issues:
            lines.append(f"Known issues: {'; '.join(self.known_issues[:3])}")

        if self.strengths:
            lines.append(f"Owner strengths: {'; '.join(self.strengths[:3])}")

        if self.reddit_sentiment:
            lines.append(f"Community consensus: {self.reddit_sentiment}")

        return "\n".join(lines)


# ── Main Entry Point ──────────────────────────────────────────────────────────

async def evaluate_product(
    brand: str,
    model: str,
    category: str,
    display_name: str,
) -> ProductEvaluation:
    """
    Gather reliability signals for a product from Reddit + Google Shopping.

    Runs both sources concurrently. Never raises — returns "unknown" tier
    on any failure so the scoring pipeline continues uninterrupted.

    Results cached for 30 minutes — the same product appearing in multiple
    listings in a session costs one lookup, not one per listing.
    """
    if not brand and not model:
        log.debug("[Evaluator] No brand/model — skipping evaluation")
        return _unknown_evaluation(display_name)

    cache_key = f"{brand.lower()} {model.lower()}".strip()
    now = time.time()

    if cache_key in _cache:
        entry = _cache[cache_key]
        if now - entry["ts"] < _CACHE_TTL:
            log.info(f"[Evaluator] Cache hit: '{cache_key}'")
            return entry["data"]

    log.info(f"[Evaluator] Evaluating: '{display_name}'")

    # Run Reddit search + Google Shopping rating + Gemini AI concurrently.
    # Gemini is the most reliable source — Reddit can rate-limit, Google HTML changes.
    # return_exceptions=True prevents one failure from cancelling the others.
    reddit_data, google_rating, gemini_rep = await asyncio.gather(
        _fetch_reddit_signals(brand, model, category),
        _fetch_google_rating(display_name),
        _fetch_gemini_reputation(brand, model, category),
        return_exceptions=True,
    )

    if isinstance(reddit_data, Exception):
        log.warning(f"[Evaluator] Reddit failed: {reddit_data}")
        reddit_data = _empty_reddit()

    if isinstance(google_rating, Exception):
        log.warning(f"[Evaluator] Google rating failed: {google_rating}")
        google_rating = {"rating": None, "count": 0}

    if isinstance(gemini_rep, Exception):
        log.warning(f"[Evaluator] Gemini reputation failed: {gemini_rep}")
        gemini_rep = {}

    rating = google_rating.get("rating")
    count  = google_rating.get("count", 0)
    issues = reddit_data.get("issues", [])
    posts  = reddit_data.get("posts", [])

    # ── Merge Gemini + Reddit/Google signals ───────────────────────────────────
    # Gemini knows product reputation from training data (millions of reviews).
    # Reddit catches very recent issues that post-date Gemini's training cutoff.
    # Strategy: Gemini sets the baseline tier/issues/strengths. Reddit appends
    # any additional signals not already captured. This is better than either alone.
    gemini_powered = bool(gemini_rep and gemini_rep.get("reliability_tier") not in (None, "unknown", ""))

    if gemini_powered:
        tier       = gemini_rep["reliability_tier"]
        confidence = gemini_rep.get("confidence", "medium")
        # Merge Gemini issues/strengths with Reddit-found signals, deduplicating
        gemini_issues    = gemini_rep.get("known_issues", [])
        gemini_strengths = gemini_rep.get("strengths", [])
        all_issues   = list(dict.fromkeys(gemini_issues   + [i for i in issues   if i not in gemini_issues]))[:5]
        all_strengths = list(dict.fromkeys(gemini_strengths + [s for s in reddit_data.get("strengths", []) if s not in gemini_strengths]))[:5]
        # Use Gemini sentiment as primary; Reddit sentiment supplements when Gemini is brief
        final_sentiment = gemini_rep.get("sentiment") or reddit_data.get("sentiment")
        # Bump confidence if Google reviews confirm Gemini's assessment
        if count >= 100 and confidence == "medium":
            confidence = "high"
        sources = ["gemini"]
        if posts:  sources.append("reddit")
        if rating: sources.append("google_shopping")
        log.info(f"[Evaluator] Gemini powered: tier={tier} conf={confidence} ai_issues={len(gemini_issues)} reddit_posts={len(posts)}")
    else:
        # Gemini unavailable (no API key, quota, etc.) — fall back to Reddit/Google only
        tier            = _determine_tier(rating, count, issues, posts)
        confidence      = _determine_confidence(rating, count, posts)
        all_issues      = issues[:5]
        all_strengths   = reddit_data.get("strengths", [])[:5]
        final_sentiment = reddit_data.get("sentiment")
        sources = []
        if posts:  sources.append("reddit")
        if rating: sources.append("google_shopping")

    result = ProductEvaluation(
        product_name      = display_name,
        overall_rating    = rating,
        review_count      = count,
        reliability_tier  = tier,
        known_issues      = all_issues,
        strengths         = all_strengths,
        reddit_sentiment  = final_sentiment,
        reddit_post_count = len(posts),
        sources_used      = sources,
        confidence        = confidence,
        ai_powered        = gemini_powered,
    )

    _cache[cache_key] = {"data": result, "ts": now}
    log.info(
        f"[Evaluator] {tier.upper()} tier — "
        f"rating={rating}, reviews={count}, reddit={len(posts)} posts"
    )
    return result


# ── Gemini AI Reputation Engine ─────────────────────────────────────────────

async def _fetch_gemini_reputation(brand: str, model: str, category: str) -> dict:
    """
    Use Claude AI to assess product reliability from training data.
    (Replaces original Gemini implementation — uses Replit AI integration.)

    Returns dict with reliability_tier, confidence, known_issues, strengths,
    sentiment. Returns {} on any failure — never blocks the pipeline.
    """
    import os as _os, json as _json, re as _re, asyncio as _asyncio
    import anthropic as _anthropic

    if not _os.getenv("AI_INTEGRATIONS_ANTHROPIC_BASE_URL"):
        log.debug("[ClaudeReputation] AI integration not configured — skipping")
        return {}

    product_term = f"{brand} {model}".strip()
    if not product_term or product_term.lower() in ("unknown unknown", "unknown"):
        return {}

    prompt = f"""You are a product reliability expert. Based on consumer reviews, owner reports, and known quality data for the {product_term}, provide a reliability assessment.

Return ONLY a valid JSON object (no markdown, no explanation outside the JSON):
{{
  "reliability_tier": "excellent|good|mixed|poor|unknown",
  "confidence": "high|medium|low",
  "known_issues": ["brief issue 1", "brief issue 2"],
  "strengths": ["brief strength 1", "brief strength 2"],
  "sentiment": "1-2 sentence owner consensus summary"
}}

Reliability tier guide:
- excellent: highly reliable, minimal owner complaints, strong build quality
- good: generally reliable with minor issues reported
- mixed: notable reliability concerns, inconsistent quality reports
- poor: significant recurring issues, high complaint volume
- unknown: product not well-documented or too niche to assess

Base this only on real owner feedback and documented issues, not marketing.
If you lack model-specific data but know the brand's general reliability, use the brand-level tier at "low" confidence rather than returning "unknown". Only return "unknown" if the brand itself is obscure or you genuinely have no quality signal at all."""

    try:
        client = _anthropic.Anthropic(
            api_key=_os.getenv("AI_INTEGRATIONS_ANTHROPIC_API_KEY", "placeholder"),
            base_url=_os.getenv("AI_INTEGRATIONS_ANTHROPIC_BASE_URL"),
        )
        loop = _asyncio.get_event_loop()
        response = await _asyncio.wait_for(
            loop.run_in_executor(
                None,
                lambda: client.messages.create(
                    model="claude-haiku-4-5",
                    max_tokens=400,
                    messages=[{"role": "user", "content": prompt}],
                )
            ),
            timeout=10.0,
        )
        text = response.content[0].text.strip()
        text = _re.sub(r"```(?:json)?\s*", "", text)
        text = _re.sub(r"```", "", text)

        json_start = text.find("{")
        json_end   = text.rfind("}") + 1
        if json_start == -1 or json_end == 0:
            return {}

        data = _json.loads(text[json_start:json_end])
        tier = str(data.get("reliability_tier", "unknown")).lower()
        if tier not in ("excellent", "good", "mixed", "poor", "unknown"):
            tier = "unknown"
        conf = str(data.get("confidence", "medium")).lower()
        if conf not in ("high", "medium", "low"):
            conf = "medium"

        result = {
            "reliability_tier": tier,
            "confidence":       conf,
            "known_issues":     [str(i) for i in (data.get("known_issues") or [])[:5]],
            "strengths":        [str(s) for s in (data.get("strengths")    or [])[:5]],
            "sentiment":        str(data.get("sentiment") or ""),
        }
        log.info(f"[ClaudeReputation] '{product_term}' -> tier={tier}")
        return result
    except _asyncio.TimeoutError:
        log.warning(f"[ClaudeReputation] Timeout for '{product_term}'")
        return {}
    except Exception as e:
        log.warning(f"[ClaudeReputation] Failed for '{product_term}': {type(e).__name__}: {e}")
        return {}




# ── Reddit Signal Extraction ──────────────────────────────────────────────────

# Regex patterns that signal product problems in Reddit text
_ISSUE_PATTERNS = [
    (r'\b(break|broke|broken|failure|failed|fail|dead|died)\b',        "reliability issues reported"),
    (r'\b(noisy|noise|loud|rattle|vibrat|squeaking)\b',                "noise or vibration issues"),
    (r'\b(battery|charge|charging).{0,25}(issue|problem|bad|drain|die)', "battery or charging issues"),
    (r'\b(motor|engine|transmission).{0,25}(issue|problem|burn|overheat|fail)', "motor or drivetrain issues"),
    (r'\b(customer.?service|support).{0,20}(bad|terrible|awful|useless|ignore)', "poor customer support"),
    (r'\b(plastic|cheap.?feel|flimsy|fragile|thin)\b',                 "build quality concerns"),
    (r'\b(defect|lemon|doa|out.of.box|oobox)\b',                      "out-of-box defect reports"),
    (r'\b(recall|safety.?issue|dangerous|hazard|fire|explod)\b',       "safety concerns reported"),
    (r'\b(return|refund).{0,20}(denied|refused|difficult|nightmare)',   "return or refund issues"),
]

# Regex patterns that signal product strengths in Reddit text
_STRENGTH_PATTERNS = [
    (r'\b(excellent|amazing|outstanding|love it|perfect|superb)\b',           "highly praised by owners"),
    (r'\b(reliable|dependable|durable|solid|sturdy|tank)\b',                  "strong durability"),
    (r'\b(easy|simple|intuitive).{0,20}(use|setup|assemble|install)',         "easy to use or set up"),
    (r'\b(great|good|best).{0,20}(value|bang.for.the.buck|money|price)',      "excellent value for money"),
    (r'\b(customer.?service|support).{0,20}(great|excellent|helpful|fast)',   "responsive customer support"),
    (r'\b(optic|lens|glass|image|picture|view).{0,20}(sharp|clear|crisp|excellent)', "excellent optics/image quality"),
    (r'\b(well.?built|quality.?construction|premium.?feel|solid.?build)\b',   "premium build quality"),
]


async def _fetch_reddit_signals(brand: str, model: str, category: str) -> dict:
    """
    Search Reddit for owner discussions and extract issue/strength signals.

    WHY TWO QUERIES:
    "[product] review" finds enthusiast assessments and recommendation threads.
    "[product] problem issue" finds complaint threads where real failures surface.
    Together they give a balanced signal in two parallel requests.

    WHY PUBLIC JSON API:
    Reddit's /search.json works without OAuth for read-only queries.
    Headers must include a descriptive User-Agent or Reddit 429s immediately.
    """
    product_term = f"{brand} {model}".strip()
    if not product_term:
        return _empty_reddit()

    queries = [
        f"{product_term} review",
        f"{product_term} problem issue",
    ]

    all_posts = []

    async with httpx.AsyncClient(
        timeout=8.0,
        # Reddit 429s instantly without a descriptive User-Agent
        headers={"User-Agent": "DealScout/0.3 deal-scoring-extension (opensource; github.com/805lager/deal-scout)"},
        follow_redirects=True,
    ) as client:
        tasks = [_single_reddit_search(client, q) for q in queries]
        results = await asyncio.gather(*tasks, return_exceptions=True)

        for r in results:
            if isinstance(r, list):
                all_posts.extend(r)

    # Deduplicate by URL — both queries may return the same top posts
    seen, unique_posts = set(), []
    for p in all_posts:
        if p["url"] not in seen:
            seen.add(p["url"])
            unique_posts.append(p)

    if not unique_posts:
        return _empty_reddit()

    # Build combined text from top 10 posts for pattern matching
    combined_text = " ".join(
        f"{p.get('title', '')} {p.get('selftext', '')}"
        for p in unique_posts[:10]
    ).lower()

    issues, strengths = [], []
    seen_i, seen_s = set(), set()

    for pattern, label in _ISSUE_PATTERNS:
        if re.search(pattern, combined_text, re.IGNORECASE) and label not in seen_i:
            issues.append(label)
            seen_i.add(label)

    for pattern, label in _STRENGTH_PATTERNS:
        if re.search(pattern, combined_text, re.IGNORECASE) and label not in seen_s:
            strengths.append(label)
            seen_s.add(label)

    # Build a plain-English sentiment summary for the Claude prompt
    n = len(unique_posts)
    sentiment = None
    if n >= 3:
        if len(issues) == 0 and len(strengths) >= 2:
            sentiment = f"Strongly positive across {n} Reddit discussions. Owners highlight reliability and value."
        elif len(issues) >= 2 and len(strengths) <= 1:
            sentiment = f"Mixed or negative reception in {n} Reddit threads. Recurring: {issues[0]}."
        elif len(issues) >= 1:
            sentiment = f"Mostly positive in {n} discussions but some owners report {issues[0]}."
        else:
            sentiment = f"Discussed in {n} Reddit threads with no strong consensus on reliability."

    return {
        "posts":     unique_posts,
        "issues":    issues,
        "strengths": strengths,
        "sentiment": sentiment,
    }


async def _single_reddit_search(client: httpx.AsyncClient, query: str) -> list:
    """Execute one Reddit search and return a list of post dicts."""
    try:
        resp = await client.get(
            "https://www.reddit.com/search.json",
            params={
                "q":     query,
                "sort":  "relevance",
                "limit": "10",
                "t":     "year",    # Last year — older posts less product-relevant
                "type":  "link",
            }
        )
        if resp.status_code == 429:
            log.debug(f"[Reddit] Rate limited for '{query}'")
            return []
        if resp.status_code != 200:
            log.debug(f"[Reddit] HTTP {resp.status_code} for '{query}'")
            return []

        posts = resp.json().get("data", {}).get("children", [])
        return [
            {
                "title":     p["data"].get("title", ""),
                "selftext":  p["data"].get("selftext", "")[:400],
                "score":     p["data"].get("score", 0),
                "url":       p["data"].get("url", ""),
                "subreddit": p["data"].get("subreddit", ""),
            }
            for p in posts
            if p.get("data", {}).get("score", 0) > 2  # Skip near-zero posts
        ]
    except Exception as e:
        log.debug(f"[Reddit] Search error for '{query}': {e}")
        return []


# ── Google Shopping Rating ────────────────────────────────────────────────────

async def _fetch_google_rating(product_name: str) -> dict:
    """
    Extract aggregate star rating from Google Shopping via httpx (no Playwright).

    WHY REWRITTEN (v2 — httpx):
      Original used _ensure_browser from google_pricer.py (Playwright).
      google_pricer.py was rewritten to httpx, removing _ensure_browser.
      Importing a non-existent function corrupts the asyncio event loop on
      Windows and crashes uvicorn after every request (same as B-V5).

    STRATEGY:
      1. JSON-LD aggregateRating (schema.org/Product) — most stable
      2. HTML text regex fallback ("4.3 out of 5 stars")
    """
    import json as _json
    import re as _re
    import urllib.parse

    try:
        encoded = urllib.parse.quote_plus(product_name)
        url = f"https://www.google.com/search?udm=28&q={encoded}&hl=en&gl=us&num=10"
        headers = {
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/122.0.0.0 Safari/537.36"
            ),
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
            "Referer": "https://www.google.com/",
        }
        async with httpx.AsyncClient(headers=headers, follow_redirects=True, timeout=6.0) as client:
            resp = await client.get(url)
            html = resp.text

        rating, count = None, 0

        # Strategy 1: JSON-LD aggregateRating
        for block in _re.findall(
            r'<script[^>]+type=["\']application/ld\+json["\'][^>]*>(.*?)</script>',
            html, _re.DOTALL | _re.I
        ):
            try:
                r, c = _extract_rating_from_jsonld(_json.loads(block))
                if r and not rating:
                    rating, count = r, c
            except Exception:
                continue

        # Strategy 2: HTML text patterns
        if not rating:
            m = _re.search(r'([0-9](?:\.[0-9])?)\s*(?:out\s*of\s*5|stars?|/5)', html, _re.I)
            if m:
                val = float(m.group(1))
                if 1.0 <= val <= 5.0:
                    rating = round(val, 1)
            cm = _re.search(r'([\d,]{3,})\s*(?:reviews?|ratings?)', html, _re.I)
            if cm:
                count = int(cm.group(1).replace(",", "")) or 0

        log.debug(f"[Evaluator] Google rating for '{product_name}': {rating} ({count} reviews)")
        return {"rating": rating, "count": count}

    except Exception as e:
        log.debug(f"[Evaluator] Google rating fetch failed: {e}")
        return {"rating": None, "count": 0}


def _extract_rating_from_jsonld(data) -> tuple:
    """Recursively extract (rating, count) from a JSON-LD object."""
    if isinstance(data, list):
        for item in data:
            r, c = _extract_rating_from_jsonld(item)
            if r: return r, c
        return None, 0
    if not isinstance(data, dict):
        return None, 0
    if data.get("@type") == "AggregateRating":
        try:
            r = float(data.get("ratingValue", 0) or 0)
            c = int(data.get("reviewCount", 0) or data.get("ratingCount", 0) or 0)
            if 1.0 <= r <= 5.0:
                return round(r, 1), c
        except (ValueError, TypeError):
            pass
    for val in data.values():
        if isinstance(val, (dict, list)):
            r, c = _extract_rating_from_jsonld(val)
            if r: return r, c
    return None, 0


def _determine_tier(
    rating: Optional[float],
    review_count: int,
    issues: list,
    reddit_posts: list,
) -> str:
    """
    Map raw signals to a reliability tier.

    WHY TIERS (not a numeric score):
    "Mixed reviews — known battery issues" is immediately actionable.
    A number like "3.2/5" is not. Tiers translate directly to UI labels
    and suggestion card messaging.
    """
    has_rating = rating is not None and review_count >= 10
    has_reddit = len(reddit_posts) >= 3

    if not has_rating and not has_reddit:
        return "unknown"

    issue_count = len(issues)

    if has_rating:
        if rating >= 4.5 and issue_count == 0:
            return "excellent"
        elif rating >= 4.2 and issue_count <= 1:
            return "good"
        elif rating >= 3.5:
            return "mixed"
        else:
            return "poor"

    # Reddit-only path (no Google rating)
    if issue_count == 0:
        return "good"
    elif issue_count == 1:
        return "mixed"
    else:
        return "poor"


def _determine_confidence(
    rating: Optional[float],
    review_count: int,
    reddit_posts: list,
) -> str:
    has_solid_rating = rating is not None and review_count >= 100
    has_reddit       = len(reddit_posts) >= 5

    if has_solid_rating and has_reddit:
        return "high"
    elif has_solid_rating or (rating is not None and len(reddit_posts) >= 2):
        return "medium"
    return "low"


def _empty_reddit() -> dict:
    return {"posts": [], "issues": [], "strengths": [], "sentiment": None}


def _unknown_evaluation(product_name: str) -> ProductEvaluation:
    return ProductEvaluation(
        product_name      = product_name,
        overall_rating    = None,
        review_count      = 0,
        reliability_tier  = "unknown",
        known_issues      = [],
        strengths         = [],
        reddit_sentiment  = None,
        reddit_post_count = 0,
        sources_used      = [],
        confidence        = "low",
    )
