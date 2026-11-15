"""Submit one img2img job per model to AI Horde (anonymous), poll, save PNGs. Usage: horde.py guide.png outprefix"""
import base64, io, json, sys, time, urllib.request
from PIL import Image
API = "https://aihorde.net/api/v2"
H = {"apikey": "0000000000", "Content-Type": "application/json", "Client-Agent": "tutu:1:anon", "User-Agent": "tutu/1.0 (+python)"}
PROMPT = ("tattoo design, black and grey realism tattoo art drawn with ink on paper, stippled shading, plain white background, red only on the moon and the smoke, fine linework, stippling, high contrast, deep solid blacks; "
          "one single long modern dragon with a serpent-like body, bold graphic blackwork scales and ribbed belly plates, wraps around the whole design: "
          "its head smooth and sleek like a black viper, polished obsidian with a few sharp geometric planes, a single head on the upper right, open jaws with long fangs facing down-left toward the centre, no second head, "
          "the thick neck rises to the top edge, the long body arcs across the top above the woman's head, runs down the left edge and returns along the bottom right, coiling under the head; "
          "in the left half a large face of a beautiful young east asian woman framed by the dragon's body, rendered as a black and grey tattoo on skin, soft stippled shading, "
          "messy dark hair strands fading into the skin, natural face without makeup, half-open pale eyes, parted lips, gentle light from the upper left, a small red moon at the upper left beside her hair, wisps of crimson smoke under her chin")
NEG = "photo, photograph, makeup, red eyeshadow, blood, scars, two heads, horns, whiskers, mane, traditional chinese dragon, cartoon, frame, text, watermark, dark background, photo, blurry"
def req(method, path, body=None):
    r = urllib.request.Request(API + path, data=json.dumps(body).encode() if body else None, headers=H, method=method)
    return json.load(urllib.request.urlopen(r, timeout=60))
guide, out = sys.argv[1], sys.argv[2]
DEN = [float(x) for x in (sys.argv[3] if len(sys.argv) > 3 else "0.8,0.8,0.8").split(",")]
PASS2 = len(sys.argv) > 4 and sys.argv[4] == "pass2"
import os
LORA = os.getenv("LORA")
W, Hh = 960, 832
buf = io.BytesIO(); Image.open(guide).convert("RGB").resize((W, Hh)).save(buf, "WEBP", quality=90)
src = base64.b64encode(buf.getvalue()).decode()
jobs = {}
if PASS2:  # second pass: keep the composition, turn the picture into tattoo ink with the moon and smoke
    PROMPT = ("black and grey realism tattoo, the whole picture is tattoo ink on pale skin: fine stippled dotwork shading, crisp linework, soft grey washes, "
              "a woman's face framed by a long serpent dragon with detailed scales, a small crimson red moon at the upper left beside her hair, "
              "wisps of crimson smoke under her chin, plain white background, contemporary blackwork tattoo")
for (model, steps, cfg, seed), den in zip((("Juggernaut XL", 30, 6, "303"), ("Juggernaut XL", 30, 6, "505"), ("Juggernaut XL", 30, 6, "707")), DEN):
    body = {"prompt": PROMPT + " ### " + NEG, "params": {"width": W, "height": Hh, "steps": steps, "cfg_scale": cfg, "denoising_strength": den,
            "sampler_name": "k_dpmpp_2m", "karras": True, "n": 1, "seed": seed},
            "models": [model], **({"loras": [{"name": LORA, "model": 0.8, "clip": 1.0}]} if LORA else {}), "source_image": src, "source_processing": "img2img", "nsfw": True, "censor_nsfw": False, "r2": True}
    try:
        jobs[model + "_" + seed + "_d" + str(den)] = req("POST", "/generate/async", body)["id"]; print("queued", model, flush=True)
    except urllib.error.HTTPError as e:
        print("fail", model, e.code, e.read()[:300], flush=True)
t0 = time.time()
while jobs and time.time() - t0 < 3000:
    time.sleep(20)
    for m, i in list(jobs.items()):
        try: st = req("GET", f"/generate/check/{i}")
        except Exception as e: print("check err", m, e, flush=True); continue
        if st.get("done"):
            for g in req("GET", f"/generate/status/{i}")["generations"]:
                data = urllib.request.urlopen(urllib.request.Request(g["img"], headers={"User-Agent": "tutu/1.0"}), timeout=60).read()
                fn = f"{out}_{m.replace(' ', '_').replace('(', '').replace(')', '')}.png"
                Image.open(io.BytesIO(data)).save(fn); print("saved", fn, int(time.time() - t0), "s", flush=True)
            del jobs[m]
        elif not st.get("is_possible", True):
            print("impossible", m, flush=True); del jobs[m]
print("done", flush=True)
