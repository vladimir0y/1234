"""Pollinations.ai. With a key: FLUX without watermark. Anonymous: 1 image / 45 s
per IP, watermark and a weaker model — development only."""
from __future__ import annotations

import asyncio
import re
from urllib.parse import quote

import httpx

from .base import ImageRequest, ProviderError, RateLimited

URL = "https://image.pollinations.ai/prompt/{prompt}"


class PollinationsProvider:
    name = "pollinations"
    label = "Pollinations (FLUX)"
    free = True
    img2img = False

    def __init__(self, key: str | None, transport: httpx.AsyncBaseTransport | None = None,
                 max_wait: float = 60) -> None:
        self.key = key
        self.transport = transport
        self.max_wait = max_wait

    async def generate(self, req: ImageRequest) -> bytes:
        try:
            return await self._once(req)
        except RateLimited as e:
            # Anonymous limit says "Retry after Ns": wait once instead of failing.
            m = re.search(r"after (\d+)s", str(e))
            wait = int(m.group(1)) + 1 if m else 46
            if wait > self.max_wait:
                raise
            await asyncio.sleep(wait)
            return await self._once(req)

    async def _once(self, req: ImageRequest) -> bytes:
        params = {"width": req.size, "height": req.size, "seed": req.seed, "nologo": "true",
                  "model": "flux", "private": "true", "safe": "true"}
        headers = {"Authorization": f"Bearer {self.key}"} if self.key else {}
        async with httpx.AsyncClient(timeout=180, transport=self.transport, follow_redirects=True) as client:
            r = await client.get(URL.format(prompt=quote(req.prompt, safe="")), params=params, headers=headers)
        if r.status_code in (402, 429):
            raise RateLimited(f"Pollinations: ліміт без ключа. {r.text[:200]}")
        if r.status_code >= 400 or not r.headers.get("content-type", "").startswith("image/"):
            raise ProviderError(f"Pollinations {r.status_code}: {r.text[:200]}")
        return r.content
