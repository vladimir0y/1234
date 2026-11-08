"""Realistic parametric body from the MakeHuman (CC0) base mesh and morph targets.

Each macro target describes the body of a population group (sex x muscle x
weight). A body is the base mesh plus a weighted sum of those targets, so the
proportions come from measured anatomy rather than hand-made shapes.
"""
from __future__ import annotations

import io
import json
import struct
from dataclasses import asdict, dataclass
from functools import lru_cache
from pathlib import Path

import numpy as np

ASSET = Path(__file__).parent / "assets" / "makehuman_body.npz"
LEVELS = ("min", "average", "max")


@dataclass(frozen=True)
class BodyParams:
    sex: float = 1.0  # 0 = female, 1 = male
    height_cm: float = 176.0
    weight: float = 0.5  # 0..1, 0.5 = average
    muscle: float = 0.5  # 0..1
    proportions: float = 0.5  # >0.5 more "ideal", <0.5 more uncommon
    breast: float = 0.5  # cup size, female only
    glutes: float = 0.0  # -1..1
    belly: float = 0.0  # -1..1

    def clamped(self) -> "BodyParams":
        c = lambda v, lo=0.0, hi=1.0: float(min(hi, max(lo, v)))  # noqa: E731
        return BodyParams(
            sex=c(self.sex), height_cm=c(self.height_cm, 140, 215), weight=c(self.weight),
            muscle=c(self.muscle), proportions=c(self.proportions), breast=c(self.breast),
            glutes=c(self.glutes, -1, 1), belly=c(self.belly, -1, 1),
        )


def _three(v: float) -> dict[str, float]:
    """Weights of the min/average/max targets for a 0..1 slider."""
    if v < 0.5:
        return {"min": 1 - 2 * v, "average": 2 * v, "max": 0.0}
    return {"min": 0.0, "average": 2 - 2 * v, "max": 2 * v - 1}


class BodyModel:
    def __init__(self, path: Path = ASSET) -> None:
        data = np.load(path)
        self.base = data["base"].astype(np.float64)
        quads = data["quads"].astype(np.int64)
        self.joint_names = [str(n) for n in data["joint_names"]]
        self.joints = {n: data[f"joint:{n}"].astype(np.int64) for n in self.joint_names}
        self.targets: dict[str, tuple[np.ndarray, np.ndarray]] = {}
        for key in data.files:
            if key.startswith("t:") and key.endswith(":i"):
                name = key[2:-2]
                self.targets[name] = (data[key].astype(np.int64), data[f"t:{name}:d"].astype(np.float64).reshape(-1, 3))
        # Compact body-only vertex list for the output mesh.
        body_ids = np.unique(quads)
        remap = -np.ones(len(self.base), dtype=np.int64)
        remap[body_ids] = np.arange(len(body_ids))
        self.body_ids = body_ids
        self.quads = remap[quads]

    # --- morphing ---------------------------------------------------------
    def _add(self, out: np.ndarray, name: str, w: float) -> None:
        if w <= 1e-6:
            return
        idx, delta = self.targets[name]
        np.add.at(out, idx, delta * w)

    def morph(self, p: BodyParams) -> np.ndarray:
        p = p.clamped()
        v = self.base.copy()
        sexes = {"female": 1 - p.sex, "male": p.sex}
        mus = _three(p.muscle)
        wei = _three(p.weight)
        # Height shape: average for the sex = 0.5; ±30 cm spans the range.
        mean_h = 164 + 12 * p.sex
        h = min(1.0, max(0.0, 0.5 + (p.height_cm - mean_h) / 60))
        hmin, hmax = max(0.0, 1 - 2 * h), max(0.0, 2 * h - 1)
        pu, pi = max(0.0, 1 - 2 * p.proportions), max(0.0, 2 * p.proportions - 1)
        cmin, cmax = max(0.0, 1 - 2 * p.breast), max(0.0, 2 * p.breast - 1)

        for s, sw in sexes.items():
            if sw <= 1e-6:
                continue
            for race in ("african", "asian", "caucasian"):
                self._add(v, f"macrodetails/{race}-{s}-young", sw / 3)
            for m, mw in mus.items():
                for w, ww in wei.items():
                    k = sw * mw * ww
                    if k <= 1e-6:
                        continue
                    combo = f"{s}-young-{m}muscle-{w}weight"
                    self._add(v, f"macrodetails/universal-{combo}", k)
                    self._add(v, f"macrodetails/height/{combo}-minheight", k * hmin)
                    self._add(v, f"macrodetails/height/{combo}-maxheight", k * hmax)
                    self._add(v, f"macrodetails/proportions/{combo}-idealproportions", k * pi)
                    self._add(v, f"macrodetails/proportions/{combo}-uncommonproportions", k * pu)
                    if s == "female":
                        self._add(v, f"breast/{combo}-mincup-averagefirmness", k * cmin)
                        self._add(v, f"breast/{combo}-maxcup-averagefirmness", k * cmax)
        self._add(v, "buttocks/buttocks-volume-incr", max(0.0, p.glutes))
        self._add(v, "buttocks/buttocks-volume-decr", max(0.0, -p.glutes))
        self._add(v, "stomach/stomach-pregnant-incr", max(0.0, p.belly) * 0.5)
        self._add(v, "stomach/stomach-pregnant-decr", max(0.0, -p.belly))
        return v

    def build(self, p: BodyParams, subdivisions: int = 1) -> "BodyMesh":
        p = p.clamped()
        v = self.morph(p)
        landmarks = {n: v[ids].mean(axis=0) for n, ids in self.joints.items()}
        positions = v[self.body_ids]
        # Feet on the floor, centred, exact requested height.
        lo, hi = positions.min(axis=0), positions.max(axis=0)
        offset = np.array([-(lo[0] + hi[0]) / 2, -lo[1], -(lo[2] + hi[2]) / 2])
        scale = (p.height_cm / 100) / (hi[1] - lo[1])
        positions = (positions + offset) * scale
        landmarks = {n: ((x + offset) * scale).tolist() for n, x in landmarks.items()}
        quads = self.quads
        for _ in range(subdivisions):
            positions, quads = catmull_clark(positions, quads)
        tris = np.concatenate([quads[:, [0, 1, 2]], quads[:, [0, 2, 3]]])
        return BodyMesh(positions.astype(np.float32), tris.astype(np.uint32), landmarks, p)


@dataclass
class BodyMesh:
    positions: np.ndarray
    triangles: np.ndarray
    landmarks: dict[str, list[float]]
    params: BodyParams

    def to_bytes(self) -> bytes:
        """TUTB format: magic, version, json header, then raw float32 xyz and uint32 triangles."""
        header = json.dumps({"landmarks": self.landmarks, "params": asdict(self.params)}).encode()
        header += b" " * (-len(header) % 4)
        buf = io.BytesIO()
        buf.write(b"TUTB")
        buf.write(struct.pack("<III", 1, len(header), 0))
        buf.write(header)
        buf.write(struct.pack("<II", len(self.positions), len(self.triangles)))
        buf.write(self.positions.astype("<f4").tobytes())
        buf.write(self.triangles.astype("<u4").tobytes())
        return buf.getvalue()


def catmull_clark(v: np.ndarray, quads: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """One level of Catmull–Clark subdivision on an all-quad mesh (open boundaries allowed)."""
    nv, nf = len(v), len(quads)
    face_pts = v[quads].mean(axis=1)

    a = quads.ravel()
    b = np.roll(quads, -1, axis=1).ravel()
    lo, hi = np.minimum(a, b), np.maximum(a, b)
    keys = lo * nv + hi
    uniq, edge_of = np.unique(keys, return_inverse=True)
    ne = len(uniq)
    e0, e1 = uniq // nv, uniq % nv
    face_of = np.repeat(np.arange(nf), 4)

    edge_faces = np.bincount(edge_of, minlength=ne)
    fsum = np.zeros((ne, 3))
    np.add.at(fsum, edge_of, face_pts[face_of])
    mid = (v[e0] + v[e1]) / 2
    boundary = edge_faces == 1
    edge_pts = np.where(boundary[:, None], mid, (v[e0] + v[e1] + fsum) / (2 + edge_faces[:, None]))

    # Vertex points.
    valence = np.bincount(np.concatenate([e0, e1]), minlength=nv).astype(np.float64)
    fcount = np.bincount(a, minlength=nv).astype(np.float64)
    favg = np.zeros((nv, 3))
    np.add.at(favg, a, face_pts[face_of])
    favg /= np.maximum(fcount, 1)[:, None]
    ravg = np.zeros((nv, 3))
    np.add.at(ravg, e0, mid)
    np.add.at(ravg, e1, mid)
    ravg /= np.maximum(valence, 1)[:, None]
    n = np.maximum(fcount, 1)[:, None]
    new_v = (favg + 2 * ravg + (n - 3) * v) / n

    on_boundary = np.zeros(nv, dtype=bool)
    on_boundary[e0[boundary]] = True
    on_boundary[e1[boundary]] = True
    if on_boundary.any():
        bsum = np.zeros((nv, 3))
        np.add.at(bsum, e0[boundary], v[e1[boundary]])
        np.add.at(bsum, e1[boundary], v[e0[boundary]])
        new_v[on_boundary] = 0.75 * v[on_boundary] + 0.125 * bsum[on_boundary]

    out_v = np.concatenate([new_v, edge_pts, face_pts])
    E = edge_of.reshape(nf, 4) + nv  # edge i goes from corner i to corner i+1
    Fi = np.arange(nf) + nv + ne
    new_q = []
    for i in range(4):
        new_q.append(np.stack([quads[:, i], E[:, i], Fi, E[:, (i - 1) % 4]], axis=1))
    return out_v, np.concatenate(new_q)


@lru_cache(maxsize=1)
def get_body_model() -> BodyModel:
    return BodyModel()


@lru_cache(maxsize=64)
def build_cached(params: BodyParams) -> bytes:
    return get_body_model().build(params).to_bytes()
