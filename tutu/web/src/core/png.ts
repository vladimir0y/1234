/** PNG helpers: embed physical DPI (pHYs chunk) so prints come out 1:1. */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Insert (or replace) a pHYs chunk right after IHDR. */
export function setPngDpi(png: Uint8Array, dpi: number): Uint8Array {
  const ppm = Math.round(dpi / 0.0254);
  const chunk = new Uint8Array(4 + 4 + 9 + 4);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, 9);
  chunk.set([0x70, 0x48, 0x59, 0x73], 4); // "pHYs"
  view.setUint32(8, ppm);
  view.setUint32(12, ppm);
  chunk[16] = 1; // unit: metre
  view.setUint32(17, crc32(chunk.subarray(4, 17)));

  // Walk chunks; drop an existing pHYs, insert ours after IHDR.
  const parts: Uint8Array[] = [png.subarray(0, 8)];
  let off = 8;
  const pv = new DataView(png.buffer, png.byteOffset, png.byteLength);
  while (off < png.length) {
    const len = pv.getUint32(off);
    const type = String.fromCharCode(...png.subarray(off + 4, off + 8));
    const end = off + 12 + len;
    if (type !== "pHYs") parts.push(png.subarray(off, end));
    if (type === "IHDR") parts.push(chunk);
    off = end;
  }
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function readPngDpi(png: Uint8Array): number | null {
  const pv = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let off = 8;
  while (off < png.length) {
    const len = pv.getUint32(off);
    const type = String.fromCharCode(...png.subarray(off + 4, off + 8));
    if (type === "pHYs" && png[off + 16] === 1) return Math.round(pv.getUint32(off + 8) * 0.0254);
    off += 12 + len;
  }
  return null;
}
