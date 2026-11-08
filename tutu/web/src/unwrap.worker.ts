import { unwrapPatches, type PatchInput } from "./core/unwrap";

self.onmessage = (e: MessageEvent<{ id: number; patches: PatchInput[]; up?: [number, number, number] }>) => {
  const { id, patches, up } = e.data;
  try {
    const result = unwrapPatches(patches, up);
    (self as unknown as Worker).postMessage({ id, result }, [result.uv.buffer, result.triangles.buffer, result.areaRatio.buffer, result.source.buffer]);
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: (err as Error).message });
  }
};
