"""Runtime settings, read from environment variables."""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path


def _env(name: str, default: str | None = None) -> str | None:
    value = os.getenv(name, default)
    return value if value else default


@dataclass(frozen=True)
class Settings:
    data_dir: Path = field(default_factory=lambda: Path(os.getenv("TUTU_DATA_DIR", "./data")))
    # Comma-separated order of providers to try, or "auto" (every configured one,
    # free first). Example: TUTU_IMAGE_PROVIDERS=cloudflare,openai
    image_provider: str = field(default_factory=lambda: os.getenv("TUTU_IMAGE_PROVIDERS", os.getenv("TUTU_IMAGE_PROVIDER", "auto")))

    openai_api_key: str | None = field(default_factory=lambda: _env("OPENAI_API_KEY"))
    openai_image_model: str = field(default_factory=lambda: os.getenv("TUTU_OPENAI_IMAGE_MODEL", "gpt-image-1"))

    # Cloudflare Workers AI: free 10k neurons/day (~200 FLUX-schnell images).
    cloudflare_account_id: str | None = field(default_factory=lambda: _env("CLOUDFLARE_ACCOUNT_ID"))
    cloudflare_api_token: str | None = field(default_factory=lambda: _env("CLOUDFLARE_API_TOKEN"))

    # Pollinations: a key ("pollen") gives FLUX without watermark; anonymous is
    # rate-limited, watermarked and uses a weaker model, so it is opt-in.
    pollinations_key: str | None = field(default_factory=lambda: _env("POLLINATIONS_KEY"))
    pollinations_anonymous: bool = field(default_factory=lambda: os.getenv("TUTU_POLLINATIONS_ANON", "") == "1")

    # AI Horde: free volunteer GPUs. Anonymous key works but waits in a long queue;
    # prompts are visible to volunteer workers, so it is opt-in.
    horde_api_key: str | None = field(default_factory=lambda: _env("AI_HORDE_API_KEY"))
    horde_enabled: bool = field(default_factory=lambda: os.getenv("TUTU_HORDE", "") == "1")

    max_scan_mb: int = field(default_factory=lambda: int(os.getenv("TUTU_MAX_SCAN_MB", "200")))
    cors_origins: list[str] = field(
        default_factory=lambda: os.getenv("TUTU_CORS_ORIGINS", "*").split(",")
    )


def get_settings() -> Settings:
    return Settings()
