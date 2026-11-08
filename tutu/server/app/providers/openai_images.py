from __future__ import annotations

import base64

import httpx


class OpenAIProvider:
    name = "openai"

    def __init__(self, api_key: str, model: str) -> None:
        self.api_key = api_key
        self.model = model

    async def generate(self, prompt: str, size: int, seed: int | None) -> bytes:
        dim = "1024x1024" if size <= 1024 else "1536x1024"
        payload = {
            "model": self.model,
            "prompt": prompt,
            "size": dim,
            "n": 1,
            "background": "transparent",
            "output_format": "png",
        }
        async with httpx.AsyncClient(timeout=120) as client:
            r = await client.post(
                "https://api.openai.com/v1/images/generations",
                headers={"Authorization": f"Bearer {self.api_key}"},
                json=payload,
            )
        if r.status_code >= 400:
            raise RuntimeError(f"OpenAI error {r.status_code}: {r.text[:300]}")
        data = r.json()["data"][0]
        if "b64_json" in data:
            return base64.b64decode(data["b64_json"])
        async with httpx.AsyncClient(timeout=60) as client:
            img = await client.get(data["url"])
            img.raise_for_status()
            return img.content
