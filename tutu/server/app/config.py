"""Runtime settings, read from environment variables."""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path


@dataclass(frozen=True)
class Settings:
    data_dir: Path = field(default_factory=lambda: Path(os.getenv("TUTU_DATA_DIR", "./data")))
    image_provider: str = field(default_factory=lambda: os.getenv("TUTU_IMAGE_PROVIDER", "auto"))
    openai_api_key: str | None = field(default_factory=lambda: os.getenv("OPENAI_API_KEY"))
    openai_image_model: str = field(default_factory=lambda: os.getenv("TUTU_OPENAI_IMAGE_MODEL", "gpt-image-1"))
    max_scan_mb: int = field(default_factory=lambda: int(os.getenv("TUTU_MAX_SCAN_MB", "200")))
    cors_origins: list[str] = field(
        default_factory=lambda: os.getenv("TUTU_CORS_ORIGINS", "*").split(",")
    )


def get_settings() -> Settings:
    return Settings()
