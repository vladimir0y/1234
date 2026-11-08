import { buildBody, type BodyParams } from "./core/bodyModels";

self.onmessage = (e: MessageEvent<{ id: number; params: BodyParams }>) => {
  const { id, params } = e.data;
  try {
    const mesh = buildBody(params);
    (self as unknown as Worker).postMessage({ id, mesh }, [mesh.positions.buffer, mesh.indices.buffer]);
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: (err as Error).message });
  }
};
