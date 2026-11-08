import asyncio
import base64
import io
import json

import httpx
import numpy as np
import pytest
from PIL import Image, ImageDraw

from app.config import Settings
from app.imaging import to_tattoo_png
from app.providers import ImageRequest, RateLimited, provider_chain
from app.providers.cloudflare import CloudflareProvider
from app.providers.horde import HordeProvider
from app.providers.pollinations import PollinationsProvider

REQ = ImageRequest(prompt="swallow tattoo", negative="photo", size=512, seed=7)


def jpeg_line_art(bg=(235, 235, 235), color=(20, 20, 20)) -> bytes:
    im = Image.new("RGB", (400, 300), bg)
    d = ImageDraw.Draw(im)
    d.ellipse([150, 100, 250, 200], outline=color, width=6)
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=85)
    return buf.getvalue()


def run(coro):
    return asyncio.run(coro)


def test_cloudflare_generate_and_translate():
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        body = json.loads(request.content)
        if "m2m100" in request.url.path:
            assert body["source_lang"] == "uk" and body["target_lang"] == "en"
            return httpx.Response(200, json={"success": True, "result": {"translated_text": "a swallow"}})
        assert body["prompt"] == REQ.prompt and body["seed"] == 7
        return httpx.Response(200, json={"success": True, "result": {"image": base64.b64encode(b"IMG").decode()}})

    p = CloudflareProvider("acc", "tok", transport=httpx.MockTransport(handler))
    assert run(p.generate(REQ)) == b"IMG"
    assert run(p.translate("ластівка")) == "a swallow"
    assert seen[0].headers["authorization"] == "Bearer tok"
    assert "/accounts/acc/ai/run/@cf/black-forest-labs/flux-1-schnell" in seen[0].url.path


def test_cloudflare_rate_limit():
    p = CloudflareProvider("a", "t", transport=httpx.MockTransport(lambda r: httpx.Response(429, json={})))
    with pytest.raises(RateLimited):
        run(p.generate(REQ))


def test_pollinations_key_and_limits():
    def ok(request: httpx.Request) -> httpx.Response:
        assert request.headers["authorization"] == "Bearer pk"
        assert request.url.params["nologo"] == "true" and request.url.params["seed"] == "7"
        return httpx.Response(200, content=b"JPEG", headers={"content-type": "image/jpeg"})

    assert run(PollinationsProvider("pk", transport=httpx.MockTransport(ok)).generate(REQ)) == b"JPEG"
    limited = httpx.MockTransport(lambda r: httpx.Response(402, json={"error": {"code": "FREE_LIMIT"}}))
    with pytest.raises(RateLimited):
        run(PollinationsProvider(None, transport=limited).generate(REQ))


def test_horde_async_flow():
    calls = {"check": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path.endswith("/generate/async"):
            body = json.loads(request.content)
            assert "### photo" in body["prompt"] and request.headers["apikey"] == "0000000000"
            return httpx.Response(202, json={"id": "job1"})
        if "/generate/check/" in path:
            calls["check"] += 1
            return httpx.Response(200, json={"done": calls["check"] >= 2, "faulted": False})
        if "/generate/status/" in path:
            return httpx.Response(200, json={"generations": [{"img": base64.b64encode(b"WEBP").decode(), "censored": False}]})
        raise AssertionError(path)

    p = HordeProvider(None, transport=httpx.MockTransport(handler), poll_seconds=0)
    assert run(p.generate(REQ)) == b"WEBP"


def test_chain_order_and_opt_in(tmp_path):
    s = Settings(data_dir=tmp_path, image_provider="auto", openai_api_key="k",
                 cloudflare_account_id="a", cloudflare_api_token="t")
    assert [p.name for p in provider_chain(s)] == ["cloudflare", "openai"]
    assert [p.name for p in provider_chain(s, "openai")] == ["openai", "cloudflare"]
    # Anonymous Pollinations / Horde are opt-in; with nothing configured -> offline mock.
    bare = Settings(data_dir=tmp_path, image_provider="auto", openai_api_key=None)
    assert [p.name for p in provider_chain(bare)] == ["mock"]
    opted = Settings(data_dir=tmp_path, image_provider="auto", openai_api_key=None,
                     pollinations_anonymous=True, horde_enabled=True)
    assert [p.name for p in provider_chain(opted)] == ["pollinations", "horde"]


def test_fallback_to_next_provider(tmp_path):
    from app.jobs import JobRunner
    from app.providers.mock import MockProvider
    from app.storage import Storage

    class Broken:
        name, label, free = "broken", "Broken", True

        async def generate(self, req):
            raise RateLimited("limit")

    async def go():
        runner = JobRunner(Storage(tmp_path))
        job = runner.submit([Broken(), MockProvider()], "rose", "", "ink", 1, 3, 256)
        while job.status in ("queued", "running"):
            await asyncio.sleep(0.01)
        return job

    job = run(go())
    assert job.status == "done" and job.images[0]["provider"] == "mock"
    assert job.errors == ["broken: limit"]


def test_cleanup_ink_mode_removes_background_and_crops():
    out = Image.open(io.BytesIO(to_tattoo_png(jpeg_line_art(), "ink")))
    assert out.mode == "RGBA"
    a = np.asarray(out.getchannel("A"))
    assert out.size[0] < 200 and out.size[1] < 200  # cropped to the circle
    assert a[a.shape[0] // 2, a.shape[1] // 2] == 0  # inside of the ring is transparent
    assert a.max() == 255
    rgb = np.asarray(out)[..., :3][a > 128]
    assert rgb.max() < 30  # ink is black


def test_cleanup_color_mode_keeps_colours():
    out = Image.open(io.BytesIO(to_tattoo_png(jpeg_line_art(color=(200, 30, 30)), "color")))
    px = np.asarray(out)
    solid = px[px[..., 3] > 200]
    assert solid[:, 0].mean() > 150 and solid[:, 1].mean() < 90
    assert np.asarray(out.getchannel("A"))[0, 0] == 0
