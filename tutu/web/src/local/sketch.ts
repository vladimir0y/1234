/**
 * Sketch generation in the browser-only build: Claude draws the tattoo as
 * SVG through the artifact `sample` capability (no keys, no external hosts).
 */
import { capability, type SampleFn } from "./claude";

export const LOCAL_STYLES = [
  { id: "fine-line", label: "Fine line", mode: "ink" as const, hint: "delicate fine line, single thin stroke weight (stroke-width 2-3), no fills" },
  { id: "blackwork", label: "Blackwork", mode: "ink" as const, hint: "bold blackwork: large solid black fills and thick strokes, strong negative space" },
  { id: "minimal", label: "Мінімалізм", mode: "ink" as const, hint: "minimalist: very few clean lines, lots of empty space" },
  { id: "geometric", label: "Геометрія", mode: "ink" as const, hint: "geometric: precise symmetric shapes, sacred geometry, circles and polygons" },
  { id: "dotwork", label: "Dotwork", mode: "ink" as const, hint: "dotwork: outlines plus shading made from many small dots (circles r=1-2)" },
  { id: "ornamental", label: "Орнамент", mode: "ink" as const, hint: "ornamental: mandala and filigree, mirrored symmetric patterns" },
  { id: "lettering", label: "Леттеринг", mode: "ink" as const, hint: "script lettering drawn as outlined calligraphic paths (no <text>), flourishes" },
  { id: "tribal", label: "Трайбл", mode: "ink" as const, hint: "tribal: flowing pointed solid black shapes" },
  { id: "traditional", label: "Traditional", mode: "color" as const, hint: "american traditional: thick black outlines, flat fills in red, yellow, green, black" },
  { id: "watercolor", label: "Акварель", mode: "color" as const, hint: "watercolor: thin black sketch lines with soft semi-transparent colour blobs (fill-opacity 0.3-0.6)" },
];

const svgPrompt = (prompt: string, style: (typeof LOCAL_STYLES)[number], aspect: number | undefined, variant: number, total: number) => {
  const w = 1024;
  const h = aspect && isFinite(aspect) ? Math.round(Math.max(0.35, Math.min(2.8, 1 / aspect)) * 1024) : 1024;
  return [
    "You are a professional tattoo artist. Draw ONE tattoo design as a standalone SVG.",
    `Subject (may be in Ukrainian): ${prompt}`,
    `Style: ${style.hint}.`,
    style.mode === "ink" ? "Use only black (#111) strokes and fills. No colour, no grey background." : "Use bold black outlines plus the style's colours.",
    `Canvas: viewBox="0 0 ${w} ${h}". Fill most of the canvas, keep 40px margin. Transparent background: no background rect.`,
    "Make it detailed and beautiful (40-200 elements), recognisable, balanced, printable as a stencil.",
    "Allowed elements: svg, g, path, circle, ellipse, line, polyline, polygon, rect. No text, no style tags, no images, no gradients, no filters, no scripts.",
    total > 1 ? `This is variant ${variant + 1} of ${total}: choose a clearly different composition from the other variants.` : "",
    "Answer with the SVG code only, starting with <svg and ending with </svg>.",
  ].filter(Boolean).join("\n");
};

const ALLOWED = new Set(["svg", "g", "path", "circle", "ellipse", "line", "polyline", "polygon", "rect"]);

/** Keep only plain vector shapes: no scripts, links, styles or external refs. */
export function sanitizeSvg(raw: string): string {
  const start = raw.indexOf("<svg");
  const end = raw.lastIndexOf("</svg>");
  if (start < 0 || end < 0) throw new Error("Claude не повернув SVG");
  const doc = new DOMParser().parseFromString(raw.slice(start, end + 6), "image/svg+xml");
  const root = doc.documentElement;
  if (root.nodeName !== "svg" || doc.querySelector("parsererror")) throw new Error("Некоректний SVG");
  const walk = (el: Element) => {
    for (const child of [...el.children]) {
      if (!ALLOWED.has(child.nodeName.toLowerCase())) child.remove();
      else walk(child);
    }
    for (const attr of [...el.attributes]) {
      const n = attr.name.toLowerCase();
      if (n.startsWith("on") || n.includes("href") || n === "style" || /url\(/i.test(attr.value)) el.removeAttribute(attr.name);
    }
  };
  walk(root);
  root.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  return new XMLSerializer().serializeToString(root);
}

export async function svgToPng(svg: string, maxSide = 1400): Promise<string> {
  const vb = /viewBox="([\d.\s-]+)"/.exec(svg)?.[1].trim().split(/\s+/).map(Number) ?? [0, 0, 1024, 1024];
  const [, , vw, vh] = vb;
  const s = maxSide / Math.max(vw, vh);
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  try {
    const img = new Image();
    await new Promise((res, rej) => ((img.onload = res), (img.onerror = () => rej(new Error("SVG не відмалювався"))), (img.src = url)));
    const c = document.createElement("canvas");
    c.width = Math.round(vw * s);
    c.height = Math.round(vh * s);
    c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL("image/png");
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function sketchWithClaude(
  prompt: string,
  styleId: string,
  variants: number,
  aspect: number | undefined,
  onImage: (dataUrl: string, i: number) => void,
  onStatus: (msg: string) => void,
): Promise<string[]> {
  const sample = await capability<SampleFn>("sample");
  if (!sample) throw new Error("Генерація через Claude доступна, коли сторінку відкрито в claude.ai");
  const style = LOCAL_STYLES.find((s) => s.id === styleId) ?? LOCAL_STYLES[0];
  onStatus("Claude малює ескіз… (зазвичай 20–60 с)");
  const errors: string[] = [];
  const results = await Promise.all(
    Array.from({ length: variants }, async (_, i) => {
      try {
        const { text } = await sample(svgPrompt(prompt, style, aspect, i, variants), { modelTier: "default", cache: false });
        const png = await svgToPng(sanitizeSvg(text));
        onImage(png, i);
        return png;
      } catch (e) {
        const err = e as { code?: string; message?: string };
        errors.push(err.code === "not_granted" ? "доступ до Claude не надано" : err.message ?? String(e));
        return null;
      }
    }),
  );
  const ok = results.filter((r): r is string => !!r);
  if (!ok.length) throw new Error(errors[0] ?? "Не вдалося згенерувати");
  return ok;
}
