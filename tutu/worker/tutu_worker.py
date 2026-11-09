"""Tutu worker: lets the Tutu server generate images on this computer's GPU.

Runs next to Stable Diffusion WebUI Forge (or A1111) started with --api. It connects
OUT to the Tutu server and pulls tasks, so no ports need to be opened. When this
computer is off, Tutu uses its online generators instead.

Only the Python standard library is used. Settings come from environment variables
(see run_worker.bat):
  TUTU_SERVER   Tutu address, e.g. https://tutu-xxxx.onrender.com
  TUTU_TOKEN    the same value as TUTU_WORKER_TOKEN on the server
  FORGE_URL     local Forge/A1111, default http://127.0.0.1:7860
  TUTU_STEPS / TUTU_CFG / TUTU_SAMPLER / TUTU_SCHEDULER   sampling (defaults suit SDXL Lightning/Hyper models)
"""
from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

SERVER = os.getenv("TUTU_SERVER", "http://127.0.0.1:8000").rstrip("/")
TOKEN = os.getenv("TUTU_TOKEN", "")
FORGE = os.getenv("FORGE_URL", "http://127.0.0.1:7860").rstrip("/")
STEPS = int(os.getenv("TUTU_STEPS", "8"))
CFG = float(os.getenv("TUTU_CFG", "2"))
SAMPLER = os.getenv("TUTU_SAMPLER", "DPM++ SDE")
SCHEDULER = os.getenv("TUTU_SCHEDULER", "Karras")


def http(method: str, url: str, data: bytes | None = None, headers: dict | None = None, timeout: float = 60):
    req = urllib.request.Request(url, data=data, method=method, headers=headers or {})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status, r.read()


def forge_model() -> str | None:
    """Current checkpoint name, or None if Forge is not running."""
    try:
        _, body = http("GET", f"{FORGE}/sdapi/v1/options", timeout=5)
        name = json.loads(body).get("sd_model_checkpoint") or "SD"
        return name.split("[")[0].strip().rsplit(".", 1)[0][:40]
    except Exception:
        return None


def render(task: dict) -> bytes:
    payload = {
        "prompt": task["prompt"], "negative_prompt": task.get("negative", ""),
        "width": task["width"], "height": task["height"], "seed": task.get("seed", -1),
        "steps": STEPS, "cfg_scale": CFG, "sampler_name": SAMPLER, "scheduler": SCHEDULER,
        "batch_size": 1, "n_iter": 1,
    }
    endpoint = "txt2img"
    if task.get("init_image"):
        endpoint = "img2img"
        payload["init_images"] = [task["init_image"]]
        payload["denoising_strength"] = task.get("denoise", 0.6)
        payload["resize_mode"] = 0
    _, body = http("POST", f"{FORGE}/sdapi/v1/{endpoint}", json.dumps(payload).encode(),
                   {"Content-Type": "application/json"}, timeout=600)
    import base64
    return base64.b64decode(json.loads(body)["images"][0].split(",", 1)[-1])


def main() -> None:
    if not TOKEN:
        sys.exit("Set TUTU_TOKEN (the same as TUTU_WORKER_TOKEN on the server).")
    auth = {"X-Tutu-Worker": TOKEN}
    print(f"Tutu worker: server {SERVER}, Forge {FORGE}")
    announced = None
    while True:
        model = forge_model()
        if not model:
            if announced is not False:
                print("Forge is not running (start it with --api). Waiting...")
                announced = False
            time.sleep(10)
            continue
        if announced is not True:
            print(f"Ready: {model}. Tutu now generates on this computer.")
            announced = True
        try:
            q = urllib.parse.urlencode({"wait": 25, "model": model})
            status, body = http("GET", f"{SERVER}/api/worker/next?{q}", headers=auth, timeout=40)
        except urllib.error.HTTPError as e:
            print(f"Server said {e.code}: check TUTU_TOKEN" if e.code == 401 else f"Server error {e.code}")
            time.sleep(15)
            continue
        except Exception as e:
            print(f"Server not reachable ({type(e).__name__}), retrying...")
            time.sleep(10)
            continue
        if status == 204 or not body:
            continue
        task = json.loads(body)
        t0 = time.time()
        print(f"Task {task['id'][:8]}: {task['width']}x{task['height']}"
              f"{' from a guide' if task.get('init_image') else ''}...", flush=True)
        try:
            image = render(task)
            http("POST", f"{SERVER}/api/worker/result/{task['id']}", image,
                 {**auth, "Content-Type": "image/png"})
            print(f"  done in {time.time() - t0:.0f} s")
        except Exception as e:
            print(f"  failed: {e}")
            try:
                q = urllib.parse.urlencode({"error": str(e)[:200]})
                http("POST", f"{SERVER}/api/worker/result/{task['id']}?{q}", b"", auth)
            except Exception:
                pass


if __name__ == "__main__":
    main()
