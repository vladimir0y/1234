from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from ..config import Settings


@dataclass
class GeneratedImage:
    png: bytes
    provider: str
    prompt: str


class ImageProvider(Protocol):
    name: str

    async def generate(self, prompt: str, size: int, seed: int | None) -> bytes: ...


def get_provider(settings: Settings, name: str | None = None) -> ImageProvider:
    from .mock import MockProvider
    from .openai_images import OpenAIProvider

    choice = (name or settings.image_provider or "auto").lower()
    if choice == "auto":
        choice = "openai" if settings.openai_api_key else "mock"
    if choice == "openai":
        if not settings.openai_api_key:
            raise ValueError("OPENAI_API_KEY is not set")
        return OpenAIProvider(settings.openai_api_key, settings.openai_image_model)
    if choice == "mock":
        return MockProvider()
    raise ValueError(f"Unknown image provider: {choice}")
