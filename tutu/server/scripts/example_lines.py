"""Contour composition after the owner's reference: viper head over the upper chest, coming over the
right shoulder, jaws open downward, tongue below the navel; body around the abdomen; sleeve on the left
arm. Back: portrait. Canvas: window.tutu.canvasInfo(1000) for the front/back canvas."""
import json, math, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
I = json.load(open(os.path.join(HERE, 'example_canvas_info.json')))
OUT = sys.argv[1] if len(sys.argv) > 1 else '.'
W, H = I['size']['width'], I['size']['height']
J = I['joints']
LINE, MID, FINE = 1.2, 0.8, 0.5

# ---------- helpers ----------
def catmull(pts, n=12):
    out = []
    P = [pts[0]] + pts + [pts[-1]]
    for i in range(1, len(P) - 2):
        p0, p1, p2, p3 = P[i-1], P[i], P[i+1], P[i+2]
        for k in range(n):
            t = k / n; t2, t3 = t*t, t*t*t
            out.append(tuple(0.5*((2*p1[j]) + (-p0[j]+p2[j])*t + (2*p0[j]-5*p1[j]+4*p2[j]-p3[j])*t2 + (-p0[j]+3*p1[j]-3*p2[j]+p3[j])*t3) for j in (0, 1)))
    out.append(tuple(pts[-1]))
    return out
def poly(pts, closed=False):
    return 'M' + ' L'.join(f'{x:.1f} {y:.1f}' for x, y in pts) + (' Z' if closed else '')
def curve(pts, closed=False):
    return poly(catmull(list(pts) + ([pts[0]] if closed else []), 10), closed)
def lerp(a, b, t): return (a[0]+(b[0]-a[0])*t, a[1]+(b[1]-a[1])*t)

class Layer:
    def __init__(self, name):
        self.name, self.paths, self.sil = name, [], []
    def add(self, d, w=FINE):
        self.paths.append((d, w))
LAYERS = []
def layer(name):
    L = Layer(name); LAYERS.append(L); return L

def body(Ly, centers, w0, w1, belly=1, taper_start=False, taper_end=False, density=1.0, dorsal=True):
    """Snake body along `centers`: two edges, a belly strip with plates, dorsal scale scallops."""
    C = catmull(centers, 14)
    N = len(C)
    def width(i):
        t = i / (N-1)
        w = w0 + (w1-w0)*t
        if taper_start: w *= min(1, 0.15 + t/0.25)
        if taper_end: w *= min(1, 0.12 + (1-t)/0.3)
        return w
    Lp, Rp, U, Nn = [], [], [], []
    for i in range(N):
        a, b = C[max(0, i-1)], C[min(N-1, i+1)]
        dx, dy = b[0]-a[0], b[1]-a[1]; l = math.hypot(dx, dy) or 1
        u = (dx/l, dy/l); n = (-u[1], u[0])
        w = width(i)/2
        Lp.append((C[i][0]+n[0]*w, C[i][1]+n[1]*w)); Rp.append((C[i][0]-n[0]*w, C[i][1]-n[1]*w))
        U.append(u); Nn.append(n)
    Ly.add(poly(Lp), LINE); Ly.add(poly(Rp), LINE)
    if taper_end: Ly.add(poly([Lp[-1], C[-1], Rp[-1]]), LINE)
    if taper_start: Ly.add(poly([Lp[0], C[0], Rp[0]]), LINE)
    Ly.sil.append(poly(Lp + Rp[::-1], True))
    # belly strip: from the belly edge to 45% of the width
    E = Rp if belly > 0 else Lp
    O = Lp if belly > 0 else Rp
    S = [lerp(E[i], O[i], 0.45) for i in range(N)]
    Ly.add(poly(S), MID)
    acc, step = 0.0, 4.2 / density
    for i in range(1, N):
        acc += math.hypot(C[i][0]-C[i-1][0], C[i][1]-C[i-1][1])
        if acc >= step and width(i) > 6:
            acc = 0
            m = lerp(E[i], S[i], 0.5)
            q = (m[0]+U[i][0]*1.6, m[1]+U[i][1]*1.6)
            Ly.add(f'M{E[i][0]:.1f} {E[i][1]:.1f} Q{q[0]:.1f} {q[1]:.1f} {S[i][0]:.1f} {S[i][1]:.1f}', FINE)
    if not dorsal: return C
    # dorsal scales: staggered scallops between S and the other edge
    rows = 3
    acc, step, k = 0.0, 5.0 / density, 0
    for i in range(1, N):
        acc += math.hypot(C[i][0]-C[i-1][0], C[i][1]-C[i-1][1])
        if acc < step or width(i) < 8: continue
        acc = 0; k += 1
        for r in range(rows):
            t = (r + 0.5 + (0.5 if k % 2 else 0)) / (rows + 0.5)
            if t > 0.95: continue
            c = lerp(S[i], O[i], t)
            s = width(i) * 0.55 / (rows + 0.5) * 1.1
            a = (c[0]-U[i][0]*s*0.9 + (O[i][0]-S[i][0])*0.0, c[1]-U[i][1]*s*0.9)
            b = (c[0]+U[i][0]*s*0.9, c[1]+U[i][1]*s*0.9)
            d = (O[i][0]-S[i][0], O[i][1]-S[i][1]); dl = math.hypot(*d) or 1
            q = (c[0]-d[0]/dl*s*1.3, c[1]-d[1]/dl*s*1.3)
            Ly.add(f'M{a[0]:.1f} {a[1]:.1f} Q{q[0]:.1f} {q[1]:.1f} {b[0]:.1f} {b[1]:.1f}', FINE)
    return C

# ---------- FRONT ----------
F = J['Спереду']
# 1) body around the abdomen: from the right flank, under the jaw, across the belly, down the left flank
abd = layer('abdomen')
body(abd, [(176, 150), (186, 165), (186, 190), (200, 212), (232, 206), (268, 192), (300, 192), (310, 222), (306, 262), (298, 300), (294, 330)],
     26, 30, belly=1)
# 2) left shoulder: the body comes over the trapezius and down the deltoid, then coils round the arm
arm = layer('arm-front')
ua, la, ha = F['upperarm_l'], F['lowerarm_l'], F['hand_l']
body(arm, [(296, 18), (312, 40), (330, 62), (346, 84), (356, 100)], 30, 26, belly=-1)
def arm_axis(s, A, B, Cc):
    l1 = math.dist(A, B); l2 = math.dist(B, Cc)
    if s <= l1: p, d = lerp(A, B, s/l1), ((B[0]-A[0])/l1, (B[1]-A[1])/l1)
    else: p, d = lerp(B, Cc, min(1, (s-l1)/l2)), ((Cc[0]-B[0])/l2, (Cc[1]-B[1])/l2)
    return p, d, l1 + l2
def arm_bands(Ly, A, B, Cc, outer_sign, phase):
    _, _, total = arm_axis(0, A, B, Cc)
    s = 34 + phase
    while s < total - 14:
        p0, d0, _ = arm_axis(s, A, B, Cc); p1, d1, _ = arm_axis(s + 22, A, B, Cc)
        hw0 = 22 - 9 * s / total; hw1 = 22 - 9 * (s + 22) / total
        n0 = (-d0[1]*outer_sign, d0[0]*outer_sign); n1 = (-d1[1]*outer_sign, d1[0]*outer_sign)
        a = (p0[0]+n0[0]*hw0*1.5, p0[1]+n0[1]*hw0*1.5); b = (p1[0]-n1[0]*hw1*1.5, p1[1]-n1[1]*hw1*1.5)
        m = lerp(a, b, 0.5)
        last = s + 36 >= total - 14
        width = 30 - 12 * s / total
        body(Ly, [a, (m[0]+d0[0]*3, m[1]+d0[1]*3), b], width, width*0.95 if not last else width*0.6, belly=1, taper_end=last)
        s += 36
# outer side of the left arm in the front view points up/right (away from the torso)
arm_bands(arm, ua, la, ha, outer_sign=-1, phase=0)

# 3) tongue: long, forked, down past the navel
tongue = layer('tongue')
tc = catmull([(238, 132), (262, 134), (282, 150), (282, 172), (268, 192), (246, 212), (232, 234), (228, 252)], 12)
def ribbon(Ly, C, w0, w1):
    Lp, Rp = [], []
    for i in range(len(C)):
        a, b = C[max(0, i-1)], C[min(len(C)-1, i+1)]
        dx, dy = b[0]-a[0], b[1]-a[1]; l = math.hypot(dx, dy) or 1
        n = (-dy/l, dx/l); w = (w0 + (w1-w0)*i/(len(C)-1))/2
        Lp.append((C[i][0]+n[0]*w, C[i][1]+n[1]*w)); Rp.append((C[i][0]-n[0]*w, C[i][1]-n[1]*w))
    Ly.add(poly(Lp), MID); Ly.add(poly(Rp), MID)
    Ly.sil.append(poly(Lp + Rp[::-1], True))
    return Lp, Rp
Lt, Rt = ribbon(tongue, tc, 5.5, 3.2)
end = tc[-1]
for fork in ([(end[0]-1, end[1]), (222, 266), (214, 280), (216, 290)], [(end[0]+1, end[1]), (236, 266), (240, 280), (248, 288)]):
    fc = catmull(fork, 8); ribbon(tongue, fc, 3.0, 0.8)
tongue.add(poly(catmull([(240, 135), (262, 138), (279, 152)], 6)), FINE)    # centre groove

# 4) neck: from the back of the head over the right trapezius to the back
neck = layer('neck')
body(neck, [(184, 84), (164, 66), (148, 46), (136, 24), (128, 2)], 44, 38, belly=1)

# 5) head
head = layer('head')
dorsal = [(170, 60), (186, 50), (206, 46), (230, 52), (254, 64), (274, 78), (287, 91), (293, 100), (292, 106), (287, 110)]
lip = [(287, 110), (276, 113), (260, 117), (244, 122), (230, 128), (219, 135)]
jaw_in = [(219, 135), (222, 150), (227, 164), (233, 176), (238, 184)]
jaw_out = [(238, 184), (231, 184), (222, 174), (214, 158), (208, 142), (205, 130)]
back = [(205, 130), (198, 122), (188, 112), (176, 100), (166, 84), (164, 70), (170, 60)]
head.add(curve(dorsal), LINE); head.add(curve(lip), LINE); head.add(curve(jaw_in), LINE)
head.add(curve(jaw_out), LINE); head.add(curve(back), LINE)
head.add(curve([(205, 130), (212, 128), (219, 135)]), MID)   # jaw hinge
head.sil.append(poly(catmull(dorsal + lip[1:] + jaw_in[1:] + jaw_out[1:] + back[1:], 6), True))
# eye: big, glowing (white) with a heavy brow
ex, ey, er = 252, 97, 8.5
head.add(f'M{ex-er:.1f} {ey:.1f} a{er} {er*0.82:.1f} -12 1 0 {2*er} 0 a{er} {er*0.82:.1f} -12 1 0 {-2*er} 0', LINE)
head.add(f'M{ex-4.5:.1f} {ey:.1f} a4.5 3.8 -12 1 0 9 0 a4.5 3.8 -12 1 0 -9 0', FINE)
head.add(curve([(234, 90), (244, 82), (258, 81), (270, 88)]), LINE)              # brow ridge
head.add(curve([(236, 92), (246, 87), (258, 86), (266, 90)]), FINE)
head.add(curve([(240, 107), (252, 109), (264, 105)]), FINE)                       # under the eye
head.add(f'M282.5 97 a2.6 1.8 -30 1 0 5.2 0 a2.6 1.8 -30 1 0 -5.2 0', MID)        # nostril
# crown ridge and plates on top of the head
ridge = [(178, 64), (200, 62), (224, 66), (248, 74), (268, 84), (284, 94)]
head.add(curve(ridge), MID)
def scale_rows(Ly, top_line, bottom_line, rows, size, flip=False):
    """Overlapping rounded scales between two lines (lists of points), staggered rows."""
    T = catmull(top_line, 20); Bt = catmull(bottom_line, 20)
    n = min(len(T), len(Bt))
    for r in range(rows):
        f = (r + 0.6) / (rows + 0.2)
        line = [lerp(T[i*len(T)//n], Bt[i*len(Bt)//n], f) for i in range(n)]
        acc, last = (r % 2) * size / 2, line[0]
        for i in range(1, n):
            acc += math.dist(line[i], line[i-1])
            if acc < size: continue
            acc = 0
            p, q = line[i], line[max(0, i-1)]
            d = (p[0]-q[0], p[1]-q[1]); dl = math.hypot(*d) or 1
            u = (d[0]/dl, d[1]/dl); nrm = (-u[1], u[0]) if not flip else (u[1], -u[0])
            a0 = (p[0]-u[0]*size*0.42, p[1]-u[1]*size*0.42); a1 = (p[0]+u[0]*size*0.42, p[1]+u[1]*size*0.42)
            c = (p[0]+nrm[0]*size*0.75, p[1]+nrm[1]*size*0.75)
            Ly.add(f'M{a0[0]:.1f} {a0[1]:.1f} Q{c[0]:.1f} {c[1]:.1f} {a1[0]:.1f} {a1[1]:.1f}', FINE)
scale_rows(head, [(178, 54), (206, 50), (232, 56), (256, 68), (276, 82)], ridge[:-1], 3, 8.5)
scale_rows(head, ridge[:4], [(184, 98), (200, 112), (222, 118), (238, 112)], 4, 7.5)
# labials along the upper lip
for i in range(9):
    a = lerp((284, 108), (222, 131), i/9); b = lerp((284, 108), (222, 131), (i+1)/9)
    m = lerp(a, b, 0.5)
    head.add(f'M{a[0]:.1f} {a[1]:.1f} Q{m[0]:.1f} {m[1]-7:.1f} {b[0]:.1f} {b[1]:.1f}', FINE)
head.add(curve([(284, 104), (262, 110), (240, 117), (224, 126)]), FINE)
# lower jaw labials
for i in range(6):
    a = lerp((235, 182), (208, 138), i/6); b = lerp((235, 182), (208, 138), (i+1)/6)
    m = lerp(a, b, 0.5)
    head.add(f'M{a[0]:.1f} {a[1]:.1f} Q{m[0]+5:.1f} {m[1]-2:.1f} {b[0]:.1f} {b[1]:.1f}', FINE)
# fangs: wide root under the snout, hooked tip
def fang(Ly, centre, w0):
    C = catmull(centre, 10); n = len(C)
    Lp, Rp = [], []
    for i in range(n):
        a, b = C[max(0, i-1)], C[min(n-1, i+1)]
        dx, dy = b[0]-a[0], b[1]-a[1]; l = math.hypot(dx, dy) or 1
        nr = (-dy/l, dx/l); w = w0 * (1 - i/(n-1))**0.8 / 2
        Lp.append((C[i][0]+nr[0]*w, C[i][1]+nr[1]*w)); Rp.append((C[i][0]-nr[0]*w, C[i][1]-nr[1]*w))
    Ly.add(poly(Lp + Rp[::-1]), MID)
    Ly.add(poly([lerp(Lp[1], Rp[1], 0.3), lerp(Lp[n//2], Rp[n//2], 0.3)]), FINE)
    Ly.sil.append(poly(Lp + Rp[::-1], True))
fang(head, [(278, 111), (278, 124), (274, 136), (266, 145), (259, 148)], 10)
fang(head, [(263, 116), (262, 127), (257, 136), (250, 140)], 7)
# lower teeth
for i in range(4):
    p = lerp((224, 146), (235, 176), i/4)
    head.add(poly([(p[0]-1.5, p[1]+1), (p[0]+3.5, p[1]-3), (p[0]+1.5, p[1]+3)]), FINE)
# inside the mouth: palate folds
for k, pts in enumerate([[(230, 134), (240, 140), (246, 152)], [(226, 140), (233, 150), (236, 164)], [(240, 128), (252, 132), (258, 142)]]):
    head.add(curve(pts), FINE)

# ---------- BACK ----------
B = J['Ззаду']
# snake parts on the back: over the right shoulder down the shoulder blade (frames the portrait),
# and the left arm sleeve
bsn = layer('back-snake')
body(bsn, [(862, 6), (856, 30), (842, 62), (826, 96), (812, 130), (806, 160), (796, 190)], 38, 30, belly=-1)
bua, bla, bha = B['upperarm_l'], B['lowerarm_l'], B['hand_l']
body(bsn, [(706, 10), (690, 32), (672, 54), (656, 78), (646, 98)], 30, 26, belly=1)
arm_bands(bsn, bua, bla, bha, outer_sign=1, phase=18)

# portrait (unchanged from the first sketch)
por = layer('portrait')
cx = B['neck_01'][0]
top = B['neck_01'][1] + 14
fw, fh = 108, 138
fy0 = top + 6
def P(x, y): return (cx + x*fw/100, fy0 + y*fh/130)
def pp(pts): return [P(*p) for p in pts]
def add(d, w=FINE): por.add(d, w)
face = [(-46, 30), (-48, 54), (-46, 78), (-39, 98), (-27, 115), (-12, 125), (0, 127), (12, 125), (27, 115), (39, 98), (46, 78), (48, 54), (46, 30)]
add(curve(pp(face)), LINE)
for side in (-1, 1):
    add(curve(pp([(0, -16), (side*18, -14), (side*36, -6), (side*48, 8), (side*52, 28), (side*54, 52)])), LINE)
    add(curve(pp([(side*54, 52), (side*58, 76), (side*54, 100), (side*60, 124), (side*56, 148)])), LINE)
    for k, o in enumerate((6, 14, 22, 30)):
        add(curve(pp([(side*(46+o*0.2), 14+k*3), (side*(54+o), 46+k*4), (side*(50+o*1.1), 80+k*5),
                       (side*(58+o*1.2), 110+k*5), (side*(54+o*1.3), 140+k*3)])), MID if k % 2 == 0 else FINE)
    add(curve(pp([(0, -16), (side*6, -2), (side*16, 10), (side*30, 18), (side*44, 26)])), FINE)
add(curve(pp([(-8, -10), (-20, 20), (-30, 50), (-26, 80), (-34, 104)])), FINE)
add(curve(pp([(-36, 44), (-26, 39), (-12, 40), (-6, 43)])), MID)
add(curve(pp([(36, 44), (26, 39), (12, 40), (6, 43)])), MID)
for side in (-1, 1):
    e = side*20
    add(curve(pp([(e-12, 55), (e-6, 50), (e, 49), (e+6, 50), (e+12, 55)])), MID)
    add(curve(pp([(e-12, 55), (e-6, 59), (e, 60), (e+6, 59), (e+12, 55)])), FINE)
    c = P(e, 54.5); r = 4.2*fw/100
    add(f'M{c[0]-r:.1f} {c[1]:.1f} a{r:.1f} {r:.1f} 0 1 0 {2*r:.1f} 0 a{r:.1f} {r:.1f} 0 1 0 {-2*r:.1f} 0')
    for a in range(0, 360, 45):
        u, v = math.cos(math.radians(a)), math.sin(math.radians(a))
        add(poly([(c[0]+u*r*1.35, c[1]+v*r*1.35), (c[0]+u*r*1.9, c[1]+v*r*1.9)]))
add(curve(pp([(-4, 56), (-6, 74), (-9, 86), (-5, 90), (0, 88), (5, 90), (9, 86), (7, 82)])))
add(curve(pp([(-15, 102), (-7, 98), (0, 100), (7, 98), (15, 102)])), MID)
add(curve(pp([(-12, 103), (-5, 111), (0, 112), (5, 111), (12, 103)])))
for x, y in [(-26, 72), (-30, 76), (-22, 78), (26, 72), (30, 77), (22, 79), (-4, 70), (5, 71)]:
    c = P(x, y); add(f'M{c[0]:.1f} {c[1]:.1f} h0.1', 1.0)
def flower(cx0, cy0, r, rot=0):
    def Q(a, rr, sq=0.82): return (cx0 + math.cos(a)*rr, cy0 + math.sin(a)*rr*sq)
    n = 7
    for k in range(n):
        a0 = rot + 2*math.pi*k/n; a1 = a0 + 2*math.pi/n; am = (a0+a1)/2
        p0, p1 = Q(a0, r*0.82), Q(a1, r*0.82); c1, c2 = Q(am-0.25, r*1.18), Q(am+0.25, r*1.18)
        add(f'M{p0[0]:.1f} {p0[1]:.1f} C{c1[0]:.1f} {c1[1]:.1f} {c2[0]:.1f} {c2[1]:.1f} {p1[0]:.1f} {p1[1]:.1f}', MID)
        add(poly([Q(am-0.12, r*0.98), Q(am, r*0.9), Q(am+0.12, r*0.98)]))
    for k in range(5):
        a = rot + 0.4 + 2*math.pi*k/5; p0, p1, c = Q(a-0.7, r*0.5), Q(a+0.7, r*0.5), Q(a, r*0.78)
        add(f'M{p0[0]:.1f} {p0[1]:.1f} Q{c[0]:.1f} {c[1]:.1f} {p1[0]:.1f} {p1[1]:.1f}')
    for k in range(4):
        a = rot + 1.0 + 2*math.pi*k/4; p0, p1, c = Q(a-0.9, r*0.22), Q(a+0.9, r*0.22), Q(a, r*0.42)
        add(f'M{p0[0]:.1f} {p0[1]:.1f} Q{c[0]:.1f} {c[1]:.1f} {p1[0]:.1f} {p1[1]:.1f}')
by = fy0 + fh + 8
flower(cx - 40, by + 4, 24, 0.3); flower(cx + 36, by + 8, 20, 1.1); flower(cx - 2, by + 24, 17, 2.0)
def butterfly(x, y, s, a=0.0):
    ca, sa = math.cos(a), math.sin(a)
    def t(px, py): return (x + (px*ca - py*sa)*s, y + (px*sa + py*ca)*s)
    for side in (-1, 1):
        fore = [(1, -2), (side*8, -12), (side*20, -20), (side*30, -20), (side*28, -12), (side*22, -4), (side*10, -1)]
        hind = [(1, 1), (side*10, 2), (side*18, 7), (side*19, 15), (side*12, 20), (side*5, 16), (side*2, 8)]
        add(curve([t(*p) for p in fore], True), MID); add(curve([t(*p) for p in hind], True), MID)
        for v in ([(side*2, -2), (side*14, -10), (side*26, -16)], [(side*2, 2), (side*11, 9), (side*15, 15)]):
            add(curve([t(*p) for p in v]))
        add(curve([t(*p) for p in [(0, -4), (side*3, -12), (side*7, -19)]]))
    add(curve([t(*p) for p in [(0, -4), (0.6, 2), (0, 8)]]), LINE)
butterfly(cx + 26, fy0 - 4, 0.85, 0.3)

# ---------- SVG ----------
# z-order (bottom -> top): front: abdomen, arm, tongue, neck, head; back: portrait, back-snake.
order = ['abdomen', 'arm-front', 'tongue', 'neck', 'head', 'portrait', 'back-snake']
byname = {L.name: L for L in LAYERS}
svg = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W*3}" height="{H*3}">', '<defs>']
svg.append(f'<clipPath id="region"><path d="{I["outline"]}"/></clipPath>')
for L in LAYERS:
    for k, s in enumerate(L.sil):
        svg.append(f'<clipPath id="not-{L.name}-{k}"><path clip-rule="evenodd" d="M-10 -10 H{W+10} V{H+10} H-10 Z {s}"/></clipPath>')
svg.append('</defs><g clip-path="url(#region)"><g fill="none" stroke="#111" stroke-linecap="round" stroke-linejoin="round">')
for i, name in enumerate(order):
    L = byname[name]
    above = [byname[n] for n in order[i+1:]]
    opened = 0
    for A in above:
        for k in range(len(A.sil)):
            svg.append(f'<g clip-path="url(#not-{A.name}-{k})">'); opened += 1
    for d, w in L.paths:
        svg.append(f'<path d="{d}" stroke-width="{w}"/>')
    svg.append('</g>' * opened)
svg.append('</g></g></svg>')
open(os.path.join(OUT, 'sketch-lines.svg'), 'w').write('\n'.join(svg))
prev = svg[:1] + [f'<rect width="{W}" height="{H}" fill="white"/><path d="{I["outline"]}" fill="#f1dcc8" stroke="#bbb" stroke-width="0.6"/>'] + svg[1:]
open(os.path.join(OUT, 'sketch-preview.svg'), 'w').write('\n'.join(prev))
print(sum(len(L.paths) for L in LAYERS), 'paths')
