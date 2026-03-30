import asyncio
import logging
import anthropic

log = logging.getLogger(__name__)

async def claude_call_with_retry(fn, *, retries=2, delay=1.0, label="Claude"):
    last_err = None
    for attempt in range(retries + 1):
        try:
            loop = asyncio.get_running_loop()
            return await loop.run_in_executor(None, fn)
        except anthropic.AuthenticationError as e:
            last_err = e
            if attempt < retries:
                log.warning(f"[{label}] Auth error (attempt {attempt+1}/{retries+1}) — retrying in {delay}s")
                await asyncio.sleep(delay)
            else:
                raise
        except Exception:
            raise
