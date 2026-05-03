import asyncio
import logging
import anthropic

from . import claude_usage

log = logging.getLogger(__name__)

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
