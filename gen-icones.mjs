// Génère les icônes PWA (PNG) : fond sombre + haltère lime, sans dépendance
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";

/* --- encodeur PNG minimal (RGBA 8 bits) --- */
const TABLE_CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const o of buf) c = TABLE_CRC[(c ^ o) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, donnees) {
  const t = Buffer.from(type, "ascii");
  const long = Buffer.alloc(4);
  long.writeUInt32BE(donnees.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, donnees])));
  return Buffer.concat([long, t, donnees, crc]);
}
function png(largeur, hauteur, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(largeur, 0);
  ihdr.writeUInt32BE(hauteur, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8 bits, RGBA
  const lignes = Buffer.alloc((largeur * 4 + 1) * hauteur);
  for (let y = 0; y < hauteur; y++) {
    lignes[y * (largeur * 4 + 1)] = 0; // filtre none
    rgba.copy(lignes, y * (largeur * 4 + 1) + 1, y * largeur * 4, (y + 1) * largeur * 4);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(lignes, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/* --- dessin : distance signée à un rectangle arrondi --- */
function dansRectArrondi(px, py, cx, cy, w, h, r) {
  const dx = Math.abs(px - cx) - (w / 2 - r);
  const dy = Math.abs(py - cy) - (h / 2 - r);
  const ex = Math.max(dx, 0);
  const ey = Math.max(dy, 0);
  return Math.sqrt(ex * ex + ey * ey) + Math.min(Math.max(dx, dy), 0) - r <= 0;
}

const FOND = [11, 15, 20];
const LIME = [163, 230, 53];

function dessiner(taille, echelleMotif) {
  const rgba = Buffer.alloc(taille * taille * 4);
  const s = (taille / 512) * echelleMotif;
  const c = taille / 2;
  // haltère : barre + 2 plaques intérieures + 2 plaques extérieures
  const formes = [
    [c, c, 210 * s, 36 * s, 18 * s],
    [c - 118 * s, c, 44 * s, 156 * s, 22 * s],
    [c + 118 * s, c, 44 * s, 156 * s, 22 * s],
    [c - 162 * s, c, 34 * s, 112 * s, 17 * s],
    [c + 162 * s, c, 34 * s, 112 * s, 17 * s],
  ];
  for (let y = 0; y < taille; y++) {
    for (let x = 0; x < taille; x++) {
      const i = (y * taille + x) * 4;
      let couleur = FOND;
      for (const [fx, fy, w, h, r] of formes) {
        if (dansRectArrondi(x + 0.5, y + 0.5, fx, fy, w, h, r)) { couleur = LIME; break; }
      }
      rgba[i] = couleur[0]; rgba[i + 1] = couleur[1]; rgba[i + 2] = couleur[2]; rgba[i + 3] = 255;
    }
  }
  return png(taille, taille, rgba);
}

writeFileSync("public/icone-512.png", dessiner(512, 1));
writeFileSync("public/icone-maskable.png", dessiner(512, 0.68));
writeFileSync("public/icone-192.png", dessiner(192, 1));
writeFileSync("public/apple-touch-icon.png", dessiner(180, 0.9));
console.log("Icônes générées dans public/");
