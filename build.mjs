import { build } from "esbuild";
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

mkdirSync("dist", { recursive: true });

// 1. Bundle React
await build({
  entryPoints: ["entry.jsx"],
  bundle: true,
  minify: true,
  format: "iife",
  outfile: "dist/bundle.js",
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' },
});

// 2. CSS Tailwind
execSync("npx tailwindcss -i input.css -o dist/tw.css --minify", { stdio: "inherit" });

// 3. Assemblage
const js = readFileSync("dist/bundle.js", "utf8").replaceAll("</script", "<\\/script");
const css = readFileSync("fonts.css", "utf8") + readFileSync("dist/tw.css", "utf8");

const corps = `<title>Coachwork — Programme duo</title>
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<style>${css}</style>
<div id="root"></div>
<script>${js}</script>
`;

// Artefact : contenu de page seul (le squelette doctype/head/body est ajouté à la publication)
writeFileSync("artifact.html", corps);

// Version locale autonome pour vérification
writeFileSync(
  "dist/index.html",
  `<!doctype html><html lang="fr"><head><meta charset="utf-8">${corps.replace('<div id="root"></div>', "</head><body><div id=\"root\"></div>")}</body></html>`
);

console.log("Build OK — artifact.html + dist/index.html");
