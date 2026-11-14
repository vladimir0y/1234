"""Tutu nodes for ComfyUI: body unwrap canvases, zone masks, layout guides, preview on the body,
and saving in the editor's format. Install: copy or link this folder to ComfyUI/custom_nodes/tutu.
"""
from __future__ import annotations

import json
import os
import time

import numpy as np

from . import core

ZONES = ["back", "chest", "right_side", "left_side", "lower_back", "belly", "front", "dragon_area", "everything"]


def _img(a: np.ndarray):
    import torch
    return torch.from_numpy(np.ascontiguousarray(a, dtype=np.float32))[None]


def _mask(a: np.ndarray):
    import torch
    return torch.from_numpy(np.ascontiguousarray(a, dtype=np.float32))[None]


def _np(image) -> np.ndarray:
    return image[0].cpu().numpy() if hasattr(image, "cpu") else np.asarray(image)[0]


class TutuCanvas:
    """Body unwrap from the Tutu editor: size for generation, silhouette and body mask."""
    CATEGORY = "Tutu"
    RETURN_TYPES = ("TUTU_CANVAS", "IMAGE", "MASK", "INT", "INT")
    RETURN_NAMES = ("canvas", "silhouette", "body_mask", "width", "height")
    FUNCTION = "run"

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "canvas": (list(core.CANVASES), {"default": "wrap_torso"}),
            "width": ("INT", {"default": 1024, "min": 256, "max": 2048, "step": 64}),
        }}

    def run(self, canvas, width):
        c = core.load_canvas(canvas, width)
        return (c, _img(core.silhouette(c)), _mask(core.body_mask(c)), c.width, c.height)


class TutuZoneMask:
    """Mask of body zones (white = repaint) with a soft edge, for inpainting one part of the composition."""
    CATEGORY = "Tutu"
    RETURN_TYPES = ("MASK",)
    FUNCTION = "run"

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "canvas": ("TUTU_CANVAS",),
            "zone": (ZONES, {"default": "dragon_area"}),
            "feather": ("INT", {"default": 48, "min": 0, "max": 256}),
            "invert": ("BOOLEAN", {"default": False}),
        }, "optional": {"also": (["none"] + ZONES, {"default": "none"})}}

    def run(self, canvas, zone, feather, invert, also="none"):
        zones = [z for z in (zone, also) if z != "none" and z in core.CANVASES[canvas.name]["zones"]]
        if not zones:
            raise ValueError(f"Canvas {canvas.name} has none of: {zone}, {also}")
        m = core.zone_mask(canvas, zones, feather)
        return (_mask(1 - m if invert else m),)


class TutuLayoutGuide:
    """Rough colour zones (where the face, the dragon's head and body go) for img2img."""
    CATEGORY = "Tutu"
    RETURN_TYPES = ("IMAGE",)
    FUNCTION = "run"

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "canvas": ("TUTU_CANVAS",),
            "preset": (list(core.LAYOUTS), {"default": "face_back_dragon_chest"}),
            "background": (["dark", "white"], {"default": "dark"}),
            "blur": ("INT", {"default": 10, "min": 0, "max": 64}),
        }}

    def run(self, canvas, preset, background, blur):
        if core.LAYOUTS[preset]["canvas"] != canvas.name:
            raise ValueError(f"Layout {preset} is drawn for the {core.LAYOUTS[preset]['canvas']} canvas")
        return (_img(core.layout_guide(canvas, preset, background, blur)),)


class TutuBodyPreview:
    """Shows an image as ink on the skin of the unwrap (left: back, right: chest on wrap_torso)."""
    CATEGORY = "Tutu"
    RETURN_TYPES = ("IMAGE",)
    FUNCTION = "run"

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"canvas": ("TUTU_CANVAS",), "image": ("IMAGE",)}}

    def run(self, canvas, image):
        return (_img(core.body_preview(canvas, _np(image))),)


class TutuSaveForEditor:
    """Saves PNG (transparent off the body) + canvas name to ComfyUI/output/tutu/ for the Tutu editor."""
    CATEGORY = "Tutu"
    RETURN_TYPES = ()
    OUTPUT_NODE = True
    FUNCTION = "run"

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"canvas": ("TUTU_CANVAS",), "image": ("IMAGE",),
                             "filename_prefix": ("STRING", {"default": "tutu"})}}

    def run(self, canvas, image, filename_prefix):
        import folder_paths
        out_dir = os.path.join(folder_paths.get_output_directory(), "tutu")
        os.makedirs(out_dir, exist_ok=True)
        name = f"{filename_prefix}_{canvas.name}_{time.strftime('%Y%m%d-%H%M%S')}"
        core.for_editor(canvas, _np(image)).save(os.path.join(out_dir, name + ".png"))
        with open(os.path.join(out_dir, name + ".json"), "w", encoding="utf-8") as f:
            json.dump({"canvas": canvas.name, "width": canvas.width, "height": canvas.height}, f)
        return {"ui": {"images": [{"filename": name + ".png", "subfolder": "tutu", "type": "output"}]}}


NODE_CLASS_MAPPINGS = {
    "TutuCanvas": TutuCanvas,
    "TutuZoneMask": TutuZoneMask,
    "TutuLayoutGuide": TutuLayoutGuide,
    "TutuBodyPreview": TutuBodyPreview,
    "TutuSaveForEditor": TutuSaveForEditor,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "TutuCanvas": "Tutu: полотно тіла",
    "TutuZoneMask": "Tutu: маска зони",
    "TutuLayoutGuide": "Tutu: розкладка композиції",
    "TutuBodyPreview": "Tutu: перегляд на тілі",
    "TutuSaveForEditor": "Tutu: зберегти для редактора",
}
