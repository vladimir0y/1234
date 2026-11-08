import { lscm } from "./lscm";
import { boundaryLoopCount } from "./topology";

export interface PatchInput {
  positions: Float64Array;
  triangles: Uint32Array;
}

export interface CombinedUnwrap {
  /** uv per vertex of all patches concatenated, in metres. */
  uv: Float64Array;
  /** Triangles re-indexed into the concatenated vertex list. */
  triangles: Uint32Array;
  areaRatio: Float64Array;
  meanDistortion: number;
  maxDistortion: number;
  /** Boundary loops per patch: 1 = disk (good), 0 = closed, >1 = ring/holes. */
  loops: number[];
}

const GAP = 0.01; // 1 cm between islands

/** Unwrap each island with LSCM and lay them out side by side. */
export function unwrapPatches(patches: PatchInput[], up: [number, number, number] = [0, 1, 0]): CombinedUnwrap {
  const nv = patches.reduce((s, p) => s + p.positions.length / 3, 0);
  const nt = patches.reduce((s, p) => s + p.triangles.length / 3, 0);
  const uv = new Float64Array(nv * 2);
  const triangles = new Uint32Array(nt * 3);
  const areaRatio = new Float64Array(nt);
  const loops: number[] = [];
  let vOff = 0;
  let tOff = 0;
  let cursorU = 0;
  let distSum = 0;
  let distW = 0;
  let maxD = 0;
  for (const p of patches) {
    const n = p.positions.length / 3;
    const T = p.triangles.length / 3;
    const l = boundaryLoopCount(p.triangles, n);
    loops.push(l);
    if (l === 0) throw new Error("Виділено замкнену поверхню цілком — зменшіть ділянку");
    const r = lscm(p.positions, p.triangles, { up });
    let minU = Infinity, minV = Infinity, maxU = -Infinity;
    for (let i = 0; i < n; i++) {
      minU = Math.min(minU, r.uv[2 * i]);
      maxU = Math.max(maxU, r.uv[2 * i]);
      minV = Math.min(minV, r.uv[2 * i + 1]);
    }
    for (let i = 0; i < n; i++) {
      uv[2 * (vOff + i)] = r.uv[2 * i] - minU + cursorU;
      uv[2 * (vOff + i) + 1] = r.uv[2 * i + 1] - minV;
    }
    for (let t = 0; t < T * 3; t++) triangles[3 * tOff + t] = p.triangles[t] + vOff;
    areaRatio.set(r.areaRatio, tOff);
    distSum += r.meanDistortion * T;
    distW += T;
    maxD = Math.max(maxD, r.maxDistortion);
    cursorU += maxU - minU + GAP;
    vOff += n;
    tOff += T;
  }
  return { uv, triangles, areaRatio, meanDistortion: distW ? distSum / distW : 0, maxDistortion: maxD, loops };
}
