"""OpenAI-compatible chat client for the local PE ingest worker.

The parser must keep running when no analysis model is configured, so configuration
entry points return ``None`` instead of raising when the
environment is incomplete. Callers treat a missing client as "skip the model
step", never as a failure.

Only the Python standard library is required. This sidecar reads existing page text;
it does not parse PDF files or load document classification adapters.
"""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any

DEFAULT_MODEL = "private-fund-default"
DEFAULT_TIMEOUT_SECONDS = 600.0
DEFAULT_MAX_ATTEMPTS = 3
RETRYABLE_STATUS = frozenset({408, 409, 425, 429, 500, 502, 503, 504})


class LlmUnavailableError(RuntimeError):
    """The model endpoint could not produce a response for this call."""


@dataclass(frozen=True)
class LlmSettings:
    base_url: str
    api_key: str
    model: str = DEFAULT_MODEL
    timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS
    max_attempts: int = DEFAULT_MAX_ATTEMPTS
    # Vendor-specific request fields merged into every chat payload, e.g.
    # {"enable_thinking": false} to turn off reasoning on DashScope Qwen models.
    extra_body: tuple[tuple[str, Any], ...] = ()

    def chat_completions_url(self) -> str:
        return f"{self.base_url.rstrip('/')}/chat/completions"


class OpenAICompatibleChatClient:
    """Minimal HTTP client for claim extraction, question resolution and card prose."""

    def __init__(self, settings: LlmSettings) -> None:
        self._settings = settings
        self.last_error: str = ""

    @property
    def model(self) -> str:
        return self._settings.model

    def chat(
        self,
        messages: list[dict[str, str]],
        *,
        max_tokens: int | None = None,
        temperature: float | None = None,
    ) -> str:
        payload: dict[str, Any] = {
            "model": self._settings.model,
            "messages": messages,
        }
        payload.update(dict(self._settings.extra_body))
        if max_tokens is not None:
            payload["max_tokens"] = max_tokens
        if temperature is not None:
            payload["temperature"] = temperature

        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        last_error = ""
        for attempt in range(1, self._settings.max_attempts + 1):
            request = urllib.request.Request(
                self._settings.chat_completions_url(),
                data=body,
                method="POST",
                headers={
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {self._settings.api_key}",
                    "Accept": "application/json",
                },
            )
            try:
                with urllib.request.urlopen(
                    request, timeout=self._settings.timeout_seconds
                ) as response:
                    raw = response.read().decode("utf-8", errors="replace")
                return _first_message_content(raw)
            except urllib.error.HTTPError as exc:
                detail = exc.read().decode("utf-8", errors="replace")[:400]
                last_error = f"HTTP {exc.code}: {detail}"
                if exc.code not in RETRYABLE_STATUS or attempt == self._settings.max_attempts:
                    break
            except (urllib.error.URLError, TimeoutError, OSError) as exc:
                last_error = f"{type(exc).__name__}: {exc}"
                if attempt == self._settings.max_attempts:
                    break
            time.sleep(min(2.0 * attempt, 8.0))

        self.last_error = last_error
        raise LlmUnavailableError(last_error or "model request failed")


def _first_message_content(raw: str) -> str:
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise LlmUnavailableError(f"model returned invalid JSON: {exc}") from exc

    choices = payload.get("choices")
    if not isinstance(choices, list) or not choices:
        raise LlmUnavailableError("model response contains no choices")
    message = choices[0].get("message") if isinstance(choices[0], dict) else None
    content = message.get("content") if isinstance(message, dict) else None
    if not isinstance(content, str) or not content.strip():
        raise LlmUnavailableError("model response contains no message content")
    return content


def _float_env(name: str, fallback: float) -> float:
    raw = (os.environ.get(name) or "").strip()
    if not raw:
        return fallback
    try:
        value = float(raw)
    except ValueError:
        return fallback
    return value if value > 0 else fallback


def _int_env(name: str, fallback: int) -> int:
    raw = (os.environ.get(name) or "").strip()
    if not raw:
        return fallback
    try:
        value = int(raw)
    except ValueError:
        return fallback
    return value if value > 0 else fallback


def _extra_body_env(name: str) -> tuple[tuple[str, Any], ...]:
    raw = (os.environ.get(name) or "").strip()
    if not raw:
        return ()
    try:
        value = json.loads(raw)
    except json.JSONDecodeError:
        return ()
    if not isinstance(value, dict):
        return ()
    # Never let the extra body override what the pipeline controls.
    return tuple((k, v) for k, v in value.items() if k not in {"model", "messages", "max_tokens", "temperature"})


def settings_from_env() -> LlmSettings | None:
    """Read model settings, or return ``None`` when the worker is unconfigured.

    ``PE_INGEST_LLM_BASE_URL`` points at the independently configured compatible
    endpoint. No web account, chat-provider settings or platform gateway is inferred.
    """

    base_url = (os.environ.get("PE_INGEST_LLM_BASE_URL") or "").strip()
    api_key = (os.environ.get("PE_INGEST_LLM_API_KEY") or "").strip()
    if not base_url or not api_key:
        return None
    if not base_url.startswith(("http://", "https://")):
        return None
    return LlmSettings(
        base_url=base_url,
        api_key=api_key,
        model=(os.environ.get("PE_INGEST_LLM_MODEL") or "").strip() or DEFAULT_MODEL,
        timeout_seconds=_float_env("PE_INGEST_LLM_TIMEOUT_SECONDS", DEFAULT_TIMEOUT_SECONDS),
        max_attempts=_int_env("PE_INGEST_LLM_MAX_ATTEMPTS", DEFAULT_MAX_ATTEMPTS),
        extra_body=_extra_body_env("PE_INGEST_LLM_EXTRA_BODY"),
    )


def build_chat_client_from_env() -> OpenAICompatibleChatClient | None:
    settings = settings_from_env()
    return OpenAICompatibleChatClient(settings) if settings else None


def extract_json_object(text: str) -> dict[str, Any]:
    """Pull the first balanced JSON object out of a model reply.

    Accepts fenced JSON objects and prose-wrapped replies.
    """

    if not text:
        raise ValueError("empty model reply")
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.split("\n", 1)[-1]
        if cleaned.endswith("```"):
            cleaned = cleaned[: -3]
        cleaned = cleaned.strip()

    start = cleaned.find("{")
    if start < 0:
        raise ValueError("model reply contains no JSON object")

    candidate = _balanced_object(cleaned, start)
    try:
        value = json.loads(candidate)
    except json.JSONDecodeError:
        # Models copying prose verbatim leave inner double quotes unescaped
        # (核心"增长公式"). Repair those and try once more.
        value = json.loads(_escape_inner_quotes(candidate))
    if not isinstance(value, dict):
        raise ValueError("model reply is not a JSON object")
    return value


def _balanced_object(text: str, start: int) -> str:
    depth = 0
    in_string = False
    escaped = False
    for index in range(start, len(text)):
        char = text[index]
        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            continue
        if char == '"':
            in_string = True
        elif char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return text[start : index + 1]
    # Unterminated: the repair pass may still recover it, so hand back the rest.
    return text[start:]


_STRING_END_FOLLOWERS = frozenset(",}]:")


def _escape_inner_quotes(text: str) -> str:
    """Escape double quotes that sit inside JSON string values.

    A quote closes a string only when the next non-space character is a
    structural one (comma, bracket, colon); any other quote inside a string
    is content the model forgot to escape.
    """

    out: list[str] = []
    in_string = False
    escaped = False
    length = len(text)
    for index, char in enumerate(text):
        if in_string:
            if escaped:
                escaped = False
                out.append(char)
                continue
            if char == "\\":
                escaped = True
                out.append(char)
                continue
            if char == '"':
                follower = index + 1
                while follower < length and text[follower] in " \t\r\n":
                    follower += 1
                if follower >= length or text[follower] in _STRING_END_FOLLOWERS:
                    in_string = False
                    out.append(char)
                else:
                    out.append('\\"')
                continue
            out.append(char)
            continue
        if char == '"':
            in_string = True
        out.append(char)
    return "".join(out)


__all__ = [
    "DEFAULT_MODEL",
    "LlmSettings",
    "LlmUnavailableError",
    "OpenAICompatibleChatClient",
    "build_chat_client_from_env",
    "extract_json_object",
    "settings_from_env",
]
