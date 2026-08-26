/* Utilitaires partagés des fonctions API (fichier _ : non exposé) */

import crypto from "node:crypto";

export function configRedis() {
  return {
    url: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL,
    jeton: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN,
  };
}

export async function redis(commande) {
  const { url, jeton } = configRedis();
  const r = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${jeton}`, "Content-Type": "application/json" },
    body: JSON.stringify(commande),
  });
  if (!r.ok) throw new Error(`redis ${r.status}`);
  return (await r.json()).result;
}

/* ------------------------------------------------------------------ */
/* Espaces : un groupe = un jeu de données isolé + un code partagé      */
/* ------------------------------------------------------------------ */

const REGISTRE = "coachwork-espaces";
/* l'espace d'origine garde son ancienne clé de données : rien à migrer */
export const ESPACE_LEGACY = "principal";
const CLE_LEGACY = "coachwork";

export function slug(nom) {
  return String(nom || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

/* scrypt : lent à dessein, pour qu'un code court reste coûteux à forcer */
function derive(code, sel) {
  return new Promise((res, rej) => {
    crypto.scrypt(String(code), sel, 32, (e, cle) => (e ? rej(e) : res(cle.toString("hex"))));
  });
}

export async function hacherCode(code) {
  const sel = crypto.randomBytes(16).toString("hex");
  return { sel, hash: await derive(code, sel) };
}

export async function codeValide(code, espace) {
  if (!espace) return false;
  /* espace jamais protégé (cas historique) : accès libre, comme avant */
  if (espace.sansCode) return true;
  if (!espace.sel || !espace.hash) return false;
  const candidat = await derive(code, espace.sel);
  const a = Buffer.from(candidat, "hex");
  const b = Buffer.from(espace.hash, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export async function lireEspace(id) {
  const brut = await redis(["HGET", REGISTRE, id]);
  if (brut) {
    try {
      return JSON.parse(brut);
    } catch (e) {
      return null;
    }
  }
  /* Premier passage : on adopte l'espace d'origine, avec ses données déjà en
     place. S'il n'y avait pas de code jusqu'ici, on n'en invente pas — l'app
     reste accessible comme avant, et le code se pose depuis l'app. */
  if (id === ESPACE_LEGACY) {
    const codeEnv = process.env.COACHWORK_CODE;
    const base = { nom: "Principal", cle: CLE_LEGACY, cree: Date.now() };
    const espace = codeEnv
      ? { ...base, ...(await hacherCode(codeEnv)) }
      : { ...base, sansCode: true };
    await redis(["HSET", REGISTRE, id, JSON.stringify(espace)]);
    return espace;
  }
  return null;
}

/* Pose ou remplace le code d'un espace (le code actuel a déjà été vérifié) */
export async function definirCode(id, espace, nouveauCode) {
  const { sel, hash } = await hacherCode(nouveauCode);
  const maj = { ...espace, sel, hash };
  delete maj.sansCode;
  await redis(["HSET", REGISTRE, id, JSON.stringify(maj)]);
  return maj;
}

export async function creerEspace(nom, code) {
  const id = slug(nom);
  if (!id) return { erreur: "nom invalide" };
  if (await lireEspace(id)) return { erreur: "nom déjà pris" };
  const { sel, hash } = await hacherCode(code);
  const espace = { nom: String(nom).slice(0, 40), cle: `coachwork:${id}`, sel, hash, cree: Date.now() };
  await redis(["HSET", REGISTRE, id, JSON.stringify(espace)]);
  return { id, espace };
}

/* Anti-force brute : quelques essais ratés et l'espace se ferme un moment */
const MAX_ESSAIS = 10;
const FENETRE = 900; // secondes

export async function tropDEssais(id) {
  const n = parseInt(await redis(["GET", `coachwork-essais:${id}`]), 10);
  return Number.isFinite(n) && n >= MAX_ESSAIS;
}

export async function noterEchec(id) {
  const cle = `coachwork-essais:${id}`;
  const n = await redis(["INCR", cle]);
  if (Number(n) === 1) await redis(["EXPIRE", cle, String(FENETRE)]);
}

export async function effacerEchecs(id) {
  await redis(["DEL", `coachwork-essais:${id}`]);
}

/* ------------------------------------------------------------------ */
/* Garde commune : CORS, base configurée, espace + code valides         */
/* Renvoie null si la requête est déjà réglée, sinon { id, espace }.    */
/* ------------------------------------------------------------------ */

export function entetes(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Code, X-Espace");
}

export async function garde(req, res) {
  entetes(res);
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return null;
  }
  const { url, jeton } = configRedis();
  if (!url || !jeton) {
    res.status(200).json({ sync: false });
    return null;
  }
  const h = req.headers || {};
  /* sans en-tête d'espace : ancienne app installée → espace d'origine */
  const id = slug(h["x-espace"]) || ESPACE_LEGACY;
  const code = h["x-code"];

  if (await tropDEssais(id)) {
    res.status(429).json({ trop: true });
    return null;
  }
  const espace = await lireEspace(id);
  if (!espace) {
    res.status(401).json({ codeRequis: true, inconnu: true });
    return null;
  }
  if (!(await codeValide(code, espace))) {
    await noterEchec(id);
    res.status(401).json({ codeRequis: true });
    return null;
  }
  await effacerEchecs(id);
  return { id, espace };
}
