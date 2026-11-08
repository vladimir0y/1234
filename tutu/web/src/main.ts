import * as THREE from "three";
import { api } from "./api";
import { DEMO_MODELS, type DemoModelId } from "./core/demoModels";
import { extensionOf, MESH_EXTENSIONS, parseMesh, prepareBody } from "./core/loaders";
import { setPngDpi } from "./core/png";
import { buildFaceAdjacency, connectedComponents, extractPatch, smoothSelection } from "./core/topology";
import type { CombinedUnwrap, PatchInput } from "./core/unwrap";
import { UnwrapEditor, type ImageLayer, type Layer, type Tool } from "./unwrapEditor";
import { Viewer, type BrushMode } from "./viewer";

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const $$ = <T extends HTMLElement = HTMLElement>(sel: string) => [...document.querySelectorAll<T>(sel)];

// ---------------------------------------------------------------------------
// State
type ModelSource = { type: "demo"; id: DemoModelId } | { type: "scan"; id: string } | { type: "file"; name: string };

interface ProjectState {
  model: { type: "demo"; id: DemoModelId } | { type: "scan"; id: string };
  selection: number[]; // run-length encoded [start, length, ...]
  layers: ReturnType<UnwrapEditor["serialize"]>;
}

const viewer = new Viewer($("#viewport"));
const editor = new UnwrapEditor($("#unwrap"));
let model: ModelSource = { type: "demo", id: "forearm" };
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
async function loadGeometry(geometry: THREE.BufferGeometry, label: string) {
  const prepared = prepareBody(geometry);
  viewer.setBody(prepared);
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

async function loadDemo(id: DemoModelId) {
  model = { type: "demo", id };
  rawFile = null;
  await loadGeometry(DEMO_MODELS[id].build(), DEMO_MODELS[id].label);
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

function runUnwrap(patches: PatchInput[]): Promise<CombinedUnwrap> {
  pending?.reject(new Error("cancelled"));
  const id = ++jobId;
  return new Promise((resolve, reject) => {
    pending = { resolve, reject };
    worker.postMessage({ id, patches });
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
  patchVertices = patches.flatMap((p) => p.vertices);
  editor.setGeometry({ uv: result.uv, triangles: result.triangles, areaRatio: result.areaRatio });

  texture?.dispose();
  texture = new THREE.CanvasTexture(editor.texture);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = viewer.renderer.capabilities.getMaxAnisotropy();
  viewer.setPatch(patchVertices, result.triangles, editor.textureUVs(), texture);

  const { width, height } = editor.size;
  const quality = result.meanDistortion < 0.05 ? "відмінна" : result.meanDistortion < 0.15 ? "добра" : "помітні спотворення";
  const ring = result.loops.some((l) => l > 1);
  setInfo(
    `${(width * 100).toFixed(1)} × ${(height * 100).toFixed(1)} см · розгортка: ${quality}` +
      (comps.length > 1 ? ` · ${comps.length} ділянки` : "") +
      (ring ? " · ділянка-кільце: можливі накладення (шов — у наступній версії)" : ""),
    ring || result.meanDistortion >= 0.15,
  );
}

editor.onTextureChange = () => {
  if (texture) texture.needsUpdate = true;
};

let unwrapTimer = 0;
viewer.onStrokeEnd = () => {
  if (adjacency && viewer.selection.size > 8) viewer.setSelection(smoothSelection(adjacency, viewer.selection));
  clearTimeout(unwrapTimer);
  unwrapTimer = window.setTimeout(unwrapSelection, 60);
};
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
    slider("Ширина", 0.5, 60, 0.1, img.width * 100, (v) => `${v.toFixed(1)} см`, (v) => editor.updateLayer(img, { width: v / 100 }, false));
    slider("Поворот", -180, 180, 1, (img.rotation * 180) / Math.PI, (v) => `${Math.round(v)}°`, (v) =>
      editor.updateLayer(img, { rotation: (v * Math.PI) / 180 }, false),
    );
    const st = document.createElement("label");
    st.className = "check";
    st.innerHTML = `<input type="checkbox" ${img.stencil ? "checked" : ""}/> трафарет (чорна лінія, без фону)`;
    st.querySelector("input")!.addEventListener("change", (e) => editor.setStencil(img, (e.target as HTMLInputElement).checked));
    box.appendChild(st);
  }
}
editor.onLayersChange = renderLayers;

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
const STYLE_LABELS: Record<string, string> = {
  "fine-line": "Fine line",
  blackwork: "Blackwork",
  traditional: "Traditional",
  geometric: "Геометрія",
  watercolor: "Акварель",
  minimal: "Мінімалізм",
  japanese: "Японський",
  realism: "Реалізм",
};
const styleSelect = $<HTMLSelectElement>("#style");
for (const [id, label] of Object.entries(STYLE_LABELS)) styleSelect.add(new Option(label, id));

$("#generate").addEventListener("click", async () => {
  const prompt = $<HTMLTextAreaElement>("#prompt").value.trim();
  if (prompt.length < 2) return toast("Опишіть, що згенерувати", true);
  const btn = $<HTMLButtonElement>("#generate");
  btn.disabled = true;
  $("#gen-status").textContent = "Генерую ескіз…";
  try {
    const { width, height } = editor.size;
    const res = await api.generate({
      prompt,
      style: styleSelect.value,
      region_aspect: editor.geometry ? width / height : undefined,
    });
    const img = await loadImage(api.url(res.url));
    $("#gen-status").textContent = `Готово (${res.provider}). Натисніть на ескіз, щоб додати ще раз.`;
    const thumb = document.createElement("button");
    thumb.title = prompt;
    thumb.appendChild(img.cloneNode());
    thumb.addEventListener("click", () => {
      if (!editor.geometry) return toast("Спершу виділіть ділянку на тілі", true);
      editor.addImageLayer(img, prompt.slice(0, 40), true);
    });
    $("#gallery").prepend(thumb);
    if (editor.geometry) editor.addImageLayer(img, prompt.slice(0, 40), true);
    else toast("Ескіз у галереї. Виділіть ділянку, щоб накласти його");
  } catch (err) {
    $("#gen-status").textContent = "";
    toast(`Генерація не вдалася: ${(err as Error).message}. Чи запущено сервер?`, true);
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
const demoSelect = $<HTMLSelectElement>("#demo-model");
for (const [id, m] of Object.entries(DEMO_MODELS)) demoSelect.add(new Option(`Демо: ${m.label}`, id));
demoSelect.addEventListener("change", () => loadDemo(demoSelect.value as DemoModelId).catch((e) => toast(e.message, true)));

$<HTMLInputElement>("#mesh-file").addEventListener("change", async (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  (e.target as HTMLInputElement).value = "";
  if (!file) return;
  if (!MESH_EXTENSIONS.includes(extensionOf(file.name))) return toast("Підтримуються OBJ, GLB, GLTF, PLY, STL", true);
  try {
    const data = await file.arrayBuffer();
    await loadMeshData(data, file.name, { type: "file", name: file.name });
    rawFile = { data, name: file.name };
    demoSelect.selectedIndex = -1;
  } catch (err) {
    toast((err as Error).message, true);
  }
});

// ---------------------------------------------------------------------------
// Projects
$("#save").addEventListener("click", async () => {
  const btn = $<HTMLButtonElement>("#save");
  btn.disabled = true;
  try {
    if (model.type === "file" && rawFile) {
      const scan = await api.uploadScan(new Blob([rawFile.data]), rawFile.name, rawFile.name);
      model = { type: "scan", id: scan.id };
    }
    const state: ProjectState = {
      model: model.type === "file" ? { type: "demo", id: "forearm" } : model,
      selection: rle([...viewer.selection].sort((a, b) => a - b)),
      layers: editor.serialize(),
    };
    const name = $<HTMLInputElement>("#project-name").value || "Без назви";
    const saved = await api.saveProject(projectId, { name, scan_id: model.type === "scan" ? model.id : null, state });
    projectId = saved.id;
    history.replaceState(null, "", `?project=${saved.id}`);
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
  else if (m.type === "demo") {
    demoSelect.value = m.id;
    await loadDemo(m.id);
  }
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
    if (projectId) await openProject(projectId);
    else if (params.get("scan")) await loadScan(params.get("scan")!);
    else await loadDemo("forearm");
  } catch (err) {
    toast((err as Error).message, true);
    await loadDemo("forearm");
  }
  api
    .health()
    .then((h) => ($("#gen-status").textContent = h.image_provider === "mock" ? "Сервер: офлайн-генератор (без API-ключа)" : ""))
    .catch(() => ($("#gen-status").textContent = "Сервер недоступний — генерація вимкнена"));
}
boot();
