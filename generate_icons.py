"""
Generate placeholder icons for the Deal Scout Chrome extension.
Run once: python generate_icons.py

Requires Pillow — already in requirements.txt.
If missing: python -m pip install Pillow
"""

from PIL import Image, ImageDraw, ImageFont
from pathlib import Path

OUTPUT_DIR = Path(__file__).parent / "extension" / "icons"
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

def generate_icon(size: int):
    img  = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # Purple circle background
    m = max(1, size // 10)
    draw.ellipse([m, m, size - m, size - m], fill="#667eea")

    # Darker inner circle for depth
    m2 = max(2, size // 5)
    draw.ellipse([m2, m2, size - m2, size - m2], fill="#764ba2")

    # White "S" for Scout on larger icons
    if size >= 48:
        font_size = size // 2
        font = None
        # Try common font paths — falls back to default if none found
        for path in [
            "C:/Windows/Fonts/arialbd.ttf",
            "C:/Windows/Fonts/arial.ttf",
            "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
            "/System/Library/Fonts/Helvetica.ttc",
        ]:
            try:
                font = ImageFont.truetype(path, font_size)
                break
            except (IOError, OSError):
                continue

        if font is None:
            font = ImageFont.load_default()

        bbox = draw.textbbox((0, 0), "S", font=font)
        tw   = bbox[2] - bbox[0]
        th   = bbox[3] - bbox[1]
        x    = (size - tw) // 2
        y    = (size - th) // 2 - max(1, size // 12)
        draw.text((x, y), "S", fill="white", font=font)
    else:
        # 16px is too small for text — just a white dot
        cx = size // 2
        r  = max(1, size // 5)
        draw.ellipse([cx - r, cx - r, cx + r, cx + r], fill="white")

    path = OUTPUT_DIR / f"icon{size}.png"
    img.save(path)
    print(f"  ✅ {path}")

if __name__ == "__main__":
    print("Generating extension icons...")
    for size in [16, 48, 128]:
        generate_icon(size)
    print("\nDone — icons saved to extension/icons/")
    print("You can now load the extension in Chrome.")
