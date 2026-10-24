"""Provider-agnostic structured LLM calls (Gemini or OpenAI).

Every call returns a validated Pydantic object. Each role (extract, verify, fast)
has a fallback chain of models; overload/quota errors move to the next model.
"""

import base64
import logging
import re
import time
from collections.abc import Callable
from concurrent.futures import FIRST_COMPLETED, Future, ThreadPoolExecutor, wait
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any, TypeVar

import httpx
from pydantic import BaseModel

from app.config import get_settings

log = logging.getLogger(__name__)
T = TypeVar("T", bound=BaseModel)

Part = dict[str, Any]  # {"text": str} | {"image": path}


def text(s: str) -> Part:
    return {"text": s}


def image(path: str | Path) -> Part:
    return {"image": str(path)}


def audio(data: bytes, mime: str) -> Part:
    return {"audio": data, "mime": mime}


@dataclass
class LLMResult:
    parsed: Any
    model: str
    ms: int
    input_tokens: int
    output_tokens: int


class LLMUnavailable(RuntimeError):
    pass


# Models that just reported an exhausted quota or do not exist are skipped for a while, so every request does not
# wait through the same failures before reaching a working model.
_cooling: dict[str, float] = {}
# The model that last answered each role is tried first, so a request does not start on a model that is overloaded.
_last_ok: dict[str, str] = {}
OVERLOAD_COOLDOWN_S = 45
INTERACTIVE_TIMEOUT_MS = 20_000
HEDGE_AFTER_S = 6


def _cooldown_s(msg: str) -> float:
    """How long to skip a model: the provider's suggested retry delay, longer for daily quotas and unknown models."""
    if "PerDay" in msg or "404" in msg or "NOT_FOUND" in msg:
        return 1800
    m = re.search(r"retry(?:Delay|[ _]in)\W+(\d+(?:\.\d+)?)\s*s", msg, re.I)
    return max(float(m.group(1)), 20) if m else 300

_RETRYABLE = ("503", "UNAVAILABLE", "overloaded", "429", "RESOURCE_EXHAUSTED", "rate", "timeout", "500", "INTERNAL", "404", "NOT_FOUND")


@lru_cache
def _gemini():
    from google import genai
    from google.genai import types

    s = get_settings()
    if not s.gemini_api_key:
        raise LLMUnavailable("GEMINI_API_KEY is not set (backend/.env)")
    opts = types.HttpOptions(timeout=300_000, client_args={"verify": s.ca_bundle} if s.ca_bundle else None)
    return genai.Client(api_key=s.gemini_api_key, http_options=opts)


@lru_cache
def _openai():
    from openai import OpenAI

    s = get_settings()
    if not s.openai_api_key:
        raise LLMUnavailable("OPENAI_API_KEY is not set (backend/.env)")
    http = httpx.Client(verify=s.ca_bundle or True, timeout=httpx.Timeout(300, connect=20))
    return OpenAI(api_key=s.openai_api_key, http_client=http, max_retries=1)


def _call_gemini(model: str, system: str, parts: list[Part], schema: type[T], thinking_level: str | None = None,
                 timeout_ms: int | None = None) -> LLMResult:
    from google.genai import types

    contents: list[Any] = []
    for p in parts:
        if "image" in p:
            contents.append(types.Part.from_bytes(data=Path(p["image"]).read_bytes(), mime_type="image/png"))
        elif "audio" in p:
            contents.append(types.Part.from_bytes(data=p["audio"], mime_type=p["mime"]))
        else:
            contents.append(p["text"])
    default = get_settings().gemini_thinking_level
    level = thinking_level or default

    def config(level: str | None) -> Any:
        thinking = types.ThinkingConfig(thinking_level=level) if level and model.startswith("gemini-3") else None
        return types.GenerateContentConfig(system_instruction=system, response_mime_type="application/json",
                                           response_json_schema=schema.model_json_schema(), temperature=0,
                                           thinking_config=thinking,
                                           http_options=types.HttpOptions(timeout=timeout_ms) if timeout_ms else None)

    t0 = time.perf_counter()
    try:
        resp = _gemini().models.generate_content(model=model, contents=contents, config=config(level))
    except Exception as e:
        # Not every model accepts every level (e.g. "minimal"); fall back to the configured one on the same model.
        if level == default or "thinking" not in str(e).lower():
            raise
        resp = _gemini().models.generate_content(model=model, contents=contents, config=config(default))
    ms = int((time.perf_counter() - t0) * 1000)
    if not resp.text:
        raise RuntimeError(f"empty response (finish={resp.candidates[0].finish_reason if resp.candidates else '?'})")
    parsed = schema.model_validate_json(resp.text)
    um = resp.usage_metadata
    return LLMResult(parsed, model, ms, (um.prompt_token_count or 0) if um else 0, (um.candidates_token_count or 0) if um else 0)


def _call_openai(model: str, system: str, parts: list[Part], schema: type[T], thinking_level: str | None = None,
                 timeout_ms: int | None = None) -> LLMResult:
    content: list[dict[str, Any]] = []
    for p in parts:
        if "audio" in p:
            raise LLMUnavailable("Audio input needs the Gemini provider")
        if "image" in p:
            data = base64.b64encode(Path(p["image"]).read_bytes()).decode()
            content.append({"type": "image_url", "image_url": {"url": f"data:image/png;base64,{data}", "detail": "high"}})
        else:
            content.append({"type": "text", "text": p["text"]})
    kwargs: dict[str, Any] = {}
    if model.startswith(("gpt-5", "o1", "o3", "o4")):
        kwargs["reasoning_effort"] = get_settings().openai_reasoning_effort
    else:
        kwargs["temperature"] = 0
    t0 = time.perf_counter()
    resp = _openai().chat.completions.parse(
        model=model,
        messages=[{"role": "system", "content": system}, {"role": "user", "content": content}],
        response_format=schema,
        **kwargs,
    )
    ms = int((time.perf_counter() - t0) * 1000)
    msg = resp.choices[0].message
    if msg.refusal or msg.parsed is None:
        raise RuntimeError(f"no structured output: {msg.refusal}")
    u = resp.usage
    return LLMResult(msg.parsed, model, ms, u.prompt_tokens if u else 0, u.completion_tokens if u else 0)


def parse(role: str, system: str, parts: list[Part] | str, schema: type[T], attempts_per_model: int = 2,
          thinking: str | None = None, interactive: bool = False) -> LLMResult:
    """Run a structured call for `role` (extract | verify | fast), falling back across models.

    `thinking` overrides the Gemini 3 thinking level for this call ("minimal" for quick voice replies).
    `interactive` is for someone waiting on the answer (chat, voice): see `_hedged`; overloaded models are then
    skipped for a while."""
    s = get_settings()
    if isinstance(parts, str):
        parts = [text(parts)]
    call = _call_gemini if s.llm_provider == "gemini" else _call_openai
    errors: list[str] = []
    chain = s.models_for(role)
    if _last_ok.get(role) in chain:
        chain = [_last_ok[role], *[m for m in chain if m != _last_ok[role]]]
    now = time.monotonic()
    ready = [m for m in chain if _cooling.get(m, 0) <= now] or chain
    if interactive:
        return _hedged(role, ready, lambda m: call(m, system, parts, schema, thinking, INTERACTIVE_TIMEOUT_MS), schema)
    for model in ready:
        for attempt in range(attempts_per_model):
            try:
                r = call(model, system, parts, schema, thinking)
                log.info("llm %s %s %s %dms in=%d out=%d", role, model, schema.__name__, r.ms, r.input_tokens, r.output_tokens)
                _cooling.pop(model, None)
                _last_ok[role] = model
                return r
            except LLMUnavailable:
                raise
            except Exception as e:  # noqa: BLE001 - provider SDKs raise many error types
                msg = str(e)
                errors.append(f"{model}: {msg[:160]}")
                log.warning("llm %s %s attempt %d failed: %s", role, model, attempt + 1, msg[:200])
                if not any(k in msg for k in _RETRYABLE):
                    # schema/validation problems: retry once on same model, then next model
                    if attempt == 0:
                        continue
                    break
                if "404" in msg or "NOT_FOUND" in msg or "free_tier" in msg or "quota" in msg.lower():
                    _cooling[model] = time.monotonic() + _cooldown_s(msg)
                    break
                time.sleep(2 + 3 * attempt)
    raise LLMUnavailable("All models failed: " + " | ".join(errors[-4:]))


def _hedged(role: str, models: list[str], run: Callable[[str], LLMResult], schema: type[BaseModel]) -> LLMResult:
    """For someone waiting: one try per model, the next model starts at once when one fails, and also when one is
    slow (after HEDGE_AFTER_S), with at most two in flight. The first answer wins."""
    queue = list(models)
    pending: dict[Future[LLMResult], str] = {}
    errors: list[str] = []
    pool = ThreadPoolExecutor(max_workers=len(models) or 1)

    def launch() -> None:
        if queue and len(pending) < 2:
            m = queue.pop(0)
            pending[pool.submit(run, m)] = m

    launch()
    try:
        while pending:
            done, _ = wait(pending, timeout=HEDGE_AFTER_S, return_when=FIRST_COMPLETED)
            if not done:
                launch()
                continue
            for f in done:
                model = pending.pop(f)
                try:
                    r = f.result()
                except LLMUnavailable:
                    raise
                except Exception as e:  # noqa: BLE001 - provider SDKs raise many error types
                    msg = str(e)
                    errors.append(f"{model}: {msg[:160]}")
                    log.warning("llm %s %s failed: %s", role, model, msg[:200])
                    if "404" in msg or "NOT_FOUND" in msg or "free_tier" in msg or "quota" in msg.lower():
                        _cooling[model] = time.monotonic() + _cooldown_s(msg)
                    elif any(k in msg for k in ("503", "UNAVAILABLE", "overloaded", "504", "DEADLINE", "timed out", "timeout")):
                        _cooling[model] = time.monotonic() + OVERLOAD_COOLDOWN_S
                    launch()
                    continue
                log.info("llm %s %s %s %dms in=%d out=%d", role, model, schema.__name__, r.ms, r.input_tokens, r.output_tokens)
                _cooling.pop(model, None)
                _last_ok[role] = model
                for slow in pending.values():  # lost the race: skip it for a while
                    _cooling[slow] = time.monotonic() + OVERLOAD_COOLDOWN_S
                return r
    finally:
        pool.shutdown(wait=False, cancel_futures=True)
    raise LLMUnavailable("All models failed: " + " | ".join(errors[-4:]))
