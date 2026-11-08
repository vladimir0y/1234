import { defineConfig } from "vite";

export default defineConfig({
  server: {
    host: true,
    proxy: { "/api": "http://127.0.0.1:8000" },
  },
  // No source maps in production: the shipped JS stays minified only.
  build: { chunkSizeWarningLimit: 1500, sourcemap: false },
});
