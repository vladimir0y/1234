import { describe, expect, it } from "vitest";
import { lscm, uvSignedArea } from "../src/core/lscm";
import {
  boundaryLoopCount,
  buildFaceAdjacency,
  connectedComponents,
  extractPatch,
  faceCentroids,
  facesInBrush,
} from "../src/core/topology";

/** Grid of (nx+1)*(ny+1) vertices mapped through `f(u, v) -> xyz`. */
function grid(nx: number, ny: number, f: (u: number, v: number) => number[]) {
  const positions: number[] = [];
  const indices: number[] = [];
  for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) positions.push(...f(i / nx, j / ny));
  const id = (i: number, j: number) => j * (nx + 1) + i;
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      indices.push(id(i, j), id(i + 1, j), id(i + 1, j + 1));
      indices.push(id(i, j), id(i + 1, j + 1), id(i, j + 1));
    }
  return { positions: new Float64Array(positions), indices: new Uint32Array(indices) };
}

function edgeLengthErrors(pos: Float64Array, tris: Uint32Array, uv: Float64Array) {
  let worst = 0;
  for (let t = 0; t < tris.length; t += 3)
    for (let k = 0; k < 3; k++) {
      const a = tris[t + k];
      const b = tris[t + ((k + 1) % 3)];
      const l3 = Math.hypot(pos[3 * a] - pos[3 * b], pos[3 * a + 1] - pos[3 * b + 1], pos[3 * a + 2] - pos[3 * b + 2]);
      const l2 = Math.hypot(uv[2 * a] - uv[2 * b], uv[2 * a + 1] - uv[2 * b + 1]);
      worst = Math.max(worst, Math.abs(l2 / l3 - 1));
    }
  return worst;
}

describe("lscm", () => {
  it("flattens a planar patch isometrically and keeps real scale", () => {
    // 10cm x 5cm sheet tilted in 3D.
    const m = grid(10, 5, (u, v) => [0.1 * u, 0.05 * v * 0.6, 0.05 * v * 0.8]);
    const r = lscm(m.positions, m.indices);
    expect(edgeLengthErrors(m.positions, m.indices, r.uv)).toBeLessThan(1e-4);
    expect(r.meanDistortion).toBeLessThan(1e-4);
  });

  it("unwraps a half cylinder (forearm-like) with almost no distortion", () => {
    const R = 0.04;
    const m = grid(24, 12, (u, v) => [R * Math.cos(Math.PI * u), 0.2 * v, R * Math.sin(Math.PI * u)]);
    const r = lscm(m.positions, m.indices);
    // A cylinder is developable: the unwrap should be a ~ (pi*R) x 0.2 rectangle.
    expect(edgeLengthErrors(m.positions, m.indices, r.uv)).toBeLessThan(0.01);
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (let i = 0; i < r.uv.length; i += 2) {
      minU = Math.min(minU, r.uv[i]); maxU = Math.max(maxU, r.uv[i]);
      minV = Math.min(minV, r.uv[i + 1]); maxV = Math.max(maxV, r.uv[i + 1]);
    }
    // Oriented so body-up (y, along the arm) is canvas-up.
    expect(maxV - minV).toBeCloseTo(0.2, 2);
    expect(maxU - minU).toBeCloseTo(Math.PI * R, 2);
  });

  it("keeps a sphere cap conformal: no flipped triangles, low distortion", () => {
    const m = grid(20, 20, (u, v) => {
      const th = (u - 0.5) * 1.2;
      const ph = (v - 0.5) * 1.2;
      return [Math.sin(th) * Math.cos(ph), Math.sin(ph), Math.cos(th) * Math.cos(ph)];
    });
    const r = lscm(m.positions, m.indices);
    for (let t = 0; t < m.indices.length / 3; t++) expect(uvSignedArea(r.uv, m.indices, t)).toBeGreaterThan(0);
    expect(r.meanDistortion).toBeLessThan(0.35);
  });

  it("never mirrors: a reversed-winding patch still keeps positive orientation", () => {
    const m = grid(6, 6, (u, v) => [u, v, 0]);
    const rev = m.indices.slice();
    for (let t = 0; t < rev.length; t += 3) [rev[t + 1], rev[t + 2]] = [rev[t + 2], rev[t + 1]];
    const r = lscm(m.positions, rev);
    for (let t = 0; t < rev.length / 3; t++) expect(uvSignedArea(r.uv, rev, t)).toBeGreaterThan(0);
  });
});

describe("topology", () => {
  const m = grid(10, 10, (u, v) => [u, v, 0]);
  const adj = buildFaceAdjacency(m);

  it("builds edge adjacency", () => {
    const counts = Array.from({ length: m.indices.length / 3 }, (_, f) => adj.offsets[f + 1] - adj.offsets[f]);
    expect(Math.max(...counts)).toBe(3);
    expect(Math.min(...counts)).toBe(1); // corner triangle
  });

  it("brush grows over the surface within the radius", () => {
    const c = faceCentroids(m);
    const faces = facesInBrush(adj, c, 110, [0.5, 0.5, 0], 0.15);
    expect(faces.length).toBeGreaterThan(10);
    for (const f of faces.slice(1)) expect(Math.hypot(c[3 * f] - 0.5, c[3 * f + 1] - 0.5)).toBeLessThanOrEqual(0.15);
  });

  it("finds components and boundary loops", () => {
    const comps = connectedComponents(adj, [0, 1, 3, 199, 198]);
    expect(comps.length).toBe(2);
    const patch = extractPatch(m, Array.from({ length: 200 }, (_, i) => i));
    expect(boundaryLoopCount(patch.triangles, patch.vertices.length)).toBe(1);
    // Remove a 2x2 block in the middle -> annulus with 2 loops.
    const hole = new Set<number>();
    for (const [i, j] of [[4, 4], [5, 4], [4, 5], [5, 5]]) { hole.add(2 * (j * 10 + i)); hole.add(2 * (j * 10 + i) + 1); }
    const ring = extractPatch(m, Array.from({ length: 200 }, (_, i) => i).filter((f) => !hole.has(f)));
    expect(boundaryLoopCount(ring.triangles, ring.vertices.length)).toBe(2);
  });
});

describe("unwrapPatches", () => {
  it("lays out islands side by side without overlap", async () => {
    const { unwrapPatches } = await import("../src/core/unwrap");
    const a = grid(4, 4, (u, v) => [0.05 * u, 0.05 * v, 0]);
    const b = grid(4, 4, (u, v) => [0.03 * u, 0.03 * v, 0.2]);
    const r = unwrapPatches([
      { positions: a.positions, triangles: a.indices },
      { positions: b.positions, triangles: b.indices },
    ]);
    expect(r.loops).toEqual([1, 1]);
    const na = a.positions.length / 3;
    let maxA = -Infinity, minB = Infinity;
    for (let i = 0; i < na; i++) maxA = Math.max(maxA, r.uv[2 * i]);
    for (let i = na; i < r.uv.length / 2; i++) minB = Math.min(minB, r.uv[2 * i]);
    expect(minB - maxA).toBeCloseTo(0.01, 4);
    expect(Math.max(...r.triangles)).toBe(r.uv.length / 2 - 1);
  });
});

describe("smoothSelection", () => {
  it("fills notches in a brushed region", async () => {
    const { smoothSelection } = await import("../src/core/topology");
    const m = grid(10, 10, (u, v) => [u, v, 0]);
    const adj = buildFaceAdjacency(m);
    const sel = new Set<number>();
    for (let f = 0; f < 200; f++) if (f % 20 < 12 && f !== 45) sel.add(f); // block with a missing face
    expect(sel.has(45)).toBe(false);
    const out = smoothSelection(adj, sel, 1);
    expect(out.has(45)).toBe(true);
  });
});

describe("ring cutting", () => {
  it("unwraps a full ring around a cylinder (armband) into a strip of the real size", async () => {
    const { unwrapPatches } = await import("../src/core/unwrap");
    const R = 0.04, H = 0.05, N = 48;
    // Closed ring: last column wraps to the first.
    const positions: number[] = [];
    const tris: number[] = [];
    for (let j = 0; j <= 6; j++) for (let i = 0; i < N; i++) {
      const a = (2 * Math.PI * i) / N;
      positions.push(R * Math.cos(a), (H * j) / 6, R * Math.sin(a));
    }
    const id = (i: number, j: number) => j * N + (i % N);
    for (let j = 0; j < 6; j++) for (let i = 0; i < N; i++) {
      tris.push(id(i, j), id(i, j + 1), id(i + 1, j + 1), id(i, j), id(i + 1, j + 1), id(i + 1, j));
    }
    const r = unwrapPatches([{ positions: new Float64Array(positions), triangles: new Uint32Array(tris) }]);
    expect(r.loops).toEqual([2]);
    expect(r.cuts).toBe(1);
    expect(r.source.length).toBe(N * 7 + 7); // one seam column duplicated
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (let i = 0; i < r.uv.length; i += 2) {
      minU = Math.min(minU, r.uv[i]); maxU = Math.max(maxU, r.uv[i]);
      minV = Math.min(minV, r.uv[i + 1]); maxV = Math.max(maxV, r.uv[i + 1]);
    }
    const circ = 2 * N * R * Math.sin(Math.PI / N); // polygon perimeter
    expect(maxU - minU).toBeCloseTo(circ, 2);
    expect(maxV - minV).toBeCloseTo(H, 2);
    expect(r.meanDistortion).toBeLessThan(0.02);
    for (let t = 0; t < r.triangles.length / 3; t++) expect(uvSignedArea(r.uv, r.triangles, t)).toBeGreaterThan(0);
  });

  it("opens a region with a hole", async () => {
    const { cutToDisk, boundaryLoops } = await import("../src/core/topology");
    const m = grid(10, 10, (u, v) => [u, v, 0]);
    const hole = new Set<number>();
    for (const [i, j] of [[4, 4], [5, 4], [4, 5], [5, 5]]) { hole.add(2 * (j * 10 + i)); hole.add(2 * (j * 10 + i) + 1); }
    const ring = extractPatch(m, Array.from({ length: 200 }, (_, i) => i).filter((f) => !hole.has(f)));
    const cut = cutToDisk(ring.positions, ring.triangles, ring.vertices.length);
    expect(cut.cuts).toBe(1);
    expect(boundaryLoops(cut.triangles, cut.source.length)).toHaveLength(1);
  });
});

describe("panorama", () => {
  it("unrolls a full ring around the body into one strip of the real circumference", async () => {
    const { panoramaUnwrap } = await import("../src/core/panorama");
    const R = 0.15, H = 0.3, N = 64;
    const positions: number[] = [];
    const tris: number[] = [];
    for (let j = 0; j <= 5; j++) for (let i = 0; i < N; i++) {
      const a = (2 * Math.PI * i) / N;
      positions.push(R * Math.sin(a), (H * j) / 5, R * Math.cos(a));
    }
    const id = (i: number, j: number) => j * N + (i % N);
    for (let j = 0; j < 5; j++) for (let i = 0; i < N; i++)
      tris.push(id(i, j), id(i + 1, j), id(i + 1, j + 1), id(i, j), id(i + 1, j + 1), id(i, j + 1));
    const r = panoramaUnwrap(positions, tris, { center: [0, 0], seam: "auto" });
    let minU = Infinity, maxU = -Infinity;
    for (let i = 0; i < r.uv.length; i += 2) { minU = Math.min(minU, r.uv[i]); maxU = Math.max(maxU, r.uv[i]); }
    expect(maxU - minU).toBeCloseTo(2 * Math.PI * R, 2);
    expect(r.cuts).toBe(1);
    for (let t = 0; t < r.triangles.length / 3; t++) expect(r.areaRatio[t]).toBeGreaterThan(0.9);
  });
});

describe("grouped unwrap", () => {
  it("lays out a limb ring and a front/back split side by side", async () => {
    const { groupedUnwrap } = await import("../src/core/groupUnwrap");
    // A vertical ring (like a forearm) of radius 4 cm and height 10 cm.
    const R = 0.04, N = 48;
    const positions: number[] = [];
    const tris: number[] = [];
    for (let j = 0; j <= 4; j++) for (let i = 0; i < N; i++) {
      const a = (2 * Math.PI * i) / N;
      positions.push(R * Math.sin(a), 0.025 * j, R * Math.cos(a));
    }
    const id = (i: number, j: number) => j * N + (i % N);
    for (let j = 0; j < 4; j++) for (let i = 0; i < N; i++)
      tris.push(id(i, j), id(i + 1, j), id(i + 1, j + 1), id(i, j), id(i + 1, j + 1), id(i, j + 1));
    const T = tris.length / 3;
    const cyl = groupedUnwrap(positions, tris, new Int32Array(T), [
      { label: "Рука", mapping: { kind: "cylinder", path: [[0, 0, 0], [0, 0.1, 0]], front: [0, 0, 1] } },
    ]);
    const g = cyl.groups[0];
    expect(g.maxU - g.minU).toBeCloseTo(2 * Math.PI * R, 2);
    expect(g.maxV - g.minV).toBeCloseTo(0.1, 3);
    for (let t = 0; t < T; t++) expect(cyl.areaRatio[t]).toBeGreaterThan(0.9);

    // Front/back projection: faces facing +z go to "front", the others to "back".
    const faceGroup = new Int32Array(T);
    for (let t = 0; t < T; t++) {
      const z = (positions[3 * tris[3 * t] + 2] + positions[3 * tris[3 * t + 1] + 2] + positions[3 * tris[3 * t + 2] + 2]) / 3;
      faceGroup[t] = z >= 0 ? 0 : 1;
    }
    const fb = groupedUnwrap(positions, tris, faceGroup, [
      { label: "Спереду", mapping: { kind: "project", side: "front" } },
      { label: "Ззаду", mapping: { kind: "project", side: "back" } },
    ]);
    expect(fb.groups.map((x) => x.label)).toEqual(["Спереду", "Ззаду"]);
    expect(fb.groups[1].minU).toBeGreaterThan(fb.groups[0].maxU);
    expect(fb.groups[0].maxU - fb.groups[0].minU).toBeCloseTo(2 * R, 2);
    // No mirrored triangles in either view.
    for (let t = 0; t < fb.triangles.length / 3; t++) expect(fb.areaRatio[t]).not.toBe(0);
  });
});
