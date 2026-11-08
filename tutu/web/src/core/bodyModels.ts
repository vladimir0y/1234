/**
 * Parametric base bodies (5 male + 5 female presets).
 *
 * The body is a signed distance field: ellipsoids and round cones blended
 * with smooth-min, meshed with Surface Nets and smoothed with Taubin.
 * The result is one watertight surface in metres, A-pose, Y up, facing +Z,
 * so the region brush and the unwrap work across joints (shoulder -> chest).
 */

export type Sex = "male" | "female";

export interface BodyParams {
  sex: Sex;
  height: number; // metres
  shoulders: number; // multipliers relative to the base template
  chest: number;
  waist: number;
  belly: number;
  hips: number;
  glutes: number;
  bust: number;
  arms: number;
  legs: number;
}

export interface BodyPreset {
  id: string;
  label: string;
  description: string;
  params: BodyParams;
}

const base = (sex: Sex, height: number): BodyParams => ({
  sex,
  height,
  shoulders: 1,
  chest: 1,
  waist: 1,
  belly: 1,
  hips: 1,
  glutes: 1,
  bust: 1,
  arms: 1,
  legs: 1,
});

export const BODY_PRESETS: BodyPreset[] = [
  { id: "m-slim", label: "Худорлявий", description: "вузькі плечі, тонкі кінцівки", params: { ...base("male", 1.8), shoulders: 0.93, chest: 0.88, waist: 0.86, hips: 0.94, arms: 0.82, legs: 0.86 } },
  { id: "m-average", label: "Середній", description: "типова статура", params: base("male", 1.76) },
  { id: "m-athletic", label: "Атлетичний", description: "широкі плечі, рельєф", params: { ...base("male", 1.82), shoulders: 1.12, chest: 1.12, waist: 0.94, arms: 1.2, legs: 1.1 } },
  { id: "m-stocky", label: "Кремезний", description: "масивний, потужний", params: { ...base("male", 1.72), shoulders: 1.12, chest: 1.2, waist: 1.18, belly: 1.4, arms: 1.22, legs: 1.15 } },
  { id: "m-heavy", label: "Повний", description: "великий живіт і об'єм", params: { ...base("male", 1.75), shoulders: 1.05, chest: 1.22, waist: 1.38, belly: 2.1, hips: 1.15, arms: 1.2, legs: 1.2 } },
  { id: "f-slim", label: "Струнка", description: "тонка, висока", params: { ...base("female", 1.72), shoulders: 0.95, chest: 0.92, waist: 0.88, hips: 0.93, glutes: 0.9, bust: 0.85, arms: 0.85, legs: 0.88 } },
  { id: "f-average", label: "Середня", description: "типова статура", params: base("female", 1.65) },
  { id: "f-athletic", label: "Спортивна", description: "підтягнута, сильні ноги", params: { ...base("female", 1.68), shoulders: 1.05, waist: 0.92, glutes: 1.15, arms: 1.1, legs: 1.1 } },
  { id: "f-curvy", label: "Пишна", description: "виражені стегна і груди", params: { ...base("female", 1.66), bust: 1.35, waist: 0.96, hips: 1.18, glutes: 1.25, legs: 1.15, arms: 1.05 } },
  { id: "f-plus", label: "Повна", description: "великий об'єм", params: { ...base("female", 1.63), chest: 1.15, waist: 1.35, belly: 1.8, hips: 1.25, glutes: 1.2, bust: 1.4, arms: 1.25, legs: 1.25 } },
];

export function findPreset(id: string): BodyPreset | undefined {
  return BODY_PRESETS.find((p) => p.id === id);
}

// ---------------------------------------------------------------------------
// SDF primitives

type V3 = [number, number, number];

interface Primitive {
  min: V3; // AABB of influence
  max: V3;
  k: number; // blend radius with what came before
  sdf: (x: number, y: number, z: number) => number;
}

function ellipsoid(c: V3, r: V3, k: number, rotZ = 0): Primitive {
  const cs = Math.cos(-rotZ);
  const sn = Math.sin(-rotZ);
  const m = Math.max(r[0], r[1], r[2]);
  return {
    min: [c[0] - m, c[1] - m, c[2] - m],
    max: [c[0] + m, c[1] + m, c[2] + m],
    k,
    sdf: (x, y, z) => {
      let px = x - c[0];
      let py = y - c[1];
      const pz = z - c[2];
      if (rotZ) {
        const tx = px * cs - py * sn;
        py = px * sn + py * cs;
        px = tx;
      }
      const k0 = Math.hypot(px / r[0], py / r[1], pz / r[2]);
      const k1 = Math.hypot(px / (r[0] * r[0]), py / (r[1] * r[1]), pz / (r[2] * r[2]));
      return k1 > 0 ? (k0 * (k0 - 1)) / k1 : -m;
    },
  };
}

/** Capsule with different radii at the ends (Inigo Quilez's round cone). */
function roundCone(a: V3, b: V3, r1: number, r2: number, k: number): Primitive {
  const ba: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const l2 = ba[0] * ba[0] + ba[1] * ba[1] + ba[2] * ba[2];
  const rr = r1 - r2;
  const a2 = l2 - rr * rr;
  const il2 = 1 / l2;
  const m = Math.max(r1, r2);
  return {
    min: [Math.min(a[0], b[0]) - m, Math.min(a[1], b[1]) - m, Math.min(a[2], b[2]) - m],
    max: [Math.max(a[0], b[0]) + m, Math.max(a[1], b[1]) + m, Math.max(a[2], b[2]) + m],
    k,
    sdf: (x, y, z) => {
      const pa0 = x - a[0];
      const pa1 = y - a[1];
      const pa2 = z - a[2];
      const yy = pa0 * ba[0] + pa1 * ba[1] + pa2 * ba[2];
      const zz = yy - l2;
      const q0 = pa0 * l2 - ba[0] * yy;
      const q1 = pa1 * l2 - ba[1] * yy;
      const q2 = pa2 * l2 - ba[2] * yy;
      const x2 = q0 * q0 + q1 * q1 + q2 * q2;
      const y2 = yy * yy * l2;
      const z2 = zz * zz * l2;
      const kk = Math.sign(rr) * rr * rr * x2;
      if (Math.sign(zz) * a2 * z2 > kk) return Math.sqrt(x2 + z2) * il2 - r2;
      if (Math.sign(yy) * a2 * y2 < kk) return Math.sqrt(x2 + y2) * il2 - r1;
      return (Math.sqrt(x2 * a2 * il2) + yy * rr) * il2 - r1;
    },
  };
}

function smin(a: number, b: number, k: number): number {
  if (k <= 0) return Math.min(a, b);
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

/** Body template in metres for a 1.75 m person, then scaled to height. */
function bodyPrimitives(p: BodyParams): Primitive[] {
  const f = p.sex === "female";
  const s = p.height / 1.75; // uniform scale for lengths
  const S = (v: V3): V3 => [v[0] * s, v[1] * s, v[2] * s];
  const R = (v: number) => v * s;
  const out: Primitive[] = [];
  const add = (prim: Primitive) => out.push(prim);

  const shoulderX = (f ? 0.168 : 0.19) * p.shoulders;
  const chestW = (f ? 0.135 : 0.16) * p.shoulders * p.chest;
  const chestD = (f ? 0.095 : 0.11) * p.chest;
  const waistW = (f ? 0.115 : 0.135) * p.waist;
  const waistD = (f ? 0.085 : 0.095) * Math.sqrt(p.waist);
  const hipW = (f ? 0.168 : 0.15) * p.hips;
  const hipD = (f ? 0.105 : 0.1) * Math.sqrt(p.hips);
  const armR = (f ? 0.038 : 0.044) * p.arms;
  const legR = (f ? 0.083 : 0.08) * p.legs;
  const legX = (f ? 0.085 : 0.09) * Math.sqrt(p.hips);

  // --- torso: stacked ellipsoids blended softly
  add(ellipsoid(S([0, 0.96, -0.005]), [R(hipW), R(0.12), R(hipD)], 0));
  add(ellipsoid(S([0, 1.09, 0]), [R(waistW), R(0.13), R(waistD)], R(0.09)));
  add(ellipsoid(S([0, 1.21, 0.0]), [R((chestW + waistW) / 2), R(0.12), R((chestD + waistD) / 2)], R(0.09)));
  add(ellipsoid(S([0, 1.33, -0.005]), [R(chestW), R(0.13), R(chestD)], R(0.08)));
  if (p.belly > 1.05) {
    const b = 0.06 * (p.belly - 1);
    add(ellipsoid(S([0, 1.06, 0.03 + b * 0.6]), [R(waistW * 0.85), R(0.1 + b * 0.4), R(0.07 + b)], R(0.09)));
  }
  // glutes
  const gl = (f ? 0.085 : 0.075) * p.glutes;
  for (const sx of [-1, 1]) add(ellipsoid(S([sx * 0.07 * p.hips, 0.9, -0.045 - gl * 0.25]), [R(gl), R(gl * 0.95), R(gl * 0.85)], R(0.06)));
  // chest: pecs or breasts
  for (const sx of [-1, 1]) {
    if (f) {
      const b = 0.058 * p.bust;
      add(ellipsoid(S([sx * 0.085, 1.27, chestD * 0.62]), [R(b * 1.05), R(b), R(b * 0.85)], R(0.045)));
    } else {
      add(ellipsoid(S([sx * 0.085, 1.33, chestD * 0.55]), [R(0.085 * p.chest), R(0.06), R(0.05)], R(0.05)));
    }
  }
  // trapezius + shoulder caps
  for (const sx of [-1, 1]) {
    add(roundCone(S([0, 1.48, -0.02]), S([sx * shoulderX * 0.85, 1.43, -0.01]), R(0.055), R(0.05), R(0.05)));
    add(ellipsoid(S([sx * shoulderX, 1.41, 0]), [R(armR * 1.35), R(armR * 1.4), R(armR * 1.3)], R(0.05)));
  }
  // neck + head
  add(roundCone(S([0, 1.46, -0.01]), S([0, 1.58, 0.0]), R(f ? 0.05 : 0.058), R(f ? 0.043 : 0.05), R(0.04)));
  add(ellipsoid(S([0, 1.66, 0.01]), [R(0.075), R(0.105), R(0.095)], R(0.04)));
  add(ellipsoid(S([0, 1.6, 0.035]), [R(0.055), R(0.045), R(0.06)], R(0.04))); // jaw

  // --- arms in A-pose (35 degrees from the body)
  const ang = (35 * Math.PI) / 180;
  const dir: V3 = [Math.sin(ang), -Math.cos(ang), 0];
  for (const sx of [-1, 1]) {
    const sh: V3 = [sx * shoulderX, 1.4, 0];
    const el: V3 = [sh[0] + sx * dir[0] * 0.29, sh[1] + dir[1] * 0.29, -0.01];
    const wr: V3 = [el[0] + sx * dir[0] * 0.25, el[1] + dir[1] * 0.25, 0.01];
    const mid: V3 = [(sh[0] + el[0]) / 2, (sh[1] + el[1]) / 2, -0.005];
    add(roundCone(S(sh), S(mid), R(armR * 1.1), R(armR * 1.02), R(0.03)));
    add(roundCone(S(mid), S(el), R(armR * 1.02), R(armR * 0.8), R(0.05)));
    const fm: V3 = [el[0] + sx * dir[0] * 0.08, el[1] + dir[1] * 0.08, 0];
    add(roundCone(S(el), S(fm), R(armR * 0.8), R(armR * 0.85), R(0.05)));
    add(roundCone(S(fm), S(wr), R(armR * 0.85), R(armR * 0.58), R(0.05)));
    const hand: V3 = [wr[0] + sx * dir[0] * 0.085, wr[1] + dir[1] * 0.085, 0.01];
    add(ellipsoid(S(hand), [R(0.022), R(0.09), R(0.048)], R(0.02), sx * ang));
  }

  // --- legs
  for (const sx of [-1, 1]) {
    const hip: V3 = [sx * legX, 0.88, 0];
    const knee: V3 = [sx * (legX + 0.005), 0.5, 0.01];
    const calf: V3 = [sx * (legX + 0.01), 0.36, -0.01];
    const ankle: V3 = [sx * (legX + 0.015), 0.085, -0.01];
    add(roundCone(S(hip), S(knee), R(legR), R(legR * 0.58), R(0.06)));
    add(roundCone(S(knee), S(calf), R(legR * 0.58), R(legR * 0.62), R(0.07)));
    add(roundCone(S(calf), S(ankle), R(legR * 0.62), R(legR * 0.36), R(0.07)));
    add(ellipsoid(S([ankle[0], 0.035, 0.055]), [R(0.042), R(0.035), R(0.115)], R(0.03)));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Meshing

export interface BodyMesh {
  positions: Float32Array;
  indices: Uint32Array;
}

/** Build the body mesh. `voxel` is the grid step in metres (smaller = finer). */
export function buildBody(params: BodyParams, voxel = 0.0075): BodyMesh {
  const prims = bodyPrimitives(params);
  const pad = 3 * voxel;
  const lo: V3 = [Infinity, Infinity, Infinity];
  const hi: V3 = [-Infinity, -Infinity, -Infinity];
  for (const p of prims)
    for (let c = 0; c < 3; c++) {
      lo[c] = Math.min(lo[c], p.min[c] - pad);
      hi[c] = Math.max(hi[c], p.max[c] + pad);
    }
  const nx = Math.ceil((hi[0] - lo[0]) / voxel) + 1;
  const ny = Math.ceil((hi[1] - lo[1]) / voxel) + 1;
  const nz = Math.ceil((hi[2] - lo[2]) / voxel) + 1;
  const field = new Float32Array(nx * ny * nz).fill(1e3);
  const at = (i: number, j: number, k: number) => i + nx * (j + ny * k);

  // Accumulate each primitive only inside its own box (+ blend margin).
  for (const p of prims) {
    const m = p.k + 2 * voxel;
    const i0 = Math.max(0, Math.floor((p.min[0] - m - lo[0]) / voxel));
    const i1 = Math.min(nx - 1, Math.ceil((p.max[0] + m - lo[0]) / voxel));
    const j0 = Math.max(0, Math.floor((p.min[1] - m - lo[1]) / voxel));
    const j1 = Math.min(ny - 1, Math.ceil((p.max[1] + m - lo[1]) / voxel));
    const k0 = Math.max(0, Math.floor((p.min[2] - m - lo[2]) / voxel));
    const k1 = Math.min(nz - 1, Math.ceil((p.max[2] + m - lo[2]) / voxel));
    for (let k = k0; k <= k1; k++) {
      const z = lo[2] + k * voxel;
      for (let j = j0; j <= j1; j++) {
        const y = lo[1] + j * voxel;
        let idx = at(i0, j, k);
        for (let i = i0; i <= i1; i++, idx++) {
          const d = p.sdf(lo[0] + i * voxel, y, z);
          field[idx] = smin(field[idx], d, p.k);
        }
      }
    }
  }

  const mesh = surfaceNets(field, nx, ny, nz, lo, voxel);
  taubinSmooth(mesh, 16);
  orientOutward(mesh);
  return mesh;
}

/** Naive Surface Nets: one vertex per sign-changing cell, quads across sign-changing edges. */
function surfaceNets(field: Float32Array, nx: number, ny: number, nz: number, lo: V3, h: number): BodyMesh {
  const at = (i: number, j: number, k: number) => i + nx * (j + ny * k);
  const cellVert = new Int32Array((nx - 1) * (ny - 1) * (nz - 1)).fill(-1);
  const cellAt = (i: number, j: number, k: number) => i + (nx - 1) * (j + (ny - 1) * k);
  const pos: number[] = [];
  const corners = [
    [0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0],
    [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1],
  ];
  const edges = [
    [0, 1], [2, 3], [4, 5], [6, 7],
    [0, 2], [1, 3], [4, 6], [5, 7],
    [0, 4], [1, 5], [2, 6], [3, 7],
  ];
  const v = new Float32Array(8);
  for (let k = 0; k < nz - 1; k++)
    for (let j = 0; j < ny - 1; j++)
      for (let i = 0; i < nx - 1; i++) {
        let inside = 0;
        for (let c = 0; c < 8; c++) {
          v[c] = field[at(i + corners[c][0], j + corners[c][1], k + corners[c][2])];
          if (v[c] < 0) inside++;
        }
        if (inside === 0 || inside === 8) continue;
        let sx = 0, sy = 0, sz = 0, n = 0;
        for (const [a, b] of edges) {
          if (v[a] < 0 === v[b] < 0) continue;
          const t = v[a] / (v[a] - v[b]);
          sx += corners[a][0] + t * (corners[b][0] - corners[a][0]);
          sy += corners[a][1] + t * (corners[b][1] - corners[a][1]);
          sz += corners[a][2] + t * (corners[b][2] - corners[a][2]);
          n++;
        }
        cellVert[cellAt(i, j, k)] = pos.length / 3;
        pos.push(lo[0] + (i + sx / n) * h, lo[1] + (j + sy / n) * h, lo[2] + (k + sz / n) * h);
      }

  const idx: number[] = [];
  const quad = (a: number, b: number, c: number, d: number, flip: boolean) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    if (flip) idx.push(a, c, b, a, d, c);
    else idx.push(a, b, c, a, c, d);
  };
  for (let k = 1; k < nz - 1; k++)
    for (let j = 1; j < ny - 1; j++)
      for (let i = 1; i < nx - 1; i++) {
        const s0 = field[at(i, j, k)] < 0;
        if (i < nx - 1 && s0 !== field[at(i + 1, j, k)] < 0)
          quad(cellVert[cellAt(i, j - 1, k - 1)], cellVert[cellAt(i, j, k - 1)], cellVert[cellAt(i, j, k)], cellVert[cellAt(i, j - 1, k)], s0);
        if (j < ny - 1 && s0 !== field[at(i, j + 1, k)] < 0)
          quad(cellVert[cellAt(i - 1, j, k - 1)], cellVert[cellAt(i - 1, j, k)], cellVert[cellAt(i, j, k)], cellVert[cellAt(i, j, k - 1)], s0);
        if (k < nz - 1 && s0 !== field[at(i, j, k + 1)] < 0)
          quad(cellVert[cellAt(i - 1, j - 1, k)], cellVert[cellAt(i, j - 1, k)], cellVert[cellAt(i, j, k)], cellVert[cellAt(i - 1, j, k)], s0);
      }
  return { positions: new Float32Array(pos), indices: new Uint32Array(idx) };
}

/** Taubin smoothing: removes voxel stair-steps without shrinking the body. */
function taubinSmooth(mesh: BodyMesh, iterations: number) {
  const n = mesh.positions.length / 3;
  const nb: Set<number>[] = Array.from({ length: n }, () => new Set());
  const ix = mesh.indices;
  for (let t = 0; t < ix.length; t += 3)
    for (let e = 0; e < 3; e++) {
      const a = ix[t + e];
      const b = ix[t + ((e + 1) % 3)];
      nb[a].add(b);
      nb[b].add(a);
    }
  const lists = nb.map((s) => Uint32Array.from(s));
  const p = mesh.positions;
  const tmp = new Float32Array(p.length);
  const step = (factor: number) => {
    for (let v = 0; v < n; v++) {
      const l = lists[v];
      if (!l.length) {
        tmp[3 * v] = p[3 * v];
        tmp[3 * v + 1] = p[3 * v + 1];
        tmp[3 * v + 2] = p[3 * v + 2];
        continue;
      }
      let ax = 0, ay = 0, az = 0;
      for (const u of l) {
        ax += p[3 * u];
        ay += p[3 * u + 1];
        az += p[3 * u + 2];
      }
      ax /= l.length;
      ay /= l.length;
      az /= l.length;
      tmp[3 * v] = p[3 * v] + factor * (ax - p[3 * v]);
      tmp[3 * v + 1] = p[3 * v + 1] + factor * (ay - p[3 * v + 1]);
      tmp[3 * v + 2] = p[3 * v + 2] + factor * (az - p[3 * v + 2]);
    }
    p.set(tmp);
  };
  for (let i = 0; i < iterations; i++) {
    step(0.5);
    step(-0.53);
  }
}

/** Make triangles wind counter-clockwise seen from outside (positive volume). */
function orientOutward(mesh: BodyMesh) {
  const p = mesh.positions;
  const ix = mesh.indices;
  let vol = 0;
  for (let t = 0; t < ix.length; t += 3) {
    const a = 3 * ix[t], b = 3 * ix[t + 1], c = 3 * ix[t + 2];
    vol +=
      p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) -
      p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) +
      p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
  }
  if (vol < 0) for (let t = 0; t < ix.length; t += 3) [ix[t + 1], ix[t + 2]] = [ix[t + 2], ix[t + 1]];
}
