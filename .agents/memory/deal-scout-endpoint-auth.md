---
name: Deal Scout endpoint auth footgun
description: Why admin auth checks in the Deal Scout FastAPI handlers must sit BEFORE the try block, not inside it.
---

# Auth checks must precede the try/except in Deal Scout handlers

Most route handlers in `artifacts/deal-scout-api/main.py` wrap their entire body
in a broad `try/except Exception` that swallows the error and returns a **200**
with an empty or `{"ok": false}` payload (e.g. GET `/nav-debug` returns `[]`,
GET `/diag` returns `{count:0,...}`).

`_check_admin_auth(request)` enforces auth by **raising `HTTPException`**.
`HTTPException` is a subclass of `Exception`, so if the auth call is placed
*inside* such a handler's `try`, the `except Exception` catches it and the
endpoint silently returns 200 — i.e. the gate is bypassed and the endpoint stays
effectively open.

**Rule:** put `_check_admin_auth(request)` (and any auth/validation that should
fail the request) as the first statement of the handler, *before* the `try`.

**Why:** discovered while locking down previously-unauthenticated admin/data
endpoints (`/score-log`, `/nav-debug`, `/diag` GET+DELETE). Verify the gate at
runtime (`curl` unauth → expect 401, not 200) — a passing import/compile does
not prove the gate works because the swallow turns a broken gate into a silent
200.

**How to apply:** any time you add auth to a handler here, confirm the auth call
is above the `try`, and add a regression test asserting unauth → 401/403/503
(see `tests/test_pipeline_integration.py`).
