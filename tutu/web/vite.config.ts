import { cpSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vite";

const examples = resolve(__dirname, "standalone/examples");

export default defineConfig({
  server: {
    host: true,
    proxy: { "/api": "http://127.0.0.1:8000" },
  },
  // No source maps in production: the shipped JS stays minified only.
  build: { chunkSizeWarningLimit: 1500, sourcemap: false },
  plugins: [
    {
      // Ship the example projects with the server build too.
      name: "tutu-examples",
      apply: "build",
      writeBundle(options) {
        if (existsSync(examples) && options.dir) cpSync(examples, resolve(options.dir, "examples"), { recursive: true });
      },
    },
  ],
});
