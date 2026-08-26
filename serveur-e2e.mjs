// Serveur local de bout en bout : dist/ + /api/* avec un Redis simulé.
// Fichier de test, non déployé. Usage : node serveur-e2e.mjs
import http from "node:http";
import { readFileSync } from "node:fs";

process.env.UPSTASH_REDIS_REST_URL = "https://redis.simule";
process.env.UPSTASH_REDIS_REST_TOKEN = "jeton";
/* volontairement PAS de COACHWORK_CODE : on reproduit le déploiement réel */

const kv = new Map();
const hashes = new Map();
const vraiFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  if (!String(url).startsWith("https://redis.simule")) return vraiFetch(url, opts);
  const [cmd, a, b, d] = JSON.parse(opts.body);
  const h = (k) => { if (!hashes.has(k)) hashes.set(k, new Map()); return hashes.get(k); };
  let result = null;
  if (cmd === "GET") result = kv.get(a) ?? null;
  else if (cmd === "SET") { kv.set(a, b); result = "OK"; }
  else if (cmd === "DEL") { kv.delete(a); result = 1; }
  else if (cmd === "INCR") { const n = (parseInt(kv.get(a), 10) || 0) + 1; kv.set(a, String(n)); result = n; }
  else if (cmd === "EXPIRE") result = 1;
  else if (cmd === "HGET") result = h(a).get(b) ?? null;
  else if (cmd === "HSET") { h(a).set(b, d); result = 1; }
  else if (cmd === "HGETALL") result = [...h(a).entries()].flat();
  return { ok: true, json: async () => ({ result }) };
};

/* données déjà en place dans l'espace d'origine */
hashes.set("coachwork", new Map([
  ["esteban:charges", JSON.stringify({ v: { presse: "50" }, t: 1 })],
]));

const routes = {
  "/api/etat": (await import("./api/etat.js")).default,
  "/api/espace": (await import("./api/espace.js")).default,
  "/api/push-cle": (await import("./api/push-cle.js")).default,
};

http
  .createServer(async (req, res) => {
    const chemin = req.url.split("?")[0];
    const handler = routes[chemin];
    if (handler) {
      let corps = "";
      for await (const c of req) corps += c;
      try { req.body = corps ? JSON.parse(corps) : {}; } catch (e) { req.body = {}; }
      res.status = (c) => { res.statusCode = c; return res; };
      res.json = (j) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(j)); return res; };
      try { await handler(req, res); } catch (e) { res.statusCode = 500; res.end(String(e)); }
      return;
    }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end(readFileSync("dist/index.html"));
  })
  .listen(4531, () => console.log("e2e prêt sur http://localhost:4531"));
