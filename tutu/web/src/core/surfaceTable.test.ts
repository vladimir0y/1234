import { describe, expect, it } from "vitest";
import { surfacePerimeter, surfaceTable, surfaceUV } from "./groupUnwrap";

// Distance from the centre to an ellipse (half-axes a sideways, b front-back) at polar angle t.
const polar = (a: number, b: number, t: number) => (a * b) / Math.hypot(b * Math.sin(t), a * Math.cos(t));

// An elliptical "torso": 36 x 22 cm, 40 cm tall, sampled like mesh vertices.
function ellipse(a = 0.18, b = 0.11) {
  const s: Array<[number, number, number]> = [];
  for (let h = 0; h <= 0.4; h += 0.01)
    for (let k = 0; k < 360; k++) {
      const t = (k / 360) * 2 * Math.PI;
      s.push([h, t, polar(a, b, t)]);
    }
  return s;
}

describe("surface (skin arc length) mapping", () => {
  const tab = surfaceTable(ellipse());
  it("goes round the body once in its real perimeter", () => {
    const a = 0.18, b = 0.11; // Ramanujan's ellipse perimeter
    const p = Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b)));
    expect(surfacePerimeter(tab, 0.2)).toBeCloseTo(p, 2);
  });
  it("keeps equal steps on the skin equal on the canvas (flat back vs narrow side)", () => {
    // Points 1 cm apart on the skin: the broad face (t ~ 0) and the narrow side (t ~ pi/2).
    const step = (t: number) => {
      // local skin length per radian = sqrt(r^2 + (dr/dt)^2)
      const e = 1e-4, r = polar(0.18, 0.11, t), dr = (polar(0.18, 0.11, t + e) - r) / e;
      const dt = 0.01 / Math.hypot(r, dr);
      return surfaceUV(tab, 0.2, t + dt)[0] - surfaceUV(tab, 0.2, t)[0];
    };
    expect(step(0.05)).toBeCloseTo(0.01, 3);
    expect(step(Math.PI / 2)).toBeCloseTo(0.01, 2);
  });
  it("measures height along the axis on a straight wall", () => {
    expect(surfaceUV(tab, 0.3, 1)[1] - surfaceUV(tab, 0.1, 1)[1]).toBeCloseTo(0.2, 3);
  });
});
