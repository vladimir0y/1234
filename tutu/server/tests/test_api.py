import io

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.config import Settings
from app.main import create_app
from app.prompts import build_prompt, shape_hint_from_aspect


@pytest.fixture()
def client(tmp_path):
    settings = Settings(data_dir=tmp_path, image_provider="mock", openai_api_key=None)
    with TestClient(create_app(settings)) as c:
        yield c


def test_health(client):
    r = client.get("/api/health")
    assert r.status_code == 200
    assert r.json()["image_provider"] == "mock"


def run_job(client, body):
    import time
    r = client.post("/api/generate", json=body)
    assert r.status_code == 200, r.text
    job = r.json()
    for _ in range(200):
        job = client.get(f"/api/jobs/{job['id']}").json()
        if job["status"] in ("done", "error"):
            return job
        time.sleep(0.02)
    raise AssertionError("job did not finish")


def test_generate_job_returns_transparent_pngs(client):
    job = run_job(client, {"prompt": "lotus flower", "style": "geometric", "size": 256, "variants": 2})
    assert job["status"] == "done", job
    assert len(job["images"]) == 2 and job["images"][0]["provider"] == "mock"
    assert "geometric" in job["prompt"]
    img = client.get(job["images"][0]["url"])
    assert img.headers["content-type"] == "image/png"
    im = Image.open(io.BytesIO(img.content))
    assert im.mode == "RGBA"
    assert im.getchannel("A").getextrema() == (0, 255)


def test_generate_is_deterministic_with_seed(client):
    a = run_job(client, {"prompt": "moth", "size": 256, "seed": 7, "variants": 1})
    b = run_job(client, {"prompt": "moth", "size": 256, "seed": 7, "variants": 1})
    assert client.get(a["images"][0]["url"]).content == client.get(b["images"][0]["url"]).content


def test_generate_rejects_unknown_style(client):
    r = client.post("/api/generate", json={"prompt": "moth", "style": "nope"})
    assert r.status_code == 400


def test_unconfigured_provider_is_400(client):
    r = client.post("/api/generate", json={"prompt": "moth", "provider": "openai"})
    assert r.status_code == 400


def test_styles_and_providers(client):
    styles = client.get("/api/styles").json()
    assert len(styles) >= 12 and {s["mode"] for s in styles} == {"ink", "color"}
    assert client.get("/api/providers").json() == [{"id": "mock", "label": "Офлайн-орнамент (для розробки)", "free": True}]


def test_scan_upload_roundtrip(client):
    obj = b"v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n"
    r = client.post("/api/scans", files={"file": ("arm.obj", obj)}, data={"name": "Рука"})
    assert r.status_code == 200, r.text
    meta = r.json()
    assert meta["format"] == "obj" and meta["name"] == "Рука"
    assert client.get(f"/api/scans/{meta['id']}/mesh").content == obj
    assert len(client.get("/api/scans").json()) == 1
    assert client.delete(f"/api/scans/{meta['id']}").status_code == 200
    assert client.get(f"/api/scans/{meta['id']}").status_code == 404


def test_scan_rejects_bad_format(client):
    r = client.post("/api/scans", files={"file": ("x.exe", b"MZ")})
    assert r.status_code == 400


def test_path_traversal_ids_are_404(client):
    assert client.get("/api/scans/..%2F..%2Fetc").status_code == 404
    assert client.get("/api/images/notanid").status_code == 404


def test_project_crud(client):
    p = client.post("/api/projects", json={"name": "Рукав", "state": {"faces": [1, 2, 3]}}).json()
    assert p["state"]["faces"] == [1, 2, 3]
    u = client.put(f"/api/projects/{p['id']}", json={"name": "Рукав v2", "state": {"faces": [4]}}).json()
    assert u["name"] == "Рукав v2" and u["created_at"] == p["created_at"]
    assert client.get("/api/projects").json()[0]["name"] == "Рукав v2"
    assert client.delete(f"/api/projects/{p['id']}").status_code == 200
    assert client.get(f"/api/projects/{p['id']}").status_code == 404


def test_prompt_building():
    assert shape_hint_from_aspect(3.0) == "long horizontal band"
    assert shape_hint_from_aspect(1.0) == "roughly square"
    assert shape_hint_from_aspect(None) is None
    p = build_prompt("wolf", "blackwork", "tall vertical")
    assert p.startswith("flash sheet illustration on white paper of wolf, bold blackwork")
    assert "tall vertical" in p and "white background" in p and "black ink only" in p
    assert "black ink only" not in build_prompt("koi", "japanese")
