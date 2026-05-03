#!/usr/bin/env bash
set -euo pipefail

# Resolve COMMIT to whatever HEAD is at script-run time (post auto-checkpoint).
# Override by exporting COMMIT=<sha> before invoking, if needed.
COMMIT="${COMMIT:-$(git --no-optional-locks rev-parse HEAD)}"
TAG="v0.46.6"
ZIP="extension/deal-scout-v0.46.6.zip"
TAG_MSG="v0.46.6 — drop duplicate low-confidence disclaimer + collapsible Negotiation (#85)"

read -r -d '' BODY <<'EOF' || true
## What's new in v0.46.6

UI polish release responding to user feedback on a thin-comps kegerator listing in v0.46.5. No backend changes — extension-only.

- **Duplicate "low confidence" disclaimer dropped (#85)** — the amber thin-comps caveat used to render twice on the same panel: once as a header banner above the confidence block, and again inline inside the confidence block body. The inline copy was removed; the header banner remains the single source of the caveat. The "● LOW · Based on N comps" chip continues to convey the confidence signal at a glance. The `renderPricingDisclaimerInline` helper is kept exported as an opt-in for future reuse.
- **Negotiation section is now collapsed by default (#85)** — the negotiation block was always-expanded and pushed the rest of the panel below the fold on long listings. It is now wrapped in a native `<details>` with a single-line summary that previews the polite target offer and the walk-away ceiling (e.g. `💬 Negotiation · standard   Polite $X · 🛑 $Y ▾`). Click to expand for the full variants/leverage/counter-response. Exception: when the strategy is `pay_asking` (score 8+ "strong deal — pay asking and act fast"), the section stays open by default since that single line *is* the primary action.
- **No backend changes** — `VERSION` bumped 0.46.5 → 0.46.6 only so the published extension matches the API `VERSION`.

### Install
1. Download `deal-scout-v0.46.6.zip` below, unzip.
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
