"""Offline generator: draws deterministic ornamental line art from the prompt.

Lets the whole product flow work without an API key (dev, tests, demos).
"""
from __future__ import annotations

import hashlib
import io
import math
import random

from PIL import Image, ImageDraw


class MockProvider:
    name = "mock"
    label = "Офлайн-орнамент (для розробки)"
    free = True

    async def generate(self, req) -> bytes:  # noqa: ANN001 - ImageRequest
        return render_ornament(req.prompt, min(req.size, 1024), req.seed)


def render_ornament(prompt: str, size: int = 1024, seed: int | None = None) -> bytes:
    h = int(hashlib.sha256(f"{prompt}|{seed}".encode()).hexdigest(), 16)
    rng = random.Random(h)
    scale = 4  # supersample for smooth lines
    s = size * scale
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    cx = cy = s / 2
    ink = (12, 12, 14, 255)
    w = max(2, int(s * 0.004))

    symmetry = rng.choice([5, 6, 8, 10, 12])
    rings = rng.randint(3, 5)
    radius = s * 0.44

    # Petal rings
    for ring in range(rings):
        r_out = radius * (1 - ring / (rings + 0.6))
        r_in = r_out * rng.uniform(0.45, 0.75)
        petals = symmetry * rng.choice([1, 2])
        bulge = rng.uniform(0.25, 0.6)
        offset = rng.random() * math.pi
        for k in range(petals):
            a0 = offset + 2 * math.pi * k / petals
            pts = []
            for t in [i / 24 for i in range(25)]:
                ang = a0 + (t - 0.5) * (2 * math.pi / petals) * (1 + bulge)
                rr = r_in + (r_out - r_in) * math.sin(math.pi * t)
                pts.append((cx + rr * math.cos(ang), cy + rr * math.sin(ang)))
            d.line(pts, fill=ink, width=w, joint="curve")
        if rng.random() < 0.6:
            d.ellipse([cx - r_in, cy - r_in, cx + r_in, cy + r_in], outline=ink, width=w)

    # Dotwork ring
    dots_r = radius * rng.uniform(0.2, 0.35)
    n_dots = symmetry * 4
    for k in range(n_dots):
        a = 2 * math.pi * k / n_dots
        x, y = cx + dots_r * math.cos(a), cy + dots_r * math.sin(a)
        r = w * 1.6
        d.ellipse([x - r, y - r, x + r, y + r], fill=ink)

    # Solid core
    core = radius * 0.08
    d.ellipse([cx - core, cy - core, cx + core, cy + core], fill=ink)

    img = img.resize((size, size), Image.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()
