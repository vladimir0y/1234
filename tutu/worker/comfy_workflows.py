"""ComfyUI workflows for Tutu (API format), tuned for SDXL Lightning on a 4 GB GPU.

Three modes, chosen from the task:
  txt2img  - a scene from the prompt alone;
  img2img  - follows a guide image (layout on the body unwrap), `denoise` = how far it may move;
  inpaint  - repaints only the white part of `mask` and keeps the rest of the picture untouched.
             Differential Diffusion uses the soft mask edge, so there is no visible seam.

The functions only build dicts: they need no ComfyUI to run, so they are unit-tested.
"""
from __future__ import annotations

import os

SETTINGS = {
    "ckpt": os.getenv("COMFY_CKPT", "DreamShaperXL_Lightning.safetensors"),
    # DreamShaper XL Lightning: 4-6 steps, CFG 1.5-2, DPM++ SDE Karras (author's recommendation).
    "steps": int(os.getenv("TUTU_STEPS", "6")),
    "cfg": float(os.getenv("TUTU_CFG", "2")),
    "sampler": os.getenv("COMFY_SAMPLER", "dpmpp_sde"),
    "scheduler": os.getenv("COMFY_SCHEDULER", "karras"),
}


def _base(task: dict, s: dict) -> dict:
    return {
        "ckpt": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": s["ckpt"]}},
        "pos": {"class_type": "CLIPTextEncode", "inputs": {"text": task["prompt"], "clip": ["ckpt", 1]}},
        "neg": {"class_type": "CLIPTextEncode", "inputs": {"text": task.get("negative", ""), "clip": ["ckpt", 1]}},
    }


def _sampler(task: dict, s: dict, model, positive, negative, latent, denoise: float) -> dict:
    return {"class_type": "KSampler", "inputs": {
        "seed": int(task.get("seed", 0)) % (2**63), "steps": s["steps"], "cfg": s["cfg"],
        "sampler_name": s["sampler"], "scheduler": s["scheduler"], "denoise": denoise,
        "model": model, "positive": positive, "negative": negative, "latent_image": latent}}


def _out(wf: dict) -> dict:
    wf["decode"] = {"class_type": "VAEDecode", "inputs": {"samples": ["sample", 0], "vae": ["ckpt", 2]}}
    wf["save"] = {"class_type": "SaveImage", "inputs": {"images": ["decode", 0], "filename_prefix": "tutu"}}
    return wf


def mode_of(task: dict) -> str:
    if task.get("init_image") and task.get("mask"):
        return "inpaint"
    return "img2img" if task.get("init_image") else "txt2img"


def build(task: dict, init_name: str | None = None, mask_name: str | None = None, settings: dict | None = None) -> dict:
    """API-format workflow for one task. init/mask names are files uploaded to ComfyUI's input folder."""
    s = {**SETTINGS, **(settings or {})}
    w, h = int(task["width"]), int(task["height"])
    wf = _base(task, s)
    mode = mode_of(task)
    if mode == "txt2img":
        wf["latent"] = {"class_type": "EmptyLatentImage", "inputs": {"width": w, "height": h, "batch_size": 1}}
        wf["sample"] = _sampler(task, s, ["ckpt", 0], ["pos", 0], ["neg", 0], ["latent", 0], 1.0)
        return _out(wf)
    wf["init"] = {"class_type": "LoadImage", "inputs": {"image": init_name}}
    wf["init_sized"] = {"class_type": "ImageScale", "inputs": {
        "image": ["init", 0], "upscale_method": "lanczos", "width": w, "height": h, "crop": "disabled"}}
    if mode == "img2img":
        wf["latent"] = {"class_type": "VAEEncode", "inputs": {"pixels": ["init_sized", 0], "vae": ["ckpt", 2]}}
        wf["sample"] = _sampler(task, s, ["ckpt", 0], ["pos", 0], ["neg", 0], ["latent", 0], float(task.get("denoise", 0.6)))
        return _out(wf)
    # inpaint: soft mask + differential diffusion, the kept part stays pixel-exact in the latent
    wf["mask_img"] = {"class_type": "LoadImage", "inputs": {"image": mask_name}}
    wf["mask_sized"] = {"class_type": "ImageScale", "inputs": {
        "image": ["mask_img", 0], "upscale_method": "bilinear", "width": w, "height": h, "crop": "disabled"}}
    wf["mask"] = {"class_type": "ImageToMask", "inputs": {"image": ["mask_sized", 0], "channel": "red"}}
    wf["dd"] = {"class_type": "DifferentialDiffusion", "inputs": {"model": ["ckpt", 0]}}
    wf["cond"] = {"class_type": "InpaintModelConditioning", "inputs": {
        "positive": ["pos", 0], "negative": ["neg", 0], "vae": ["ckpt", 2],
        "pixels": ["init_sized", 0], "mask": ["mask", 0], "noise_mask": True}}
    wf["sample"] = _sampler(task, s, ["dd", 0], ["cond", 0], ["cond", 1], ["cond", 2], float(task.get("denoise", 1.0)))
    return _out(wf)
