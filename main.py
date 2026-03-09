# main.py — Project root entry point for Railpack auto-detection.
#
# WHY THIS FILE EXISTS:
#   Railpack 0.17.2 broke startCommand parsing from railway.toml.
#   It falls back to running main.py or app.py in the project root.
#   This file is that fallback — it just launches the actual FastAPI app.
#
# The real app lives at api/main.py. We import it here so uvicorn
# can find it via the standard "main:app" path from the project root.

import os
import uvicorn

# Import the FastAPI app instance so "main:app" resolves correctly
from api.main import app  # noqa: F401

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run("main:app", host="0.0.0.0", port=port)
