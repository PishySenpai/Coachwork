/* Clé publique VAPID pour l'abonnement Web Push.
   La paire de clés est générée au premier appel et conservée dans Redis. */

import webpush from "web-push";
import { redis, garde } from "./_commun.js";

export async function clesVapid() {
  const brut = await redis(["GET", "coachwork-vapid"]);
  if (brut) return JSON.parse(brut);
  const paire = webpush.generateVAPIDKeys();
  const cles = { publique: paire.publicKey, privee: paire.privateKey };
  await redis(["SET", "coachwork-vapid", JSON.stringify(cles)]);
  return cles;
}

export default async function handler(req, res) {
  if (garde(req, res)) return;
  try {
    const { publique } = await clesVapid();
    return res.status(200).json({ cle: publique });
  } catch (err) {
    return res.status(500).json({ erreur: String(err && err.message) });
  }
}
