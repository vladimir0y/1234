"""Pack the MakeHuman (CC0) base body and the morph targets Tutu uses into one .npz.

Source data: the CC0 asset folder of MakeHuman / MPFB2
(https://github.com/makehumancommunity/mpfb2, src/mpfb/data). Only the assets
are used (CC0); no MakeHuman/MPFB code is copied.

    python scripts/build_body_assets.py /path/to/mpfb2/src/mpfb/data

Output: app/body/assets/makehuman_body.npz
"""
from __future__ import annotations

import gzip
import itertools
import sys
from pathlib import Path

import numpy as np

UNIT = 0.1  # MakeHuman units are decimetres
JOINTS = [
    "neck", "head", "pelvis", "spine-1", "spine-2", "spine-3", "spine-4",
    "l-clavicle", "r-clavicle", "l-shoulder", "r-shoulder", "l-elbow", "r-elbow", "l-hand", "r-hand",
    "l-upper-leg", "r-upper-leg", "l-knee", "r-knee", "l-ankle", "r-ankle",
]
MUSCLE = ["minmuscle", "averagemuscle", "maxmuscle"]
WEIGHT = ["minweight", "averageweight", "maxweight"]
SEXES = ["female", "male"]

# Skeleton for posing (MakeHuman "game_engine" rig, CC0): bone -> (parent, joint cube at its head).
BONES = {
    "pelvis": (None, "pelvis"),
    "spine_01": ("pelvis", "spine-4"),
    "spine_02": ("spine_01", "spine-3"),
    "spine_03": ("spine_02", "spine-2"),
    "neck_01": ("spine_03", "neck"),
    "head": ("neck_01", "head"),
}
for side in "lr":
    BONES.update({
        f"clavicle_{side}": ("spine_03", f"{side}-clavicle"),
        f"upperarm_{side}": (f"clavicle_{side}", f"{side}-shoulder"),
        f"lowerarm_{side}": (f"upperarm_{side}", f"{side}-elbow"),
        f"hand_{side}": (f"lowerarm_{side}", f"{side}-hand"),
        f"thigh_{side}": ("pelvis", f"{side}-upper-leg"),
        f"calf_{side}": (f"thigh_{side}", f"{side}-knee"),
        f"foot_{side}": (f"calf_{side}", f"{side}-ankle"),
    })


def merged_bone(name: str) -> str:
    """Fold fingers into the hand, toes into the foot, Root into the pelvis."""
    if name == "Root":
        return "pelvis"
    side = name[-1]
    if name.startswith(("thumb", "index", "middle", "ring", "pinky")):
        return f"hand_{side}"
    if name.startswith("ball"):
        return f"foot_{side}"
    return name


def target_names() -> list[str]:
    names = []
    for s, m, w in itertools.product(SEXES, MUSCLE, WEIGHT):
        names.append(f"macrodetails/universal-{s}-young-{m}-{w}")
        for h in ("minheight", "maxheight"):
            names.append(f"macrodetails/height/{s}-young-{m}-{w}-{h}")
        for p in ("idealproportions", "uncommonproportions"):
            names.append(f"macrodetails/proportions/{s}-young-{m}-{w}-{p}")
    for race, s in itertools.product(["african", "asian", "caucasian"], SEXES):
        names.append(f"macrodetails/{race}-{s}-young")
    for m, w, c in itertools.product(MUSCLE, WEIGHT, ["mincup", "maxcup"]):
        names.append(f"breast/female-young-{m}-{w}-{c}-averagefirmness")
    names += ["buttocks/buttocks-volume-incr", "buttocks/buttocks-volume-decr",
              "stomach/stomach-pregnant-incr", "stomach/stomach-pregnant-decr"]
    return names


def read_obj(path: Path):
    verts, groups, group = [], {}, None
    for line in path.read_text().splitlines():
        if line.startswith("v "):
            verts.append([float(x) for x in line.split()[1:4]])
        elif line.startswith("g "):
            group = line.split()[1]
        elif line.startswith("f "):
            groups.setdefault(group, []).append([int(t.split("/")[0]) - 1 for t in line.split()[1:]])
    return np.array(verts, dtype=np.float64), groups


def read_target(path: Path) -> tuple[np.ndarray, np.ndarray]:
    idx, delta = [], []
    with gzip.open(path, "rt") as f:
        for line in f:
            parts = line.split()
            if len(parts) != 4 or line.startswith("#"):
                continue
            idx.append(int(parts[0]))
            delta.append([float(x) for x in parts[1:]])
    return np.array(idx, dtype=np.int64), np.array(delta, dtype=np.float64)


def main(data_dir: str) -> None:
    root = Path(data_dir)
    verts, groups = read_obj(root / "3dobjs" / "base.obj")
    body_faces = np.array(groups["body"], dtype=np.int64)  # quads

    joint_vertex_sets = {}
    for j in JOINTS:
        faces = groups.get(f"joint-{j}")
        if not faces:
            raise SystemExit(f"missing joint group joint-{j}")
        joint_vertex_sets[j] = sorted({i for f in faces for i in f})

    used = sorted(set(body_faces.ravel().tolist()) | {i for s in joint_vertex_sets.values() for i in s})
    remap = -np.ones(len(verts), dtype=np.int64)
    remap[used] = np.arange(len(used))
    n_body = len(set(body_faces.ravel().tolist()))

    out: dict[str, np.ndarray] = {
        "base": (verts[used] * UNIT).astype(np.float32),
        "quads": remap[body_faces].astype(np.int32),
        "joint_names": np.array(JOINTS),
    }
    for j, ids in joint_vertex_sets.items():
        out[f"joint:{j}"] = remap[ids].astype(np.int32)

    # Skin weights, folded onto the posing bones.
    bone_names = list(BONES)
    weights = __import__("json").loads((root / "rigs" / "standard" / "weights.game_engine.json").read_text())["weights"]
    acc: dict[str, dict[int, float]] = {b: {} for b in bone_names}
    for src, pairs in weights.items():
        b = merged_bone(src)
        for vid, w in pairs:
            if remap[vid] >= 0:
                acc[b][int(remap[vid])] = acc[b].get(int(remap[vid]), 0.0) + float(w)
    out["bone_names"] = np.array(bone_names)
    out["bone_parent"] = np.array([bone_names.index(BONES[b][0]) if BONES[b][0] else -1 for b in bone_names], dtype=np.int32)
    out["bone_joint"] = np.array([BONES[b][1] for b in bone_names])
    for b in bone_names:
        ids = np.array(sorted(acc[b]), dtype=np.uint16)
        out[f"w:{b}:i"] = ids
        out[f"w:{b}:w"] = np.array([acc[b][i] for i in ids.tolist()], dtype=np.float16)

    names = target_names()
    for name in names:
        idx, delta = read_target(root / "targets" / f"{name}.target.gz")
        keep = remap[idx] >= 0
        out[f"t:{name}:i"] = remap[idx[keep]].astype(np.uint16)
        out[f"t:{name}:d"] = (delta[keep] * UNIT).astype(np.float16)

    dest = Path(__file__).resolve().parents[1] / "app" / "body" / "assets" / "makehuman_body.npz"
    np.savez_compressed(dest, **out)
    print(f"{len(used)} vertices ({n_body} body), {len(body_faces)} quads, {len(names)} targets -> {dest} "
          f"({dest.stat().st_size / 1e6:.1f} MB)")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "../mpfb2/src/mpfb/data")
