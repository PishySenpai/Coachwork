/* Ouvrir ou créer un espace (un groupe = des données isolées + un code).
   Aucune donnée n'est renvoyée ici : uniquement l'identifiant de l'espace. */

import {
  configRedis, entetes, slug, lireEspace, creerEspace, codeValide, definirCode,
  tropDEssais, noterEchec, effacerEchecs,
} from "./_commun.js";

export default async function handler(req, res) {
  entetes(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  const { url, jeton } = configRedis();
  if (!url || !jeton) return res.status(200).json({ sync: false });
  if (req.method !== "POST") return res.status(405).json({ erreur: "méthode non autorisée" });

  try {
    const { action, nom, code, nouveauCode } = req.body || {};
    if (typeof nom !== "string" || !nom.trim()) {
      return res.status(400).json({ erreur: "nom requis" });
    }
    /* un espace encore sans code s'ouvre sans rien saisir */
    const codeSaisi = typeof code === "string" ? code.trim() : "";
    if (action !== "definirCode" && action !== "ouvrir" && !codeSaisi) {
      return res.status(400).json({ erreur: "code requis" });
    }
    const id = slug(nom);
    if (!id) return res.status(400).json({ erreur: "nom invalide" });

    /* poser un code (espace encore libre) ou le remplacer (code actuel exigé) */
    if (action === "definirCode") {
      if (typeof nouveauCode !== "string" || nouveauCode.trim().length < 4) {
        return res.status(400).json({ erreur: "code trop court (4 caractères minimum)" });
      }
      if (await tropDEssais(id)) return res.status(429).json({ trop: true });
      const espace = await lireEspace(id);
      if (!espace) return res.status(404).json({ erreur: "espace inconnu" });
      if (!(await codeValide(codeSaisi, espace))) {
        await noterEchec(id);
        return res.status(401).json({ erreur: "code actuel incorrect" });
      }
      await effacerEchecs(id);
      await definirCode(id, espace, nouveauCode.trim());
      return res.status(200).json({ sync: true, id, nom: espace.nom, protege: true });
    }

    if (action === "creer") {
      if (codeSaisi.length < 4) {
        return res.status(400).json({ erreur: "code trop court (4 caractères minimum)" });
      }
      const r = await creerEspace(nom.trim(), codeSaisi);
      if (r.erreur) return res.status(409).json({ erreur: r.erreur });
      return res.status(200).json({ sync: true, id: r.id, nom: r.espace.nom, protege: true });
    }

    /* ouvrir */
    if (await tropDEssais(id)) return res.status(429).json({ trop: true });
    const espace = await lireEspace(id);
    if (!espace) return res.status(404).json({ erreur: "espace inconnu" });
    if (!(await codeValide(codeSaisi, espace))) {
      await noterEchec(id);
      return res.status(401).json({ erreur: "code incorrect" });
    }
    await effacerEchecs(id);
    return res.status(200).json({ sync: true, id, nom: espace.nom, protege: !espace.sansCode });
  } catch (err) {
    return res.status(500).json({ erreur: String(err && err.message) });
  }
}
