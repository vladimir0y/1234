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
        # Measured along the skin (editor's surface wrap): one turn = 787 units, 882 tall.
        # Zones and layouts below are drawn on the earlier angle-based canvas; "design" maps them
        # here (x' = x + 14, y' = 1.034 y + 52.6: fitted on the skeleton's joints, error < 4 units).
        "file": "wrap_torso.json", "area": (787, 882), "design": (1.0, 14.0, 1.034, 52.6),
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
            # head of `one_dragon_around_torso` with its back of the head and jaws, for repainting only
            # the head (r14: masked repaint at denoise 0.65-0.75 removed the classic horns and whiskers)
            "dragon_head": [(465, 20), (585, 15), (690, 70), (745, 200), (715, 260), (625, 320), (525, 315), (475, 220)],
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
    # Owner's target reference: a face filling the whole back in black and deep red with a red moon
    # and clouds; the dragon's head on the right pec, its body going up over the right shoulder.
    "reference_red_back_dragon_chest": {
        "canvas": "wrap_torso",
        # r05: the moon at (60..200, 160..300) landed on the forehead -> now upper left, outside the face
        "ellipses": [((10, 80, 390, 717), (55, 30, 30)),       # dark hair mass, whole back
                     ((35, 55, 150, 170), (150, 30, 25)),      # red moon, peeks out above-left of the head
                     ((90, 170, 330, 600), (170, 120, 105)),   # face, centred on the spine (x~200)
                     ((95, 170, 210, 420), (200, 150, 130))],  # light on the cheek
        # r03-r05: a solid red ellipse turned into cartoon cloud puffs -> noise texture reads as real smoke
        "smoke": [((0, 540, 400, 717), (110, 45, 40)),         # red smoke rising from the lower back
                  ((340, 380, 470, 600), (90, 80, 80))],       # grey smoke on the right side linking back and chest
        "polygons": [([(440, 70), (520, 40), (620, 90), (650, 170), (600, 230), (545, 300), (500, 290), (470, 200)], (35, 25, 25)),  # head on the right pec
                     ([(560, 205), (630, 185), (600, 265)], (75, 25, 25))],                                                       # open jaws (darker: r05 drew a red blob here)
        "path": ([(500, 300), (470, 200), (455, 110), (430, 40), (410, 0)], 110, (40, 28, 28)),                                   # thick neck up over the right shoulder
    },
    # Owner's request after r05: ONE long dragon wrapping the torso (like a serpent bodysuit):
    # head on the right pec, neck over the right shoulder; the body comes back over the upper back
    # above the girl's head, runs down the left side, crosses the belly and curls under the head.
    # The canvas is a cylinder: x=0 and x=820 are the same line on the left side, so the body
    # leaves at x<0 and comes back at x>820.
    "one_dragon_around_torso": {
        "canvas": "wrap_torso",
        "shade_head": True,
        "ellipses": [((55, 190, 385, 625), (55, 30, 30)),      # hair, ends above the buttocks (r12 on the body)
                     ((81, 65, 221, 201), (150, 30, 25)),      # big red moon behind the hair, upper left (r10: dot on the face; r13: still touched the forehead)
                     ((70, 265, 350, 525), (170, 120, 105))],  # face wider than tall on the canvas: the curved back narrows it on the body (c3) (r06: a pale cheek ellipse became a white disc -> removed)
        "smoke": [((60, 540, 380, 670), (110, 45, 40))],       # red smoke at the lower back
        "paths": [
            # neck + back in ONE stroke: up from the head, over the right shoulder through the ~10 cm
            # strip between the top edge and the armpit hole (the old neck ran through the hole and was
            # cut there), across the shoulder blades above the girl's head, down the left side
            ([(526, 268), (521, 191), (514, 114), (503, 63), (481, 38), (438, 15), (386, 5), (336, 11), (296, 46), (246, 94), (186, 104), (126, 128), (104, 181), (98, 249), (66, 307), (6, 346), (-64, 384)], 72, (40, 28, 28)),
            # continues on the front from the left side, across the belly, curls up under the head
            # (enters at the right edge at the height where the back stroke leaves the left edge)
            ([(880, 320), (780, 356), (680, 440), (570, 495), (490, 450), (470, 420), (500, 370), (560, 380), (600, 430)], 95, (40, 28, 28)),
            # thin tail from the bottom of the coil (r06: starting at the jaws it read as a tongue)
            ([(690, 505), (720, 580), (715, 650), (690, 717)], 30, (45, 30, 30)),
        ],
        "polygons": [([(485, 85), (580, 55), (665, 110), (725, 215), (675, 240), (590, 300), (530, 285), (495, 195)], (35, 25, 25)),  # long viper-like wedge on the right pec (r10: a chunky head shape got horns)
                     ([(610, 205), (680, 185), (650, 265)], (75, 25, 25))],                                                       # open jaws
    },
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
    design: tuple = (1.0, 0.0, 1.0, 0.0)  # design grid -> canvas units: x*sx+ox, y*sy+oy (zones, layouts)

    def px(self, pts):
        """Canvas units -> pixels (the outline)."""
        return [(x * self.scale, y * self.scale) for x, y in pts]

    def dpx(self, pts):
        """Design-grid units (zones, layouts) -> pixels."""
        sx, ox, sy, oy = self.design
        return [((x * sx + ox) * self.scale, (y * sy + oy) * self.scale) for x, y in pts]


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
    return Canvas(name, width, height, scale, loops, spec.get("design", (1.0, 0.0, 1.0, 0.0)))


def body_mask(c: Canvas) -> np.ndarray:
    """1 on the skin of the unwrap, 0 outside (float32 HxW)."""
    # even-odd: inner loops are holes (the armpits, where the arms are cut off), not skin
    a = np.zeros((c.height, c.width), bool)
    for lp in c.outline:
        m = Image.new("1", (c.width, c.height), 0)
        ImageDraw.Draw(m).polygon(c.px(lp), fill=1)
        a ^= np.asarray(m, bool)
    return a.astype(np.float32)


def zone_mask(c: Canvas, zones: list[str], feather: int = 40, on_body: bool = True) -> np.ndarray:
    """Union of the named zones, with a soft edge of `feather` pixels."""
    m = Image.new("L", (c.width, c.height), 0)
    d = ImageDraw.Draw(m)
    for z in zones:
        if z == "dragon_body":
            continue
        d.polygon(c.dpx(CANVASES[c.name]["zones"][z]), fill=255)
    if "dragon_body" in zones:
        # r18: dragon_area also covered the head and repainted it back into a classic one ->
        # the body alone, from the preset's paths (a bit wider), minus the head
        L = LAYOUTS["one_dragon_around_torso"]
        for pts, w, _ in L["paths"]:
            r = (w / 2 + 18) * c.scale * c.design[0]
            for x, y in c.dpx(_spline(pts, 40)):
                d.ellipse((x - r, y - r, x + r, y + r), fill=255)
        d.polygon(c.dpx(CANVASES[c.name]["zones"]["dragon_head"]), fill=0)
        # r19: the body passes over the moon, and the accent pass repainted it -> keep the moon out too
        (x0, y0, x1, y1), _ = L["ellipses"][1]
        d.ellipse(c.dpx([(x0, y0), (x1, y1)]), fill=0)
        # colour pass: zones=[dragon_body, dragon_head] must repaint the whole dragon -> head goes back in
        if "dragon_head" in zones:
            d.polygon(c.dpx(CANVASES[c.name]["zones"]["dragon_head"]), fill=255)
    if feather > 0:
        m = m.filter(ImageFilter.GaussianBlur(feather / 2))
    a = np.asarray(m, np.float32) / 255
    if on_body:
        a = a * np.asarray(Image.fromarray((body_mask(c) * 255).astype(np.uint8)).filter(ImageFilter.MaxFilter(9)), np.float32) / 255
    return a


def _box(x: np.ndarray, r: int) -> np.ndarray:
    for ax in (0, 1):
        p = np.pad(x, [(r + 1, r) if i == ax else (0, 0) for i in (0, 1)], mode="edge")
        cs = np.cumsum(p, axis=ax)
        n = cs.shape[ax]
        x = (np.take(cs, range(2 * r + 1, n), axis=ax) - np.take(cs, range(0, n - 2 * r - 1), axis=ax)) / (2 * r + 1)
    return x


def _blur(x: np.ndarray, r: int) -> np.ndarray:
    return _box(_box(x, r), r)


def clean_residue(img: np.ndarray) -> np.ndarray:
    """Whitens smooth, colourless grey haze (leftover guide shading, 'ghost' bodies) while keeping
    detailed parts (scales, hair) and coloured ones (skin, moon, smoke). img: HxWx3 float 0..1."""
    L = img.mean(-1)
    sat = img.max(-1) - img.min(-1)
    r = max(2, img.shape[1] // 128)
    std = np.sqrt(np.maximum(_blur(L * L, r) - _blur(L, r) ** 2, 0))
    res = np.clip((0.08 - std) / 0.03, 0, 1) * np.clip((0.12 - sat) / 0.06, 0, 1) * np.clip((L - 0.2) / 0.08, 0, 1)
    res = np.clip(_blur(res, r * 2) * 2.5, 0, 1) * np.clip((0.16 - std) / 0.05, 0, 1) * np.clip((0.15 - sat) / 0.05, 0, 1)
    res = _blur(res, r)
    return img + (1 - img) * res[..., None]


def edge_fade(c: Canvas, inset: float = 14) -> np.ndarray:
    """Body mask that fades to 0 over `inset` canvas units before every edge (armpits, neck, waist):
    the region is cut along mesh triangles, so a tattoo running to the edge ends in a staircase."""
    r = max(1, int(inset * c.scale / 2))
    m = _blur(body_mask(c), r)
    return np.clip((m - 0.5) / 0.45, 0, 1)


def silhouette(c: Canvas, skin=(224, 196, 172), background=(255, 255, 255)) -> np.ndarray:
    """RGB image of the unwrap: skin-coloured body on a plain background (float32 HxWx3, 0..1)."""
    m = body_mask(c)[..., None]
    return (np.array(skin, np.float32) * m + np.array(background, np.float32) * (1 - m)) / 255


def vary_layout(L: dict, variation: int, amount: float) -> dict:
    """A random variant of a layout: every point, ellipse and path bend moves by up to `amount`
    design units (same `variation` -> same variant), sizes change by up to +-amount/3. 0 = unchanged."""
    if not variation or amount <= 0:
        return L
    rng = np.random.default_rng(variation)
    j = lambda: float(rng.uniform(-amount, amount))
    out = dict(L)
    out["ellipses"] = []
    for (x0, y0, x1, y1), col in L.get("ellipses", []):
        dx, dy, g = j(), j(), j() / 3
        out["ellipses"].append(((x0 + dx - g, y0 + dy - g, x1 + dx + g, y1 + dy + g), col))
    out["smoke"] = [((x0 + (d := j()), y0, x1 + d, y1), col) for (x0, y0, x1, y1), col in L.get("smoke", [])]
    paths = L.get("paths", [L["path"]] if "path" in L else [])
    # ends that leave the canvas (shoulder, seam) stay put so the body still wraps around
    out["paths"] = [([p if (p[0] < 0 or p[0] > 820 or p[1] < 0) else (p[0] + j(), p[1] + j()) for p in pts], w * (1 + j() / (4 * amount)), col)
                    for pts, w, col in paths]
    out.pop("path", None)
    dx, dy = j() / 2, j() / 2   # the head moves as one piece
    out["polygons"] = [([(x + dx, y + dy) for x, y in poly], col) for poly, col in L.get("polygons", [])]
    return out


def layout_guide(c: Canvas, preset: str, background: str = "dark", blur: int = 10, variation: int = 0, amount: float = 0) -> np.ndarray:
    """Colour zones that tell img2img where each element goes (float32 HxWx3, 0..1).
    `variation` > 0 with `amount` > 0 draws a random variant of the preset (to explore compositions)."""
    L = vary_layout(LAYOUTS[preset], variation, amount)
    bg = (14, 14, 16) if background == "dark" else (255, 255, 255)
    g = Image.new("RGB", (c.width, c.height), bg)
    d = ImageDraw.Draw(g)
    for (x0, y0, x1, y1), col in L.get("ellipses", []):
        d.ellipse(c.dpx([(x0, y0), (x1, y1)]), fill=col)
    for box, col in L.get("smoke", []):
        _smoke(g, c, box, col)
    for pts, w, col in L.get("paths", [L["path"]] if "path" in L else []):
        pts = c.dpx(_spline(pts, 40))
        # r07: a flat dark band came back as a flat black silhouette -> shade it as a tube
        # (dark edges, lighter middle) so img2img keeps volume and draws scales with highlights
        levels = 7
        for k in range(levels):
            f = 1 - k / levels
            colour = tuple(min(255, int(v + 110 * (k / (levels - 1)) ** 1.4)) for v in col)
            r = w * f * c.scale * c.design[0] / 2
            for x, y in pts:  # round stamps: no notches at the bends
                d.ellipse((x - r, y - r, x + r, y + r), fill=colour)
    for i, (poly, col) in enumerate(L.get("polygons", [])):
        if i == 0 and L.get("shade_head"):
            # r07-r08: a flat dark polygon came back as a black disc / a second blob behind the head ->
            # shade it like the body (lighter towards the middle) so it reads as a solid head
            cx = sum(x for x, _ in poly) / len(poly); cy = sum(y for _, y in poly) / len(poly)
            for k in range(6):
                f = 1 - k / 7
                colour = tuple(min(255, int(v + 100 * (k / 5) ** 1.4)) for v in col)
                d.polygon(c.dpx([(cx + (x - cx) * f, cy + (y - cy) * f) for x, y in poly]), fill=colour)
        else:
            d.polygon(c.dpx(poly), fill=col)
    if blur > 0:
        g = g.filter(ImageFilter.GaussianBlur(blur))
    return np.asarray(g, np.float32) / 255


def _spline(pts, n: int = 12):
    """Catmull-Rom through the points, so a body drawn as a polyline bends smoothly."""
    if len(pts) < 3:
        return pts
    p = [pts[0]] + list(pts) + [pts[-1]]
    out = []
    for i in range(1, len(p) - 2):
        (x0, y0), (x1, y1), (x2, y2), (x3, y3) = p[i - 1], p[i], p[i + 1], p[i + 2]
        for k in range(n):
            t = k / n
            t2, t3 = t * t, t * t * t
            out.append(tuple(0.5 * (2 * b + (-a + c2) * t + (2 * a - 5 * b + 4 * c2 - d) * t2 + (-a + 3 * b - 3 * c2 + d) * t3)
                             for a, b, c2, d in ((x0, x1, x2, x3), (y0, y1, y2, y3))))
    out.append(tuple(pts[-1]))
    return out


def _smoke(g: Image.Image, c: Canvas, box, col, seed: int = 7) -> None:
    """Paints wispy smoke into `box` (units): multi-scale noise, ridged so it forms strands, soft-faded at the edges."""
    (x0, y0), (x1, y1) = ((int(x), int(y)) for x, y in c.dpx([box[:2], box[2:]]))
    w, h = max(8, x1 - x0), max(8, y1 - y0)
    rng = np.random.default_rng(seed)
    n = np.zeros((h, w), np.float32)
    for k, amp in ((4, 1.0), (9, 0.5), (20, 0.25), (44, 0.12)):
        small = rng.random((k, max(2, int(k * w / h)))).astype(np.float32)
        n += amp * np.asarray(Image.fromarray((small * 255).astype(np.uint8)).resize((w, h), Image.BICUBIC), np.float32) / 255
    n /= 1.87
    n = 1 - np.abs(n - 0.5) * 2               # ridges -> strands of smoke
    n = np.clip((n - 0.3) / 0.5, 0, 1)
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    d = ((xx - w / 2) / (w / 2)) ** 2 + ((yy - h / 2) / (h / 2)) ** 2
    fade = np.clip((1 - d) / 0.6, 0, 1)                # elliptical, no box edges
    a = (n * fade)[..., None]
    region = np.asarray(g.crop((x0, y0, x0 + w, y0 + h)), np.float32)
    out = region * (1 - a) + np.array(col, np.float32) * a
    g.paste(Image.fromarray(out.clip(0, 255).astype(np.uint8)), (x0, y0))


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
    alpha = np.clip((250 - lum) / 22, 0, 1) * edge_fade(c)
    return Image.fromarray(np.dstack([img, alpha * 255]).astype(np.uint8), "RGBA")
