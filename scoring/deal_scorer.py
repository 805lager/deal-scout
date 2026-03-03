"""
Claude Deal Scoring Engine — Week 3

WHY THIS IS THE CORE VALUE PROPOSITION:
  Anyone can compare a price to eBay averages. What makes this product
  valuable is the AI layer that reasons about the WHOLE picture:
    - Is the condition claim believable given the description?
    - Are the accessories included worth extra?
    - Is the dent mentioned a real concern or irrelevant?
    - Is $500 actually bad given current market conditions?
    - What should the buyer do — offer, pass, or jump on it?

  That nuanced reasoning is what users will pay for.

WHAT THIS MODULE DOES:
  1. Loads a listing + its market value data from /data
  2. Sends both to Claude with a structured scoring prompt
  3. Parses Claude's response into a clean DealScore object
  4. Saves the result and prints a final report

DEAL SCORE SCALE (1-10):
  9-10  Exceptional deal — act immediately
  7-8   Good deal — worth buying at asking price
  5-6   Fair — priced at market, negotiate if possible
  3-4   Overpriced — only buy with significant discount
  1-2   Bad deal — avoid or lowball heavily

RUN STANDALONE:
  python scoring/deal_scorer.py
  (uses most recent listing + market value files from /data)
"""

import asyncio
import json
import logging
import os
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Optional

import anthropic
from dotenv import load_dotenv

load_dotenv()

logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO"),
    format="%(asctime)s [%(levelname)s] %(message)s"
)
log = logging.getLogger(__name__)

DATA_DIR = Path(__file__).parent.parent / "data"

# Initialize the Anthropic client once at module level
# WHY: Creating a new client per request is wasteful — reuse the connection
client = anthropic.Anthropic(api_key=os.getenv("ANTHROPIC_API_KEY"))


# ── Data Model ────────────────────────────────────────────────────────────────

@dataclass
class DealScore:
    """
    Complete AI-generated deal analysis.
    This is the final output of the entire POC pipeline.
    Every field here maps directly to something shown in the Week 4 UI.
    """
    score:              int     # 1-10 deal score
    verdict:            str     # One-line verdict: "Good Deal", "Overpriced", etc.
    summary:            str     # 2-3 sentence plain English explanation
    value_assessment:   str     # What Claude thinks the item is actually worth
    condition_notes:    str     # Claude's read on the condition claim
    red_flags:          list    # List of concerns (empty if none)
    green_flags:        list    # List of positive signals
    recommended_offer:  float   # What price Claude recommends offering
    should_buy:         bool    # Simple yes/no recommendation
    confidence:         str     # "high" / "medium" / "low"
    model_used:         str     # Which Claude model scored this


# ── Prompt Builder ────────────────────────────────────────────────────────────

def build_scoring_prompt(listing: dict, market_value: dict) -> str:
    """
    Build the prompt that Claude uses to score the deal.

    WHY STRUCTURED OUTPUT (JSON):
    The Week 4 UI needs to parse Claude's response programmatically.
    Asking Claude to respond in strict JSON lets us map its reasoning
    directly to UI components without fragile text parsing.

    WHY WE INCLUDE BOTH LISTING AND MARKET DATA:
    Claude needs both to reason well. Market data alone misses
    listing-specific signals (condition, extras, red flags).
    Listing data alone has no price anchor.

    WHY MULTI-ITEM HANDLING:
    A "Ryobi 6-tool set for $290" should NOT be compared against
    single Ryobi tool eBay comps (~$80 each). Without this flag,
    Claude would wrongly call a $290 bundle overpriced.
    When is_multi_item=True we tell Claude to reason about
    aggregate value — what would each item cost individually.
    """
    is_multi = listing.get('is_multi_item', False)

    # Build a context-specific instruction block for multi-item listings
    multi_item_instruction = ""
    if is_multi:
        multi_item_instruction = """
## IMPORTANT: MULTI-ITEM / BUNDLE LISTING
This listing contains multiple items, a set, lot, kit, or bundle.
The eBay market data below reflects SINGLE-ITEM prices, not bundle prices.

Adjust your analysis accordingly:
- Estimate what each included item would cost individually on eBay
- Sum those individual values to get total bundle market value
- Compare the asking price against that aggregate value, NOT single-item comps
- Note which items in the bundle drive most of the value
- Flag if key items (like batteries, chargers, or cases) appear missing
"""

    return f"""You are an expert deal evaluator for a personal shopping assistant.
Your job is to analyze a second-hand marketplace listing and produce a structured deal score.
{multi_item_instruction}
## LISTING DETAILS
Title:        {listing['title']}
Price:        {listing['raw_price_text']}
Condition:    {listing.get('condition', 'Not specified')}
Location:     {listing.get('location', 'Unknown')}
Seller:       {listing.get('seller_name', 'Unknown')}
Bundle/Set:   {'Yes — see multi-item instructions above' if is_multi else 'No — single item'}
Description:  {listing.get('description', 'No description provided')}

## MARKET VALUE DATA (from eBay — single-item comps)
eBay sold avg:       ${market_value['sold_avg']:.2f}  ({market_value['sold_count']} completed sales)
eBay sold range:     ${market_value['sold_low']:.2f} - ${market_value['sold_high']:.2f}
eBay active avg:     ${market_value['active_avg']:.2f}  ({market_value['active_count']} active listings)
eBay lowest active:  ${market_value['active_low']:.2f}
New retail price:    ${market_value['new_price']:.2f}
Estimated value:     ${market_value['estimated_value']:.2f}
Data confidence:     {market_value['confidence']}

## YOUR TASK
Analyze this listing holistically. Consider:
- How does the asking price compare to real sold comps (adjusted for bundles if applicable)?
- Does the condition description match the claimed condition?
- Are there red flags (vague description, suspicious claims, missing accessories)?
- Are there positive signals (extras included, detailed description, honest disclosure)?
- What is a reasonable offer price if the buyer wants to negotiate?
- Would YOU recommend buying this at the listed price?

## RESPONSE FORMAT
Respond ONLY with a valid JSON object. No preamble, no explanation, no markdown fences.
Use exactly this structure:

{{
  "score": <integer 1-10>,
  "verdict": "<10 words or less — e.g. 'Good bundle deal, 30% below aggregate value'>",
  "summary": "<2-3 sentences explaining the score in plain English>",
  "value_assessment": "<1-2 sentences on what this item or bundle is actually worth>",
  "condition_notes": "<1-2 sentences on your read of the condition claim>",
  "red_flags": ["<flag 1>", "<flag 2>"],
  "green_flags": ["<flag 1>", "<flag 2>"],
  "recommended_offer": <float — the price you'd recommend offering>,
  "should_buy": <true or false>,
  "confidence": "<high|medium|low>"
}}

If red_flags or green_flags are empty, use an empty array [].
recommended_offer should be realistic — not insultingly low, not full ask if overpriced.
"""


# ── Claude API Call ───────────────────────────────────────────────────────────

async def score_deal(listing: dict, market_value: dict) -> Optional[DealScore]:
    """
    Send listing + market data to Claude and parse the deal score response.

    WHY claude-3-5-haiku:
      Fast and cheap — ideal for POC. Scoring a listing should feel instant.
      We can upgrade to Sonnet for production if we need deeper reasoning.
      Haiku handles structured JSON output reliably at this complexity level.
    """
    if not os.getenv("ANTHROPIC_API_KEY"):
        log.error("ANTHROPIC_API_KEY not set in .env")
        log.error("Get your key at: https://console.anthropic.com")
        return None

    prompt = build_scoring_prompt(listing, market_value)
    log.info("Sending listing to Claude for deal scoring...")

    try:
        # WHY we run this in an executor:
        # The anthropic client is synchronous. We wrap it in asyncio
        # so it doesn't block the event loop when we wire this into FastAPI.
        loop = asyncio.get_event_loop()
        response = await loop.run_in_executor(
            None,
            lambda: client.messages.create(
                model="claude-haiku-4-5-20251001",
                max_tokens=1024,
                messages=[{"role": "user", "content": prompt}]
            )
        )

        raw_text = response.content[0].text.strip()
        log.debug(f"Claude raw response:\n{raw_text}")

        # Strip markdown fences — Claude often wraps JSON in ```json ... ```
        # even when told not to. This is the most common silent failure point.
        clean_text = raw_text
        if "```" in clean_text:
            # Extract content between first { and last }
            import re
            json_match = re.search(r'\{.*\}', clean_text, re.DOTALL)
            if json_match:
                clean_text = json_match.group()
            else:
                log.error(f"Claude returned markdown but no JSON object found:\n{raw_text}")
                return None

        try:
            data = json.loads(clean_text)
        except json.JSONDecodeError as e:
            log.error(f"JSON parse failed: {e}\nRaw text was:\n{raw_text}")
            return None

        return DealScore(
            score             = int(data.get("score", 5)),
            verdict           = data.get("verdict", "No verdict"),
            summary           = data.get("summary", ""),
            value_assessment  = data.get("value_assessment", ""),
            condition_notes   = data.get("condition_notes", ""),
            red_flags         = data.get("red_flags", []),
            green_flags       = data.get("green_flags", []),
            recommended_offer = float(data.get("recommended_offer", 0)),
            should_buy        = bool(data.get("should_buy", False)),
            confidence        = data.get("confidence", "medium"),
            model_used        = response.model,
        )

    except anthropic.AuthenticationError:
        log.error("Invalid Anthropic API key — check your .env file")
        return None
    except anthropic.RateLimitError:
        log.error("Anthropic rate limit hit — wait a moment and retry")
        return None
    except Exception as e:
        log.error(f"Claude API error: {e}")
        return None


# ── Output ────────────────────────────────────────────────────────────────────

def print_deal_score(score: DealScore, listing: dict):
    """Print the full deal analysis report to console."""
    score_bar = "█" * score.score + "░" * (10 - score.score)
    buy_label = "✅ BUY" if score.should_buy else "❌ PASS"

    print("\n" + "="*60)
    print("  AI DEAL SCORE REPORT")
    print("="*60)
    print(f"  Item:      {listing['title']}")
    print(f"  Price:     {listing['raw_price_text']}")
    print()
    print(f"  Score:     {score.score}/10  [{score_bar}]")
    print(f"  Verdict:   {score.verdict}")
    print(f"  Decision:  {buy_label}")
    print()
    print(f"  Summary:")
    # Word-wrap the summary at 55 chars for clean console output
    words = score.summary.split()
    line = "    "
    for word in words:
        if len(line) + len(word) > 57:
            print(line)
            line = "    "
        line += word + " "
    if line.strip():
        print(line)
    print()
    print(f"  Value:     {score.value_assessment}")
    print(f"  Condition: {score.condition_notes}")
    print()
    if score.green_flags:
        print("  ✅ Green flags:")
        for flag in score.green_flags:
            print(f"     • {flag}")
    if score.red_flags:
        print("  ⚠️  Red flags:")
        for flag in score.red_flags:
            print(f"     • {flag}")
    print()
    print(f"  Recommended offer: ${score.recommended_offer:.2f}")
    print(f"  Confidence:        {score.confidence.upper()}")
    print(f"  Scored by:         {score.model_used}")
    print("="*60)


def save_deal_score(score: DealScore, listing_title: str) -> Path:
    """Save the deal score to /data — consumed by the Week 4 React UI."""
    safe  = "".join(c for c in listing_title if c.isalnum() or c in " _-")[:40]
    fpath = DATA_DIR / f"deal_score_{safe.strip().replace(' ', '_')}.json"
    fpath.write_text(json.dumps(asdict(score), indent=2))
    log.info(f"Deal score saved: {fpath}")
    return fpath


# ── Full Pipeline Runner ──────────────────────────────────────────────────────

async def run_full_pipeline(listing_file: Path, market_value_file: Path):
    """
    Run the complete scoring pipeline for a single listing.
    This is the function the FastAPI endpoint will call in Week 4.
    """
    listing      = json.loads(listing_file.read_text())
    market_value = json.loads(market_value_file.read_text())

    print(f"\n  Scoring: {listing['title']}")
    print(f"  Price:   ${listing['price']:.2f}")
    print(f"  eBay est value: ${market_value['estimated_value']:.2f}")
    print(f"\n  Sending to Claude...")

    deal_score = await score_deal(listing, market_value)

    if deal_score:
        print_deal_score(deal_score, listing)
        output = save_deal_score(deal_score, listing["title"])
        print(f"\n  Saved to: {output}")
        print(f"  Ready for Week 4 — React UI")
        return deal_score
    else:
        log.error("Scoring failed — check your ANTHROPIC_API_KEY in .env")
        return None


# ── Standalone Entry Point ────────────────────────────────────────────────────

async def main():
    """
    Test the scorer against the most recent listing + market value in /data.
    Requires ANTHROPIC_API_KEY to be set in .env.
    """
    # Find most recent listing file
    listing_files = list(DATA_DIR.glob("listing_*.json"))
    if not listing_files:
        log.error("No listing files in /data — run the scraper first")
        return

    listing_file = max(listing_files, key=lambda f: f.stat().st_mtime)

    # Find matching market value file
    # Match by looking for market_value_ file with same item name stem
    market_files = list(DATA_DIR.glob("market_value_*.json"))
    if not market_files:
        log.error("No market value files in /data — run ebay_pricer.py first")
        return

    market_file = max(market_files, key=lambda f: f.stat().st_mtime)

    log.info(f"Listing file:      {listing_file.name}")
    log.info(f"Market value file: {market_file.name}")

    await run_full_pipeline(listing_file, market_file)


if __name__ == "__main__":
    asyncio.run(main())
