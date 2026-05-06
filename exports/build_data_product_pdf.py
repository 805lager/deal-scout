from reportlab.lib.pagesizes import LETTER
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import inch
from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, PageBreak, ListFlowable, ListItem
)

OUT = "exports/deal-scout-data-product-summary.pdf"

styles = getSampleStyleSheet()
NAVY = colors.HexColor("#0f2a44")
ACCENT = colors.HexColor("#1f7a8c")
MUTED = colors.HexColor("#5b6b7a")
LINE = colors.HexColor("#d6dde4")

styles.add(ParagraphStyle(name="DocTitle", parent=styles["Title"],
    fontName="Helvetica-Bold", fontSize=22, leading=26, textColor=NAVY, spaceAfter=4))
styles.add(ParagraphStyle(name="DocSub", parent=styles["Normal"],
    fontName="Helvetica", fontSize=11, leading=14, textColor=MUTED, spaceAfter=18))
styles.add(ParagraphStyle(name="H1", parent=styles["Heading1"],
    fontName="Helvetica-Bold", fontSize=14, leading=18, textColor=NAVY,
    spaceBefore=14, spaceAfter=6))
styles.add(ParagraphStyle(name="DSBody", parent=styles["Normal"],
    fontName="Helvetica", fontSize=10.5, leading=15, textColor=colors.black,
    spaceAfter=8, alignment=TA_LEFT))
styles.add(ParagraphStyle(name="DSBullet", parent=styles["Normal"],
    fontName="Helvetica", fontSize=10.5, leading=15, textColor=colors.black))
styles.add(ParagraphStyle(name="Callout", parent=styles["Normal"],
    fontName="Helvetica-Bold", fontSize=11, leading=15, textColor=NAVY,
    backColor=colors.HexColor("#eef4f7"), borderPadding=10, spaceAfter=12))
styles.add(ParagraphStyle(name="Foot", parent=styles["Normal"],
    fontName="Helvetica-Oblique", fontSize=8.5, leading=11, textColor=MUTED))

def P(text, style="DSBody"):
    return Paragraph(text, styles[style])

def bullets(items):
    return ListFlowable(
        [ListItem(P(t, "DSBullet"), leftIndent=10, value="square") for t in items],
        bulletType="bullet", leftIndent=14, bulletColor=ACCENT, bulletFontSize=8,
    )

doc = SimpleDocTemplate(
    OUT, pagesize=LETTER,
    leftMargin=0.85*inch, rightMargin=0.85*inch,
    topMargin=0.8*inch, bottomMargin=0.8*inch,
    title="Deal Scout — Market Intelligence Data Product",
    author="Deal Scout",
)

story = []

story.append(P("Deal Scout — Market Intelligence Data Product", "DocTitle"))
story.append(P("Executive Summary  ·  Anonymized secondhand-goods pricing dataset", "DocSub"))

story.append(P(
    "<b>Yes — collection is live and accumulating today.</b> Every time a Deal Scout "
    "user scores a marketplace listing, an anonymized signal is written to a Postgres "
    "table that is purpose-built to be packaged and sold as a B2B data product.",
    "Callout"))

story.append(P("What we collect (per scored listing)", "H1"))
story.append(P(
    "Each row in the <b>market_signals</b> table captures a single, fully anonymized "
    "snapshot of a real-world transaction attempt:", "DSBody"))
story.append(bullets([
    "<b>Item</b> — category (electronics, appliances, vehicles, etc.) and a generic label such as “Nikon Z8” or “Samsung washer/dryer”",
    "<b>Condition</b> — new, used, or for-parts, as classified by our scoring model",
    "<b>City</b> — the listing’s city only (no street, ZIP, neighborhood, or seller geography)",
    "<b>Pricing snapshot</b> — asking price, eBay sold-comps average, Google Shopping average, retail / MSRP, and the spreads between them",
    "<b>Deal score</b> — the 1–10 verdict and confidence bucket assigned by Deal Scout",
    "<b>Affiliate context</b> — which programs (eBay, Amazon, Impact, etc.) were surfaced for that item",
]))

story.append(P("What we deliberately do NOT collect", "H1"))
story.append(P(
    "The pipeline enforces a hard architectural rule that no personally identifiable "
    "information ever reaches the dataset. There is a code-level audit checklist that "
    "rejects any change which would leak PII into telemetry.", "DSBody"))
story.append(bullets([
    "No user IDs, install IDs, or device fingerprints",
    "No listing URLs or marketplace listing IDs",
    "No seller names, seller history, or seller ratings",
    "No buyer messages, photos, or extension session data",
    "No street-level location — city is the maximum granularity",
]))

story.append(P("Why this dataset is commercially valuable", "H1"))
story.append(P(
    "Deal Scout is effectively building a real-time <b>secondhand-goods price index</b> — "
    "the kind of dataset that does not exist publicly today because eBay, Facebook "
    "Marketplace, OfferUp, and Craigslist do not publish unified pricing data. Each row "
    "tells a buyer: <i>this item, in this condition, in this city, was being asked for "
    "$X, against a true market value of $Y, and earned a deal score of Z.</i>", "DSBody"))

story.append(P("Distribution channels (pre-built into the architecture)", "H1"))

table_data = [
    [P("<b>Channel</b>", "DSBullet"), P("<b>Who buys</b>", "DSBullet"), P("<b>Typical use case</b>", "DSBullet")],
    [P("AWS Data Exchange", "DSBullet"),
     P("Hedge funds, retail analytics firms, consumer-trend desks", "DSBullet"),
     P("Quant signals on used-goods inflation; regional demand shifts", "DSBullet")],
    [P("Snowflake Marketplace", "DSBullet"),
     P("Large retailers (Best Buy, Home Depot, Lowe’s); OEMs (Samsung, LG, Dell)", "DSBullet"),
     P("Competitive secondhand-pricing intel; trade-in program calibration", "DSBullet")],
    [P("Direct API<br/>(<b>/v1/market-data</b>)", "DSBullet"),
     P("Insurance carriers, appraisal firms, recommerce platforms (Back Market, Gazelle, ItsWorthMore)", "DSBullet"),
     P("Real-time fair-market-value lookups for claims, trade-ins, buyback offers", "DSBullet")],
]
tbl = Table(table_data, colWidths=[1.4*inch, 2.5*inch, 2.7*inch], hAlign="LEFT")
tbl.setStyle(TableStyle([
    ("BACKGROUND", (0,0), (-1,0), NAVY),
    ("TEXTCOLOR", (0,0), (-1,0), colors.white),
    ("LINEBELOW", (0,0), (-1,0), 0.5, NAVY),
    ("ROWBACKGROUNDS", (0,1), (-1,-1), [colors.white, colors.HexColor("#f4f7f9")]),
    ("VALIGN", (0,0), (-1,-1), "TOP"),
    ("LEFTPADDING", (0,0), (-1,-1), 8),
    ("RIGHTPADDING", (0,0), (-1,-1), 8),
    ("TOPPADDING", (0,0), (-1,-1), 7),
    ("BOTTOMPADDING", (0,0), (-1,-1), 7),
    ("BOX", (0,0), (-1,-1), 0.4, LINE),
    ("INNERGRID", (0,0), (-1,-1), 0.25, LINE),
]))
story.append(tbl)
story.append(Spacer(1, 10))

story.append(P("Likely individual buyer profiles", "H1"))
story.append(bullets([
    "<b>Insurance adjusters</b> — settle claims at fair secondhand value rather than MSRP",
    "<b>Recommerce / trade-in companies</b> — set buyback prices that beat competitors",
    "<b>Retail analysts</b> — track when consumers flood the resale market with a category (an early recession signal)",
    "<b>Consumer-trend research firms</b> (Nielsen, Circana, NPD-style) — fill the secondhand-market blind spot in their reports",
]))

story.append(P("Current status", "H1"))
story.append(bullets([
    "<font color='#1f7a8c'><b>Live</b></font> — collection pipeline is writing to <b>market_signals</b> on every score",
    "<font color='#1f7a8c'><b>Live</b></font> — <b>/v1/market-data</b> endpoint serves anonymized aggregates",
    "<font color='#1f7a8c'><b>Live</b></font> — PII firewall is enforced architecturally and audited per change",
    "<font color='#5b6b7a'><b>Gated</b></font> — buyer access requires a per-customer <b>MARKET_DATA_API_KEY</b>",
    "<font color='#5b6b7a'><b>Pending</b></font> — not yet listed on AWS Data Exchange or Snowflake Marketplace (sales motion, not engineering)",
    "<font color='#5b6b7a'><b>Pending</b></font> — most data buyers want 30–60 days of consistent volume before purchase",
]))

story.append(P("Recommended next steps", "H1"))
story.append(bullets([
    "Pick the first marketplace to list on — <b>Snowflake Marketplace</b> is the easiest path to B2B retail and insurance buyers",
    "Draft the data dictionary and a sample dataset to share with prospective buyers",
    "Continue growing extension installs to build the dataset to commercially interesting volume",
    "Begin outreach to insurance and recommerce prospects once 30–60 days of consistent volume is in hand",
]))

story.append(Spacer(1, 18))
story.append(P(
    "Prepared from the Deal Scout architecture documentation. Distribution: shareable. "
    "Contains no proprietary code or customer data.", "Foot"))

doc.build(story)
print(f"Wrote {OUT}")
