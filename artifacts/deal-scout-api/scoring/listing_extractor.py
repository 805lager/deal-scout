"""
Listing Extractor — Claude Haiku field extraction from raw page text.

WHY THIS EXISTS:
  Each platform (FBM, Craigslist, eBay, OfferUp) renders listing data
  differently — different DOM selectors, class names, aria-labels, and
  text formats. Maintaining platform-specific regex and DOM selectors
  in every content script is brittle and constantly breaks when platforms
  update their UI.

  Instead: content scripts send raw page text to Claude Haiku, which
  naturally extracts all relevant fields regardless of platform layout.
  This single function replaces hundreds of lines of fragile selectors
  across four content scripts.

  Benefits:
    - Handles "$145 · In stock", "$145$200" dual-price, "Make offer" — all naturally
    - Seller rating extraction: reads "4.8 (126 ratings)" or "Highly Rated" in context
    - Photo count from "1/5" carousel text or "5 photos" mentions
    - No regex brittleness — Claude understands natural language
    - All platforms share the same extraction logic

WHY HAIKU (not Sonnet):
  Extraction is a structured JSON-output task with a short prompt and short output.
  Haiku costs ~$0.0002/call and returns in ~0.5-1s. It runs at the start of the
  streaming pipeline so users see their listing data immediately.
"""

import json
import logging
import os
from typing import Optional

import anthropic

log = logging.getLogger(__name__)

_extract_client: Optional[anthropic.Anthropic] = None


def _get_client() -> anthropic.Anthropic:
    global _extract_client
    if _extract_client is None:
        _extract_client = anthropic.Anthropic(
            api_key=os.getenv("AI_INTEGRATIONS_ANTHROPIC_API_KEY", "placeholder"),
            base_url=os.getenv("AI_INTEGRATIONS_ANTHROPIC_BASE_URL"),
        )
    return _extract_client


_EXTRACT_PROMPT = """\
You are parsing a product listing from a second-hand marketplace webpage.

Platform: {platform}
Listing URL: {url}

Raw page text (may contain navigation menus and sidebar noise — focus on the listing content):
<text>
{raw_text}
</text>

Extract the listing fields below. Respond ONLY with valid JSON — no markdown fences, no commentary.
{{
  "title": "exact product name/model as listed, max 120 chars",
  "price": null,
  "description": "seller's own description text only, max 600 chars, exclude navigation/UI/unrelated text",
  "condition": "New|Like New|Good|Fair|Used|Unknown",
  "location": "city, state or region if visible on page",
  "seller_name": "display name of the seller if visible, else empty string",
  "is_vehicle": false,
  "photo_count": 0,
  "original_price": 0.0,
  "shipping_cost": 0.0,
  "is_multi_item": false,
  "seller_joined": "year or month+year the seller joined, e.g. '2019' or 'March 2019', else null",
  "seller_rating": null,
  "seller_rating_count": 0
}}

Rules:
- price: number only in US dollars (e.g. 145.0). Use 0.0 if the item is FREE or "make offer".
  Use null ONLY if there is absolutely no price information anywhere on the page.
  Handles formats: "$145", "$145 · In stock", "$145$200" (dual-price — use the lower).
- photo_count: look for "1/5", "3/8", "3 photos", "5 pictures" etc. 0 if unclear.
- is_vehicle: true ONLY for road-registered/titled vehicles: cars, trucks, gas motorcycles (Harley/Honda/Yamaha/etc.), boats, RVs, ATVs, trailers.
  is_vehicle MUST be FALSE for: e-bikes, electric bicycles, e-trikes, electric tricycles, e-scooters, electric scooters, Surron / Talaria / electric dirt bikes, hoverboards, OneWheel, electric mopeds. These items have eBay/Google comps and are NOT vehicles for pricing purposes.
- is_multi_item: true if the listing sells a bundle, lot, or set of multiple items together.
- original_price: the crossed-out or "was" price if seller reduced it, else 0.0.
- shipping_cost: 0.0 for free shipping or local pickup. 0.0 if not mentioned.
- condition: default to "Used" if seller does not state it.
- seller_rating: float like 4.8 if visible, else null.
- seller_rating_count: integer count of ratings/reviews if visible, else 0.
- seller_joined: when the seller joined the platform if shown, else null.
"""


def _validate_extracted_price(data: dict, raw_text: str) -> dict:
    """
    Validate that Claude's extracted price actually appears in the raw text.
    If the extracted price doesn't match any price in the text, attempt to
    find the correct price from the raw text.
    """
    import re as _re
    extracted_price = data.get("price")
    if extracted_price is None or extracted_price == 0:
        return data

    extracted_price = float(extracted_price)

    price_pattern = r'\$\s*([\d,]+(?:\.\d{2})?)'
    found_prices = []
    for match in _re.finditer(price_pattern, raw_text):
        try:
            p = float(match.group(1).replace(",", ""))
            if p > 0:
                found_prices.append(p)
        except ValueError:
            continue

    if not found_prices:
        return data

    if extracted_price in found_prices:
        return data

    close_match = None
    for p in found_prices:
        if abs(p - extracted_price) / max(extracted_price, 1) < 0.01:
            close_match = p
            break

    if close_match:
        return data

    if len(found_prices) == 1:
        corrected = found_prices[0]
        if abs(corrected - extracted_price) / max(extracted_price, 1) > 0.5:
            log.warning(
                f"[Extract] Price mismatch: Claude extracted ${extracted_price:.0f} "
                f"but raw text only has ${corrected:.0f} — correcting"
            )
            data["price"] = corrected
            return data

    lowest_reasonable = min(found_prices)
    if extracted_price < lowest_reasonable * 0.1 or extracted_price > max(found_prices) * 10:
        log.warning(
            f"[Extract] Price ${extracted_price:.0f} is far outside text prices "
            f"(${lowest_reasonable:.0f}-${max(found_prices):.0f}) — using lowest"
        )
        data["price"] = lowest_reasonable

    return data


async def extract_listing_from_text(
    raw_text: str,
    platform: str = "facebook_marketplace",
    url: str = "",
) -> dict:
    """
    Use Claude Haiku to extract structured listing fields from raw page text.

    Returns a dict compatible with ListingRequest fields.
    On any error, returns a minimal fallback dict (title="", price=0.0).
    The caller is responsible for checking whether title/price are usable.
    """
    truncated = raw_text.strip()[:3500]
    prompt = _EXTRACT_PROMPT.format(
        platform=platform,
        url=url,
        raw_text=truncated,
    )

    import asyncio as _aio
    last_err = None
    for _attempt in range(3):
        try:
            client = _get_client()
            msg = client.messages.create(
                model="claude-haiku-4-5",
                max_tokens=600,
                messages=[{"role": "user", "content": prompt}],
            )
            try:
                from scoring import claude_usage
                claude_usage.record(msg, label="ListingExtractor")
            except Exception:
                pass
            text = msg.content[0].text.strip()

            if text.startswith("```"):
                lines = text.split("\n")
                lines = lines[1:]
                if lines and lines[-1].strip() == "```":
                    lines = lines[:-1]
                text = "\n".join(lines).strip()

            data = json.loads(text)

            data = _validate_extracted_price(data, raw_text)

            log.info(
                f"[Extract] '{data.get('title', '?')}' @ ${(data.get('price') or 0):.0f} "
                f"({platform})"
            )
            return data

        except anthropic.AuthenticationError as e:
            last_err = e
            log.warning(f"[Extract] Auth error (attempt {_attempt+1}/3) — retrying in 1s")
            await _aio.sleep(1)
        except Exception as e:
            last_err = e
            break

    if last_err:
        log.warning(f"[Extract] Haiku extraction failed: {last_err!r} — returning empty dict")
        return {
            "title": "",
            "price": 0.0,
            "description": "",
            "condition": "Unknown",
            "location": "",
            "seller_name": "",
            "is_vehicle": False,
            "photo_count": 0,
            "original_price": 0.0,
            "shipping_cost": 0.0,
            "is_multi_item": False,
            "seller_joined": None,
            "seller_rating": None,
            "seller_rating_count": 0,
        }
