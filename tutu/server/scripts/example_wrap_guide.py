import json, re
import numpy as np
from PIL import Image, ImageDraw, ImageFilter
I = json.load(open('/tmp/claude-0/e2e/info-wrap.json'))
W, H = I['size']['width'], I['size']['height']
D = '/tmp/claude-0/dragon/'
X1, Y1 = 820, 717                       # area of the canvas used by the body
S = 1024/X1                             # guide pixels per unit
GW, GH = 1024, 896
g = Image.new('RGB', (GW, GH), 'white')
def paste(img, box, mask):
    x0, y0, x1, y1 = [int(v*S) for v in box]
    img = img.resize((x1-x0, y1-y0), Image.LANCZOS); m = mask.resize((x1-x0, y1-y0), Image.LANCZOS)
    g.paste(img, (x0, y0), m)
# portrait on the back (oval mask)
face = Image.open(D+'v3-back-0.webp').convert('RGB')
w, h = face.size; yy, xx = np.mgrid[0:h, 0:w]
r = np.hypot((xx/w-0.5)/0.5, (yy/h-0.42)/0.52); m = Image.fromarray((np.clip((1-r)/0.3, 0, 1)*255).astype(np.uint8))
paste(face, (55, -30, 375, 515), m)
# dragon body: from the back of the head over the right shoulder, down around the hair
body = [(585, 470), (560, 565), (490, 615), (410, 610), (330, 585), (240, 600), (140, 590), (60, 520), (40, 400), (45, 270), (70, 150), (130, 70)]
def catmull(pts, n=20):
    out = []; P = [pts[0]] + pts + [pts[-1]]
    for i in range(1, len(P)-2):
        p0, p1, p2, p3 = P[i-1], P[i], P[i+1], P[i+2]
        for k in range(n):
            t = k/n; t2, t3 = t*t, t*t*t
            out.append(tuple(0.5*((2*p1[j]) + (-p0[j]+p2[j])*t + (2*p0[j]-5*p1[j]+4*p2[j]-p3[j])*t2 + (-p0[j]+3*p1[j]-3*p2[j]+p3[j])*t3) for j in (0, 1)))
    out.append(pts[-1]); return np.array(out)
SC = np.asarray(Image.open('/tmp/claude-0/dragon/assets/scales.png').convert('L'), np.float32)/255
C = catmull([(x*S, y*S) for x, y in body])
seg = np.diff(C, axis=0); ln = np.hypot(seg[:, 0], seg[:, 1]); keep = ln > 1e-6
C = np.vstack([C[0], C[1:][keep]]); seg = np.diff(C, axis=0); ln = np.hypot(seg[:, 0], seg[:, 1])
sarr = np.concatenate([[0], np.cumsum(ln)]); U = np.vstack([seg/ln[:, None], (seg/ln[:, None])[-1:]])
Nn = np.stack([-U[:, 1], U[:, 0]], 1)
Sx = np.arange(0, sarr[-1], 0.4); idx = np.clip(np.searchsorted(sarr, Sx)-1, 0, len(sarr)-2)
f = ((Sx - sarr[idx])/ln[idx])[:, None]; P = C[idx]*(1-f) + C[idx+1]*f; Nv = Nn[idx]
tt = Sx/sarr[-1]; wv = (62 - 24*tt)*S
wv = wv*np.clip(0.2 + (1-tt)/0.15, 0, 1)            # tail tapers at the end
T = np.linspace(-0.5, 0.5, 120)
X = P[:, 0:1] + Nv[:, 0:1]*T[None]*wv[:, None]; Y = P[:, 1:2] + Nv[:, 1:2]*T[None]*wv[:, None]
th, tw = SC.shape
u = (Sx[:, None]/(wv[:, None]*0.9)*tw*0.5) % tw
v = ((np.arcsin(np.clip(T[None]*2, -1, 1))/np.pi + 0.5)*th*0.6) % th
tex = SC[v.astype(int) % th, u.astype(int) % tw]
shade = np.sqrt(np.clip(1 - (T[None]*2)**2, 0, 1))
dark = np.clip(tex*(0.25 + 0.75*shade), 0, 1)
col = np.stack([20 + 200*dark**1.5 + 60*(1-shade)*dark, 14 + 90*dark**2, 10 + 30*dark**3], -1)   # obsidian with ember highlights
spine = np.abs(T[None]) > 0.47
col[np.broadcast_to(spine, col.shape[:2])] = (15, 10, 8)
arr = np.asarray(g).copy()
xi = np.clip(X.astype(int), 0, GW-1); yi = np.clip(Y.astype(int), 0, GH-1)
arr[yi, xi] = col.astype(np.uint8)
# dorsal spikes on the outer edge
g = Image.fromarray(arr); d = ImageDraw.Draw(g)
for k in range(8, len(Sx)-60, 70):
    p, n, u0 = P[k], Nv[k], U[min(idx[k], len(U)-1)]
    w = wv[k]/2; base = p - n*w*0.95
    tip = base - n*w*0.7 + u0*w*0.5
    d.polygon([tuple(base - u0*w*0.35), tuple(tip), tuple(base + u0*w*0.4)], fill=(20, 14, 12))
# dragon head on the chest
head = Image.open(D+'v3-chest-1.webp').convert('RGB')
a = np.asarray(head.convert('L')); ys, xs = np.where(a < 235)
head = head.crop((xs.min(), ys.min(), xs.max()+1, ys.max()+1))
hm = Image.fromarray(((np.asarray(head.convert('L')) < 238)*255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(2))
hw = 265; hh = hw*head.height/head.width
paste(head, (455, 40, 455+hw, 40+hh), hm)
g.save('/tmp/claude-0/wrap/guide2.png')
# preview with the body outline
p = g.copy(); dp = ImageDraw.Draw(p)
for sg in I['outline'].split('M')[1:]:
    nums = list(map(float, re.findall(r'-?\d+\.?\d*', sg)))
    dp.line([(x*S, y*S) for x, y in zip(nums[0::2], nums[1::2])] + [(nums[0]*S, nums[1]*S)], fill=(160, 160, 160), width=2)
p.save('/tmp/claude-0/wrap/guide2-preview.png'); print(GW, GH)
