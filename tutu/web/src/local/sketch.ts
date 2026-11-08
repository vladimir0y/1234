/**
 * Sketch generation in the browser-only build: Claude draws the tattoo as
 * SVG through the artifact `sample` capability (no keys, no external hosts).
 */
import { capability, type SampleFn } from "./claude";

export const LOCAL_STYLES = [
  { id: "art", label: "Художнє зображення", mode: "color" as const, hint: "a beautiful original artwork/illustration that can be tattooed. NOT a generic tattoo-flash cliché: no banners, no stock tattoo motifs unless asked. Rich composition, confident linework, considered shading" },
  { id: "art-bw", label: "Художнє, чорно-біле", mode: "ink" as const, hint: "a beautiful original black-and-grey artwork/illustration that can be tattooed, NOT a generic tattoo-flash cliché; confident linework, shading by hatching or dot density" },
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

export interface SketchOptions {
  prompt: string;
  style: string;
  variants: number;
  /** Canvas size in SVG units; matches the region's proportions. */
  width: number;
  height: number;
  /** Region outline as an SVG path in the same units: the composition fills it. */
  outline?: string;
  /** Style references from the user. */
  references?: Blob[];
}

const svgPrompt = (o: SketchOptions, style: (typeof LOCAL_STYLES)[number], variant: number) =>
  [
    "You are an illustrator designing artwork that will be tattooed on a real person. Draw ONE design as a standalone SVG.",
    `What to draw (the user's words, may be Ukrainian): ${o.prompt}`,
    `Style: ${style.hint}.`,
    o.references?.length
      ? "Attached are the user's style references: match their visual language (line quality, shading, motifs, mood) but create an original design."
      : "",
    style.mode === "ink" ? "Use only black (#111) and greys made by hatching or dots. No colour." : "Colours are allowed when they serve the image.",
    `Canvas: viewBox="0 0 ${o.width} ${o.height}". Transparent background: no background rect.`,
    o.outline
      ? `The tattoo area on the body is this shape (an SVG path in the same coordinates; it may be a band around the body unrolled flat):\n<path d="${o.outline}"/>\nCompose the artwork to fill THIS shape: main elements inside it, flowing along its form, nothing important outside it. Do not draw the outline itself.`
      : "Fill most of the canvas, keep a small margin.",
    "Make it detailed and beautiful (60-300 elements), balanced, readable at real size.",
    "Allowed elements: svg, g, path, circle, ellipse, line, polyline, polygon, rect. No text, no style tags, no images, no gradients, no filters, no scripts.",
    o.variants > 1 ? `This is variant ${variant + 1} of ${o.variants}: choose a clearly different composition.` : "",
    "Answer with the SVG code only, starting with <svg and ending with </svg>.",
  ].filter(Boolean).join("\n");

/** A text-to-image prompt for FLUX / Midjourney etc., written by Claude. */
export async function externalPrompt(o: SketchOptions): Promise<string> {
  const sample = await capability<SampleFn>("sample");
  if (!sample) throw new Error("Доступно, коли сторінку відкрито в claude.ai");
  const style = LOCAL_STYLES.find((s) => s.id === o.style) ?? LOCAL_STYLES[0];
  const ratio = `${Math.round((o.width / o.height) * 10) / 10}:1`;
  const { text } = await sample(
    [
      "Write ONE English prompt for an image generator (FLUX / Midjourney) for artwork that will later be tattooed.",
      `Idea (may be Ukrainian): ${o.prompt}`,
      `Style: ${style.hint}.`,
      o.references?.length ? "Describe the visual style of the attached reference images precisely and include it." : "",
      `Aspect ratio of the area: ${ratio} (width:height). The artwork must fill that shape edge to edge.`,
      "Plain white background, the artwork only (no body, no skin, no mockup, no frame, no text).",
      "Answer with the prompt only, one paragraph, then on a new line: --ar W:H with whole numbers.",
    ].filter(Boolean).join("\n"),
    { modelTier: "default", cache: false, images: o.references?.length ? o.references : undefined },
  );
  return text.trim();
}

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
  o: SketchOptions,
  onImage: (dataUrl: string, i: number) => void,
  onStatus: (msg: string) => void,
): Promise<string[]> {
  const sample = await capability<SampleFn>("sample");
  if (!sample) throw new Error("Генерація через Claude доступна, коли сторінку відкрито в claude.ai");
  const style = LOCAL_STYLES.find((s) => s.id === o.style) ?? LOCAL_STYLES[0];
  onStatus("Claude малює… (зазвичай 30–90 с)");
  const errors: string[] = [];
  const results = await Promise.all(
    Array.from({ length: o.variants }, async (_, i) => {
      try {
        const { text } = await sample(svgPrompt(o, style, i), { modelTier: "default", cache: false, images: o.references?.length ? o.references : undefined });
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
