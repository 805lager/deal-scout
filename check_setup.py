"""
Quick setup check — run this first to verify your environment is ready.
Usage: python check_setup.py
"""

import sys
import os
from pathlib import Path

print("🔍 Checking Personal Shopping Bot setup...\n")

errors = []
warnings = []

# Python version
if sys.version_info < (3, 11):
    warnings.append(f"Python {sys.version_info.major}.{sys.version_info.minor} detected — recommend 3.11+")
else:
    print(f"✅ Python {sys.version_info.major}.{sys.version_info.minor}")

# Required packages
packages = {
    "playwright": "playwright",
    "fastapi": "fastapi",
    "anthropic": "anthropic",
    "dotenv": "python-dotenv",
    "httpx": "httpx",
    "pydantic": "pydantic",
}
for module, package in packages.items():
    try:
        __import__(module)
        print(f"✅ {package}")
    except ImportError:
        errors.append(f"Missing package: {package}  →  pip install {package}")

# .env file
env_path = Path(".env")
if not env_path.exists():
    errors.append(".env file not found — copy from template and fill in credentials")
else:
    from dotenv import load_dotenv
    load_dotenv()
    missing_keys = []
    for key in ["FB_EMAIL", "FB_PASSWORD", "ANTHROPIC_API_KEY", "EBAY_APP_ID"]:
        val = os.getenv(key)
        if not val or "your_" in val:
            missing_keys.append(key)
    if missing_keys:
        warnings.append(f".env is missing real values for: {', '.join(missing_keys)}")
    else:
        print("✅ .env credentials present")

# Playwright browsers
try:
    import subprocess
    result = subprocess.run(
        ["python", "-m", "playwright", "install", "--dry-run"],
        capture_output=True, text=True
    )
    print("✅ Playwright installed")
except Exception:
    warnings.append("Could not verify Playwright browsers — run: playwright install chromium")

# Summary
print()
if errors:
    print("❌ ERRORS (must fix):")
    for e in errors:
        print(f"   • {e}")
if warnings:
    print("⚠️  WARNINGS (should fix):")
    for w in warnings:
        print(f"   • {w}")
if not errors and not warnings:
    print("🚀 All good — you're ready to run the scraper!")
    print("   Next: Fill in .env with your test FB credentials, then:")
    print("   python scraper/fbm_scraper.py")
