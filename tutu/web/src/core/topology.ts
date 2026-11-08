/**
 * Triangle-mesh topology helpers: face adjacency, patch extraction,
 * connected components and boundary loops. Pure math, no three.js.
 */

export interface MeshData {
  /** xyz per vertex (merged / welded vertices). */
  positions: ArrayLike<number>;
  /** 3 vertex indices per triangle. */
  indices: ArrayLike<number>;
}

export interface Patch {
  /** Global face indices included in this patch. */
  faces: number[];
  /** Local vertex index -> global vertex index. */
  vertices: number[];
  /** Local xyz per local vertex. */
  positions: Float64Array;
  /** Local triangle indices. */
  triangles: Uint32Array;
}

export function faceCount(mesh: MeshData): number {
  return Math.floor(mesh.indices.length / 3);
}

/** For each face, the list of faces sharing an edge with it (CSR layout). */
export interface FaceAdjacency {
  offsets: Uint32Array;
  neighbors: Uint32Array;
}

export function buildFaceAdjacency(mesh: MeshData): FaceAdjacency {
  const F = faceCount(mesh);
  const idx = mesh.indices;
  const edgeFaces = new Map<number, number[]>();
  const nv = mesh.positions.length / 3 + 1;
  for (let f = 0; f < F; f++) {
    for (let k = 0; k < 3; k++) {
      const a = idx[3 * f + k];
      const b = idx[3 * f + ((k + 1) % 3)];
      const key = a < b ? a * nv + b : b * nv + a;
      const list = edgeFaces.get(key);
      if (list) list.push(f);
      else edgeFaces.set(key, [f]);
    }
  }
  const counts = new Uint32Array(F);
  for (const list of edgeFaces.values()) {
    if (list.length < 2) continue;
    for (const f of list) counts[f] += list.length - 1;
  }
  const offsets = new Uint32Array(F + 1);
  for (let f = 0; f < F; f++) offsets[f + 1] = offsets[f] + counts[f];
  const neighbors = new Uint32Array(offsets[F]);
  const fill = offsets.slice(0, F);
  for (const list of edgeFaces.values()) {
    if (list.length < 2) continue;
    for (const f of list) for (const g of list) if (f !== g) neighbors[fill[f]++] = g;
  }
  return { offsets, neighbors };
}

export function faceCentroids(mesh: MeshData): Float32Array {
  const F = faceCount(mesh);
  const out = new Float32Array(F * 3);
  const p = mesh.positions;
  const idx = mesh.indices;
  for (let f = 0; f < F; f++) {
    for (let k = 0; k < 3; k++) {
      const v = idx[3 * f + k];
      out[3 * f] += p[3 * v] / 3;
      out[3 * f + 1] += p[3 * v + 1] / 3;
      out[3 * f + 2] += p[3 * v + 2] / 3;
    }
  }
  return out;
}

/**
 * Faces reachable from `seed` across shared edges whose centroid lies within
 * `radius` of `center`. Growing over the surface (not just a sphere test)
 * keeps the brush from leaking onto a nearby but unconnected body part.
 */
export function facesInBrush(
  adj: FaceAdjacency,
  centroids: Float32Array,
  seed: number,
  center: [number, number, number],
  radius: number,
): number[] {
  const r2 = radius * radius;
  const seen = new Set<number>([seed]);
  const queue = [seed];
  const out: number[] = [];
  while (queue.length) {
    const f = queue.pop()!;
    out.push(f);
    for (let i = adj.offsets[f]; i < adj.offsets[f + 1]; i++) {
      const g = adj.neighbors[i];
      if (seen.has(g)) continue;
      seen.add(g);
      const dx = centroids[3 * g] - center[0];
      const dy = centroids[3 * g + 1] - center[1];
      const dz = centroids[3 * g + 2] - center[2];
      if (dx * dx + dy * dy + dz * dz <= r2) queue.push(g);
    }
  }
  return out;
}

/** Split a face set into edge-connected components, largest first. */
export function connectedComponents(adj: FaceAdjacency, faces: Iterable<number>): number[][] {
  const inSet = new Set(faces);
  const seen = new Set<number>();
  const comps: number[][] = [];
  for (const start of inSet) {
    if (seen.has(start)) continue;
    const comp: number[] = [];
    const stack = [start];
    seen.add(start);
    while (stack.length) {
      const f = stack.pop()!;
      comp.push(f);
      for (let i = adj.offsets[f]; i < adj.offsets[f + 1]; i++) {
        const g = adj.neighbors[i];
        if (inSet.has(g) && !seen.has(g)) {
          seen.add(g);
          stack.push(g);
        }
      }
    }
    comps.push(comp.sort((a, b) => a - b));
  }
  return comps.sort((a, b) => b.length - a.length);
}

export function extractPatch(mesh: MeshData, faces: number[]): Patch {
  const local = new Map<number, number>();
  const vertices: number[] = [];
  const triangles = new Uint32Array(faces.length * 3);
  faces.forEach((f, i) => {
    for (let k = 0; k < 3; k++) {
      const g = mesh.indices[3 * f + k];
      let l = local.get(g);
      if (l === undefined) {
        l = vertices.length;
        local.set(g, l);
        vertices.push(g);
      }
      triangles[3 * i + k] = l;
    }
  });
  const positions = new Float64Array(vertices.length * 3);
  vertices.forEach((g, l) => {
    positions[3 * l] = mesh.positions[3 * g];
    positions[3 * l + 1] = mesh.positions[3 * g + 1];
    positions[3 * l + 2] = mesh.positions[3 * g + 2];
  });
  return { faces, vertices, positions, triangles };
}

/** Number of closed boundary loops of a triangle patch (1 for a disk). */
export function boundaryLoopCount(triangles: ArrayLike<number>, vertexCount: number): number {
  const edgeUse = new Map<number, number>();
  const n = vertexCount + 1;
  for (let t = 0; t < triangles.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const a = triangles[t + k];
      const b = triangles[t + ((k + 1) % 3)];
      const key = a < b ? a * n + b : b * n + a;
      edgeUse.set(key, (edgeUse.get(key) ?? 0) + 1);
    }
  }
  // Union-find over boundary edges.
  const parent = new Map<number, number>();
  const find = (x: number): number => {
    let r = x;
    while (parent.get(r)! !== r) r = parent.get(r)!;
    parent.set(x, r);
    return r;
  };
  for (const [key, uses] of edgeUse) {
    if (uses !== 1) continue;
    const a = Math.floor(key / n);
    const b = key % n;
    if (!parent.has(a)) parent.set(a, a);
    if (!parent.has(b)) parent.set(b, b);
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }
  const roots = new Set<number>();
  for (const v of parent.keys()) roots.add(find(v));
  return roots.size;
}

/**
 * Morphological clean-up of a brushed face selection: fills notches (faces
 * with >= 2 selected neighbours) and drops spikes (faces with <= 1), so the
 * region outline — and the printed stencil edge — is less jagged.
 */
export function smoothSelection(adj: FaceAdjacency, selection: Set<number>, iterations = 2): Set<number> {
  let current = new Set(selection);
  for (let it = 0; it < iterations; it++) {
    const next = new Set(current);
    const candidates = new Set<number>();
    for (const f of current) {
      candidates.add(f);
      for (let i = adj.offsets[f]; i < adj.offsets[f + 1]; i++) candidates.add(adj.neighbors[i]);
    }
    for (const f of candidates) {
      let n = 0;
      let total = 0;
      for (let i = adj.offsets[f]; i < adj.offsets[f + 1]; i++) {
        total++;
        if (current.has(adj.neighbors[i])) n++;
      }
      if (!current.has(f) && n >= 2) next.add(f);
      else if (current.has(f) && total >= 2 && n <= 1 && current.size > 8) next.delete(f);
    }
    current = next;
  }
  return current;
}
