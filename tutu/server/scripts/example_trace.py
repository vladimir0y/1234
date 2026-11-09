"""Contours traced from the owner's reference photos, mapped onto the front/back canvas.

Usage: python example_trace.py <refs dir with ref0.jpeg (chest) and ref2.jpeg (portrait)> <out.png>
The reference photos are other artists' work: keep the result private (not in git)."""
import json, re, sys
import numpy as np
from PIL import Image, ImageFilter, ImageDraw
R = sys.argv[1].rstrip('/') + '/'
import os
I = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'example_canvas_info.json')))
W, H = I['size']['width'], I['size']['height']
PX = 4                                     # output pixels per canvas unit

def xdog(img, s, k=1.6, tau=0.985, eps=-6, phi=0.9):
    a = np.asarray(img.filter(ImageFilter.GaussianBlur(s)), np.float32)
    b = np.asarray(img.filter(ImageFilter.GaussianBlur(s*k)), np.float32)
    d = a - tau*b
    return np.where(d >= eps, 1.0, 1 + np.tanh(phi*(d - eps)))

def lines(gray, s, keep, density=7):
    """Binary ink (True) from XDoG, minus specks, only inside `keep` (bool mask)."""
    ink = (xdog(gray, s) < 0.55) & keep
    box = Image.fromarray(ink.astype(np.uint8)*255).filter(ImageFilter.BoxBlur(4))
    dens = np.asarray(box, np.float32)/255*81
    return ink & (dens >= density)

def poly_mask(size, polys, scale=1.0, fill=True):
    m = Image.new('L', size, 0 if fill else 255); d = ImageDraw.Draw(m)
    for p in polys: d.polygon([(x*scale, y*scale) for x, y in p], fill=255 if fill else 0)
    return np.asarray(m) > 0

# ---------- front: ref0 (chest), crop of the photo, upscaled x2 ----------
src = Image.open(R+'ref0.jpeg').convert('L').crop((0, 360, 923, 1510))
S2 = 2
g = src.resize((src.width*S2, src.height*S2), Image.LANCZOS)
excl = [
    [(790, 10), (910, 10), (910, 105), (790, 105)],                                  # "4/5" badge
    [(300, 0), (650, 0), (725, 92), (640, 122), (470, 160), (300, 132), (238, 100)],  # neck, collarbones
    [(0, 330), (138, 330), (150, 560), (140, 1150), (0, 1150)],                     # right arm / torso edge
    [(848, 300), (923, 300), (923, 1150), (848, 1150)],                              # left arm
    [(395, 955), (480, 955), (480, 995), (395, 995)],                                # navel
    [(0, 1080), (923, 1080), (923, 1150), (0, 1150)],                                # waistband
]
keep = ~poly_mask(g.size, excl, S2)
front = lines(g, 1.6*S2/2, keep)
near = np.asarray(Image.fromarray(front.astype(np.uint8)*255).filter(ImageFilter.MaxFilter(5)), np.float32)/255
soft = np.clip((0.85 - xdog(g, 1.6*S2/2))/0.55, 0, 1) * near * keep
fimg = Image.fromarray((255*(1-soft)).astype(np.uint8)).filter(ImageFilter.MinFilter(3)).filter(ImageFilter.GaussianBlur(0.8))

# ---------- back: ref2 (portrait), full photo upscaled x2 ----------
src2 = Image.open(R+'ref2.jpeg').convert('L')
g2 = src2.resize((src2.width*S2, src2.height*S2), Image.LANCZOS)
design = [(200, 222), (300, 215), (420, 260), (510, 330), (585, 470), (630, 640), (650, 820), (690, 1050),
          (740, 1260), (775, 1430), (760, 1560), (560, 1570), (420, 1330), (330, 1180), (250, 1010),
          (200, 850), (170, 690), (150, 520), (140, 380), (160, 280)]
keep2 = poly_mask(g2.size, [design], S2)
# fade the outer band of the polygon so the arm edge does not show
edge = Image.fromarray(keep2.astype(np.uint8)*255).filter(ImageFilter.MinFilter(61))
keep2 = np.asarray(edge) > 0
from PIL import ImageOps
gp = ImageOps.autocontrast(g2, cutoff=1)
inv = ImageOps.invert(gp).filter(ImageFilter.GaussianBlur(6*S2))
av = np.asarray(gp, np.float32); bv = np.asarray(inv, np.float32)
dodge = np.clip(av*255/(255-bv+1), 0, 255)
pencil = np.clip((dodge-120)/(250-120), 0, 1)**2.2          # 1 = paper, 0 = stroke
feather = np.asarray(Image.fromarray(keep2.astype(np.uint8)*255).filter(ImageFilter.GaussianBlur(26)), np.float32)/255
bink = (1-pencil)*feather
bimg = Image.fromarray((255*(1-bink)).astype(np.uint8)).rotate(-14, Image.BICUBIC, center=(470*S2, 900*S2), fillcolor=255)
# ---------- map onto the canvas ----------
OW, OH = W*PX, H*PX
# front: canvas u = 246 + (cx-470)/6, v = 125 + (cy-545)/4.6   (cx, cy: crop pixels)
SX, SY, CX, CY, U0, V0 = 6.0, 4.6, 470, 545, 246, 125
fa = (S2*SX/PX, 0, S2*(CX - U0*SX), 0, S2*SY/PX, S2*(CY - V0*SY))
fw = fimg.transform((OW, OH), Image.AFFINE, fa, Image.BILINEAR, fillcolor=255)
# back: portrait centred on the spine, top at the base of the neck
BS, BX, BY, BU, BV = 4.9, 455, 250, 754, 34
ba = (S2*BS/PX, 0, S2*(BX - BU*BS), 0, S2*BS/PX, S2*(BY - BV*BS))
bw = bimg.transform((OW, OH), Image.AFFINE, ba, Image.BILINEAR, fillcolor=255)

split = 500*PX
ink = np.zeros((OH, OW), np.float32)
ink[:, :split] = 1 - np.asarray(fw, np.float32)[:, :split]/255
ink[:, split:] = 1 - np.asarray(bw, np.float32)[:, split:]/255
# only on the body
loops = []
for seg in I['outline'].split('M')[1:]:
    nums = list(map(float, re.findall(r'-?\d+\.?\d*', seg)))
    loops.append(list(zip(nums[0::2], nums[1::2])))
m = Image.new('L', (OW, OH), 0); d = ImageDraw.Draw(m)
for lp in loops: d.polygon([(x*PX, y*PX) for x, y in lp], fill=255)
ink *= np.asarray(m.filter(ImageFilter.MinFilter(5)), np.float32)/255
ink = np.clip(ink*1.6, 0, 1)
rgba = np.zeros((OH, OW, 4), np.uint8); rgba[..., 3] = (ink*255).astype(np.uint8); rgba[..., :3] = 17
out = sys.argv[2]
Image.fromarray(rgba).save(out, optimize=True)
# preview on skin with the outline
prev = Image.new('RGB', (OW, OH), 'white'); dp = ImageDraw.Draw(prev)
for lp in loops: dp.polygon([(x*PX, y*PX) for x, y in lp], fill=(241, 220, 200))
prev.paste(Image.new('RGB', (OW, OH), (17, 17, 17)), (0, 0), Image.fromarray(rgba[..., 3]))
prev.resize((OW//2, OH//2), Image.LANCZOS).save(out.replace('.png', '-preview.png'))
print('ok', out)
