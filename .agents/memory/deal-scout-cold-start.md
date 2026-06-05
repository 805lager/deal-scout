---
name: Deal Scout prod cold starts
description: Why morning API errors happen on the deployed Deal Scout backend and how they're mitigated
---

Deal Scout's production backend (deal-scout-805lager.replit.app) runs as an
**Autoscale** deployment, which scales to zero when idle. The first request
after an idle gap (typically the first morning scoring attempt) must wait for
the container to provision and FastAPI to boot (migrations + DB pool +
scheduler, ~3-8s). Requests landing during that window fail with an API error,
then succeed once startup completes — matching the user's "error in the
morning, works after a minute" report. Deployment logs show frequent
"Root app startup — running migrations and scheduler" lines clustered after
idle gaps confirming repeated cold starts.

**Mitigation chosen (cost-conscious):** the extension's `callScoringAPI`
(extension/background.js) retries network errors / 5xx with backoff and a
fetch timeout so a cold start is absorbed silently instead of surfacing an error.

**Why not the full fix:** the proper fix is switching the deployment to a
**Reserved VM** (always-on, no scale-to-zero), but that costs a flat monthly
rate. User opted to keep costs low and rely on the extension retry for now.

**How to apply:** if cold-start errors resurface, either lengthen the retry
budget further or recommend Reserved VM again. Don't add a keep-warm cron —
it still scales down on long gaps and burns Autoscale compute.
