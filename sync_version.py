"""
sync_version.py — called by push.bat before every git push.

Reads VERSION from extension/content/fbm.js and writes it to
BACKEND_VERSION in api/main.py so /health always shows the live version.
"""
import re, sys

# ── Read JS version ───────────────────────────────────────────────────────────
try:
    fbm = open("extension/content/fbm.js", encoding="utf-8").read()
except FileNotFoundError:
    print("[version-sync] extension/content/fbm.js not found — skipping")
    sys.exit(0)

m = re.search(r'const VERSION\s*=\s*"([0-9.]+)"', fbm)
if not m:
    print("[version-sync] VERSION constant not found in fbm.js — skipping")
    sys.exit(0)

ver = m.group(1)

# ── Write to main.py ──────────────────────────────────────────────────────────
try:
    main = open("api/main.py", encoding="utf-8").read()
except FileNotFoundError:
    print("[version-sync] api/main.py not found — skipping")
    sys.exit(0)

updated = re.sub(r'BACKEND_VERSION\s*=\s*"[0-9.]+"', f'BACKEND_VERSION = "{ver}"', main)

if updated == main:
    print(f"[version-sync] BACKEND_VERSION already {ver} — no change needed")
else:
    open("api/main.py", "w", encoding="utf-8").write(updated)
    print(f"[version-sync] BACKEND_VERSION set to {ver}")

sys.exit(0)
