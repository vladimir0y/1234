"""Tutu nodes for ComfyUI: canvas geometry without ComfyUI or torch."""
import importlib.util
import sys
from pathlib import Path

import numpy as np

spec = importlib.util.spec_from_file_location("tutu_core", Path(__file__).resolve().parents[2] / "comfy_nodes" / "core.py")
core = importlib.util.module_from_spec(spec)
sys.modules['tutu_core'] = core
spec.loader.exec_module(core)


def test_canvas_sizes():
    c = core.load_canvas("wrap_torso", 1024)
    assert (c.width, c.height) == (1024, 896)
    assert core.load_canvas("front_back_body", 1024).height % 64 == 0


def test_body_and_zones():
    c = core.load_canvas("wrap_torso", 512)
    body = core.body_mask(c)
    assert 0.5 < body.mean() < 0.95                      # most of the canvas is skin
    back = core.zone_mask(c, ["back"], 0)
    chest = core.zone_mask(c, ["chest"], 0)
    assert back[:, : int(60 * c.scale)].max() == 0 and chest[:, : int(440 * c.scale)].max() == 0
    assert (back * chest).max() == 0                     # zones do not overlap
    soft = core.zone_mask(c, ["back"], 40)
    edge = soft[c.height // 2, int(340 * c.scale) - 20: int(340 * c.scale) + 20]
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
