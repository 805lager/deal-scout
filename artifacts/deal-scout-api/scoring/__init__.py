import asyncio
import json
import logging
import re
from typing import Optional

import anthropic

from . import claude_usage

log = logging.getLogger(__name__)


def extract_claude_json(raw_text: str, label: str = "Claude") -> Optional[dict]:
    """
    Robustly extract a JSON object from a Claude response.

    Claude — even with explicit "no fences, no preamble" instructions — will
    occasionally:
      1. wrap the JSON in ```json ... ``` fences
      2. emit a leading sentence ("Here is the JSON:") before the object
      3. close with trailing commentary after the object
      4. emit malformed JSON (unescaped quotes inside strings, trailing commas)

    NOT recovered: a response that abandons the schema entirely (e.g. emits
    only array bodies or only prose with no `{ ... }` anywhere). All four
    current callers require an object-shaped payload, so the helper only
    returns dicts; array-only outputs yield None.

    Strategy, in order — first success wins:
      a) json.loads on the raw text                 — happy path
      b) strip ```json fences, slice to first { … last }, then json.loads
      c) json_repair.loads on the sliced text       — fixes quote/comma issues
      d) json_repair.loads on the raw text          — last-ditch salvage

    Returns the parsed dict, or None if every strategy failed.
    The caller is responsible for logging the None-return failure mode that
    matters to it (e.g. a user-facing "scoring failed" path vs. silent
    fallback to a heuristic).
    """
    if not raw_text or not isinstance(raw_text, str):
        return None

    text = raw_text.strip()

    # (a) Happy path — Claude obeyed
    try:
        result = json.loads(text)
        return result if isinstance(result, dict) else None
    except (json.JSONDecodeError, ValueError):
        pass

    # (b) Strip fences and slice to outermost { … }
    sliced = text
    # Remove leading/trailing fence markers like ```json … ```
    sliced = re.sub(r"^```(?:json)?\s*", "", sliced)
    sliced = re.sub(r"\s*```$", "", sliced)
    # Greedy match: handles nested braces because we want the whole object,
    # not the first inner one.
    m = re.search(r"\{.*\}", sliced, re.DOTALL)
    if m:
        sliced = m.group()
        try:
            result = json.loads(sliced)
            return result if isinstance(result, dict) else None
        except (json.JSONDecodeError, ValueError):
            pass

    # (c) + (d) json_repair on sliced, then raw
    try:
        import json_repair
        for candidate in (sliced, text):
            try:
                repaired = json_repair.loads(candidate)
                if isinstance(repaired, dict) and repaired:
                    log.warning(f"[{label}] JSON parsed via json_repair fallback")
                    return repaired
            except Exception:
                continue
    except ImportError:
        log.debug(f"[{label}] json_repair not installed — skipping repair fallback")

    return None

async def claude_call_with_retry(fn, *, retries=2, delay=1.0, label="Claude"):
    last_err = None
    for attempt in range(retries + 1):
        try:
            loop = asyncio.get_running_loop()
            response = await loop.run_in_executor(None, fn)
            claude_usage.record(response, label=label)
            # One-shot cache telemetry (Task #75): log cache_read /
            # cache_creation token counts so we can confirm prompt caching
            # is firing in production. Anthropic returns these on every
            # response when the request used cache_control. INFO-level so
            # they're visible in normal logs without enabling DEBUG.
            try:
                u = claude_usage.extract_usage(response)
                log.info(
                    "[ClaudeCache] label=%s model=%s in=%d out=%d "
                    "cache_read=%d cache_creation=%d hit=%s",
                    label,
                    u.get("model") or "?",
                    u.get("input_tokens", 0),
                    u.get("output_tokens", 0),
                    u.get("cache_read_input_tokens", 0),
                    u.get("cache_creation_input_tokens", 0),
                    "Y" if u.get("cache_read_input_tokens", 0) > 0 else "N",
                )
            except Exception:
                pass
            return response
        except anthropic.AuthenticationError as e:
            last_err = e
            if attempt < retries:
                log.warning(f"[{label}] Auth error (attempt {attempt+1}/{retries+1}) — retrying in {delay}s")
                await asyncio.sleep(delay)
            else:
                raise
        except Exception:
            raise
