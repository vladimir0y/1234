import { unwrapPatches, type PatchInput } from "./core/unwrap";

self.onmessage = (e: MessageEvent<{ id: number; patches: PatchInput[] }>) => {
  const { id, patches } = e.data;
  try {
    const result = unwrapPatches(patches);
    (self as unknown as Worker).postMessage({ id, result }, [result.uv.buffer, result.triangles.buffer, result.areaRatio.buffer]);
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: (err as Error).message });
  }
};
