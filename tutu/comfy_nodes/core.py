"""Tutu canvases for ComfyUI: body unwraps as images and masks (numpy + Pillow only).

A canvas is the flat unwrap of a body region exported from the Tutu editor
(window.tutu.canvasInfo(1000)): its outline, size and, for some canvases, joints.
Units are millimetres on the body; images are made at `width` pixels across the used area.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

HERE = Path(__file__).resolve().parent

# Used area of each canvas (units) and its zones as rectangles / polygons in units.
CANVASES = {
    # Torso around the body axis, cut along the left side: left half = back (seen from behind),
    # right half = chest (seen from the front), middle = right side.
    "wrap_torso": {
        "file": "wrap_torso.json", "area": (820, 717),
        "label": "Навколо тулуба (спина | бік | груди)",
        "zones": {
            "back": [(60, 0), (340, 0), (340, 717), (60, 717)],
            "right_side": [(340, 0), (450, 0), (450, 717), (340, 717)],
            "chest": [(450, 0), (800, 0), (800, 420), (450, 420)],
            "belly": [(450, 420), (800, 420), (800, 717), (450, 717)],
            "left_side": [(0, 0), (60, 0), (60, 717), (0, 717)],
            "lower_back": [(0, 520), (400, 520), (400, 717), (0, 717)],
            # where the dragon goes in the owner's composition: chest, belly, right side, lower back
            "dragon_area": [(345, 0), (820, 0), (820, 717), (0, 717), (0, 600), (345, 600)],
            "everything": [(0, 0), (820, 0), (820, 717), (0, 717)],
        },
    },
    "front_back_torso": {
        "file": "front_back_torso.json", "area": (1000, 315), "label": "Тулуб: спереду | ззаду",
        "zones": {
            "front": [(0, 0), (492, 0), (492, 315), (0, 315)],
            "back": [(508, 0), (1000, 0), (1000, 315), (508, 315)],
            "everything": [(0, 0), (1000, 0), (1000, 315), (0, 315)],
        },
    },
    "front_back_body": {
        "file": "front_back_body.json", "area": (1000, 662), "label": "Усе тіло: спереду | ззаду",
        "zones": {
            "front": [(0, 0), (492, 0), (492, 662), (0, 662)],
            "back": [(508, 0), (1000, 0), (1000, 662), (508, 662)],
            "everything": [(0, 0), (1000, 0), (1000, 662), (0, 662)],
        },
    },
}

# Layout presets (units of the wrap_torso canvas): rough colour zones only - where things go.
LAYOUTS = {
    "face_back_dragon_chest": {
        "canvas": "wrap_torso",
        "ellipses": [((60, 10, 345, 600), (70, 38, 26)),      # hair
                     ((110, 70, 300, 470), (150, 112, 92)),   # face
                     ((120, 80, 220, 300), (185, 150, 125))],  # light on the face
        "polygons": [([(455, 70), (560, 60), (700, 150), (715, 215), (630, 240), (600, 330), (540, 330), (480, 230)], (40, 42, 50)),  # dragon head
                     ([(600, 225), (700, 215), (650, 300)], (90, 60, 50))],                                                            # open jaws
        "path": ([(520, 320), (540, 450), (510, 560), (430, 610), (330, 600), (220, 625), (110, 600), (50, 500), (40, 350), (60, 200), (110, 80)],
                 60, (48, 50, 60)),                                                                                                      # dragon body
    },
}


@dataclass
class Canvas:
    name: str
    width: int
    height: int
    scale: float          # pixels per unit
    outline: list         # list of loops, each a list of (x, y) in units

    def px(self, pts):
        return [(x * self.scale, y * self.scale) for x, y in pts]


def load_canvas(name: str, width: int = 1024) -> Canvas:
    spec = CANVASES[name]
    info = json.loads((HERE / "canvases" / spec["file"]).read_text(encoding="utf-8"))
    aw, ah = spec["area"]
    scale = width / aw
    height = max(64, int(round(ah * scale / 64)) * 64)
    loops = []
    for seg in info["outline"].split("M")[1:]:
        nums = list(map(float, re.findall(r"-?\d+\.?\d*", seg)))
        loops.append(list(zip(nums[0::2], nums[1::2])))
    return Canvas(name, width, height, scale, loops)


def body_mask(c: Canvas) -> np.ndarray:
    """1 on the skin of the unwrap, 0 outside (float32 HxW)."""
    m = Image.new("L", (c.width, c.height), 0)
    d = ImageDraw.Draw(m)
    for lp in c.outline:
        d.polygon(c.px(lp), fill=255)
    return np.asarray(m, np.float32) / 255


def zone_mask(c: Canvas, zones: list[str], feather: int = 40, on_body: bool = True) -> np.ndarray:
    """Union of the named zones, with a soft edge of `feather` pixels."""
    m = Image.new("L", (c.width, c.height), 0)
    d = ImageDraw.Draw(m)
    for z in zones:
        d.polygon(c.px(CANVASES[c.name]["zones"][z]), fill=255)
    if feather > 0:
        m = m.filter(ImageFilter.GaussianBlur(feather / 2))
    a = np.asarray(m, np.float32) / 255
    if on_body:
        a = a * np.asarray(Image.fromarray((body_mask(c) * 255).astype(np.uint8)).filter(ImageFilter.MaxFilter(9)), np.float32) / 255
    return a


def silhouette(c: Canvas, skin=(224, 196, 172), background=(255, 255, 255)) -> np.ndarray:
    """RGB image of the unwrap: skin-coloured body on a plain background (float32 HxWx3, 0..1)."""
    m = body_mask(c)[..., None]
    return (np.array(skin, np.float32) * m + np.array(background, np.float32) * (1 - m)) / 255


def layout_guide(c: Canvas, preset: str, background: str = "dark", blur: int = 10) -> np.ndarray:
    """Colour zones that tell img2img where each element goes (float32 HxWx3, 0..1)."""
    L = LAYOUTS[preset]
    bg = (14, 14, 16) if background == "dark" else (255, 255, 255)
    g = Image.new("RGB", (c.width, c.height), bg)
    d = ImageDraw.Draw(g)
    for (x0, y0, x1, y1), col in L.get("ellipses", []):
        d.ellipse(c.px([(x0, y0), (x1, y1)]), fill=col)
    pts, w, col = L["path"]
    d.line(c.px(pts), fill=col, width=int(w * c.scale), joint="curve")
    d.line(c.px(pts), fill=tuple(min(255, v + 32) for v in col), width=int(w * c.scale * 0.27), joint="curve")
    for poly, col in L.get("polygons", []):
        d.polygon(c.px(poly), fill=col)
    if blur > 0:
        g = g.filter(ImageFilter.GaussianBlur(blur))
    return np.asarray(g, np.float32) / 255


def body_preview(c: Canvas, image: np.ndarray, skin=(224, 196, 172)) -> np.ndarray:
    """The image as ink on skin: multiplied into the skin inside the body, paper colour elsewhere."""
    img = np.asarray(Image.fromarray((np.clip(image, 0, 1) * 255).astype(np.uint8)).resize((c.width, c.height), Image.LANCZOS), np.float32) / 255
    m = body_mask(c)[..., None]
    sk = np.array(skin, np.float32) / 255
    out = sk * img * m + np.array([0.97, 0.97, 0.98], np.float32) * (1 - m)
    edge = Image.fromarray((m[..., 0] * 255).astype(np.uint8)).filter(ImageFilter.FIND_EDGES)
    e = (np.asarray(edge, np.float32) / 255)[..., None]
    return np.clip(out * (1 - e) + 0.55 * e, 0, 1)


def for_editor(c: Canvas, image: np.ndarray) -> Image.Image:
    """RGBA PNG for the Tutu editor: the image on the body (alpha = body), near-white paper made transparent."""
    img = np.asarray(Image.fromarray((np.clip(image, 0, 1) * 255).astype(np.uint8)).resize((c.width, c.height), Image.LANCZOS), np.float32)
    lum = img.mean(-1)
    alpha = np.clip((250 - lum) / 22, 0, 1) * body_mask(c)
    return Image.fromarray(np.dstack([img, alpha * 255]).astype(np.uint8), "RGBA")
