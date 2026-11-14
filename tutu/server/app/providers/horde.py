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


def _webp_b64(data: bytes, w: int, h: int, grey: bool = False) -> str:
    from io import BytesIO

    from PIL import Image

    img = Image.open(BytesIO(data)).convert("L" if grey else "RGB").resize((w, h))
    out = BytesIO()
    img.save(out, "WEBP", quality=92)
    return base64.b64encode(out.getvalue()).decode()


class HordeProvider:
    name = "horde"
    label = "AI Horde (SDXL)"
    free = True
    img2img = True

    def __init__(self, key: str | None, transport: httpx.AsyncBaseTransport | None = None,
                 poll_seconds: float = 5, timeout_seconds: float = 900) -> None:
        self.key = key or ANON
        self.transport = transport
        self.poll = poll_seconds
        self.timeout = timeout_seconds

    async def generate(self, req: ImageRequest) -> bytes:
        headers = {"apikey": self.key, "Client-Agent": "tutu:0.2:https://github.com/vladimir0y/1234"}
        w, h = req.dims
        if self.key == ANON and w * h > 832 * 1088:  # anonymous requests have a size cap
            k = (832 * 1088 / (w * h)) ** 0.5
            w, h = max(256, int(w * k) // 64 * 64), max(256, int(h * k) // 64 * 64)
        params = {"width": w, "height": h, "steps": 28, "cfg_scale": 6,
                  "sampler_name": "k_euler_a", "seed": str(req.seed), "n": 1, "karras": True}
        payload = {
            "prompt": f"{req.prompt} ### {req.negative}" if req.negative else req.prompt,
            "params": params,
            "models": MODELS, "r2": False, "nsfw": False, "censor_nsfw": False,
        }
        if req.init_image:
            payload["source_image"] = _webp_b64(req.init_image, w, h)
            payload["source_processing"] = "img2img"
            params["denoising_strength"] = req.denoise
            if req.mask:  # masked img2img: only the white part is repainted
                payload["source_mask"] = _webp_b64(req.mask, w, h, grey=True)
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
        if not gens or gens[0].get("censored"):  # false positives happen on skin tones
            raise ProviderError("AI Horde: немає результату")
        return base64.b64decode(gens[0]["img"])
