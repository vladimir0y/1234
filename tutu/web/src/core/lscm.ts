/**
 * Least Squares Conformal Maps (Lévy et al. 2002).
 *
 * Flattens a disk-like triangle patch into the plane while preserving angles
 * as well as possible. The result is rescaled so that total 2D area equals
 * total 3D area, so UV units are the same as mesh units (metres for scans):
 * what you draw in the unwrap has its real size on the body.
 */

export interface UnwrapResult {
  /** uv per local vertex, in mesh units (metres). */
  uv: Float64Array;
  /** Per-triangle area ratio (2D / 3D); 1 = no stretch. */
  areaRatio: Float64Array;
  /** Mean |log2(areaRatio)| — 0 means perfect, 0.1 is barely visible. */
  meanDistortion: number;
  maxDistortion: number;
  iterations: number;
}

export interface UnwrapOptions {
  /** World "up" used to orient the unwrap so up on the body = up on canvas. */
  up?: [number, number, number];
  maxIterations?: number;
  tolerance?: number;
}

export function lscm(
  positions: ArrayLike<number>,
  triangles: ArrayLike<number>,
  options: UnwrapOptions = {},
): UnwrapResult {
  const n = positions.length / 3;
  const T = triangles.length / 3;
  if (n < 3 || T < 1) throw new Error("Патч замалий для розгортки");

  const P = (i: number, c: number) => positions[3 * i + c];

  // --- 1. Pick two pins far apart (extremes along the longest bbox axis).
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++)
    for (let c = 0; c < 3; c++) {
      min[c] = Math.min(min[c], P(i, c));
      max[c] = Math.max(max[c], P(i, c));
    }
  const axis = [0, 1, 2].reduce((a, c) => (max[c] - min[c] > max[a] - min[a] ? c : a), 0);
  let pinA = 0;
  let pinB = 0;
  for (let i = 0; i < n; i++) {
    if (P(i, axis) < P(pinA, axis)) pinA = i;
    if (P(i, axis) > P(pinB, axis)) pinB = i;
  }
  if (pinA === pinB) pinB = (pinA + 1) % n;
  const pinDist = Math.hypot(P(pinB, 0) - P(pinA, 0), P(pinB, 1) - P(pinA, 1), P(pinB, 2) - P(pinA, 2));

  // --- 2. Build the sparse system: 2 rows per triangle, 6 non-zeros each.
  // Unknown vector x = [u_0..u_{n-1}, v_0..v_{n-1}].
  const rowCols = new Uint32Array(T * 2 * 6);
  const rowVals = new Float64Array(T * 2 * 6);
  const area3 = new Float64Array(T);
  let rows = 0;
  for (let t = 0; t < T; t++) {
    const i0 = triangles[3 * t];
    const i1 = triangles[3 * t + 1];
    const i2 = triangles[3 * t + 2];
    // Local orthonormal frame of the triangle.
    const e1 = [P(i1, 0) - P(i0, 0), P(i1, 1) - P(i0, 1), P(i1, 2) - P(i0, 2)];
    const e2 = [P(i2, 0) - P(i0, 0), P(i2, 1) - P(i0, 1), P(i2, 2) - P(i0, 2)];
    const l1 = Math.hypot(e1[0], e1[1], e1[2]);
    const cx = e1[1] * e2[2] - e1[2] * e2[1];
    const cy = e1[2] * e2[0] - e1[0] * e2[2];
    const cz = e1[0] * e2[1] - e1[1] * e2[0];
    const twiceA = Math.hypot(cx, cy, cz);
    area3[t] = twiceA / 2;
    if (l1 < 1e-12 || twiceA < 1e-14) continue; // degenerate
    const q = [
      [0, 0],
      [l1, 0],
      [(e1[0] * e2[0] + e1[1] * e2[1] + e1[2] * e2[2]) / l1, twiceA / l1],
    ];
    // Gradient of a linear function: grad f = sum_j f_j * g_j,
    // g_j = perp(edge opposite j) / (2A), perp(x, y) = (-y, x).
    const ids = [i0, i1, i2];
    // Rows weighted by sqrt(area): grad * sqrt(A) = perp(e) / (2 sqrt(A)).
    const k = 1 / (2 * Math.sqrt(twiceA / 2));
    const g: number[][] = [];
    for (let j = 0; j < 3; j++) {
      const a = q[(j + 1) % 3];
      const b = q[(j + 2) % 3];
      const ex = b[0] - a[0];
      const ey = b[1] - a[1];
      g.push([-ey * k, ex * k]);
    }
    // Cauchy–Riemann: grad v = perp(grad u)
    //   x: sum v_j gx_j + u_j gy_j = 0
    //   y: sum v_j gy_j - u_j gx_j = 0
    const base0 = rows * 6;
    const base1 = (rows + 1) * 6;
    for (let j = 0; j < 3; j++) {
      rowCols[base0 + j] = ids[j];
      rowVals[base0 + j] = g[j][1];
      rowCols[base0 + 3 + j] = n + ids[j];
      rowVals[base0 + 3 + j] = g[j][0];
      rowCols[base1 + j] = ids[j];
      rowVals[base1 + j] = -g[j][0];
      rowCols[base1 + 3 + j] = n + ids[j];
      rowVals[base1 + 3 + j] = g[j][1];
    }
    rows += 2;
  }

  const N = 2 * n;
  const pinned = new Uint8Array(N);
  pinned[pinA] = pinned[n + pinA] = pinned[pinB] = pinned[n + pinB] = 1;

  // --- 3. Initial guess: project onto the best-fit plane, then align to pins.
  const x = projectInitialGuess(positions, n, pinA, pinB, pinDist);
  x[pinA] = 0;
  x[n + pinA] = 0;
  x[pinB] = pinDist;
  x[n + pinB] = 0;

  // --- 4. Conjugate gradient on the normal equations over free variables.
  const Ax = (vec: Float64Array, out: Float64Array) => {
    for (let r = 0; r < rows; r++) {
      let s = 0;
      for (let k = 0; k < 6; k++) s += rowVals[r * 6 + k] * vec[rowCols[r * 6 + k]];
      out[r] = s;
    }
  };
  const ATy = (vec: Float64Array, out: Float64Array) => {
    out.fill(0);
    for (let r = 0; r < rows; r++) {
      const yr = vec[r];
      if (yr === 0) continue;
      for (let k = 0; k < 6; k++) out[rowCols[r * 6 + k]] += rowVals[r * 6 + k] * yr;
    }
  };
  const tmpR = new Float64Array(rows);
  const normalOp = (vec: Float64Array, out: Float64Array) => {
    Ax(vec, tmpR);
    ATy(tmpR, out);
    for (let i = 0; i < N; i++) if (pinned[i]) out[i] = 0;
  };

  // Residual r = -A^T A x (target is zero), restricted to free vars.
  const r = new Float64Array(N);
  normalOp(x, r);
  for (let i = 0; i < N; i++) r[i] = -r[i];
  const p = r.slice();
  const Ap = new Float64Array(N);
  let rr = dot(r, r);
  const rr0 = rr || 1;
  const maxIt = options.maxIterations ?? Math.max(500, 4 * n);
  const tol = options.tolerance ?? 1e-12;
  let it = 0;
  for (; it < maxIt && rr > tol * rr0; it++) {
    normalOp(p, Ap);
    const pAp = dot(p, Ap);
    if (pAp <= 0) break;
    const alpha = rr / pAp;
    for (let i = 0; i < N; i++) {
      x[i] += alpha * p[i];
      r[i] -= alpha * Ap[i];
    }
    const rrNew = dot(r, r);
    const beta = rrNew / rr;
    rr = rrNew;
    for (let i = 0; i < N; i++) p[i] = r[i] + beta * p[i];
  }

  const uv = new Float64Array(2 * n);
  for (let i = 0; i < n; i++) {
    uv[2 * i] = x[i];
    uv[2 * i + 1] = x[n + i];
  }

  // --- 5. Fix mirroring: triangles must keep their winding.
  let signed = 0;
  for (let t = 0; t < T; t++) signed += uvSignedArea(uv, triangles, t);
  if (signed < 0) for (let i = 0; i < n; i++) uv[2 * i + 1] = -uv[2 * i + 1];

  // --- 6. Real scale: total 2D area = total 3D area.
  let a2 = 0;
  let a3 = 0;
  for (let t = 0; t < T; t++) {
    a2 += Math.abs(uvSignedArea(uv, triangles, t));
    a3 += area3[t];
  }
  if (a2 > 0) {
    const s = Math.sqrt(a3 / a2);
    for (let i = 0; i < 2 * n; i++) uv[i] *= s;
  }

  // --- 7. Orient so the body's "up" points up in the unwrap.
  orientUp(uv, positions, n, options.up ?? [0, 1, 0]);

  // --- 8. Distortion stats.
  const areaRatio = new Float64Array(T);
  let sum = 0;
  let mx = 0;
  let counted = 0;
  for (let t = 0; t < T; t++) {
    if (area3[t] <= 0) {
      areaRatio[t] = 1;
      continue;
    }
    const ratio = uvSignedArea(uv, triangles, t) / area3[t];
    areaRatio[t] = ratio;
    const d = ratio > 0 ? Math.abs(Math.log2(ratio)) : 10; // flipped = very bad
    sum += d * area3[t];
    counted += area3[t];
    mx = Math.max(mx, d);
  }
  return { uv, areaRatio, meanDistortion: counted ? sum / counted : 0, maxDistortion: mx, iterations: it };
}

function dot(a: Float64Array, b: Float64Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

export function uvSignedArea(uv: ArrayLike<number>, tris: ArrayLike<number>, t: number): number {
  const a = tris[3 * t];
  const b = tris[3 * t + 1];
  const c = tris[3 * t + 2];
  return (
    ((uv[2 * b] - uv[2 * a]) * (uv[2 * c + 1] - uv[2 * a + 1]) -
      (uv[2 * c] - uv[2 * a]) * (uv[2 * b + 1] - uv[2 * a + 1])) /
    2
  );
}

/** PCA plane projection, similarity-aligned so pinA -> (0,0), pinB -> (d,0). */
function projectInitialGuess(
  positions: ArrayLike<number>,
  n: number,
  pinA: number,
  pinB: number,
  pinDist: number,
): Float64Array {
  const mean = [0, 0, 0];
  for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) mean[c] += positions[3 * i + c] / n;
  const C = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (let i = 0; i < n; i++) {
    const d = [0, 1, 2].map((c) => positions[3 * i + c] - mean[c]);
    for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) C[a][b] += d[a] * d[b];
  }
  const e1 = powerIteration(C, null);
  const e2 = powerIteration(C, e1);
  const proj = new Float64Array(2 * n);
  for (let i = 0; i < n; i++) {
    const d = [0, 1, 2].map((c) => positions[3 * i + c] - mean[c]);
    proj[2 * i] = d[0] * e1[0] + d[1] * e1[1] + d[2] * e1[2];
    proj[2 * i + 1] = d[0] * e2[0] + d[1] * e2[1] + d[2] * e2[2];
  }
  // Similarity transform mapping proj[pinA] -> 0 and proj[pinB] -> (pinDist, 0).
  const ax = proj[2 * pinA];
  const ay = proj[2 * pinA + 1];
  const vx = proj[2 * pinB] - ax;
  const vy = proj[2 * pinB + 1] - ay;
  const len2 = vx * vx + vy * vy || 1;
  // complex multiply by conj(v) * pinDist / |v|^2
  const mr = (vx * pinDist) / len2;
  const mi = (-vy * pinDist) / len2;
  const x = new Float64Array(2 * n);
  for (let i = 0; i < n; i++) {
    const px = proj[2 * i] - ax;
    const py = proj[2 * i + 1] - ay;
    x[i] = px * mr - py * mi;
    x[n + i] = px * mi + py * mr;
  }
  return x;
}

function powerIteration(C: number[][], orth: number[] | null): number[] {
  let v = orth ? [orth[1] - orth[2], orth[2] - orth[0], orth[0] - orth[1]] : [1, 0.7, 0.3];
  if (Math.hypot(v[0], v[1], v[2]) < 1e-9) v = [0, 0, 1];
  for (let k = 0; k < 64; k++) {
    let w = [0, 1, 2].map((a) => C[a][0] * v[0] + C[a][1] * v[1] + C[a][2] * v[2]);
    if (orth) {
      const d = w[0] * orth[0] + w[1] * orth[1] + w[2] * orth[2];
      w = w.map((c, i) => c - d * orth[i]);
    }
    const len = Math.hypot(w[0], w[1], w[2]);
    if (len < 1e-18) break;
    v = w.map((c) => c / len);
  }
  return v;
}

/** Rotate uv so that the direction in which world-up increases points to +v. */
function orientUp(uv: Float64Array, positions: ArrayLike<number>, n: number, up: [number, number, number]) {
  // Least squares fit: h_i ≈ gu * u_i + gv * v_i + c, h = height along `up`.
  let su = 0, sv = 0, sh = 0;
  for (let i = 0; i < n; i++) {
    su += uv[2 * i];
    sv += uv[2 * i + 1];
    sh += positions[3 * i] * up[0] + positions[3 * i + 1] * up[1] + positions[3 * i + 2] * up[2];
  }
  su /= n; sv /= n; sh /= n;
  let uu = 0, uvv = 0, vv = 0, uh = 0, vh = 0;
  for (let i = 0; i < n; i++) {
    const du = uv[2 * i] - su;
    const dv = uv[2 * i + 1] - sv;
    const dh = positions[3 * i] * up[0] + positions[3 * i + 1] * up[1] + positions[3 * i + 2] * up[2] - sh;
    uu += du * du; uvv += du * dv; vv += dv * dv; uh += du * dh; vh += dv * dh;
  }
  const det = uu * vv - uvv * uvv;
  if (Math.abs(det) < 1e-24) return;
  const gu = (uh * vv - vh * uvv) / det;
  const gv = (vh * uu - uh * uvv) / det;
  // Weak gradient = region mostly horizontal (e.g. top of the shoulder): keep as is.
  if (Math.hypot(gu, gv) < 0.2) return;
  const angle = Math.PI / 2 - Math.atan2(gv, gu);
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  for (let i = 0; i < n; i++) {
    const x = uv[2 * i];
    const y = uv[2 * i + 1];
    uv[2 * i] = x * c - y * s;
    uv[2 * i + 1] = x * s + y * c;
  }
}
