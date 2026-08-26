/* Partage d'un programme entre espaces, par code court.
   Le code ne donne accès qu'au programme partagé — jamais à un espace.
   L'import crée une copie indépendante chez celui qui importe. */

import { redis, garde } from "./_commun.js";

const DUREE = 60 * 60 * 24 * 30; // 30 jours
/* alphabet sans caractères qui se confondent (0/O, 1/I/L) */
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const LONGUEUR = 6;

function cleDe(code) {
  return `coachwork-partage:${String(code).toUpperCase().replace(/[^A-Z0-9]/g, "")}`;
}

function tirerCode() {
  let c = "";
  for (let i = 0; i < LONGUEUR; i++) {
    c += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  return c;
}

export default async function handler(req, res) {
  const acces = await garde(req, res);
  if (!acces) return;
  if (req.method !== "POST") return res.status(405).json({ erreur: "méthode non autorisée" });

  try {
    const { action, programme, exos, code } = req.body || {};

    if (action === "creer") {
      if (!programme || typeof programme.nom !== "string" || !Array.isArray(programme.seances)) {
        return res.status(400).json({ erreur: "programme invalide" });
      }
      if (!programme.seances.length) {
        return res.status(400).json({ erreur: "programme sans séance" });
      }
      const charge = {
        nom: String(programme.nom).slice(0, 60),
        seances: programme.seances.slice(0, 7).map((s) => ({
          nom: String(s.nom || "Séance").slice(0, 60),
          exoIds: Array.isArray(s.exoIds) ? s.exoIds.slice(0, 20).map(String) : [],
          ...(s.tabata ? { tabata: s.tabata, rounds: s.rounds || {} } : {}),
        })),
        /* les exercices maison voyagent avec, sinon le programme arrive troué */
        exos: Array.isArray(exos) ? exos.slice(0, 40) : [],
        cree: Date.now(),
      };

      let codeGenere = null;
      for (let essai = 0; essai < 6 && !codeGenere; essai++) {
        const candidat = tirerCode();
        if (!(await redis(["GET", cleDe(candidat)]))) codeGenere = candidat;
      }
      if (!codeGenere) return res.status(500).json({ erreur: "impossible de générer un code" });

      await redis(["SET", cleDe(codeGenere), JSON.stringify(charge), "EX", String(DUREE)]);
      return res.status(200).json({ sync: true, code: codeGenere, nom: charge.nom });
    }

    if (action === "lire") {
      if (typeof code !== "string" || !code.trim()) {
        return res.status(400).json({ erreur: "code requis" });
      }
      const brut = await redis(["GET", cleDe(code)]);
      if (!brut) return res.status(404).json({ erreur: "code inconnu ou expiré" });
      let charge = null;
      try { charge = JSON.parse(brut); } catch (e) {}
      if (!charge) return res.status(500).json({ erreur: "partage illisible" });
      return res.status(200).json({ sync: true, programme: charge });
    }

    return res.status(400).json({ erreur: "action inconnue" });
  } catch (err) {
    return res.status(500).json({ erreur: String(err && err.message) });
  }
}
