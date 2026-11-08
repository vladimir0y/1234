// Builds the browser-only editor for publishing as a claude.ai Artifact:
// dist-artifact/tutu.html (page content, CSS inlined) + assets/* + body-model.bin
import { execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";

const out = "dist-artifact";
if (!existsSync("standalone/body-model.bin")) {
  console.error("standalone/body-model.bin is missing: run python server/scripts/export_body_bin.py");
  process.exit(1);
}
execSync("npx vite build --outDir dist-standalone --base ./ --emptyOutDir", {
  stdio: "inherit",
  env: { ...process.env, VITE_STANDALONE: "1" },
});
rmSync(out, { recursive: true, force: true });
mkdirSync(out);
cpSync("dist-standalone/assets", `${out}/assets`, { recursive: true });
cpSync("standalone/body-model.bin", `${out}/body-model.wasm`); // artifact hosts serve .wasm, not .bin

const html = readFileSync("dist-standalone/index.html", "utf8");
const title = /<title>(.*?)<\/title>/s.exec(html)[1];
const css = [...html.matchAll(/<link rel="stylesheet"[^>]*href="\.\/(assets\/[^"]+\.css)"[^>]*>/g)].map((m) =>
  readFileSync(`dist-standalone/${m[1]}`, "utf8"),
);
const scripts = [...html.matchAll(/<script type="module"[^>]*src="\.\/(assets\/[^"]+\.js)"[^>]*><\/script>/g)].map((m) => m[1]);
const body = /<body>([\s\S]*)<\/body>/.exec(html)[1].replace(/<script[^>]*><\/script>/g, "");
// The Artifact host wraps this in its own <html>/<head>/<body> skeleton.
const page = `<title>Tutu</title>
<meta name="description" content="${title}">
<style>${css.join("\n")}</style>
${body}
${scripts.map((s) => `<script type="module" src="./${s}"></script>`).join("\n")}
`;
writeFileSync(`${out}/tutu.html`, page);
for (const f of readdirSync(`${out}/assets`)) for (const ext of [".css"]) if (f.endsWith(ext)) rmSync(`${out}/assets/${f}`);
console.log("files:", readdirSync(`${out}/assets`), "page bytes:", page.length);
