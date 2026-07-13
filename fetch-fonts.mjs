// Télécharge Plus Jakarta Sans (400/600/800, latin) et génère fonts.css en data URIs
import { writeFileSync } from "node:fs";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const cssUrl =
  "https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;800&display=swap";

const css = await (await fetch(cssUrl, { headers: { "User-Agent": UA } })).text();

const blocks = [...css.matchAll(/\/\* ([a-z-]+) \*\/\s*@font-face\s*\{([^}]+)\}/g)];
let out = "";
for (const [, subset, body] of blocks) {
  if (subset !== "latin") continue;
  const weight = body.match(/font-weight:\s*(\d+)/)[1];
  const url = body.match(/url\((https:[^)]+\.woff2)\)/)[1];
  const buf = Buffer.from(await (await fetch(url, { headers: { "User-Agent": UA } })).arrayBuffer());
  out += `@font-face{font-family:'Plus Jakarta Sans';font-style:normal;font-weight:${weight};font-display:swap;src:url(data:font/woff2;base64,${buf.toString("base64")}) format('woff2');}\n`;
  console.log(`latin ${weight}: ${(buf.length / 1024).toFixed(0)} Ko`);
}
if (!out) throw new Error("Aucune police récupérée");
writeFileSync("fonts.css", out);
console.log("fonts.css OK");
