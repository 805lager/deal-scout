"""
restore_fbm.py — restores fbm.js from the .bak file and applies the Railway URL fix.
Run once from the project root: python restore_fbm.py
"""
import re, sys, shutil
from pathlib import Path

bak  = Path(r"extension\content\fbm.js.bak")
dest = Path(r"extension\content\fbm.js")

if not bak.exists():
    print(f"ERROR: backup not found at {bak}")
    print("The backup should have been created by fix_api_base.py")
    sys.exit(1)

content = bak.read_text(encoding="utf-8")
print(f"Backup read: {len(content)} bytes, {content.count(chr(10))} lines")

# Apply the API_BASE fix while restoring
old = 'let API_BASE = "http://localhost:8000";'
new = 'let API_BASE = "https://deal-scout-production.up.railway.app";'

if old in content:
    content = content.replace(old, new, 1)
    print(f"Applied Railway URL fix")
elif new in content:
    print("Railway URL already present in backup")
else:
    print("WARNING: API_BASE line not found - restoring as-is")

dest.write_text(content, encoding="utf-8")
print(f"Restored to {dest}")
print(f"Written: {len(content)} bytes")

# Verify
m = re.search(r'let API_BASE = "([^"]+)"', content)
v = re.search(r'const VERSION\s*=\s*"([^"]+)"', content)
print(f"API_BASE = {m.group(1) if m else 'NOT FOUND'}")
print(f"VERSION  = {v.group(1) if v else 'NOT FOUND'}")

if content.strip().endswith("})();"):
    print("IIFE close: OK")
else:
    print("WARNING: unexpected file ending")
