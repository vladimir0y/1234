import { describe, expect, it } from "vitest";
import { crc32, readPngDpi, setPngDpi } from "../src/core/png";

// Smallest valid PNG: 1x1 transparent pixel.
const PNG_1PX = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="),
  (c) => c.charCodeAt(0),
);

describe("png", () => {
  it("crc32 matches the reference value", () => {
    expect(crc32(new TextEncoder().encode("IEND"))).toBe(0xae426082);
  });

  it("embeds and reads back DPI, replacing an existing value", () => {
    const a = setPngDpi(PNG_1PX, 300);
    expect(readPngDpi(a)).toBe(300);
    const b = setPngDpi(a, 600);
    expect(readPngDpi(b)).toBe(600);
    expect(b.length).toBe(a.length);
  });
});
