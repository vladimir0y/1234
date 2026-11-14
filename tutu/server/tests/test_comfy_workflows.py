"""The ComfyUI graphs the worker sends: every link points at an existing node output."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "worker"))
from comfy_workflows import build, mode_of  # noqa: E402

TASK = {"prompt": "dragon", "negative": "text", "width": 1024, "height": 896, "seed": 7}


def links_ok(wf: dict) -> bool:
    for node in wf.values():
        for v in node["inputs"].values():
            if isinstance(v, list) and len(v) == 2 and isinstance(v[0], str):
                if v[0] not in wf:
                    return False
    return True


def test_txt2img():
    wf = build(TASK)
    assert mode_of(TASK) == "txt2img" and links_ok(wf)
    assert wf["latent"]["inputs"]["width"] == 1024 and wf["sample"]["inputs"]["denoise"] == 1.0
    assert wf["sample"]["inputs"]["steps"] == 6 and wf["sample"]["inputs"]["sampler_name"] == "dpmpp_sde"


def test_img2img_keeps_layout():
    t = {**TASK, "init_image": "x", "denoise": 0.55}
    wf = build(t, "guide.png")
    assert mode_of(t) == "img2img" and links_ok(wf)
    assert wf["init"]["inputs"]["image"] == "guide.png" and wf["sample"]["inputs"]["denoise"] == 0.55


def test_inpaint_uses_differential_diffusion():
    t = {**TASK, "init_image": "x", "mask": "m"}
    wf = build(t, "pic.png", "mask.png")
    assert mode_of(t) == "inpaint" and links_ok(wf)
    assert wf["sample"]["inputs"]["model"] == ["dd", 0]
    assert wf["sample"]["inputs"]["latent_image"] == ["cond", 2]
    assert wf["mask_img"]["inputs"]["image"] == "mask.png"
