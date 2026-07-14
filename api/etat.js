// Synchronisation entre téléphones — stockage Upstash Redis (Vercel Marketplace).
// Sans base configurée, répond { sync: false } et l'app reste en mode local.

function configRedis() {
  return {
    url: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL,
    jeton: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN,
  };
}

async function redis(commande) {
  const { url, jeton } = configRedis();
  const r = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${jeton}`, "Content-Type": "application/json" },
    body: JSON.stringify(commande),
  });
  if (!r.ok) throw new Error(`redis ${r.status}`);
  return (await r.json()).result;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Code");
  if (req.method === "OPTIONS") return res.status(204).end();
  const { url, jeton } = configRedis();
  if (!url || !jeton) return res.status(200).json({ sync: false });

  /* Code d'accès : si COACHWORK_CODE est défini, toute requête doit le fournir */
  const codeAttendu = process.env.COACHWORK_CODE;
  if (codeAttendu && (req.headers || {})["x-code"] !== codeAttendu) {
    return res.status(401).json({ codeRequis: true });
  }

  try {
    if (req.method === "GET") {
      const plat = (await redis(["HGETALL", "coachwork"])) || [];
      const etat = {};
      for (let i = 0; i < plat.length; i += 2) {
        try { etat[plat[i]] = JSON.parse(plat[i + 1]); } catch (e) {}
      }
      return res.status(200).json({ sync: true, etat });
    }

    if (req.method === "POST") {
      const { entrees } = req.body || {};
      if (!Array.isArray(entrees)) return res.status(400).json({ erreur: "entrees manquantes" });
      // Dernier écrit gagne, clé par clé (horodatage client)
      for (const e of entrees.slice(0, 100)) {
        if (typeof e.cle !== "string" || typeof e.t !== "number") continue;
        const brut = await redis(["HGET", "coachwork", e.cle]);
        let actuel = null;
        try { actuel = brut ? JSON.parse(brut) : null; } catch (err) {}
        if (!actuel || actuel.t < e.t) {
          await redis(["HSET", "coachwork", e.cle, JSON.stringify({ v: e.v, t: e.t })]);
        }
      }
      return res.status(200).json({ sync: true });
    }

    return res.status(405).json({ erreur: "méthode non autorisée" });
  } catch (err) {
    return res.status(500).json({ erreur: String(err && err.message) });
  }
}
