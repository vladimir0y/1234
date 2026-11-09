/**
 * Unwraps where the selection is split into groups, each with its own simple
 * mapping, then laid out side by side on one canvas:
 *  - body parts (torso, arms, legs, head) unrolled around their own axis;
 *  - front / back projections, like photos of a body taken from the front and
 *    from the back (how big compositions are usually designed).
 */
import type { CombinedUnwrap } from "./unwrap";

export type V3 = [number, number, number];

export type GroupMapping =
  /** Unrolled around a polyline axis (joints of a limb, or a vertical line for the torso). */
  | { kind: "cylinder"; path: V3[]; front: V3; seam?: number }
  | { kind: "project"; side: "front" | "back" };

export interface GroupSpec {
  label: string;
  mapping: GroupMapping;
}

export interface GroupedUnwrap extends CombinedUnwrap {
  /** Each group's box on the canvas (metres) and label. */
  groups: Array<{
    label: string; minU: number; minV: number; maxU: number; maxV: number;
    /** Front/back projections: canvas u = sx * x + du, v = y (body coordinates). */
    map?: { sx: number; du: number };
    /** Single-axis cylinders: u = (angle - seam mod 2pi) * R * sign + du, v = height along the axis + v0. */
    cyl?: { a: V3; d: V3; e1: V3; e2: V3; seam: number; R: number; sign: number; du: number };
  }>;
}

const GAP = 0.04;

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/**
 * @param positions patch vertex positions (rest pose)
 * @param triangles patch triangles
 * @param faceGroup group index per triangle (-1 = drop)
 */
export function groupedUnwrap(
  positions: ArrayLike<number>,
  triangles: ArrayLike<number>,
  faceGroup: ArrayLike<number>,
  specs: GroupSpec[],
): GroupedUnwrap {
  const P = (v: number): V3 => [positions[3 * v], positions[3 * v + 1], positions[3 * v + 2]];
  const T = triangles.length / 3;
  const outSource: number[] = [];
  const outUV: number[] = [];
  const outTris: number[] = [];
  const outFaceSrc: number[] = [];
  const groups: GroupedUnwrap["groups"] = [];
  let cursor = 0;

  specs.forEach((spec, g) => {
    const faces: number[] = [];
    for (let f = 0; f < T; f++) if (faceGroup[f] === g) faces.push(f);
    if (!faces.length) return;

    // Per-vertex (u, v) for this group.
    const verts = new Map<number, [number, number]>();
    let R = 0;
    const angle = new Map<number, number>();
    const radii: number[] = [];
    // Polyline axis: each vertex measures height along the polyline and its angle
    // around the nearest segment, with angle 0 = the body's front.
    const segs: Array<{ a: V3; d: V3; len: number; start: number; e1: V3; e2: V3 }> = [];
    if (spec.mapping.kind === "cylinder") {
      const path = spec.mapping.path;
      let acc = 0;
      for (let i = 0; i + 1 < path.length; i++) {
        const dv = sub(path[i + 1], path[i]);
        const len = Math.hypot(...dv) || 1e-6;
        const d = norm(dv);
        const fr = spec.mapping.front;
        let f = sub(fr, d.map((x) => x * dot(fr, d)) as V3);
        if (Math.hypot(...f) < 1e-6) f = [1, 0, 0];
        const e2 = norm(f);
        segs.push({ a: path[i], d, len, start: acc, e1: cross(d, e2), e2 });
        acc += len;
      }
    }
    for (const f of faces)
      for (let k = 0; k < 3; k++) {
        const v = triangles[3 * f + k];
        if (verts.has(v)) continue;
        const p = P(v);
        if (spec.mapping.kind === "project") {
          // Seen from the back, x runs the other way.
          verts.set(v, [spec.mapping.side === "front" ? p[0] : -p[0], p[1]]);
          continue;
        }
        let best = segs[0], bt = 0, bd = Infinity;
        segs.forEach((sg, i) => {
          const rel = sub(p, sg.a);
          let t = dot(rel, sg.d);
          // The ends extend past the first/last joint.
          if (i > 0) t = Math.max(t, 0);
          if (i < segs.length - 1) t = Math.min(t, sg.len);
          const q: V3 = [sg.a[0] + sg.d[0] * t, sg.a[1] + sg.d[1] * t, sg.a[2] + sg.d[2] * t];
          const dist = Math.hypot(...sub(p, q));
          if (dist < bd) (bd = dist), (best = sg), (bt = t);
        });
        const r = sub(p, [best.a[0] + best.d[0] * bt, best.a[1] + best.d[1] * bt, best.a[2] + best.d[2] * bt]);
        angle.set(v, Math.atan2(dot(r, best.e1), dot(r, best.e2)));
        radii.push(bd);
        verts.set(v, [0, best.start + bt]);
      }

    // Cylinder: cut where the part is thinnest, then angle * radius.
    let seam = 0;
    if (spec.mapping.kind === "cylinder") {
      radii.sort((a, b) => a - b);
      R = radii[Math.floor(radii.length / 2)] || 0.05;
      const bins = new Array(36).fill(0);
      for (const a of angle.values()) bins[Math.floor(((a + Math.PI) / (2 * Math.PI)) * 36) % 36]++;
      let best = 0;
      for (let b = 1; b < 36; b++) if (bins[b] < bins[best]) best = b;
      seam = spec.mapping.seam ?? ((best + 0.5) / 36) * 2 * Math.PI - Math.PI;
      for (const [v, a] of angle) {
        let t = a - seam;
        while (t < 0) t += 2 * Math.PI;
        while (t >= 2 * Math.PI) t -= 2 * Math.PI;
        verts.get(v)![0] = t; // radians for now
      }
    }

    // Emit this group's vertices; seam-crossing triangles get shifted copies.
    const local = new Map<string, number>();
    const startV = outSource.length;
    const emit = (v: number, shift: boolean) => {
      const key = shift ? `${v}+` : `${v}`;
      let id = local.get(key);
      if (id === undefined) {
        id = outSource.length;
        local.set(key, id);
        outSource.push(v);
        const [u, h] = verts.get(v)!;
        outUV.push(spec.mapping.kind === "cylinder" ? (u + (shift ? 2 * Math.PI : 0)) * R : u, h);
      }
      return id;
    };
    for (const f of faces) {
      const vs = [triangles[3 * f], triangles[3 * f + 1], triangles[3 * f + 2]];
      let wrap = false;
      if (spec.mapping.kind === "cylinder") {
        const us = vs.map((v) => verts.get(v)![0]);
        wrap = Math.max(...us) - Math.min(...us) > Math.PI;
      }
      for (const v of vs) outTris.push(emit(v, wrap && verts.get(v)![0] < Math.PI));
      outFaceSrc.push(f);
    }

    // Unmirror (positive orientation seen from outside), then place on the canvas.
    const gTris = outTris.slice(outTris.length - faces.length * 3);
    let signed = 0;
    for (let i = 0; i < gTris.length; i += 3) signed += area2(outUV, gTris[i], gTris[i + 1], gTris[i + 2]);
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (let i = startV; i < outSource.length; i++) {
      if (signed < 0) outUV[2 * i] = -outUV[2 * i];
      minU = Math.min(minU, outUV[2 * i]);
      maxU = Math.max(maxU, outUV[2 * i]);
      minV = Math.min(minV, outUV[2 * i + 1]);
      maxV = Math.max(maxV, outUV[2 * i + 1]);
    }
    for (let i = startV; i < outSource.length; i++) outUV[2 * i] += cursor - minU;
    const map = spec.mapping.kind === "project"
      ? { sx: (spec.mapping.side === "front" ? 1 : -1) * (signed < 0 ? -1 : 1), du: cursor - minU }
      : undefined;
    const cyl = spec.mapping.kind === "cylinder" && segs.length === 1
      ? { a: segs[0].a, d: segs[0].d, e1: segs[0].e1, e2: segs[0].e2, seam, R, sign: signed < 0 ? -1 : 1, du: cursor - minU }
      : undefined;
    groups.push({ label: spec.label, minU: cursor, maxU: cursor + maxU - minU, minV, maxV, map, cyl });
    cursor += maxU - minU + GAP;
  });

  const uv = Float64Array.from(outUV);
  const tris = Uint32Array.from(outTris);
  const nt = tris.length / 3;
  const areaRatio = new Float64Array(nt);
  let sum = 0, wsum = 0, mx = 0;
  for (let t = 0; t < nt; t++) {
    const [a, b, c] = [outSource[tris[3 * t]], outSource[tris[3 * t + 1]], outSource[tris[3 * t + 2]]].map(P);
    const a3 = Math.hypot(...cross(sub(b, a), sub(c, a))) / 2;
    const r = a3 > 0 ? area2(uv, tris[3 * t], tris[3 * t + 1], tris[3 * t + 2]) / a3 : 1;
    areaRatio[t] = r;
    const d = r > 0 ? Math.abs(Math.log2(r)) : 10;
    sum += d * a3;
    wsum += a3;
    mx = Math.max(mx, d);
  }
  return {
    uv, triangles: tris, areaRatio, source: Uint32Array.from(outSource),
    meanDistortion: wsum ? sum / wsum : 0, maxDistortion: mx, loops: [], cuts: 0, groups,
  };
}

function area2(uv: ArrayLike<number>, a: number, b: number, c: number) {
  return ((uv[2 * b] - uv[2 * a]) * (uv[2 * c + 1] - uv[2 * a + 1]) - (uv[2 * c] - uv[2 * a]) * (uv[2 * b + 1] - uv[2 * a + 1])) / 2;
}

// --- Body parts from the skeleton -------------------------------------------------

export const PART_LABELS: Record<string, string> = {
  torso: "Тулуб",
  head: "Голова",
  "l-arm": "Ліва рука",
  "r-arm": "Права рука",
  "l-leg": "Ліва нога",
  "r-leg": "Права нога",
};

/** Body part of each bone of the MakeHuman rig. */
export function partOfBone(name: string): string {
  if (name === "head") return "head";
  const side = name.endsWith("_l") ? "l" : name.endsWith("_r") ? "r" : "";
  if (/^(upperarm|lowerarm|hand)/.test(name)) return `${side}-arm`;
  if (/^(thigh|calf|foot)/.test(name)) return `${side}-leg`;
  return "torso"; // pelvis, spine, neck, clavicles
}
