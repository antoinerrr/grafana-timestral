"""Validated process configuration. Model and source revisions are not caller-controlled."""
from __future__ import annotations

from dataclasses import dataclass, field
import os
from pathlib import Path
from typing import Mapping

VERSION = "0.1.0"
MODEL_REVISIONS = {
    "5M": ("mistralai/Timestral-5M", "bdd20cfc15a3fea0e4cb5ccef37f8d3ca7aa335f"),
    "28M": ("mistralai/Timestral-28M", "49b26409ac87b5935539a5d8ffe7f397b720db47"),
}
SOURCE_REVISION = "a534bdbd244d64f3d9d743f46c7bf6fc330ed4ff"
MIN_CONTEXT = 64
MAX_CONTEXT = 32768
MAX_HORIZON = 2016
MAX_SERIES = 16
MAX_BODY_BYTES = 16 * 1024 * 1024


def _integer(env: Mapping[str, str], name: str, default: int, low: int, high: int) -> int:
    try:
        value = int(env.get(name, str(default)))
    except ValueError:
        raise ValueError(f"{name} must be an integer") from None
    if not low <= value <= high:
        raise ValueError(f"{name} must be between {low} and {high}")
    return value


@dataclass(frozen=True)
class Settings:
    model_variant: str = "5M"
    # Secrets must never appear in Settings reprs or diagnostics.
    api_token: str | None = field(default=None, repr=False)
    cache_dir: str = "/cache/huggingface"
    torch_threads: int = 4
    cache_ttl_seconds: int = 60
    cache_max_bytes: int = 64 * 1024 * 1024
    cache_max_entries: int = 32
    max_admitted_requests: int = 4
    queue_timeout_seconds: int = 30
    load_attempts: int = 3
    load_retry_seconds: int = 5

    def __post_init__(self):
        if self.model_variant not in MODEL_REVISIONS:
            raise ValueError("TIMESTRAL_MODEL must be 5M or 28M")
        if self.api_token is not None:
            if not 16 <= len(self.api_token) <= 4096 or any(not 33 <= ord(c) <= 126 for c in self.api_token):
                raise ValueError("TIMESTRAL_API_TOKEN must contain 16–4096 printable ASCII characters without whitespace")
        limits = {
            "torch_threads": (1, 128), "cache_ttl_seconds": (0, 86400),
            "cache_max_bytes": (0, 512 * 1024 * 1024), "cache_max_entries": (1, 256),
            "max_admitted_requests": (1, 16), "queue_timeout_seconds": (1, 120),
            "load_attempts": (1, 5), "load_retry_seconds": (1, 60),
        }
        for name, (low, high) in limits.items():
            value = getattr(self, name)
            if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
                raise ValueError(f"{name} must be an integer between {low} and {high}")
        if not self.cache_dir:
            raise ValueError("HF_HUB_CACHE must name a writable model-cache directory")

    @property
    def model_id(self) -> str:
        return MODEL_REVISIONS[self.model_variant][0]

    @property
    def model_revision(self) -> str:
        return MODEL_REVISIONS[self.model_variant][1]

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> "Settings":
        env = os.environ if env is None else env
        token = env.get("TIMESTRAL_API_TOKEN")
        token_file = env.get("TIMESTRAL_API_TOKEN_FILE")
        if token is not None and token_file is not None:
            raise ValueError("Configure only one of TIMESTRAL_API_TOKEN and TIMESTRAL_API_TOKEN_FILE")
        if token_file is not None:
            try:
                with Path(token_file).open("r", encoding="utf-8") as handle:
                    contents = handle.read(4099)
                if len(contents) > 4098:
                    raise ValueError("TIMESTRAL_API_TOKEN_FILE exceeds the token length limit")
                token = contents.rstrip("\r\n")
            except (OSError, UnicodeError):
                raise ValueError("TIMESTRAL_API_TOKEN_FILE could not be read") from None
        return cls(
            model_variant=env.get("TIMESTRAL_MODEL", "5M"), api_token=token,
            cache_dir=env.get("HF_HUB_CACHE", "/cache/huggingface"),
            torch_threads=_integer(env, "TORCH_NUM_THREADS", 4, 1, 128),
            cache_ttl_seconds=_integer(env, "TIMESTRAL_CACHE_TTL_SECONDS", 60, 0, 86400),
            cache_max_bytes=_integer(env, "TIMESTRAL_CACHE_MAX_MIB", 64, 0, 512) * 1024 * 1024,
            cache_max_entries=_integer(env, "TIMESTRAL_CACHE_MAX_ENTRIES", 32, 1, 256),
            max_admitted_requests=_integer(env, "TIMESTRAL_MAX_ADMITTED_REQUESTS", 4, 1, 16),
            queue_timeout_seconds=_integer(env, "TIMESTRAL_QUEUE_TIMEOUT_SECONDS", 30, 1, 120),
            load_attempts=_integer(env, "TIMESTRAL_LOAD_ATTEMPTS", 3, 1, 5),
            load_retry_seconds=_integer(env, "TIMESTRAL_LOAD_RETRY_SECONDS", 5, 1, 60),
        )
