// Synchronisation entre téléphones — stockage Upstash Redis (Vercel Marketplace).
// Chaque espace a son propre jeu de données ; sans base configurée, répond
// { sync: false } et l'app reste en mode local.

import { redis, garde } from "./_commun.js";

export default async function handler(req, res) {
  const acces = await garde(req, res);
  if (!acces) return; // réponse déjà envoyée (préflight, pas de base, code refusé)
  const cle = acces.espace.cle;

  try {
    if (req.method === "GET") {
      const plat = (await redis(["HGETALL", cle])) || [];
      const etat = {};
      for (let i = 0; i < plat.length; i += 2) {
        try { etat[plat[i]] = JSON.parse(plat[i + 1]); } catch (e) {}
      }
      return res.status(200).json({ sync: true, espace: acces.id, nom: acces.espace.nom, protege: !acces.espace.sansCode, etat });
    }

    if (req.method === "POST") {
      const { entrees } = req.body || {};
      if (!Array.isArray(entrees)) return res.status(400).json({ erreur: "entrees manquantes" });
      // Dernier écrit gagne, clé par clé (horodatage client)
      for (const e of entrees.slice(0, 100)) {
        if (typeof e.cle !== "string" || typeof e.t !== "number") continue;
        const brut = await redis(["HGET", cle, e.cle]);
        let actuel = null;
        try { actuel = brut ? JSON.parse(brut) : null; } catch (err) {}
        if (!actuel || actuel.t < e.t) {
          await redis(["HSET", cle, e.cle, JSON.stringify({ v: e.v, t: e.t })]);
        }
      }
      return res.status(200).json({ sync: true });
    }

    return res.status(405).json({ erreur: "méthode non autorisée" });
  } catch (err) {
    return res.status(500).json({ erreur: String(err && err.message) });
  }
}
