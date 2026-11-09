from __future__ import annotations

import base64

import httpx

from .base import ImageRequest, ProviderError, RateLimited


class OpenAIProvider:
    name = "openai"
    label = "OpenAI gpt-image (платний)"
    free = False
    img2img = False

    def __init__(self, api_key: str, model: str, transport: httpx.AsyncBaseTransport | None = None) -> None:
        self.api_key = api_key
        self.model = model
        self.transport = transport

    async def generate(self, req: ImageRequest) -> bytes:
        payload = {
            "model": self.model,
            "prompt": req.prompt,
            "size": "1024x1024",
            "n": 1,
            "background": "transparent",
            "output_format": "png",
        }
        async with httpx.AsyncClient(timeout=180, transport=self.transport) as client:
            r = await client.post(
                "https://api.openai.com/v1/images/generations",
                headers={"Authorization": f"Bearer {self.api_key}"},
                json=payload,
            )
        if r.status_code == 429:
            raise RateLimited("OpenAI: ліміт запитів")
        if r.status_code >= 400:
            raise ProviderError(f"OpenAI {r.status_code}: {r.text[:200]}")
        data = r.json()["data"][0]
        if "b64_json" in data:
            return base64.b64decode(data["b64_json"])
        async with httpx.AsyncClient(timeout=60, transport=self.transport) as client:
            img = await client.get(data["url"])
            img.raise_for_status()
            return img.content
