"""Tutu nodes for ComfyUI: canvas geometry without ComfyUI or torch."""
import importlib.util
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

spec = importlib.util.spec_from_file_location("tutu_core", Path(__file__).resolve().parents[2] / "comfy_nodes" / "core.py")
core = importlib.util.module_from_spec(spec)
sys.modules['tutu_core'] = core
spec.loader.exec_module(core)


def test_canvas_sizes():
    c = core.load_canvas("wrap_torso", 1024)
    assert (c.width, c.height) == (1024, 1152)          # measured along the skin: 787 x 882 units
    assert core.load_canvas("front_back_body", 1024).height % 64 == 0


def test_body_and_zones():
    c = core.load_canvas("wrap_torso", 512)
    body = core.body_mask(c)
    assert 0.5 < body.mean() < 0.95                      # most of the canvas is skin
    back = core.zone_mask(c, ["back"], 0)
    chest = core.zone_mask(c, ["chest"], 0)
    X = lambda x: int(c.dpx([(x, 0)])[0][0])            # zones are on the design grid
    assert back[:, : X(60)].max() == 0 and chest[:, : X(440)].max() == 0
    assert (back * chest).max() == 0                     # zones do not overlap
    soft = core.zone_mask(c, ["back"], 40)
    edge = soft[c.height // 2, X(340) - 20: X(340) + 20]
    assert 0 < edge.min() < edge.max() <= 1 and len(np.unique(edge.round(2))) > 5   # soft edge


def test_guide_preview_editor():
    c = core.load_canvas("wrap_torso", 512)
    g = core.layout_guide(c, "face_back_dragon_chest")
    assert g.shape == (c.height, c.width, 3)
    face = g[int(200 * c.scale), int(200 * c.scale)]
    assert face.mean() > 0.3                              # warm face zone on the back
    p = core.body_preview(c, g)
    assert p.shape == g.shape and 0 <= p.min() and p.max() <= 1
    png = core.for_editor(c, np.ones((100, 100, 3), np.float32))
    assert png.size == (c.width, c.height) and np.asarray(png)[..., 3].max() == 0   # white paper = no ink


def test_dragon_body_zone_leaves_the_head():
    c = core.load_canvas("wrap_torso", 512)
    body = core.zone_mask(c, ["dragon_body"], 0, on_body=False)
    head = core.zone_mask(c, ["dragon_head"], 0, on_body=False)
    assert body.mean() > 0.1 and (body * head).max() == 0


def test_whole_dragon_zone_keeps_the_head():
    c = core.load_canvas("wrap_torso", 512)
    head = core.zone_mask(c, ["dragon_head"], feather=0, on_body=False)
    both = core.zone_mask(c, ["dragon_body", "dragon_head"], feather=0, on_body=False)
    assert (both[head > 0.5] > 0.5).all()


def test_layout_variations():
    c = core.load_canvas("wrap_torso", 256)
    base = core.layout_guide(c, "one_dragon_around_torso", "white", 0)
    a = core.layout_guide(c, "one_dragon_around_torso", "white", 0, variation=7, amount=40)
    b = core.layout_guide(c, "one_dragon_around_torso", "white", 0, variation=7, amount=40)
    other = core.layout_guide(c, "one_dragon_around_torso", "white", 0, variation=8, amount=40)
    assert np.array_equal(a, b) and not np.array_equal(a, base) and not np.array_equal(a, other)
    assert np.array_equal(base, core.layout_guide(c, "one_dragon_around_torso", "white", 0, variation=7, amount=0))


def test_armpit_holes_are_not_skin():
    c = core.load_canvas("wrap_torso", 512)
    m = core.body_mask(c)
    assert m[int(200 * c.scale), int(420 * c.scale)] == 0      # right armpit hole
    assert m[int(60 * c.scale), int(410 * c.scale)] == 1       # shoulder strip above it


def test_layout_body_stays_out_of_the_armpits():
    # the neck/back stroke crosses the shoulder between the top edge and the armpit hole (r21: it ran
    # through the hole and the tattoo was cut there in a staircase)
    c = core.load_canvas("wrap_torso", 512)
    skin = core.body_mask(c)
    pts, w, _ = core.LAYOUTS["one_dragon_around_torso"]["paths"][0]
    m = Image.new("L", (c.width, c.height), 0)
    d = ImageDraw.Draw(m)
    r = w / 2 * c.scale
    for x, y in c.dpx(core._spline(pts, 40)):
        d.ellipse((x - r, y - r, x + r, y + r), fill=255)
    stroke = np.asarray(m, np.float32) / 255
    stroke[:, : int(40 * c.scale)] = 0                       # the seam edge is crossed on purpose
    assert (stroke * (1 - skin)).sum() < 0.01 * stroke.sum()


def test_clean_residue_whitens_grey_and_keeps_detail():
    rng = np.random.default_rng(0)
    img = np.ones((128, 128, 3), np.float32)
    img[:, :64] = 0.4                                         # smooth grey haze
    img[:, 64:] = rng.uniform(0, 1, (128, 64, 1))             # detailed texture
    out = core.clean_residue(img)
    assert out[64, 20].mean() > 0.9 and abs(out[64, 110] - img[64, 110]).max() < 0.05
