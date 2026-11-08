"""AI Horde (stablehorde): free community GPUs, asynchronous queue.

Anonymous requests wait at the end of the queue (often 5-15 minutes);
a free registered key earns priority. Prompts are seen by volunteer workers.
"""
from __future__ import annotations

import asyncio
import base64

import httpx

from .base import ImageRequest, ProviderError

API = "https://aihorde.net/api/v2"
ANON = "0000000000"
MODELS = ["AlbedoBase XL 3.1", "Juggernaut XL", "stable_diffusion"]


class HordeProvider:
    name = "horde"
    label = "AI Horde (SDXL)"
    free = True

    def __init__(self, key: str | None, transport: httpx.AsyncBaseTransport | None = None,
                 poll_seconds: float = 5, timeout_seconds: float = 900) -> None:
        self.key = key or ANON
        self.transport = transport
        self.poll = poll_seconds
        self.timeout = timeout_seconds

    async def generate(self, req: ImageRequest) -> bytes:
        headers = {"apikey": self.key, "Client-Agent": "tutu:0.2:https://github.com/vladimir0y/1234"}
        size = 1024 if self.key != ANON else 768
        payload = {
            "prompt": f"{req.prompt} ### {req.negative}" if req.negative else req.prompt,
            "params": {"width": size, "height": size, "steps": 25, "cfg_scale": 6,
                       "sampler_name": "k_euler_a", "seed": str(req.seed), "n": 1},
            "models": MODELS, "r2": False, "nsfw": False, "censor_nsfw": True,
        }
        async with httpx.AsyncClient(timeout=60, transport=self.transport) as client:
            r = await client.post(f"{API}/generate/async", headers=headers, json=payload)
            if r.status_code >= 400:
                raise ProviderError(f"AI Horde {r.status_code}: {r.text[:200]}")
            job = r.json()["id"]
            waited = 0.0
            try:
                while waited < self.timeout:
                    check = (await client.get(f"{API}/generate/check/{job}")).json()
                    if check.get("faulted"):
                        raise ProviderError("AI Horde: задача завершилась з помилкою")
                    if check.get("done"):
                        break
                    await asyncio.sleep(self.poll)
                    waited += self.poll
                else:
                    raise ProviderError("AI Horde: черга задовга")
                status = (await client.get(f"{API}/generate/status/{job}")).json()
            except BaseException:
                await client.delete(f"{API}/generate/status/{job}")  # free the queue slot
                raise
        gens = status.get("generations") or []
        if not gens or gens[0].get("censored"):
            raise ProviderError("AI Horde: немає результату")
        return base64.b64decode(gens[0]["img"])
