#!/usr/bin/env bash
set -euo pipefail

# Resolve COMMIT to whatever HEAD is at script-run time (post auto-checkpoint).
# Override by exporting COMMIT=<sha> before invoking, if needed.
COMMIT="${COMMIT:-$(git --no-optional-locks rev-parse HEAD)}"
TAG="v0.46.7"
ZIP="extension/deal-scout-v0.46.7.zip"
TAG_MSG="v0.46.7 — restyle collapsed Negotiation summary to match other section headers"

read -r -d '' BODY <<'EOF' || true
## What's new in v0.46.7

UI polish on top of v0.46.6's collapsible Negotiation. Extension-only release.

- **Negotiation summary now matches the other section headers** — in v0.46.6 the closed-state line crammed the label, a "standard" strategy badge, and the polite/walk-away preview into a single flex row, which wrapped onto two lines on narrow panels and looked unlike anything else in the panel. The summary is now shaped like the other section headers ("Category leaders", "Same-budget alternatives", "Leverage points"): an uppercase 11px gray label on the left and a compact preview + chevron on the right, on a single row.
- **Strategy badge moved into the open body** — the indigo "standard"/"firm"/etc. badge that used to sit in the summary now lives just inside the expanded section as "Strategy: …", so the closed line stays tidy. The pay_asking case still skips the badge (the green "Strong deal — pay asking" note is the strategy).
- **No backend changes** — `VERSION` bumped 0.46.6 → 0.46.7 only so the published extension matches the API `VERSION`.

### Install
1. Download `deal-scout-v0.46.7.zip` below, unzip.
2. `chrome://extensions` → enable Developer mode → Load unpacked → select the unzipped folder.
EOF

H_AUTH="Authorization: Bearer ${GITHUB_TOKEN}"
H_ACC="Accept: application/vnd.github+json"
H_VER="X-GitHub-Api-Version: 2022-11-28"

release_repo() {
  local REPO="$1"
  local ATTACH="$2"
  echo
  echo "=== ${REPO} ==="

  local TAG_PAYLOAD
  TAG_PAYLOAD=$(jq -nc --arg t "$TAG" --arg m "$TAG_MSG" --arg o "$COMMIT" \
    '{tag:$t,message:$m,object:$o,type:"commit",tagger:{name:"Deal Scout Release",email:"release@deal-scout.local",date:(now|todate)}}')
  local TAG_SHA
  TAG_SHA=$(curl -sS -X POST -H "$H_AUTH" -H "$H_ACC" -H "$H_VER" \
    "https://api.github.com/repos/${REPO}/git/tags" -d "$TAG_PAYLOAD" | jq -r '.sha // empty')
  echo "tag obj sha: ${TAG_SHA:-FAILED}"
  [ -n "$TAG_SHA" ] || return 1

  local REF_RES
  REF_RES=$(curl -sS -X POST -H "$H_AUTH" -H "$H_ACC" -H "$H_VER" \
    "https://api.github.com/repos/${REPO}/git/refs" \
    -d "$(jq -nc --arg r "refs/tags/${TAG}" --arg s "$TAG_SHA" '{ref:$r,sha:$s}')")
  echo "ref:         $(echo "$REF_RES" | jq -r '.ref // .message')"

  local REL_PAYLOAD
  REL_PAYLOAD=$(jq -nc --arg t "$TAG" --arg n "Deal Scout ${TAG}" --arg b "$BODY" \
    '{tag_name:$t,name:$n,body:$b,draft:false,prerelease:false}')
  local REL_RES
  REL_RES=$(curl -sS -X POST -H "$H_AUTH" -H "$H_ACC" -H "$H_VER" \
    "https://api.github.com/repos/${REPO}/releases" -d "$REL_PAYLOAD")
  local REL_URL UP_URL
  REL_URL=$(echo "$REL_RES" | jq -r '.html_url // empty')
  UP_URL=$(echo "$REL_RES"  | jq -r '.upload_url // empty' | sed 's/{.*}$//')
  echo "release:     ${REL_URL:-FAILED} ($(echo "$REL_RES" | jq -r '.message // "ok"'))"
  [ -n "$REL_URL" ] || return 1

  if [ "$ATTACH" = "yes" ]; then
    local UP_RES
    UP_RES=$(curl -sS -X POST -H "$H_AUTH" -H "$H_ACC" -H "$H_VER" \
      -H "Content-Type: application/zip" \
      --data-binary "@${ZIP}" \
      "${UP_URL}?name=deal-scout-${TAG}.zip")
    echo "asset:       $(echo "$UP_RES" | jq -r '.browser_download_url // .message')"
  fi
}

release_repo "805lager/deal-scout"     "yes"
release_repo "805lager/deal-scout-api" "no"
