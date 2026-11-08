"""Export app/body/assets/makehuman_body.npz into a compact binary for the
browser-only (standalone) build of the editor.

    python scripts/export_body_bin.py  ->  ../web/standalone/body-model.bin

Layout (little endian): b"TUBM", u32 version, u32 header_len, JSON header,
then 4-byte aligned sections described by offsets in the header:
base float32[n*3], quads uint32[q*4], joint vertex ids uint32,
per target: ids uint16[count] and deltas int16[count*3] * scale (metres).
"""
from __future__ import annotations

import json
import struct
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]


def main() -> None:
    data = np.load(ROOT / "app" / "body" / "assets" / "makehuman_body.npz")
    chunks: list[bytes] = []
    offset = 0

    def add(arr: np.ndarray) -> int:
        nonlocal offset
        raw = arr.tobytes()
        raw += b"\0" * (-len(raw) % 4)
        start = offset
        chunks.append(raw)
        offset += len(raw)
        return start

    header: dict = {"vertices": int(len(data["base"])), "quads": int(len(data["quads"])), "joints": {}, "targets": {}}
    header["base"] = add(data["base"].astype("<f4"))
    header["quadsOffset"] = add(data["quads"].astype("<u4"))
    for name in data["joint_names"]:
        ids = data[f"joint:{name}"].astype("<u4")
        header["joints"][str(name)] = [add(ids), int(len(ids))]
    header["bones"] = []
    for i, name in enumerate(data["bone_names"]):
        ids = data[f"w:{name}:i"].astype("<u2")
        w = data[f"w:{name}:w"].astype("<f4")
        header["bones"].append({"name": str(name), "parent": int(data["bone_parent"][i]),
                                "joint": str(data["bone_joint"][i]), "ids": add(ids), "w": add(w), "count": int(len(ids))})
    for key in data.files:
        if not (key.startswith("t:") and key.endswith(":i")):
            continue
        name = key[2:-2]
        ids = data[key].astype("<u2")
        delta = data[f"t:{name}:d"].astype(np.float64).reshape(-1, 3)
        scale = float(np.abs(delta).max()) / 32767 if len(delta) else 1.0
        scale = scale or 1.0
        q = np.round(delta / scale).astype("<i2")
        header["targets"][name] = [add(ids), add(q), int(len(ids)), scale]

    head = json.dumps(header).encode()
    head += b" " * (-len(head) % 4)
    out = ROOT.parent / "web" / "standalone" / "body-model.bin"
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("wb") as f:
        f.write(b"TUBM")
        f.write(struct.pack("<II", 1, len(head)))
        f.write(head)
        for c in chunks:
            f.write(c)
    print(f"{out} {out.stat().st_size / 1e6:.1f} MB, {len(header['targets'])} targets")


if __name__ == "__main__":
    main()
