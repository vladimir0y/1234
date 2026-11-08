/**
 * Where the editor's data comes from.
 *  - "server": the Tutu API (bodies, generators, projects on the server).
 *  - "local":  everything in the browser — used for the claude.ai Artifact build
 *              (VITE_STANDALONE=1): bodies computed here, sketches drawn by Claude,
 *              projects kept in IndexedDB, files saved through the viewer.
 */
import { api, bodyApi, type BodyMeshData, type BodyPreset, type BodyPresetParams, type GenerationJob } from "./api";

export interface StyleInfo {
  id: string;
  label: string;
  mode: "ink" | "color";
}
export interface ProviderInfo {
  id: string;
  label: string;
  free: boolean;
}
export interface GenerateBody {
  prompt: string;
  style: string;
  variants: number;
  region_aspect?: number;
  provider?: string;
  /** Canvas in SVG units with the region's proportions, and its outline path. */
  width?: number;
  height?: number;
  outline?: string;
  references?: Blob[];
}
export interface SavedProject<S> {
  id: string;
  name: string;
  state: S;
}

export interface Backend {
  mode: "server" | "local";
  presets(): Promise<BodyPreset[]>;
  bodyMesh(preset: string, overrides: Partial<BodyPresetParams>): Promise<BodyMeshData>;
  styles(): Promise<StyleInfo[]>;
  providers(): Promise<ProviderInfo[]>;
  generate(body: GenerateBody, onProgress: (job: GenerationJob) => void): Promise<GenerationJob>;
  saveProject<S>(id: string | null, body: { name: string; state: S; mesh?: { data: ArrayBuffer; name: string } }): Promise<{ id: string; meshRef?: string }>;
  loadProject<S>(id: string): Promise<SavedProject<S>>;
  listProjects(): Promise<Array<{ id: string; name: string; updated: number }>>;
  loadSavedMesh(ref: string): Promise<{ data: ArrayBuffer; name: string }>;
  download(blob: Blob, filename: string): Promise<void>;
  /** Claude writes a prompt for an external image generator (browser build only). */
  externalPrompt?(body: GenerateBody): Promise<string>;
}

// ---------------------------------------------------------------------------
const serverBackend: Backend = {
  mode: "server",
  presets: () => bodyApi.presets(),
  bodyMesh: (preset, overrides) => bodyApi.mesh(preset, overrides),
  styles: () => api.styles(),
  providers: () => api.providers(),
  generate: (body, onProgress) => api.generate(body, onProgress),
  async saveProject(id, body) {
    let scanId: string | null = null;
    if (body.mesh) scanId = (await api.uploadScan(new Blob([body.mesh.data]), body.mesh.name, body.mesh.name)).id;
    const saved = await api.saveProject(id, { name: body.name, scan_id: scanId, state: body.state });
    return { id: saved.id, meshRef: scanId ?? undefined };
  },
  async loadProject(id) {
    const p = await api.loadProject(id);
    return { id: p.id, name: p.name, state: p.state as never };
  },
  async listProjects() {
    const r = await fetch(api.url("/api/projects"));
    if (!r.ok) return [];
    const items = (await r.json()) as Array<{ id: string; name: string; updated_at: number }>;
    return items.map((p) => ({ id: p.id, name: p.name, updated: p.updated_at * 1000 }));
  },
  async loadSavedMesh(ref) {
    const meta = await api.scanMeta(ref);
    return { data: await api.scanMesh(ref), name: `scan.${meta.format}` };
  },
  async download(blob, filename) {
    // Inside the iOS app the native side saves files (WKWebView has no downloads).
    const native = (window as unknown as { webkit?: { messageHandlers?: { tutu?: { postMessage(m: unknown): void } } } })
      .webkit?.messageHandlers?.tutu;
    if (native) {
      const reader = new FileReader();
      reader.onload = () => native.postMessage({ type: "file", filename, dataURL: reader.result });
      reader.readAsDataURL(blob);
      return;
    }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  },
};

// ---------------------------------------------------------------------------
async function createLocalBackend(): Promise<Backend> {
  const [{ LocalBodyModel, BODY_PRESETS }, { LOCAL_STYLES, sketchWithClaude, externalPrompt }, { store }, { capability }] = await Promise.all([
    import("./local/bodyModel"),
    import("./local/sketch"),
    import("./local/store"),
    import("./local/claude"),
  ]);
  let model: Promise<InstanceType<typeof LocalBodyModel>> | null = null;
  // Served as .wasm only because Artifact hosting allows that binary type; it is plain data.
  const getModel = () => (model ??= LocalBodyModel.load(new URL("./body-model.wasm", document.baseURI).href));

  return {
    mode: "local",
    presets: async () => BODY_PRESETS,
    async bodyMesh(presetId, overrides) {
      const preset = BODY_PRESETS.find((p) => p.id === presetId) ?? BODY_PRESETS[1];
      return (await getModel()).build({ ...preset.params, ...overrides });
    },
    styles: async () => LOCAL_STYLES.map(({ id, label, mode }) => ({ id, label, mode })),
    providers: async () => [{ id: "claude", label: "Claude (малює SVG)", free: true }],
    async generate(body, onProgress) {
      const job: GenerationJob = { id: `local-${Date.now()}`, status: "running", message: "", images: [], errors: [], prompt: body.prompt };
      try {
        await sketchWithClaude(
          { prompt: body.prompt, style: body.style, variants: body.variants, width: body.width ?? 1024, height: body.height ?? 1024, outline: body.outline, references: body.references },
          (png, i) => {
            job.images.push({ image_id: `${job.id}-${i}`, url: png, provider: "claude", seed: i });
            onProgress({ ...job, images: [...job.images] });
          },
          (msg) => onProgress({ ...job, message: msg }),
        );
        job.status = "done";
        job.message = "Готово";
      } catch (e) {
        job.status = "error";
        job.message = (e as Error).message;
        job.errors.push((e as Error).message);
      }
      return job;
    },
    externalPrompt: (body) =>
      externalPrompt({ prompt: body.prompt, style: body.style, variants: 1, width: body.width ?? 1024, height: body.height ?? 1024, references: body.references }),
    async saveProject(id, body) {
      const pid = id ?? `p${Date.now().toString(36)}`;
      let meshRef: string | undefined;
      if (body.mesh) {
        meshRef = `mesh:${pid}`;
        await store.put(meshRef, body.mesh);
      }
      await store.put(`project:${pid}`, { id: pid, name: body.name, state: body.state, updated: Date.now() });
      return { id: pid, meshRef };
    },
    async loadProject(id) {
      const p = await store.get<{ id: string; name: string; state: never }>(`project:${id}`);
      if (!p) throw new Error("Проєкт не знайдено в цьому браузері");
      return p;
    },
    async listProjects() {
      const keys = (await store.keys()).map(String).filter((k) => k.startsWith("project:"));
      const items = await Promise.all(keys.map((k) => store.get<{ id: string; name: string; updated: number }>(k)));
      return items.filter((p): p is { id: string; name: string; updated: number } => !!p).sort((a, b) => b.updated - a.updated);
    },
    async loadSavedMesh(ref) {
      const m = await store.get<{ data: ArrayBuffer; name: string }>(ref);
      if (!m) throw new Error("Збережений 3D-файл не знайдено");
      return m;
    },
    async download(blob, filename) {
      const downloads = await capability<{ save(r: { filename: string; data: Blob }): Promise<unknown> }>("downloads");
      if (!downloads) throw new Error("Збереження файлів доступне, коли сторінку відкрито в claude.ai");
      await downloads.save({ filename, data: blob });
    },
  };
}

export const STANDALONE = import.meta.env.VITE_STANDALONE === "1";

export function createBackend(): Promise<Backend> {
  return STANDALONE ? createLocalBackend() : Promise.resolve(serverBackend);
}
