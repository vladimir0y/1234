/** Thin client for the Tutu backend. */

export interface GenerateResult {
  image_id: string;
  url: string;
  provider: string;
  prompt: string;
}

export interface ScanMeta {
  id: string;
  name: string;
  format: string;
  bytes: number;
  created_at: number;
}

export interface Project<S = unknown> {
  id: string;
  name: string;
  scan_id: string | null;
  state: S;
  created_at: number;
  updated_at: number;
}

const BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? "";

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = res.statusText;
    try {
      detail = (await res.json()).detail ?? detail;
    } catch {
      /* not json */
    }
    throw new Error(`${res.status}: ${detail}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  url: (path: string) => `${BASE}${path}`,

  health: () => fetch(`${BASE}/api/health`).then((r) => json<{ ok: boolean; image_provider: string }>(r)),

  styles: () => fetch(`${BASE}/api/styles`).then((r) => json<Array<{ id: string; description: string }>>(r)),

  generate: (body: { prompt: string; style: string; region_aspect?: number; seed?: number }) =>
    fetch(`${BASE}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ size: 1024, ...body }),
    }).then((r) => json<GenerateResult>(r)),

  uploadScan: (data: Blob, filename: string, name: string) => {
    const form = new FormData();
    form.append("file", data, filename);
    form.append("name", name);
    return fetch(`${BASE}/api/scans`, { method: "POST", body: form }).then((r) => json<ScanMeta>(r));
  },

  scanMeta: (id: string) => fetch(`${BASE}/api/scans/${id}`).then((r) => json<ScanMeta>(r)),

  scanMesh: (id: string) =>
    fetch(`${BASE}/api/scans/${id}/mesh`).then(async (r) => {
      if (!r.ok) throw new Error(`Скан не знайдено (${r.status})`);
      return r.arrayBuffer();
    }),

  saveProject: <S>(id: string | null, body: { name: string; scan_id: string | null; state: S }) =>
    fetch(`${BASE}/api/projects${id ? `/${id}` : ""}`, {
      method: id ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => json<Project<S>>(r)),

  loadProject: <S>(id: string) => fetch(`${BASE}/api/projects/${id}`).then((r) => json<Project<S>>(r)),
};

export interface BodyPresetParams {
  sex: number; // 0 female .. 1 male
  height_cm: number;
  weight: number;
  muscle: number;
  breast?: number;
  glutes?: number;
  belly?: number;
}

export interface BodyPreset {
  id: string;
  label: string;
  description: string;
  params: BodyPresetParams;
}

export interface BodyMeshData {
  positions: Float32Array;
  indices: Uint32Array;
  landmarks: Record<string, [number, number, number]>;
}

/** Parse the server's TUTB body format: header JSON + float32 xyz + uint32 triangles. */
export function parseBodyMesh(buf: ArrayBuffer): BodyMeshData {
  const view = new DataView(buf);
  const magic = String.fromCharCode(...new Uint8Array(buf, 0, 4));
  if (magic !== "TUTB") throw new Error("Невірний формат моделі тіла");
  const headerLen = view.getUint32(8, true);
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 16, headerLen)));
  let off = 16 + headerLen;
  const nv = view.getUint32(off, true);
  const nt = view.getUint32(off + 4, true);
  off += 8;
  const positions = new Float32Array(buf.slice(off, off + nv * 12));
  const indices = new Uint32Array(buf.slice(off + nv * 12, off + nv * 12 + nt * 12));
  return { positions, indices, landmarks: header.landmarks };
}

export const bodyApi = {
  presets: () => fetch(`${BASE}/api/bodies/presets`).then((r) => json<BodyPreset[]>(r)),
  mesh: async (preset: string, overrides: Partial<BodyPresetParams>) => {
    const q = new URLSearchParams({ preset });
    for (const [k, v] of Object.entries(overrides)) if (v !== undefined) q.set(k, String(v));
    const r = await fetch(`${BASE}/api/bodies/mesh?${q}`);
    if (!r.ok) throw new Error(`Модель тіла недоступна (${r.status})`);
    return parseBodyMesh(await r.arrayBuffer());
  },
};
