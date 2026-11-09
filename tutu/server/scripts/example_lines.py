"""Line-art composition (vector) on the front/back canvas: snake over the shoulder + back portrait."""
import json, math
import os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
I = json.load(open(os.path.join(HERE, 'example_canvas_info.json')))  # window.tutu.canvasInfo(1000)
OUT = sys.argv[1] if len(sys.argv) > 1 else '.'
W, H = I['size']['width'], I['size']['height']
J = I['joints']
LINE = 1.1    # ~2.6 mm
FINE = 0.6

def catmull(pts, n=14):
    out = []
    P = [pts[0]] + pts + [pts[-1]]
    for i in range(1, len(P) - 2):
        p0, p1, p2, p3 = P[i-1], P[i], P[i+1], P[i+2]
        for k in range(n):
            t = k / n
            t2, t3 = t*t, t*t*t
            out.append(tuple(0.5*((2*p1[j]) + (-p0[j]+p2[j])*t + (2*p0[j]-5*p1[j]+4*p2[j]-p3[j])*t2 + (-p0[j]+3*p1[j]-3*p2[j]+p3[j])*t3) for j in (0, 1)))
    out.append(pts[-1])
    return out

def poly(pts, closed=False):
    d = 'M' + ' L'.join(f'{x:.1f} {y:.1f}' for x, y in pts)
    return d + (' Z' if closed else '')

def smooth_path(pts, closed=False):
    """Quadratic-midpoint smoothing for hand-placed points."""
    if closed: pts = pts + pts[:2]
    d = f'M{(pts[0][0]+pts[1][0])/2:.1f} {(pts[0][1]+pts[1][1])/2:.1f}'
    for i in range(1, len(pts)-1):
        mx, my = (pts[i][0]+pts[i+1][0])/2, (pts[i][1]+pts[i+1][1])/2
        d += f' Q{pts[i][0]:.1f} {pts[i][1]:.1f} {mx:.1f} {my:.1f}'
    return d + (' Z' if closed else '')

paths = []   # (d, width, layer)
LAYER = 'body'
def add(d, w=LINE, fill='none'):
    paths.append((d, w, LAYER))

# ---------------- Snake (front) ----------------
F = J['Спереду']
sh = F['upperarm_r']; el = F['lowerarm_r']
center = [
    (el[0]+6, el[1]+12),            # tail just past the elbow
    (el[0]+22, el[1]-14),
    (sh[0]-34, sh[1]+40),
    (sh[0]-12, sh[1]+6),            # top of the arm
    (sh[0]+8, sh[1]-14),            # over the shoulder cap
    (sh[0]+48, sh[1]-6),
    (sh[0]+98, sh[1]+12),
    (sh[0]+122, sh[1]+46),          # outer edge of the left pec
    (sh[0]+124, sh[1]+96),
    (sh[0]+98, sh[1]+124),          # down to the solar plexus
    (sh[0]+62, sh[1]+124),
    (sh[0]+42, sh[1]+104),
    (sh[0]+44, sh[1]+82),           # rising to the head
    (sh[0]+56, sh[1]+70),
]
C = catmull(center, 16)
N = len(C)
def width(i):
    t = i / (N-1)
    return 3 + 21*min(1, t/0.35) - 3*max(0, (t-0.9)/0.1)
L, R = [], []
for i in range(N):
    a = C[max(0, i-1)]; b = C[min(N-1, i+1)]
    dx, dy = b[0]-a[0], b[1]-a[1]; l = math.hypot(dx, dy) or 1
    nx, ny = -dy/l, dx/l
    w = width(i)/2
    L.append((C[i][0]+nx*w, C[i][1]+ny*w)); R.append((C[i][0]-nx*w, C[i][1]-ny*w))
# body outline: left side, tail tip, right side back
CUT = N-3
add(poly(L[:CUT]))
add(poly(R[:CUT]))
add(poly([L[0], (C[0][0]-(C[1][0]-C[0][0])*0.8, C[0][1]-(C[1][1]-C[0][1])*0.8), R[0]]))
# belly strip: a line along the body, scutes only between it and the belly edge
B_IN = []
for i in range(N):
    B_IN.append((R[i][0]*0.68+L[i][0]*0.32, R[i][1]*0.68+L[i][1]*0.32))
add(poly(B_IN[6:CUT-2]), FINE)
for i in range(8, CUT-3, 3):
    add(poly([B_IN[i], R[i]]), FINE)
# dorsal diamond chain along the back of the body
for i in range(10, N-12, 10):
    p = C[i]; a = C[i-1]; b = C[i+1]
    dx, dy = b[0]-a[0], b[1]-a[1]; l = math.hypot(dx, dy) or 1
    ux, uy = dx/l, dy/l; nx, ny = -uy, ux
    s, w = 4.2, width(i)*0.22
    pts = [(p[0]-ux*s, p[1]-uy*s), (p[0]+nx*w, p[1]+ny*w), (p[0]+ux*s, p[1]+uy*s), (p[0]-nx*w, p[1]-ny*w)]
    add(poly(pts, True), FINE)

# Head at the end of the body, mouth open toward the sternum.
end = C[CUT-1]; prev = C[CUT-5]
ang = math.radians(-42)   # head raised over the coil, toward the collarbone
ang = math.radians(-42)   # head raised over the coil, toward the collarbone
HS = 1.4
def T(x, y):
    ca, sa = math.cos(ang), math.sin(ang)
    x, y = x*HS, y*HS
    return (end[0] + x*ca - y*sa, end[1] + x*sa + y*ca)
def tp(pts): return [T(*p) for p in pts]
s = 1.0
LAYER = 'head'
# head in profile, jaws wide open
skull = [(-4, -9), (6, -11), (16, -13), (26, -14), (36, -12), (44, -10), (50, -8), (54, -6), (55, -4), (52, -2), (44, -1), (34, 0), (24, 1)]
jaw = [(-4, 9), (4, 9), (12, 10), (20, 13), (27, 18), (33, 24), (36, 29), (34, 31), (28, 27), (21, 21), (14, 15), (8, 10)]
add(smooth_path(tp(skull)))
add(smooth_path(tp(jaw)))
add(smooth_path(tp([(24, 1), (16, 3), (10, 6), (8, 10)])))                 # corner of the mouth
add(smooth_path(tp([(4, -9), (2, -3), (3, 3), (6, 9)])), FINE)             # back of the head
add(smooth_path(tp([(46, -1), (36, 1), (26, 3), (18, 6)])), FINE)          # upper gum
add(smooth_path(tp([(32, 27), (26, 22), (20, 17), (14, 13)])), FINE)       # lower gum
# fangs: two long curved upper, two lower
for x0 in (44, 38):
    add(smooth_path(tp([(x0-2.2, -1), (x0-1.5, 5), (x0-3.5, 10), (x0+0.2, 4), (x0+1.6, -1)])), FINE)
for x0 in (31, 25):
    add(smooth_path(tp([(x0-1.6, 25-(31-x0)*0.9), (x0-0.5, 18-(31-x0)*0.9), (x0+1.6, 24-(31-x0)*0.9)])), FINE)
# eye with a heavy brow ridge, nostril, labial scales
c = T(30, -8); r = 2.6*HS
add(f'M{c[0]-r:.1f} {c[1]:.1f} a{r:.1f} {r*0.8:.1f} {math.degrees(ang):.0f} 1 0 {2*r:.1f} 0 a{r:.1f} {r*0.8:.1f} {math.degrees(ang):.0f} 1 0 {-2*r:.1f} 0')
add(poly([T(30, -10.2), T(30, -5.8)]), FINE)                               # slit pupil
add(smooth_path(tp([(18, -12), (24, -15.5), (32, -14), (38, -11)])))       # brow
add(smooth_path(tp([(48, -7), (50, -6), (49, -5)])), FINE)                 # nostril
for k in range(6):
    x = 8 + k*7
    add(smooth_path(tp([(x, -1+k*0.2), (x+3.5, -3.2), (x+7, -1+k*0.2)])), FINE)   # upper labials
for k in range(4):
    x = 4 + k*7
    add(smooth_path(tp([(x, 10+k*1.8), (x+3.5, 12.6+k*1.8), (x+7, 11.5+k*1.8)])), FINE)  # lower labials
for k in range(4):
    add(smooth_path(tp([(8+k*8, -12), (11+k*8, -9), (14+k*8, -12)])), FINE)  # head plates

HEAD_SIL = smooth_path(tp(skull + [(56, -4), (52, 4), (40, 22), (36, 29)] + jaw[::-1] + [(-4, 9), (-6, 0)]), True)
LAYER = 'back'
# ---------------- Portrait (back) ----------------
B = J['Ззаду']
cx = B['neck_01'][0]
top = B['neck_01'][1] + 14          # hairline just under the neck
fw, fh = 112, 142                    # face width/height (~22 x 31 cm)
fy0 = top + 6
def P(x, y): return (cx + x*fw/100, fy0 + y*fh/130)   # face-local coords: x -50..50, y 0..130
def pp(pts): return [P(*p) for p in pts]
# face outline (jaw and cheeks)
face = [(-46, 30), (-48, 54), (-46, 78), (-39, 98), (-27, 115), (-12, 125), (0, 127), (12, 125), (27, 115), (39, 98), (46, 78), (48, 54), (46, 30)]
add(smooth_path(pp(face)))
# hair: parted in the middle, volume over the temples, long waves down to the flowers
for side in (-1, 1):
    add(smooth_path(pp([(0, -16), (side*18, -14), (side*36, -6), (side*48, 8), (side*52, 28), (side*54, 52)])))
    add(smooth_path(pp([(side*54, 52), (side*58, 76), (side*54, 100), (side*60, 124), (side*56, 148)])))
    for k, (o, w) in enumerate([(6, 1), (14, 0), (22, 1), (30, 0)]):
        add(smooth_path(pp([(side*(46+o*0.2), 14+k*3), (side*(54+o), 46+k*4), (side*(50+o*1.1), 80+k*5),
                            (side*(58+o*1.2), 110+k*5), (side*(54+o*1.3), 140+k*3), (side*(62+o*1.4), 160)])), LINE if w else FINE)
    add(smooth_path(pp([(0, -16), (side*6, -2), (side*16, 10), (side*30, 18), (side*44, 26)])), FINE)
    add(smooth_path(pp([(side*4, -12), (side*14, -6), (side*28, 2), (side*40, 16)])), FINE)
# strand across the face
add(smooth_path(pp([(-8, -10), (-20, 20), (-30, 50), (-26, 80), (-34, 104)])), FINE)
# brows
add(smooth_path(pp([(-36, 44), (-26, 39), (-12, 40), (-6, 43)])))
add(smooth_path(pp([(36, 44), (26, 39), (12, 40), (6, 43)])))
# eyes (blank, glowing: iris circle + short rays)
for side in (-1, 1):
    ex = side*20
    add(smooth_path(pp([(ex-12, 55), (ex-6, 50), (ex, 49), (ex+6, 50), (ex+12, 55)])))
    add(smooth_path(pp([(ex-12, 55), (ex-6, 59), (ex, 60), (ex+6, 59), (ex+12, 55)])), FINE)
    c = P(ex, 54.5); r = 4.2*fw/100
    add(f'M{c[0]-r:.1f} {c[1]:.1f} a{r:.1f} {r:.1f} 0 1 0 {2*r:.1f} 0 a{r:.1f} {r:.1f} 0 1 0 {-2*r:.1f} 0', FINE)
    for a in range(0, 360, 45):
        u, v = math.cos(math.radians(a)), math.sin(math.radians(a))
        add(poly([(c[0]+u*r*1.35, c[1]+v*r*1.35), (c[0]+u*r*1.9, c[1]+v*r*1.9)]), FINE)
    add(smooth_path(pp([(ex-10, 64), (ex, 66), (ex+10, 64)])), FINE)   # lower lid crease
# nose
add(smooth_path(pp([(-4, 56), (-6, 74), (-9, 86), (-5, 90), (0, 88)])), FINE)
add(smooth_path(pp([(0, 88), (5, 90), (9, 86), (7, 82)])), FINE)
# lips
add(smooth_path(pp([(-15, 102), (-7, 98), (0, 100), (7, 98), (15, 102)])))
add(smooth_path(pp([(-15, 102), (0, 104), (15, 102)])), FINE)
add(smooth_path(pp([(-12, 103), (-5, 111), (0, 112), (5, 111), (12, 103)])), FINE)
# freckles (dots)
for x, y in [(-26, 72), (-30, 76), (-22, 78), (26, 72), (30, 77), (22, 79), (-4, 70), (5, 71)]:
    c = P(x, y); add(f'M{c[0]:.1f} {c[1]:.1f} h0.1', 1.0)
# neck lines
add(smooth_path(pp([(-20, 120), (-22, 140), (-26, 150)])), FINE)
add(smooth_path(pp([(20, 120), (22, 140), (26, 150)])), FINE)

def flower(cx0, cy0, r, rot=0):
    """Peony: a ring of cupped outer petals, overlapping inner cups, a ruffled centre."""
    def P(a, rr, sq=0.82): return (cx0 + math.cos(a)*rr, cy0 + math.sin(a)*rr*sq)
    n = 7
    for k in range(n):                                   # outer petals: bumps with a notch
        a0 = rot + 2*math.pi*k/n; a1 = a0 + 2*math.pi/n
        am = (a0+a1)/2
        p0, p1 = P(a0, r*0.82), P(a1, r*0.82)
        c1, c2 = P(am-0.25, r*1.18), P(am+0.25, r*1.18)
        add(f'M{p0[0]:.1f} {p0[1]:.1f} C{c1[0]:.1f} {c1[1]:.1f} {c2[0]:.1f} {c2[1]:.1f} {p1[0]:.1f} {p1[1]:.1f}', LINE)
        q0, q1 = P(am-0.12, r*0.98), P(am+0.12, r*0.98)
        add(poly([q0, P(am, r*0.9), q1]), FINE)          # petal notch
        add(smooth_path([P(am, r*0.6), P(am+0.08, r*0.75), P(am, r*0.88)]), FINE)  # vein
    for k in range(5):                                   # inner cups
        a = rot + 0.4 + 2*math.pi*k/5
        p0, p1 = P(a-0.7, r*0.5), P(a+0.7, r*0.5)
        c = P(a, r*0.78)
        add(f'M{p0[0]:.1f} {p0[1]:.1f} Q{c[0]:.1f} {c[1]:.1f} {p1[0]:.1f} {p1[1]:.1f}', FINE)
    for k in range(4):                                   # ruffled centre
        a = rot + 1.0 + 2*math.pi*k/4
        p0, p1 = P(a-0.9, r*0.22), P(a+0.9, r*0.22)
        c = P(a, r*0.42)
        add(f'M{p0[0]:.1f} {p0[1]:.1f} Q{c[0]:.1f} {c[1]:.1f} {p1[0]:.1f} {p1[1]:.1f}', FINE)
def leaf(x, y, l, a):
    ca, sa = math.cos(a), math.sin(a)
    tip = (x+ca*l, y+sa*l); m = (x+ca*l/2, y+sa*l/2); n = (-sa*l*0.25, ca*l*0.25)
    add(f'M{x:.1f} {y:.1f} Q{m[0]+n[0]:.1f} {m[1]+n[1]:.1f} {tip[0]:.1f} {tip[1]:.1f} Q{m[0]-n[0]:.1f} {m[1]-n[1]:.1f} {x:.1f} {y:.1f}', FINE)
    add(poly([(x, y), m]), FINE)
# peonies under the chin, framing the lower back
by = fy0 + fh + 10
flower(cx - 44, by + 4, 26, 0.3); flower(cx + 40, by + 8, 22, 1.1); flower(cx - 4, by + 26, 18, 2.0)
leaf(cx - 72, by + 10, 28, math.pi*0.9); leaf(cx + 62, by + 20, 26, 0.1); leaf(cx + 18, by + 42, 22, 0.8)

def butterfly(x, y, s, a=0.0):
    ca, sa = math.cos(a), math.sin(a)
    def t(px, py): return (x + (px*ca - py*sa)*s, y + (px*sa + py*ca)*s)
    for side in (-1, 1):
        fore = [(1, -2), (side*8, -12), (side*20, -20), (side*30, -20), (side*28, -12), (side*22, -4), (side*10, -1)]
        hind = [(1, 1), (side*10, 2), (side*18, 7), (side*19, 15), (side*12, 20), (side*5, 16), (side*2, 8)]
        add(smooth_path([t(*p) for p in fore], True)); add(smooth_path([t(*p) for p in hind], True))
        for v in ([(side*2, -2), (side*14, -10), (side*26, -16)], [(side*3, -1), (side*16, -6), (side*25, -9)], [(side*2, 2), (side*11, 9), (side*15, 15)]):
            add(smooth_path([t(*p) for p in v]), FINE)
        for px, py in [(side*27, -17), (side*24, -10), (side*15, 15)]:
            c = t(px, py); add(f'M{c[0]:.1f} {c[1]:.1f} h0.1', 1.4)
        add(smooth_path([t(*p) for p in [(0, -4), (side*3, -12), (side*7, -19)]]), FINE)
    add(smooth_path([t(*p) for p in [(0, -4), (0.6, 2), (0, 8)]]), LINE)
butterfly(cx - 42, fy0 + 2, 0.95, -0.35)

svg = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W*3}" height="{H*3}">',
       f'<defs><clipPath id="under-head"><path clip-rule="evenodd" d="M-10 -10 H{W+10} V{H+10} H-10 Z {HEAD_SIL}"/></clipPath></defs>',
       '<g fill="none" stroke="#111" stroke-linecap="round" stroke-linejoin="round">']
for layer in ('body', 'head', 'back'):
    svg.append('<g clip-path="url(#under-head)">' if layer == 'body' else '<g>')
    for d, w, l in paths:
        if l == layer: svg.append(f'<path d="{d}" stroke-width="{w}"/>')
    svg.append('</g>')
svg.append('</g></svg>')
open(os.path.join(OUT, 'sketch-lines.svg'), 'w').write('\n'.join(svg))
prev = svg[:1] + [f'<rect width="{W}" height="{H}" fill="white"/><path d="{I["outline"]}" fill="#f1dcc8" stroke="#bbb" stroke-width="0.6"/>'] + svg[1:]
open(os.path.join(OUT, 'sketch-preview.svg'), 'w').write('\n'.join(prev))
print(len(paths), 'paths')
