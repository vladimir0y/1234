import * as THREE from "three";
import { api, type BodyMeshData, type BodyPreset, type BodyPresetParams } from "./api";
import { createBackend, STANDALONE, type Backend } from "./backend";
import { isRest, POSE_PRESETS, Poser, REST_POSE, type PoseParams } from "./core/pose";
import { groupedUnwrap, PART_LABELS, partOfBone, type GroupSpec, type GroupedUnwrap, type V3 } from "./core/groupUnwrap";
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
  canvas?: "unwrap" | "parts" | "front-back" | "wrap";
  pose?: Partial<PoseParams>;
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

let backend: Backend;

async function download(blob: Blob, filename: string) {
  try {
    await backend.download(blob, filename);
  } catch (e) {
    const err = e as { code?: string; message?: string };
    if (err.code !== "declined") toast(`Файл не збережено: ${err.message ?? err.code}`, true);
  }
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
async function loadGeometry(geometry: THREE.BufferGeometry, label: string, opts: { keepCamera?: boolean; weld?: boolean } = {}) {
  const prepared = prepareBody(geometry, { weld: opts.weld });
  poser = null;
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
  return prepared;
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
      mesh = await backend.bodyMesh(preset.id, overrides);
      bodyCache.set(key, mesh);
    }
    if (request !== bodyRequest) return; // superseded by a newer choice
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(mesh.positions.slice(), 3));
    g.setIndex(new THREE.BufferAttribute(mesh.indices.slice(), 1));
    const params = bodyParams(model)!;
    const kg = meshVolume(mesh.positions, mesh.indices);
    const sex = params.sex >= 0.5 ? "Чоловіче" : "Жіноче";
    const prepared = await loadGeometry(g, `${sex} · ${preset.label}`, { keepCamera: keepSelection.length > 0, weld: false });
    landmarks = mesh.landmarks;
    if (mesh.skin) {
      // Bone pivots in editor coordinates (same transform prepareBody applied).
      const bones = mesh.skin.bones.map((b) => ({
        ...b,
        head: b.head.map((x, i) => x * prepared.scale + prepared.offset.getComponent(i)) as [number, number, number],
      }));
      poser = new Poser({ ...mesh.skin, bones });
      boneHeads = Object.fromEntries(bones.map((b) => [b.name, b.head]));
      // Body part of every vertex = part of its strongest bone.
      const parts = Object.keys(PART_LABELS);
      vertexPart = Uint8Array.from({ length: mesh.skin.index.length / 4 }, (_, v) =>
        parts.indexOf(partOfBone(bones[mesh.skin!.index[4 * v]].name)),
      );
    }
    $("#pose-panel").hidden = !poser;
    applyPose();
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
  const mesh = await backend.loadSavedMesh(id);
  rawFile = null;
  await loadMeshData(mesh.data, mesh.name, { type: "scan", id });
  syncBodyUI();
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

let unwrapRun = 0;
let lastGroups: GroupedUnwrap["groups"] = [];
const groupBoxes = () => lastGroups;
async function unwrapSelection() {
  const mesh = viewer.mesh;
  if (!mesh || !adjacency) return;
  const run = ++unwrapRun; // a newer call (or canvas switch) makes this one stale
  pending?.reject(new Error("cancelled"));
  pending = null;
  if (viewer.selection.size < 2) {
    editor.setGeometry(null);
    viewer.clearPatch();
    patchVertices = [];
    setInfo("Розгортка ділянки — тут малюєте і розміщуєте ескіз");
    return;
  }
  const comps = connectedComponents(adjacency, viewer.selection).filter((c) => c.length >= 2);
  const grouped = canvasMode !== "unwrap";
  // Grouped canvases take everything selected as one patch, then split it by body part or by side.
  const patches = grouped ? [extractPatch(mesh, comps.flat())] : comps.map((faces) => extractPatch(mesh, faces));
  setInfo("Розгортаю…");
  let result: CombinedUnwrap;
  let labels: Array<{ text: string; u: number; v: number }> | undefined;
  try {
    if (grouped) {
      const g = groupedForSelection(patches[0].faces, mesh);
      const r = groupedUnwrap(patches[0].positions, patches[0].triangles, g.faceGroup, g.specs);
      labels = r.groups.map((x) => ({ text: x.label, u: x.minU, v: x.maxV }));
      result = r;
    } else {
      result = await runUnwrap(patches.map((p) => ({ positions: p.positions, triangles: p.triangles })));
    }
  } catch (err) {
    if ((err as Error).message !== "cancelled") setInfo((err as Error).message, true);
    return;
  }
  if (run !== unwrapRun) return;
  const flat = patches.flatMap((p) => p.vertices);
  patchVertices = Array.from(result.source, (i) => flat[i]); // cut seams duplicate vertices
  editor.setGeometry({ uv: result.uv, triangles: result.triangles, areaRatio: result.areaRatio, labels });
  lastGroups = "groups" in result ? (result as { groups: ReturnType<typeof groupBoxes> }).groups : [];

  texture?.dispose();
  texture = new THREE.CanvasTexture(editor.texture);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = viewer.renderer.capabilities.getMaxAnisotropy();
  viewer.setPatch(patchVertices, result.triangles, editor.textureUVs(), texture);

  const { width, height } = editor.size;
  const quality = result.meanDistortion < 0.05 ? "відмінна" : result.meanDistortion < 0.15 ? "добра" : "помітні спотворення";
  if (grouped) {
    setInfo(
      canvasMode === "parts"
        ? `По частинах тіла: ${labels!.map((l) => l.text.toLowerCase()).join(", ")} · кожна частина розгорнута навколо своєї осі`
        : `Спереду / ззаду: як на фото тіла спереду і зі спини · ${(width * 100).toFixed(0)} × ${(height * 100).toFixed(0)} см`,
    );
    markDirty();
    return;
  }
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
    actions.innerHTML = `<button class="small" data-a="fit" title="Розтягнути на всю ділянку">⤧ Вписати в межі</button><button class="small" data-a="flip" title="Дзеркально">⇋ Дзеркало</button><button class="small" data-a="dup" title="Копія шару">⧉ Копія</button>`;
    actions.querySelector('[data-a="fit"]')!.addEventListener("click", () => editor.fitLayerToRegion(img));
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
  const [styles, providers] = await Promise.all([backend.styles(), backend.providers()]);
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
    const layer = editor.addImageLayer(img, title.slice(0, 40));
    if ($<HTMLInputElement>("#fit-region").checked) editor.fitLayerToRegion(layer, false);
  });
  $("#gallery").prepend(thumb);
}

// --- Canvas mode, region shape and style references for generators
let canvasMode: "unwrap" | "parts" | "front-back" | "wrap" = "unwrap";
let vertexPart: Uint8Array | null = null;
let boneHeads: Record<string, V3> = {};

/** Split the selected faces into canvas groups for the current canvas mode. */
function groupedForSelection(faces: number[], mesh: { positions: ArrayLike<number>; indices: ArrayLike<number> }) {
  const faceGroup = new Int32Array(faces.length);
  const specs: GroupSpec[] = [];
  if (canvasMode === "front-back") {
    const N = viewer.normals!;
    faces.forEach((f, i) => {
      let z = 0;
      for (let k = 0; k < 3; k++) z += N[3 * mesh.indices[3 * f + k] + 2];
      faceGroup[i] = z >= 0 ? 0 : 1;
    });
    specs.push({ label: "Спереду", mapping: { kind: "project", side: "front" } }, { label: "Ззаду", mapping: { kind: "project", side: "back" } });
    return { faceGroup, specs };
  }
  if (canvasMode === "wrap") {
    // One canvas around the body's vertical axis, cut along the left side: chest, right side
    // and back form one continuous surface for a single composition.
    const c = boneHeads["spine_02"] ?? [0, 0, 0];
    specs.push({ label: "Навколо тіла", mapping: { kind: "cylinder", front: [0, 0, 1], seam: Math.PI / 2, path: [[c[0], c[1] - 1, c[2]], [c[0], c[1] + 1, c[2]]] } });
    return { faceGroup, specs };
  }
  // By body part. Without a skeleton (own 3D file) everything is one part around the body axis.
  const parts = Object.keys(PART_LABELS);
  const used = new Map<string, number>();
  faces.forEach((f, i) => {
    let part = "torso";
    if (vertexPart) {
      const votes = new Map<number, number>();
      for (let k = 0; k < 3; k++) {
        const p = vertexPart[mesh.indices[3 * f + k]];
        votes.set(p, (votes.get(p) ?? 0) + 1);
      }
      part = parts[[...votes].sort((a, b) => b[1] - a[1])[0][0]];
    }
    if (!used.has(part)) used.set(part, used.size);
    faceGroup[i] = used.get(part)!;
  });
  const H = boneHeads;
  const FRONT: V3 = [0, 0, 1];
  // Axis through the joints, from the far end towards the body (so "up" on the canvas points to the body).
  const pathOf = (part: string): V3[] => {
    const s = part[0];
    if (part.endsWith("-arm") && H[`hand_${s}`]) return [H[`hand_${s}`], H[`lowerarm_${s}`], H[`upperarm_${s}`]];
    if (part.endsWith("-leg") && H[`foot_${s}`]) return [H[`foot_${s}`], H[`calf_${s}`], H[`thigh_${s}`]];
    const c = part === "head" && H.head ? H.head : H["spine_02"] ?? [0, 0, 0];
    return [[c[0], c[1] - 1, c[2]], [c[0], c[1] + 1, c[2]]];
  };
  for (const [part] of used) specs.push({ label: PART_LABELS[part], mapping: { kind: "cylinder", front: FRONT, path: pathOf(part) } });
  return { faceGroup, specs };
}

$<HTMLSelectElement>("#canvas-mode").addEventListener("change", (e) => {
  canvasMode = (e.target as HTMLSelectElement).value as typeof canvasMode;
  unwrapSelection();
  markDirty();
});

function shapeForGenerator(fit: boolean) {
  if (!fit || !editor.geometry) return {};
  const { width, height } = editor.regionCanvas(1024);
  return { width, height, outline: editor.regionOutline(1024) };
}

const references: Array<{ blob: Blob; url: string }> = [];
async function shrinkImage(file: File, max = 1024): Promise<Blob> {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * k);
  c.height = Math.round(bmp.height * k);
  c.getContext("2d")!.drawImage(bmp, 0, 0, c.width, c.height);
  return new Promise((res) => c.toBlob((b) => res(b!), "image/jpeg", 0.85));
}
function renderRefs() {
  const box = $("#refs");
  box.innerHTML = "";
  references.forEach((r, i) => {
    const b = document.createElement("button");
    b.title = "Прибрати референс";
    b.innerHTML = `<img src="${r.url}" alt="Референс ${i + 1}">`;
    b.addEventListener("click", () => {
      URL.revokeObjectURL(r.url);
      references.splice(i, 1);
      renderRefs();
    });
    box.appendChild(b);
  });
}
$<HTMLInputElement>("#ref-file").addEventListener("change", async (e) => {
  const input = e.target as HTMLInputElement;
  for (const f of Array.from(input.files ?? []).slice(0, 4 - references.length)) {
    const blob = await shrinkImage(f);
    references.push({ blob, url: URL.createObjectURL(blob) });
  }
  input.value = "";
  renderRefs();
});

$("#ext-prompt").addEventListener("click", async () => {
  const prompt = $<HTMLTextAreaElement>("#prompt").value.trim();
  if (prompt.length < 2) return toast("Опишіть ідею", true);
  const btn = $<HTMLButtonElement>("#ext-prompt");
  btn.disabled = true;
  btn.textContent = "Claude пише промпт…";
  try {
    const text = await backend.externalPrompt!({
      prompt, style: styleSelect.value, variants: 1, ...shapeForGenerator(true), references: references.map((r) => r.blob),
    });
    const out = $<HTMLTextAreaElement>("#ext-prompt-out");
    out.value = text;
    out.hidden = false;
    $("#ext-actions").hidden = false;
  } catch (err) {
    toast((err as Error).message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = "Промпт для FLUX / Midjourney";
  }
});
$("#ext-copy").addEventListener("click", () => {
  const out = $<HTMLTextAreaElement>("#ext-prompt-out");
  navigator.clipboard.writeText(out.value).then(
    () => toast("Промпт скопійовано"),
    () => {
      out.select();
      toast("Виділено — скопіюйте вручну");
    },
  );
});

$("#generate").addEventListener("click", async () => {
  const prompt = $<HTMLTextAreaElement>("#prompt").value.trim();
  if (prompt.length < 2) return toast("Опишіть, що згенерувати", true);
  const btn = $<HTMLButtonElement>("#generate");
  btn.disabled = true;
  const status = $("#gen-status");
  status.textContent = "Ставлю в чергу…";
  const added = new Set<string>();
  const fit = $<HTMLInputElement>("#fit-region").checked && !!editor.geometry;
  let first = true;
  const take = async (images: { image_id: string; url: string }[]) => {
    for (const im of images) {
      if (added.has(im.image_id)) continue;
      added.add(im.image_id);
      const img = await loadImage(api.url(im.url));
      addToGallery(img, prompt);
      // The first variant goes straight onto the body; the rest wait in the gallery.
      if (first && editor.geometry) {
        const layer = editor.addImageLayer(img, prompt.slice(0, 40));
        if (fit) editor.fitLayerToRegion(layer, false);
      }
      first = false;
    }
  };
  try {
    const { width, height } = editor.size;
    const job = await backend.generate(
      {
        prompt,
        style: styleSelect.value,
        variants: Number($<HTMLSelectElement>("#variants").value),
        region_aspect: editor.geometry ? width / height : undefined,
        provider: providerSelect.value || undefined,
        ...shapeForGenerator(fit),
        references: references.map((r) => r.blob),
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
    const name = $<HTMLInputElement>("#project-name").value || "Без назви";
    if (model.type === "file" && rawFile) {
      // Keep the user's own 3D file with the project.
      const first = await backend.saveProject(projectId, { name, state: {}, mesh: rawFile });
      projectId = first.id;
      model = { type: "scan", id: first.meshRef! };
    }
    const state: ProjectState = {
      model: model.type === "file" ? { type: "body", preset: "m-average", overrides: {} } : model,
      selection: rle([...viewer.selection].sort((a, b) => a - b)),
      up: unwrapUp,
      canvas: canvasMode,
      pose,
      layers: editor.serialize(),
    };
    const saved = await backend.saveProject(projectId, { name, state });
    projectId = saved.id;
    if (!STANDALONE) history.replaceState(null, "", `?project=${saved.id}`);
    refreshProjectList();
    dirty = false;
    toast("Проєкт збережено");
  } catch (err) {
    toast(`Не вдалося зберегти: ${(err as Error).message}`, true);
  } finally {
    btn.disabled = false;
  }
});

async function openProject(id: string) {
  const p = await backend.loadProject<ProjectState>(id);
  projectId = p.id;
  await openState(p.state, p.name);
}

async function openState(state: ProjectState, name: string) {
  $<HTMLInputElement>("#project-name").value = name;
  const m = state.model;
  if (m.type === "scan") await loadScan(m.id);
  else if (m.type === "body") await loadBody(m.preset, m.overrides ?? {});
  unwrapUp = state.up ?? [0, 1, 0];
  canvasMode = state.canvas ?? "unwrap";
  $<HTMLSelectElement>("#canvas-mode").value = canvasMode;
  pose = { ...REST_POSE, ...(state.pose ?? {}) };
  syncPoseUI();
  applyPose();
  viewer.setSelection(unrle(state.selection));
  await unwrapSelection();
  await editor.deserialize(state.layers);
}

/** Ready-made example projects shipped next to the page (browser build). */
const EXAMPLES = [
  { id: "chest-back", name: "Дракон на грудях + обличчя на спині (живопис, світло)" },
  { id: "dragon-color", name: "Дракон у кольорі + портрет (генерація однією композицією)" },
  { id: "dragon", name: "Дракон ч/б + портрет (зібраний з частин)" },
  { id: "sketch", name: "Ескіз з референсів: змія + портрет" },
];
async function openExample(id: string) {
  const r = await fetch(new URL(`./examples/${id}.json`, document.baseURI).href);
  if (!r.ok) throw new Error("Приклад не знайдено");
  const ex = await r.json();
  projectId = null;
  await openState(ex.state, ex.name);
  viewer.frameAll();
}

async function refreshProjectList() {
  const sel = $<HTMLSelectElement>("#projects");
  const items = await backend.listProjects().catch(() => []);
  sel.innerHTML = "";
  sel.add(new Option(items.length ? `Мої проєкти (${items.length})` : "Немає збережених", ""));
  for (const p of items) sel.add(new Option(`${p.name} · ${new Date(p.updated).toLocaleDateString("uk")}`, p.id));
  for (const e of EXAMPLES) sel.add(new Option(e.name, `example:${e.id}`));
  sel.disabled = sel.options.length < 2;
}
$<HTMLSelectElement>("#projects").addEventListener("change", async (e) => {
  const sel = e.target as HTMLSelectElement;
  const id = sel.value;
  sel.value = "";
  if (!id) return;
  try {
    if (id.startsWith("example:")) await openExample(id.slice(8));
    else await openProject(id);
    dirty = false;
    toast("Проєкт відкрито");
  } catch (err) {
    toast((err as Error).message, true);
  }
});
$("#new-project").addEventListener("click", async () => {
  projectId = null;
  $<HTMLInputElement>("#project-name").value = "Новий проєкт";
  editor.clearAll();
  viewer.clearSelection();
  await unwrapSelection();
  if (!STANDALONE) history.replaceState(null, "", location.pathname);
  dirty = false;
});

// ---------------------------------------------------------------------------
// Pose
let poser: Poser | null = null;
let pose: PoseParams = { ...REST_POSE };
let poseFrame = 0;
function applyPose() {
  cancelAnimationFrame(poseFrame);
  poseFrame = requestAnimationFrame(() => {
    if (!viewer.mesh) return;
    let posed: Float32Array | null = null;
    if (poser && !isRest(pose)) {
      posed = poser.apply(viewer.mesh.positions, pose);
      // Keep the lowest point on the floor (sitting, bending).
      let minY = Infinity;
      for (let i = 1; i < posed.length; i += 3) minY = Math.min(minY, posed[i]);
      for (let i = 1; i < posed.length; i += 3) posed[i] -= minY;
    }
    viewer.setPosed(posed);
  });
}
function syncPoseUI() {
  $$<HTMLInputElement>("[data-pose]").forEach((inp) => {
    const k = inp.dataset.pose as keyof PoseParams;
    inp.value = String(pose[k] as number);
    inp.nextElementSibling!.textContent = `${pose[k]}°`;
  });
}
const poseSelect = $<HTMLSelectElement>("#pose-preset");
for (const [id, p] of Object.entries(POSE_PRESETS)) poseSelect.add(new Option(p.label, id));
poseSelect.addEventListener("change", () => {
  pose = { ...REST_POSE, ...POSE_PRESETS[poseSelect.value].pose };
  syncPoseUI();
  applyPose();
});
$("#pose-reset").addEventListener("click", () => {
  pose = { ...REST_POSE };
  poseSelect.value = "rest";
  syncPoseUI();
  applyPose();
});
$$<HTMLInputElement>("[data-pose]").forEach((inp) =>
  inp.addEventListener("input", () => {
    (pose as unknown as Record<string, number>)[inp.dataset.pose!] = Number(inp.value);
    inp.nextElementSibling!.textContent = `${inp.value}°`;
    applyPose();
  }),
);

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
  // Scripting hooks (iOS app, building example projects).
  async selectRegion(opts: { parts: string[]; yMin?: number; yMax?: number }) {
    if (!vertexPart || !viewer.mesh) throw new Error("Немає скелета");
    const names = Object.keys(PART_LABELS);
    const want = new Set(opts.parts.map((p) => names.indexOf(p)));
    const { positions, indices } = viewer.mesh;
    const faces: number[] = [];
    for (let f = 0; f < indices.length / 3; f++) {
      let y = 0, ok = 0;
      for (let k = 0; k < 3; k++) {
        const v = indices[3 * f + k];
        y += positions[3 * v + 1] / 3;
        if (want.has(vertexPart[v])) ok++;
      }
      if (ok >= 2 && y >= (opts.yMin ?? -1) && y <= (opts.yMax ?? 9)) faces.push(f);
    }
    viewer.setSelection(faces);
    await unwrapSelection();
    return faces.length;
  },
  async setCanvas(mode: typeof canvasMode) {
    canvasMode = mode;
    $<HTMLSelectElement>("#canvas-mode").value = mode;
    await unwrapSelection();
  },
  /** Add an image layer into one labelled canvas part, covering `fill` of its width. */
  /**
   * Adds an image to one canvas group. `along: [boneA, boneB]` (front/back canvases)
   * centres it between two joints and turns its vertical axis along that segment.
   */
  async addLayerToGroup(
    url: string, name: string, group: string,
    opts: { fill?: number; dx?: number; dy?: number; widthM?: number; flip?: boolean; along?: [string, string]; t?: number; rotation?: number } = {},
  ) {
    const img = await loadImage(url);
    const layer = editor.addImageLayer(img, name);
    const g = editor.geometry?.labels?.find((l) => l.text === group);
    const box = groupBoxes().find((b) => b.label === group);
    if (!g || !box) return;
    const w = opts.widthM ?? (box.maxU - box.minU) * (opts.fill ?? 0.9);
    let x = (box.minU + box.maxU) / 2, y = (box.minV + box.maxV) / 2, rotation = opts.rotation ?? 0;
    const [a, b] = (opts.along ?? []).map((n) => boneHeads[n]);
    if (a && b && box.map) {
      const ua = box.map.sx * a[0] + box.map.du, ub = box.map.sx * b[0] + box.map.du;
      const t = opts.t ?? 0.5;
      x = ua + (ub - ua) * t;
      y = a[1] + (b[1] - a[1]) * t;
      // Image "up" points from b back to a.
      rotation += Math.atan2(a[1] - b[1], ua - ub) - Math.PI / 2;
    }
    editor.updateLayer(layer, { x: x + (opts.dx ?? 0), y: y + (opts.dy ?? 0), width: w, flipX: !!opts.flip, rotation });
  },
  /** Canvas outline and joints in regionCanvas(long) coordinates (y down), for drawing compositions. */
  canvasInfo(long = 1000) {
    const size = editor.regionCanvas(long);
    const b = editor.bounds;
    const k = size.width / Math.max(b.maxU - b.minU, 1e-6);
    const joints: Record<string, Record<string, [number, number]>> = {};
    for (const g of groupBoxes()) {
      if (g.cyl) {
        const { a, d, e1, e2, seam, R, sign, du } = g.cyl;
        joints[g.label] = Object.fromEntries(Object.entries(boneHeads).map(([n, p]) => {
          const r: V3 = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
          const h = r[0] * d[0] + r[1] * d[1] + r[2] * d[2];
          const rr: V3 = [r[0] - d[0] * h, r[1] - d[1] * h, r[2] - d[2] * h];
          let t = Math.atan2(rr[0] * e1[0] + rr[1] * e1[1] + rr[2] * e1[2], rr[0] * e2[0] + rr[1] * e2[1] + rr[2] * e2[2]) - seam;
          while (t < 0) t += 2 * Math.PI;
          while (t >= 2 * Math.PI) t -= 2 * Math.PI;
          return [n, [Math.round((t * R * sign + du - b.minU) * k), Math.round((b.maxV - h) * k)]];
        }));
        continue;
      }
      if (!g.map) continue;
      joints[g.label] = Object.fromEntries(
        Object.entries(boneHeads).map(([n, p]) => [n, [Math.round((g.map!.sx * p[0] + g.map!.du - b.minU) * k), Math.round((b.maxV - p[1]) * k)]]),
      );
    }
    const groups = groupBoxes().map((g) => ({ label: g.label, x0: Math.round((g.minU - b.minU) * k), x1: Math.round((g.maxU - b.minU) * k), y0: Math.round((b.maxV - g.maxV) * k), y1: Math.round((b.maxV - g.minV) * k) }));
    return { size, metersPerUnit: 1 / k, outline: editor.regionOutline(long, 900), groups, joints };
  },
  /** Adds an image that covers the whole canvas (same proportions as canvasInfo). */
  async addCanvasLayer(url: string, name: string) {
    const img = await loadImage(url);
    const layer = editor.addImageLayer(img, name);
    editor.fitLayerToRegion(layer);
  },
  exportState(): ProjectState {
    return {
      model: model.type === "body" ? model : { type: "body", preset: "m-average", overrides: {} },
      selection: rle([...viewer.selection].sort((a, b) => a - b)),
      up: unwrapUp,
      canvas: canvasMode,
      pose,
      layers: editor.serialize(),
    };
  },
  async importState(state: ProjectState, name: string) {
    await openState(state, name);
  },
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
  backend = await createBackend();
  document.body.classList.toggle("standalone", STANDALONE);
  $("#ext-box").hidden = !backend.externalPrompt;
  renderLayers();
  const params = new URLSearchParams(location.search);
  try {
    presets = await backend.presets();
  } catch {
    toast("Сервер недоступний: базові тіла не завантажено. Можна відкрити свій 3D-файл.", true);
  }
  refreshProjectList();
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
