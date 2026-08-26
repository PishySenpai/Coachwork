/* Ouvrir ou créer un espace (un groupe = des données isolées + un code).
   Aucune donnée n'est renvoyée ici : uniquement l'identifiant de l'espace. */

import {
  configRedis, entetes, slug, lireEspace, creerEspace, codeValide,
  tropDEssais, noterEchec, effacerEchecs,
} from "./_commun.js";

export default async function handler(req, res) {
  entetes(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  const { url, jeton } = configRedis();
  if (!url || !jeton) return res.status(200).json({ sync: false });
  if (req.method !== "POST") return res.status(405).json({ erreur: "méthode non autorisée" });

  try {
    const { action, nom, code } = req.body || {};
    if (typeof nom !== "string" || typeof code !== "string" || !nom.trim() || !code.trim()) {
      return res.status(400).json({ erreur: "nom et code requis" });
    }
    const id = slug(nom);
    if (!id) return res.status(400).json({ erreur: "nom invalide" });

    if (action === "creer") {
      if (code.trim().length < 4) {
        return res.status(400).json({ erreur: "code trop court (4 caractères minimum)" });
      }
      const r = await creerEspace(nom.trim(), code.trim());
      if (r.erreur) return res.status(409).json({ erreur: r.erreur });
      return res.status(200).json({ sync: true, id: r.id, nom: r.espace.nom });
    }

    /* ouvrir */
    if (await tropDEssais(id)) return res.status(429).json({ trop: true });
    const espace = await lireEspace(id);
    if (!espace) return res.status(404).json({ erreur: "espace inconnu" });
    if (!(await codeValide(code.trim(), espace))) {
      await noterEchec(id);
      return res.status(401).json({ erreur: "code incorrect" });
    }
    await effacerEchecs(id);
    return res.status(200).json({ sync: true, id, nom: espace.nom });
  } catch (err) {
    return res.status(500).json({ erreur: String(err && err.message) });
  }
}
