#!/usr/bin/env bash
# Bump version across every place that needs to stay in sync.
#
# Usage: scripts/bump-version.sh 0.42.7
#
# Updates:
#   - extension/manifest.json   ("version": "...")
#   - artifacts/deal-scout-api/VERSION  (single source of truth read by main.py)
#
# Does NOT commit, tag, or rebuild the zip — that's still the caller's job.
# But after this runs, the audit dashboard, score metadata, /health, and the
# extension all report the same number, automatically.

set -euo pipefail

if [ $# -ne 1 ]; then
  echo "usage: $0 <new-version>   (e.g. $0 0.42.7)" >&2
  exit 1
fi

NEW="$1"

# Validate looks like semver-ish X.Y.Z
if ! echo "$NEW" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo "error: '$NEW' is not in X.Y.Z form" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MANIFEST="$ROOT/extension/manifest.json"
VERSION_FILE="$ROOT/artifacts/deal-scout-api/VERSION"

# extension/manifest.json
python3 - "$MANIFEST" "$NEW" <<'PY'
import json, sys
path, new = sys.argv[1], sys.argv[2]
with open(path) as f:
    data = json.load(f)
old = data.get("version")
data["version"] = new
with open(path, "w") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
print(f"manifest.json: {old} -> {new}")
PY

# artifacts/deal-scout-api/VERSION
OLD_API="$(cat "$VERSION_FILE" 2>/dev/null | tr -d '[:space:]' || echo 'unset')"
echo "$NEW" > "$VERSION_FILE"
echo "VERSION (API): $OLD_API -> $NEW"

echo
echo "Done. Next steps:"
echo "  - rebuild deal_scout_extension.zip if extension changed"
echo "  - update replit.md changelog"
echo "  - git tag -a v$NEW -m '...' && git push origin v$NEW && git push api v$NEW"
