/**
 * 2D editor of the unwrapped region. Everything is stored in "unwrap metres"
 * (the LSCM output is real-scale), so a 5 cm wide layer is 5 cm on the skin
 * and 5 cm on the printed stencil.
 */

export interface UnwrapGeometry {
  uv: Float64Array; // metres, 2 per vertex
  triangles: Uint32Array;
  areaRatio: Float64Array;
  /** Names of canvas parts (body parts, front/back) drawn above each part. */
  labels?: Array<{ text: string; u: number; v: number }>;
}

export interface Bounds {
  minU: number;
  minV: number;
  maxU: number;
  maxV: number;
}

export type Tool = "move" | "brush" | "eraser" | "pan";

interface BaseLayer {
  id: string;
  name: string;
  visible: boolean;
  opacity: number;
}

export interface ImageLayer extends BaseLayer {
  kind: "image";
  original: HTMLImageElement | HTMLCanvasElement;
  rendered: HTMLCanvasElement; // original or stencil-filtered
  stencil: boolean;
  /** Stencil line threshold 0..0.6: higher drops faint shading. */
  threshold: number;
  flipX: boolean;
  x: number; // centre, metres
  y: number;
  width: number; // metres
  rotation: number; // radians, CCW
}

export interface InkLayer extends BaseLayer {
  kind: "ink";
  canvas: HTMLCanvasElement;
  bounds: Bounds; // area of the unwrap covered by the canvas
}

export type Layer = ImageLayer | InkLayer;

const TEXTURE_MAX = 2048;
const INK_MAX = 2048;
const HISTORY_MAX = 20;
const HANDLE_PX = 9;

let nextId = 1;
const newId = () => `l${nextId++}`;

export function stencilFilter(src: CanvasImageSource, w: number, h: number, threshold = 0.0): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(src, 0, 0, w, h);
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const lum = (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
    let a = (1 - lum) * (d[i + 3] / 255);
    a = a < threshold ? 0 : Math.min(1, (a - threshold) / (1 - threshold));
    d[i] = d[i + 1] = d[i + 2] = 10;
    d[i + 3] = Math.round(a * 255);
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

function toCanvas(src: HTMLImageElement | HTMLCanvasElement): HTMLCanvasElement {
  if (src instanceof HTMLCanvasElement) return src;
  const c = document.createElement("canvas");
  c.width = src.naturalWidth;
  c.height = src.naturalHeight;
  c.getContext("2d")!.drawImage(src, 0, 0);
  return c;
}

/** Scale ruler with cm/mm ticks: print it and measure to verify 100% scale. */
function drawRuler(ctx: CanvasRenderingContext2D, ppm: number, x0: number, y0: number, canvasW: number) {
  const cm = Math.max(1, Math.min(5, Math.floor((canvasW - x0 * 2) / (ppm * 0.01))));
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.strokeStyle = "#000";
  ctx.fillStyle = "#000";
  ctx.lineWidth = Math.max(1, ppm * 0.0002);
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x0 + cm * 0.01 * ppm, y0);
  for (let mm = 0; mm <= cm * 10; mm++) {
    const x = x0 + mm * 0.001 * ppm;
    const len = mm % 10 === 0 ? 0.003 : mm % 5 === 0 ? 0.002 : 0.001;
    ctx.moveTo(x, y0);
    ctx.lineTo(x, y0 + len * ppm);
  }
  ctx.stroke();
  ctx.font = `${Math.round(ppm * 0.0025)}px sans-serif`;
  ctx.textBaseline = "top";
  ctx.fillText(`${cm} см — перевірте масштаб друку`, x0, y0 + 0.0042 * ppm);
  ctx.restore();
}

/** Edges used by exactly one triangle (the outline of the region). */
export function boundaryEdges(tris: ArrayLike<number>): Array<[number, number]> {
  const count = new Map<string, [number, number, number]>();
  for (let t = 0; t < tris.length; t += 3)
    for (let k = 0; k < 3; k++) {
      const a = tris[t + k];
      const b = tris[t + ((k + 1) % 3)];
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      const e = count.get(key);
      if (e) e[2]++;
      else count.set(key, [a, b, 1]);
    }
  return [...count.values()].filter((e) => e[2] === 1).map(([a, b]) => [a, b]);
}

function cloneCanvas(src: HTMLCanvasElement): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = src.width;
  c.height = src.height;
  c.getContext("2d")!.drawImage(src, 0, 0);
  return c;
}

export class UnwrapEditor {
  readonly canvas: HTMLCanvasElement;
  readonly texture: HTMLCanvasElement = document.createElement("canvas");
  layers: Layer[] = [];
  activeId: string | null = null;
  tool: Tool = "move";
  brushSize = 0.0015; // metres (1.5 mm line)
  brushColor = "#0b0b0d";
  showWire = true;
  showHeatmap = false;
  showGrid = true;
  /** Preview the tattoo as healed (softer, slightly faded) on the 3D body. */
  healed = false;

  geometry: UnwrapGeometry | null = null;
  bounds: Bounds = { minU: 0, minV: 0, maxU: 0.1, maxV: 0.1 };
  /** Texture placement: metres -> texture pixels. */
  private texPPM = 1;
  private texOrigin = { u: 0, v: 0 };

  // View transform: px = (u - cu) * zoom + w/2 ; py = h/2 - (v - cv) * zoom
  private cu = 0.05;
  private cv = 0.05;
  private zoom = 4000;
  private dpr = 1;

  private history: Layer[][] = [];
  private future: Layer[][] = [];
  private pointers = new Map<number, { x: number; y: number }>();
  private drag:
    | null
    | { type: "pan"; x: number; y: number }
    | { type: "move"; layer: ImageLayer; du: number; dv: number }
    | { type: "scale"; layer: ImageLayer; startDist: number; startWidth: number }
    | { type: "rotate"; layer: ImageLayer; startAngle: number; startRot: number }
    | { type: "ink"; layer: InkLayer; last: [number, number] }
    | { type: "pinch"; dist: number; zoom: number; mid: { x: number; y: number }; cu: number; cv: number } = null;
  private raf = 0;

  onTextureChange: (() => void) | null = null;
  onLayersChange: (() => void) | null = null;

  constructor(private container: HTMLElement) {
    this.canvas = document.createElement("canvas");
    this.canvas.className = "unwrap-canvas";
    this.canvas.style.touchAction = "none";
    container.appendChild(this.canvas);
    new ResizeObserver(() => this.resize()).observe(container);
    this.canvas.addEventListener("pointerdown", this.onDown);
    this.canvas.addEventListener("pointermove", this.onMove);
    this.canvas.addEventListener("pointerup", this.onUp);
    this.canvas.addEventListener("pointercancel", this.onUp);
    this.canvas.addEventListener("wheel", this.onWheel, { passive: false });
    this.resize();
  }

  // --- geometry -------------------------------------------------------------
  setGeometry(geometry: UnwrapGeometry | null) {
    this.geometry = geometry;
    if (geometry) {
      const uv = geometry.uv;
      const b = { minU: Infinity, minV: Infinity, maxU: -Infinity, maxV: -Infinity };
      for (let i = 0; i < uv.length; i += 2) {
        b.minU = Math.min(b.minU, uv[i]);
        b.maxU = Math.max(b.maxU, uv[i]);
        b.minV = Math.min(b.minV, uv[i + 1]);
        b.maxV = Math.max(b.maxV, uv[i + 1]);
      }
      this.bounds = b;
      const pad = 0.01 * Math.max(b.maxU - b.minU, b.maxV - b.minV);
      const w = b.maxU - b.minU + 2 * pad;
      const h = b.maxV - b.minV + 2 * pad;
      this.texPPM = TEXTURE_MAX / Math.max(w, h);
      this.texOrigin = { u: b.minU - pad, v: b.minV - pad };
      this.texture.width = Math.max(2, Math.ceil(w * this.texPPM));
      this.texture.height = Math.max(2, Math.ceil(h * this.texPPM));
      if (!this.layers.some((l) => l.kind === "ink")) this.addInkLayer("Туш");
      this.fit();
    }
    this.compose();
  }

  get size(): { width: number; height: number } {
    return { width: this.bounds.maxU - this.bounds.minU, height: this.bounds.maxV - this.bounds.minV };
  }

  /** Normalised texture coordinates for the 3D patch. */
  textureUVs(): Float32Array {
    const uv = this.geometry!.uv;
    const out = new Float32Array(uv.length);
    const W = this.texture.width / this.texPPM;
    const H = this.texture.height / this.texPPM;
    for (let i = 0; i < uv.length; i += 2) {
      out[i] = (uv[i] - this.texOrigin.u) / W;
      out[i + 1] = (uv[i + 1] - this.texOrigin.v) / H;
    }
    return out;
  }

  private needsFit = false;

  fit() {
    const { width, height } = this.size;
    const cw = this.canvas.clientWidth;
    const ch = this.canvas.clientHeight;
    if (!cw || !ch) {
      this.needsFit = true; // panel hidden (mobile tab) — fit when it appears
      return;
    }
    this.needsFit = false;
    this.cu = (this.bounds.minU + this.bounds.maxU) / 2;
    this.cv = (this.bounds.minV + this.bounds.maxV) / 2;
    this.zoom = 0.86 * Math.min(cw / Math.max(width, 1e-4), ch / Math.max(height, 1e-4));
    this.requestDraw();
  }

  // --- layers ---------------------------------------------------------------
  get active(): Layer | null {
    return this.layers.find((l) => l.id === this.activeId) ?? null;
  }

  addImageLayer(img: HTMLImageElement | HTMLCanvasElement, name: string, stencil = false): ImageLayer {
    this.pushHistory();
    const { width, height } = this.size;
    const iw = img instanceof HTMLImageElement ? img.naturalWidth : img.width;
    const ih = img instanceof HTMLImageElement ? img.naturalHeight : img.height;
    const aspect = ih / iw;
    let w = Math.min(width, height / aspect) * 0.7;
    if (!isFinite(w) || w <= 0) w = 0.05;
    const layer: ImageLayer = {
      id: newId(),
      kind: "image",
      name,
      visible: true,
      opacity: 1,
      original: img,
      rendered: toCanvas(img),
      stencil: false,
      threshold: 0.08,
      flipX: false,
      x: (this.bounds.minU + this.bounds.maxU) / 2,
      y: (this.bounds.minV + this.bounds.maxV) / 2,
      width: w,
      rotation: 0,
    };
    // Insert below the top ink layer so fresh ink stays on top.
    const inkIdx = this.layers.findIndex((l) => l.kind === "ink");
    if (inkIdx >= 0) this.layers.splice(inkIdx, 0, layer);
    else this.layers.push(layer);
    if (stencil) this.setStencil(layer, true, false);
    this.activeId = layer.id;
    this.changed();
    return layer;
  }

  addInkLayer(name = "Туш"): InkLayer {
    const pad = 0.15 * Math.max(this.size.width, this.size.height);
    const b = {
      minU: this.bounds.minU - pad,
      minV: this.bounds.minV - pad,
      maxU: this.bounds.maxU + pad,
      maxV: this.bounds.maxV + pad,
    };
    const ppm = INK_MAX / Math.max(b.maxU - b.minU, b.maxV - b.minV);
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil((b.maxU - b.minU) * ppm);
    canvas.height = Math.ceil((b.maxV - b.minV) * ppm);
    const layer: InkLayer = { id: newId(), kind: "ink", name, visible: true, opacity: 1, canvas, bounds: b };
    this.layers.push(layer);
    this.activeId = layer.id;
    this.changed();
    return layer;
  }

  setStencil(layer: ImageLayer, on: boolean, record = true, threshold = layer.threshold) {
    if (record) this.pushHistory();
    layer.stencil = on;
    layer.threshold = threshold;
    const src = layer.original;
    const w = src instanceof HTMLImageElement ? src.naturalWidth : src.width;
    const h = src instanceof HTMLImageElement ? src.naturalHeight : src.height;
    layer.rendered = on ? stencilFilter(src, w, h, threshold) : toCanvas(src);
    if (record) this.changed();
    else this.compose();
  }

  duplicateLayer(id: string) {
    const l = this.layers.find((x) => x.id === id);
    if (!l || l.kind !== "image") return;
    this.pushHistory();
    const copy: ImageLayer = { ...l, id: newId(), name: `${l.name} (копія)`, x: l.x + l.width * 0.15, y: l.y - l.width * 0.15 };
    this.layers.splice(this.layers.indexOf(l) + 1, 0, copy);
    this.activeId = copy.id;
    this.changed();
  }

  /** With record=false (live slider drags) only the picture updates, not the UI. */
  updateLayer(layer: Layer, patch: Partial<Omit<ImageLayer, "kind" | "id"> & Omit<InkLayer, "kind" | "id">>, record = true) {
    if (record) this.pushHistory();
    Object.assign(layer, patch);
    if (record) this.changed();
    else this.compose();
  }

  /** Save an undo point before a series of live updates. */
  checkpoint() {
    this.pushHistory();
  }

  removeLayer(id: string) {
    this.pushHistory();
    this.layers = this.layers.filter((l) => l.id !== id);
    if (this.activeId === id) this.activeId = this.layers.at(-1)?.id ?? null;
    this.changed();
  }

  moveLayer(id: string, dir: -1 | 1) {
    const i = this.layers.findIndex((l) => l.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= this.layers.length) return;
    this.pushHistory();
    [this.layers[i], this.layers[j]] = [this.layers[j], this.layers[i]];
    this.changed();
  }

  clearAll() {
    this.pushHistory();
    this.layers = [];
    this.activeId = null;
    if (this.geometry) this.addInkLayer("Туш");
    this.changed();
  }

  // --- history --------------------------------------------------------------
  private snapshot(): Layer[] {
    return this.layers.map((l) => ({ ...l }) as Layer);
  }

  private pushHistory() {
    this.history.push(this.snapshot());
    if (this.history.length > HISTORY_MAX) this.history.shift();
    this.future = [];
  }

  undo() {
    const prev = this.history.pop();
    if (!prev) return;
    this.future.push(this.snapshot());
    this.layers = prev;
    if (!this.active) this.activeId = this.layers.at(-1)?.id ?? null;
    this.changed();
  }

  redo() {
    const next = this.future.pop();
    if (!next) return;
    this.history.push(this.snapshot());
    this.layers = next;
    this.changed();
  }

  get canUndo() {
    return this.history.length > 0;
  }
  get canRedo() {
    return this.future.length > 0;
  }

  // --- rendering --------------------------------------------------------------
  private changed() {
    this.compose();
    this.onLayersChange?.();
  }

  /** Draw all layers with a metres -> pixels transform. */
  drawLayers(ctx: CanvasRenderingContext2D, ppm: number, originU: number, originV: number, heightPx: number, alphaScale = 1) {
    // px = (u - originU) * ppm ; py = heightPx - (v - originV) * ppm
    const base = new DOMMatrix([ppm, 0, 0, -ppm, -originU * ppm, heightPx + originV * ppm]);
    for (const l of this.layers) {
      if (!l.visible) continue;
      ctx.save();
      ctx.setTransform(base);
      ctx.globalAlpha = l.opacity * alphaScale;
      if (l.kind === "image") {
        const h = l.width * (l.rendered.height / l.rendered.width);
        ctx.translate(l.x, l.y);
        ctx.rotate(l.rotation);
        ctx.scale(l.flipX ? -1 : 1, -1);
        ctx.drawImage(l.rendered, -l.width / 2, -h / 2, l.width, h);
      } else {
        const b = l.bounds;
        ctx.translate(b.minU, b.maxV);
        ctx.scale(1, -1);
        ctx.drawImage(l.canvas, 0, 0, b.maxU - b.minU, b.maxV - b.minV);
      }
      ctx.restore();
    }
  }

  compose() {
    const ctx = this.texture.getContext("2d")!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.texture.width, this.texture.height);
    if (this.geometry) {
      ctx.imageSmoothingQuality = "high";
      // Healed look: ink spreads a little under the skin and loses some contrast.
      if (this.healed) ctx.filter = `blur(${Math.max(0.5, 0.00035 * this.texPPM).toFixed(2)}px)`;
      this.drawLayers(ctx, this.texPPM, this.texOrigin.u, this.texOrigin.v, this.texture.height, this.healed ? 0.82 : 1);
      ctx.filter = "none";
    }
    this.onTextureChange?.();
    this.requestDraw();
  }

  private resize() {
    this.dpr = Math.min(devicePixelRatio || 1, 2);
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    if (this.geometry && this.needsFit) this.fit();
    this.requestDraw();
  }

  requestDraw() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.draw();
    });
  }

  private toScreen(u: number, v: number): [number, number] {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    return [(u - this.cu) * this.zoom + w / 2, h / 2 - (v - this.cv) * this.zoom];
  }

  private toUnwrap(x: number, y: number): [number, number] {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    return [(x - w / 2) / this.zoom + this.cu, (h / 2 - y) / this.zoom + this.cv];
  }

  private draw() {
    const ctx = this.canvas.getContext("2d")!;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = "#1b1c22";
    ctx.fillRect(0, 0, w, h);

    if (!this.geometry) {
      ctx.fillStyle = "#8a8d99";
      ctx.font = "15px system-ui, sans-serif";
      ctx.textAlign = "center";
      const lines = ["Виділіть кистю ділянку на тілі,", "тут з'явиться її розгортка"];
      lines.forEach((t, i) => ctx.fillText(t, w / 2, h / 2 + i * 22 - 10));
      return;
    }

    if (this.showGrid) this.drawGrid(ctx, w, h);

    // Region shape (skin) + optional distortion heatmap.
    const { uv, triangles, areaRatio } = this.geometry;
    const path = new Path2D();
    for (let t = 0; t < triangles.length; t += 3) {
      const [ax, ay] = this.toScreen(uv[2 * triangles[t]], uv[2 * triangles[t] + 1]);
      const [bx, by] = this.toScreen(uv[2 * triangles[t + 1]], uv[2 * triangles[t + 1] + 1]);
      const [cx, cy] = this.toScreen(uv[2 * triangles[t + 2]], uv[2 * triangles[t + 2] + 1]);
      path.moveTo(ax, ay);
      path.lineTo(bx, by);
      path.lineTo(cx, cy);
      path.closePath();
      if (this.showHeatmap) {
        const r = areaRatio[t / 3];
        const d = r > 0 ? Math.max(-1, Math.min(1, Math.log2(r) * 2)) : 1;
        ctx.fillStyle = d > 0 ? `rgb(${231},${Math.round(193 - 140 * d)},${Math.round(164 - 120 * d)})` : `rgb(${Math.round(231 + 180 * d)},${Math.round(193 + 40 * d)},${Math.round(164 - 60 * d)})`;
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(bx, by);
        ctx.lineTo(cx, cy);
        ctx.fill();
      }
    }
    if (!this.showHeatmap) {
      ctx.fillStyle = "#e7c1a4";
      ctx.fill(path);
    }
    if (this.geometry.labels) {
      ctx.fillStyle = "#aeb3c2";
      ctx.font = "600 13px system-ui, sans-serif";
      ctx.textAlign = "left";
      for (const l of this.geometry.labels) {
        const [x, y] = this.toScreen(l.u, l.v);
        ctx.fillText(l.text, x, y - 8);
      }
    }

    // Tattoo layers (draw the composed texture at its placement).
    const [tx, ty] = this.toScreen(this.texOrigin.u, this.texOrigin.v + this.texture.height / this.texPPM);
    const scale = this.zoom / this.texPPM;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(this.texture, tx, ty, this.texture.width * scale, this.texture.height * scale);

    if (this.showWire) {
      ctx.strokeStyle = "rgba(20, 60, 70, 0.28)";
      ctx.lineWidth = 0.6;
      ctx.stroke(path);
    }

    const a = this.active;
    if (a && a.kind === "image" && a.visible) this.drawHandles(ctx, a);
  }

  private drawGrid(ctx: CanvasRenderingContext2D, w: number, h: number) {
    const [u0, v1] = this.toUnwrap(0, 0);
    const [u1, v0] = this.toUnwrap(w, h);
    const step = this.zoom * 0.01 < 8 ? 0.05 : 0.01; // 1 cm or 5 cm lines
    ctx.lineWidth = 1;
    for (let u = Math.floor(u0 / step) * step; u <= u1; u += step) {
      const [x] = this.toScreen(u, 0);
      const major = Math.round(u / step) % (step === 0.01 ? 5 : 2) === 0;
      ctx.strokeStyle = major ? "#2c2f3a" : "#23252d";
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, 0);
      ctx.lineTo(Math.round(x) + 0.5, h);
      ctx.stroke();
    }
    for (let v = Math.floor(v0 / step) * step; v <= v1; v += step) {
      const [, y] = this.toScreen(0, v);
      const major = Math.round(v / step) % (step === 0.01 ? 5 : 2) === 0;
      ctx.strokeStyle = major ? "#2c2f3a" : "#23252d";
      ctx.beginPath();
      ctx.moveTo(0, Math.round(y) + 0.5);
      ctx.lineTo(w, Math.round(y) + 0.5);
      ctx.stroke();
    }
    ctx.fillStyle = "#6c7080";
    ctx.font = "11px system-ui, sans-serif";
    ctx.textAlign = "left";
    ctx.fillText(step === 0.01 ? "сітка 1 см" : "сітка 5 см", 8, h - 8);
  }

  private layerCorners(l: ImageLayer): [number, number][] {
    const hw = l.width / 2;
    const hh = (l.width * (l.rendered.height / l.rendered.width)) / 2;
    const c = Math.cos(l.rotation);
    const s = Math.sin(l.rotation);
    return [
      [-hw, -hh],
      [hw, -hh],
      [hw, hh],
      [-hw, hh],
    ].map(([x, y]) => [l.x + x * c - y * s, l.y + x * s + y * c]);
  }

  private handlePositions(l: ImageLayer) {
    const corners = this.layerCorners(l).map(([u, v]) => this.toScreen(u, v));
    const hh = (l.width * (l.rendered.height / l.rendered.width)) / 2;
    const offset = hh + 24 / this.zoom;
    const rot = this.toScreen(l.x - Math.sin(l.rotation) * offset, l.y + Math.cos(l.rotation) * offset);
    const top = this.toScreen(l.x - Math.sin(l.rotation) * hh, l.y + Math.cos(l.rotation) * hh);
    return { corners, rot, top };
  }

  private drawHandles(ctx: CanvasRenderingContext2D, l: ImageLayer) {
    const { corners, rot, top } = this.handlePositions(l);
    ctx.strokeStyle = "#3fd0c9";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    corners.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(top[0], top[1]);
    ctx.lineTo(rot[0], rot[1]);
    ctx.stroke();
    ctx.fillStyle = "#15161b";
    for (const [x, y] of corners) {
      ctx.beginPath();
      ctx.rect(x - HANDLE_PX / 2, y - HANDLE_PX / 2, HANDLE_PX, HANDLE_PX);
      ctx.fill();
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.arc(rot[0], rot[1], HANDLE_PX / 1.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    // Size label in centimetres.
    const hcm = l.width * (l.rendered.height / l.rendered.width) * 100;
    ctx.fillStyle = "#3fd0c9";
    ctx.font = "12px system-ui, sans-serif";
    ctx.textAlign = "center";
    const [lx, ly] = this.toScreen(l.x, l.y);
    const maxY = Math.max(...corners.map((c) => c[1]));
    ctx.fillText(`${(l.width * 100).toFixed(1)} × ${hcm.toFixed(1)} см`, lx, Math.max(ly, maxY + 18));
  }

  // --- input ------------------------------------------------------------------
  private local(e: PointerEvent) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private hitLayer(u: number, v: number): ImageLayer | null {
    for (let i = this.layers.length - 1; i >= 0; i--) {
      const l = this.layers[i];
      if (l.kind !== "image" || !l.visible) continue;
      const c = Math.cos(-l.rotation);
      const s = Math.sin(-l.rotation);
      const dx = u - l.x;
      const dy = v - l.y;
      const lx = dx * c - dy * s;
      const ly = dx * s + dy * c;
      const hh = (l.width * (l.rendered.height / l.rendered.width)) / 2;
      if (Math.abs(lx) <= l.width / 2 && Math.abs(ly) <= hh) return l;
    }
    return null;
  }

  private onDown = (e: PointerEvent) => {
    if (!this.geometry) return;
    this.canvas.setPointerCapture(e.pointerId);
    const p = this.local(e);
    this.pointers.set(e.pointerId, p);
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.drag = {
        type: "pinch",
        dist: Math.hypot(a.x - b.x, a.y - b.y),
        zoom: this.zoom,
        mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
        cu: this.cu,
        cv: this.cv,
      };
      return;
    }
    const [u, v] = this.toUnwrap(p.x, p.y);
    const pan = this.tool === "pan" || e.button === 1 || e.button === 2;

    if (!pan && (this.tool === "brush" || this.tool === "eraser")) {
      let ink = this.active?.kind === "ink" ? (this.active as InkLayer) : null;
      if (!ink) ink = (this.layers.filter((l) => l.kind === "ink").at(-1) as InkLayer) ?? this.addInkLayer();
      this.activeId = ink.id;
      this.pushHistory();
      ink.canvas = cloneCanvas(ink.canvas); // history keeps the old pixels
      this.drag = { type: "ink", layer: ink, last: [u, v] };
      this.inkSegment(ink, [u, v], [u, v]);
      this.onLayersChange?.();
      return;
    }

    if (!pan && this.tool === "move") {
      const a = this.active;
      if (a && a.kind === "image") {
        const { corners, rot } = this.handlePositions(a);
        if (Math.hypot(p.x - rot[0], p.y - rot[1]) < HANDLE_PX * 1.4) {
          this.pushHistory();
          this.drag = { type: "rotate", layer: a, startAngle: Math.atan2(v - a.y, u - a.x), startRot: a.rotation };
          return;
        }
        if (corners.some(([x, y]) => Math.hypot(p.x - x, p.y - y) < HANDLE_PX * 1.4)) {
          this.pushHistory();
          this.drag = { type: "scale", layer: a, startDist: Math.hypot(u - a.x, v - a.y), startWidth: a.width };
          return;
        }
      }
      const hit = this.hitLayer(u, v);
      if (hit) {
        this.activeId = hit.id;
        this.pushHistory();
        this.drag = { type: "move", layer: hit, du: u - hit.x, dv: v - hit.y };
        this.onLayersChange?.();
        this.requestDraw();
        return;
      }
    }
    this.drag = { type: "pan", x: p.x, y: p.y };
  };

  private onMove = (e: PointerEvent) => {
    if (!this.pointers.has(e.pointerId)) return;
    const p = this.local(e);
    this.pointers.set(e.pointerId, p);
    const d = this.drag;
    if (!d) return;
    if (d.type === "pinch") {
      if (this.pointers.size < 2) return;
      const [a, b] = [...this.pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      this.zoom = d.zoom * (dist / Math.max(d.dist, 1));
      this.cu = d.cu - (mid.x - d.mid.x) / this.zoom;
      this.cv = d.cv + (mid.y - d.mid.y) / this.zoom;
      this.requestDraw();
      return;
    }
    const [u, v] = this.toUnwrap(p.x, p.y);
    switch (d.type) {
      case "pan":
        this.cu -= (p.x - d.x) / this.zoom;
        this.cv += (p.y - d.y) / this.zoom;
        d.x = p.x;
        d.y = p.y;
        this.requestDraw();
        break;
      case "move":
        d.layer.x = u - d.du;
        d.layer.y = v - d.dv;
        this.compose();
        break;
      case "scale": {
        const dist = Math.hypot(u - d.layer.x, v - d.layer.y);
        d.layer.width = Math.max(0.002, d.startWidth * (dist / Math.max(d.startDist, 1e-6)));
        this.compose();
        break;
      }
      case "rotate": {
        let r = d.startRot + Math.atan2(v - d.layer.y, u - d.layer.x) - d.startAngle;
        if (e.shiftKey) r = Math.round(r / (Math.PI / 12)) * (Math.PI / 12);
        d.layer.rotation = r;
        this.compose();
        break;
      }
      case "ink":
        this.inkSegment(d.layer, d.last, [u, v]);
        d.last = [u, v];
        break;
    }
  };

  private onUp = (e: PointerEvent) => {
    this.pointers.delete(e.pointerId);
    if (this.drag && this.drag.type !== "pan" && this.drag.type !== "pinch") this.onLayersChange?.();
    this.drag = null;
  };

  private onWheel = (e: WheelEvent) => {
    if (!this.geometry) return;
    e.preventDefault();
    const p = { x: e.offsetX, y: e.offsetY };
    const [u, v] = this.toUnwrap(p.x, p.y);
    this.zoom *= Math.exp(-e.deltaY * 0.0015);
    // keep the point under the cursor fixed
    const [u2, v2] = this.toUnwrap(p.x, p.y);
    this.cu += u - u2;
    this.cv += v - v2;
    this.requestDraw();
  };

  private inkSegment(layer: InkLayer, from: [number, number], to: [number, number]) {
    const b = layer.bounds;
    const ppm = layer.canvas.width / (b.maxU - b.minU);
    const px = (u: number) => (u - b.minU) * ppm;
    const py = (v: number) => (b.maxV - v) * ppm;
    const ctx = layer.canvas.getContext("2d")!;
    ctx.save();
    ctx.globalCompositeOperation = this.tool === "eraser" ? "destination-out" : "source-over";
    ctx.strokeStyle = this.brushColor;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.lineWidth = Math.max(1, this.brushSize * ppm * (this.tool === "eraser" ? 4 : 1));
    ctx.beginPath();
    ctx.moveTo(px(from[0]), py(from[1]));
    ctx.lineTo(px(to[0]) + 0.01, py(to[1]));
    ctx.stroke();
    ctx.restore();
    this.compose();
  }

  // --- export -------------------------------------------------------------------
  /**
   * Print-ready stencil at real size. Clipped to the region, optional
   * outline of the region so the artist can align it on the skin.
   */
  renderStencil(dpi = 300, outline = true): HTMLCanvasElement {
    const ppm = dpi / 0.0254;
    const b = this.bounds;
    const margin = 0.005;
    const rulerSpace = 0.014; // room under the design for the scale ruler
    const W = Math.ceil(Math.max(b.maxU - b.minU + 2 * margin, 0.06) * ppm);
    const H = Math.ceil((b.maxV - b.minV + 2 * margin) * ppm);
    const c = document.createElement("canvas");
    c.width = W;
    c.height = H + Math.ceil(rulerSpace * ppm);
    const ctx = c.getContext("2d")!;
    const ou = b.minU - margin;
    const ov = b.minV - margin;
    this.drawLayers(ctx, ppm, ou, ov, H);
    if (this.geometry) {
      const { uv, triangles } = this.geometry;
      const path = new Path2D();
      const X = (i: number) => (uv[2 * i] - ou) * ppm;
      const Y = (i: number) => H - (uv[2 * i + 1] - ov) * ppm;
      for (let t = 0; t < triangles.length; t += 3) {
        path.moveTo(X(triangles[t]), Y(triangles[t]));
        path.lineTo(X(triangles[t + 1]), Y(triangles[t + 1]));
        path.lineTo(X(triangles[t + 2]), Y(triangles[t + 2]));
        path.closePath();
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalCompositeOperation = "destination-in";
      ctx.fill(path);
      ctx.globalCompositeOperation = "destination-over";
      if (outline) {
        const edges = new Path2D();
        for (const [a, b2] of boundaryEdges(triangles)) {
          edges.moveTo(X(a), Y(a));
          edges.lineTo(X(b2), Y(b2));
        }
        ctx.strokeStyle = "rgba(0,0,0,0.22)";
        ctx.lineWidth = Math.max(2, ppm * 0.0004);
        ctx.lineJoin = "round";
        ctx.stroke(edges);
      }
      ctx.globalCompositeOperation = "source-over";
    }
    drawRuler(ctx, ppm, margin * ppm, H + 0.004 * ppm, W);
    // White paper behind everything: prints as-is and the ruler stays visible in any viewer.
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = "destination-over";
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.restore();
    return c;
  }

  // --- region shape for generators --------------------------------------------
  /** Canvas size (SVG units) with the region's proportions, longest side `long`. */
  regionCanvas(long = 1024): { width: number; height: number } {
    const { width, height } = this.size;
    const k = long / Math.max(width, height, 1e-6);
    return { width: Math.max(64, Math.round(width * k)), height: Math.max(64, Math.round(height * k)) };
  }

  /** Region outline as an SVG path in regionCanvas() coordinates (y down), simplified. */
  regionOutline(long = 1024, maxPoints = 260): string {
    if (!this.geometry) return "";
    const { uv, triangles } = this.geometry;
    const { width } = this.regionCanvas(long);
    const k = width / Math.max(this.size.width, 1e-6);
    const X = (i: number) => Math.round((uv[2 * i] - this.bounds.minU) * k);
    const Y = (i: number) => Math.round((this.bounds.maxV - uv[2 * i + 1]) * k);
    const next = new Map<number, number[]>();
    for (const [a, b] of boundaryEdges(triangles)) {
      (next.get(a) ?? next.set(a, []).get(a)!).push(b);
      (next.get(b) ?? next.set(b, []).get(b)!).push(a);
    }
    const seen = new Set<number>();
    const loops: number[][] = [];
    for (const start of next.keys()) {
      if (seen.has(start)) continue;
      const loop = [start];
      seen.add(start);
      let cur = start;
      for (;;) {
        const nb = (next.get(cur) ?? []).find((v) => !seen.has(v));
        if (nb === undefined) break;
        seen.add(nb);
        loop.push(nb);
        cur = nb;
      }
      if (loop.length > 2) loops.push(loop);
    }
    const total = loops.reduce((s, l) => s + l.length, 0);
    const step = Math.max(1, Math.ceil(total / maxPoints));
    return loops
      .map((l) => {
        const pts = l.filter((_, i) => i % step === 0);
        return "M" + pts.map((v) => `${X(v)} ${Y(v)}`).join(" L") + " Z";
      })
      .join(" ");
  }

  /** Stretch a layer to cover the region's bounding box (keeping proportions). */
  fitLayerToRegion(layer: ImageLayer, record = true) {
    if (record) this.pushHistory();
    const { width, height } = this.size;
    const aspect = layer.rendered.height / layer.rendered.width;
    layer.rotation = 0;
    layer.x = (this.bounds.minU + this.bounds.maxU) / 2;
    layer.y = (this.bounds.minV + this.bounds.maxV) / 2;
    layer.width = Math.min(width, height / aspect);
    this.changed();
  }

  // --- persistence -------------------------------------------------------------
  serialize() {
    return this.layers.map((l) =>
      l.kind === "image"
        ? {
            kind: "image" as const,
            name: l.name,
            visible: l.visible,
            opacity: l.opacity,
            stencil: l.stencil,
            threshold: l.threshold,
            flipX: l.flipX,
            x: l.x,
            y: l.y,
            width: l.width,
            rotation: l.rotation,
            src: toCanvas(l.original).toDataURL("image/png"),
          }
        : {
            kind: "ink" as const,
            name: l.name,
            visible: l.visible,
            opacity: l.opacity,
            bounds: l.bounds,
            src: l.canvas.toDataURL("image/png"),
          },
    );
  }

  async deserialize(items: ReturnType<UnwrapEditor["serialize"]>) {
    const load = (src: string) =>
      new Promise<HTMLImageElement>((res, rej) => {
        const img = new Image();
        img.onload = () => res(img);
        img.onerror = rej;
        img.src = src;
      });
    const layers: Layer[] = [];
    for (const it of items) {
      const img = await load(it.src);
      if (it.kind === "image") {
        const layer: ImageLayer = {
          id: newId(),
          kind: "image",
          name: it.name,
          visible: it.visible,
          opacity: it.opacity,
          original: img,
          rendered: toCanvas(img),
          stencil: false,
          threshold: it.threshold ?? 0.08,
          flipX: it.flipX ?? false,
          x: it.x,
          y: it.y,
          width: it.width,
          rotation: it.rotation,
        };
        if (it.stencil) {
          layer.stencil = true;
          layer.rendered = stencilFilter(img, img.naturalWidth, img.naturalHeight, layer.threshold);
        }
        layers.push(layer);
      } else {
        const canvas = toCanvas(img);
        layers.push({ id: newId(), kind: "ink", name: it.name, visible: it.visible, opacity: it.opacity, canvas, bounds: it.bounds });
      }
    }
    this.layers = layers;
    this.history = [];
    this.future = [];
    this.activeId = layers.at(-1)?.id ?? null;
    this.changed();
  }
}
