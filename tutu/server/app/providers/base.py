from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol


class ProviderError(Exception):
    """Generation failed; the next provider in the chain may be tried."""


class RateLimited(ProviderError):
    pass


@dataclass
class ImageRequest:
    prompt: str
    negative: str
    size: int
    seed: int


class ImageProvider(Protocol):
    name: str
    label: str
    free: bool

    async def generate(self, req: ImageRequest) -> bytes: ...
