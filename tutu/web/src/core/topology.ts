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

/** Closed boundary loops of a patch, each as an ordered-ish vertex list. */
export function boundaryLoops(triangles: ArrayLike<number>, vertexCount: number): number[][] {
  const n = vertexCount + 1;
  const use = new Map<number, number>();
  for (let t = 0; t < triangles.length; t += 3)
    for (let k = 0; k < 3; k++) {
      const a = triangles[t + k];
      const b = triangles[t + ((k + 1) % 3)];
      const key = a < b ? a * n + b : b * n + a;
      use.set(key, (use.get(key) ?? 0) + 1);
    }
  const adj = new Map<number, number[]>();
  for (const [key, c] of use) {
    if (c !== 1) continue;
    const a = Math.floor(key / n);
    const b = key % n;
    (adj.get(a) ?? adj.set(a, []).get(a)!).push(b);
    (adj.get(b) ?? adj.set(b, []).get(b)!).push(a);
  }
  const seen = new Set<number>();
  const loops: number[][] = [];
  for (const start of adj.keys()) {
    if (seen.has(start)) continue;
    const loop: number[] = [];
    const stack = [start];
    seen.add(start);
    while (stack.length) {
      const v = stack.pop()!;
      loop.push(v);
      for (const w of adj.get(v)!) if (!seen.has(w)) (seen.add(w), stack.push(w));
    }
    loops.push(loop);
  }
  return loops.sort((a, b) => b.length - a.length);
}

export interface CutResult {
  triangles: Uint32Array;
  /** New vertex index -> original vertex index. */
  source: Uint32Array;
  cuts: number;
}

/**
 * Turn a patch with several boundaries (a ring around the arm, a region with
 * holes) into a disk by cutting along shortest edge paths between boundaries.
 * Vertices on a cut are duplicated, so LSCM can lay the ring out as a strip.
 */
export function cutToDisk(positions: ArrayLike<number>, triangles: ArrayLike<number>, vertexCount: number): CutResult {
  let tris = Uint32Array.from(triangles);
  const source: number[] = Array.from({ length: vertexCount }, (_, i) => i);
  let cuts = 0;
  for (let guard = 0; guard < 16; guard++) {
    const loops = boundaryLoops(tris, source.length);
    if (loops.length <= 1) break;
    const path = shortestPathBetween(positions, source, tris, loops[0], new Set(loops.slice(1).flat()));
    if (!path) break;
    tris = cutAlong(tris, path, source);
    cuts++;
  }
  return { triangles: tris, source: Uint32Array.from(source), cuts };
}

function vertexNeighbors(tris: ArrayLike<number>, n: number): number[][] {
  const nb: Set<number>[] = Array.from({ length: n }, () => new Set());
  for (let t = 0; t < tris.length; t += 3)
    for (let k = 0; k < 3; k++) {
      const a = tris[t + k];
      const b = tris[t + ((k + 1) % 3)];
      nb[a].add(b);
      nb[b].add(a);
    }
  return nb.map((s) => [...s]);
}

function shortestPathBetween(
  positions: ArrayLike<number>,
  source: number[],
  tris: ArrayLike<number>,
  from: number[],
  targets: Set<number>,
): number[] | null {
  const n = source.length;
  const nb = vertexNeighbors(tris, n);
  const dist = new Float64Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const P = (v: number, c: number) => positions[3 * source[v] + c];
  // Small binary heap.
  const heap: Array<[number, number]> = [];
  const push = (d: number, v: number) => {
    heap.push([d, v]);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p][0] <= heap[i][0]) break;
      [heap[p], heap[i]] = [heap[i], heap[p]];
      i = p;
    }
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]];
        i = m;
      }
    }
    return top;
  };
  for (const v of from) {
    dist[v] = 0;
    push(0, v);
  }
  while (heap.length) {
    const [d, v] = pop();
    if (d > dist[v]) continue;
    if (targets.has(v)) {
      const path = [v];
      let u = prev[v];
      while (u >= 0) {
        path.push(u);
        u = prev[u];
      }
      return path.reverse();
    }
    for (const w of nb[v]) {
      const nd = d + Math.hypot(P(v, 0) - P(w, 0), P(v, 1) - P(w, 1), P(v, 2) - P(w, 2));
      if (nd < dist[w]) {
        dist[w] = nd;
        prev[w] = v;
        push(nd, w);
      }
    }
  }
  return null;
}

/** Duplicate the vertices along `path` so the surface opens along it. */
function cutAlong(tris: Uint32Array, path: number[], source: number[]): Uint32Array<ArrayBuffer> {
  const out = Uint32Array.from(tris);
  const T = tris.length / 3;
  const onPath = new Set<string>();
  for (let i = 0; i + 1 < path.length; i++) {
    const a = path[i];
    const b = path[i + 1];
    onPath.add(a < b ? `${a}_${b}` : `${b}_${a}`);
  }
  const facesOf = new Map<number, number[]>();
  for (let t = 0; t < T; t++)
    for (let k = 0; k < 3; k++) {
      const v = tris[3 * t + k];
      (facesOf.get(v) ?? facesOf.set(v, []).get(v)!).push(t);
    }
  for (const v of path) {
    const fan = facesOf.get(v) ?? [];
    // Group the faces around v: neighbours across an edge (v, w) that is not on the cut.
    const group = new Map<number, number>();
    let groups = 0;
    for (const f of fan) {
      if (group.has(f)) continue;
      const stack = [f];
      group.set(f, groups);
      while (stack.length) {
        const g = stack.pop()!;
        for (let k = 0; k < 3; k++) {
          const w = tris[3 * g + k];
          if (w === v) continue;
          const key = v < w ? `${v}_${w}` : `${w}_${v}`;
          if (onPath.has(key)) continue;
          for (const h of fan) {
            if (group.has(h)) continue;
            if (tris[3 * h] === w || tris[3 * h + 1] === w || tris[3 * h + 2] === w) {
              group.set(h, groups);
              stack.push(h);
            }
          }
        }
      }
      groups++;
    }
    // Every group after the first gets its own copy of v.
    for (let g = 1; g < groups; g++) {
      const copy = source.length;
      source.push(source[v]);
      for (const [f, gi] of group) {
        if (gi !== g) continue;
        for (let k = 0; k < 3; k++) if (out[3 * f + k] === v) out[3 * f + k] = copy;
      }
    }
  }
  return out;
}

/** Edge-connected faces satisfying `accept`, grouped; largest group first. */
export function acceptedComponents(adj: FaceAdjacency, faceCount: number, accept: (f: number) => boolean): number[][] {
  const faces: number[] = [];
  for (let f = 0; f < faceCount; f++) if (accept(f)) faces.push(f);
  return connectedComponents(adj, faces);
}
