/* Utilitaires partagés des fonctions API (fichier _ : non exposé) */

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

/* Pose les en-têtes CORS ; renvoie true si la requête est déjà réglée
   (préflight OPTIONS, base absente ou code d'accès refusé). */
export function garde(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Code");
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return true;
  }
  const { url, jeton } = configRedis();
  if (!url || !jeton) {
    res.status(200).json({ sync: false });
    return true;
  }
  const codeAttendu = process.env.COACHWORK_CODE;
  if (codeAttendu && (req.headers || {})["x-code"] !== codeAttendu) {
    res.status(401).json({ codeRequis: true });
    return true;
  }
  return false;
}
