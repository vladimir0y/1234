import * as THREE from "three";
import { api, bodyApi, type BodyMeshData, type BodyPreset, type BodyPresetParams } from "./api";
import { extensionOf, MESH_EXTENSIONS, parseMesh, prepareBody } from "./core/loaders";
import { setPngDpi } from "./core/png";
import { acceptedComponents, buildFaceAdjacency, connectedComponents, extractPatch, smoothSelection } from "./core/topology";
import type { CombinedUnwrap, PatchInput } from "./core/unwrap";
import { UnwrapEditor, type ImageLayer, type Layer, type Tool } from "./unwrapEditor";
import { Viewer, type BrushMode } from "./viewer";

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const $$ = <T extends HTMLElement = HTMLElement>(sel: string) => [...document.querySelectorAll<T>(sel)];

// ---------------------------------------------------------------------------
// State
type BodyModel = { type: "body"; preset: string; overrides: Partial<BodyPresetParams> };
type ModelSource = BodyModel | { type: "scan"; id: string } | { type: "file"; name: string };
type Sex = "male" | "female";

interface ProjectState {
  model: BodyModel | { type: "scan"; id: string };
  selection: number[]; // run-length encoded [start, length, ...]
  up?: [number, number, number]; // unwrap orientation (limb axis for zones)
  layers: ReturnType<UnwrapEditor["serialize"]>;
}

const viewer = new Viewer($("#viewport"));
const editor = new UnwrapEditor($("#unwrap"));
let model: ModelSource = { type: "body", preset: "m-average", overrides: {} };
let presets: BodyPreset[] = [];
let landmarks: BodyMeshData["landmarks"] | null = null;
let rawFile: { data: ArrayBuffer; name: string } | null = null;
let projectId: string | null = new URLSearchParams(location.search).get("project");
let texture: THREE.CanvasTexture | null = null;
let patchVertices: number[] = [];
let adjacency: ReturnType<typeof buildFaceAdjacency> | null = null;

// ---------------------------------------------------------------------------
// UI helpers
let toastTimer = 0;
function toast(msg: string, error = false) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.toggle("error", error);
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.classList.remove("show"), error ? 5000 : 2600);
}

function download(blob: Blob, filename: string) {
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
}

const loadImage = (src: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Не вдалося завантажити зображення"));
    img.src = src;
  });

function rle(sorted: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    out.push(sorted[i], j - i + 1);
    i = j + 1;
  }
  return out;
}
function unrle(runs: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < runs.length; i += 2) for (let k = 0; k < runs[i + 1]; k++) out.push(runs[i] + k);
  return out;
}

// ---------------------------------------------------------------------------
// Model loading
async function loadGeometry(geometry: THREE.BufferGeometry, label: string, opts: { keepCamera?: boolean } = {}) {
  const prepared = prepareBody(geometry);
  landmarks = null;
  viewer.setBody(prepared, opts.keepCamera);
  brush3d.value = String(Math.round(viewer.brushRadius * 1000));
  $("#brush3d-out").textContent = `${(viewer.brushRadius * 100).toFixed(1)} см`;
  adjacency = buildFaceAdjacency(viewer.mesh!);
  editor.setGeometry(null);
  patchVertices = [];
  const s = prepared.size;
  const faces = viewer.mesh!.indices.length / 3;
  $("#model-info").textContent =
    `${label}: ${(s.x * 100).toFixed(0)}×${(s.y * 100).toFixed(0)}×${(s.z * 100).toFixed(0)} см, ` +
    `${faces.toLocaleString("uk")} трикутників` + (prepared.unit !== "m" ? ` (одиниці файлу: ${prepared.unit})` : "");
}

// --- Realistic base bodies, generated on the server from anthropometric morphs
const bodyCache = new Map<string, BodyMeshData>();
let bodyRequest = 0;

function presetById(id: string): BodyPreset | undefined {
  return presets.find((p) => p.id === id);
}

function bodyParams(m: BodyModel): BodyPresetParams | null {
  const p = presetById(m.preset);
  return p ? { ...p.params, ...m.overrides } : null;
}

/** Litres of a closed mesh; for a body ~ kilograms (density ~1). */
function meshVolume(pos: ArrayLike<number>, idx: ArrayLike<number>): number {
  let v = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const a = 3 * idx[t], b = 3 * idx[t + 1], c = 3 * idx[t + 2];
    v +=
      pos[a] * (pos[b + 1] * pos[c + 2] - pos[b + 2] * pos[c + 1]) -
      pos[a + 1] * (pos[b] * pos[c + 2] - pos[b + 2] * pos[c]) +
      pos[a + 2] * (pos[b] * pos[c + 1] - pos[b + 1] * pos[c]);
  }
  return (v / 6) * 1000;
}

async function loadBody(presetId: string, overrides: Partial<BodyPresetParams> = {}) {
  const preset = presetById(presetId) ?? presets[1];
  if (!preset) throw new Error("Моделі тіла завантажуються з сервера — сервер недоступний");
  // Same topology for every body: keep the region and the design when only the shape changes.
  const keepSelection = model.type === "body" && viewer.mesh ? [...viewer.selection] : [];
  model = { type: "body", preset: preset.id, overrides };
  rawFile = null;
  syncBodyUI();
  const request = ++bodyRequest;
  const overlay = document.createElement("div");
  overlay.className = "loading-overlay";
  overlay.textContent = "Будую модель тіла…";
  $("#viewport").appendChild(overlay);
  try {
    const key = JSON.stringify([preset.id, overrides]);
    let mesh = bodyCache.get(key);
    if (!mesh) {
      mesh = await bodyApi.mesh(preset.id, overrides);
      bodyCache.set(key, mesh);
    }
    if (request !== bodyRequest) return; // superseded by a newer choice
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(mesh.positions.slice(), 3));
    g.setIndex(new THREE.BufferAttribute(mesh.indices.slice(), 1));
    const params = bodyParams(model)!;
    const kg = meshVolume(mesh.positions, mesh.indices);
    const sex = params.sex >= 0.5 ? "Чоловіче" : "Жіноче";
    await loadGeometry(g, `${sex} · ${preset.label}`, { keepCamera: keepSelection.length > 0 });
    landmarks = mesh.landmarks;
    $("#model-info").textContent = `${sex} · ${preset.label}: ${Math.round(params.height_cm)} см, ≈${Math.round(kg)} кг`;
    if (keepSelection.length) {
      viewer.setSelection(keepSelection);
      await unwrapSelection();
    }
  } finally {
    overlay.remove();
  }
}

async function loadMeshData(data: ArrayBuffer, filename: string, source: ModelSource) {
  const ext = extensionOf(filename);
  const geometry = await parseMesh(data, ext);
  model = source;
  await loadGeometry(geometry, filename);
}

async function loadScan(id: string) {
  const meta = await api.scanMeta(id);
  const data = await api.scanMesh(id);
  rawFile = null;
  await loadMeshData(data, `scan.${meta.format}`, { type: "scan", id });
  syncBodyUI();
  $("#model-info").textContent = `${meta.name} · ` + $("#model-info").textContent;
}

// ---------------------------------------------------------------------------
// Unwrap pipeline (runs in a worker)
const worker = new Worker(new URL("./unwrap.worker.ts", import.meta.url), { type: "module" });
let jobId = 0;
let pending: { resolve: (r: CombinedUnwrap) => void; reject: (e: Error) => void } | null = null;
worker.onmessage = (e: MessageEvent<{ id: number; result?: CombinedUnwrap; error?: string }>) => {
  if (e.data.id !== jobId || !pending) return; // stale result
  if (e.data.error) pending.reject(new Error(e.data.error));
  else pending.resolve(e.data.result!);
  pending = null;
};

/** "Up" for the unwrap: along the limb for limb zones, else world up. */
let unwrapUp: [number, number, number] = [0, 1, 0];

function runUnwrap(patches: PatchInput[]): Promise<CombinedUnwrap> {
  pending?.reject(new Error("cancelled"));
  const id = ++jobId;
  return new Promise((resolve, reject) => {
    pending = { resolve, reject };
    worker.postMessage({ id, patches, up: unwrapUp });
  });
}

const info = $("#region-info");
function setInfo(text: string, warn = false) {
  info.textContent = text;
  info.classList.toggle("warn", warn);
}

async function unwrapSelection() {
  const mesh = viewer.mesh;
  if (!mesh || !adjacency) return;
  if (viewer.selection.size < 2) {
    editor.setGeometry(null);
    viewer.clearPatch();
    patchVertices = [];
    setInfo("Розгортка ділянки — тут малюєте і розміщуєте ескіз");
    return;
  }
  const comps = connectedComponents(adjacency, viewer.selection).filter((c) => c.length >= 2);
  const patches = comps.map((faces) => extractPatch(mesh, faces));
  setInfo("Розгортаю…");
  let result: CombinedUnwrap;
  try {
    result = await runUnwrap(patches.map((p) => ({ positions: p.positions, triangles: p.triangles })));
  } catch (err) {
    if ((err as Error).message !== "cancelled") setInfo((err as Error).message, true);
    return;
  }
  const flat = patches.flatMap((p) => p.vertices);
  patchVertices = Array.from(result.source, (i) => flat[i]); // cut seams duplicate vertices
  editor.setGeometry({ uv: result.uv, triangles: result.triangles, areaRatio: result.areaRatio });

  texture?.dispose();
  texture = new THREE.CanvasTexture(editor.texture);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = viewer.renderer.capabilities.getMaxAnisotropy();
  viewer.setPatch(patchVertices, result.triangles, editor.textureUVs(), texture);

  const { width, height } = editor.size;
  const quality = result.meanDistortion < 0.05 ? "відмінна" : result.meanDistortion < 0.15 ? "добра" : "помітні спотворення";
  setInfo(
    `${(width * 100).toFixed(1)} × ${(height * 100).toFixed(1)} см · розгортка: ${quality}` +
      (comps.length > 1 ? ` · ${comps.length} ділянки` : "") +
      (result.cuts ? ` · кільце розрізано швом (${result.cuts})` : ""),
    result.meanDistortion >= 0.15,
  );
  markDirty();
}

editor.onTextureChange = () => {
  if (texture) texture.needsUpdate = true;
};

let unwrapTimer = 0;
viewer.onStrokeEnd = () => {
  unwrapUp = [0, 1, 0];
  if (adjacency && viewer.selection.size > 8) viewer.setSelection(smoothSelection(adjacency, viewer.selection));
  clearTimeout(unwrapTimer);
  unwrapTimer = window.setTimeout(unwrapSelection, 60);
};
// --- Ready-made zones around limbs, from the body's joint landmarks
type Zone = { from: string; to: string; t0: number; t1: number; radius: number };
const ZONES: Record<string, Zone> = {
  "l-forearm-band": { from: "l-elbow", to: "l-hand", t0: 0.45, t1: 0.72, radius: 0.09 },
  "l-forearm-sleeve": { from: "l-elbow", to: "l-hand", t0: 0.08, t1: 0.88, radius: 0.09 },
  "l-upperarm-band": { from: "l-shoulder", to: "l-elbow", t0: 0.4, t1: 0.72, radius: 0.11 },
  "l-thigh-band": { from: "l-upper-leg", to: "l-knee", t0: 0.35, t1: 0.65, radius: 0.17 },
  "l-calf-band": { from: "l-knee", to: "l-ankle", t0: 0.45, t1: 0.75, radius: 0.12 },
};
$<HTMLSelectElement>("#zone").addEventListener("change", (e) => {
  const sel = e.target as HTMLSelectElement;
  const z = ZONES[sel.value];
  sel.value = "";
  if (!z) return;
  if (!landmarks || !viewer.adjacency || !viewer.centroids) return toast("Готові зони доступні для базових тіл", true);
  const a = landmarks[z.from];
  const b = landmarks[z.to];
  const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const len2 = d[0] ** 2 + d[1] ** 2 + d[2] ** 2;
  const c = viewer.centroids;
  const inZone = (f: number) => {
    const p = [c[3 * f] - a[0], c[3 * f + 1] - a[1], c[3 * f + 2] - a[2]];
    const t = (p[0] * d[0] + p[1] * d[1] + p[2] * d[2]) / len2;
    if (t < z.t0 || t > z.t1) return false;
    return Math.hypot(p[0] - t * d[0], p[1] - t * d[1], p[2] - t * d[2]) < z.radius;
  };
  // Server bodies are quads split into triangle f and f + T/2: keep quads whole
  // so the zone edge follows the grid instead of a saw-tooth of half-quads.
  const T = c.length / 3;
  const half = T / 2;
  const pair = (f: number) => (f < half ? f + half : f - half);
  const comps = acceptedComponents(viewer.adjacency, T, (f) => inZone(f) && inZone(pair(f)));
  if (!comps.length) return toast("Не вдалося знайти зону на цій моделі", true);
  // Up in the unwrap = towards the body along the limb (elbow above wrist on the stencil).
  const axis = Math.sqrt(len2);
  unwrapUp = [-d[0] / axis, -d[1] / axis, -d[2] / axis];
  viewer.setSelection(smoothSelection(viewer.adjacency, new Set(comps[0]), 2));
  unwrapSelection();
});

viewer.onSelectionChange = () => {
  $("#hint3d").style.display = viewer.selection.size ? "none" : "";
};

// ---------------------------------------------------------------------------
// 3D toolbar
$$<HTMLButtonElement>("[data-mode]").forEach((b) =>
  b.addEventListener("click", () => {
    viewer.mode = b.dataset.mode as BrushMode;
    $$("[data-mode]").forEach((x) => x.classList.toggle("active", x === b));
  }),
);
const brush3d = $<HTMLInputElement>("#brush3d");
const syncBrush3d = () => {
  viewer.brushRadius = Number(brush3d.value) / 1000;
  $("#brush3d-out").textContent = `${(viewer.brushRadius * 100).toFixed(1)} см`;
};
brush3d.addEventListener("input", syncBrush3d);
$("#clear-selection").addEventListener("click", () => {
  viewer.clearSelection();
  unwrapSelection();
});
$<HTMLInputElement>("#show-selection").addEventListener("change", (e) => {
  viewer.showSelection = (e.target as HTMLInputElement).checked;
  viewer.refreshColors();
});

// ---------------------------------------------------------------------------
// 2D toolbar
$$<HTMLButtonElement>("[data-tool]").forEach((b) =>
  b.addEventListener("click", () => {
    editor.tool = b.dataset.tool as Tool;
    $$("[data-tool]").forEach((x) => x.classList.toggle("active", x === b));
  }),
);
const brush2d = $<HTMLInputElement>("#brush2d");
brush2d.addEventListener("input", () => {
  editor.brushSize = Number(brush2d.value) / 10000;
  $("#brush2d-out").textContent = `${(editor.brushSize * 1000).toFixed(1)} мм`;
});
$<HTMLInputElement>("#ink-color").addEventListener("input", (e) => (editor.brushColor = (e.target as HTMLInputElement).value));
$("#fit").addEventListener("click", () => editor.fit());
$<HTMLInputElement>("#show-heat").addEventListener("change", (e) => {
  editor.showHeatmap = (e.target as HTMLInputElement).checked;
  editor.requestDraw();
});
$<HTMLInputElement>("#healed").addEventListener("change", (e) => {
  editor.healed = (e.target as HTMLInputElement).checked;
  editor.compose();
});
$$<HTMLButtonElement>("[data-skin]").forEach((b) => {
  b.style.background = b.dataset.skin!;
  b.classList.toggle("active", b.dataset.skin === "#e7c1a4");
  b.addEventListener("click", () => {
    viewer.skin.set(b.dataset.skin!);
    viewer.refreshColors();
    $$("[data-skin]").forEach((x) => x.classList.toggle("active", x === b));
  });
});
$<HTMLInputElement>("#show-wire").addEventListener("change", (e) => {
  editor.showWire = (e.target as HTMLInputElement).checked;
  editor.requestDraw();
});

// ---------------------------------------------------------------------------
// Undo / redo
const undoBtn = $<HTMLButtonElement>("#undo");
const redoBtn = $<HTMLButtonElement>("#redo");
undoBtn.addEventListener("click", () => editor.undo());
redoBtn.addEventListener("click", () => editor.redo());
window.addEventListener("keydown", (e) => {
  if ((e.target as HTMLElement).matches("input, textarea")) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
    e.preventDefault();
    if (e.shiftKey) editor.redo();
    else editor.undo();
  } else if ((e.key === "Delete" || e.key === "Backspace") && editor.active) {
    editor.removeLayer(editor.active.id);
  }
});

// ---------------------------------------------------------------------------
// Layers panel
function renderLayers() {
  undoBtn.disabled = !editor.canUndo;
  redoBtn.disabled = !editor.canRedo;
  const list = $("#layers");
  list.innerHTML = "";
  [...editor.layers].reverse().forEach((l) => {
    const li = document.createElement("li");
    li.classList.toggle("active", l.id === editor.activeId);
    li.innerHTML = `<button data-act="vis" title="Показати/сховати">${l.visible ? "◉" : "○"}</button>
      <span class="name">${l.kind === "ink" ? "✎ " : "▣ "}${escapeHtml(l.name)}</span>
      <button data-act="up" title="Вище">▲</button><button data-act="down" title="Нижче">▼</button>
      <button data-act="del" title="Видалити">✕</button>`;
    li.addEventListener("click", (e) => {
      const act = (e.target as HTMLElement).closest("button")?.dataset.act;
      if (act === "vis") editor.updateLayer(l, { visible: !l.visible });
      else if (act === "up") editor.moveLayer(l.id, 1);
      else if (act === "down") editor.moveLayer(l.id, -1);
      else if (act === "del") editor.removeLayer(l.id);
      else {
        editor.activeId = l.id;
        renderLayers();
        editor.requestDraw();
      }
    });
    list.appendChild(li);
  });
  renderLayerProps(editor.active);
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function renderLayerProps(l: Layer | null) {
  const box = $("#layer-props");
  box.innerHTML = "";
  if (!l) return;
  const slider = (label: string, min: number, max: number, step: number, value: number, fmt: (v: number) => string, apply: (v: number) => void) => {
    const row = document.createElement("label");
    row.innerHTML = `<span>${label}</span><input type="range" min="${min}" max="${max}" step="${step}" value="${value}"/><output>${fmt(value)}</output>`;
    const input = row.querySelector("input")!;
    input.addEventListener("pointerdown", () => editor.checkpoint());
    input.addEventListener("input", () => {
      apply(Number(input.value));
      row.querySelector("output")!.textContent = fmt(Number(input.value));
    });
    input.addEventListener("change", () => renderLayers());
    box.appendChild(row);
  };
  slider("Прозорість", 0, 1, 0.01, l.opacity, (v) => `${Math.round(v * 100)}%`, (v) => editor.updateLayer(l, { opacity: v }, false));
  if (l.kind === "image") {
    const img = l as ImageLayer;
    const actions = document.createElement("div");
    actions.className = "layer-actions";
    actions.innerHTML = `<button class="small" data-a="flip" title="Дзеркально">⇋ Дзеркало</button><button class="small" data-a="dup" title="Копія шару">⧉ Копія</button>`;
    actions.querySelector('[data-a="flip"]')!.addEventListener("click", () => editor.updateLayer(img, { flipX: !img.flipX }));
    actions.querySelector('[data-a="dup"]')!.addEventListener("click", () => editor.duplicateLayer(img.id));
    box.appendChild(actions);
    slider("Ширина", 0.5, 60, 0.1, img.width * 100, (v) => `${v.toFixed(1)} см`, (v) => editor.updateLayer(img, { width: v / 100 }, false));
    slider("Поворот", -180, 180, 1, (img.rotation * 180) / Math.PI, (v) => `${Math.round(v)}°`, (v) =>
      editor.updateLayer(img, { rotation: (v * Math.PI) / 180 }, false),
    );
    const st = document.createElement("label");
    st.className = "check";
    st.innerHTML = `<input type="checkbox" ${img.stencil ? "checked" : ""}/> трафарет (чорна лінія, без фону)`;
    st.querySelector("input")!.addEventListener("change", (e) => editor.setStencil(img, (e.target as HTMLInputElement).checked));
    box.appendChild(st);
    if (img.stencil)
      slider("Поріг лінії", 0, 0.6, 0.01, img.threshold, (v) => `${Math.round(v * 100)}%`, (v) => editor.setStencil(img, true, false, v));
  }
}
editor.onLayersChange = () => {
  renderLayers();
  markDirty();
};

$("#add-ink").addEventListener("click", () => {
  if (!editor.geometry) return toast("Спершу виділіть ділянку на тілі", true);
  editor.addInkLayer(`Туш ${editor.layers.filter((l) => l.kind === "ink").length + 1}`);
});

$<HTMLInputElement>("#image-file").addEventListener("change", async (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  (e.target as HTMLInputElement).value = "";
  if (!file) return;
  if (!editor.geometry) return toast("Спершу виділіть ділянку на тілі", true);
  const img = await loadImage(URL.createObjectURL(file));
  editor.addImageLayer(img, file.name.replace(/\.[^.]+$/, ""));
});

// ---------------------------------------------------------------------------
// Generation
const styleSelect = $<HTMLSelectElement>("#style");
const providerSelect = $<HTMLSelectElement>("#provider");
const MOTIFS = ["троянда", "півонія", "змія", "метелик", "ластівка", "місяць і зорі", "вовк", "лотос", "дракон", "компас", "хвиля", "гори"];
for (const m of MOTIFS) {
  const chip = document.createElement("button");
  chip.className = "chip";
  chip.textContent = m;
  chip.addEventListener("click", () => {
    const ta = $<HTMLTextAreaElement>("#prompt");
    ta.value = ta.value.trim() ? `${ta.value.trim()}, ${m}` : m;
  });
  $("#prompt-chips").appendChild(chip);
}

async function loadGenerators() {
  const [styles, providers] = await Promise.all([api.styles(), api.providers()]);
  styleSelect.innerHTML = "";
  for (const s of styles) styleSelect.add(new Option(`${s.label}${s.mode === "color" ? " · колір" : ""}`, s.id));
  providerSelect.innerHTML = "";
  providerSelect.add(new Option("Генератор: авто", ""));
  for (const p of providers) providerSelect.add(new Option(`${p.label}${p.free ? "" : " 💳"}`, p.id));
  const offline = providers.length === 1 && providers[0].id === "mock";
  $("#gen-status").textContent = offline
    ? "Генератори не налаштовані — працює офлайн-заглушка. Див. README: безкоштовний Cloudflare FLUX."
    : "";
}

function addToGallery(img: HTMLImageElement, title: string) {
  const thumb = document.createElement("button");
  thumb.title = `${title} — натисніть, щоб накласти`;
  thumb.appendChild(img.cloneNode());
  thumb.addEventListener("click", () => {
    if (!editor.geometry) return toast("Спершу виділіть ділянку на тілі", true);
    editor.addImageLayer(img, title.slice(0, 40));
  });
  $("#gallery").prepend(thumb);
}

$("#generate").addEventListener("click", async () => {
  const prompt = $<HTMLTextAreaElement>("#prompt").value.trim();
  if (prompt.length < 2) return toast("Опишіть, що згенерувати", true);
  const btn = $<HTMLButtonElement>("#generate");
  btn.disabled = true;
  const status = $("#gen-status");
  status.textContent = "Ставлю в чергу…";
  const added = new Set<string>();
  let first = true;
  const take = async (images: { image_id: string; url: string }[]) => {
    for (const im of images) {
      if (added.has(im.image_id)) continue;
      added.add(im.image_id);
      const img = await loadImage(api.url(im.url));
      addToGallery(img, prompt);
      // The first variant goes straight onto the body; the rest wait in the gallery.
      if (first && editor.geometry) editor.addImageLayer(img, prompt.slice(0, 40));
      first = false;
    }
  };
  try {
    const { width, height } = editor.size;
    const job = await api.generate(
      {
        prompt,
        style: styleSelect.value,
        variants: Number($<HTMLSelectElement>("#variants").value),
        region_aspect: editor.geometry ? width / height : undefined,
        provider: providerSelect.value || undefined,
      },
      (j) => {
        status.textContent = j.message;
        take(j.images);
      },
    );
    await take(job.images);
    if (job.status === "error") throw new Error(job.errors.at(-1) ?? job.message);
    const providers = [...new Set(job.images.map((i) => i.provider))].join(", ");
    status.textContent = `Готово: ${job.images.length} вар. (${providers}). Інші варіанти — у галереї нижче.`;
    if (!editor.geometry) toast("Ескізи в галереї. Виділіть ділянку, щоб накласти");
  } catch (err) {
    status.textContent = "";
    toast(`Генерація не вдалася: ${(err as Error).message}`, true);
  } finally {
    btn.disabled = false;
  }
});

// ---------------------------------------------------------------------------
// Export
$("#export-stencil").addEventListener("click", async () => {
  if (!editor.geometry) return toast("Немає ділянки для експорту", true);
  const dpi = Number($<HTMLSelectElement>("#dpi").value);
  const canvas = editor.renderStencil(dpi, $<HTMLInputElement>("#outline").checked);
  const blob = await new Promise<Blob>((r) => canvas.toBlob((b) => r(b!), "image/png"));
  const withDpi = setPngDpi(new Uint8Array(await blob.arrayBuffer()), dpi);
  const { width, height } = editor.size;
  download(new Blob([withDpi as BlobPart], { type: "image/png" }), `tutu-stencil-${Math.round(width * 1000)}x${Math.round(height * 1000)}mm.png`);
  toast(`Трафарет ${(width * 100).toFixed(1)} × ${(height * 100).toFixed(1)} см, ${dpi} DPI`);
});
$("#export-shot").addEventListener("click", async () => {
  const blob = await (await fetch(viewer.screenshot())).blob();
  download(blob, "tutu-3d.png");
});

// ---------------------------------------------------------------------------
// Model panel
let currentSex: Sex = "male";
const sliders = {
  height_cm: { input: $<HTMLInputElement>("#body-height"), out: $("#body-height-out"), toValue: (v: number) => v, fromValue: (v: number) => v, fmt: (v: number) => `${v} см` },
  weight: { input: $<HTMLInputElement>("#body-weight"), out: $("#body-weight-out"), toValue: (v: number) => v / 100, fromValue: (v: number) => v * 100, fmt: (v: number) => weightLabel(v) },
  muscle: { input: $<HTMLInputElement>("#body-muscle"), out: $("#body-muscle-out"), toValue: (v: number) => v / 100, fromValue: (v: number) => v * 100, fmt: (v: number) => muscleLabel(v) },
  breast: { input: $<HTMLInputElement>("#body-breast"), out: $("#body-breast-out"), toValue: (v: number) => v / 100, fromValue: (v: number) => v * 100, fmt: (v: number) => breastLabel(v) },
} as const;

function weightLabel(v: number) {
  return v < 20 ? "дуже худа" : v < 40 ? "худа" : v < 60 ? "середня" : v < 80 ? "вище сер." : "велика";
}
function muscleLabel(v: number) {
  return v < 30 ? "слабкі" : v < 60 ? "середні" : v < 80 ? "тренов." : "атлет";
}
function breastLabel(v: number) {
  return v < 30 ? "мала" : v < 60 ? "середня" : v < 80 ? "велика" : "дуже велика";
}

function silhouette(p: BodyPresetParams): string {
  const f = p.sex < 0.5;
  const sh = 15 * (f ? 0.88 : 1) * (0.92 + p.muscle * 0.16);
  const w = 11 * (f ? 0.82 : 1) * (0.82 + p.weight * 0.45);
  const hp = 13 * (f ? 1.1 : 0.95) * (0.88 + p.weight * 0.3);
  const a = 3 * (0.85 + p.weight * 0.3 + p.muscle * 0.15);
  const l = 5 * (0.85 + p.weight * 0.35);
  return `<svg viewBox="0 0 60 100" aria-hidden="true"><path d="
    M${30 - sh} 22 Q30 17 ${30 + sh} 22 L${30 + w} 44 Q${30 + hp + 1} 52 ${30 + hp} 56
    L${30 + 3 + l} 96 L${30 + 1} 96 L30 60 L${30 - 1} 96 L${30 - 3 - l} 96 L${30 - hp} 56
    Q${30 - hp - 1} 52 ${30 - w} 44 Z"/>
    <path d="M${30 - sh} 22 L${30 - sh - 9} 54 L${30 - sh - 9 + a} 55 L${30 - sh + a} 30 Z"/>
    <path d="M${30 + sh} 22 L${30 + sh + 9} 54 L${30 + sh + 9 - a} 55 L${30 + sh - a} 30 Z"/>
    <path d="M30 2 a6.5 8 0 1 0 0.01 0 Z M27 16 h6 v6 h-6 Z"/></svg>`;
}

function syncBodyUI() {
  const params = model.type === "body" ? bodyParams(model) : null;
  if (params) {
    currentSex = params.sex >= 0.5 ? "male" : "female";
    for (const [key, s] of Object.entries(sliders)) {
      const v = (params as unknown as Record<string, number | undefined>)[key] ?? 0.5;
      s.input.value = String(Math.round(s.fromValue(v)));
      s.out.textContent = s.fmt(Number(s.input.value));
    }
  }
  $("#breast-row").hidden = currentSex === "male";
  $$<HTMLButtonElement>("[data-sex]").forEach((b) => b.classList.toggle("active", b.dataset.sex === currentSex));
  const box = $("#body-presets");
  box.innerHTML = "";
  for (const preset of presets.filter((p) => (p.params.sex >= 0.5 ? "male" : "female") === currentSex)) {
    const b = document.createElement("button");
    b.title = preset.description;
    b.innerHTML = `${silhouette(preset.params)}<span>${preset.label}</span>`;
    b.classList.toggle("active", model.type === "body" && model.preset === preset.id);
    b.addEventListener("click", () => loadBody(preset.id).catch((e) => toast(e.message, true)));
    box.appendChild(b);
  }
  $<HTMLSelectElement>("#focus").disabled = model.type !== "body";
}

$$<HTMLButtonElement>("[data-sex]").forEach((b) =>
  b.addEventListener("click", () => {
    currentSex = b.dataset.sex as Sex;
    const preset = presets.find((p) => (p.params.sex >= 0.5 ? "male" : "female") === currentSex && p.id.endsWith("average"));
    if (preset) loadBody(preset.id).catch((e) => toast(e.message, true));
  }),
);
for (const [key, s] of Object.entries(sliders)) {
  s.input.addEventListener("input", () => (s.out.textContent = s.fmt(Number(s.input.value))));
  s.input.addEventListener("change", () => {
    if (model.type !== "body") return;
    const overrides = { ...model.overrides, [key]: s.toValue(Number(s.input.value)) };
    loadBody(model.preset, overrides).catch((e) => toast(e.message, true));
  });
}

// Camera shortcuts to body parts, placed by the model's joint landmarks.
type Focus = { joints: string[]; dir: [number, number, number]; dist: number; dy?: number };
const FOCUS: Record<string, Focus> = {
  "l-forearm": { joints: ["l-elbow", "l-hand"], dir: [0.4, 0.15, 1], dist: 0.65 },
  "r-forearm": { joints: ["r-elbow", "r-hand"], dir: [-0.4, 0.15, 1], dist: 0.65 },
  "l-shoulder": { joints: ["l-shoulder", "l-elbow"], dir: [0.7, 0.1, 1], dist: 0.6 },
  "r-shoulder": { joints: ["r-shoulder", "r-elbow"], dir: [-0.7, 0.1, 1], dist: 0.6 },
  chest: { joints: ["l-clavicle", "r-clavicle"], dir: [0.15, 0.05, 1], dist: 0.75, dy: -0.1 },
  belly: { joints: ["spine-1", "pelvis"], dir: [0.15, 0.05, 1], dist: 0.75 },
  back: { joints: ["spine-2", "spine-3"], dir: [0.15, 0.1, -1], dist: 0.95 },
  neck: { joints: ["neck"], dir: [0.2, 0.05, 1], dist: 0.5 },
  "l-thigh": { joints: ["l-upper-leg", "l-knee"], dir: [0.5, 0.05, 1], dist: 0.8 },
  "l-calf": { joints: ["l-knee", "l-ankle"], dir: [0.5, 0.1, -1], dist: 0.75 },
};
$<HTMLSelectElement>("#focus").addEventListener("change", (e) => {
  const sel = e.target as HTMLSelectElement;
  const f = FOCUS[sel.value];
  if (!f || !landmarks) {
    viewer.frameAll();
    return;
  }
  const t = new THREE.Vector3();
  for (const j of f.joints) t.add(new THREE.Vector3(...landmarks[j]));
  t.divideScalar(f.joints.length);
  t.y += f.dy ?? 0;
  viewer.focus(t, new THREE.Vector3(...f.dir), f.dist);
});

$<HTMLInputElement>("#mesh-file").addEventListener("change", async (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  (e.target as HTMLInputElement).value = "";
  if (!file) return;
  if (!MESH_EXTENSIONS.includes(extensionOf(file.name))) return toast("Підтримуються OBJ, GLB, GLTF, PLY, STL", true);
  try {
    const data = await file.arrayBuffer();
    await loadMeshData(data, file.name, { type: "file", name: file.name });
    rawFile = { data, name: file.name };
    syncBodyUI();
    $<HTMLSelectElement>("#focus").value = "all";
  } catch (err) {
    toast((err as Error).message, true);
  }
});

// ---------------------------------------------------------------------------
// Projects
// Unsaved-changes guard and Ctrl+S.
let dirty = false;
let booted = false;
function markDirty() {
  if (booted) dirty = true;
}
window.addEventListener("beforeunload", (e) => {
  if (dirty) e.preventDefault();
});
window.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
    e.preventDefault();
    $<HTMLButtonElement>("#save").click();
  }
});

$("#save").addEventListener("click", async () => {
  const btn = $<HTMLButtonElement>("#save");
  btn.disabled = true;
  try {
    if (model.type === "file" && rawFile) {
      const scan = await api.uploadScan(new Blob([rawFile.data]), rawFile.name, rawFile.name);
      model = { type: "scan", id: scan.id };
    }
    const state: ProjectState = {
      model: model.type === "file" ? { type: "body", preset: "m-average", overrides: {} } : model,
      selection: rle([...viewer.selection].sort((a, b) => a - b)),
      up: unwrapUp,
      layers: editor.serialize(),
    };
    const name = $<HTMLInputElement>("#project-name").value || "Без назви";
    const saved = await api.saveProject(projectId, { name, scan_id: model.type === "scan" ? model.id : null, state });
    projectId = saved.id;
    history.replaceState(null, "", `?project=${saved.id}`);
    dirty = false;
    toast("Проєкт збережено");
  } catch (err) {
    toast(`Не вдалося зберегти: ${(err as Error).message}`, true);
  } finally {
    btn.disabled = false;
  }
});

async function openProject(id: string) {
  const p = await api.loadProject<ProjectState>(id);
  $<HTMLInputElement>("#project-name").value = p.name;
  const m = p.state.model;
  if (m.type === "scan") await loadScan(m.id);
  else if (m.type === "body") await loadBody(m.preset, m.overrides ?? {});
  unwrapUp = p.state.up ?? [0, 1, 0];
  viewer.setSelection(unrle(p.state.selection));
  await unwrapSelection();
  await editor.deserialize(p.state.layers);
}

// ---------------------------------------------------------------------------
// Mobile tabs
$$<HTMLButtonElement>(".tabs button").forEach((b) =>
  b.addEventListener("click", () => {
    $(".workspace").dataset.tab = b.dataset.tab;
    $$(".tabs button").forEach((x) => x.classList.toggle("active", x === b));
  }),
);

// ---------------------------------------------------------------------------
// Bridge for the iOS app: window.tutu.loadMeshBase64(b64, "scan.obj")
(window as unknown as { tutu: unknown }).tutu = {
  loadBody,
  async loadMeshBase64(b64: string, filename: string) {
    const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    rawFile = { data: bin.buffer, name: filename };
    await loadMeshData(bin.buffer, filename, { type: "file", name: filename });
  },
  loadScan,
};

// ---------------------------------------------------------------------------
// Boot
async function boot() {
  renderLayers();
  const params = new URLSearchParams(location.search);
  try {
    presets = await bodyApi.presets();
  } catch {
    toast("Сервер недоступний: базові тіла не завантажено. Можна відкрити свій 3D-файл.", true);
  }
  syncBodyUI();
  try {
    if (projectId) await openProject(projectId);
    else if (params.get("scan")) await loadScan(params.get("scan")!);
    else await loadBody(params.get("body") ?? "m-average");
  } catch (err) {
    toast((err as Error).message, true);
    if (presets.length) await loadBody("m-average");
  }
  booted = true;
  dirty = false;
  loadGenerators().catch(() => ($("#gen-status").textContent = "Сервер недоступний — генерація вимкнена"));
}
boot();
