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
