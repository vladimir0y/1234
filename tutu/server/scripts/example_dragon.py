"""Usage: python example_dragon.py <assets dir: head.png, face.png, scales.png> <out.png>

One continuous dragon on the front/back canvas (with legs), plus head and portrait images.

Body: a textured tube along one path that crosses between the front and back canvases at the
body's silhouette (sides, shoulder tops, limb edges), so it reads as one unbroken dragon.
"""
import json, math, re, sys
import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageOps

import os
I = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'example_canvas_full.json')))  # window.tutu.canvasInfo(1000), whole body
W, H = I['size']['width'], I['size']['height']
J = I['joints']
PX = 3
OW, OH = W*PX, H*PX
ASSETS = sys.argv[1] if len(sys.argv) > 1 else '/tmp/claude-0/dragon/assets'

def catmull(pts, n=16):
    out = []; P = [pts[0]] + pts + [pts[-1]]
    for i in range(1, len(P)-2):
        p0, p1, p2, p3 = P[i-1], P[i], P[i+1], P[i+2]
        for k in range(n):
            t = k/n; t2, t3 = t*t, t*t*t
            out.append(tuple(0.5*((2*p1[j]) + (-p0[j]+p2[j])*t + (2*p0[j]-5*p1[j]+4*p2[j]-p3[j])*t2 + (-p0[j]+3*p1[j]-3*p2[j]+p3[j])*t3) for j in (0, 1)))
    out.append(tuple(pts[-1])); return out
def lerp(a, b, t): return (a[0]+(b[0]-a[0])*t, a[1]+(b[1]-a[1])*t)

# ---------- limb axis helpers (for spirals) ----------
def axis(s, chain):
    acc = 0
    for A, B in zip(chain, chain[1:]):
        l = math.dist(A, B)
        if s <= acc + l or B is chain[-1]:
            t = min(1, max(0, (s-acc)/l)); d = ((B[0]-A[0])/l, (B[1]-A[1])/l)
            return lerp(A, B, t), d
        acc += l
def chain_len(chain): return sum(math.dist(a, b) for a, b in zip(chain, chain[1:]))
def edge(s, chain, side, hw, k=1.25):
    p, d = axis(s, chain); n = (-d[1]*side, d[0]*side)
    return (p[0]+n[0]*hw*k, p[1]+n[1]*hw*k)

# ---------- the path: list of (canvas, points, width_start, width_end) ----------
F, B = J['Спереду'], J['Ззаду']
segs = []
# front: neck from the back of the head down the right ribs, across the belly, over the left hip,
# across the front of the left thigh to its inner edge
segs.append(('F', [(224, 128), (220, 160), (214, 186), (204, 220), (210, 248), (240, 264), (276, 270), (300, 290),
                   (304, 326), (290, 362), (268, 392), (250, 414)], 44, 28))
# back: from the inner left thigh up across the buttock, up the left side of the back,
# over the top of the portrait, down its right side to the right shoulder
segs.append(('B', [(752, 414), (730, 380), (708, 336), (692, 286), (684, 230), (680, 170), (684, 112),
                   (700, 66), (734, 40), (776, 38), (812, 54), (836, 82)], 28, 26))
# right arm spiral: back <-> front, outer/inner edges alternate; tail at the wrist
armF = [F['upperarm_r'], F['lowerarm_r'], F['hand_r']]
armB = [B['upperarm_r'], B['lowerarm_r'], B['hand_r']]
outerF, outerB = 1, -1                     # normal sign pointing to the outer side of the arm
L = chain_len(armF)
def hw_at(s): return 21 - 9*s/L
s0, step = 26.0, 27.0
# back: from the shoulder (end of the last back segment) to the outer edge
segs.append(('B', [(836, 82), (846, 92), edge(s0, armB, outerB, hw_at(s0))], 26, 25))
s, side = s0, 'F'
while s + step < L + 10:
    s1 = min(s + step, L + 6)
    w0, w1 = 28 - 13*s/L, 28 - 13*s1/L
    last = s + 2*step >= L + 10
    if side == 'F':
        a, b = edge(s, armF, outerF, hw_at(s)), edge(s1, armF, -outerF, hw_at(s1))
        segs.append(('F', [a, lerp(a, b, 0.5), b] if not last else [a, axis(s1, armF)[0]], w0, 4 if last else w1))
        side = 'B'
    else:
        a, b = edge(s, armB, -outerB, hw_at(s)), edge(s1, armB, outerB, hw_at(s1))
        segs.append(('B', [a, lerp(a, b, 0.5), b] if not last else [a, axis(s1, armB)[0]], w0, 4 if last else w1))
        side = 'F'
    s = s1
    if last: break

# ---------- textures ----------
def load_gray(name, fallback_size=512):
    try:
        return np.asarray(Image.open(f'{ASSETS}/{name}').convert('L'), np.float32)/255
    except FileNotFoundError:
        # procedural placeholder scales
        n = fallback_size; y, x = np.mgrid[0:n, 0:n].astype(np.float32)
        r = 22; row = (y // (r*1.0)).astype(int)
        xx = (x + (row % 2)*r) % (2*r) - r; yy = y % r
        d = np.hypot(xx, (yy - r)*1.2)/r
        return np.clip(0.25 + 0.75*np.where(d < 1, d**0.7, 0.2), 0, 1)
SC = load_gray('scales.png')

def render_tube(ink, canvas_mask, pts, w0, w1, belly_sign, taper_tail=False, phase=0.0):
    C = np.array(catmull([tuple(p) for p in pts], 24), np.float64)
    seg = np.diff(C, axis=0); ln = np.hypot(seg[:, 0], seg[:, 1]); keep = ln > 1e-6
    C = np.vstack([C[0], C[1:][keep]]); seg = np.diff(C, axis=0); ln = np.hypot(seg[:, 0], seg[:, 1])
    s = np.concatenate([[0], np.cumsum(ln)]); total = s[-1]
    U = np.vstack([seg/ln[:, None], (seg/ln[:, None])[-1:]])
    # smooth tangents
    U = (np.roll(U, 1, 0) + U + np.roll(U, -1, 0)); U[0] = U[1]; U[-1] = U[-2]
    U /= np.hypot(U[:, 0], U[:, 1])[:, None]
    Nn = np.stack([-U[:, 1], U[:, 0]], 1)
    # dense samples along s
    ds = 0.25/PX
    S = np.arange(0, total, ds)
    idx = np.clip(np.searchsorted(s, S) - 1, 0, len(s)-2)
    f = ((S - s[idx]) / np.maximum(ln[idx], 1e-9))[:, None]
    P = C[idx]*(1-f) + C[idx+1]*f
    Nv = Nn[idx]*(1-f) + Nn[idx+1]*f
    t_s = S/total
    width = w0 + (w1-w0)*t_s
    if taper_tail: width = width*np.clip(0.1 + (1-t_s)/0.35, 0, 1)
    T = np.arange(-0.5, 0.5, 0.25/(PX*max(w0, w1)))
    # grid (len(S) x len(T))
    wv = width[:, None]
    X = P[:, 0:1] + Nv[:, 0:1]*T[None, :]*wv
    Y = P[:, 1:2] + Nv[:, 1:2]*T[None, :]*wv
    tt = T[None, :]*2*belly_sign           # -1..1, belly at +1
    # texture coords: scales repeat every ~ width along the body
    th, tw = SC.shape
    u = ((S[:, None] + phase) / (wv*0.9) * tw * 0.5) % tw
    v = ((np.arcsin(np.clip(tt, -1, 1))/math.pi + 0.5) * th * 0.6) % th
    tex = SC[v.astype(int) % th, u.astype(int) % tw]
    shade = np.sqrt(np.clip(1 - tt**2, 0, 1))
    val = tex*(0.35 + 0.65*shade)                       # brightness of skin left visible
    # belly plates on the belly side
    belly = tt > 0.45
    plate = (((S[:, None] + phase) / (wv*0.22)) % 1.0)
    pv = np.where(plate < 0.12, 0.15, 0.85 - 0.25*(tt-0.45))
    val = np.where(belly, pv*(0.4 + 0.6*shade), val)
    # outlines
    ed = np.abs(T[None, :]*2)
    val = np.where(ed > 0.93, 0.0, val)
    val = np.where(np.abs(tt - 0.45) < 0.035, 0.1, val)
    a = 1 - val
    xi = np.clip((X*PX).astype(int), 0, OW-1); yi = np.clip((Y*PX).astype(int), 0, OH-1)
    m = canvas_mask[yi, xi]
    # later tubes cover earlier ones
    ink[yi[m], xi[m]] = a[m]
    return C, U, Nn, s

def spikes(draw, C, U, Nn, s, w0, w1, belly_sign, every=11.0):
    """Curved dorsal fins sweeping toward the tail, varying in size."""
    total = s[-1]; k = every/2; j = 0
    while k < total - 6:
        i = min(int(np.searchsorted(s, k)), len(C)-1)
        t = k/total; w = (w0 + (w1-w0)*t)/2
        side = -belly_sign
        size = (0.75 + 0.35*math.sin(j*1.7)) * max(w, 6)
        n, u = Nn[i]*side, U[i]
        base = C[i] + n*w*0.92
        pts = [base - u*size*0.35,
               base + n*size*0.35 + u*size*0.05,
               base + n*size*0.62 + u*size*0.45,          # hooked tip
               base + n*size*0.30 + u*size*0.35,
               base + u*size*0.45]
        draw.polygon([tuple(p*PX) for p in pts], fill=235)
        k += every; j += 1
# ---------- canvas masks ----------
loops = []
for sg in I['outline'].split('M')[1:]:
    nums = list(map(float, re.findall(r'-?\d+\.?\d*', sg)))
    loops.append(list(zip(nums[0::2], nums[1::2])))
body = Image.new('L', (OW, OH), 0); d = ImageDraw.Draw(body)
for lp in loops: d.polygon([(x*PX, y*PX) for x, y in lp], fill=255)
body = np.asarray(body) > 0
xs = np.arange(OW)[None, :].repeat(OH, 0)
maskF = body & (xs < 500*PX); maskB = body & (xs >= 500*PX)

ink = np.zeros((OH, OW), np.float32)

spike_layer = Image.new('L', (OW, OH), 0); sd = ImageDraw.Draw(spike_layer)
for k, (cv, pts, w0, w1) in enumerate(segs):
    belly = 1 if cv == 'F' else -1
    tail = k == len(segs)-1
    C, U, Nn, s = render_tube(ink, maskF if cv == 'F' else maskB, pts, w0, w1, belly, taper_tail=tail, phase=k*7.0)
    spikes(sd, C, U, Nn, s, w0, w1, belly)
sp = np.asarray(spike_layer, np.float32)/255
ink = np.maximum(ink, sp*0.9*body)

# portrait on top: the dragon passes under it
try:
    face = Image.open(f'{ASSETS}/face.png').convert('L')
    fw_units = 150
    fs = fw_units*PX / face.width
    face = face.resize((int(face.width*fs), int(face.height*fs)), Image.LANCZOS)
    fa = np.clip((1 - np.asarray(face, np.float32)/255 - 0.10)/0.85, 0, 1)
    # soft oval vignette
    hh, ww = fa.shape; yy, xx = np.mgrid[0:hh, 0:ww]
    r = np.hypot((xx-ww/2)/(ww*0.5), (yy-hh*0.47)/(hh*0.53))
    al = np.clip((1-r)/0.22, 0, 1) * np.clip((hh - yy)/(hh*0.3), 0, 1)
    cx, cy = 754*PX, 168*PX
    x0, y0 = int(cx - ww/2), int(cy - hh*0.47)
    sub = ink[y0:y0+hh, x0:x0+ww]; sub[:] = sub*(1-al) + fa*al
except FileNotFoundError:
    pass


# head on the right chest (over the body)
try:
    head = Image.open(f'{ASSETS}/head.png').convert('RGBA')
    hl = 150  # head width in canvas units
    s_ = hl*PX/head.width
    head = head.resize((int(head.width*s_), int(head.height*s_)), Image.LANCZOS)
    ha = np.asarray(head, np.float32)
    fade = np.clip((ha.shape[0] - np.arange(ha.shape[0]))/(ha.shape[0]*0.22), 0, 1)[:, None]
    ha[..., 3] *= fade
    hink = (1 - ha[..., :3].mean(-1)/255) * ha[..., 3]/255
    hh, ww = hink.shape
    x0, y0 = int(146*PX), int(36*PX)
    sub = ink[y0:y0+hh, x0:x0+ww]
    al = (ha[..., 3]/255)[:sub.shape[0], :sub.shape[1]]
    sub[:] = sub*(1-al) + hink[:sub.shape[0], :sub.shape[1]]
except FileNotFoundError:
    pass

ink *= body
rgba = np.zeros((OH, OW, 4), np.uint8); rgba[..., :3] = 17; rgba[..., 3] = (np.clip(ink, 0, 1)*255).astype(np.uint8)
out = sys.argv[2] if len(sys.argv) > 2 else '/tmp/claude-0/dragon/dragon.png'
Image.fromarray(rgba).save(out, optimize=True)
prev = Image.new('RGB', (OW, OH), 'white'); dp = ImageDraw.Draw(prev)
for lp in loops: dp.polygon([(x*PX, y*PX) for x, y in lp], fill=(236, 210, 188))
prev.paste(Image.new('RGB', (OW, OH), (17, 17, 17)), (0, 0), Image.fromarray(rgba[..., 3]))
prev.resize((OW//3, OH//3), Image.LANCZOS).save(out.replace('.png', '-preview.png'))
print('segments', len(segs))
