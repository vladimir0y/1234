"""Turn any generated picture into a tattoo-ready transparent PNG.

Free models return JPEGs on white/grey backgrounds, sometimes with frames.
This keeps the design, removes the background and crops to the design, so
every provider's result drops straight onto the skin.
"""
from __future__ import annotations

import io

import numpy as np
from PIL import Image, ImageDraw, ImageFilter


LUMA = np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)


def _outer_background(img: Image.Image, tolerance: int = 28) -> np.ndarray:
    """Mask of the background connected to the image border (magic-wand from the edges)."""
    small = img.convert("RGB")
    scale = 1.0
    if max(small.size) > 512:
        scale = 512 / max(small.size)
        small = small.resize((max(1, int(small.width * scale)), max(1, int(small.height * scale))), Image.BILINEAR)
    small = small.filter(ImageFilter.MedianFilter(3))
    marker = (255, 0, 255)
    w, h = small.size
    seeds = [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1), (w // 2, 0), (w // 2, h - 1), (0, h // 2), (w - 1, h // 2)]
    for x, y in seeds:
        if small.getpixel((x, y)) != marker:
            ImageDraw.floodfill(small, (x, y), marker, thresh=tolerance)
    m = np.all(np.asarray(small) == marker, axis=-1)
    # Grow the background a little to swallow anti-aliased frame edges.
    mask = Image.fromarray((m * 255).astype(np.uint8)).filter(ImageFilter.MaxFilter(5))
    mask = mask.resize(img.size, Image.BILINEAR)
    return np.asarray(mask).astype(np.float32) / 255


def to_tattoo_png(data: bytes, mode: str = "ink", max_side: int = 1024, pad: float = 0.04) -> bytes:
    img = Image.open(io.BytesIO(data))
    img.load()
    has_alpha = img.mode in ("RGBA", "LA") or "transparency" in img.info
    img = img.convert("RGBA")
    if max(img.size) > max_side:
        img.thumbnail((max_side, max_side), Image.LANCZOS)
    arr = np.asarray(img).astype(np.float32) / 255
    rgb, alpha_in = arr[..., :3], arr[..., 3]

    if has_alpha and alpha_in.min() < 0.5:
        alpha = alpha_in  # provider already gave transparency
    else:
        outside = _outer_background(img)  # 1 = background reached from the edges
        inside = outside < 0.5
        lum = rgb @ LUMA
        ref = lum[inside] if inside.mean() > 0.02 else lum.ravel()
        paper = float(np.percentile(ref, 90))  # the "paper" colour of the artwork
        if mode == "ink":
            darkest = float(np.percentile(ref, 2))
            span = max(paper - darkest - 0.05, 0.15)
            alpha = np.clip((paper - lum - 0.05) / span, 0, 1)
        else:
            paper_rgb = np.median(rgb[inside & (np.abs(lum - paper) < 0.04)], axis=0) if inside.any() else np.ones(3)
            dist = np.linalg.norm(rgb - paper_rgb, axis=-1)
            alpha = np.clip((dist - 0.08) / 0.17, 0, 1)
        alpha = alpha * (1 - outside)

    if mode == "ink":
        # Black ink, slightly sharpened coverage curve for crisp lines.
        alpha = np.clip(alpha * 1.15, 0, 1) ** 0.9
        out = np.zeros_like(arr)
        out[..., :3] = 0.04
        out[..., 3] = alpha
    else:
        out = np.concatenate([rgb, alpha[..., None]], axis=-1)

    res = Image.fromarray((out * 255).astype(np.uint8), "RGBA")
    # Remove speckles and crop to the design.
    mask = res.getchannel("A").point(lambda a: 255 if a > 24 else 0).filter(ImageFilter.MinFilter(3)).filter(ImageFilter.MaxFilter(3))
    box = mask.getbbox()
    if box:
        w, h = res.size
        p = int(max(w, h) * pad)
        box = (max(0, box[0] - p), max(0, box[1] - p), min(w, box[2] + p), min(h, box[3] + p))
        res = res.crop(box)
    buf = io.BytesIO()
    res.save(buf, "PNG", optimize=True)
    return buf.getvalue()
