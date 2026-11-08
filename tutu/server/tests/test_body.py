import struct

import numpy as np
import pytest
from fastapi.testclient import TestClient

from app.body import BODY_PRESETS, BodyParams, get_body_model
from app.config import Settings
from app.main import create_app


def volume(positions, tris):
    p = positions.astype(np.float64)
    return float(np.sum(np.einsum("ij,ij->i", p[tris[:, 0]], np.cross(p[tris[:, 1]], p[tris[:, 2]]))) / 6)


def parse(blob: bytes):
    assert blob[:4] == b"TUTB"
    _, hlen, _ = struct.unpack_from("<III", blob, 4)
    off = 16 + hlen
    nv, nt = struct.unpack_from("<II", blob, off)
    off += 8
    pos = np.frombuffer(blob, "<f4", nv * 3, off).reshape(-1, 3)
    tris = np.frombuffer(blob, "<u4", nt * 3, off + nv * 12).reshape(-1, 3)
    return pos, tris


def test_ten_presets():
    assert len([p for p in BODY_PRESETS if p["params"]["sex"] == 1]) == 5
    assert len([p for p in BODY_PRESETS if p["params"]["sex"] == 0]) == 5


@pytest.mark.parametrize("preset", BODY_PRESETS, ids=lambda p: p["id"])
def test_preset_is_realistic(preset):
    body = get_body_model().build(BodyParams(**preset["params"]))
    pos, tris = body.positions, body.triangles
    height = pos[:, 1].max() - pos[:, 1].min()
    assert height == pytest.approx(preset["params"]["height_cm"] / 100, abs=0.002)
    # Body volume in litres ~ body mass in kg (density ~1): realistic adult range.
    litres = volume(pos, tris) * 1000
    assert 40 < litres < 130, litres
    # Outward-facing triangles.
    assert volume(pos, tris) > 0
    # Anatomical landmarks: shoulders above elbows above hands, knees between hips and ankles.
    lm = body.landmarks
    for side in "lr":
        assert lm[f"{side}-shoulder"][1] > lm[f"{side}-elbow"][1] > lm[f"{side}-hand"][1]
        assert lm[f"{side}-upper-leg"][1] > lm[f"{side}-knee"][1] > lm[f"{side}-ankle"][1]
    # Legs are roughly half of the height (real proportion: 0.45..0.53).
    leg = lm["l-upper-leg"][1] / height
    assert 0.42 < leg < 0.56, leg


def test_weight_and_sex_change_shape():
    m = get_body_model()
    slim = m.build(BodyParams(sex=1, weight=0.1))
    heavy = m.build(BodyParams(sex=1, weight=1.0))
    assert volume(heavy.positions, heavy.triangles) > 1.15 * volume(slim.positions, slim.triangles)
    male = m.build(BodyParams(sex=1, height_cm=170))
    female = m.build(BodyParams(sex=0, height_cm=170))
    shoulders = lambda b: b.landmarks["l-shoulder"][0] - b.landmarks["r-shoulder"][0]  # noqa: E731
    assert shoulders(male) > shoulders(female)


def test_mesh_endpoint(tmp_path):
    client = TestClient(create_app(Settings(data_dir=tmp_path, image_provider="mock", openai_api_key=None)))
    assert len(client.get("/api/bodies/presets").json()) == 10
    r = client.get("/api/bodies/mesh", params={"preset": "f-curvy", "height_cm": 158})
    assert r.status_code == 200
    pos, tris = parse(r.content)
    assert pos[:, 1].max() == pytest.approx(1.58, abs=0.002)
    assert tris.max() < len(pos)
    assert client.get("/api/bodies/mesh", params={"preset": "nope"}).status_code == 404
