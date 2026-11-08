/**
 * "Panorama" canvas: the selected skin is unrolled around the body's vertical
 * axis, so back, sides, front and legs become one continuous picture — the way
 * people think about a large composition. Less exact than LSCM for small
 * pieces (inner thighs and arms overlap), but continuous all the way round.
 */
import type { CombinedUnwrap } from "./unwrap";

export interface PanoramaOptions {
  /** Body axis in the horizontal plane. */
  center: [number, number];
  /** Angle (radians, 0 = front, +x side positive) where the canvas is cut. "auto" = emptiest direction. */
  seam: number | "auto";
}

export function panoramaUnwrap(positions: ArrayLike<number>, triangles: ArrayLike<number>, opts: PanoramaOptions): CombinedUnwrap & { seam: number; radius: number } {
  const n = positions.length / 3;
  const [cx, cz] = opts.center;
  const theta = new Float64Array(n);
  const rad: number[] = [];
  for (let v = 0; v < n; v++) {
    const dx = positions[3 * v] - cx;
    const dz = positions[3 * v + 2] - cz;
    theta[v] = Math.atan2(dx, dz);
    rad.push(Math.hypot(dx, dz));
  }
  rad.sort((a, b) => a - b);
  const R = rad[Math.floor(rad.length / 2)] || 0.15;

  // Seam where the selection is thinnest (72 bins of 5 degrees).
  let seam = opts.seam === "auto" ? 0 : opts.seam;
  if (opts.seam === "auto") {
    const bins = new Array(72).fill(0);
    for (let v = 0; v < n; v++) bins[Math.floor(((theta[v] + Math.PI) / (2 * Math.PI)) * 72) % 72]++;
    let best = 0;
    for (let b = 1; b < 72; b++) if (bins[b] < bins[best]) best = b;
    seam = ((best + 0.5) / 72) * 2 * Math.PI - Math.PI;
  }
  const t = new Float64Array(n);
  for (let v = 0; v < n; v++) {
    let a = theta[v] - seam;
    while (a < 0) a += 2 * Math.PI;
    while (a >= 2 * Math.PI) a -= 2 * Math.PI;
    t[v] = a;
  }

  // Triangles across the seam get copies of their low-angle corners shifted by 2*pi.
  const source: number[] = Array.from({ length: n }, (_, i) => i);
  const shifted = new Map<number, number>();
  const tris = Uint32Array.from(triangles);
  const T = tris.length / 3;
  const extraT: number[] = [];
  for (let f = 0; f < T; f++) {
    const a = t[tris[3 * f]], b = t[tris[3 * f + 1]], c = t[tris[3 * f + 2]];
    if (Math.max(a, b, c) - Math.min(a, b, c) <= Math.PI) continue;
    for (let k = 0; k < 3; k++) {
      const v = tris[3 * f + k];
      if (t[v] >= Math.PI) continue;
      let copy = shifted.get(v);
      if (copy === undefined) {
        copy = source.length;
        source.push(v);
        extraT.push(t[v] + 2 * Math.PI);
        shifted.set(v, copy);
      }
      tris[3 * f + k] = copy;
    }
  }
  const N = source.length;
  const uv = new Float64Array(N * 2);
  for (let i = 0; i < N; i++) {
    const v = source[i];
    uv[2 * i] = (i < n ? t[v] : extraT[i - n]) * R;
    uv[2 * i + 1] = positions[3 * v + 1];
  }

  // Keep the picture unmirrored when seen from outside.
  const area2 = (f: number) => {
    const a = tris[3 * f], b = tris[3 * f + 1], c = tris[3 * f + 2];
    return ((uv[2 * b] - uv[2 * a]) * (uv[2 * c + 1] - uv[2 * a + 1]) - (uv[2 * c] - uv[2 * a]) * (uv[2 * b + 1] - uv[2 * a + 1])) / 2;
  };
  let signed = 0;
  for (let f = 0; f < T; f++) signed += area2(f);
  if (signed < 0) {
    let maxU = 0;
    for (let i = 0; i < N; i++) maxU = Math.max(maxU, uv[2 * i]);
    for (let i = 0; i < N; i++) uv[2 * i] = maxU - uv[2 * i];
  }

  const areaRatio = new Float64Array(T);
  let sum = 0, wsum = 0, mx = 0;
  for (let f = 0; f < T; f++) {
    const P = (k: number) => 3 * source[tris[3 * f + k]];
    const a = P(0), b = P(1), c = P(2);
    const e1 = [positions[b] - positions[a], positions[b + 1] - positions[a + 1], positions[b + 2] - positions[a + 2]];
    const e2 = [positions[c] - positions[a], positions[c + 1] - positions[a + 1], positions[c + 2] - positions[a + 2]];
    const a3 = Math.hypot(e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]) / 2;
    const r = a3 > 0 ? area2(f) / a3 : 1;
    areaRatio[f] = r;
    const d = r > 0 ? Math.abs(Math.log2(r)) : 10;
    sum += d * a3;
    wsum += a3;
    mx = Math.max(mx, d);
  }
  return {
    uv, triangles: tris, areaRatio, source: Uint32Array.from(source),
    meanDistortion: wsum ? sum / wsum : 0, maxDistortion: mx, loops: [], cuts: shifted.size ? 1 : 0, seam, radius: R,
  };
}
