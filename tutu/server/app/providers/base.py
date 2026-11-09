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
    width: int | None = None
    height: int | None = None
    # Guide image for img2img (PNG/WEBP bytes): keeps the composition's layout.
    init_image: bytes | None = None
    denoise: float = 0.6

    @property
    def dims(self) -> tuple[int, int]:
        """Width and height, multiples of 64."""
        w = self.width or self.size
        h = self.height or self.size
        return max(256, w // 64 * 64), max(256, h // 64 * 64)


class ImageProvider(Protocol):
    name: str
    label: str
    free: bool
    img2img: bool  # can follow a guide image

    async def generate(self, req: ImageRequest) -> bytes: ...
