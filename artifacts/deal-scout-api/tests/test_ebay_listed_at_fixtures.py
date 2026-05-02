"""
Cross-template fixture test for eBay listing-date detection (Task #65).

eBay renders the "Listed on …" date in several template variants depending
on category (motors, electronics, fashion, …). The extension's content
script (`extension/content/ebay.js`) extracts the raw string with a regex
against `document.body.innerText`, and the server's leverage module
(`scoring/leverage.py::_parse_listed_at_to_days`) parses it into a day
count. A template change on eBay's side could silently break either
half — and the time-on-market signal feeds the negotiation-leverage
recommendation, so a silent break would mis-advise buyers.

To guard against that we keep a small set of saved page fixtures (one per
category / template variant), run the same extraction regex the extension
uses against each fixture's text, and assert:

  1. The raw `listed_at` string is present.
  2. The server-side parser returns a non-None, non-negative day count.
  3. Relative ("N days ago") fixtures parse to exactly the expected count.
  4. Absolute-date fixtures parse to a count that lines up with the
     fixture's listed date (within a generous tolerance — the assertion
     is "sensible day count", not "exact day count", because we don't
     want this test going red purely because the calendar advanced).

The regex below is intentionally a literal port of the JS regex in
ebay.js so the two stay in lock-step. If you change one, change the
other and re-run this test.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from scoring.leverage import _parse_listed_at_to_days

FIXTURE_DIR = Path(__file__).resolve().parent / "fixtures" / "ebay"

# Literal port of extension/content/ebay.js extractRaw() listedAtRaw block.
_REL_RE = re.compile(
    r"listed\s+(\d+\s*(?:hour|day|week|month|year)s?\s+ago)",
    re.IGNORECASE,
)
_ON_RE = re.compile(
    r"listed\s+on\s+(?:[A-Za-z]{3,9},?\s+)?([A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4})",
    re.IGNORECASE,
)


def _innertext(html: str) -> str:
    """
    Approximation of `document.body.innerText` good enough for our
    fixtures: strip tags, comments, and collapse whitespace. We're not
    trying to be a full HTML renderer — eBay's listed-on text is plain
    text inside a span, so tag-stripping is sufficient for the regex
    to match exactly as it would in the browser.
    """
    no_comments = re.sub(r"<!--.*?-->", " ", html, flags=re.DOTALL)
    no_tags     = re.sub(r"<[^>]+>", " ", no_comments)
    return re.sub(r"\s+", " ", no_tags).strip()


def _extract_listed_at(html: str) -> str | None:
    """Mirror of the JS extractor — returns the raw listed_at string or None."""
    txt = _innertext(html)
    rel = _REL_RE.search(txt)
    if rel:
        return "Listed " + rel.group(1)
    on_match = _ON_RE.search(txt)
    if on_match:
        return on_match.group(1)
    return None


def _load(name: str) -> str:
    return (FIXTURE_DIR / name).read_text(encoding="utf-8")


# Each entry: (fixture filename, expected_min_days, expected_max_days,
#              human description). Bounds are wide enough that calendar
#              drift won't flake the test, but tight enough to catch a
#              parser regression that returns 0 / None / nonsense.
FIXTURES = [
    # "Listed on Mon, Apr 1, 2024" — weekday-prefixed absolute date.
    # Today is May 2, 2026 in the task brief; fixture is ~2 years old.
    # Anything in [600, 5000] confirms parsing landed in the right ballpark
    # without being sensitive to the calendar advancing.
    ("motors_weekday_prefixed.html", 600,  5000, "motors / weekday-prefixed date"),
    # "Listed on Apr 15, 2025" — month-first absolute date.
    ("electronics_month_first.html", 200,  5000, "electronics / month-first date"),
    # "Listed 3 days ago" — relative form. Parser must return exactly 3.
    ("fashion_relative.html",          3,     3, "fashion / relative time"),
]


def _check_listed_at_extracts_and_parses(fname, min_days, max_days, desc):
    html = _load(fname)
    raw  = _extract_listed_at(html)
    assert raw, f"{desc}: extension regex failed to extract listed_at from fixture"

    days = _parse_listed_at_to_days(raw)
    assert days is not None, (
        f"{desc}: server parser returned None for raw={raw!r}"
    )
    assert days >= 0, f"{desc}: parser returned negative days ({days}) for raw={raw!r}"
    assert min_days <= days <= max_days, (
        f"{desc}: parsed days={days} outside expected sensible range "
        f"[{min_days}, {max_days}] for raw={raw!r}"
    )


def test_motors_weekday_prefixed_listed_at():
    _check_listed_at_extracts_and_parses(*FIXTURES[0])


def test_electronics_month_first_listed_at():
    _check_listed_at_extracts_and_parses(*FIXTURES[1])


def test_fashion_relative_listed_at():
    _check_listed_at_extracts_and_parses(*FIXTURES[2])


def test_all_three_categories_present():
    """Done-looks-like requires >=3 categories. Guard against silent removal."""
    files = sorted(p.name for p in FIXTURE_DIR.glob("*.html"))
    assert len(files) >= 3, f"Expected >=3 eBay fixtures, found {len(files)}: {files}"


def test_extractor_returns_none_when_no_listed_text():
    """Negative case — extractor must not hallucinate a date from unrelated text."""
    html = "<html><body><p>No listing-date text here at all.</p></body></html>"
    assert _extract_listed_at(html) is None


if __name__ == "__main__":
    for fname, lo, hi, desc in FIXTURES:
        _check_listed_at_extracts_and_parses(fname, lo, hi, desc)
    test_all_three_categories_present()
    test_extractor_returns_none_when_no_listed_text()
    print("All eBay listed_at fixture tests passed.")
