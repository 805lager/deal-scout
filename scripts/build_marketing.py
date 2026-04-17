"""Build marketing imagery for Deal Scout — CWS assets, hero banner, promo tile, landing screenshots.

Output layout (matches the canonical deliverable structure):
  marketing/cws/promo-tile-440x280.png
  marketing/cws/screenshots/0[1-5]_*.png
  docs/images/hero_banner.png
  docs/images/screenshot_results.png
  docs/images/screenshot_popup.png
"""
import os
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOTS = os.path.join(ROOT, "attached_assets")
CWS_DIR = os.path.join(ROOT, "marketing/cws")
CWS_SHOTS = os.path.join(CWS_DIR, "screenshots")
DOCS_IMG = os.path.join(ROOT, "docs/images")
os.makedirs(CWS_SHOTS, exist_ok=True)
os.makedirs(DOCS_IMG, exist_ok=True)

NAVY = (13, 17, 23)
CARD = (22, 27, 34)
BORDER = (33, 38, 45)
GREEN = (46, 160, 67)
GREEN_BRIGHT = (63, 185, 80)
TEXT = (230, 237, 243)
MUTED = (139, 148, 158)
WHITE = (255, 255, 255)

FONT_PATH = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
FONT_REG = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"

def font(size, bold=True):
    return ImageFont.truetype(FONT_PATH if bold else FONT_REG, size)

def text_w(draw, txt, f):
    b = draw.textbbox((0, 0), txt, font=f)
    return b[2] - b[0], b[3] - b[1]

# Map: (source_filename, headline, label, output_name)
SCREENS = [
    ("Screenshot_2026-04-17_111154_1776449524121.png",
     "Know if it's a fair deal",
     "Scored by AI",
     "01_fbm_watch.png"),
    ("Screenshot_2026-04-17_110548_1776449448291.png",
     "Backed by real eBay sold-price data",
     "See what things actually sell for",
     "02_fbm_guitar.png"),
    ("Screenshot_2026-04-17_110859_1776449448294.png",
     "Works on FB Marketplace, eBay, Craigslist & OfferUp",
     "One extension, all the big used-goods sites",
     "03_ebay_ipad.png"),
    ("Screenshot_2026-04-17_110656_1776449448292.png",
     "Stop overpaying — instant market check",
     "See the gap between asking and market in one glance",
     "04_craigslist_speaker.png"),
    ("Screenshot_2026-04-17_110832_1776449448293.png",
     "Auto-scores every listing — or score on demand",
     "Toggle auto-score on or off in one click",
     "05_offerup_ac.png"),
]

def build_cws_screenshot(src, headline, sub, out):
    """1280x800 — top headline band + cropped screenshot under it."""
    W, H = 1280, 800
    BAND_H = 180
    canvas = Image.new("RGB", (W, H), NAVY)
    d = ImageDraw.Draw(canvas)
    d.rectangle([0, 0, W, BAND_H], fill=CARD)
    d.line([(0, BAND_H), (W, BAND_H)], fill=GREEN, width=3)

    f_h = font(44, bold=True)
    f_s = font(22, bold=False)
    words = headline.split()
    lines, cur = [], ""
    for w in words:
        test = (cur + " " + w).strip()
        tw, _ = text_w(d, test, f_h)
        if tw <= W - 120:
            cur = test
        else:
            if cur: lines.append(cur)
            cur = w
    if cur: lines.append(cur)

    line_h = 54
    y = (BAND_H - (len(lines) * line_h + 28)) // 2
    for ln in lines:
        tw, _ = text_w(d, ln, f_h)
        d.text(((W - tw) // 2, y), ln, fill=WHITE, font=f_h)
        y += line_h
    tw, _ = text_w(d, sub, f_s)
    d.text(((W - tw) // 2, y + 4), sub, fill=GREEN_BRIGHT, font=f_s)

    img = Image.open(os.path.join(SHOTS, src)).convert("RGB")
    avail_h = H - BAND_H
    scale = W / img.width
    new_h = int(img.height * scale)
    if new_h > avail_h:
        scale = avail_h / img.height
        new_w = int(img.width * scale)
        img = img.resize((new_w, avail_h), Image.LANCZOS)
        canvas.paste(img, ((W - new_w) // 2, BAND_H))
    else:
        img = img.resize((W, new_h), Image.LANCZOS)
        canvas.paste(img, (0, BAND_H))

    canvas.save(os.path.join(CWS_SHOTS, out), "PNG", optimize=True)
    print(f"  built marketing/cws/screenshots/{out}")

print("=== CWS screenshots (1280x800) ===")
for s in SCREENS:
    build_cws_screenshot(*s)

print("=== Promo tile (440x280) ===")
def build_promo_tile():
    W, H = 440, 280
    canvas = Image.new("RGB", (W, H), NAVY)
    d = ImageDraw.Draw(canvas)
    for i in range(H):
        a = int(15 * (i / H))
        d.line([(0, i), (W, i)], fill=(13 + a, 17 + a, 23 + a))
    icon = Image.open(os.path.join(DOCS_IMG, "icon.png")).convert("RGBA")
    icon = icon.resize((56, 56), Image.LANCZOS)
    canvas.paste(icon, (28, 28), icon)
    d.text((96, 38), "Deal Scout", fill=WHITE, font=font(28, bold=True))
    d.text((28, 116), "Know if it's a deal", fill=WHITE, font=font(34, bold=True))
    d.text((28, 156), "before you message.", fill=GREEN_BRIGHT, font=font(34, bold=True))
    d.text((28, 220), "Free Chrome extension · FB · eBay · CL · OU", fill=MUTED, font=font(15, bold=False))
    bx, by, bs = W - 96, 28, 68
    d.rounded_rectangle([bx, by, bx + bs, by + bs], radius=14, fill=GREEN, outline=GREEN_BRIGHT, width=2)
    d.text((bx + 18, by + 10), "8", fill=WHITE, font=font(28, bold=True))
    d.text((bx + 30, by + 10), "/10", fill=WHITE, font=font(14, bold=True))
    d.text((bx + 8, by + 46), "GREAT DEAL", fill=WHITE, font=font(10, bold=True))
    canvas.save(os.path.join(CWS_DIR, "promo-tile-440x280.png"), "PNG", optimize=True)
    print("  built marketing/cws/promo-tile-440x280.png")

build_promo_tile()

print("=== Hero banner ===")
def build_hero_banner():
    W, H = 1600, 800
    canvas = Image.new("RGB", (W, H), NAVY)
    d = ImageDraw.Draw(canvas)
    for i in range(H):
        a = int(20 * (i / H))
        d.line([(0, i), (W, i)], fill=(13 + a, 17 + a, 23 + a))

    pill_txt = "✦ FREE CHROME EXTENSION"
    f_pill = font(16, bold=True)
    pw, ph = text_w(d, pill_txt, f_pill)
    px, py = 80, 140
    d.rounded_rectangle([px, py, px + pw + 32, py + ph + 18], radius=20, outline=GREEN_BRIGHT, width=1)
    d.text((px + 16, py + 7), pill_txt, fill=GREEN_BRIGHT, font=f_pill)

    f_h = font(72, bold=True)
    d.text((80, 200), "Know if it's a deal", fill=WHITE, font=f_h)
    d.text((80, 286), "before you message.", fill=GREEN_BRIGHT, font=f_h)

    f_s = font(26, bold=False)
    y = 400
    for ln in ["AI scoring + real eBay sold prices for",
               "Facebook Marketplace, Craigslist, eBay & OfferUp."]:
        d.text((80, y), ln, fill=MUTED, font=f_s)
        y += 38

    cx, cy, cw, ch = 980, 160, 540, 480
    d.rounded_rectangle([cx, cy, cx + cw, cy + ch], radius=20, fill=CARD, outline=BORDER, width=1)
    sx, sy, sr = cx + 60, cy + 60, 130
    d.ellipse([sx, sy, sx + sr * 2, sy + sr * 2], outline=GREEN_BRIGHT, width=4)
    f_big = font(96, bold=True)
    txt = "8"
    tw, _ = text_w(d, txt, f_big)
    d.text((sx + sr - tw // 2, sy + 50), txt, fill=WHITE, font=f_big)
    d.text((sx + sr + 30, sy + 110), "/10", fill=MUTED, font=font(28, bold=True))

    d.text((cx + 320, cy + 80), "GREAT DEAL", fill=GREEN_BRIGHT, font=font(22, bold=True))
    d.text((cx + 320, cy + 116), "$26 below market", fill=TEXT, font=font(20, bold=False))
    d.text((cx + 320, cy + 146), "Based on 24 sold comps", fill=MUTED, font=font(16, bold=False))

    d.line([(cx + 32, cy + 340), (cx + cw - 32, cy + 340)], fill=BORDER, width=1)

    rows = [("Asking price", "$120"), ("Market average", "$146"), ("Recommended offer", "$110")]
    ry = cy + 360
    for k, v in rows:
        d.text((cx + 40, ry), k, fill=MUTED, font=font(18, bold=False))
        vw, _ = text_w(d, v, font(20, bold=True))
        d.text((cx + cw - 40 - vw, ry), v, fill=TEXT, font=font(20, bold=True))
        ry += 32

    canvas.save(os.path.join(DOCS_IMG, "hero_banner.png"), "PNG", optimize=True)
    print("  built docs/images/hero_banner.png")

build_hero_banner()

print("=== Landing screenshots ===")
def fit_landing(src, out, target_w=1100):
    img = Image.open(os.path.join(SHOTS, src)).convert("RGB")
    scale = target_w / img.width
    img = img.resize((target_w, int(img.height * scale)), Image.LANCZOS)
    img.save(os.path.join(DOCS_IMG, out), "PNG", optimize=True)
    print(f"  built docs/images/{out}")

fit_landing("Screenshot_2026-04-17_111154_1776449524121.png", "screenshot_results.png")
fit_landing("Screenshot_2026-04-17_110832_1776449448293.png", "screenshot_popup.png")

print("DONE")
