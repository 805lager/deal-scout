"""
fix_api_base.py — run once from project root to patch fbm.js API_BASE.

WHY THIS EXISTS:
  fbm.js defaulted to http://localhost:8000 while popup.js defaulted to
  Railway. If ds_api_base isn't in chrome.storage, the content script
  hits localhost (old code) while the popup hits Railway — causing eBay
  mock data to appear despite Railway having working Gemini.

RUN:  python fix_api_base.py
"""
import re, sys, shutil
from pathlib import Path

path = Path(r"extension\content\fbm.js")

if not path.exists():
    # Try absolute fallback
    path = Path(r"C:\Users\Shaun\Desktop\Personal_Shopping_Bot\extension\content\fbm.js")

if not path.exists():
    print(f"ERROR: fbm.js not found at {path}")
    sys.exit(1)

# Backup first
bak = path.with_suffix(".js.bak")
shutil.copy2(path, bak)
print(f"Backup: {bak}")

content = path.read_text(encoding="utf-8")

old = 'let API_BASE = "http://localhost:8000";'
new = 'let API_BASE = "https://deal-scout-production.up.railway.app";'

if new in content:
    print("Already patched — nothing to do.")
    sys.exit(0)

if old not in content:
    print(f"ERROR: Could not find target string in fbm.js")
    print(f"File size: {len(content)} bytes")
    sys.exit(1)

content = content.replace(old, new, 1)
path.write_text(content, encoding="utf-8")

m = re.search(r'let API_BASE = "([^"]+)"', content)
print(f"Done. API_BASE = {m.group(1)}")
print(f"File size: {len(content)} bytes")
