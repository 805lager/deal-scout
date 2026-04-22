"""
Per-scoring-run Anthropic token usage tracking.

Every Anthropic .messages.create() response carries a `usage` object with
`input_tokens` and `output_tokens`. This module collects those numbers across
every Claude call that fires during a single scoring run, so the scorecard
(and downstream Discord summary) can report real spend instead of a flat
estimate.

Usage:

    from scoring import claude_usage

    with claude_usage.track_run():
        # ... run scoring pipeline that calls Claude N times ...
        totals = claude_usage.totals()   # snapshot before the context exits

Each call site (or, in practice, the central `claude_call_with_retry`
wrapper) calls `claude_usage.record(response, label="...")` after every
successful `.messages.create()`. Calls made outside an active `track_run`
context are silently ignored, so this is safe to enable everywhere.
"""

from contextlib import contextmanager
from contextvars import ContextVar
from typing import Optional

# Anthropic public list-price per million tokens (USD).
# Update here when pricing changes.
PRICING = {
    "claude-haiku-4-5":  {"input": 1.0, "output": 5.0},
    "claude-haiku-4.5":  {"input": 1.0, "output": 5.0},
    "claude-3-5-haiku":  {"input": 1.0, "output": 5.0},
    "claude-sonnet-4-5": {"input": 3.0, "output": 15.0},
}
_DEFAULT_PRICING = {"input": 1.0, "output": 5.0}  # assume Haiku-class

_run: ContextVar[Optional[dict]] = ContextVar("claude_usage_run", default=None)


def _new_state() -> dict:
    return {
        "input_tokens": 0,
        "output_tokens": 0,
        "calls": 0,
        "by_model": {},
        "by_label": {},
    }


@contextmanager
def track_run():
    """Start a per-run accumulator. Yields the mutable state dict."""
    state = _new_state()
    token = _run.set(state)
    try:
        yield state
    finally:
        _run.reset(token)


def start_run() -> None:
    """
    Begin a per-run accumulator on the current asyncio task without a
    context-manager indent. ContextVars are task-local, so the value is
    reclaimed automatically when the request task ends — there's no need
    to call a matching reset for normal request lifecycles.

    Use this from the top of an HTTP handler whose body is too large to
    indent under `with track_run():`. Use track_run() everywhere else.
    """
    _run.set(_new_state())


def _pricing_for(model: str) -> dict:
    if not model:
        return _DEFAULT_PRICING
    if model in PRICING:
        return PRICING[model]
    # tolerate suffixes like claude-haiku-4-5-20251015
    for prefix, p in PRICING.items():
        if model.startswith(prefix):
            return p
    return _DEFAULT_PRICING


def cost_usd(input_tokens: int, output_tokens: int, model: str = "claude-haiku-4-5") -> float:
    p = _pricing_for(model)
    return (input_tokens * p["input"] + output_tokens * p["output"]) / 1_000_000.0


def record(response, *, label: str = "anthropic") -> None:
    """Record token usage from a Claude response object. No-op outside a run."""
    state = _run.get()
    if state is None or response is None:
        return
    try:
        usage = getattr(response, "usage", None)
        if usage is None:
            return
        in_tok = int(getattr(usage, "input_tokens", 0) or 0)
        out_tok = int(getattr(usage, "output_tokens", 0) or 0)
        if in_tok == 0 and out_tok == 0:
            return
        model = getattr(response, "model", "") or ""

        state["input_tokens"] += in_tok
        state["output_tokens"] += out_tok
        state["calls"] += 1

        bm = state["by_model"].setdefault(model or "unknown", {
            "input_tokens": 0, "output_tokens": 0, "calls": 0,
        })
        bm["input_tokens"] += in_tok
        bm["output_tokens"] += out_tok
        bm["calls"] += 1

        bl = state["by_label"].setdefault(label or "anthropic", {
            "input_tokens": 0, "output_tokens": 0, "calls": 0,
        })
        bl["input_tokens"] += in_tok
        bl["output_tokens"] += out_tok
        bl["calls"] += 1
    except Exception:
        # Never let usage tracking break a scoring run
        pass


def totals() -> Optional[dict]:
    """Return a JSON-serializable snapshot of the current run's usage, or None."""
    state = _run.get()
    if state is None:
        return None

    cost = 0.0
    for model, m in state["by_model"].items():
        cost += cost_usd(m["input_tokens"], m["output_tokens"], model)

    return {
        "input_tokens":  state["input_tokens"],
        "output_tokens": state["output_tokens"],
        "calls":         state["calls"],
        "cost_usd":      round(cost, 6),
        "by_model":      {k: dict(v) for k, v in state["by_model"].items()},
        "by_label":      {k: dict(v) for k, v in state["by_label"].items()},
    }
