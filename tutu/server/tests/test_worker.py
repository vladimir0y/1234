"""Your own computer as a generator, with fallback to the online ones."""
import asyncio
import base64
import io
import time

from fastapi.testclient import TestClient
from PIL import Image

from app.config import Settings
from app.main import create_app
from app.providers import provider_chain
from app.providers.worker import HUB


def png(color=(200, 30, 90), size=(64, 64)) -> bytes:
    b = io.BytesIO()
    Image.new("RGB", size, color).save(b, "PNG")
    return b.getvalue()


def settings(tmp_path, **kw):
    return Settings(data_dir=tmp_path, worker_token="t0k", **kw)


def test_pc_only_when_online(tmp_path):
    s = settings(tmp_path)
    HUB.last_seen = 0
    assert "pc" not in [p.name for p in provider_chain(s)]
    HUB.last_seen = time.time()
    assert provider_chain(s)[0].name == "pc"
    HUB.last_seen = 0


def test_worker_needs_token(tmp_path):
    client = TestClient(create_app(settings(tmp_path)))
    assert client.get("/api/worker/next?wait=0").status_code == 401
    assert client.get("/api/worker/next?wait=0", headers={"X-Tutu-Worker": "nope"}).status_code == 401
    r = client.get("/api/worker/next?wait=0&model=juggernaut", headers={"X-Tutu-Worker": "t0k"})
    assert r.status_code == 204
    st = client.get("/api/worker/status").json()
    assert st["online"] and st["model"] == "juggernaut"
    HUB.last_seen = 0


def test_hub_round_trip_and_timeout():
    async def run():
        HUB.last_seen = time.time()
        gen = asyncio.create_task(HUB.submit({"prompt": "x", "width": 64, "height": 64}, timeout=5))
        task = await HUB.next(1)
        assert task and task.payload["prompt"] == "x"
        assert HUB.finish(task.id, png())
        assert (await gen).startswith(b"\x89PNG")
        # nobody takes the task: the provider gives up so the chain can move on
        try:
            await HUB.submit({"prompt": "y"}, timeout=0.2)
        except Exception as e:
            assert "не встиг" in str(e)
        else:
            raise AssertionError("expected a timeout")
        HUB.last_seen = 0
    asyncio.run(run())


def test_guide_image_skips_generators_that_cannot_follow_it(tmp_path):
    s = Settings(data_dir=tmp_path, cloudflare_account_id="a", cloudflare_api_token="b", horde_enabled=True)
    HUB.last_seen = 0
    assert [p.name for p in provider_chain(s, img2img=True)] == ["horde"]
    client = TestClient(create_app(Settings(data_dir=tmp_path)))
    guide = base64.b64encode(png()).decode()
    r = client.post("/api/generate", json={"prompt": "dragon", "init_image": guide, "variants": 1, "raw_prompt": True})
    assert r.status_code == 200          # offline generator stands in when nothing else is configured
    r = client.post("/api/generate", json={"prompt": "dragon", "init_image": "%%%"})
    assert r.status_code == 400
