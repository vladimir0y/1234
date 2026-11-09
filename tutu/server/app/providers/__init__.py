from __future__ import annotations

from ..config import Settings
from .base import ImageProvider, ImageRequest, ProviderError, RateLimited

# "pc" (your own computer) is first whenever it is online; otherwise it is skipped.
DEFAULT_ORDER = ["pc", "cloudflare", "openai", "pollinations", "horde", "mock"]


def build_provider(name: str, settings: Settings) -> ImageProvider | None:
    """The provider if it is configured, else None."""
    from .cloudflare import CloudflareProvider
    from .horde import HordeProvider
    from .mock import MockProvider
    from .openai_images import OpenAIProvider
    from .pollinations import PollinationsProvider
    from .worker import HUB, WorkerProvider

    if name == "pc" and settings.worker_token and HUB.online():
        return WorkerProvider(HUB)
    if name == "cloudflare" and settings.cloudflare_account_id and settings.cloudflare_api_token:
        return CloudflareProvider(settings.cloudflare_account_id, settings.cloudflare_api_token)
    if name == "openai" and settings.openai_api_key:
        return OpenAIProvider(settings.openai_api_key, settings.openai_image_model)
    if name == "pollinations" and (settings.pollinations_key or settings.pollinations_anonymous):
        return PollinationsProvider(settings.pollinations_key)
    if name == "horde" and (settings.horde_api_key or settings.horde_enabled):
        return HordeProvider(settings.horde_api_key)
    if name == "mock":
        return MockProvider()
    return None


def provider_chain(settings: Settings, preferred: str | None = None, img2img: bool = False) -> list[ImageProvider]:
    """Providers to try in order. `preferred` (if configured) goes first.
    With `img2img`, only generators that can follow a guide image."""
    spec = (settings.image_provider or "auto").lower()
    order = DEFAULT_ORDER if spec == "auto" else [s.strip() for s in spec.split(",") if s.strip()]
    if "pc" not in order:
        order = ["pc"] + order
    if preferred:
        order = [preferred] + [o for o in order if o != preferred]
    chain = [p for p in (build_provider(n, settings) for n in order) if p is not None]
    if img2img:
        chain = [p for p in chain if getattr(p, "img2img", False)]
    # The offline generator is only a last resort when nothing real is configured.
    real = [p for p in chain if p.name != "mock"]
    return real or chain


__all__ = ["ImageProvider", "ImageRequest", "ProviderError", "RateLimited", "build_provider", "provider_chain"]
