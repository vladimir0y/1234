/** Access to the claude.ai artifact runtime (only present when the page runs as an Artifact). */
type Use = (name: string) => Promise<unknown>;
declare global {
  interface Window {
    claude?: { use: Use };
  }
}

const cache = new Map<string, Promise<unknown>>();

export function capability<T>(name: string): Promise<T | null> {
  if (!window.claude?.use) return Promise.resolve(null);
  if (!cache.has(name)) cache.set(name, window.claude.use(name).catch(() => null));
  return cache.get(name) as Promise<T | null>;
}

export interface SampleFn {
  (input: string, opts?: { modelTier?: "quick" | "default" | "complex"; cache?: boolean; onText?: (e: { text: string }) => void }): Promise<{ text: string; truncated: boolean }>;
}

export interface Downloads {
  save(req: { filename: string; data: Blob | ArrayBuffer | string }): Promise<unknown>;
}
