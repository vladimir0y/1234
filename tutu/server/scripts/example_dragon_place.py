"""Put generated front/back images back on the canvas, keep only the composition area."""
import sys, numpy as np
from PIL import Image, ImageFilter, ImageDraw
D = '/tmp/claude-0/dragon/'
PX = 3
front, back, out = sys.argv[1], sys.argv[2], sys.argv[3]
full = Image.open(D + 'full.png'); OW, OH = full.size
a = np.asarray(full, np.float32)[..., 3]/255
mask = Image.fromarray(((a > 0.04)*255).astype(np.uint8)).filter(ImageFilter.MaxFilter(25)).filter(ImageFilter.GaussianBlur(10))
mask = np.asarray(mask, np.float32)/255
canvas = np.full((OH, OW, 3), 255, np.float32)
crops = {'front': (20, 20, 340, 440), 'back': (640, 20, 990, 440)}
for name, path in (('front', front), ('back', back)):
    x0, y0, x1, y1 = crops[name]
    g = Image.open(path).convert('RGB').resize(((x1-x0)*PX, (y1-y0)*PX), Image.LANCZOS)
    canvas[y0*PX:y1*PX, x0*PX:x1*PX] = np.asarray(g, np.float32)
# body only
body = np.asarray(Image.open(D + 'only.png'), np.float32)[..., 3] >= 0  # full canvas
import json, re
I = json.load(open(D + 'example_canvas_full.json'))
m = Image.new('L', (OW, OH), 0); d = ImageDraw.Draw(m)
for sg in I['outline'].split('M')[1:]:
    nums = list(map(float, re.findall(r'-?\d+\.?\d*', sg)))
    d.polygon([(x*PX, y*PX) for x, y in zip(nums[0::2], nums[1::2])], fill=255)
bm = np.asarray(m, np.float32)/255
alpha = mask*bm
# drop the pale, unsaturated mannequin the generator may draw around the art
sat = canvas.max(-1) - canvas.min(-1); lum0 = canvas.mean(-1)
keep = np.clip((sat - 28)/30, 0, 1)
keep = np.maximum(keep, np.clip((165 - lum0)/40, 0, 1))
keep = np.asarray(Image.fromarray((keep*255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(1.5)), np.float32)/255
alpha = alpha*keep
# whiten near-white paper so it does not tint the skin
lum = canvas.mean(-1, keepdims=True)
grey = np.abs(canvas - np.array([232, 234, 240], np.float32)).max(-1, keepdims=True) < 16
canvas = np.where((lum > 242) | grey, 255, canvas)
rgba = np.dstack([canvas, alpha*255]).astype(np.uint8)
Image.fromarray(rgba).save(out, optimize=True)
prev = Image.new('RGB', (OW, OH), 'white'); dp = ImageDraw.Draw(prev)
for sg in I['outline'].split('M')[1:]:
    nums = list(map(float, re.findall(r'-?\d+\.?\d*', sg)))
    dp.polygon([(x*PX, y*PX) for x, y in zip(nums[0::2], nums[1::2])], fill=(236, 210, 188))
sk = np.asarray(prev, np.float32)
mul = sk*(1-alpha[..., None]) + sk*canvas/255*alpha[..., None]
Image.fromarray(mul.astype(np.uint8)).resize((OW//3, OH//3), Image.LANCZOS).save(out.replace('.png', '-preview.png'))
print('ok')
