/* Planifie la notification de fin de repos : la fonction attend l'heure de
   fin puis envoie un Web Push — l'app peut être en arrière-plan ou fermée.
   Un jeton par appareil (clé Redis) permet d'annuler ou de remplacer un
   repos en cours : seul le dernier jeton envoie. */

import webpush from "web-push";
import { redis, garde } from "./_commun.js";
import { clesVapid } from "./push-cle.js";

const ATTENTE_MAX = 280000; // marge sous la limite de 300 s

function hach(texte) {
  let h = 5381;
  for (let i = 0; i < texte.length; i++) h = ((h << 5) + h + texte.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

export default async function handler(req, res) {
  if (garde(req, res)) return;
  if (req.method !== "POST") return res.status(405).json({ erreur: "méthode non autorisée" });

  try {
    const { abonnement, annuler, jeton, finA, titre, corps } = req.body || {};
    if (!abonnement || !abonnement.endpoint || typeof jeton !== "string") {
      return res.status(400).json({ erreur: "abonnement ou jeton manquant" });
    }
    const cle = `coachwork-repos:${hach(abonnement.endpoint)}`;

    /* Le dernier écrit gagne : annulation ou remplacement du repos en cours */
    await redis(["SET", cle, jeton, "EX", "900"]);
    if (annuler) return res.status(200).json({ envoye: false, annule: true });

    if (typeof finA !== "number") return res.status(400).json({ erreur: "finA manquant" });
    const attente = Math.max(0, Math.min(ATTENTE_MAX, finA - Date.now()));
    await dormir(attente);

    const actuel = await redis(["GET", cle]);
    if (actuel !== jeton) return res.status(200).json({ envoye: false, remplace: true });

    const { publique, privee } = await clesVapid();
    webpush.setVapidDetails("mailto:coachwork@vercel.app", publique, privee);
    await webpush.sendNotification(
      abonnement,
      JSON.stringify({ titre: titre || "Repos terminé — à toi !", corps: corps || "" }),
      { TTL: 120 }
    );
    return res.status(200).json({ envoye: true });
  } catch (err) {
    /* abonnement expiré (410) ou autre : sans gravité, l'app a aussi sa notification locale */
    return res.status(200).json({ envoye: false, erreur: String(err && err.message) });
  }
}
