"""
Shared Anthropic client (Task #80).

WHY THIS EXISTS:
  Before this module, ~11 call sites across the scoring package each
  constructed their own `anthropic.Anthropic(api_key=..., base_url=...)`
  on every Claude call. Each construction does a TLS handshake on the
  first request and re-reads env vars; under concurrent load this added
  50–200ms per Haiku call and churned sockets unnecessarily.

  This module exposes a single process-wide cached client built lazily
  at first use, so every Haiku call site shares one underlying HTTP/2
  connection pool.

ENV VAR HANDLING:
  - AI_INTEGRATIONS_ANTHROPIC_API_KEY — falls back to "placeholder" so
    construction never raises when the key is unset (matches the
    pre-existing behavior of every call site we migrated).
  - AI_INTEGRATIONS_ANTHROPIC_BASE_URL — read once at first construction
    and cached for the lifetime of the process.
  - If either env var is rotated at runtime, the worker process must be
    restarted for the change to take effect. We DO NOT re-read env on
    each call: that would defeat the entire point of pooling.

THREAD / ASYNC SAFETY:
  Module-level singleton built behind import semantics. Concurrent
  requests racing the first `get_anthropic_client()` call may construct
  the client more than once in pathological cases, but the underlying
  `anthropic.Anthropic` object is safe to construct repeatedly and the
  last one wins. We accept that micro-race in exchange for not needing
  a lock on the hot path.

CYBERSECURITY:
  - The client is module-level only — never per-request, never
    per-user, never built from request data. There is no path for one
    user's session/headers to leak into another's call.
  - api_key / base_url are NEVER logged at any verbosity level.
"""

from __future__ import annotations

import os
from typing import Optional

import anthropic

_shared_client: Optional[anthropic.Anthropic] = None

# TASK-80 BENCHMARK FLAG: when env var DS_DISABLE_CLIENT_POOL=1 is set,
# get_anthropic_client() constructs a fresh client on every call. This
# simulates the pre-Task-80 behavior so we can run a clean A/B
# benchmark on /score. In production this env var is unset and the
# singleton behavior is the default. REMOVE THIS FLAG after the
# benchmark is recorded if it's never needed again.
def get_anthropic_client() -> anthropic.Anthropic:
    """Return the process-wide shared Anthropic client.

    Constructed lazily at first call from
    ``AI_INTEGRATIONS_ANTHROPIC_API_KEY`` and
    ``AI_INTEGRATIONS_ANTHROPIC_BASE_URL``.
    """
    if os.getenv("DS_DISABLE_CLIENT_POOL") == "1":
        return anthropic.Anthropic(
            api_key=os.getenv("AI_INTEGRATIONS_ANTHROPIC_API_KEY", "placeholder"),
            base_url=os.getenv("AI_INTEGRATIONS_ANTHROPIC_BASE_URL"),
        )
    global _shared_client
    if _shared_client is None:
        _shared_client = anthropic.Anthropic(
            api_key=os.getenv("AI_INTEGRATIONS_ANTHROPIC_API_KEY", "placeholder"),
            base_url=os.getenv("AI_INTEGRATIONS_ANTHROPIC_BASE_URL"),
        )
    return _shared_client


def reset_anthropic_client_for_tests() -> None:
    """Reset the cached client. Test-only; do NOT call from request handlers."""
    global _shared_client
    _shared_client = None
