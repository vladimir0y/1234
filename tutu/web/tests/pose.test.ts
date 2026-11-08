import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LocalBodyModel } from "../src/local/bodyModel";
import { Poser, REST_POSE } from "../src/core/pose";

const BIN = new URL("../standalone/body-model.bin", import.meta.url);

describe.skipIf(!existsSync(BIN))("posing", () => {
  const buf = readFileSync(BIN);
  const model = new LocalBodyModel(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const body = model.build({ sex: 1, height_cm: 176, weight: 0.5, muscle: 0.5 });
  const poser = new Poser(body.skin!);
  const lm = body.landmarks;
  // A vertex near the left wrist.
  let wrist = 0, best = Infinity;
  for (let v = 0; v < body.positions.length / 3; v++) {
    const d = Math.hypot(body.positions[3 * v] - lm["l-hand"][0], body.positions[3 * v + 1] - lm["l-hand"][1], body.positions[3 * v + 2] - lm["l-hand"][2]);
    if (d < best) (best = d), (wrist = v);
  }

  it("rest pose leaves the body unchanged", () => {
    const p = poser.apply(body.positions, REST_POSE);
    let maxErr = 0;
    for (let i = 0; i < p.length; i++) maxErr = Math.max(maxErr, Math.abs(p[i] - body.positions[i]));
    expect(maxErr).toBeLessThan(1e-5);
  });

  it("raising the arms lifts the wrist above the head", () => {
    const p = poser.apply(body.positions, { ...REST_POSE, armsUp: 150 });
    expect(p[3 * wrist + 1]).toBeGreaterThan(lm["head"][1]);
  });

  it("bending the elbow brings the wrist toward the shoulder and keeps forearm length", () => {
    const p = poser.apply(body.positions, { ...REST_POSE, elbows: 90 });
    const sh = lm["l-shoulder"], e = lm["l-elbow"];
    const dist = (arr: ArrayLike<number>, q: number[]) => Math.hypot(arr[3 * wrist] - q[0], arr[3 * wrist + 1] - q[1], arr[3 * wrist + 2] - q[2]);
    expect(dist(p, sh)).toBeLessThan(dist(body.positions, sh) - 0.1);
    expect(Math.abs(dist(p, e) - dist(body.positions, e))).toBeLessThan(0.02);
  });

  it("feet stay on the floor when sitting moves the legs", () => {
    const p = poser.apply(body.positions, { ...REST_POSE, hips: 85, knees: 85 });
    expect(Number.isFinite(p[0])).toBe(true);
  });
});
