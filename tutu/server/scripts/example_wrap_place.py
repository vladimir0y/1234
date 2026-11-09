import json, re, sys
import numpy as np
from PIL import Image, ImageDraw, ImageFilter
I = json.load(open('/tmp/claude-0/e2e/info-wrap.json'))
W, H = I['size']['width'], I['size']['height']; PX = 3
OW, OH = W*PX, H*PX
src, out = sys.argv[1], sys.argv[2]
S = 1024/820
im = Image.open(src).convert('RGB')
tw, th = int(820*PX), int(im.height/S*PX)
im = np.asarray(im.resize((tw, th), Image.LANCZOS), np.float32)
rgb = np.full((OH, OW, 3), 255, np.float32); al = np.zeros((OH, OW), np.float32)
h = min(th, OH)
lum = im.mean(-1); a = np.clip((248 - lum)/22, 0, 1)
rgb[:h, :tw] = im[:h]; al[:h, :tw] = a[:h]
m = Image.new('L', (OW, OH), 0); d = ImageDraw.Draw(m)
for sg in I['outline'].split('M')[1:]:
    nums = list(map(float, re.findall(r'-?\d+\.?\d*', sg)))
    d.polygon([(x*PX, y*PX) for x, y in zip(nums[0::2], nums[1::2])], fill=255)
al *= np.asarray(m.filter(ImageFilter.GaussianBlur(2)), np.float32)/255
Image.fromarray(np.dstack([rgb, al*255]).astype(np.uint8)).save(out, optimize=True)
print('ok')
