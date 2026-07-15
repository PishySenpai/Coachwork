import { build } from "esbuild";
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, cpSync } from "node:fs";

mkdirSync("dist", { recursive: true });
cpSync("public", "dist", { recursive: true });

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

// Version déployée : mêmes contenus + en-têtes PWA (manifest, icônes, service worker)
const tetePWA = `<meta name="theme-color" content="#0B0F14">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" href="/icone-192.png" type="image/png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Coachwork">
`;
writeFileSync(
  "dist/index.html",
  `<!doctype html><html lang="fr"><head><meta charset="utf-8">${tetePWA}${corps.replace('<div id="root"></div>', "</head><body><div id=\"root\"></div>")}</body></html>`
);

console.log("Build OK — artifact.html + dist/index.html");
