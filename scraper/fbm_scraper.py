"""
FBM Scraper — Facebook Marketplace listing scraper using Playwright.

WHY Playwright over requests/BeautifulSoup:
  FBM is a React SPA — all content loads dynamically via JS.
  A headless browser is the only reliable way to get rendered content.

THREE MODES (no FB login required for any of them):
  1. URL MODE    — paste a FBM listing URL, scraper extracts data automatically
  2. TEXT MODE   — paste raw listing text manually (most reliable, zero bot risk)
  3. BATCH MODE  — feed a list of URLs from a file, scrape all of them

HOW TO USE:
  python scraper/fbm_scraper.py --mode url   --input "https://www.facebook.com/marketplace/item/..."
  python scraper/fbm_scraper.py --mode text
  python scraper/fbm_scraper.py --mode batch --input data/urls.txt

⚠️ BOT DETECTION RISKS are marked with [BOT RISK]
"""

import asyncio
import json
import os
import random
import argparse
import logging
import sys
from pathlib import Path
from dataclasses import dataclass, asdict
from typing import Optional

from playwright.async_api import async_playwright, Page
from dotenv import load_dotenv

load_dotenv()

logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO"),
    format="%(asctime)s [%(levelname)s] %(message)s"
)
log = logging.getLogger(__name__)

# ── Config ───────────────────────────────────────────────────────────────────

HEADLESS = os.getenv("HEADLESS", "false").lower() == "true"
SLOW_MO  = int(os.getenv("SLOW_MO", "50"))

DATA_DIR = Path(__file__).parent.parent / "data"
DATA_DIR.mkdir(exist_ok=True)


# ── Data Model ───────────────────────────────────────────────────────────────

@dataclass
class Listing:
    title: str
    price: float
    raw_price_text: str      # Keep original — "$1,200 OBO" is useful context for AI scoring
    description: str
    location: str
    image_urls: list[str]
    listing_url: str
    seller_name: str
    condition: str           # "Used - Like New", "Good", "Fair" etc — fed to AI scorer
    source: str              # "fbm_url", "fbm_text", "fbm_batch" — useful for debugging


# ── Browser Setup ─────────────────────────────────────────────────────────────

async def create_browser(playwright):
    """
    Launch a browser that looks as human as possible.
    [BOT RISK] Even with these overrides, headless Chromium is detectable.
    HEADLESS=false in .env is strongly recommended during POC.
    """
    browser = await playwright.chromium.launch(
        headless=HEADLESS,
        slow_mo=SLOW_MO,
        args=[
            "--disable-blink-features=AutomationControlled",  # Removes navigator.webdriver flag
            "--no-sandbox",
            "--disable-dev-shm-usage",
        ]
    )
    context = await browser.new_context(
        viewport={"width": 1366, "height": 768},
        user_agent=(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/124.0.0.0 Safari/537.36"
        ),
        locale="en-US",
        timezone_id="America/New_York",
    )
    return browser, context


# ── Human Behavior Helpers ────────────────────────────────────────────────────

async def human_pause(min_sec: float = 0.8, max_sec: float = 2.5):
    """
    Random pause between actions.
    WHY: Fixed delays are easy to detect. Randomized delays mimic human hesitation.
    """
    await asyncio.sleep(random.uniform(min_sec, max_sec))


# ── MODE 1: URL Scraping ──────────────────────────────────────────────────────

async def scrape_from_url(url: str) -> Optional[Listing]:
    """
    Open a FBM listing URL in a browser and extract listing data.

    [BOT RISK] FBM redirects unauthenticated users to login for some listings.
    If that happens, the scraper will detect it and fall back gracefully.
    The browser opens visibly (HEADLESS=false) so you can see what's happening.
    """
    log.info(f"Scraping URL: {url}")

    async with async_playwright() as p:
        browser, context = await create_browser(p)
        page = await context.new_page()

        try:
            await page.goto(url, wait_until="domcontentloaded", timeout=30000)
            await human_pause(2.0, 4.0)  # Let React fully render

            # Check if we got redirected to login
            if "login" in page.url or "checkpoint" in page.url:
                log.warning("FBM redirected to login — this URL requires authentication")
                log.warning("Switch to TEXT MODE: copy/paste the listing text instead")
                return None

            listing = await extract_from_page(page, url)
            return listing

        except Exception as e:
            log.error(f"Failed to scrape URL: {e}")
            return None

        finally:
            await browser.close()


async def extract_from_page(page: Page, url: str) -> Optional[Listing]:
    """
    Extract all listing fields from a loaded FBM listing page.
    Uses multiple fallback selectors per field — FBM changes their DOM regularly.
    """
    try:
        # ── Title ──
        title = await try_selectors(page, [
            'h1[data-testid="marketplace-pdp-title"]',
            'h1',
            'span[dir="auto"][style*="font-weight"]',
        ]) or "Unknown Title"

        # ── Price ──
        raw_price_text = await try_selectors(page, [
            '[data-testid="marketplace-pdp-price"]',
            'div[aria-label*="price"] span',
            'span:has-text("$")',
        ]) or "$0"
        price = parse_price(raw_price_text)

        # ── Description ──
        description = await try_selectors(page, [
            '[data-testid="marketplace-pdp-description"]',
            'div[style*="word-break"] span',
            'div[aria-label*="description"]',
        ]) or ""

        # ── Location ──
        location = await try_selectors(page, [
            '[data-testid="marketplace-pdp-seller-location"]',
            'span:has-text("Listed in")',
            'div[aria-label*="location"]',
        ]) or "Unknown"

        # ── Seller name ──
        seller_name = await try_selectors(page, [
            'a[href*="/marketplace/seller/"] span',
            'a[href*="/profile.php"] span',
            'a[aria-label*="seller"] span',
        ]) or "Unknown"

        # ── Images ──
        image_urls = []
        img_els = await page.query_selector_all('img[src*="scontent"]')
        for img in img_els[:6]:
            src = await img.get_attribute("src")
            if src:
                image_urls.append(src)

        listing = Listing(
            title=title.strip(),
            price=price,
            raw_price_text=raw_price_text.strip(),
            description=description.strip(),
            location=location.strip(),
            seller_name=seller_name.strip(),
            condition="Unknown",     # URL mode doesn't extract condition yet
            image_urls=image_urls,
            listing_url=url,
            source="fbm_url",
        )

        log.info(f"✅ Extracted: {listing.title} — {listing.raw_price_text}")
        return listing

    except Exception as e:
        log.error(f"Extraction error: {e}")
        return None


async def try_selectors(page: Page, selectors: list[str]) -> Optional[str]:
    """
    Try multiple CSS selectors in order, return text of first match.
    WHY: FBM changes their DOM structure — multiple fallbacks make scraping resilient.
    """
    for selector in selectors:
        try:
            el = await page.query_selector(selector)
            if el:
                text = await el.inner_text()
                if text and text.strip():
                    return text.strip()
        except Exception:
            continue
    return None


# ── MODE 2: Manual Text Input ─────────────────────────────────────────────────

def scrape_from_text() -> Optional[Listing]:
    """
    Accept a paste of raw listing text directly from the user.

    WHY THIS MODE EXISTS:
    If FBM blocks URL scraping, you can still test the full AI scoring pipeline
    by manually copying the listing text. Zero bot risk, 100% reliable.

    HOW TO USE:
    1. Open any FBM listing in your browser
    2. Select and copy the listing title, price, description, location
    3. Run this mode and paste when prompted
    """
    print("\n" + "="*60)
    print("MANUAL TEXT MODE — Paste listing details below")
    print("="*60)
    print("""Open the FBM listing in your browser and find each field:

  TITLE       — the bold item name at the top (e.g. 'MacBook Pro 2021')
  PRICE       — the dollar amount (e.g. '$850' or 'Free')
  DESCRIPTION — the seller's description paragraph
  LOCATION    — the city/area (e.g. 'Poway, CA')
  URL         — copy from your browser address bar
  SELLER      — the seller's name shown on the listing
  CONDITION   — e.g. 'Used - Like New', 'Good', 'Fair'
""")

    try:
        title        = input("Title (bold item name):         ").strip() or "Unknown"
        raw_price    = input("Price (e.g. $450):              ").strip() or "$0"
        description  = input("Description (seller's text):    ").strip() or ""
        location     = input("Location (city, state):         ").strip() or "Unknown"
        listing_url  = input("URL (from browser address bar): ").strip() or ""
        seller_name  = input("Seller name:                    ").strip() or "Unknown"
        condition    = input("Condition (e.g. Used-Like New): ").strip() or "Unknown"

        listing = Listing(
            title=title,
            price=parse_price(raw_price),
            raw_price_text=raw_price,
            description=description,
            location=location,
            seller_name=seller_name,
            condition=condition,
            image_urls=[],           # No images in text mode — vision scoring skipped
            listing_url=listing_url,
            source="fbm_text",
        )

        log.info(f"✅ Listing captured: {listing.title} — {listing.raw_price_text}")
        return listing

    except KeyboardInterrupt:
        log.info("Cancelled by user")
        return None


# ── MODE 3: Batch URL Scraping ────────────────────────────────────────────────

async def scrape_from_batch(filepath: str) -> list[Listing]:
    """
    Read a list of FBM URLs from a text file and scrape each one.
    One URL per line in the file.

    WHY: Lets you queue up listings to score overnight without manual effort.
    [BOT RISK] Add delays between requests — rapid sequential scraping is detectable.
    """
    url_file = Path(filepath)
    if not url_file.exists():
        log.error(f"URL file not found: {filepath}")
        return []

    urls = [line.strip() for line in url_file.read_text().splitlines() if line.strip()]
    log.info(f"Batch mode: {len(urls)} URLs to scrape")

    listings = []
    for i, url in enumerate(urls, 1):
        log.info(f"Scraping {i}/{len(urls)}: {url}")
        listing = await scrape_from_url(url)
        if listing:
            listings.append(listing)

        # [BOT RISK] Pause between requests — don't hammer FBM
        if i < len(urls):
            delay = random.uniform(5.0, 12.0)
            log.info(f"Waiting {delay:.1f}s before next request...")
            await asyncio.sleep(delay)

    return listings


# ── Utilities ─────────────────────────────────────────────────────────────────

def parse_price(text: str) -> float:
    """
    Parse messy price strings into a float.
    Handles: '$1,200', '$45 OBO', 'Free', '$1.2k'
    Returns 0.0 if unparseable — caller should handle the zero case.
    """
    if not text:
        return 0.0
    try:
        # Handle 'Free' listings
        if "free" in text.lower():
            return 0.0
        # Strip everything except digits, dots, commas
        cleaned = ""
        for char in text:
            if char.isdigit() or char in ".,":
                cleaned += char
        cleaned = cleaned.replace(",", "").split(".")[0]
        return float(cleaned) if cleaned else 0.0
    except (ValueError, IndexError):
        return 0.0


def save_listing(listing: Listing) -> Path:
    """Save a single listing to JSON. Returns the file path."""
    safe_title = "".join(c for c in listing.title if c.isalnum() or c in " _-")[:40]
    filename = DATA_DIR / f"listing_{safe_title.strip().replace(' ', '_')}.json"
    filename.write_text(json.dumps(asdict(listing), indent=2))
    log.info(f"Saved to: {filename}")
    return filename


def save_listings(listings: list[Listing], label: str = "batch") -> Path:
    """Save multiple listings to a single JSON file."""
    filename = DATA_DIR / f"listings_{label}.json"
    filename.write_text(json.dumps([asdict(l) for l in listings], indent=2))
    log.info(f"Saved {len(listings)} listings to: {filename}")
    return filename


def print_listing_summary(listing: Listing):
    """Print a clean summary of a scraped listing to the console."""
    print("\n" + "="*60)
    print(f"  Title:       {listing.title}")
    print(f"  Price:       {listing.raw_price_text} (parsed: ${listing.price:.2f})")
    print(f"  Condition:   {listing.condition}")
    print(f"  Location:    {listing.location}")
    print(f"  Seller:      {listing.seller_name}")
    print(f"  Images:      {len(listing.image_urls)} found")
    print(f"  Description: {listing.description[:100]}{'...' if len(listing.description) > 100 else ''}")
    print(f"  URL:         {listing.listing_url}")
    print("="*60)


# ── CLI Entry Point ───────────────────────────────────────────────────────────

def parse_args():
    parser = argparse.ArgumentParser(
        description="FBM Listing Scraper — no login required",
        formatter_class=argparse.RawTextHelpFormatter,
        epilog="""
Examples:
  URL mode:    python scraper/fbm_scraper.py --mode url --input "https://www.facebook.com/marketplace/item/123"
  Text mode:   python scraper/fbm_scraper.py --mode text
  Batch mode:  python scraper/fbm_scraper.py --mode batch --input data/urls.txt
        """
    )
    parser.add_argument(
        "--mode",
        choices=["url", "text", "batch"],
        default="text",         # Default to text mode — safest for POC
        help="url: scrape a single URL | text: manual paste | batch: file of URLs"
    )
    parser.add_argument(
        "--input",
        type=str,
        help="URL (for url mode) or filepath (for batch mode)"
    )
    return parser.parse_args()


async def main():
    args = parse_args()

    if args.mode == "url":
        if not args.input:
            log.error("URL mode requires --input with a FBM listing URL")
            sys.exit(1)
        listing = await scrape_from_url(args.input)
        if listing:
            print_listing_summary(listing)
            save_listing(listing)
        else:
            log.error("Scraping failed — try text mode instead: --mode text")

    elif args.mode == "text":
        listing = scrape_from_text()
        if listing:
            print_listing_summary(listing)
            save_listing(listing)

    elif args.mode == "batch":
        if not args.input:
            log.error("Batch mode requires --input with a path to a URL file")
            sys.exit(1)
        listings = await scrape_from_batch(args.input)
        if listings:
            save_listings(listings)
            log.info(f"\n✅ Batch complete — {len(listings)} listings scraped")
            for l in listings:
                print_listing_summary(l)
        else:
            log.warning("No listings scraped from batch")


if __name__ == "__main__":
    asyncio.run(main())
