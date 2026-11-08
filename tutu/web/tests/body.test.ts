import { describe, expect, it } from "vitest";
import { BODY_PRESETS, buildBody } from "../src/core/bodyModels";
import { lscm } from "../src/core/lscm";
import { buildFaceAdjacency, connectedComponents, extractPatch, faceCentroids, facesInBrush } from "../src/core/topology";

function stats(m: { positions: Float32Array; indices: Uint32Array }) {
  const directed = new Map<string, number>();
  const undirected = new Map<string, number>();
  for (let t = 0; t < m.indices.length; t += 3)
    for (let e = 0; e < 3; e++) {
      const a = m.indices[t + e];
      const b = m.indices[t + ((e + 1) % 3)];
      directed.set(`${a}>${b}`, (directed.get(`${a}>${b}`) ?? 0) + 1);
      const k = a < b ? `${a}_${b}` : `${b}_${a}`;
      undirected.set(k, (undirected.get(k) ?? 0) + 1);
    }
  const dupDirected = [...directed.values()].filter((c) => c > 1).length;
  const open = [...undirected.values()].filter((c) => c === 1).length;
  let minY = Infinity, maxY = -Infinity;
  for (let i = 1; i < m.positions.length; i += 3) {
    minY = Math.min(minY, m.positions[i]);
    maxY = Math.max(maxY, m.positions[i]);
  }
  return { dupDirected, open, height: maxY - minY, edges: undirected.size };
}

describe("base bodies", () => {
  it("has 5 male and 5 female presets", () => {
    expect(BODY_PRESETS.filter((p) => p.params.sex === "male")).toHaveLength(5);
    expect(BODY_PRESETS.filter((p) => p.params.sex === "female")).toHaveLength(5);
  });

  for (const preset of BODY_PRESETS) {
    it(`${preset.id}: one closed, consistently oriented surface at the right height`, () => {
      const t0 = performance.now();
      const m = buildBody(preset.params);
      const ms = performance.now() - t0;
      const s = stats(m);
      expect(s.open).toBe(0);
      expect(s.dupDirected / s.edges).toBeLessThan(0.002); // tiny non-manifold spots allowed
      expect(s.height).toBeGreaterThan(preset.params.height * 0.93);
      expect(s.height).toBeLessThan(preset.params.height * 1.03);
      const tris = m.indices.length / 3;
      expect(tris).toBeGreaterThan(20000);
      expect(tris).toBeLessThan(250000);
      const comps = connectedComponents(buildFaceAdjacency(m), Array.from({ length: tris }, (_, i) => i));
      expect(comps[0].length / tris).toBeGreaterThan(0.99);
      console.log(preset.id, tris, "tris", Math.round(ms), "ms");
    });
  }

  it("unwraps a shoulder-to-chest region across the joint", () => {
    const m = buildBody(BODY_PRESETS[1].params);
    const adj = buildFaceAdjacency(m);
    const c = faceCentroids(m);
    // Face closest to the front of the right shoulder.
    const target: [number, number, number] = [0.15, 1.36, 0.1];
    let best = 0, bd = Infinity;
    for (let f = 0; f < c.length / 3; f++) {
      const d = Math.hypot(c[3 * f] - target[0], c[3 * f + 1] - target[1], c[3 * f + 2] - target[2]);
      if (d < bd) { bd = d; best = f; }
    }
    const faces = facesInBrush(adj, c, best, [c[3 * best], c[3 * best + 1], c[3 * best + 2]], 0.07);
    const patch = extractPatch(m, faces);
    const r = lscm(patch.positions, patch.triangles);
    expect(r.meanDistortion).toBeLessThan(0.3);
  });
});
