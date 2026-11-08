/**
 * Browser port of server/app/body/model.py for the standalone build:
 * realistic MakeHuman (CC0) body = base mesh + weighted morph targets,
 * exact height, joint landmarks, one Catmull–Clark subdivision.
 * Keep the maths identical to the Python version (tests compare them).
 */
import type { Bone, BodyMeshData, BodyPreset, BodyPresetParams } from "../api";

export const BODY_PRESETS: BodyPreset[] = [
  { id: "m-slim", label: "Худорлявий", description: "низька вага, вузька кістка", params: { sex: 1, height_cm: 180, weight: 0.15, muscle: 0.45 } },
  { id: "m-average", label: "Середній", description: "середні зріст і статура", params: { sex: 1, height_cm: 176, weight: 0.5, muscle: 0.5 } },
  { id: "m-athletic", label: "Атлетичний", description: "розвинені м'язи, мало жиру", params: { sex: 1, height_cm: 181, weight: 0.55, muscle: 0.9 } },
  { id: "m-stocky", label: "Кремезний", description: "широкий, сильний, з запасом", params: { sex: 1, height_cm: 172, weight: 0.8, muscle: 0.75 } },
  { id: "m-heavy", label: "Повний", description: "велика вага, м'який живіт", params: { sex: 1, height_cm: 175, weight: 1, muscle: 0.35 } },
  { id: "f-slim", label: "Струнка", description: "низька вага, тонка кістка", params: { sex: 0, height_cm: 170, weight: 0.15, muscle: 0.45, breast: 0.4 } },
  { id: "f-average", label: "Середня", description: "середні зріст і статура", params: { sex: 0, height_cm: 164, weight: 0.5, muscle: 0.5, breast: 0.5 } },
  { id: "f-athletic", label: "Спортивна", description: "тонус, сильні ноги", params: { sex: 0, height_cm: 168, weight: 0.45, muscle: 0.85, breast: 0.4, glutes: 0.3 } },
  { id: "f-curvy", label: "Пишна", description: "виражені груди і стегна", params: { sex: 0, height_cm: 165, weight: 0.7, muscle: 0.5, breast: 0.85, glutes: 0.6 } },
  { id: "f-plus", label: "Повна", description: "велика вага", params: { sex: 0, height_cm: 162, weight: 1, muscle: 0.35, breast: 0.8, glutes: 0.3 } },
];

interface Header {
  vertices: number;
  quads: number;
  base: number;
  quadsOffset: number;
  joints: Record<string, [number, number]>;
  targets: Record<string, [number, number, number, number]>; // idsOffset, deltaOffset, count, scale
  bones: Array<{ name: string; parent: number; joint: string; ids: number; w: number; count: number }>;
}

export class LocalBodyModel {
  private base: Float64Array;
  private quads: Uint32Array; // in compact body-vertex indices
  private bodyIds: Uint32Array;
  private joints: Record<string, Uint32Array> = {};
  private targets = new Map<string, { ids: Uint16Array; delta: Int16Array; scale: number }>();
  private bones: Header["bones"] = [];
  /** Dense skin weights for body vertices: n x bones, rows sum to 1. */
  private weights: Float32Array = new Float32Array(0);

  constructor(buf: ArrayBuffer) {
    const view = new DataView(buf);
    if (String.fromCharCode(...new Uint8Array(buf, 0, 4)) !== "TUBM") throw new Error("Невірний файл моделі тіла");
    const headLen = view.getUint32(8, true);
    const h: Header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 12, headLen)));
    const data = 12 + headLen;
    this.base = Float64Array.from(new Float32Array(buf, data + h.base, h.vertices * 3));
    const rawQuads = new Uint32Array(buf, data + h.quadsOffset, h.quads * 4);
    for (const [name, [off, n]] of Object.entries(h.joints)) this.joints[name] = new Uint32Array(buf, data + off, n);
    for (const [name, [idsOff, dOff, n, scale]] of Object.entries(h.targets)) {
      this.targets.set(name, { ids: new Uint16Array(buf, data + idsOff, n), delta: new Int16Array(buf, data + dOff, n * 3), scale });
    }
    // Body vertices only (joints are helper cubes used for landmarks).
    const used = new Uint8Array(h.vertices);
    for (const v of rawQuads) used[v] = 1;
    const ids: number[] = [];
    const remap = new Int32Array(h.vertices).fill(-1);
    for (let v = 0; v < h.vertices; v++) if (used[v]) (remap[v] = ids.length), ids.push(v);
    this.bodyIds = Uint32Array.from(ids);
    this.quads = Uint32Array.from(rawQuads, (v) => remap[v]);
    this.bones = h.bones ?? [];
    const B = this.bones.length;
    const w = new Float32Array(ids.length * B);
    this.bones.forEach((b, bi) => {
      const vids = new Uint16Array(buf, data + b.ids, b.count);
      const ws = new Float32Array(buf, data + b.w, b.count);
      for (let i = 0; i < b.count; i++) {
        const v = remap[vids[i]];
        if (v >= 0) w[v * B + bi] += ws[i];
      }
    });
    for (let v = 0; v < ids.length; v++) {
      let s = 0;
      for (let b = 0; b < B; b++) s += w[v * B + b];
      if (s > 1e-6) for (let b = 0; b < B; b++) w[v * B + b] /= s;
    }
    this.weights = w;
  }

  static async load(url: string): Promise<LocalBodyModel> {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Модель тіла не завантажилась (${r.status})`);
    return new LocalBodyModel(await r.arrayBuffer());
  }

  private add(out: Float64Array, name: string, w: number) {
    if (w <= 1e-6) return;
    const t = this.targets.get(name);
    if (!t) return;
    const k = w * t.scale;
    for (let i = 0; i < t.ids.length; i++) {
      const v = 3 * t.ids[i];
      out[v] += t.delta[3 * i] * k;
      out[v + 1] += t.delta[3 * i + 1] * k;
      out[v + 2] += t.delta[3 * i + 2] * k;
    }
  }

  morph(input: BodyPresetParams): Float64Array {
    const p = clampParams(input);
    const v = this.base.slice();
    const three = (x: number): Record<string, number> =>
      x < 0.5 ? { min: 1 - 2 * x, average: 2 * x, max: 0 } : { min: 0, average: 2 - 2 * x, max: 2 * x - 1 };
    const sexes: Record<string, number> = { female: 1 - p.sex, male: p.sex };
    const mus = three(p.muscle);
    const wei = three(p.weight);
    const meanH = 164 + 12 * p.sex;
    const h = Math.min(1, Math.max(0, 0.5 + (p.height_cm - meanH) / 60));
    const hmin = Math.max(0, 1 - 2 * h), hmax = Math.max(0, 2 * h - 1);
    const pu = Math.max(0, 1 - 2 * p.proportions), pi = Math.max(0, 2 * p.proportions - 1);
    const cmin = Math.max(0, 1 - 2 * p.breast), cmax = Math.max(0, 2 * p.breast - 1);
    for (const [s, sw] of Object.entries(sexes)) {
      if (sw <= 1e-6) continue;
      for (const race of ["african", "asian", "caucasian"]) this.add(v, `macrodetails/${race}-${s}-young`, sw / 3);
      for (const [m, mw] of Object.entries(mus))
        for (const [w, ww] of Object.entries(wei)) {
          const k = sw * mw * ww;
          if (k <= 1e-6) continue;
          const combo = `${s}-young-${m}muscle-${w}weight`;
          this.add(v, `macrodetails/universal-${combo}`, k);
          this.add(v, `macrodetails/height/${combo}-minheight`, k * hmin);
          this.add(v, `macrodetails/height/${combo}-maxheight`, k * hmax);
          this.add(v, `macrodetails/proportions/${combo}-idealproportions`, k * pi);
          this.add(v, `macrodetails/proportions/${combo}-uncommonproportions`, k * pu);
          if (s === "female") {
            this.add(v, `breast/${combo}-mincup-averagefirmness`, k * cmin);
            this.add(v, `breast/${combo}-maxcup-averagefirmness`, k * cmax);
          }
        }
    }
    this.add(v, "buttocks/buttocks-volume-incr", Math.max(0, p.glutes));
    this.add(v, "buttocks/buttocks-volume-decr", Math.max(0, -p.glutes));
    this.add(v, "stomach/stomach-pregnant-incr", Math.max(0, p.belly) * 0.5);
    this.add(v, "stomach/stomach-pregnant-decr", Math.max(0, -p.belly));
    return v;
  }

  build(input: BodyPresetParams): BodyMeshData {
    const p = clampParams(input);
    const v = this.morph(p);
    const n = this.bodyIds.length;
    let pos: Float64Array = new Float64Array(n * 3);
    this.bodyIds.forEach((g, i) => pos.set(v.subarray(3 * g, 3 * g + 3), 3 * i));
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < n; i++)
      for (let c = 0; c < 3; c++) {
        lo[c] = Math.min(lo[c], pos[3 * i + c]);
        hi[c] = Math.max(hi[c], pos[3 * i + c]);
      }
    const off = [-(lo[0] + hi[0]) / 2, -lo[1], -(lo[2] + hi[2]) / 2];
    const scale = p.height_cm / 100 / (hi[1] - lo[1]);
    for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) pos[3 * i + c] = (pos[3 * i + c] + off[c]) * scale;
    const landmarks: Record<string, [number, number, number]> = {};
    for (const [name, ids] of Object.entries(this.joints)) {
      const m = [0, 0, 0];
      for (const id of ids) for (let c = 0; c < 3; c++) m[c] += v[3 * id + c] / ids.length;
      landmarks[name] = [(m[0] + off[0]) * scale, (m[1] + off[1]) * scale, (m[2] + off[2]) * scale];
    }
    const sub = catmullClark(pos, this.quads);
    pos = sub.positions;
    const skin = this.bones.length ? this.skin(sub, n, landmarks) : undefined;
    const q = sub.quads;
    const nq = q.length / 4;
    const indices = new Uint32Array(nq * 6);
    for (let i = 0; i < nq; i++) {
      indices[3 * i] = q[4 * i];
      indices[3 * i + 1] = q[4 * i + 1];
      indices[3 * i + 2] = q[4 * i + 2];
      indices[3 * (nq + i)] = q[4 * i];
      indices[3 * (nq + i) + 1] = q[4 * i + 2];
      indices[3 * (nq + i) + 2] = q[4 * i + 3];
    }
    return { positions: Float32Array.from(pos), indices, landmarks, skin };
  }

  /** Subdivide the skin weights like the mesh and keep 4 bones per vertex. */
  private skin(sub: ReturnType<typeof catmullClark>, n: number, landmarks: Record<string, [number, number, number]>) {
    const B = this.bones.length;
    const w = this.weights;
    const { e0, e1 } = sub;
    const ne = e0.length;
    const nf = this.quads.length / 4;
    const total = n + ne + nf;
    const index = new Uint8Array(total * 4);
    const weight = new Uint8Array(total * 4);
    const row = new Float32Array(B);
    for (let v = 0; v < total; v++) {
      row.fill(0);
      if (v < n) for (let b = 0; b < B; b++) row[b] = w[v * B + b];
      else if (v < n + ne) {
        const a = e0[v - n], c = e1[v - n];
        for (let b = 0; b < B; b++) row[b] = (w[a * B + b] + w[c * B + b]) / 2;
      } else {
        const f = v - n - ne;
        for (let k = 0; k < 4; k++) {
          const q = this.quads[4 * f + k];
          for (let b = 0; b < B; b++) row[b] += w[q * B + b] / 4;
        }
      }
      // top 4
      const best = [-1, -1, -1, -1];
      for (let b = 0; b < B; b++) {
        for (let k = 0; k < 4; k++) {
          if (best[k] < 0 || row[b] > row[best[k]]) {
            best.splice(k, 0, b);
            best.length = 4;
            break;
          }
        }
      }
      let s = 0;
      for (const b of best) s += b >= 0 ? row[b] : 0;
      let sum = 0;
      const q = best.map((b) => (b >= 0 && s > 0 ? Math.floor((row[b] / s) * 255) : 0));
      q.forEach((x) => (sum += x));
      q[0] += 255 - sum;
      for (let k = 0; k < 4; k++) {
        index[4 * v + k] = Math.max(0, best[k]);
        weight[4 * v + k] = q[k];
      }
    }
    const bones: Bone[] = this.bones.map((b) => ({ name: b.name, parent: b.parent, head: landmarks[b.joint] }));
    return { bones, index, weight };
  }
}

function clampParams(p: BodyPresetParams) {
  const c = (x: number | undefined, d: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, x ?? d));
  return {
    sex: c(p.sex, 1),
    height_cm: c(p.height_cm, 176, 140, 215),
    weight: c(p.weight, 0.5),
    muscle: c(p.muscle, 0.5),
    proportions: 0.5,
    breast: c(p.breast, 0.5),
    glutes: c(p.glutes, 0, -1, 1),
    belly: c(p.belly, 0, -1, 1),
  };
}

/** One Catmull–Clark level on an all-quad mesh (same rules as the Python version). */
export function catmullClark(v: Float64Array, quads: Uint32Array): { positions: Float64Array; quads: Uint32Array; e0: number[]; e1: number[] } {
  const nv = v.length / 3;
  const nf = quads.length / 4;
  const fp = new Float64Array(nf * 3);
  for (let f = 0; f < nf; f++)
    for (let k = 0; k < 4; k++) for (let c = 0; c < 3; c++) fp[3 * f + c] += v[3 * quads[4 * f + k] + c] / 4;

  // Unique edges, sorted by key like numpy.unique.
  const keys = new Float64Array(nf * 4);
  for (let f = 0; f < nf; f++)
    for (let k = 0; k < 4; k++) {
      const a = quads[4 * f + k], b = quads[4 * f + ((k + 1) % 4)];
      keys[4 * f + k] = Math.min(a, b) * nv + Math.max(a, b);
    }
  const order = Array.from(keys.keys()).sort((i, j) => keys[i] - keys[j]);
  const edgeOf = new Int32Array(nf * 4);
  const e0: number[] = [], e1: number[] = [];
  let last = -1;
  for (const i of order) {
    if (keys[i] !== last) {
      last = keys[i];
      e0.push(Math.floor(last / nv));
      e1.push(last % nv);
    }
    edgeOf[i] = e0.length - 1;
  }
  const ne = e0.length;
  const edgeFaces = new Int32Array(ne);
  const fsum = new Float64Array(ne * 3);
  for (let i = 0; i < nf * 4; i++) {
    const e = edgeOf[i], f = i >> 2;
    edgeFaces[e]++;
    for (let c = 0; c < 3; c++) fsum[3 * e + c] += fp[3 * f + c];
  }
  const mid = new Float64Array(ne * 3);
  const ep = new Float64Array(ne * 3);
  for (let e = 0; e < ne; e++)
    for (let c = 0; c < 3; c++) {
      const a = v[3 * e0[e] + c], b = v[3 * e1[e] + c];
      mid[3 * e + c] = (a + b) / 2;
      ep[3 * e + c] = edgeFaces[e] === 1 ? (a + b) / 2 : (a + b + fsum[3 * e + c]) / (2 + edgeFaces[e]);
    }

  const valence = new Float64Array(nv);
  const fcount = new Float64Array(nv);
  const favg = new Float64Array(nv * 3);
  const ravg = new Float64Array(nv * 3);
  for (let e = 0; e < ne; e++) {
    valence[e0[e]]++;
    valence[e1[e]]++;
    for (let c = 0; c < 3; c++) {
      ravg[3 * e0[e] + c] += mid[3 * e + c];
      ravg[3 * e1[e] + c] += mid[3 * e + c];
    }
  }
  for (let i = 0; i < nf * 4; i++) {
    const a = quads[i], f = i >> 2;
    fcount[a]++;
    for (let c = 0; c < 3; c++) favg[3 * a + c] += fp[3 * f + c];
  }
  const nvPos = new Float64Array(nv * 3);
  for (let a = 0; a < nv; a++) {
    const n = Math.max(fcount[a], 1);
    for (let c = 0; c < 3; c++) {
      const F = favg[3 * a + c] / n;
      const R = ravg[3 * a + c] / Math.max(valence[a], 1);
      nvPos[3 * a + c] = (F + 2 * R + (n - 3) * v[3 * a + c]) / n;
    }
  }
  // Boundary vertices (eye sockets etc.).
  const bsum = new Float64Array(nv * 3);
  const onB = new Uint8Array(nv);
  for (let e = 0; e < ne; e++) {
    if (edgeFaces[e] !== 1) continue;
    onB[e0[e]] = onB[e1[e]] = 1;
    for (let c = 0; c < 3; c++) {
      bsum[3 * e0[e] + c] += v[3 * e1[e] + c];
      bsum[3 * e1[e] + c] += v[3 * e0[e] + c];
    }
  }
  for (let a = 0; a < nv; a++)
    if (onB[a]) for (let c = 0; c < 3; c++) nvPos[3 * a + c] = 0.75 * v[3 * a + c] + 0.125 * bsum[3 * a + c];

  const out = new Float64Array((nv + ne + nf) * 3);
  out.set(nvPos, 0);
  out.set(ep, nv * 3);
  out.set(fp, (nv + ne) * 3);
  const nq = new Uint32Array(nf * 16);
  for (let i = 0; i < 4; i++)
    for (let f = 0; f < nf; f++) {
      const o = 4 * (i * nf + f);
      nq[o] = quads[4 * f + i];
      nq[o + 1] = nv + edgeOf[4 * f + i];
      nq[o + 2] = nv + ne + f;
      nq[o + 3] = nv + edgeOf[4 * f + ((i + 3) % 4)];
    }
  return { positions: out, quads: nq, e0, e1 };
}
