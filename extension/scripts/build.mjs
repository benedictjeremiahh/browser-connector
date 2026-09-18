import { build } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";

await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });
await build({
  entryPoints: {
    "service-worker": "src/service-worker.ts",
    panel: "src/panel.ts"
  },
  outdir: "dist",
  bundle: true,
  format: "iife",
  target: "chrome130",
  sourcemap: true,
  minify: false
});
for (const file of ["manifest.json", "panel.html", "panel.css"]) {
  await cp(`public/${file}`, `dist/${file}`);
}
await cp("public/icons", "dist/icons", { recursive: true });

