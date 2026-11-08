"""Cloudflare Workers AI — FLUX.1 [schnell] (Apache-2.0, commercial use allowed).

Free plan: 10,000 neurons/day; one 1024px 4-step image costs ~50-150 neurons.
Also used for uk->en prompt translation (m2m100), from the same free allowance.
"""
from __future__ import annotations

import base64

import httpx

from .base import ImageRequest, ProviderError, RateLimited

API = "https://api.cloudflare.com/client/v4/accounts/{account}/ai/run/{model}"
FLUX = "@cf/black-forest-labs/flux-1-schnell"
TRANSLATE = "@cf/meta/m2m100-1.2b"


class CloudflareProvider:
    name = "cloudflare"
    label = "FLUX.1 schnell (Cloudflare)"
    free = True

    def __init__(self, account_id: str, token: str, transport: httpx.AsyncBaseTransport | None = None) -> None:
        self.account_id = account_id
        self.token = token
        self.transport = transport

    async def _run(self, model: str, payload: dict) -> dict:
        url = API.format(account=self.account_id, model=model)
        async with httpx.AsyncClient(timeout=120, transport=self.transport) as client:
            r = await client.post(url, headers={"Authorization": f"Bearer {self.token}"}, json=payload)
        if r.status_code == 429:
            raise RateLimited("Cloudflare: денний ліміт вичерпано")
        if r.status_code >= 400:
            raise ProviderError(f"Cloudflare {r.status_code}: {r.text[:200]}")
        data = r.json()
        if not data.get("success", True):
            raise ProviderError(f"Cloudflare: {data.get('errors')}")
        return data.get("result", data)

    async def generate(self, req: ImageRequest) -> bytes:
        # FLUX ignores negative prompts; quality steps max 8.
        result = await self._run(FLUX, {"prompt": req.prompt, "steps": 6, "seed": req.seed})
        image = result.get("image")
        if not image:
            raise ProviderError("Cloudflare: порожня відповідь")
        return base64.b64decode(image)

    async def translate(self, text: str, source: str = "uk") -> str:
        result = await self._run(TRANSLATE, {"text": text, "source_lang": source, "target_lang": "en"})
        return result.get("translated_text") or text
