"""Chest painting (dragon head) + back painting (portrait) on the torso canvas (canvasInfo 1000 x 315)."""
import json, re, sys
import numpy as np
from PIL import Image, ImageDraw, ImageFilter
I = json.load(open('/tmp/claude-0/comp/example_canvas_info.json'))
W, H = I['size']['width'], I['size']['height']; PX = 3
OW, OH = W*PX, H*PX
chest, back, out = sys.argv[1], sys.argv[2], sys.argv[3]
rgb = np.full((OH, OW, 3), 255, np.float32); al = np.zeros((OH, OW), np.float32)

def put(path, box, crop=None, fade=0.07, oval=None):
    x0, y0, x1, y1 = box
    im = Image.open(path).convert('RGB')
    if crop == 'auto':   # crop to the art (non-white) area
        g = np.asarray(im.convert('L')); ys, xs = np.where(g < 235)
        im = im.crop((xs.min(), ys.min(), xs.max()+1, ys.max()+1))
        if box[3] is None: box = (x0, y0, x1, y0 + (x1-x0)*im.height/im.width)
        x0, y0, x1, y1 = box
    elif crop: im = im.crop(crop)
    tw, th = int((x1-x0)*PX), int((y1-y0)*PX)
    im = np.asarray(im.resize((tw, th), Image.LANCZOS), np.float32)
    yy, xx = np.mgrid[0:th, 0:tw]
    e = np.minimum.reduce([xx/tw, (tw-1-xx)/tw, yy/th, (th-1-yy)/th])
    a = np.clip(e/fade, 0, 1)
    # only ink: near-white paper stays skin
    if oval:   # soft oval vignette (the painting has a full background)
        cx, cy, rx, ry, f = oval
        r = np.hypot((xx/tw - cx)/rx, (yy/th - cy)/ry)
        a = np.clip((1 - r)/f, 0, 1)**1.4
    else:
        lum = im.mean(-1); a = a*np.clip((250 - lum)/25, 0, 1)
    X0, Y0 = int(x0*PX), int(y0*PX)
    sx0, sy0 = max(0, -X0), max(0, -Y0)
    X0c, Y0c = max(0, X0), max(0, Y0)
    w = min(tw - sx0, OW - X0c); h = min(th - sy0, OH - Y0c)
    reg = (slice(Y0c, Y0c+h), slice(X0c, X0c+w)); src = (slice(sy0, sy0+h), slice(sx0, sx0+w))
    aa = a[src][..., None]
    rgb[reg] = rgb[reg]*(1-aa) + im[src]*aa
    al[reg] = np.maximum(al[reg], a[src])

put(chest, (140, 4, 305, None), crop='auto', fade=0.02)
put(back, (640, -10, 868, 378), oval=(0.5, 0.42, 0.52, 0.5, 0.35))
m = Image.new('L', (OW, OH), 0); d = ImageDraw.Draw(m)
for sg in I['outline'].split('M')[1:]:
    nums = list(map(float, re.findall(r'-?\d+\.?\d*', sg)))
    d.polygon([(x*PX, y*PX) for x, y in zip(nums[0::2], nums[1::2])], fill=255)
al *= np.asarray(m.filter(ImageFilter.GaussianBlur(2)), np.float32)/255
# fade out before the lower edge of the selected area (hips)
yy = np.arange(OH)[:, None]/PX
al *= np.clip((300 - yy)/40, 0, 1)
Image.fromarray(np.dstack([rgb, al*255]).astype(np.uint8)).save(out, optimize=True)
sk = np.zeros((OH, OW, 3), np.float32) + 255
skin = np.asarray(m, np.float32)[..., None]/255*np.array([-19, -45, -67], np.float32)
sk = sk + skin
mul = sk*(1-al[..., None]) + sk*rgb/255*al[..., None]
Image.fromarray(mul.astype(np.uint8)).resize((OW//2, OH//2), Image.LANCZOS).save(out.replace('.png', '-preview.png'))
print('ok')
