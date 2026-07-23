import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Dumbbell, Check, ChevronLeft, ChevronDown, Flame, Timer, HeartPulse,
  Wind, Leaf, Moon, ShieldCheck, Sparkles, TrendingUp, X, Plus, Salad,
  Stethoscope, Scale, Ruler, Cloud, CloudOff, Pencil, Trash2, Search,
  ChevronUp, Copy, SquarePen, ArrowLeftRight, Play, Pause,
} from "lucide-react";

/* ------------------------------------------------------------------ */
/* Persistance locale : window.storage → IndexedDB → mémoire           */
/* ------------------------------------------------------------------ */

const mem = new Map();
let idbP = null;

function ouvrirIDB() {
  if (!idbP) {
    idbP = new Promise((res, rej) => {
      const req = indexedDB.open("coachwork", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("kv");
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
  }
  return idbP;
}

function idbLire(cle) {
  return ouvrirIDB().then(
    (db) =>
      new Promise((res, rej) => {
        const r = db.transaction("kv", "readonly").objectStore("kv").get(cle);
        r.onsuccess = () => res(r.result == null ? null : r.result);
        r.onerror = () => rej(r.error);
      })
  );
}

function idbEcrire(cle, val) {
  return ouvrirIDB().then(
    (db) =>
      new Promise((res, rej) => {
        const tx = db.transaction("kv", "readwrite");
        tx.objectStore("kv").put(val, cle);
        tx.oncomplete = () => res();
        tx.onerror = () => rej(tx.error);
      })
  );
}

async function lire(cle) {
  try {
    const s = typeof window !== "undefined" ? window.storage : null;
    const fn = s && (s.getItem || s.get);
    if (typeof fn === "function") {
      const r = await fn.call(s, cle);
      const v = r != null && typeof r === "object" && "value" in r ? r.value : r;
      return v == null ? null : JSON.parse(v);
    }
  } catch (e) {}
  try {
    const v = await idbLire(cle);
    return v == null ? null : JSON.parse(v);
  } catch (e) {}
  return mem.has(cle) ? JSON.parse(mem.get(cle)) : null;
}

async function ecrireBrut(cle, valeur) {
  const v = JSON.stringify(valeur);
  mem.set(cle, v);
  try {
    const s = typeof window !== "undefined" ? window.storage : null;
    const fn = s && (s.setItem || s.set);
    if (typeof fn === "function") {
      await fn.call(s, cle, v);
      return;
    }
  } catch (e) {}
  try {
    await idbEcrire(cle, v);
  } catch (e) {}
}

/* ------------------------------------------------------------------ */
/* Synchronisation entre téléphones (API Vercel, si configurée)        */
/* Chaque clé porte un horodatage : le dernier écrit gagne.            */
/* ------------------------------------------------------------------ */

const API_SYNC = "/api/etat";
/* Clés propres à l'appareil : jamais synchronisées */
const CLES_LOCALES = new Set(["app:profil", "app:horodatages", "app:code"]);

let horodatages = {};
let syncDisponible = false;
let codeApp = null; // code d'accès, gardé sur l'appareil uniquement
const enAttente = new Map();
let minuteriePoussee = null;

function entetesSync(avecJson) {
  const h = {};
  if (avecJson) h["Content-Type"] = "application/json";
  if (codeApp) h["X-Code"] = codeApp;
  return h;
}

function programmerPoussee() {
  if (minuteriePoussee) return;
  minuteriePoussee = setTimeout(async () => {
    minuteriePoussee = null;
    if (!enAttente.size) return;
    const entrees = [...enAttente.values()];
    enAttente.clear();
    try {
      const r = await fetch(API_SYNC, {
        method: "POST",
        headers: entetesSync(true),
        body: JSON.stringify({ entrees }),
      });
      if (!r.ok) throw new Error("poussée refusée");
    } catch (e) {
      /* on remet en file, réessayé à la prochaine écriture ou au prochain cycle */
      for (const en of entrees) {
        const existante = enAttente.get(en.cle);
        if (!existante || existante.t < en.t) enAttente.set(en.cle, en);
      }
    }
  }, 800);
}

async function ecrire(cle, valeur) {
  await ecrireBrut(cle, valeur);
  if (CLES_LOCALES.has(cle)) return;
  const t = Date.now();
  horodatages[cle] = t;
  ecrireBrut("app:horodatages", horodatages);
  if (syncDisponible) {
    enAttente.set(cle, { cle, v: valeur, t });
    programmerPoussee();
  }
}

/* Récupère l'état distant et adopte les clés plus récentes.
   Retourne "code" (code d'accès requis), "off" (pas de base),
   "maj" (des données ont été adoptées) ou "ok". */
async function tirerDepuisServeur() {
  const r = await fetch(API_SYNC, { signal: AbortSignal.timeout(6000), headers: entetesSync(false) });
  if (r.status === 401) return "code";
  if (!r.ok) throw new Error("api indisponible");
  const j = await r.json();
  if (!j.sync) return "off";
  syncDisponible = true;
  let adopte = false;
  const aPousser = [];
  const distant = j.etat || {};
  for (const [cle, val] of Object.entries(distant)) {
    if (CLES_LOCALES.has(cle) || !val || typeof val.t !== "number") continue;
    if ((horodatages[cle] || 0) < val.t) {
      await ecrireBrut(cle, val.v);
      horodatages[cle] = val.t;
      adopte = true;
    }
  }
  /* clés locales plus récentes que le serveur : on les pousse */
  for (const [cle, t] of Object.entries(horodatages)) {
    if (CLES_LOCALES.has(cle)) continue;
    if (!distant[cle] || distant[cle].t < t) {
      const v = await lire(cle);
      if (v != null) aPousser.push({ cle, v, t });
    }
  }
  if (adopte) ecrireBrut("app:horodatages", horodatages);
  if (aPousser.length) {
    for (const e of aPousser) enAttente.set(e.cle, e);
    programmerPoussee();
  }
  return adopte ? "maj" : "ok";
}

/* ------------------------------------------------------------------ */
/* Notifications (repos) — via le service worker quand il est là       */
/* ------------------------------------------------------------------ */

function heureCourte(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

async function notifier(titre, corps, options = {}) {
  try {
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    const opts = { body: corps, tag: "coachwork-repos", icon: "/icone-192.png", badge: "/icone-192.png", ...options };
    const reg = "serviceWorker" in navigator ? await navigator.serviceWorker.getRegistration() : null;
    if (reg && reg.showNotification) reg.showNotification(titre, opts);
    else new Notification(titre, opts);
  } catch (e) {}
}

async function fermerNotifications() {
  try {
    const reg = "serviceWorker" in navigator ? await navigator.serviceWorker.getRegistration() : null;
    if (reg && reg.getNotifications) {
      (await reg.getNotifications({ tag: "coachwork-repos" })).forEach((n) => n.close());
    }
  } catch (e) {}
}

/* --- Web Push : le serveur envoie la notification de fin de repos à
   l'heure exacte, même si l'app est en arrière-plan ou fermée --- */

let clePushPublique = null;

function base64VersUint8(base64) {
  const rembourrage = "=".repeat((4 - (base64.length % 4)) % 4);
  const propre = (base64 + rembourrage).replace(/-/g, "+").replace(/_/g, "/");
  const brut = atob(propre);
  return Uint8Array.from(brut, (c) => c.charCodeAt(0));
}

async function abonnementPush() {
  try {
    if (!syncDisponible || !("serviceWorker" in navigator) || !("PushManager" in window)) return null;
    if (!("Notification" in window) || Notification.permission !== "granted") return null;
    const reg = await navigator.serviceWorker.ready;
    let ab = await reg.pushManager.getSubscription();
    if (!ab) {
      if (!clePushPublique) {
        const r = await fetch("/api/push-cle", { headers: entetesSync(false) });
        if (!r.ok) return null;
        clePushPublique = (await r.json()).cle;
      }
      ab = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: base64VersUint8(clePushPublique),
      });
    }
    return ab;
  } catch (e) {
    return null;
  }
}

function jetonAleatoire() {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function planifierPushRepos(finA, corps) {
  try {
    const ab = await abonnementPush();
    if (!ab) return;
    fetch("/api/repos", {
      method: "POST",
      headers: entetesSync(true),
      body: JSON.stringify({
        abonnement: ab.toJSON(),
        finA,
        jeton: jetonAleatoire(),
        titre: "Repos terminé — à toi !",
        corps,
      }),
    }).catch(() => {});
  } catch (e) {}
}

async function annulerPushRepos() {
  try {
    const ab = await abonnementPush();
    if (!ab) return;
    fetch("/api/repos", {
      method: "POST",
      headers: entetesSync(true),
      body: JSON.stringify({ abonnement: { endpoint: ab.endpoint }, annuler: true, jeton: jetonAleatoire() }),
    }).catch(() => {});
  } catch (e) {}
}

/* Migration : l'ancien profil « maman » devient « valerie » */
const ANCIENS_PROFILS = { valerie: "maman" };

async function lireProfil(p, suffixe) {
  let v = await lire(`${p}:${suffixe}`);
  if (v == null && ANCIENS_PROFILS[p]) {
    v = await lire(`${ANCIENS_PROFILS[p]}:${suffixe}`);
    if (v != null) ecrire(`${p}:${suffixe}`, v);
  }
  return v;
}

/* ------------------------------------------------------------------ */
/* Dates (semaine = lundi → dimanche)                                  */
/* ------------------------------------------------------------------ */

function cleJour(d = new Date()) {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const j = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${j}`;
}

function depuisCle(iso) {
  const [a, m, j] = iso.split("-").map(Number);
  return new Date(a, m - 1, j);
}

function lundiDe(iso) {
  const d = depuisCle(iso);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return cleJour(d);
}

function semainesAvant(isoLundi, n) {
  const [a, m, j] = isoLundi.split("-").map(Number);
  return cleJour(new Date(a, m - 1, j - 7 * n));
}

const FORMAT_JOUR = new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "numeric", month: "long" });
const FORMAT_COURT = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "long" });
const FORMAT_MINI = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short" });

/* ------------------------------------------------------------------ */
/* Profils & mesures                                                   */
/* ------------------------------------------------------------------ */

const PROFILS = {
  esteban: { nom: "Esteban", initiale: "E", detail: "Reprise en main" },
  valerie: { nom: "Valérie", initiale: "V", detail: "Reprise en douceur" },
};

const MESURES_DEFAUT = {
  esteban: { nom: "Esteban", age: "29", taille: "170", poids: "79" },
  valerie: { nom: "Valérie", age: "54", taille: "154", poids: "65" },
};

function nomAffiche(donneesProfil, id) {
  return ((donneesProfil.mesures.nom || "").trim()) || PROFILS[id].nom;
}

/* ------------------------------------------------------------------ */
/* Les exercices (partagés entre tous les programmes : la charge       */
/* notée sur un exercice suit partout)                                 */
/* ------------------------------------------------------------------ */

const EXOS = {
  presse: {
    id: "presse",
    nom: "Presse à cuisses",
    zone: "Jambes & fessiers",
    series: 3,
    reps: "12",
    repos: 90,
    charge: { esteban: "Départ conseillé : 40–60 kg", valerie: "Départ conseillé : 15–25 kg" },
    variante: "Poids libres : goblet squat avec un haltère.",
    conseil:
      "Pieds à largeur d’épaules, descends jusqu’à 90° et pousse sans jamais verrouiller les genoux.",
  },
  goblet: {
    id: "goblet",
    nom: "Goblet squat",
    zone: "Jambes & fessiers",
    series: 3,
    reps: "12",
    repos: 90,
    charge: { esteban: "Haltère de 10–16 kg", valerie: "Haltère de 4–8 kg" },
    variante: "Genoux sensibles ce jour-là ? Repasse sur la presse à cuisses.",
    conseil: "Haltère serré contre la poitrine, dos droit, talons au sol. Descends comme pour t’asseoir.",
  },
  "souleve-roumain": {
    id: "souleve-roumain",
    nom: "Soulevé de terre roumain, haltères",
    zone: "Jambes & fessiers",
    series: 3,
    reps: "12",
    repos: 90,
    charge: { esteban: "2 haltères de 10–14 kg", valerie: "2 haltères de 4–6 kg" },
    variante: "Ou leg curl si le geste n’est pas encore à l’aise.",
    conseil:
      "Pousse les hanches vers l’arrière, dos plat, haltères qui glissent le long des cuisses. Tu dois sentir l’arrière des jambes, jamais le bas du dos.",
  },
  "leg-curl": {
    id: "leg-curl",
    nom: "Leg curl assis",
    zone: "Jambes & fessiers",
    series: 2,
    reps: "12",
    repos: 60,
    charge: { esteban: "Départ conseillé : 25–35 kg", valerie: "Départ conseillé : 10–15 kg" },
    variante: "Version allongée selon les machines de la salle.",
    conseil: "Fléchis en 1 seconde, retiens la remontée en 3 secondes. Les ischios adorent la lenteur.",
  },
  "leg-extension": {
    id: "leg-extension",
    nom: "Leg extension",
    zone: "Jambes & fessiers",
    series: 2,
    reps: "15",
    repos: 60,
    charge: { esteban: "Départ conseillé : 20–30 kg", valerie: "Départ conseillé : 10–15 kg" },
    variante: "Réglage : le coussin repose juste au-dessus des chevilles.",
    conseil: "Monte en 1 seconde, redescends en 3. Léger et propre plutôt que lourd et saccadé.",
  },
  "hip-thrust": {
    id: "hip-thrust",
    nom: "Pont fessier (hip thrust)",
    zone: "Jambes & fessiers",
    series: 3,
    reps: "15",
    repos: 60,
    charge: {
      esteban: "Haltère ou disque de 10–20 kg sur les hanches",
      valerie: "Poids du corps, puis 5–10 kg quand c’est facile",
    },
    variante: "Machine hip thrust si ta salle en a une.",
    conseil:
      "Pousse dans les talons, serre fort les fessiers 1 s en haut. Très efficace et très doux pour les articulations.",
  },
  "dev-poitrine": {
    id: "dev-poitrine",
    nom: "Développé poitrine assis",
    zone: "Poitrine",
    series: 3,
    reps: "10",
    repos: 90,
    charge: { esteban: "Départ conseillé : 20–30 kg", valerie: "Départ conseillé : 7,5–12,5 kg" },
    variante: "Poids libres : développé haltères sur banc.",
    conseil: "Omoplates serrées contre le dossier, pousse en expirant, redescends en 2 secondes.",
  },
  "dev-epaules": {
    id: "dev-epaules",
    nom: "Développé épaules assis",
    zone: "Épaules",
    series: 3,
    reps: "10",
    repos: 90,
    charge: { esteban: "Départ conseillé : 15–20 kg", valerie: "Départ conseillé : 5–10 kg" },
    variante: "Poids libres : développé avec deux haltères légers.",
    conseil: "Ne hausse pas les épaules vers les oreilles ; le mouvement reste fluide, sans à-coups.",
  },
  pompes: {
    id: "pompes",
    nom: "Pompes mains surélevées",
    zone: "Poitrine",
    series: 3,
    reps: "8–12",
    repos: 90,
    sansCharge: true,
    charge: {
      esteban: "Mains sur un banc bas, ou au sol",
      valerie: "Mains sur une barre haute (cadre guidé)",
    },
    variante: "Ou développé poitrine avec haltères.",
    conseil:
      "Corps gainé comme une planche. Pour progresser : baisse le support petit à petit, semaine après semaine.",
  },
  "tirage-vertical": {
    id: "tirage-vertical",
    nom: "Tirage vertical",
    zone: "Dos",
    series: 3,
    reps: "10",
    repos: 90,
    charge: { esteban: "Départ conseillé : 30–40 kg", valerie: "Départ conseillé : 15–20 kg" },
    variante: "Machine à tractions assistées si disponible.",
    conseil: "Tire la barre vers le haut de la poitrine, coudes vers le bas — pas derrière la nuque.",
  },
  rowing: {
    id: "rowing",
    nom: "Rowing assis machine",
    zone: "Dos",
    series: 3,
    reps: "12",
    repos: 90,
    charge: { esteban: "Départ conseillé : 30–40 kg", valerie: "Départ conseillé : 15–20 kg" },
    variante: "Ou tirage horizontal à la poulie basse.",
    conseil: "Poitrine contre le support, tire les coudes vers l’arrière et serre les omoplates 1 seconde.",
  },
  "tirage-horizontal": {
    id: "tirage-horizontal",
    nom: "Tirage horizontal à la poulie",
    zone: "Dos",
    series: 3,
    reps: "12",
    repos: 90,
    charge: { esteban: "Départ conseillé : 25–35 kg", valerie: "Départ conseillé : 12–17 kg" },
    variante: "Ou rowing un bras avec haltère, genou sur le banc.",
    conseil: "Buste droit et stable, tire la poignée vers le nombril sans te balancer.",
  },
  planche: {
    id: "planche",
    nom: "Planche",
    zone: "Abdos & gainage",
    series: 3,
    reps: "20–40 s",
    repos: 60,
    sansCharge: true,
    charge: { esteban: "Sur les avant-bras, corps aligné", valerie: "Sur les genoux au départ — parfait aussi" },
    variante: "Trop facile ? Décolle un pied 5 s de chaque côté.",
    conseil: "Serre les fessiers et le ventre, ne laisse pas le bas du dos se creuser.",
  },
  "dead-bug": {
    id: "dead-bug",
    nom: "Dead bug",
    zone: "Abdos & gainage",
    series: 3,
    reps: "8 / côté",
    repos: 60,
    sansCharge: true,
    charge: { esteban: "Bras et jambe opposés tendus", valerie: "Amplitude réduite au départ" },
    variante: "Trop facile ? Ralentis encore le mouvement.",
    conseil: "Bas du dos plaqué au sol du début à la fin. Souffle en allongeant bras et jambe.",
  },
  "planche-laterale": {
    id: "planche-laterale",
    nom: "Planche latérale",
    zone: "Abdos & gainage",
    series: 2,
    reps: "15–25 s / côté",
    repos: 60,
    sansCharge: true,
    charge: { esteban: "Sur l’avant-bras, pieds empilés", valerie: "Genoux posés — version parfaite pour démarrer" },
    variante: "Trop facile ? Lève le bras libre vers le plafond.",
    conseil: "Hanches hautes, corps en ligne droite des épaules aux pieds (ou aux genoux).",
  },
  "squat-barre": {
    id: "squat-barre",
    nom: "Squat à la barre guidée (Smith)",
    zone: "Jambes & fessiers",
    series: 3,
    reps: "10",
    repos: 90,
    charge: { esteban: "Barre seule pour apprendre, puis +2,5 kg par côté", valerie: "Barre de la Smith seule, amplitude confortable" },
    variante: "Goblet squat si la barre impressionne encore.",
    conseil:
      "Pieds légèrement ouverts, descends comme pour t’asseoir, talons ancrés. La barre guidée sécurise la trajectoire.",
  },
  fentes: {
    id: "fentes",
    nom: "Fentes sur place, haltères",
    zone: "Jambes & fessiers",
    series: 3,
    reps: "8 / jambe",
    repos: 90,
    charge: { esteban: "2 haltères de 6–10 kg", valerie: "Poids du corps, une main sur un support" },
    variante: "Fentes arrière, plus douces pour les genoux.",
    conseil:
      "Grand pas, buste droit, le genou avant reste au-dessus de la cheville. Le genou arrière descend vers le sol.",
  },
  abduction: {
    id: "abduction",
    nom: "Abduction de hanches (machine)",
    zone: "Jambes & fessiers",
    series: 3,
    reps: "15",
    repos: 60,
    charge: { esteban: "Départ conseillé : 35–50 kg", valerie: "Départ conseillé : 15–25 kg" },
    variante: "Avec un élastique au-dessus des genoux si la machine est prise.",
    conseil: "Pousse les genoux vers l’extérieur sans décoller le dos du dossier, reviens lentement.",
  },
  adduction: {
    id: "adduction",
    nom: "Adduction de hanches (machine)",
    zone: "Jambes & fessiers",
    series: 3,
    reps: "15",
    repos: 60,
    charge: { esteban: "Départ conseillé : 30–45 kg", valerie: "Départ conseillé : 15–20 kg" },
    variante: "Serre un ballon entre les genoux, allongée, à défaut.",
    conseil: "Serre en 1 seconde, retiens 2–3 secondes au retour. Sans à-coups.",
  },
  "kickback-fessier": {
    id: "kickback-fessier",
    nom: "Kickback fessier à la poulie",
    zone: "Jambes & fessiers",
    series: 3,
    reps: "12 / jambe",
    repos: 60,
    charge: { esteban: "Départ conseillé : 10–15 kg", valerie: "Départ conseillé : 5–7,5 kg" },
    variante: "À quatre pattes au sol (donkey kick), sans poulie.",
    conseil: "Sangle à la cheville, jambe qui pousse vers l’arrière, serre le fessier 1 s. Sans cambrer le dos.",
  },
  mollets: {
    id: "mollets",
    nom: "Mollets debout",
    zone: "Jambes & fessiers",
    series: 3,
    reps: "15",
    repos: 45,
    charge: { esteban: "Machine +20–40 kg, ou poids du corps sur une marche", valerie: "Poids du corps sur une marche, en te tenant" },
    variante: "Version assise pour varier l’angle.",
    conseil: "Monte haut sur la pointe, marque 1 s en haut, laisse le talon descendre bien bas.",
  },
  "dev-couche": {
    id: "dev-couche",
    nom: "Développé couché, haltères",
    zone: "Poitrine",
    series: 3,
    reps: "10",
    repos: 90,
    charge: { esteban: "2 haltères de 10–14 kg", valerie: "2 haltères de 3–5 kg" },
    variante: "À la barre quand le geste est bien acquis.",
    conseil:
      "Pieds au sol, omoplates serrées, descends les haltères au niveau de la poitrine, coudes à environ 45°.",
  },
  "dev-incline": {
    id: "dev-incline",
    nom: "Développé incliné (machine ou haltères)",
    zone: "Poitrine",
    series: 3,
    reps: "10",
    repos: 90,
    charge: { esteban: "15–25 kg machine, ou 2 haltères de 8–12 kg", valerie: "5–10 kg machine, ou 2 haltères de 3–4 kg" },
    variante: "Pompes pieds au sol, mains sur banc incliné.",
    conseil: "Banc entre 30 et 45°. Vise le haut de la poitrine, sans cambrer le bas du dos.",
  },
  ecarte: {
    id: "ecarte",
    nom: "Écarté à la poulie (ou pec deck)",
    zone: "Poitrine",
    series: 3,
    reps: "12",
    repos: 60,
    charge: { esteban: "Départ conseillé : 10–15 kg par côté", valerie: "Départ conseillé : 5–7,5 kg par côté" },
    variante: "Pec deck (machine papillon), plus guidé.",
    conseil: "Bras presque tendus, grand mouvement d’accolade. Reste léger : c’est un exercice de finition.",
  },
  dips: {
    id: "dips",
    nom: "Dips assistés (machine)",
    zone: "Poitrine",
    series: 3,
    reps: "8",
    repos: 90,
    charge: { esteban: "Assistance moyenne (–20 à –30 kg)", valerie: "Assistance forte (–35 kg et plus)" },
    variante: "Ou pompes sur banc si la machine manque.",
    conseil: "Penche-toi légèrement en avant, descends jusqu’à 90° aux coudes — pas plus bas.",
  },
  butterfly: {
    id: "butterfly",
    nom: "Butterfly (pec deck machine)",
    zone: "Poitrine",
    series: 3,
    reps: "12",
    repos: 60,
    charge: { esteban: "Départ conseillé : 25–40 kg", valerie: "Départ conseillé : 10–20 kg" },
    variante: "Écarté à la poulie si la machine est prise.",
    conseil: "Dos bien calé au dossier, avant-bras sur les coussinets, rapproche les coudes en serrant la poitrine 1 s, reviens en contrôlant.",
  },
  "pull-over": {
    id: "pull-over",
    nom: "Pull-over à la poulie haute",
    zone: "Poitrine",
    series: 3,
    reps: "12",
    repos: 60,
    charge: { esteban: "Départ conseillé : 20–30 kg", valerie: "Départ conseillé : 10–15 kg" },
    variante: "Avec un haltère en travers d’un banc à défaut de poulie.",
    conseil: "Bras presque tendus, tire la barre vers les cuisses en gardant le buste stable. Tu sens la poitrine et les grands dorsaux travailler ensemble.",
  },
  "elevations-laterales": {
    id: "elevations-laterales",
    nom: "Élévations latérales, haltères",
    zone: "Épaules",
    series: 3,
    reps: "12",
    repos: 60,
    charge: { esteban: "2 haltères de 4–6 kg", valerie: "2 haltères de 2–3 kg" },
    variante: "À la poulie basse, un bras à la fois.",
    conseil: "Coudes à peine fléchis, monte jusqu’à l’horizontale, redescends en 2 s. Léger, toujours.",
  },
  oiseau: {
    id: "oiseau",
    nom: "Oiseau, buste penché",
    zone: "Épaules",
    series: 3,
    reps: "12",
    repos: 60,
    charge: { esteban: "2 haltères de 4–6 kg", valerie: "2 haltères de 2–3 kg" },
    variante: "Machine reverse fly (papillon inversé).",
    conseil: "Buste penché, dos plat, écarte les bras comme des ailes — sans élan. Arrière d’épaule et posture.",
  },
  "face-pull": {
    id: "face-pull",
    nom: "Face pull à la corde",
    zone: "Épaules",
    series: 3,
    reps: "15",
    repos: 60,
    charge: { esteban: "Départ conseillé : 10–15 kg", valerie: "Départ conseillé : 5–7,5 kg" },
    variante: "Oiseau aux haltères à défaut de poulie.",
    conseil: "Poulie à hauteur du visage, tire la corde vers le front en écartant les mains, coudes hauts. Excellent pour la posture.",
  },
  shrugs: {
    id: "shrugs",
    nom: "Shrugs (haussements), haltères",
    zone: "Épaules",
    series: 2,
    reps: "12",
    repos: 60,
    charge: { esteban: "2 haltères de 10–14 kg", valerie: "2 haltères de 4–6 kg" },
    variante: "À la barre ou à la Smith machine.",
    conseil: "Hausse les épaules droit vers les oreilles, marque 1 s, redescends. Sans rouler les épaules.",
  },
  "traction-assistee": {
    id: "traction-assistee",
    nom: "Tractions assistées (machine)",
    zone: "Dos",
    series: 3,
    reps: "6–8",
    repos: 90,
    charge: { esteban: "Assistance –25 à –35 kg", valerie: "Assistance –45 kg et plus" },
    variante: "Tirage vertical si la machine manque.",
    conseil: "Prise un peu plus large que les épaules, tire la poitrine vers la barre, redescends bras presque tendus.",
  },
  "rowing-haltere": {
    id: "rowing-haltere",
    nom: "Rowing un bras, haltère",
    zone: "Dos",
    series: 3,
    reps: "10 / bras",
    repos: 90,
    charge: { esteban: "Haltère de 10–16 kg", valerie: "Haltère de 4–6 kg" },
    variante: "Rowing assis machine pour un geste plus guidé.",
    conseil: "Main et genou sur le banc, dos plat. Tire le coude vers la hanche, sans tourner le buste.",
  },
  "curl-biceps": {
    id: "curl-biceps",
    nom: "Curl biceps, haltères",
    zone: "Bras",
    series: 3,
    reps: "12",
    repos: 60,
    charge: { esteban: "2 haltères de 6–10 kg", valerie: "2 haltères de 2–4 kg" },
    variante: "À la poulie basse pour une tension continue.",
    conseil: "Coudes collés au buste, redescends complètement et lentement — c’est la descente qui construit.",
  },
  "curl-marteau": {
    id: "curl-marteau",
    nom: "Curl marteau",
    zone: "Bras",
    series: 3,
    reps: "12",
    repos: 60,
    charge: { esteban: "2 haltères de 6–10 kg", valerie: "2 haltères de 2–4 kg" },
    variante: "En alternant les bras pour rester propre.",
    conseil: "Paumes face à face, comme si tu plantais un clou. Zéro élan, zéro balancement.",
  },
  "triceps-poulie": {
    id: "triceps-poulie",
    nom: "Extension triceps à la poulie",
    zone: "Bras",
    series: 3,
    reps: "12",
    repos: 60,
    charge: { esteban: "Départ conseillé : 15–20 kg", valerie: "Départ conseillé : 5–10 kg" },
    variante: "Corde (finition poignets vers le bas) ou barre courte.",
    conseil: "Coudes soudés au buste, tends complètement les bras, remonte lentement.",
  },
  crunch: {
    id: "crunch",
    nom: "Crunch au sol",
    zone: "Abdos & gainage",
    series: 3,
    reps: "15",
    repos: 45,
    sansCharge: true,
    charge: { esteban: "Mains aux tempes", valerie: "Bras tendus vers les genoux" },
    variante: "À la machine à abdos si tu préfères doser une charge.",
    conseil: "Décolle seulement le haut du dos, souffle en montant. Petit mouvement, grande contraction.",
  },
  "releve-genoux": {
    id: "releve-genoux",
    nom: "Relevé de genoux",
    zone: "Abdos & gainage",
    series: 3,
    reps: "10",
    repos: 60,
    sansCharge: true,
    charge: { esteban: "À la chaise romaine", valerie: "Assise au bord d’un banc, mains derrière toi" },
    variante: "Jambes tendues quand les genoux deviennent faciles.",
    conseil: "Remonte les genoux vers la poitrine sans te balancer, redescends lentement.",
  },
  "russian-twist": {
    id: "russian-twist",
    nom: "Rotation russe",
    zone: "Abdos & gainage",
    series: 3,
    reps: "10 / côté",
    repos: 45,
    charge: { esteban: "Disque ou haltère de 2,5–5 kg", valerie: "Sans poids d’abord, mains jointes" },
    variante: "Pieds au sol pour commencer, décollés ensuite.",
    conseil: "Assis, buste légèrement incliné, tourne les épaules — pas seulement les bras.",
  },
  "mountain-climbers": {
    id: "mountain-climbers",
    nom: "Mountain climbers",
    zone: "Abdos & gainage",
    series: 3,
    reps: "20 s",
    repos: 45,
    sansCharge: true,
    charge: { esteban: "Rythme soutenu", valerie: "Rythme lent, hanches bien stables" },
    variante: "Mains sur un banc pour une version plus douce.",
    conseil: "Position de pompe, ramène les genoux l’un après l’autre en gardant les hanches basses. Cardio et gainage à la fois.",
  },
  "extension-lombaire": {
    id: "extension-lombaire",
    nom: "Extension lombaire (banc à 45°)",
    zone: "Abdos & gainage",
    series: 2,
    reps: "12",
    repos: 60,
    charge: { esteban: "Poids du corps, puis un disque de 5 kg contre la poitrine", valerie: "Poids du corps, amplitude réduite" },
    variante: "Superman au sol à défaut de banc.",
    conseil: "Remonte jusqu’à l’alignement du corps, pas plus haut. Lentement — le bas du dos aime la douceur.",
  },
  superman: {
    id: "superman",
    nom: "Superman au sol",
    zone: "Abdos & gainage",
    series: 2,
    reps: "10",
    repos: 45,
    sansCharge: true,
    charge: { esteban: "Tiens 2 s en haut", valerie: "Bras et jambe opposés en alternance" },
    variante: "Sur un tapis, coussin sous les hanches si besoin.",
    conseil: "Allongé sur le ventre, décolle bras et jambes de quelques centimètres, regard vers le sol.",
  },
  "squat-pdc": {
    id: "squat-pdc",
    nom: "Squat au poids du corps",
    zone: "Jambes & fessiers",
    series: 3,
    reps: "15",
    repos: 45,
    sansCharge: true,
    charge: { esteban: "Rythme soutenu, amplitude complète", valerie: "Vers une chaise pour te repérer au départ" },
    variante: "Bras tendus devant pour l’équilibre.",
    conseil: "Pieds à largeur d’épaules, descends comme pour t’asseoir, talons au sol, remonte en serrant les fessiers.",
  },
  "squat-sumo": {
    id: "squat-sumo",
    nom: "Squat sumo",
    zone: "Jambes & fessiers",
    series: 3,
    reps: "12",
    repos: 60,
    charge: { esteban: "Poids du corps, ou haltère de 12–20 kg tenu vertical", valerie: "Poids du corps, puis haltère léger" },
    variante: "Sur les pointes en haut pour prendre les mollets.",
    conseil: "Pieds bien plus larges que les épaules, pointes ouvertes, genoux qui suivent les pointes. Vise l’intérieur des cuisses et les fessiers.",
  },
  "fentes-bulgares": {
    id: "fentes-bulgares",
    nom: "Fentes bulgares (pied arrière surélevé)",
    zone: "Jambes & fessiers",
    series: 3,
    reps: "8 / jambe",
    repos: 90,
    charge: { esteban: "Poids du corps, puis 2 haltères de 6–10 kg", valerie: "Poids du corps, une main en appui" },
    variante: "Chaise, banc ou marche : tout support stable fait l’affaire.",
    conseil: "Pied arrière posé sur le support, tout le poids sur la jambe avant. Descends droit, genou avant au-dessus de la cheville.",
  },
};

/* Catalogue par zone (ordre d'affichage dans le sélecteur) */
const ZONES = [
  ["Jambes & fessiers", ["presse", "squat-barre", "goblet", "squat-sumo", "squat-pdc", "fentes", "fentes-bulgares", "souleve-roumain", "leg-curl", "leg-extension", "hip-thrust", "abduction", "adduction", "kickback-fessier", "mollets"]],
  ["Poitrine", ["dev-poitrine", "dev-couche", "dev-incline", "pompes", "butterfly", "ecarte", "pull-over", "dips"]],
  ["Épaules", ["dev-epaules", "elevations-laterales", "oiseau", "face-pull", "shrugs"]],
  ["Dos", ["tirage-vertical", "traction-assistee", "rowing", "tirage-horizontal", "rowing-haltere"]],
  ["Bras", ["curl-biceps", "curl-marteau", "triceps-poulie"]],
  ["Abdos & gainage", ["planche", "planche-laterale", "dead-bug", "crunch", "releve-genoux", "russian-twist", "mountain-climbers", "extension-lombaire", "superman"]],
];

/* ------------------------------------------------------------------ */
/* Muscles travaillés & schéma corporel                                */
/* ------------------------------------------------------------------ */

const MUSCLES_LIBELLES = {
  quadriceps: "Quadriceps", ischios: "Ischio-jambiers", fessiers: "Fessiers",
  abducteurs: "Abducteurs", adducteurs: "Adducteurs", mollets: "Mollets",
  pectoraux: "Pectoraux", epaules: "Épaules", trapezes: "Trapèzes",
  dorsaux: "Dorsaux", lombaires: "Lombaires", biceps: "Biceps",
  triceps: "Triceps", "avant-bras": "Avant-bras", abdos: "Abdominaux", obliques: "Obliques",
};

const MUSCLES_PAR_ZONE = {
  "Jambes & fessiers": ["quadriceps", "fessiers"],
  Poitrine: ["pectoraux", "triceps"],
  Épaules: ["epaules"],
  Dos: ["dorsaux", "biceps"],
  Bras: ["biceps"],
  "Abdos & gainage": ["abdos"],
};

const MUSCLES_PAR_EXO = {
  presse: ["quadriceps", "fessiers"],
  "squat-barre": ["quadriceps", "fessiers"],
  goblet: ["quadriceps", "fessiers", "abdos"],
  fentes: ["quadriceps", "fessiers"],
  "souleve-roumain": ["ischios", "fessiers", "lombaires"],
  "leg-curl": ["ischios"],
  "leg-extension": ["quadriceps"],
  "hip-thrust": ["fessiers", "ischios"],
  abduction: ["abducteurs", "fessiers"],
  adduction: ["adducteurs"],
  "kickback-fessier": ["fessiers"],
  mollets: ["mollets"],
  "dev-poitrine": ["pectoraux", "triceps", "epaules"],
  "dev-couche": ["pectoraux", "triceps", "epaules"],
  "dev-incline": ["pectoraux", "epaules", "triceps"],
  pompes: ["pectoraux", "triceps", "abdos"],
  ecarte: ["pectoraux"],
  butterfly: ["pectoraux"],
  "pull-over": ["pectoraux", "dorsaux"],
  dips: ["pectoraux", "triceps"],
  "dev-epaules": ["epaules", "triceps"],
  "elevations-laterales": ["epaules"],
  oiseau: ["epaules", "trapezes"],
  "face-pull": ["epaules", "trapezes"],
  shrugs: ["trapezes"],
  "tirage-vertical": ["dorsaux", "biceps"],
  "traction-assistee": ["dorsaux", "biceps"],
  rowing: ["dorsaux", "trapezes", "biceps"],
  "tirage-horizontal": ["dorsaux", "biceps"],
  "rowing-haltere": ["dorsaux", "biceps"],
  "curl-biceps": ["biceps", "avant-bras"],
  "curl-marteau": ["biceps", "avant-bras"],
  "triceps-poulie": ["triceps"],
  planche: ["abdos", "lombaires", "epaules"],
  "planche-laterale": ["obliques", "abdos"],
  "dead-bug": ["abdos"],
  crunch: ["abdos"],
  "releve-genoux": ["abdos"],
  "russian-twist": ["obliques", "abdos"],
  "mountain-climbers": ["abdos", "quadriceps", "epaules"],
  "extension-lombaire": ["lombaires", "fessiers", "ischios"],
  superman: ["lombaires", "fessiers"],
  "squat-pdc": ["quadriceps", "fessiers"],
  "squat-sumo": ["quadriceps", "fessiers", "adducteurs"],
  "fentes-bulgares": ["quadriceps", "fessiers"],
};
for (const [id, m] of Object.entries(MUSCLES_PAR_EXO)) {
  if (EXOS[id]) EXOS[id].muscles = m;
}

/* ------------------------------------------------------------------ */
/* Groupes de mouvement : les exercices d'un même groupe sont           */
/* interchangeables en séance (swipe / bouton variante)                 */
/* ------------------------------------------------------------------ */

const GROUPES = {
  squat: "Squat & presse",
  ischios: "Ischios & charnière",
  fessiers: "Fessiers",
  quadriceps: "Quadriceps (isolation)",
  hanches: "Hanches (machine)",
  mollets: "Mollets",
  "poussee-poitrine": "Poussée poitrine",
  epaules: "Épaules",
  "arriere-epaule": "Arrière d'épaule & posture",
  trapezes: "Trapèzes",
  "tirage-vertical": "Tirage vertical",
  "tirage-horizontal": "Tirage horizontal",
  biceps: "Biceps",
  triceps: "Triceps",
  "gainage-ventral": "Gainage ventral",
  obliques: "Obliques",
  "abdos-flexion": "Abdos (flexion)",
  lombaires: "Bas du dos",
};

const GROUPE_PAR_EXO = {
  presse: "squat", "squat-barre": "squat", goblet: "squat", fentes: "squat",
  "squat-sumo": "squat", "squat-pdc": "squat", "fentes-bulgares": "squat",
  "souleve-roumain": "ischios", "leg-curl": "ischios",
  "hip-thrust": "fessiers", "kickback-fessier": "fessiers",
  "leg-extension": "quadriceps",
  abduction: "hanches", adduction: "hanches",
  mollets: "mollets",
  "dev-poitrine": "poussee-poitrine", "dev-couche": "poussee-poitrine",
  "dev-incline": "poussee-poitrine", pompes: "poussee-poitrine",
  ecarte: "poussee-poitrine", dips: "poussee-poitrine",
  butterfly: "poussee-poitrine", "pull-over": "poussee-poitrine",
  "dev-epaules": "epaules", "elevations-laterales": "epaules",
  oiseau: "arriere-epaule", "face-pull": "arriere-epaule",
  shrugs: "trapezes",
  "tirage-vertical": "tirage-vertical", "traction-assistee": "tirage-vertical",
  rowing: "tirage-horizontal", "tirage-horizontal": "tirage-horizontal", "rowing-haltere": "tirage-horizontal",
  "curl-biceps": "biceps", "curl-marteau": "biceps",
  "triceps-poulie": "triceps",
  planche: "gainage-ventral", "dead-bug": "gainage-ventral", "mountain-climbers": "gainage-ventral",
  "planche-laterale": "obliques", "russian-twist": "obliques",
  crunch: "abdos-flexion", "releve-genoux": "abdos-flexion",
  "extension-lombaire": "lombaires", superman: "lombaires",
};
for (const [id, g] of Object.entries(GROUPE_PAR_EXO)) {
  if (EXOS[id]) EXOS[id].groupe = g;
}

/* ------------------------------------------------------------------ */
/* Estimation d'énergie dépensée (indicative, jamais un objectif)      */
/* Modèle MET : kcal = MET × poids(kg) × durée(h), avec un petit       */
/* bonus si la charge est lourde par rapport au poids de corps.         */
/* ------------------------------------------------------------------ */

const MET_COMPOSE_JAMBES = 6;
const MET_COMPOSE_HAUT = 5;
const MET_ISOLATION = 4;
const MET_GAINAGE = 3.5;
const MET_TABATA = 8;
const GROUPES_COMPOSES_HAUT = new Set(["poussee-poitrine", "epaules", "tirage-vertical", "tirage-horizontal"]);
const GROUPES_COMPOSES_JAMBES = new Set(["squat", "ischios", "fessiers"]);

function parseCharge(v) {
  if (v == null) return null;
  const n = parseFloat(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function metPourExo(exo) {
  if (!exo) return MET_ISOLATION;
  if (GROUPES_COMPOSES_JAMBES.has(exo.groupe)) return MET_COMPOSE_JAMBES;
  if (GROUPES_COMPOSES_HAUT.has(exo.groupe)) return MET_COMPOSE_HAUT;
  if (exo.zone === "Abdos & gainage") return MET_GAINAGE;
  return MET_ISOLATION;
}

/* minutes actives d'un exercice classique : ~45 s de travail par série
   + le repos prévu entre les séries */
function minutesExo(series, repos) {
  return (series * 45 + Math.max(0, series - 1) * (repos || 60)) / 60;
}

/* kcal d'un exercice fait, à partir des données figées de l'historique */
function kcalExo(dexo, poidsKg, tabata) {
  const exo = EXOS[dexo.id];
  const met = tabata ? MET_TABATA : metPourExo(exo);
  let minutes;
  if (tabata) {
    minutes = (dexo.series * (tabata.travail + tabata.repos)) / 60;
  } else {
    minutes = minutesExo(dexo.series, exo ? exo.repos : 60);
  }
  const charge = parseCharge(dexo.charge);
  const bonusCharge = charge ? Math.min(0.3, charge / (poidsKg * 2)) : 0;
  return met * poidsKg * (minutes / 60) * (1 + bonusCharge);
}

/* Total séance : exercices faits + échauffement + cardio/étirements.
   `detail` vient du snapshot ; `poidsKg` du profil ; `tabata` si applicable. */
function estimerCaloriesSeance(detail, poidsKg, tabata) {
  if (!poidsKg || !detail) return null;
  let kcal = 0;
  for (const dexo of detail) kcal += kcalExo(dexo, poidsKg, tabata);
  kcal += 3.5 * poidsKg * (7 / 60); // échauffement ~7 min doux
  if (!tabata) kcal += 5 * poidsKg * (17 / 60); // cardio ~17 min modéré
  kcal += 2.5 * poidsKg * (5 / 60); // retour au calme ~5 min
  return Math.round(kcal / 5) * 5; // arrondi à 5 kcal, c'est une estimation
}

/* Silhouettes stylisées (face / dos) : chaque forme porte éventuellement
   un identifiant de muscle, colorié en accent quand il travaille */
const FORMES_FACE = [
  { t: "c", cx: 54, cy: 15, r: 10 },
  { t: "r", x: 48.5, y: 24, w: 11, h: 7, rx: 3 },
  { m: "epaules", t: "c", cx: 33.5, cy: 39, r: 8 },
  { m: "epaules", t: "c", cx: 74.5, cy: 39, r: 8 },
  { m: "pectoraux", t: "r", x: 39, y: 33, w: 14.5, h: 16, rx: 5 },
  { m: "pectoraux", t: "r", x: 54.5, y: 33, w: 14.5, h: 16, rx: 5 },
  { m: "biceps", t: "r", x: 25, y: 48, w: 10, h: 21, rx: 5 },
  { m: "biceps", t: "r", x: 73, y: 48, w: 10, h: 21, rx: 5 },
  { m: "avant-bras", t: "r", x: 23, y: 71, w: 9, h: 19, rx: 4.5 },
  { m: "avant-bras", t: "r", x: 76, y: 71, w: 9, h: 19, rx: 4.5 },
  { m: "obliques", t: "r", x: 39, y: 51, w: 6.5, h: 25, rx: 3 },
  { m: "obliques", t: "r", x: 62.5, y: 51, w: 6.5, h: 25, rx: 3 },
  { m: "abdos", t: "r", x: 47, y: 51, w: 14, h: 27, rx: 5 },
  { t: "r", x: 41, y: 80, w: 26, h: 11, rx: 5 },
  { m: "abducteurs", t: "r", x: 35.5, y: 81, w: 5.5, h: 13, rx: 2.75 },
  { m: "abducteurs", t: "r", x: 67, y: 81, w: 5.5, h: 13, rx: 2.75 },
  { m: "quadriceps", t: "r", x: 40, y: 93, w: 11.5, h: 33, rx: 5.5 },
  { m: "quadriceps", t: "r", x: 56.5, y: 93, w: 11.5, h: 33, rx: 5.5 },
  { m: "adducteurs", t: "r", x: 52.5, y: 93, w: 3.5, h: 17, rx: 1.75 },
  { t: "r", x: 41.5, y: 128, w: 9, h: 28, rx: 4.5 },
  { t: "r", x: 57.5, y: 128, w: 9, h: 28, rx: 4.5 },
  { t: "r", x: 40.5, y: 158, w: 11, h: 5, rx: 2.5 },
  { t: "r", x: 56.5, y: 158, w: 11, h: 5, rx: 2.5 },
];
const FORMES_DOS = [
  { t: "c", cx: 54, cy: 15, r: 10 },
  { t: "r", x: 48.5, y: 24, w: 11, h: 7, rx: 3 },
  { m: "trapezes", t: "r", x: 41, y: 29, w: 26, h: 11, rx: 5 },
  { m: "epaules", t: "c", cx: 33.5, cy: 39, r: 8 },
  { m: "epaules", t: "c", cx: 74.5, cy: 39, r: 8 },
  { m: "dorsaux", t: "r", x: 39, y: 42, w: 14, h: 22, rx: 5 },
  { m: "dorsaux", t: "r", x: 55, y: 42, w: 14, h: 22, rx: 5 },
  { m: "triceps", t: "r", x: 25, y: 48, w: 10, h: 21, rx: 5 },
  { m: "triceps", t: "r", x: 73, y: 48, w: 10, h: 21, rx: 5 },
  { m: "avant-bras", t: "r", x: 23, y: 71, w: 9, h: 19, rx: 4.5 },
  { m: "avant-bras", t: "r", x: 76, y: 71, w: 9, h: 19, rx: 4.5 },
  { m: "lombaires", t: "r", x: 47, y: 66, w: 14, h: 13, rx: 4 },
  { m: "fessiers", t: "r", x: 40, y: 81, w: 13, h: 14, rx: 5 },
  { m: "fessiers", t: "r", x: 55, y: 81, w: 13, h: 14, rx: 5 },
  { m: "ischios", t: "r", x: 40, y: 97, w: 11.5, h: 29, rx: 5.5 },
  { m: "ischios", t: "r", x: 56.5, y: 97, w: 11.5, h: 29, rx: 5.5 },
  { m: "mollets", t: "r", x: 41.5, y: 128, w: 9, h: 26, rx: 4.5 },
  { m: "mollets", t: "r", x: 57.5, y: 128, w: 9, h: 26, rx: 4.5 },
  { t: "r", x: 40.5, y: 158, w: 11, h: 5, rx: 2.5 },
  { t: "r", x: 56.5, y: 158, w: 11, h: 5, rx: 2.5 },
];

function SchemaMuscles({ muscles = [], hauteur = 82 }) {
  const actifs = new Set(muscles);
  const rendre = (formes, dx) =>
    formes.map((f, i) => {
      const cls = f.m && actifs.has(f.m) ? "schema-actif" : "schema-base";
      return f.t === "c" ? (
        <circle key={i} cx={f.cx + dx} cy={f.cy} r={f.r} className={cls} />
      ) : (
        <rect key={i} x={f.x + dx} y={f.y} width={f.w} height={f.h} rx={f.rx} className={cls} />
      );
    });
  return (
    <svg viewBox="18 0 178 174" style={{ height: hauteur, flexShrink: 0 }} aria-hidden="true">
      {rendre(FORMES_FACE, 0)}
      {rendre(FORMES_DOS, 105)}
      <text x="54" y="171" textAnchor="middle" className="schema-texte">face</text>
      <text x="159" y="171" textAnchor="middle" className="schema-texte">dos</text>
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* Programmes                                                          */
/* ------------------------------------------------------------------ */

const ECHAUFFEMENT = {
  duree: { esteban: "5 à 7 min", valerie: "8 à 10 min" },
  mobilite: [
    "10 grands cercles de bras (avant puis arrière)",
    "10 rotations du buste, mains sur les hanches",
    "10 cercles de hanches dans chaque sens",
    "10 balancements de jambe par côté, en te tenant",
    "10 squats au poids du corps, lents",
  ],
};

const RETOUR_AU_CALME =
  "3 min de marche très lente pour redescendre, puis 30 s d’étirement doux par groupe : quadriceps, ischios, fessiers, poitrine, dos. Respire profondément — cette séance, personne ne pourra te l’enlever.";

const CARDIO_GENERIQUE = {
  esteban:
    "15–20 min au choix : tapis incliné, vélo ou elliptique, à allure modérée. Option : quelques passages plus toniques d’une minute.",
  valerie:
    "15–20 min au choix : vélo ou elliptique de préférence (zéro impact), à une allure où tu peux parler.",
};

const PROGRAMMES_BASE = [
  {
    id: "fullbody",
    nom: "Full body",
    description:
      "Tout le corps à chaque séance. Le format le plus efficace pour débuter et perdre du gras : chaque muscle travaille 3 fois par semaine.",
    seances: [
      {
        id: "A",
        badge: "A",
        titre: "Séance A — Fondations",
        sousTitre: "tout le corps",
        resume: "Presse · Développé poitrine · Tirage vertical",
        exos: [EXOS.presse, EXOS["dev-poitrine"], EXOS["tirage-vertical"], EXOS["leg-curl"], EXOS.planche],
        cardio: {
          esteban:
            "Tapis : 15–20 min de marche rapide inclinée (5–8 %, 5,5–6,5 km/h). Option intervalles doux : 6 × (1 min tonique / 1 min tranquille).",
          valerie:
            "Vélo ou elliptique : 15–20 min à allure modérée — tu dois pouvoir parler, pas chanter. Zéro impact pour les genoux.",
        },
      },
      {
        id: "B",
        badge: "B",
        titre: "Séance B — Force tranquille",
        sousTitre: "tout le corps",
        resume: "Goblet squat · Épaules · Rowing",
        exos: [EXOS.goblet, EXOS["dev-epaules"], EXOS.rowing, EXOS["hip-thrust"], EXOS["dead-bug"]],
        cardio: {
          esteban:
            "Elliptique : 15–20 min, résistance moyenne. Option : monte la résistance d’un cran 1 min sur 3.",
          valerie: "Elliptique : 15 min tranquilles, résistance légère. Aucun impact, que du bénéfice.",
        },
      },
      {
        id: "C",
        badge: "C",
        titre: "Séance C — Énergie",
        sousTitre: "tout le corps",
        resume: "Soulevé roumain · Pompes · Tirage horizontal",
        exos: [
          EXOS["souleve-roumain"], EXOS.pompes, EXOS["tirage-horizontal"],
          EXOS["leg-extension"], EXOS["planche-laterale"],
        ],
        cardio: {
          esteban:
            "Vélo : 15–20 min. Option : augmente la résistance d’un palier toutes les 5 min, puis redescends sur les 3 dernières.",
          valerie:
            "Vélo : 15–20 min, allure régulière. Règle la selle : jambe presque tendue quand la pédale est en bas.",
        },
      },
    ],
  },
  {
    id: "split",
    nom: "Haut / Bas",
    description:
      "Jour 1 haut du corps, jour 2 bas du corps, jour 3 corps entier. Plus de volume par zone à chaque séance — garde au moins un jour de repos entre deux.",
    seances: [
      {
        id: "sH",
        badge: "1",
        titre: "Jour 1 — Haut du corps",
        sousTitre: "haut du corps",
        resume: "Développé poitrine · Tirage vertical · Épaules",
        exos: [
          EXOS["dev-poitrine"], EXOS["tirage-vertical"], EXOS["dev-epaules"],
          EXOS.rowing, EXOS.planche,
        ],
        cardio: {
          esteban:
            "Tapis : 15–20 min de marche inclinée — les jambes sont fraîches, profites-en. Option : 6 × (1 min tonique / 1 min tranquille).",
          valerie: "Vélo ou elliptique : 15–20 min à allure modérée, zéro impact.",
        },
      },
      {
        id: "sB",
        badge: "2",
        titre: "Jour 2 — Bas du corps",
        sousTitre: "bas du corps",
        resume: "Presse · Leg curl · Hip thrust",
        exos: [
          EXOS.presse, EXOS["leg-curl"], EXOS["leg-extension"],
          EXOS["hip-thrust"], EXOS["dead-bug"],
        ],
        cardio: {
          esteban: "Elliptique : 15 min tranquilles — les jambes ont déjà bien travaillé aujourd’hui.",
          valerie: "Elliptique : 12–15 min très douces, résistance légère.",
        },
      },
      {
        id: "sX",
        badge: "3",
        titre: "Jour 3 — Corps entier",
        sousTitre: "corps entier",
        resume: "Goblet squat · Soulevé roumain · Tirage",
        exos: [
          EXOS.goblet, EXOS["souleve-roumain"], EXOS.pompes,
          EXOS["tirage-horizontal"], EXOS["planche-laterale"],
        ],
        cardio: {
          esteban: "Vélo : 15–20 min. Option : augmente la résistance d’un palier toutes les 5 min.",
          valerie: "Vélo : 15–20 min, selle bien réglée : jambe presque tendue quand la pédale est en bas.",
        },
      },
    ],
  },
  {
    id: "tabata-maison",
    nom: "Tabata maison",
    description:
      "Pas le temps d’aller à la salle ? Sans matériel, à la maison : 20 s d’effort, 10 s de repos, 8 rounds par exercice — et c’est l’app qui fait le chrono (bips, vibrations, écran allumé).",
    seances: [
      {
        id: "T1",
        badge: "T",
        titre: "Tabata — Bas du corps",
        sousTitre: "tabata maison",
        resume: "Squat · Fentes bulgares · Hip thrust · Sumo",
        tabata: { travail: 20, repos: 10 },
        rounds: { "squat-pdc": 8, "fentes-bulgares": 8, "hip-thrust": 8, "squat-sumo": 8 },
        exos: [EXOS["squat-pdc"], EXOS["fentes-bulgares"], EXOS["hip-thrust"], EXOS["squat-sumo"]],
        cardio: null,
      },
    ],
  },
];

const SEANCES_BASE = PROGRAMMES_BASE.flatMap((p) => p.seances);

/* Transforme un programme perso stocké ({id, nom, seances:[{nom, exoIds}]})
   en programme complet affichable */
function construirePerso(p, dico) {
  return {
    id: p.id,
    nom: p.nom,
    perso: true,
    description: `Programme personnalisé · ${p.seances.length} séance${p.seances.length > 1 ? "s" : ""} par semaine`,
    seances: p.seances.map((s, i) => ({
      id: `${p.id}-s${i}`,
      badge: String(i + 1),
      titre: s.nom,
      sousTitre: s.tabata ? "tabata" : "sur mesure",
      resume: s.exoIds.slice(0, 3).map((eid) => (dico[eid] ? dico[eid].nom.split(",")[0] : "")).filter(Boolean).join(" · "),
      tabata: s.tabata || null,
      rounds: s.rounds || {},
      exos: s.exoIds.map((eid) => dico[eid]).filter(Boolean),
      cardio: s.tabata ? null : CARDIO_GENERIQUE,
    })),
  };
}

function idsSeancesDe(persos) {
  return [
    ...SEANCES_BASE.map((s) => s.id),
    ...persos.flatMap((p) => p.seances.map((s, i) => `${p.id}-s${i}`)),
  ];
}

const MESSAGES_FETE = [
  "La régularité bat le talent. Et toi, tu es là.",
  "Une brique de plus sur des fondations solides.",
  "Ton futur toi te dit merci.",
  "Ce que tu répètes, tu le deviens. Bravo.",
  "Séance faite ≠ séance parfaite. Et c’est très bien comme ça.",
  "Le plus dur, c’était de venir. C’est fait.",
];

/* ------------------------------------------------------------------ */
/* Conseils                                                            */
/* ------------------------------------------------------------------ */

const CONSEILS = [
  {
    id: "medical",
    icone: Stethoscope,
    titre: "Avant de commencer",
    texte: [
      "Un avis médical est recommandé avant de reprendre une activité physique — particulièrement pour une reprise à 54 ans. Rien d’inquiétant : c’est simplement la bonne façon de construire sur du solide.",
      "Les deux premières semaines, reste volontairement en dessous de tes capacités : 2 séries par exercice suffisent, avec des charges légères. Mieux vaut finir en se disant « j’aurais pu faire plus » que l’inverse.",
    ],
  },
  {
    id: "echauffement",
    icone: Wind,
    titre: "L’échauffement type",
    texte: [
      "Non négociable, même les jours pressés : 5 à 10 min de cardio très doux (vélo, elliptique ou marche), puis la mobilité — cercles de bras, rotations du buste, cercles de hanches, balancements de jambe, squats lents au poids du corps.",
      "Sur le premier exercice de la séance, fais ta première série très légère : c’est ton échauffement spécifique.",
    ],
  },
  {
    id: "securite",
    icone: ShieldCheck,
    titre: "La technique avant la charge",
    texte: [
      "Une répétition propre et contrôlée vaut plus que trois répétitions arrachées. Si la technique se dégrade, la série est finie — c’est la règle d’or.",
      "Courbature ≠ douleur. La courbature est une raideur diffuse dans le muscle, 24 à 48 h après la séance : normal, ça passe. Une douleur vive et précise dans une articulation (genou, épaule, dos) pendant l’effort : on arrête cet exercice, on passe au suivant, et on en reparle. On ne force jamais sur une articulation qui proteste.",
    ],
  },
  {
    id: "modes",
    icone: Dumbbell,
    titre: "Quel programme choisir ?",
    texte: [
      "Full body : chaque muscle travaille 3 fois par semaine — c’est le format le plus efficace pour débuter, apprendre les gestes et perdre du gras. Reste dessus au moins 4 à 6 semaines.",
      "Haut / Bas : plus de volume par zone et des séances plus ciblées — agréable quand le full body devient routinier. Tu peux aussi créer tes propres programmes selon l’envie. Dans tous les cas, les charges notées te suivent (ce sont les mêmes exercices) et vise 3 séances par semaine avec un jour de repos entre deux.",
    ],
  },
  {
    id: "progression",
    icone: TrendingUp,
    titre: "Progresser sans se presser",
    texte: [
      "Semaines 1–2 : on apprend les gestes, 2 séries, charges légères. Semaines 3–4 : on passe à 3 séries. Ensuite, la surcharge progressive : quand tu atteins le haut de la fourchette de répétitions sur toutes les séries, deux séances de suite, augmente la charge.",
      "Esteban : +2,5 kg sur le haut du corps, +5 kg sur la presse. Valérie : +1 à +2,5 kg, et prends une semaine de plus sur un palier si les articulations le demandent. Note tes charges dans l’app après chaque exercice : c’est ta courbe de progression sur 8 à 12 semaines.",
    ],
  },
  {
    id: "assiette",
    icone: Salad,
    titre: "L’assiette qui aide",
    texte: [
      "Pas de régime, pas de comptage. Des principes simples : une source de protéines à chaque repas (œufs, poisson, volaille, légumineuses, laitages), la moitié de l’assiette en légumes, de l’eau tout au long de la journée.",
      "Pour perdre du gras : un léger déficit durable — des assiettes un peu plus légères qu’avant, pas de privation. Ce que tu peux tenir un an bat toujours ce que tu ne tiens que trois semaines.",
    ],
  },
  {
    id: "sommeil",
    icone: Moon,
    titre: "Sommeil & récupération",
    texte: [
      "7 à 8 h de sommeil : c’est là que les muscles se construisent et que la perte de gras se joue en coulisses.",
      "Garde au moins un jour de repos entre deux séances — lundi / mercredi / vendredi, par exemple. Marcher les jours off est excellent.",
    ],
  },
  {
    id: "balance",
    icone: Scale,
    titre: "La balance ? On s’en occupe peu",
    texte: [
      "Un rythme sain et durable, c’est environ 0,3 à 0,5 kg par semaine — et encore, en moyenne, avec des hauts et des bas parfaitement normaux.",
      "La balance ne voit pas le muscle qui arrive, ni le tour de taille qui diminue, ni les charges qui montent. Ici, on compte les séances faites et la force qui grandit. C’est ça, la vraie progression.",
    ],
  },
  {
    id: "cinquante-quatre",
    icone: HeartPulse,
    titre: "Reprendre à 54 ans : un atout",
    texte: [
      "Le renforcement musculaire est ce qu’on peut faire de mieux à 54 ans : il entretient la densité osseuse, préserve la masse musculaire et protège les articulations en renforçant tout ce qui les entoure.",
      "Machines assises et cardio sans impact (vélo, elliptique) sont tes meilleurs alliés pour démarrer. Un échauffement un peu plus long, des paliers un peu plus doux — et la régularité sur des mois fera le reste. C’est l’intensité qui est optionnelle, jamais la douceur.",
    ],
  },
];

/* ------------------------------------------------------------------ */
/* Chargement de l'état complet depuis le stockage local               */
/* ------------------------------------------------------------------ */

/* Une séance en cours stocke les étapes cochées et les séries faites.
   (migration : les anciennes données étaient directement la carte des coches) */
function normaliserSeance(brut) {
  if (!brut) return { coches: {}, series: {}, remplacements: {} };
  if (brut.coches) return { coches: brut.coches, series: brut.series || {}, remplacements: brut.remplacements || {} };
  return { coches: brut, series: {}, remplacements: {} };
}

async function chargerTout() {
  const persos = (await lire("app:programmesPerso")) || [];
  const exosPerso = (await lire("app:exosPerso")) || [];
  const ids = idsSeancesDe(persos);
  const res = {};
  for (const p of ["esteban", "valerie"]) {
    const seances = {};
    await Promise.all(
      ids.map(async (id) => {
        seances[id] = normaliserSeance(await lireProfil(p, `seance:${id}`));
      })
    );
    const [ch, ass, mode, mesures] = await Promise.all([
      lireProfil(p, "charges"),
      lireProfil(p, "assiduite"),
      lireProfil(p, "mode"),
      lireProfil(p, "mesures"),
    ]);
    res[p] = {
      seances,
      charges: ch || {},
      historique: (ass && ass.historique) || [],
      mode: typeof mode === "string" ? mode : "fullbody",
      mesures: { ...MESURES_DEFAUT[p], ...(mesures || {}) },
    };
  }
  return { persos, exosPerso, res };
}

/* ------------------------------------------------------------------ */
/* Petits composants                                                   */
/* ------------------------------------------------------------------ */

function CaseCoche({ coche, surClic }) {
  return (
    <button
      onClick={surClic}
      aria-pressed={coche}
      aria-label={coche ? "Marquer comme à faire" : "Marquer comme fait"}
      className={`h-12 w-12 shrink-0 rounded-full border-2 flex items-center justify-center transi ${
        coche ? "bg-accent border-transparent" : "border-slate-600 bg-transparent active:scale-95"
      }`}
    >
      {coche && <Check className="pop text-accent-ink" size={26} strokeWidth={3.5} />}
    </button>
  );
}

function Anneau({ fait, total }) {
  const R = 48;
  const C = 2 * Math.PI * R;
  const frac = total ? Math.min(fait / total, 1) : 0;
  return (
    <div className="relative h-28 w-28 shrink-0">
      <svg viewBox="0 0 112 112" className="h-28 w-28 -rotate-90">
        <circle cx="56" cy="56" r={R} fill="none" strokeWidth="10" className="stroke-carte2" />
        <circle
          cx="56" cy="56" r={R} fill="none" strokeWidth="10" strokeLinecap="round"
          className="stroke-accent anneau"
          strokeDasharray={C}
          strokeDashoffset={C * (1 - frac)}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-2xl font-extrabold chiffres leading-none">
          {fait}<span className="text-brume text-base font-bold">/{total}</span>
        </span>
        <span className="text-brume mt-1 text-xs">séances</span>
      </div>
    </div>
  );
}

function Barres({ barres }) {
  return (
    <div>
      <div className="flex items-end gap-2" style={{ height: 72 }}>
        {barres.map((b) => (
          <div key={b.semaine} className="flex-1 flex flex-col items-center justify-end gap-1 h-full">
            <span className={`text-xs chiffres leading-none ${b.n > 0 ? "text-accent font-bold" : "text-transparent"}`}>
              {b.n}
            </span>
            <div className="w-full flex items-end" style={{ height: 44 }}>
              <div
                className={`w-full rounded-t barre ${b.n > 0 ? "bg-accent" : "bg-carte2"}`}
                style={{ height: b.n > 0 ? `${(Math.min(b.n, 3) / 3) * 100}%` : 5 }}
              />
            </div>
            <span className="text-brume chiffres" style={{ fontSize: 10 }}>
              {b.semaine.slice(8, 10)}/{b.semaine.slice(5, 7)}
            </span>
          </div>
        ))}
      </div>
      <p className="text-brume mt-2 text-center text-xs">Séances par semaine · 6 dernières semaines</p>
    </div>
  );
}

function Accordeon({ icone: Icone, titre, texte, accent }) {
  const [ouvert, setOuvert] = useState(false);
  return (
    <div className={`rounded-2xl border bg-carte overflow-hidden ${accent ? "bordure-accent-douce" : "border-ligne"}`}>
      <button
        onClick={() => setOuvert(!ouvert)}
        className="w-full flex items-center gap-3 p-4 text-left min-h-14"
        aria-expanded={ouvert}
      >
        <span className="h-10 w-10 rounded-xl bg-accent-soft flex items-center justify-center shrink-0 transi">
          <Icone size={20} className="text-accent transi" />
        </span>
        <span className="flex-1 font-bold text-base">{titre}</span>
        <ChevronDown size={20} className={`text-brume shrink-0 transi ${ouvert ? "rotate-180" : ""}`} />
      </button>
      {ouvert && (
        <div className="px-4 pb-4 vue space-y-2">
          {texte.map((p, i) => (
            <p key={i} className="text-sm leading-relaxed text-douce">{p}</p>
          ))}
        </div>
      )}
    </div>
  );
}

/* Écran de verrouillage — code d'accès */
function EcranVerrou({ profil, erreur, occupe, surValider }) {
  const [code, setCode] = useState("");
  return (
    <div data-profil={profil} className="coquille bg-fond text-encre font-jakarta flex items-center justify-center px-6">
      <div className="w-full max-w-sm rounded-3xl bg-carte border border-ligne p-8 text-center vue">
        <span className="mx-auto h-16 w-16 rounded-2xl bg-accent flex items-center justify-center">
          <Dumbbell size={30} className="text-accent-ink" strokeWidth={2.5} />
        </span>
        <h1 className="mt-5 text-2xl font-extrabold tracking-tight">Coachwork</h1>
        <p className="text-brume text-sm mt-2 leading-relaxed">
          Cette app est protégée. Entre le code d’accès pour continuer.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (code.trim() && !occupe) surValider(code.trim());
          }}
        >
          <input
            type="password"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="Code d’accès"
            autoComplete="off"
            className="mt-5 w-full rounded-2xl bg-carte2 px-4 text-center font-extrabold text-lg outline-none placeholder-slate-600 chiffres"
            style={{ height: 56 }}
            aria-label="Code d’accès"
          />
          {erreur && <p className="text-rouge text-xs mt-3">{erreur}</p>}
          <button
            type="submit"
            disabled={occupe || !code.trim()}
            className={`mt-4 w-full rounded-2xl font-extrabold text-base transi ${
              occupe || !code.trim() ? "bg-carte2 text-brume" : "bg-accent text-accent-ink active:scale-98"
            }`}
            style={{ height: 56 }}
          >
            {occupe ? "Vérification…" : "Entrer"}
          </button>
        </form>
      </div>
    </div>
  );
}

/* Gèle le défilement du fond tant qu'une feuille ou un sélecteur est ouvert */
let nbVerrousScroll = 0;
function useVerrouScroll() {
  useEffect(() => {
    nbVerrousScroll++;
    document.body.classList.add("fige");
    return () => {
      nbVerrousScroll--;
      if (nbVerrousScroll <= 0) document.body.classList.remove("fige");
    };
  }, []);
}

/* Bouton de suppression en deux temps (pas de fenêtre de confirmation) */
function BoutonSuppression({ surConfirmer, etiquette }) {
  const [arme, setArme] = useState(false);
  useEffect(() => {
    if (!arme) return;
    const t = setTimeout(() => setArme(false), 3000);
    return () => clearTimeout(t);
  }, [arme]);
  return arme ? (
    <button
      onClick={() => { setArme(false); surConfirmer(); }}
      className="h-11 px-3 rounded-xl bg-rouge-doux text-rouge text-xs font-bold shrink-0 transi"
    >
      Confirmer ?
    </button>
  ) : (
    <button
      onClick={() => setArme(true)}
      aria-label={etiquette}
      className="h-11 w-11 rounded-xl bg-carte2 flex items-center justify-center shrink-0 active:scale-95 transi"
    >
      <Trash2 size={17} className="text-brume" />
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* Application                                                         */
/* ------------------------------------------------------------------ */

function etatVide() {
  return { seances: {}, charges: {}, historique: [], mode: "fullbody", mesures: { age: "", taille: "", poids: "" } };
}

export default function App() {
  const [profil, setProfil] = useState("esteban");
  const [chargement, setChargement] = useState(true);
  const [store, setStore] = useState({ esteban: etatVide(), valerie: etatVide() });
  const [programmesPerso, setProgrammesPerso] = useState([]);
  const [exosPerso, setExosPerso] = useState([]);
  const [syncEtat, setSyncEtat] = useState("off"); // "ok" | "off"
  const [onglet, setOnglet] = useState("semaine");
  const [ouverte, setOuverte] = useState(null); // id de séance ou null
  const [edition, setEdition] = useState(null); // null | {id} | {nouveau:true}
  const [minuteur, setMinuteur] = useState(null); // {finA, total, label}
  const [, setTic] = useState(0); // re-rendu périodique pendant le repos
  const [fete, setFete] = useState(null); // {titre, deja, total}
  const [verrou, setVerrou] = useState(null); // null | {erreur?, occupe?}
  const vivantRef = useRef(true);

  async function afficherDonnees() {
    const { persos, exosPerso: ep, res } = await chargerTout();
    let pSauve = await lire("app:profil");
    if (pSauve === "maman") pSauve = "valerie";
    if (!vivantRef.current) return;
    setProgrammesPerso(persos);
    setExosPerso(ep);
    setStore(res);
    if (pSauve === "valerie" || pSauve === "esteban") setProfil(pSauve);
    setChargement(false);
  }

  /* ---- chargement initial : horodatages → code → serveur → état local ---- */
  useEffect(() => {
    vivantRef.current = true;
    (async () => {
      horodatages = (await lire("app:horodatages")) || {};
      codeApp = await lire("app:code");
      let statut = "off";
      try {
        statut = await tirerDepuisServeur();
      } catch (e) {}
      if (!vivantRef.current) return;
      if (statut === "code") {
        setVerrou({});
        return;
      }
      setSyncEtat(statut === "ok" || statut === "maj" ? "ok" : "off");
      await afficherDonnees();
    })();
    return () => { vivantRef.current = false; };
  }, []);

  /* ---- déverrouillage par code d'accès ---- */
  async function deverrouiller(code) {
    setVerrou({ occupe: true });
    codeApp = code;
    let statut;
    try {
      statut = await tirerDepuisServeur();
    } catch (e) {
      codeApp = null;
      setVerrou({ erreur: "Serveur injoignable — réessaie dans un instant." });
      return;
    }
    if (statut === "code") {
      codeApp = null;
      setVerrou({ erreur: "Code incorrect, réessaie." });
      return;
    }
    ecrireBrut("app:code", code);
    setSyncEtat("ok");
    setVerrou(null);
    await afficherDonnees();
  }

  /* ---- rafraîchissement périodique quand la synchro est active ---- */
  useEffect(() => {
    if (syncEtat !== "ok") return;
    const rafraichir = async () => {
      try {
        const statut = await tirerDepuisServeur();
        if (statut === "maj") {
          const { persos, exosPerso: ep, res } = await chargerTout();
          setProgrammesPerso(persos);
          setExosPerso(ep);
          setStore(res);
        } else if (statut === "code") {
          /* le code a été changé côté serveur : on reverrouille */
          codeApp = null;
          ecrireBrut("app:code", null);
          setVerrou({ erreur: "Le code d’accès a changé — entre le nouveau code." });
        }
      } catch (e) {}
    };
    const t = setInterval(rafraichir, 45000);
    const vis = () => { if (document.visibilityState === "visible") rafraichir(); };
    document.addEventListener("visibilitychange", vis);
    return () => { clearInterval(t); document.removeEventListener("visibilitychange", vis); };
  }, [syncEtat]);

  /* ---- enregistrement du service worker (notifications + hors-ligne) ---- */
  useEffect(() => {
    try {
      if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
    } catch (e) {}
  }, []);

  /* ---- minuteur de repos : basé sur l'horloge, il continue même
     si l'app passe en arrière-plan ---- */
  useEffect(() => {
    if (!minuteur) return;
    const tic = () => setTic((x) => x + 1);
    const t = setInterval(tic, 500);
    document.addEventListener("visibilitychange", tic);
    return () => { clearInterval(t); document.removeEventListener("visibilitychange", tic); };
  }, [minuteur !== null]);

  const resteRepos = minuteur ? Math.max(0, Math.ceil((minuteur.finA - Date.now()) / 1000)) : 0;
  const finie = minuteur !== null && resteRepos === 0;
  useEffect(() => {
    if (!finie) return;
    try { if (navigator.vibrate) navigator.vibrate([150, 90, 150]); } catch (e) {}
    notifier("Repos terminé — à toi !", minuteur.label, { renotify: true, vibrate: [150, 90, 150] });
    const t = setTimeout(() => setMinuteur(null), 4000);
    return () => clearTimeout(t);
  }, [finie]);

  function lancerRepos(exo) {
    try {
      if ("Notification" in window && Notification.permission === "default") {
        Notification.requestPermission();
      }
    } catch (e) {}
    const finA = Date.now() + exo.repos * 1000;
    setMinuteur({ finA, total: exo.repos, label: exo.nom });
    notifier("Repos en cours", `${exo.nom} — fin à ${heureCourte(finA)}`, { silent: true });
    planifierPushRepos(finA, exo.nom);
  }

  function prolongerRepos() {
    setMinuteur((c) => {
      if (!c) return c;
      const finA = Math.max(c.finA, Date.now()) + 30000;
      notifier("Repos en cours", `${c.label} — fin à ${heureCourte(finA)}`, { silent: true });
      planifierPushRepos(finA, c.label);
      return { ...c, finA, total: c.total + 30 };
    });
  }

  function arreterRepos() {
    setMinuteur(null);
    fermerNotifications();
    annulerPushRepos();
  }

  const defileur = useRef(null);
  useEffect(() => {
    if (defileur.current) defileur.current.scrollTo({ top: 0 });
  }, [ouverte, onglet, edition]);

  /* ---- exercices & programmes ---- */
  const dicoExos = useMemo(() => {
    const d = { ...EXOS };
    for (const e of exosPerso) d[e.id] = e;
    return d;
  }, [exosPerso]);
  const programmes = useMemo(
    () => [...PROGRAMMES_BASE, ...programmesPerso.map((p) => construirePerso(p, dicoExos))],
    [programmesPerso, dicoExos]
  );
  const toutesSeances = useMemo(() => programmes.flatMap((p) => p.seances), [programmes]);
  /* catalogue ordonné complet (variantes swipe) */
  const tousExos = useMemo(
    () => [...ZONES.flatMap(([, ids]) => ids).map((id) => EXOS[id]), ...exosPerso],
    [exosPerso]
  );

  function sauverExoPerso(exo) {
    setExosPerso((prev) => {
      const liste = prev.some((e) => e.id === exo.id)
        ? prev.map((e) => (e.id === exo.id ? exo : e))
        : [...prev, exo];
      ecrire("app:exosPerso", liste);
      return liste;
    });
  }

  function supprimerExoPerso(id) {
    setExosPerso((prev) => {
      const liste = prev.filter((e) => e.id !== id);
      ecrire("app:exosPerso", liste);
      return liste;
    });
  }

  /* ---- mutations ---- */
  const donnees = store[profil];
  const progActuel = programmes.find((p) => p.id === donnees.mode) || programmes[0];

  function choisirProfil(p) {
    setProfil(p);
    ecrire("app:profil", p);
  }

  /* les feuilles sont portalées sur <body> : il porte aussi l'accent du profil */
  useEffect(() => {
    document.body.dataset.profil = profil;
  }, [profil]);

  function basculerEtape(sid, eid) {
    setStore((prev) => {
      const p = prev[profil];
      const seance = normaliserSeance(p.seances[sid]);
      const maj = { ...seance, coches: { ...seance.coches, [eid]: !seance.coches[eid] } };
      ecrire(`${profil}:seance:${sid}`, maj);
      return { ...prev, [profil]: { ...p, seances: { ...p.seances, [sid]: maj } } };
    });
  }

  /* n séries faites sur un emplacement d'exercice ; il se coche tout seul
     quand toutes les séries prévues sont faites */
  function noterSeries(sid, slotId, cible, n) {
    setStore((prev) => {
      const p = prev[profil];
      const seance = normaliserSeance(p.seances[sid]);
      const maj = {
        ...seance,
        coches: { ...seance.coches, [slotId]: n >= cible },
        series: { ...seance.series, [slotId]: n },
      };
      ecrire(`${profil}:seance:${sid}`, maj);
      return { ...prev, [profil]: { ...p, seances: { ...p.seances, [sid]: maj } } };
    });
  }

  /* remplace l'exercice d'un emplacement par une variante (humeur du jour,
     machine prise…) ; revient au programme d'origine à la validation */
  function remplacerExo(sid, slotId, nouvelId) {
    setStore((prev) => {
      const p = prev[profil];
      const seance = normaliserSeance(p.seances[sid]);
      const remplacements = { ...seance.remplacements };
      if (nouvelId === slotId) delete remplacements[slotId];
      else remplacements[slotId] = nouvelId;
      const maj = { ...seance, remplacements };
      ecrire(`${profil}:seance:${sid}`, maj);
      return { ...prev, [profil]: { ...p, seances: { ...p.seances, [sid]: maj } } };
    });
  }

  function noterCharge(exoId, valeur) {
    setStore((prev) => {
      const p = prev[profil];
      const charges = { ...p.charges, [exoId]: valeur };
      ecrire(`${profil}:charges`, charges);
      return { ...prev, [profil]: { ...p, charges } };
    });
  }

  function noterMesure(champ, valeur) {
    setStore((prev) => {
      const p = prev[profil];
      const mesures = { ...p.mesures, [champ]: valeur };
      ecrire(`${profil}:mesures`, mesures);
      return { ...prev, [profil]: { ...p, mesures } };
    });
  }

  function choisirMode(m) {
    setStore((prev) => {
      const p = prev[profil];
      ecrire(`${profil}:mode`, m);
      return { ...prev, [profil]: { ...p, mode: m } };
    });
  }

  function majHistorique(historique) {
    setStore((prev) => {
      const p = prev[profil];
      ecrire(`${profil}:assiduite`, { historique });
      return { ...prev, [profil]: { ...p, historique } };
    });
  }

  function terminerSeance(seance) {
    const auj = cleJour();
    /* instantané de la séance : exercices réellement faits, séries et charges du jour */
    const etatSeance = normaliserSeance(donnees.seances[seance.id]);
    const detail = seance.exos
      .filter((slot) => etatSeance.coches[slot.id])
      .map((slot) => {
        const exo = (etatSeance.remplacements[slot.id] && dicoExos[etatSeance.remplacements[slot.id]]) || slot;
        if (seance.tabata) {
          return {
            id: exo.id,
            nom: exo.nom,
            series: (seance.rounds && seance.rounds[slot.id]) || 8,
            reps: `rounds tabata ${seance.tabata.travail}/${seance.tabata.repos}`,
            charge: exo.sansCharge ? null : donnees.charges[exo.id] || null,
          };
        }
        return {
          id: exo.id,
          nom: exo.nom,
          series: etatSeance.series[slot.id] || exo.series,
          reps: exo.reps,
          charge: exo.sansCharge ? null : donnees.charges[exo.id] || null,
        };
      });
    const poidsKg = parseCharge(donnees.mesures.poids);
    const kcal = estimerCaloriesSeance(detail, poidsKg, seance.tabata || null);
    /* chaque validation est enregistrée — y compris la même séance refaite
       dans la semaine (ça arrive, et ça compte) */
    const repeat = donnees.historique.some((h) => h.s === seance.id && lundiDe(h.d) === lundiDe(auj));
    const historique = [...donnees.historique, { s: seance.id, d: auj, titre: seance.titre, detail, kcal }];
    const vierge = { coches: {}, series: {}, remplacements: {} };
    setStore((prev) => {
      const p = prev[profil];
      ecrire(`${profil}:assiduite`, { historique });
      ecrire(`${profil}:seance:${seance.id}`, vierge);
      return { ...prev, [profil]: { ...p, historique, seances: { ...p.seances, [seance.id]: vierge } } };
    });
    setOuverte(null);
    setFete({ titre: seance.titre, repeat, total: historique.length, kcal });
  }

  /* Valide une séance écourtée en gardant la version faite comme programme */
  function terminerAvecSauvegarde(seance, exoIdsFaits) {
    if (exoIdsFaits.length) {
      const prog = {
        id: `perso-${Date.now()}`,
        nom: `${seance.titre} · express`,
        seances: [{ nom: `${seance.titre} · express`, exoIds: exoIdsFaits }],
      };
      const liste = [...programmesPerso, prog];
      setProgrammesPerso(liste);
      ecrire("app:programmesPerso", liste);
    }
    terminerSeance(seance);
  }

  /* Annule la DERNIÈRE validation de cette séance cette semaine (cochée par
     erreur) — si elle a été faite plusieurs fois, n'en retire qu'une */
  function retirerValidation(sid) {
    const lundiActuel = lundiDe(cleJour());
    let idxDernier = -1;
    donnees.historique.forEach((h, i) => {
      if (h.s === sid && lundiDe(h.d) === lundiActuel) idxDernier = i;
    });
    if (idxDernier === -1) return;
    majHistorique(donnees.historique.filter((_, i) => i !== idxDernier));
  }

  function supprimerEntree(entree) {
    majHistorique(donnees.historique.filter((h) => h !== entree));
  }

  function sauverProgramme(brouillon, idExistant) {
    const id = idExistant || `perso-${Date.now()}`;
    const prog = {
      id,
      nom: brouillon.nom.trim() || "Mon programme",
      seances: brouillon.seances.map((s, i) => ({
        nom: s.nom.trim() || `Séance ${i + 1}`,
        exoIds: [...s.exoIds],
        ...(s.tabata ? { tabata: s.tabata, rounds: s.rounds || {} } : {}),
      })),
    };
    const liste = idExistant
      ? programmesPerso.map((p) => (p.id === idExistant ? prog : p))
      : [...programmesPerso, prog];
    setProgrammesPerso(liste);
    ecrire("app:programmesPerso", liste);
    choisirMode(id);
    setEdition(null);
  }

  function supprimerProgramme(id) {
    const liste = programmesPerso.filter((p) => p.id !== id);
    setProgrammesPerso(liste);
    ecrire("app:programmesPerso", liste);
    if (donnees.mode === id) choisirMode("fullbody");
    setEdition(null);
  }

  /* ---- statistiques d’assiduité ---- */
  const stats = useMemo(() => {
    const lundiActuel = lundiDe(cleJour());
    const idsParSemaine = new Map(); // séances distinctes (badge « Faite », série)
    const nParSemaine = new Map();   // total de validations (anneau, barres)
    for (const h of donnees.historique) {
      const w = lundiDe(h.d);
      if (!idsParSemaine.has(w)) { idsParSemaine.set(w, new Set()); nParSemaine.set(w, 0); }
      idsParSemaine.get(w).add(h.s);
      nParSemaine.set(w, nParSemaine.get(w) + 1);
    }
    const cetteSemaine = idsParSemaine.get(lundiActuel) || new Set();
    const nCetteSemaine = nParSemaine.get(lundiActuel) || 0;
    let serie = 0;
    let w = idsParSemaine.has(lundiActuel) ? lundiActuel : semainesAvant(lundiActuel, 1);
    while (idsParSemaine.has(w) && idsParSemaine.get(w).size > 0) { serie++; w = semainesAvant(w, 1); }
    const barres = [];
    for (let i = 5; i >= 0; i--) {
      const wk = semainesAvant(lundiActuel, i);
      barres.push({ semaine: wk, n: nParSemaine.get(wk) || 0 });
    }
    return { total: donnees.historique.length, cetteSemaine, nCetteSemaine, serie, barres };
  }, [store, profil]);

  /* ---- écran de verrouillage ---- */
  if (verrou) {
    return (
      <EcranVerrou
        profil={profil}
        erreur={verrou.erreur}
        occupe={!!verrou.occupe}
        surValider={deverrouiller}
      />
    );
  }

  /* ---- écran de chargement ---- */
  if (chargement) {
    return (
      <div data-profil={profil} className="coquille bg-fond text-encre font-jakarta flex flex-col items-center justify-center gap-4">
        <Dumbbell size={40} className="text-accent pulsation" />
        <p className="text-brume text-sm">Chargement de vos séances…</p>
      </div>
    );
  }

  const seanceOuverte = toutesSeances.find((s) => s.id === ouverte) || null;

  return (
    <div ref={defileur} data-profil={profil} className="coquille bg-fond text-encre font-jakarta">
      <div className="mx-auto max-w-md px-4 pb-32">

        {/* ---------- en-tête ---------- */}
        <header className="pt-5 pb-4">
          <div className="flex items-center gap-2.5">
            <span className="h-9 w-9 rounded-xl bg-accent flex items-center justify-center transi">
              <Dumbbell size={20} className="text-accent-ink" strokeWidth={2.5} />
            </span>
            <div className="flex-1">
              <h1 className="text-lg font-extrabold leading-none tracking-tight">Coachwork</h1>
              <p className="text-brume text-xs mt-0.5">3 séances / semaine, à deux</p>
            </div>
            <span
              className="flex items-center gap-1.5 text-xs text-brume"
              title={syncEtat === "ok" ? "Synchronisé entre vos téléphones" : "Données sur cet appareil uniquement"}
            >
              {syncEtat === "ok"
                ? <Cloud size={16} className="text-accent transi" />
                : <CloudOff size={16} />}
            </span>
          </div>

          {/* sélecteur de profil */}
          <div className="mt-4 grid grid-cols-2 gap-2" role="group" aria-label="Choisir le profil">
            {Object.keys(PROFILS).map((id) => {
              const actif = profil === id;
              const nom = nomAffiche(store[id], id);
              return (
                <button
                  key={id}
                  onClick={() => choisirProfil(id)}
                  className={`h-14 rounded-2xl flex items-center justify-center gap-2.5 font-bold transi border ${
                    actif
                      ? "bg-accent text-accent-ink border-transparent"
                      : "bg-carte text-brume border-ligne active:scale-95"
                  }`}
                >
                  <span
                    className={`h-8 w-8 rounded-full flex items-center justify-center text-sm font-extrabold transi ${
                      actif ? "encre-sur-accent" : "bg-carte2"
                    }`}
                  >
                    {nom.charAt(0).toUpperCase()}
                  </span>
                  <span className="truncate" style={{ maxWidth: 110 }}>{nom}</span>
                </button>
              );
            })}
          </div>
        </header>

        {/* ---------- contenu ---------- */}
        {edition ? (
          <VueEditeur
            initial={edition.id ? programmesPerso.find((p) => p.id === edition.id) : null}
            dico={dicoExos}
            exosPerso={exosPerso}
            surSauverExo={sauverExoPerso}
            surSupprimerExo={supprimerExoPerso}
            surSauver={(brouillon) => sauverProgramme(brouillon, edition.id || null)}
            surSupprimer={edition.id ? () => supprimerProgramme(edition.id) : null}
            surFermer={() => setEdition(null)}
          />
        ) : seanceOuverte ? (
          <VueSeance
            seance={seanceOuverte}
            profil={profil}
            etat={normaliserSeance(donnees.seances[seanceOuverte.id])}
            charges={donnees.charges}
            dico={dicoExos}
            tousExos={tousExos}
            faiteCetteSemaine={stats.cetteSemaine.has(seanceOuverte.id)}
            surRetour={() => setOuverte(null)}
            surCoche={(eid) => basculerEtape(seanceOuverte.id, eid)}
            surSeries={(slotId, cible, n) => noterSeries(seanceOuverte.id, slotId, cible, n)}
            surRemplacer={(slotId, nouvelId) => remplacerExo(seanceOuverte.id, slotId, nouvelId)}
            surCharge={noterCharge}
            surRepos={lancerRepos}
            historique={donnees.historique}
            surFin={() => terminerSeance(seanceOuverte)}
            surFinAvecSauvegarde={(exoIds) => terminerAvecSauvegarde(seanceOuverte, exoIds)}
            surAnnuler={() => retirerValidation(seanceOuverte.id)}
          />
        ) : (
          <>
            {/* onglets */}
            <div className="grid grid-cols-4 gap-1 rounded-2xl bg-carte p-1 border border-ligne mb-5">
              {[["semaine", "Semaine"], ["progres", "Progrès"], ["historique", "Historique"], ["conseils", "Conseils"]].map(([id, nom]) => (
                <button
                  key={id}
                  onClick={() => setOnglet(id)}
                  className={`h-11 rounded-xl text-xs font-bold transi ${
                    onglet === id ? "bg-accent text-accent-ink" : "text-brume"
                  }`}
                >
                  {nom}
                </button>
              ))}
            </div>

            {onglet === "semaine" ? (
              <VueSemaine
                profil={profil}
                stats={stats}
                donnees={donnees}
                programmes={programmes}
                progActuel={progActuel}
                syncEtat={syncEtat}
                surOuvrir={setOuverte}
                surMode={choisirMode}
                surMesure={noterMesure}
                surCreer={() => setEdition({ nouveau: true })}
                surEditer={(id) => setEdition({ id })}
              />
            ) : onglet === "progres" ? (
              <VueProgres profil={profil} historique={donnees.historique} dico={dicoExos} />
            ) : onglet === "historique" ? (
              <VueHistorique
                profil={profil}
                historique={donnees.historique}
                toutesSeances={toutesSeances}
                surSupprimer={supprimerEntree}
              />
            ) : (
              <div key={`conseils-${profil}`} className="vue space-y-3">
                {CONSEILS.map((c) => (
                  <Accordeon
                    key={c.id}
                    icone={c.icone}
                    titre={c.titre}
                    texte={c.texte}
                    accent={profil === "valerie" && c.id === "cinquante-quatre"}
                  />
                ))}
                <p className="text-brume text-center text-xs pt-2 leading-relaxed">
                  Ce programme ne remplace pas un avis médical.<br />Fait avec soin pour Esteban & Valérie.
                </p>
              </div>
            )}
          </>
        )}
      </div>

      {/* ---------- minuteur de repos flottant ---------- */}
      {minuteur && (
        <div className="fixed left-4 right-4 z-40 mx-auto max-w-md vue barre-flottante">
          <div className="rounded-2xl bg-carte border bordure-accent-douce p-4 shadow-lg">
            {resteRepos > 0 ? (
              <>
                <div className="flex items-center gap-3">
                  <Timer size={20} className="text-accent shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-xs text-brume truncate">Repos — {minuteur.label}</p>
                    <p className="text-2xl font-extrabold chiffres leading-tight">
                      {Math.floor(resteRepos / 60)}:{String(resteRepos % 60).padStart(2, "0")}
                    </p>
                  </div>
                  <button
                    onClick={prolongerRepos}
                    className="h-11 px-3 rounded-xl bg-carte2 text-sm font-bold flex items-center gap-1 active:scale-95 transi"
                  >
                    <Plus size={16} /> 30 s
                  </button>
                  <button
                    onClick={arreterRepos}
                    aria-label="Arrêter le repos"
                    className="h-11 w-11 rounded-xl bg-carte2 flex items-center justify-center active:scale-95 transi"
                  >
                    <X size={18} className="text-brume" />
                  </button>
                </div>
                <div className="mt-3 h-1.5 rounded-full bg-carte2 overflow-hidden">
                  <div
                    className="h-full rounded-full bg-accent barre"
                    style={{ width: `${(resteRepos / minuteur.total) * 100}%` }}
                  />
                </div>
              </>
            ) : (
              <div className="flex items-center gap-3">
                <Sparkles size={20} className="text-accent" />
                <p className="font-bold flex-1">Repos terminé — à toi !</p>
                <button
                  onClick={arreterRepos}
                  aria-label="Fermer"
                  className="h-11 w-11 rounded-xl bg-carte2 flex items-center justify-center"
                >
                  <X size={18} className="text-brume" />
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ---------- fête de fin de séance ---------- */}
      {fete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-6 voile" onClick={() => setFete(null)}>
          <div className="w-full max-w-sm rounded-3xl bg-carte border border-ligne p-8 text-center surgit" onClick={(e) => e.stopPropagation()}>
            <span className="mx-auto h-20 w-20 rounded-full bg-accent-soft flex items-center justify-center">
              <Flame size={38} className="text-accent" />
            </span>
            <h2 className="mt-5 text-2xl font-extrabold tracking-tight">Séance validée !</h2>
            <p className="mt-1 text-brume text-sm">{fete.titre}</p>
            <p className="mt-3 text-douce text-sm leading-relaxed">
              {fete.repeat
                ? "Deuxième fois cette semaine sur cette séance — double dose, chapeau. Elle compte, évidemment."
                : MESSAGES_FETE[fete.total % MESSAGES_FETE.length]}
            </p>
            {fete.kcal ? (
              <div className="mt-4 inline-flex items-center gap-2 rounded-full bg-accent-soft px-3 py-1.5">
                <Flame size={15} className="text-accent transi" />
                <span className="text-sm font-extrabold chiffres text-accent transi">≈ {fete.kcal} kcal</span>
                <span className="text-xs text-brume">dépensées</span>
              </div>
            ) : null}
            <p className="mt-4 text-brume text-xs chiffres">
              {stats.total} séance{stats.total > 1 ? "s" : ""} au total · {stats.nCetteSemaine} cette semaine
            </p>
            <button
              onClick={() => setFete(null)}
              className="mt-6 w-full rounded-2xl bg-accent text-accent-ink font-extrabold text-base transi active:scale-95"
              style={{ height: 52 }}
            >
              Retour à ma semaine
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Vue « Ma semaine »                                                  */
/* ------------------------------------------------------------------ */

function VueSemaine({
  profil, stats, donnees, programmes, progActuel, syncEtat,
  surOuvrir, surMode, surMesure, surCreer, surEditer,
}) {
  const p = PROFILS[profil];
  const nom = nomAffiche(donnees, profil);
  const dateFr = FORMAT_JOUR.format(new Date());

  return (
    <div key={profil} className="vue space-y-5">
      <div>
        <p className="text-xs uppercase tracking-widest text-accent font-bold transi">{dateFr}</p>
        <h2 className="text-2xl font-extrabold tracking-tight mt-1">
          Salut {nom} !
        </h2>
        <p className="text-brume text-sm mt-1">{p.detail} — on avance à ton rythme.</p>
      </div>

      {/* assiduité */}
      <section className="rounded-3xl bg-carte border border-ligne p-5">
        <div className="flex items-center gap-5">
          <Anneau
            fait={stats.nCetteSemaine}
            total={progActuel.seances.length}
          />
          <div className="flex-1 space-y-3">
            <div className="flex items-center gap-3">
              <span className="h-10 w-10 rounded-xl bg-accent-soft flex items-center justify-center transi">
                <Dumbbell size={19} className="text-accent transi" />
              </span>
              <div>
                <p className="text-xl font-extrabold chiffres leading-none">{stats.total}</p>
                <p className="text-brume text-xs mt-0.5">séances au total</p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <span className="h-10 w-10 rounded-xl bg-accent-soft flex items-center justify-center transi">
                <Flame size={19} className="text-accent transi" />
              </span>
              <div>
                <p className="text-xl font-extrabold chiffres leading-none">{stats.serie}</p>
                <p className="text-brume text-xs mt-0.5">
                  semaine{stats.serie > 1 ? "s" : ""} d’affilée
                </p>
              </div>
            </div>
          </div>
        </div>
        <div className="mt-5 pt-4 border-t border-ligne">
          <Barres barres={stats.barres} />
        </div>
      </section>

      {/* programme */}
      <section>
        <h3 className="text-xs uppercase tracking-widest text-brume font-bold mb-3">
          Mon programme
        </h3>
        <div className="space-y-2">
          {programmes.map((prog) => {
            const actif = progActuel.id === prog.id;
            return (
              <div
                key={prog.id}
                className={`w-full rounded-2xl bg-carte border p-1 flex items-center transi ${
                  actif ? "bordure-accent-douce" : "border-ligne"
                }`}
              >
                <button
                  onClick={() => surMode(prog.id)}
                  className="flex-1 min-w-0 flex items-center gap-3 p-3 text-left"
                >
                  <span
                    className={`h-5 w-5 rounded-full border-2 flex items-center justify-center shrink-0 transi ${
                      actif ? "bg-accent border-transparent" : "border-slate-600"
                    }`}
                  >
                    {actif && <Check size={13} strokeWidth={4} className="text-accent-ink" />}
                  </span>
                  <span className="min-w-0">
                    <span className={`font-bold text-sm block ${actif ? "" : "text-douce"}`}>{prog.nom}</span>
                    <span className="text-brume text-xs block truncate">
                      {prog.seances.map((s) => s.titre.split(" — ").pop()).join(" · ")}
                    </span>
                  </span>
                </button>
                {prog.perso && (
                  <button
                    onClick={() => surEditer(prog.id)}
                    aria-label={`Modifier le programme ${prog.nom}`}
                    className="h-11 w-11 rounded-xl flex items-center justify-center shrink-0 mr-1 active:scale-95 transi"
                  >
                    <Pencil size={16} className="text-brume" />
                  </button>
                )}
              </div>
            );
          })}
          <button
            onClick={surCreer}
            className="w-full h-12 rounded-2xl border border-dashed border-slate-600 text-brume text-sm font-bold flex items-center justify-center gap-2 active:scale-98 transi"
          >
            <Plus size={17} /> Créer un programme
          </button>
        </div>
        <p className="text-brume text-xs mt-2 leading-relaxed">{progActuel.description}</p>
      </section>

      {/* séances */}
      <section>
        <h3 className="text-xs uppercase tracking-widest text-brume font-bold mb-3">
          Mes séances de la semaine
        </h3>
        <div className="space-y-3">
          {progActuel.seances.map((s) => {
            const faite = stats.cetteSemaine.has(s.id);
            const etatSeance = donnees.seances[s.id] || {};
            const nChecks = Object.values(etatSeance.coches || etatSeance).filter((v) => v === true).length;
            const enCours = !faite && nChecks > 0;
            return (
              <button
                key={s.id}
                onClick={() => surOuvrir(s.id)}
                className="w-full rounded-2xl bg-carte border border-ligne p-4 flex items-center gap-4 text-left active:scale-98 transi"
              >
                <span
                  className={`h-12 w-12 rounded-xl flex items-center justify-center text-xl font-extrabold shrink-0 transi ${
                    faite ? "bg-accent text-accent-ink" : "bg-accent-soft text-accent"
                  }`}
                >
                  {faite ? <Check size={26} strokeWidth={3} /> : s.badge}
                </span>
                <span className="flex-1 min-w-0">
                  <span className="font-bold text-base block">{s.titre}</span>
                  <span className="text-brume text-xs block truncate mt-0.5">{s.resume}</span>
                </span>
                <span
                  className={`text-xs font-bold px-2.5 py-1.5 rounded-full shrink-0 transi ${
                    faite
                      ? "bg-accent-soft text-accent"
                      : enCours
                      ? "bg-carte2 text-encre"
                      : "bg-carte2 text-brume"
                  }`}
                >
                  {faite ? "Faite" : enCours ? "En cours" : "À faire"}
                </span>
              </button>
            );
          })}
        </div>
        <p className="text-brume text-xs mt-3 leading-relaxed">
          L’ordre est libre, avec au moins un jour de repos entre deux séances.
          Chaque séance dure 45 à 60 min. Séance validée par erreur ? Ouvre-la pour l’annuler,
          ou passe par l’onglet Historique.
        </p>
      </section>

      {/* mesures */}
      <section className="rounded-3xl bg-carte border border-ligne p-5">
        <div className="flex items-center gap-3 mb-4">
          <span className="h-10 w-10 rounded-xl bg-accent-soft flex items-center justify-center transi">
            <Ruler size={19} className="text-accent transi" />
          </span>
          <div>
            <h3 className="font-bold text-base leading-none">Mes repères</h3>
            <p className="text-brume text-xs mt-1">Ajustables quand tu veux</p>
          </div>
        </div>
        <label className="block mb-3">
          <span className="text-xs text-brume block mb-1.5">Prénom</span>
          <input
            type="text"
            value={donnees.mesures.nom || ""}
            onChange={(e) => surMesure("nom", e.target.value)}
            placeholder={PROFILS[profil].nom}
            className="w-full rounded-xl bg-carte2 px-3 text-center font-extrabold text-base outline-none placeholder-slate-600"
            style={{ height: 48 }}
            aria-label="Prénom"
          />
        </label>
        <div className="grid grid-cols-3 gap-2">
          {[["age", "Âge", "ans"], ["taille", "Taille", "cm"], ["poids", "Poids", "kg"]].map(
            ([champ, etiquette, unite]) => (
              <label key={champ} className="block">
                <span className="text-xs text-brume block mb-1.5">{etiquette}</span>
                <span className="flex items-baseline gap-1 rounded-xl bg-carte2 px-3" style={{ height: 48 }}>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={donnees.mesures[champ] || ""}
                    onChange={(e) => surMesure(champ, e.target.value)}
                    placeholder="—"
                    className="w-full min-w-0 bg-transparent text-center font-extrabold chiffres text-base outline-none placeholder-slate-600"
                    style={{ height: 46 }}
                    aria-label={`${etiquette} (${unite})`}
                  />
                  <span className="text-xs text-brume shrink-0">{unite}</span>
                </span>
              </label>
            )
          )}
        </div>
        <p className="text-brume text-xs mt-3 leading-relaxed">
          Le poids n’est qu’un repère parmi d’autres — les séances faites et les charges qui
          montent racontent mieux l’histoire.
        </p>
      </section>

      {/* note dédiée */}
      {profil === "valerie" ? (
        <section className="rounded-2xl bg-carte border bordure-accent-douce p-4 flex gap-3">
          <HeartPulse size={20} className="text-accent shrink-0 mt-0.5" />
          <p className="text-sm leading-relaxed text-douce">
            <strong className="text-encre">Le renfo, ta meilleure alliée.</strong> Il entretient la
            densité osseuse et le muscle — exactement ce qu’il faut à 54 ans. Machines assises,
            cardio sans impact, et zéro pression : la douceur d’abord, toujours.
          </p>
        </section>
      ) : (
        <section className="rounded-2xl bg-carte border border-ligne p-4 flex gap-3">
          <TrendingUp size={20} className="text-accent shrink-0 mt-0.5" />
          <p className="text-sm leading-relaxed text-douce">
            <strong className="text-encre">Ta force, c’est la régularité.</strong> Charge après
            charge, note tout : dans 8 semaines, tu relèveras ces chiffres avec un grand sourire.
          </p>
        </section>
      )}

      <section className="rounded-2xl bg-carte border border-ligne p-4 flex gap-3">
        {syncEtat === "ok" ? (
          <>
            <Cloud size={20} className="text-accent shrink-0 mt-0.5 transi" />
            <p className="text-xs leading-relaxed text-brume">
              <strong className="text-douce">Synchro activée.</strong> Vos deux téléphones voient
              les mêmes données : séances validées, charges, programmes. Tu peux suivre le
              programme de Valérie depuis ici, et inversement.
            </p>
          </>
        ) : (
          <>
            <CloudOff size={20} className="text-brume shrink-0 mt-0.5" />
            <p className="text-xs leading-relaxed text-brume">
              <strong className="text-douce">Synchro non configurée.</strong> Les données restent
              sur cet appareil. Pour voir les séances de l’autre depuis ton téléphone, active le
              stockage sur Vercel (voir le README du projet) — 2 minutes, gratuit.
            </p>
          </>
        )}
      </section>

      <section className="rounded-2xl bg-carte border border-ligne p-4 flex gap-3">
        <Stethoscope size={20} className="text-brume shrink-0 mt-0.5" />
        <p className="text-xs leading-relaxed text-brume">
          Avant de commencer, un avis médical est recommandé — surtout pour une reprise après une
          longue pause. Voir l’onglet Conseils.
        </p>
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Vue « Progrès » : évolution des charges par exercice               */
/* ------------------------------------------------------------------ */

function CourbeCharge({ points }) {
  const L = 320;
  const H = 150;
  const mgG = 34;
  const mgB = 22;
  const mgT = 12;
  const mgD = 10;
  const larg = L - mgG - mgD;
  const haut = H - mgT - mgB;
  const vals = points.map((p) => p.charge);
  const vmax = Math.max(...vals);
  const vmin = Math.min(...vals);
  const pad = (vmax - vmin) * 0.15 || Math.max(1, vmax * 0.1);
  const haut0 = Math.max(0, vmin - pad);
  const haut1 = vmax + pad;
  const n = points.length;
  const x = (i) => mgG + (n === 1 ? larg / 2 : (i / (n - 1)) * larg);
  const y = (v) => mgT + haut - ((v - haut0) / (haut1 - haut0 || 1)) * haut;

  const ligne = points.map((p, i) => `${i === 0 ? "M" : "L"} ${x(i).toFixed(1)} ${y(p.charge).toFixed(1)}`).join(" ");
  const aire = `${ligne} L ${x(n - 1).toFixed(1)} ${(mgT + haut).toFixed(1)} L ${x(0).toFixed(1)} ${(mgT + haut).toFixed(1)} Z`;

  /* 3 graduations d'axe Y */
  const ticks = [haut0, (haut0 + haut1) / 2, haut1];

  return (
    <svg viewBox={`0 0 ${L} ${H}`} width="100%" role="img" aria-label="Évolution de la charge" style={{ display: "block" }}>
      {ticks.map((t, i) => (
        <g key={i}>
          <line x1={mgG} y1={y(t)} x2={L - mgD} y2={y(t)} className="grille-progres" />
          <text x={mgG - 6} y={y(t) + 3} textAnchor="end" className="axe-progres chiffres">
            {Math.round(t)}
          </text>
        </g>
      ))}
      <path d={aire} className="aire-progres" />
      <path d={ligne} className="ligne-progres" fill="none" />
      {points.map((p, i) => (
        <circle key={i} cx={x(i)} cy={y(p.charge)} r={i === n - 1 ? 5 : 3.5} className="point-progres" />
      ))}
      <text x={x(n - 1)} y={y(vals[n - 1]) - 11} textAnchor="middle" className="valeur-progres chiffres">
        {vals[n - 1]} kg
      </text>
    </svg>
  );
}

function VueProgres({ profil, historique, dico }) {
  /* série (date, charge) par exercice, à partir des snapshots d'historique */
  const series = useMemo(() => {
    const m = new Map();
    const tri = [...historique].sort((a, b) => (a.d < b.d ? -1 : 1));
    for (const h of tri) {
      if (!h.detail) continue;
      for (const dexo of h.detail) {
        const charge = parseCharge(dexo.charge);
        if (charge == null) continue;
        if (!m.has(dexo.id)) m.set(dexo.id, { id: dexo.id, nom: dexo.nom, points: [] });
        m.get(dexo.id).points.push({ d: h.d, charge });
      }
    }
    return [...m.values()].sort((a, b) => b.points.length - a.points.length);
  }, [historique]);

  /* exercices regroupés par catégorie (pour la roulette), dans l'ordre des zones */
  const categories = useMemo(() => {
    const parZone = new Map();
    for (const s of series) {
      const zone = (dico[s.id] && dico[s.id].zone) || "Autres";
      if (!parZone.has(zone)) parZone.set(zone, []);
      parZone.get(zone).push({ id: s.id, court: s.nom.split(/[,(]/)[0].trim() });
    }
    const ordre = [...ZONES.map(([z]) => z), "Autres"];
    return ordre
      .filter((z) => parZone.has(z))
      .map((z) => ({ zone: z, court: z.split(" & ")[0].split(" (")[0], exos: parZone.get(z) }));
  }, [series, dico]);

  const [choisi, setChoisi] = useState(null);
  const courant = series.find((s) => s.id === choisi) || series[0] || null;

  if (!series.length) {
    return (
      <div key={profil} className="vue rounded-3xl bg-carte border border-ligne p-8 text-center">
        <span className="mx-auto h-16 w-16 rounded-full bg-accent-soft flex items-center justify-center">
          <TrendingUp size={28} className="text-accent transi" />
        </span>
        <h3 className="mt-4 font-bold text-base">Ta courbe de force arrive</h3>
        <p className="text-brume text-sm mt-2 leading-relaxed">
          Note tes charges pendant les séances : dès qu’un exercice aura été fait deux fois, sa
          progression s’affichera ici.
        </p>
      </div>
    );
  }

  const pts = courant.points;
  const delta = pts.length > 1 ? pts[pts.length - 1].charge - pts[0].charge : 0;

  return (
    <div key={profil} className="vue space-y-4">
      <p className="text-sm text-brume leading-relaxed">
        L’évolution de tes charges, exercice par exercice. C’est <strong className="text-douce">ça</strong>,
        la vraie preuve que ça marche.
      </p>

      {/* roulette de sélection, triée par catégorie */}
      <RoueExercices categories={categories} choisi={courant.id} surChoisir={setChoisi} />

      <section className="rounded-3xl bg-carte border border-ligne p-4">
        <div className="flex items-baseline justify-between gap-3 mb-3">
          <h3 className="font-bold text-base leading-tight min-w-0 truncate">{courant.nom}</h3>
          {pts.length > 1 && (
            <span
              className={`text-sm font-extrabold chiffres shrink-0 ${
                delta > 0 ? "text-accent transi" : delta < 0 ? "text-brume" : "text-brume"
              }`}
            >
              {delta > 0 ? "+" : ""}{delta.toLocaleString("fr-FR")} kg
            </span>
          )}
        </div>
        {pts.length > 1 ? (
          <CourbeCharge points={pts} />
        ) : (
          <div className="rounded-2xl bg-fond p-5 text-center">
            <p className="text-2xl font-extrabold chiffres">{pts[0].charge} kg</p>
            <p className="text-brume text-xs mt-1">
              Une seule mesure pour l’instant — refais cet exercice pour voir la courbe monter.
            </p>
          </div>
        )}
        <div className="mt-3 flex items-center justify-between text-xs text-brume chiffres">
          <span>Première : {pts[0].charge} kg · {FORMAT_MINI.format(depuisCle(pts[0].d))}</span>
          <span>Dernière : {pts[pts.length - 1].charge} kg</span>
        </div>
      </section>

      <p className="text-brume text-center text-xs leading-relaxed">
        Progresse doucement : quand tu tiens toutes tes séries au haut de la fourchette, monte d’un cran.
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Vue « Historique »                                                  */
/* ------------------------------------------------------------------ */

function VueHistorique({ profil, historique, toutesSeances, surSupprimer }) {
  const [deplie, setDeplie] = useState(null);
  const groupes = useMemo(() => {
    const parSemaine = new Map();
    for (const h of historique) {
      const w = lundiDe(h.d);
      if (!parSemaine.has(w)) parSemaine.set(w, []);
      parSemaine.get(w).push(h);
    }
    return [...parSemaine.entries()]
      .sort((a, b) => (a[0] < b[0] ? 1 : -1))
      .map(([semaine, entrees]) => ({
        semaine,
        entrees: entrees.sort((a, b) => (a.d < b.d ? 1 : -1)),
      }));
  }, [historique]);

  const titreDe = (h) =>
    h.titre || (toutesSeances.find((s) => s.id === h.s) || {}).titre || "Séance";

  if (!historique.length) {
    return (
      <div key={profil} className="vue rounded-3xl bg-carte border border-ligne p-8 text-center">
        <span className="mx-auto h-16 w-16 rounded-full bg-accent-soft flex items-center justify-center">
          <Flame size={28} className="text-accent" />
        </span>
        <h3 className="mt-4 font-bold text-base">Aucune séance pour l’instant</h3>
        <p className="text-brume text-sm mt-2 leading-relaxed">
          Chaque séance validée s’affichera ici. La première est la plus belle — elle t’attend
          dans « Ma semaine ».
        </p>
      </div>
    );
  }

  const lundiActuel = lundiDe(cleJour());

  return (
    <div key={profil} className="vue space-y-5">
      {groupes.map(({ semaine, entrees }) => (
        <section key={semaine}>
          <h3 className="text-xs uppercase tracking-widest text-brume font-bold mb-2.5">
            {semaine === lundiActuel
              ? "Cette semaine"
              : `Semaine du ${FORMAT_COURT.format(depuisCle(semaine))}`}
            <span className="text-accent transi"> · {entrees.length} séance{entrees.length > 1 ? "s" : ""}</span>
          </h3>
          <div className="space-y-2">
            {entrees.map((h, i) => {
              const cle = `${semaine}-${h.s}-${h.d}-${i}`;
              const ouvert = deplie === cle;
              return (
                <div key={cle} className="rounded-2xl bg-carte border border-ligne overflow-hidden">
                  <div className="p-3 flex items-center gap-3">
                    <button
                      onClick={() => setDeplie(ouvert ? null : cle)}
                      aria-expanded={ouvert}
                      className="flex-1 min-w-0 flex items-center gap-3 text-left"
                    >
                      <span className="h-10 w-10 rounded-xl bg-accent-soft flex items-center justify-center shrink-0 transi">
                        <Check size={19} strokeWidth={3} className="text-accent transi" />
                      </span>
                      <span className="flex-1 min-w-0">
                        <span className="font-bold text-sm block truncate">{titreDe(h)}</span>
                        <span className="text-brume text-xs block mt-0.5">
                          {FORMAT_JOUR.format(depuisCle(h.d))}
                          {h.detail ? ` · ${h.detail.length} exo${h.detail.length > 1 ? "s" : ""}` : ""}
                          {h.kcal ? ` · ≈ ${h.kcal} kcal` : ""}
                        </span>
                      </span>
                      <ChevronDown
                        size={17}
                        className={`text-brume shrink-0 transi ${ouvert ? "rotate-180" : ""}`}
                      />
                    </button>
                    <BoutonSuppression
                      etiquette="Supprimer cette séance de l’historique"
                      surConfirmer={() => surSupprimer(h)}
                    />
                  </div>
                  {ouvert && (
                    <div className="px-3 pb-3 vue">
                      {h.detail && h.detail.length ? (
                        <div className="rounded-xl bg-fond p-3 space-y-1.5">
                          {h.detail.map((dexo, j) => (
                            <div key={j} className="flex items-baseline justify-between gap-3">
                              <span className="text-xs font-bold text-douce truncate">{dexo.nom}</span>
                              <span className="text-xs text-brume chiffres shrink-0">
                                {dexo.series} × {dexo.reps}
                                {dexo.charge ? ` · ${dexo.charge} kg` : ""}
                              </span>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="text-brume text-xs leading-relaxed">
                          Détail non enregistré — les séances validées à partir de maintenant
                          garderont leurs exercices, séries et charges.
                        </p>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      ))}
      <p className="text-brume text-center text-xs leading-relaxed">
        Une séance validée par erreur ? Supprime-la ici, l’assiduité se recalcule toute seule.
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Éditeur de programme personnalisé                                   */
/* ------------------------------------------------------------------ */

function VueEditeur({ initial, dico, exosPerso, surSauverExo, surSupprimerExo, surSauver, surSupprimer, surFermer }) {
  const [nom, setNom] = useState(initial ? initial.nom : "");
  const [seances, setSeances] = useState(
    initial
      ? initial.seances.map((s) => ({
          nom: s.nom,
          exoIds: [...s.exoIds],
          tabata: s.tabata ? { ...s.tabata } : null,
          rounds: { ...(s.rounds || {}) },
        }))
      : null
  );
  const [selecteur, setSelecteur] = useState(null); // index de la séance en cours d'ajout

  /* ----- étape 1 (nouveau programme) : choisir un point de départ ----- */
  if (!seances) {
    const modeles = [
      {
        icone: SquarePen,
        titre: "Partir de zéro",
        detail: "Compose tes séances librement, exercice par exercice.",
        seances: [{ nom: "Séance 1", exoIds: [], tabata: null, rounds: {} }],
      },
      ...PROGRAMMES_BASE.map((p) => ({
        icone: Copy,
        titre: `Copier « ${p.nom} »`,
        detail: "Repars des séances existantes, puis remplace ou ajoute ce que tu veux.",
        seances: p.seances.map((s) => ({
          nom: s.titre,
          exoIds: s.exos.map((e) => e.id),
          tabata: s.tabata ? { ...s.tabata } : null,
          rounds: { ...(s.rounds || {}) },
        })),
      })),
    ];
    return (
      <div className="vue">
        <div className="flex items-center gap-3 mb-5">
          <button
            onClick={surFermer}
            aria-label="Annuler et revenir"
            className="h-12 w-12 rounded-2xl bg-carte border border-ligne flex items-center justify-center shrink-0 active:scale-95 transi"
          >
            <ChevronLeft size={22} />
          </button>
          <div className="flex-1 min-w-0">
            <h2 className="text-xl font-extrabold tracking-tight leading-tight">Nouveau programme</h2>
            <p className="text-brume text-xs mt-0.5">Comment veux-tu démarrer ?</p>
          </div>
        </div>
        <div className="space-y-3">
          {modeles.map((m) => (
            <button
              key={m.titre}
              onClick={() =>
                setSeances(
                  m.seances.map((s) => ({
                    nom: s.nom,
                    exoIds: [...s.exoIds],
                    tabata: s.tabata ? { ...s.tabata } : null,
                    rounds: { ...(s.rounds || {}) },
                  }))
                )
              }
              className="w-full rounded-2xl bg-carte border border-ligne p-4 flex items-center gap-4 text-left active:scale-98 transi"
            >
              <span className="h-12 w-12 rounded-xl bg-accent-soft flex items-center justify-center shrink-0 transi">
                <m.icone size={21} className="text-accent transi" />
              </span>
              <span className="min-w-0">
                <span className="font-bold text-base block">{m.titre}</span>
                <span className="text-brume text-xs block mt-0.5 leading-relaxed">{m.detail}</span>
              </span>
            </button>
          ))}
        </div>
      </div>
    );
  }

  /* ----- étape 2 : composer ----- */
  const valide = seances.length >= 1 && seances.every((s) => s.exoIds.length >= 1);

  function majSeance(i, patch) {
    setSeances((prev) => prev.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  }

  function basculerExo(i, exoId) {
    setSeances((prev) =>
      prev.map((s, j) => {
        if (j !== i) return s;
        const exoIds = s.exoIds.includes(exoId)
          ? s.exoIds.filter((e) => e !== exoId)
          : [...s.exoIds, exoId];
        return { ...s, exoIds };
      })
    );
  }

  function deplacerExo(i, idx, dir) {
    setSeances((prev) =>
      prev.map((s, j) => {
        if (j !== i) return s;
        const k = idx + dir;
        if (k < 0 || k >= s.exoIds.length) return s;
        const exoIds = [...s.exoIds];
        [exoIds[idx], exoIds[k]] = [exoIds[k], exoIds[idx]];
        return { ...s, exoIds };
      })
    );
  }

  function majRound(i, exoId) {
    const paliers = [4, 6, 8, 10, 12];
    setSeances((prev) =>
      prev.map((s, j) => {
        if (j !== i) return s;
        const actuel = (s.rounds && s.rounds[exoId]) || 8;
        const suivant = paliers[(paliers.indexOf(actuel) + 1) % paliers.length] || 8;
        return { ...s, rounds: { ...s.rounds, [exoId]: suivant } };
      })
    );
  }

  return (
    <div className="vue">
      <div className="flex items-center gap-3 mb-5">
        <button
          onClick={surFermer}
          aria-label="Annuler et revenir"
          className="h-12 w-12 rounded-2xl bg-carte border border-ligne flex items-center justify-center shrink-0 active:scale-95 transi"
        >
          <ChevronLeft size={22} />
        </button>
        <div className="flex-1 min-w-0">
          <h2 className="text-xl font-extrabold tracking-tight leading-tight">
            {initial ? "Modifier le programme" : "Nouveau programme"}
          </h2>
          <p className="text-brume text-xs mt-0.5">Les exercices s’enchaînent dans l’ordre affiché</p>
        </div>
      </div>

      <label className="block mb-5">
        <span className="text-xs uppercase tracking-widest text-brume font-bold block mb-2">
          Nom du programme
        </span>
        <input
          type="text"
          value={nom}
          onChange={(e) => setNom(e.target.value)}
          placeholder="Ex. : Spécial jambes, Semaine légère…"
          className="w-full rounded-2xl bg-carte border border-ligne px-4 font-bold text-base outline-none placeholder-slate-600 focus:border-slate-500"
          style={{ height: 52 }}
        />
      </label>

      <div className="space-y-4">
        {seances.map((s, i) => (
          <section key={i} className="rounded-2xl bg-carte border border-ligne p-4">
            <div className="flex items-center gap-2 mb-3">
              <span className="h-9 w-9 rounded-xl bg-accent-soft text-accent flex items-center justify-center font-extrabold shrink-0 transi">
                {i + 1}
              </span>
              <input
                type="text"
                value={s.nom}
                onChange={(e) => majSeance(i, { nom: e.target.value })}
                placeholder={`Séance ${i + 1}`}
                className="flex-1 min-w-0 rounded-xl bg-carte2 px-3 font-bold text-sm outline-none placeholder-slate-600"
                style={{ height: 44 }}
                aria-label={`Nom de la séance ${i + 1}`}
              />
              {seances.length > 1 && (
                <button
                  onClick={() => setSeances((prev) => prev.filter((_, j) => j !== i))}
                  aria-label={`Retirer la séance ${i + 1}`}
                  className="h-11 w-11 rounded-xl bg-carte2 flex items-center justify-center shrink-0 active:scale-95 transi"
                >
                  <X size={17} className="text-brume" />
                </button>
              )}
            </div>

            {/* mode tabata : chrono guidé, rounds par exercice */}
            <button
              onClick={() => majSeance(i, { tabata: s.tabata ? null : { travail: 20, repos: 10 } })}
              aria-pressed={!!s.tabata}
              className={`w-full rounded-xl border p-3 mb-3 flex items-center gap-3 text-left transi ${
                s.tabata ? "bordure-accent-douce bg-carte2" : "border-ligne bg-carte2"
              }`}
            >
              <span
                className={`h-6 w-6 rounded-md flex items-center justify-center shrink-0 transi ${
                  s.tabata ? "bg-accent" : "bg-carte"
                }`}
              >
                {s.tabata && <Check size={15} strokeWidth={3.5} className="text-accent-ink pop" />}
              </span>
              <span className="text-sm font-bold flex-1">
                Séance Tabata <span className="text-brume font-normal">— chrono guidé par l’app</span>
              </span>
            </button>
            {s.tabata && (
              <div className="flex flex-wrap gap-1.5 mb-3">
                {[[20, 10], [30, 15], [40, 20], [45, 15]].map(([t, r]) => (
                  <button
                    key={`${t}-${r}`}
                    onClick={() => majSeance(i, { tabata: { travail: t, repos: r } })}
                    className={`px-3 rounded-xl text-xs font-bold chiffres transi ${
                      s.tabata.travail === t && s.tabata.repos === r
                        ? "bg-accent text-accent-ink"
                        : "bg-carte2 text-douce"
                    }`}
                    style={{ height: 38 }}
                  >
                    {t} s / {r} s
                  </button>
                ))}
              </div>
            )}

            {s.exoIds.length === 0 ? (
              <p className="text-brume text-sm text-center py-4">
                Aucun exercice pour l’instant — ajoute-en avec le bouton ci-dessous.
              </p>
            ) : (
              <ol className="space-y-1.5 mb-1">
                {s.exoIds.map((exoId, idx) => {
                  const exo = dico[exoId];
                  if (!exo) return null;
                  return (
                    <li key={exoId} className="rounded-xl bg-carte2 p-2 pl-3 flex items-center gap-2">
                      <span className="text-brume text-xs chiffres shrink-0 w-4">{idx + 1}</span>
                      <span className="flex-1 min-w-0">
                        <span className="font-bold text-sm block truncate">{exo.nom}</span>
                        <span className="text-brume text-xs block chiffres">
                          {s.tabata ? `${(s.rounds && s.rounds[exoId]) || 8} rounds` : `${exo.series} × ${exo.reps}`} · {exo.zone}
                        </span>
                      </span>
                      {s.tabata && (
                        <button
                          onClick={() => majRound(i, exoId)}
                          aria-label={`Changer le nombre de rounds de ${exo.nom}`}
                          className="h-10 px-2 rounded-lg bg-carte text-accent text-xs font-extrabold chiffres shrink-0 active:scale-95 transi"
                        >
                          ×{(s.rounds && s.rounds[exoId]) || 8}
                        </button>
                      )}
                      <button
                        onClick={() => deplacerExo(i, idx, -1)}
                        disabled={idx === 0}
                        aria-label="Monter l’exercice"
                        className={`h-10 w-9 rounded-lg flex items-center justify-center shrink-0 transi ${idx === 0 ? "opacity-25" : "active:scale-95"}`}
                      >
                        <ChevronUp size={18} className="text-brume" />
                      </button>
                      <button
                        onClick={() => deplacerExo(i, idx, 1)}
                        disabled={idx === s.exoIds.length - 1}
                        aria-label="Descendre l’exercice"
                        className={`h-10 w-9 rounded-lg flex items-center justify-center shrink-0 transi ${idx === s.exoIds.length - 1 ? "opacity-25" : "active:scale-95"}`}
                      >
                        <ChevronDown size={18} className="text-brume" />
                      </button>
                      <button
                        onClick={() => basculerExo(i, exoId)}
                        aria-label={`Retirer ${exo.nom}`}
                        className="h-10 w-9 rounded-lg flex items-center justify-center shrink-0 active:scale-95 transi"
                      >
                        <X size={17} className="text-rouge" />
                      </button>
                    </li>
                  );
                })}
              </ol>
            )}

            <button
              onClick={() => setSelecteur(i)}
              className="mt-2 w-full h-12 rounded-xl border border-dashed border-slate-600 text-douce text-sm font-bold flex items-center justify-center gap-2 active:scale-98 transi"
            >
              <Plus size={17} className="text-accent transi" /> Ajouter un exercice
            </button>
            <p className="text-brume text-xs mt-2.5 leading-relaxed">
              L’échauffement, le cardio et les étirements sont ajoutés automatiquement à chaque séance.
            </p>
          </section>
        ))}
      </div>

      {seances.length < 5 && (
        <button
          onClick={() => setSeances((prev) => [...prev, { nom: `Séance ${prev.length + 1}`, exoIds: [], tabata: null, rounds: {} }])}
          className="mt-3 w-full h-12 rounded-2xl border border-dashed border-slate-600 text-brume text-sm font-bold flex items-center justify-center gap-2 active:scale-98 transi"
        >
          <Plus size={17} /> Ajouter une séance
        </button>
      )}

      <button
        onClick={() => surSauver({ nom, seances })}
        disabled={!valide}
        className={`mt-6 w-full rounded-2xl font-extrabold text-base transi ${
          valide ? "bg-accent text-accent-ink active:scale-98" : "bg-carte text-brume"
        }`}
        style={{ height: 56 }}
      >
        {valide ? "Enregistrer le programme" : "Choisis au moins un exercice par séance"}
      </button>

      {surSupprimer && (
        <div className="mt-3 flex items-center justify-center gap-2">
          <span className="text-brume text-xs">Supprimer ce programme :</span>
          <BoutonSuppression etiquette="Supprimer le programme" surConfirmer={surSupprimer} />
        </div>
      )}

      {selecteur !== null && (
        <SelecteurExos
          nomSeance={seances[selecteur].nom || `Séance ${selecteur + 1}`}
          exoIds={seances[selecteur].exoIds}
          dico={dico}
          exosPerso={exosPerso}
          surSauverExo={surSauverExo}
          surSupprimerExo={surSupprimerExo}
          surBasculer={(exoId) => basculerExo(selecteur, exoId)}
          surFermer={() => setSelecteur(null)}
        />
      )}
    </div>
  );
}

/* Sélecteur d'exercices plein écran : recherche + filtres par zone */
function SelecteurExos({ nomSeance, exoIds, dico, exosPerso, surSauverExo, surSupprimerExo, surBasculer, surFermer }) {
  const [recherche, setRecherche] = useState("");
  const [zone, setZone] = useState(null); // null = toutes
  const [form, setForm] = useState(undefined); // undefined ferm\u00e9 \u00b7 null nouveau \u00b7 objet = \u00e9dition

  useVerrouScroll();
  const normalise = (t) => t.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const rq = normalise(recherche.trim());

  const sections = ZONES
    .filter(([z]) => !zone || z === zone)
    .map(([z, ids]) => ({
      zone: z,
      exos: [...ids.map((id) => dico[id]), ...exosPerso.filter((e) => e.zone === z)]
        .filter((e) => e && (!rq || normalise(e.nom).includes(rq))),
    }))
    .filter((s) => s.exos.length > 0);

  return createPortal(
    <div className="fixed inset-0 z-50 bg-fond flex flex-col coussin-haut font-jakarta text-encre">
      <div className="mx-auto w-full max-w-md flex-1 min-h-0 flex flex-col px-4">
        <div className="flex items-center gap-3 pt-5 pb-3">
          <div className="flex-1 min-w-0">
            <h2 className="text-lg font-extrabold tracking-tight leading-tight">Ajouter des exercices</h2>
            <p className="text-brume text-xs mt-0.5 truncate chiffres">
              {nomSeance} · {exoIds.length} exercice{exoIds.length > 1 ? "s" : ""} choisi{exoIds.length > 1 ? "s" : ""}
            </p>
          </div>
          <button
            onClick={surFermer}
            className="h-12 px-5 rounded-2xl bg-accent text-accent-ink font-extrabold shrink-0 active:scale-95 transi"
          >
            OK
          </button>
        </div>

        <label className="flex items-center gap-2.5 rounded-2xl bg-carte border border-ligne px-4 shrink-0" style={{ height: 48 }}>
          <Search size={18} className="text-brume shrink-0" />
          <input
            type="text"
            value={recherche}
            onChange={(e) => setRecherche(e.target.value)}
            placeholder="Rechercher un exercice…"
            className="w-full min-w-0 bg-transparent text-sm font-bold outline-none placeholder-slate-600"
            aria-label="Rechercher un exercice"
          />
          {recherche && (
            <button onClick={() => setRecherche("")} aria-label="Effacer la recherche" className="shrink-0">
              <X size={16} className="text-brume" />
            </button>
          )}
        </label>

        <div className="flex flex-wrap gap-1.5 py-3 shrink-0">
          {[null, ...ZONES.map(([z]) => z)].map((z) => (
            <button
              key={z || "toutes"}
              onClick={() => setZone(z)}
              className={`px-3 rounded-xl text-xs font-bold transi ${
                zone === z ? "bg-accent text-accent-ink" : "bg-carte text-brume border border-ligne"
              }`}
              style={{ height: 38 }}
            >
              {z || "Tout"}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto pb-8 space-y-4 defile">
          <button
            onClick={() => setForm(null)}
            className="w-full h-12 rounded-2xl border border-dashed border-slate-600 text-douce text-sm font-bold flex items-center justify-center gap-2 active:scale-98 transi"
          >
            <Plus size={17} className="text-accent transi" /> Créer mon exercice
          </button>
          {sections.length === 0 && (
            <p className="text-brume text-sm text-center pt-8">
              Aucun exercice ne correspond à « {recherche} » — tu peux le créer avec le bouton ci-dessus.
            </p>
          )}
          {sections.map((sec) => (
            <div key={sec.zone}>
              <p className="text-xs uppercase tracking-widest text-brume font-bold mb-2">{sec.zone}</p>
              <div className="space-y-2">
                {sec.exos.map((exo) => {
                  const choisi = exoIds.includes(exo.id);
                  return (
                    <div
                      key={exo.id}
                      className={`rounded-2xl border flex items-stretch transi ${
                        choisi ? "bg-carte bordure-accent-douce" : "bg-carte border-ligne"
                      }`}
                    >
                      <button
                        onClick={() => surBasculer(exo.id)}
                        aria-pressed={choisi}
                        className="flex-1 min-w-0 p-3 flex items-center gap-3 text-left active:scale-98 transi"
                      >
                        <SchemaMuscles muscles={exo.muscles || []} hauteur={48} />
                        <span className="flex-1 min-w-0">
                          <span className="font-bold text-sm block leading-snug">
                            {exo.nom}
                            {exo.perso && (
                              <span className="ml-1.5 text-xs font-bold px-1.5 py-0.5 rounded bg-carte2 text-brume align-middle">
                                perso
                              </span>
                            )}
                          </span>
                          <span className="text-brume text-xs block mt-0.5 chiffres">
                            {exo.series} × {exo.reps} · repos {exo.repos} s
                          </span>
                        </span>
                        <span
                          className={`h-9 w-9 rounded-full flex items-center justify-center shrink-0 transi ${
                            choisi ? "bg-accent" : "bg-carte2"
                          }`}
                        >
                          {choisi
                            ? <Check size={18} strokeWidth={3.5} className="text-accent-ink pop" />
                            : <Plus size={18} className="text-brume" />}
                        </span>
                      </button>
                      {exo.perso && (
                        <button
                          onClick={() => setForm(exo)}
                          aria-label={`Modifier ${exo.nom}`}
                          className="px-3 flex items-center justify-center shrink-0 active:scale-95 transi"
                        >
                          <Pencil size={15} className="text-brume" />
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>

      {form !== undefined && (
        <FormExo
          initial={form}
          surSauver={(exo) => {
            surSauverExo(exo);
            if (!form && !exoIds.includes(exo.id)) surBasculer(exo.id);
            setForm(undefined);
          }}
          surSupprimer={
            form
              ? () => {
                  if (exoIds.includes(form.id)) surBasculer(form.id);
                  surSupprimerExo(form.id);
                  setForm(undefined);
                }
              : null
          }
          surFermer={() => setForm(undefined)}
        />
      )}
    </div>,
    document.body
  );
}

/* Formulaire de création / édition d'un exercice personnalisé */
function FormExo({ initial, surSauver, surSupprimer, surFermer }) {
  useVerrouScroll();
  const [nom, setNom] = useState(initial ? initial.nom : "");
  const [zone, setZone] = useState(initial ? initial.zone : "Jambes & fessiers");
  const [muscles, setMuscles] = useState(initial ? initial.muscles || [] : MUSCLES_PAR_ZONE["Jambes & fessiers"]);
  const [series, setSeries] = useState(initial ? String(initial.series) : "3");
  const [reps, setReps] = useState(initial ? String(initial.reps) : "12");
  const [repos, setRepos] = useState(initial ? String(initial.repos) : "60");
  const [sansCharge, setSansCharge] = useState(initial ? !!initial.sansCharge : false);
  const [consigne, setConsigne] = useState(initial && initial.charge ? initial.charge.esteban : "");
  const [conseil, setConseil] = useState(initial ? initial.conseil || "" : "");
  const [groupe, setGroupe] = useState(initial ? initial.groupe || null : null);

  const valide = nom.trim().length > 0 && muscles.length > 0;

  function choisirZone(z) {
    setZone(z);
    setMuscles(MUSCLES_PAR_ZONE[z] || []);
  }

  function basculerMuscle(m) {
    setMuscles((prev) => (prev.includes(m) ? prev.filter((x) => x !== m) : [...prev, m]));
  }

  function enregistrer() {
    const texteConsigne = consigne.trim() || "À ton rythme — la technique d’abord";
    surSauver({
      id: initial ? initial.id : `exo-${Date.now()}`,
      perso: true,
      nom: nom.trim(),
      zone,
      muscles,
      series: Math.max(1, parseInt(series, 10) || 3),
      reps: reps.trim() || "12",
      repos: parseInt(repos, 10) || 60,
      sansCharge,
      groupe: groupe || undefined,
      charge: { esteban: texteConsigne, valerie: texteConsigne },
      variante: "",
      conseil: conseil.trim(),
    });
  }

  const etiquette = "text-xs uppercase tracking-widest text-brume font-bold block mb-2";

  return (
    <div className="fixed inset-0 z-50 bg-fond overflow-y-auto defile coussin-haut">
      <div className="mx-auto w-full max-w-md px-4 pb-10">
        <div className="flex items-center gap-3 pt-5 pb-4">
          <button
            onClick={surFermer}
            aria-label="Annuler"
            className="h-12 w-12 rounded-2xl bg-carte border border-ligne flex items-center justify-center shrink-0 active:scale-95 transi"
          >
            <ChevronLeft size={22} />
          </button>
          <div className="flex-1 min-w-0">
            <h2 className="text-xl font-extrabold tracking-tight leading-tight">
              {initial ? "Modifier l’exercice" : "Mon exercice"}
            </h2>
            <p className="text-brume text-xs mt-0.5">Il apparaîtra dans le catalogue, pour vous deux</p>
          </div>
        </div>

        <div className="space-y-5">
          <label className="block">
            <span className={etiquette}>Nom de l’exercice</span>
            <input
              type="text"
              value={nom}
              onChange={(e) => setNom(e.target.value)}
              placeholder="Ex. : Presse à mollets assis"
              className="w-full rounded-2xl bg-carte border border-ligne px-4 font-bold text-base outline-none placeholder-slate-600 focus:border-slate-500"
              style={{ height: 52 }}
            />
          </label>

          <div>
            <span className={etiquette}>Zone</span>
            <div className="flex flex-wrap gap-1.5">
              {ZONES.map(([z]) => (
                <button
                  key={z}
                  onClick={() => choisirZone(z)}
                  className={`px-3 rounded-xl text-xs font-bold transi ${
                    zone === z ? "bg-accent text-accent-ink" : "bg-carte text-brume border border-ligne"
                  }`}
                  style={{ height: 40 }}
                >
                  {z}
                </button>
              ))}
            </div>
          </div>

          <div>
            <span className={etiquette}>Muscles travaillés</span>
            <div className="flex items-start gap-3">
              <SchemaMuscles muscles={muscles} hauteur={110} />
              <div className="flex-1 flex flex-wrap gap-1.5">
                {Object.entries(MUSCLES_LIBELLES).map(([m, libelle]) => (
                  <button
                    key={m}
                    onClick={() => basculerMuscle(m)}
                    aria-pressed={muscles.includes(m)}
                    className={`px-2.5 rounded-lg text-xs font-bold transi ${
                      muscles.includes(m) ? "bg-accent text-accent-ink" : "bg-carte2 text-douce"
                    }`}
                    style={{ height: 34 }}
                  >
                    {libelle}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div>
            <span className={etiquette}>Interchangeable avec (swipe en séance)</span>
            <div className="flex flex-wrap gap-1.5">
              <button
                onClick={() => setGroupe(null)}
                className={`px-2.5 rounded-lg text-xs font-bold transi ${
                  groupe === null ? "bg-accent text-accent-ink" : "bg-carte2 text-douce"
                }`}
                style={{ height: 34 }}
              >
                Aucun
              </button>
              {Object.entries(GROUPES).map(([id, libelle]) => (
                <button
                  key={id}
                  onClick={() => setGroupe(id)}
                  className={`px-2.5 rounded-lg text-xs font-bold transi ${
                    groupe === id ? "bg-accent text-accent-ink" : "bg-carte2 text-douce"
                  }`}
                  style={{ height: 34 }}
                >
                  {libelle}
                </button>
              ))}
            </div>
            <p className="text-brume text-xs mt-2 leading-relaxed">
              En séance, un swipe sur un exercice de ce groupe pourra le remplacer par celui-ci.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <span className={etiquette}>Séries</span>
              <div className="flex gap-1.5">
                {["2", "3", "4"].map((s) => (
                  <button
                    key={s}
                    onClick={() => setSeries(s)}
                    className={`flex-1 rounded-xl text-sm font-bold chiffres transi ${
                      series === s ? "bg-accent text-accent-ink" : "bg-carte text-brume border border-ligne"
                    }`}
                    style={{ height: 44 }}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
            <label className="block">
              <span className={etiquette}>Répétitions</span>
              <input
                type="text"
                value={reps}
                onChange={(e) => setReps(e.target.value)}
                placeholder="12, 10 / côté, 30 s…"
                className="w-full rounded-xl bg-carte border border-ligne px-3 text-center font-bold text-sm outline-none placeholder-slate-600 chiffres"
                style={{ height: 44 }}
              />
            </label>
          </div>

          <div>
            <span className={etiquette}>Repos entre les séries</span>
            <div className="flex gap-1.5">
              {["45", "60", "90"].map((r) => (
                <button
                  key={r}
                  onClick={() => setRepos(r)}
                  className={`flex-1 rounded-xl text-sm font-bold chiffres transi ${
                    repos === r ? "bg-accent text-accent-ink" : "bg-carte text-brume border border-ligne"
                  }`}
                  style={{ height: 44 }}
                >
                  {r} s
                </button>
              ))}
            </div>
          </div>

          <button
            onClick={() => setSansCharge(!sansCharge)}
            aria-pressed={sansCharge}
            className={`w-full rounded-2xl border p-3.5 flex items-center gap-3 text-left transi ${
              sansCharge ? "bordure-accent-douce bg-carte" : "border-ligne bg-carte"
            }`}
          >
            <span
              className={`h-6 w-6 rounded-md flex items-center justify-center shrink-0 transi ${
                sansCharge ? "bg-accent" : "bg-carte2"
              }`}
            >
              {sansCharge && <Check size={15} strokeWidth={3.5} className="text-accent-ink pop" />}
            </span>
            <span className="text-sm font-bold flex-1">Au poids du corps (pas de charge à noter)</span>
          </button>

          <label className="block">
            <span className={etiquette}>Consigne de départ (optionnel)</span>
            <input
              type="text"
              value={consigne}
              onChange={(e) => setConsigne(e.target.value)}
              placeholder="Ex. : Départ conseillé : 20–30 kg"
              className="w-full rounded-2xl bg-carte border border-ligne px-4 text-sm font-bold outline-none placeholder-slate-600"
              style={{ height: 48 }}
            />
          </label>

          <label className="block">
            <span className={etiquette}>Conseil technique (optionnel)</span>
            <textarea
              value={conseil}
              onChange={(e) => setConseil(e.target.value)}
              placeholder="Ex. : Dos plat, mouvement lent et contrôlé…"
              rows={2}
              className="w-full rounded-2xl bg-carte border border-ligne px-4 py-3 text-sm outline-none placeholder-slate-600 resize-none leading-relaxed"
            />
          </label>

          <button
            onClick={enregistrer}
            disabled={!valide}
            className={`w-full rounded-2xl font-extrabold text-base transi ${
              valide ? "bg-accent text-accent-ink active:scale-98" : "bg-carte text-brume"
            }`}
            style={{ height: 56 }}
          >
            {valide ? "Enregistrer l’exercice" : "Donne un nom et au moins un muscle"}
          </button>

          {surSupprimer && (
            <div className="flex items-center justify-center gap-2">
              <span className="text-brume text-xs">Supprimer cet exercice :</span>
              <BoutonSuppression etiquette="Supprimer l’exercice" surConfirmer={surSupprimer} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Vue séance détaillée                                                */
/* ------------------------------------------------------------------ */

function VueSeance({
  seance, profil, etat, charges, dico, tousExos, faiteCetteSemaine, historique,
  surRetour, surCoche, surSeries, surRemplacer, surCharge, surRepos,
  surFin, surFinAvecSauvegarde, surAnnuler,
}) {
  const checks = etat.coches;
  const [tabataActif, setTabataActif] = useState(null); // {slotId, exo, rounds}
  /* dernière performance enregistrée par exercice (séance validée la plus récente) */
  const dernieresPerfs = useMemo(() => {
    const m = {};
    for (let i = historique.length - 1; i >= 0; i--) {
      const h = historique[i];
      if (!h.detail) continue;
      for (const dexo of h.detail) {
        if (!m[dexo.id]) m[dexo.id] = { ...dexo, d: h.d };
      }
    }
    return m;
  }, [historique]);
  const [roue, setRoue] = useState(null); // exo dont on règle la charge
  const [confirmation, setConfirmation] = useState(false); // séance écourtée
  const etapes = [
    { id: "echauffement" },
    ...seance.exos.map((e) => ({ id: e.id })),
    ...(seance.cardio ? [{ id: "cardio" }] : []),
    { id: "retour" },
  ];
  const nFait = etapes.filter((e) => checks[e.id]).length;
  const tout = nFait === etapes.length;
  /* exercices réellement faits (variante affichée, pas l'emplacement) */
  const exosFaits = seance.exos
    .filter((slot) => checks[slot.id])
    .map((slot) => etat.remplacements[slot.id] || slot.id);
  /* exercices déjà affichés dans la séance : exclus des variantes (doublons) */
  const dejaAffiches = new Set(seance.exos.map((s) => etat.remplacements[s.id] || s.id));

  return (
    <div key={`${profil}-${seance.id}`} className="vue">
      {/* en-tête de séance */}
      <div className="flex items-center gap-3 mb-4">
        <button
          onClick={surRetour}
          aria-label="Retour à ma semaine"
          className="h-12 w-12 rounded-2xl bg-carte border border-ligne flex items-center justify-center shrink-0 active:scale-95 transi"
        >
          <ChevronLeft size={22} />
        </button>
        <div className="flex-1 min-w-0">
          <h2 className="text-xl font-extrabold tracking-tight leading-tight">{seance.titre}</h2>
          <p className="text-brume text-xs mt-0.5">45–60 min · {seance.sousTitre}</p>
        </div>
      </div>

      {/* séance déjà validée cette semaine */}
      {faiteCetteSemaine && (
        <div className="rounded-2xl bg-carte border bordure-accent-douce p-4 mb-4 flex items-center gap-3">
          <span className="h-10 w-10 rounded-xl bg-accent flex items-center justify-center shrink-0 transi">
            <Check size={20} strokeWidth={3} className="text-accent-ink" />
          </span>
          <p className="flex-1 text-sm font-bold">Validée cette semaine</p>
          <button
            onClick={surAnnuler}
            className="h-11 px-3 rounded-xl bg-carte2 text-xs font-bold text-douce active:scale-95 transi"
          >
            Annuler la validation
          </button>
        </div>
      )}

      {/* progression */}
      <div className="mb-5">
        <div className="h-2 rounded-full bg-carte overflow-hidden">
          <div
            className="h-full rounded-full bg-accent barre"
            style={{ width: `${(nFait / etapes.length) * 100}%` }}
          />
        </div>
        <p className="text-brume text-xs mt-2 chiffres">{nFait}/{etapes.length} étapes</p>
      </div>

      <div className="space-y-3">
        {/* échauffement */}
        <EtapeSimple
          icone={Wind}
          etiquette="Échauffement — non négociable"
          coche={!!checks["echauffement"]}
          surCoche={() => surCoche("echauffement")}
        >
          <p className="text-sm text-douce leading-relaxed">
            {ECHAUFFEMENT.duree[profil]} de cardio très doux (vélo ou elliptique), puis :
          </p>
          <ul className="mt-2 space-y-1">
            {ECHAUFFEMENT.mobilite.map((m, i) => (
              <li key={i} className="text-xs text-brume leading-relaxed flex gap-2">
                <span className="text-accent shrink-0">•</span>{m}
              </li>
            ))}
          </ul>
        </EtapeSimple>

        {/* exercices */}
        {seance.exos.map((slot, i) => {
          const exoAffiche = (etat.remplacements[slot.id] && dico[etat.remplacements[slot.id]]) || slot;
          const variantes = exoAffiche.groupe
            ? tousExos.filter(
                (e) =>
                  e.groupe === exoAffiche.groupe &&
                  (e.id === exoAffiche.id || !dejaAffiches.has(e.id))
              )
            : [];
          return (
            <CarteExo
              key={slot.id}
              numero={i + 1}
              total={seance.exos.length}
              exo={exoAffiche}
              nomOriginal={exoAffiche.id !== slot.id ? slot.nom : null}
              variantes={variantes}
              profil={profil}
              coche={!!checks[slot.id]}
              seriesFaites={etat.series[slot.id] || 0}
              poids={charges[exoAffiche.id] || ""}
              dernierePerf={dernieresPerfs[exoAffiche.id]}
              tabata={seance.tabata || null}
              rounds={(seance.rounds && seance.rounds[slot.id]) || 8}
              surCoche={() => surCoche(slot.id)}
              surSeries={(n) => surSeries(slot.id, exoAffiche.series, n)}
              surRoue={() => setRoue(exoAffiche)}
              surRepos={() => surRepos(exoAffiche)}
              surTabata={() =>
                setTabataActif({
                  slotId: slot.id,
                  exo: exoAffiche,
                  rounds: (seance.rounds && seance.rounds[slot.id]) || 8,
                })
              }
              surVariante={(dir) => {
                if (variantes.length < 2) return;
                const idx = variantes.findIndex((e) => e.id === exoAffiche.id);
                const prochaine = variantes[(idx + dir + variantes.length) % variantes.length];
                surRemplacer(slot.id, prochaine.id);
              }}
            />
          );
        })}

        {/* cardio (pas en tabata : le tabata EST le cardio) */}
        {seance.cardio && (
          <EtapeSimple
            icone={HeartPulse}
            etiquette="Cardio — 15 à 20 min"
            coche={!!checks["cardio"]}
            surCoche={() => surCoche("cardio")}
          >
            <p className="text-sm text-douce leading-relaxed">{seance.cardio[profil]}</p>
          </EtapeSimple>
        )}

        {/* retour au calme */}
        <EtapeSimple
          icone={Leaf}
          etiquette="Retour au calme — 5 min"
          coche={!!checks["retour"]}
          surCoche={() => surCoche("retour")}
        >
          <p className="text-sm text-douce leading-relaxed">{RETOUR_AU_CALME}</p>
        </EtapeSimple>
      </div>

      {/* valider (une séance écourtée se valide aussi) */}
      <button
        onClick={() => (tout ? surFin() : setConfirmation(true))}
        disabled={nFait === 0}
        className={`mt-6 w-full rounded-2xl font-extrabold text-base transi ${
          nFait > 0 ? "bg-accent text-accent-ink active:scale-98" : "bg-carte text-brume"
        }`}
        style={{ height: 56 }}
      >
        {nFait === 0
          ? "Coche au moins une étape"
          : tout
          ? "Valider la séance"
          : `Valider la séance (${nFait}/${etapes.length})`}
      </button>
      <p className="text-brume text-center text-xs mt-3 leading-relaxed">
        Douleur articulaire vive ? On passe l’exercice, sans culpabiliser — voir Conseils.
      </p>

      {confirmation && (
        <ConfirmationEcourtee
          nFait={nFait}
          total={etapes.length}
          nbExosFaits={exosFaits.length}
          surValider={() => { setConfirmation(false); surFin(); }}
          surValiderEtGarder={() => { setConfirmation(false); surFinAvecSauvegarde(exosFaits); }}
          surFermer={() => setConfirmation(false)}
        />
      )}

      {roue && (
        <FeuilleCharge
          exo={roue}
          valeurInitiale={charges[roue.id] || ""}
          surValider={(v) => { surCharge(roue.id, v); setRoue(null); }}
          surFermer={() => setRoue(null)}
        />
      )}

      {tabataActif && seance.tabata && (
        <MinuteurTabata
          exo={tabataActif.exo}
          rounds={tabataActif.rounds}
          travail={seance.tabata.travail}
          repos={seance.tabata.repos}
          surTerminer={() => {
            surSeries(tabataActif.slotId, tabataActif.rounds, tabataActif.rounds);
            setTabataActif(null);
          }}
          surFermer={() => setTabataActif(null)}
        />
      )}
    </div>
  );
}

/* Feuille de confirmation : séance écourtée */
function ConfirmationEcourtee({ nFait, total, nbExosFaits, surValider, surValiderEtGarder, surFermer }) {
  useVerrouScroll();
  return createPortal(
    <div className="fixed inset-0 z-50 voile font-jakarta text-encre flex items-end" onClick={surFermer}>
      <div
        className="w-full mx-auto max-w-md rounded-t-3xl bg-carte border-t border-ligne p-6 coussin-bas surgit"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-xl font-extrabold tracking-tight">Séance écourtée</h3>
        <p className="text-douce text-sm mt-2 leading-relaxed">
          {nFait} étape{nFait > 1 ? "s" : ""} sur {total} — c’est déjà ça de pris, et ça compte
          pareil pour ton assiduité.
        </p>
        <div className="mt-5 space-y-2">
          <button
            onClick={surValider}
            className="w-full rounded-2xl bg-accent text-accent-ink font-extrabold text-base active:scale-98 transi"
            style={{ height: 54 }}
          >
            Valider la séance
          </button>
          {nbExosFaits > 0 && (
            <button
              onClick={surValiderEtGarder}
              className="w-full rounded-2xl bg-carte2 font-bold text-sm text-douce active:scale-98 transi px-4"
              style={{ height: 54 }}
            >
              Valider + garder cette version en programme « express »
            </button>
          )}
          <button
            onClick={surFermer}
            className="w-full rounded-2xl border border-ligne text-brume font-bold text-sm active:scale-98 transi"
            style={{ height: 48 }}
          >
            Continuer la séance
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

/* ------------------------------------------------------------------ */
/* Chrono Tabata plein écran : bips, vibrations, écran allumé          */
/* ------------------------------------------------------------------ */

function MinuteurTabata({ exo, rounds, travail, repos, surTerminer, surFermer }) {
  useVerrouScroll();
  const ctxAudio = useRef(null);
  const [pause, setPause] = useState(false);
  const [etat, setEtat] = useState({ idx: 0, finA: Date.now() + 5000, resteMs: null });
  const [, setTic] = useState(0);

  const phases = useMemo(() => {
    const liste = [{ type: "prep", duree: 5 }];
    for (let r = 1; r <= rounds; r++) {
      liste.push({ type: "travail", duree: travail, round: r });
      if (r < rounds) liste.push({ type: "repos", duree: repos, round: r });
    }
    return liste;
  }, [rounds, travail, repos]);

  /* audio (créé au montage : on vient d'un geste utilisateur) */
  useEffect(() => {
    try {
      ctxAudio.current = new (window.AudioContext || window.webkitAudioContext)();
    } catch (e) {}
    return () => {
      try { if (ctxAudio.current) ctxAudio.current.close(); } catch (e) {}
    };
  }, []);

  function bip(freq, ms, gain = 0.15) {
    const ctx = ctxAudio.current;
    if (!ctx) return;
    try {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = "sine";
      o.frequency.value = freq;
      o.connect(g);
      g.connect(ctx.destination);
      g.gain.setValueAtTime(gain, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + ms / 1000);
      o.start();
      o.stop(ctx.currentTime + ms / 1000);
    } catch (e) {}
  }

  /* écran maintenu allumé pendant le chrono */
  useEffect(() => {
    let verrou = null;
    try {
      if (navigator.wakeLock) {
        navigator.wakeLock.request("screen").then((v) => { verrou = v; }).catch(() => {});
      }
    } catch (e) {}
    return () => {
      try { if (verrou) verrou.release(); } catch (e) {}
    };
  }, []);

  /* moteur : basé sur l'horloge */
  useEffect(() => {
    if (pause) return;
    const t = setInterval(() => {
      setTic((x) => x + 1);
      setEtat((cur) => {
        if (Date.now() < cur.finA) return cur;
        const suivant = cur.idx + 1;
        if (suivant >= phases.length) return cur;
        const ph = phases[suivant];
        return { idx: suivant, finA: Date.now() + ph.duree * 1000, resteMs: null };
      });
    }, 200);
    return () => clearInterval(t);
  }, [pause, phases]);

  const phase = phases[etat.idx];
  const reste = pause && etat.resteMs != null
    ? Math.ceil(etat.resteMs / 1000)
    : Math.max(0, Math.ceil((etat.finA - Date.now()) / 1000));
  const finie = etat.idx === phases.length - 1 && !pause && Date.now() >= etat.finA;

  /* signaux de changement de phase */
  const refIdx = useRef(0);
  useEffect(() => {
    if (etat.idx === refIdx.current) return;
    refIdx.current = etat.idx;
    const ph = phases[etat.idx];
    try {
      if (navigator.vibrate) navigator.vibrate(ph.type === "travail" ? [120, 60, 120] : [280]);
    } catch (e) {}
    if (ph.type === "travail") {
      bip(1150, 150);
      setTimeout(() => bip(1150, 150), 180);
    } else {
      bip(520, 320);
    }
  }, [etat.idx, phases]);

  /* décompte 3-2-1 */
  const refReste = useRef(null);
  useEffect(() => {
    if (reste === refReste.current) return;
    refReste.current = reste;
    if (!pause && !finie && reste <= 3 && reste >= 1) bip(850, 90, 0.1);
  });

  /* fin du tabata */
  useEffect(() => {
    if (!finie) return;
    try { if (navigator.vibrate) navigator.vibrate([200, 100, 200, 100, 450]); } catch (e) {}
    bip(1150, 150); setTimeout(() => bip(1350, 150), 190); setTimeout(() => bip(1600, 400), 380);
    const t = setTimeout(surTerminer, 1400);
    return () => clearTimeout(t);
  }, [finie]);

  function basculerPause() {
    setPause((p) => {
      if (!p) {
        setEtat((c) => ({ ...c, resteMs: Math.max(0, c.finA - Date.now()) }));
        return true;
      }
      setEtat((c) => ({ ...c, finA: Date.now() + (c.resteMs != null ? c.resteMs : 0), resteMs: null }));
      return false;
    });
  }

  const libelle = finie
    ? "Terminé !"
    : phase.type === "prep"
    ? "Prépare-toi"
    : phase.type === "travail"
    ? "Effort !"
    : "Repos";
  const couleur = finie || phase.type === "travail" ? "text-accent" : phase.type === "repos" ? "text-brume" : "text-douce";
  const fraction = phase.duree ? Math.min(1, Math.max(0, reste / phase.duree)) : 0;

  return createPortal(
    <div className="fixed inset-0 z-50 bg-fond font-jakarta text-encre flex flex-col coussin-haut">
      <div className="mx-auto w-full max-w-md flex-1 min-h-0 flex flex-col px-6 pb-8 coussin-bas">
        <div className="flex items-center gap-3 pt-4">
          <div className="flex-1 min-w-0">
            <h2 className="font-extrabold text-base leading-tight truncate">{exo.nom}</h2>
            <p className="text-brume text-xs mt-0.5 chiffres">
              Tabata · {travail} s / {repos} s · {rounds} rounds
            </p>
          </div>
          <button
            onClick={surFermer}
            aria-label="Arrêter le tabata"
            className="h-12 w-12 rounded-2xl bg-carte border border-ligne flex items-center justify-center shrink-0 active:scale-95 transi"
          >
            <X size={20} className="text-brume" />
          </button>
        </div>

        <div className="flex-1 flex flex-col items-center justify-center gap-3">
          <p className={`uppercase tracking-widest font-extrabold text-lg transi ${couleur}`}>{libelle}</p>
          <p
            className={`chiffres font-extrabold leading-none transi ${finie || phase.type === "travail" ? "text-accent" : ""}`}
            style={{ fontSize: 120 }}
          >
            {finie ? "💪" : reste}
          </p>
          <p className="text-brume text-sm chiffres">
            {phase.type === "prep" || finie ? `${rounds} rounds au programme` : `Round ${phase.round}/${rounds}`}
          </p>
          <div className="w-full h-2 rounded-full bg-carte overflow-hidden mt-2">
            <div
              className="h-full rounded-full bg-accent"
              style={{ width: `${fraction * 100}%`, transition: "width 0.2s linear" }}
            />
          </div>
        </div>

        <button
          onClick={basculerPause}
          disabled={finie}
          className={`w-full rounded-2xl font-extrabold text-base flex items-center justify-center gap-2 transi ${
            pause ? "bg-accent text-accent-ink" : "bg-carte border border-ligne text-douce"
          } active:scale-98`}
          style={{ height: 60 }}
        >
          {pause ? <Play size={20} strokeWidth={2.5} /> : <Pause size={20} strokeWidth={2.5} />}
          {pause ? "Reprendre" : "Pause"}
        </button>
        <p className="text-brume text-center text-xs mt-3">
          L’écran reste allumé pendant le chrono. Le son sert de repère : 2 bips = effort, 1 bip grave = repos.
        </p>
      </div>
    </div>,
    document.body
  );
}

/* ------------------------------------------------------------------ */
/* Roue de sélection de charge (façon iOS)                             */
/* ------------------------------------------------------------------ */

const ROUE_ENTIERS = Array.from({ length: 301 }, (_, i) => String(i));
const ROUE_DECIMALES = [",0", ",5"];
const ROUE_H = 40;

function Roue({ valeurs, index, surIndex, largeur = 80, ligneH = ROUE_H, hauteur = 200, police }) {
  const ref = useRef(null);
  const minuterie = useRef(null);

  useEffect(() => {
    if (ref.current) ref.current.scrollTop = index * ligneH;
    // positionnement initial uniquement
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function surScroll() {
    clearTimeout(minuterie.current);
    minuterie.current = setTimeout(() => {
      const el = ref.current;
      if (!el) return;
      const i = Math.max(0, Math.min(valeurs.length - 1, Math.round(el.scrollTop / ligneH)));
      if (i !== index) {
        surIndex(i);
        try { if (navigator.vibrate) navigator.vibrate(8); } catch (e) {}
      }
    }, 120);
  }

  const marge = (hauteur - ligneH) / 2;
  return (
    <div ref={ref} onScroll={surScroll} className="roue" style={{ width: largeur, height: hauteur }}>
      <div style={{ height: marge }} />
      {valeurs.map((v, i) => (
        <div
          key={i}
          onClick={() => { surIndex(i); if (ref.current) ref.current.scrollTo({ top: i * ligneH, behavior: "smooth" }); }}
          className={`roue-item chiffres ${i === index ? "roue-active" : ""}`}
          style={{ height: ligneH, fontSize: police }}
        >
          <span style={{ minWidth: 0, maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {v}
          </span>
        </div>
      ))}
      <div style={{ height: marge }} />
    </div>
  );
}

/* Roue de sélection d'exercice, triée par catégorie (Progrès) :
   colonne gauche = catégorie, colonne droite = exercices de la catégorie */
function RoueExercices({ categories, choisi, surChoisir }) {
  const catInit = Math.max(0, categories.findIndex((c) => c.exos.some((e) => e.id === choisi)));
  const [catIdx, setCatIdx] = useState(catInit);
  const catCourante = categories[Math.min(catIdx, categories.length - 1)];
  const [exoIdx, setExoIdx] = useState(
    Math.max(0, catCourante.exos.findIndex((e) => e.id === choisi))
  );
  const exos = catCourante.exos;
  const exoClamp = Math.min(exoIdx, exos.length - 1);

  const refChoix = useRef(choisi);
  useEffect(() => {
    const e = categories[Math.min(catIdx, categories.length - 1)].exos[exoClamp];
    if (e && e.id !== refChoix.current) {
      refChoix.current = e.id;
      surChoisir(e.id);
    }
  }, [catIdx, exoClamp, categories, surChoisir]);

  const H = 176;
  const LH = 40;
  return (
    <div className="rounded-3xl bg-carte border border-ligne p-3">
      <div className="relative flex items-stretch justify-center gap-1">
        <div
          className="absolute pointer-events-none rounded-xl bg-carte2"
          style={{ top: (H - LH) / 2, height: LH, left: 6, right: 6, opacity: 0.45 }}
        />
        <Roue
          valeurs={categories.map((c) => c.court)}
          index={Math.min(catIdx, categories.length - 1)}
          surIndex={(i) => { setCatIdx(i); setExoIdx(0); }}
          largeur={116}
          ligneH={LH}
          hauteur={H}
          police={13}
        />
        <div className="w-px bg-ligne my-6" />
        <Roue
          key={catIdx}
          valeurs={exos.map((e) => e.court)}
          index={exoClamp}
          surIndex={setExoIdx}
          largeur={196}
          ligneH={LH}
          hauteur={H}
          police={15}
        />
      </div>
    </div>
  );
}

function FeuilleCharge({ exo, valeurInitiale, surValider, surFermer }) {
  useVerrouScroll();
  const nombre = parseFloat(String(valeurInitiale).replace(",", "."));
  const initEntier = Number.isFinite(nombre) ? Math.max(0, Math.min(300, Math.floor(nombre))) : 20;
  const initDec = Number.isFinite(nombre) && Math.round((nombre % 1) * 10) >= 3 ? 1 : 0;
  const [entier, setEntier] = useState(initEntier);
  const [dec, setDec] = useState(initDec);

  const valeur = dec === 1 ? `${entier},5` : String(entier);

  return createPortal(
    <div className="fixed inset-0 z-50 voile font-jakarta text-encre" onClick={surFermer}>
      <div
        className="absolute bottom-0 inset-x-0 mx-auto max-w-md rounded-t-3xl bg-carte border-t border-ligne p-5 coussin-bas surgit"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 mb-2">
          <div className="flex-1 min-w-0">
            <h3 className="font-extrabold text-base leading-tight truncate">{exo.nom}</h3>
            <p className="text-brume text-xs mt-0.5">Charge utilisée</p>
          </div>
          <button
            onClick={surFermer}
            aria-label="Fermer"
            className="h-11 w-11 rounded-xl bg-carte2 flex items-center justify-center active:scale-95 transi"
          >
            <X size={18} className="text-brume" />
          </button>
        </div>

        <div className="relative flex items-center justify-center gap-1">
          <div
            className="absolute pointer-events-none rounded-xl bg-carte2"
            style={{ top: (200 - ROUE_H) / 2, height: ROUE_H, left: 24, right: 24, opacity: 0.45 }}
          />
          <Roue valeurs={ROUE_ENTIERS} index={entier} surIndex={setEntier} largeur={96} />
          <Roue valeurs={ROUE_DECIMALES} index={dec} surIndex={setDec} largeur={64} />
          <div style={{ height: 200 }} className="flex items-center">
            <span className="font-bold text-brume text-sm pl-1">kg</span>
          </div>
        </div>

        <div className="mt-4 flex items-center gap-2">
          <button
            onClick={() => surValider("")}
            className="h-14 px-4 rounded-2xl bg-carte2 text-brume text-sm font-bold active:scale-95 transi"
          >
            Effacer
          </button>
          <button
            onClick={() => surValider(valeur)}
            className="flex-1 h-14 rounded-2xl bg-accent text-accent-ink font-extrabold text-base active:scale-98 transi chiffres"
          >
            Valider {valeur} kg
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

function EtapeSimple({ icone: Icone, etiquette, coche, surCoche, children }) {
  return (
    <div className={`rounded-2xl bg-carte border p-4 transi ${coche ? "bordure-accent-douce" : "border-ligne"}`}>
      <div className="flex items-center gap-3">
        <span className="h-10 w-10 rounded-xl bg-accent-soft flex items-center justify-center shrink-0 transi">
          <Icone size={20} className="text-accent transi" />
        </span>
        <p className={`flex-1 font-bold text-sm ${coche ? "text-brume" : ""}`}>{etiquette}</p>
        <CaseCoche coche={coche} surClic={surCoche} />
      </div>
      <div className={coche ? "opacity-50 mt-3" : "mt-3"}>{children}</div>
    </div>
  );
}

function CarteExo({
  numero, total, exo, nomOriginal, variantes = [], profil, coche, seriesFaites, poids,
  dernierePerf, tabata, rounds, surCoche, surSeries, surRoue, surRepos, surVariante, surTabata,
}) {
  const nbPastilles = Math.min(6, Math.max(exo.series, seriesFaites));
  const aVariantes = variantes.length > 1;
  const [glisse, setGlisse] = useState(0);
  const depart = useRef(null);

  function toucheDebut(e) {
    if (!aVariantes) return;
    depart.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  }
  function toucheBouge(e) {
    if (!aVariantes || !depart.current) return;
    const dx = e.touches[0].clientX - depart.current.x;
    const dy = e.touches[0].clientY - depart.current.y;
    if (Math.abs(dy) > Math.abs(dx)) return;
    setGlisse(Math.max(-90, Math.min(90, dx)));
  }
  function toucheFin() {
    if (glisse <= -55) surVariante(1);
    else if (glisse >= 55) surVariante(-1);
    setGlisse(0);
    depart.current = null;
  }

  return (
    <div
      onTouchStart={toucheDebut}
      onTouchMove={toucheBouge}
      onTouchEnd={toucheFin}
      className={`rounded-2xl bg-carte border p-4 transi ${coche ? "bordure-accent-douce" : "border-ligne"}`}
      style={{
        touchAction: "pan-y",
        transform: glisse ? `translateX(${glisse}px)` : undefined,
        transition: glisse ? "none" : "transform 0.2s ease",
      }}
    >
      <div className="flex items-start gap-3">
        <div className={`flex-1 min-w-0 ${coche ? "opacity-60" : ""}`}>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-accent-soft text-accent transi">
              {exo.zone}
            </span>
            <span className="text-brume text-xs chiffres">Exo {numero}/{total}</span>
            {aVariantes && (
              <button
                onClick={() => surVariante(1)}
                aria-label={`Changer d'exercice (${variantes.length} variantes)`}
                className="flex items-center gap-1 text-xs font-bold px-2 py-0.5 rounded-full bg-carte2 text-douce active:scale-95 transi"
              >
                <ArrowLeftRight size={11} className="text-accent transi" />
                variante {variantes.findIndex((e) => e.id === exo.id) + 1}/{variantes.length}
              </button>
            )}
          </div>
          <h3 className="font-bold text-base mt-1.5 leading-snug">{exo.nom}</h3>
          {nomOriginal && (
            <p className="text-xs text-accent transi mt-0.5">En remplacement de : {nomOriginal}</p>
          )}
          <p className="text-sm mt-1 chiffres">
            {tabata ? (
              <>
                <strong className="text-accent transi">{rounds} rounds</strong>
                <span className="text-brume"> · {tabata.travail} s effort / {tabata.repos} s repos</span>
              </>
            ) : (
              <>
                <strong className="text-accent transi">{exo.series} × {exo.reps}</strong>
                <span className="text-brume"> · repos {exo.repos} s</span>
              </>
            )}
          </p>
          {dernierePerf ? (
            <p className="text-xs mt-1.5 leading-relaxed">
              <span className="text-accent transi font-bold">Dernière fois :</span>{" "}
              <span className="text-douce chiffres">
                {dernierePerf.series} × {dernierePerf.reps}
                {dernierePerf.charge ? ` · ${dernierePerf.charge} kg` : ""}
              </span>
              <span className="text-brume"> · {FORMAT_MINI.format(depuisCle(dernierePerf.d))}</span>
            </p>
          ) : (
            <p className="text-xs text-douce mt-1.5 leading-relaxed">{exo.charge[profil]}</p>
          )}
        </div>
        <CaseCoche coche={coche} surClic={surCoche} />
      </div>

      {/* séries faites : une pastille par série, tape après chaque série */}
      {!tabata && (
      <div className="mt-3 flex items-center gap-1.5 flex-wrap">
        <span className="text-xs text-brume font-bold mr-1">Séries</span>
        {Array.from({ length: nbPastilles }).map((_, i) => (
          <button
            key={i}
            onClick={() => surSeries(i + 1 === seriesFaites ? i : i + 1)}
            aria-label={`Série ${i + 1} ${i < seriesFaites ? "faite" : "à faire"}`}
            className={`h-9 w-9 rounded-full text-xs font-extrabold chiffres transi ${
              i < seriesFaites ? "bg-accent text-accent-ink" : "bg-carte2 text-brume active:scale-95"
            }`}
          >
            {i < seriesFaites ? <Check size={15} strokeWidth={3.5} className="mx-auto pop" /> : i + 1}
          </button>
        ))}
        {seriesFaites >= exo.series && nbPastilles < 6 && (
          <button
            onClick={() => surSeries(seriesFaites + 1)}
            aria-label="Ajouter une série bonus"
            className="h-9 w-9 rounded-full bg-carte2 text-brume flex items-center justify-center active:scale-95 transi"
          >
            <Plus size={15} />
          </button>
        )}
        <span className="text-xs text-brume chiffres ml-auto">{seriesFaites}/{exo.series}</span>
      </div>
      )}

      <div className={coche ? "opacity-50" : ""}>
        {exo.conseil ? <p className="text-xs text-brume mt-3 leading-relaxed">{exo.conseil}</p> : null}
        {exo.variante ? (
          <p className="text-xs text-brume mt-1.5 leading-relaxed italic">Variante : {exo.variante}</p>
        ) : null}

        <div className="mt-3 flex items-center gap-3 rounded-xl bg-fond p-2.5">
          <SchemaMuscles muscles={exo.muscles || []} hauteur={80} />
          <div className="flex-1 min-w-0">
            <p className="text-xs font-bold text-brume uppercase tracking-wide">Muscles travaillés</p>
            <p className="text-xs text-douce mt-1.5 leading-relaxed">
              {(exo.muscles || []).map((m) => MUSCLES_LIBELLES[m]).filter(Boolean).join(" · ") || "—"}
            </p>
          </div>
        </div>

        <div className="mt-3 flex items-center gap-2">
          {!exo.sansCharge && (
            <button
              onClick={surRoue}
              aria-label={`Charge utilisée pour ${exo.nom} : ${poids || "non renseignée"}`}
              className="flex-1 flex items-center gap-2 rounded-xl bg-carte2 px-3 text-left active:scale-98 transi"
              style={{ height: 48 }}
            >
              <span className="text-xs text-brume shrink-0">Charge</span>
              <span className="flex-1 min-w-0 text-right font-extrabold chiffres text-base truncate">
                {poids || "—"}
              </span>
              <span className="text-xs text-brume shrink-0">kg</span>
              <ChevronDown size={14} className="text-brume shrink-0" />
            </button>
          )}
          {tabata ? (
            <button
              onClick={surTabata}
              className={`rounded-xl bg-accent text-accent-ink px-4 font-extrabold text-sm flex items-center justify-center gap-2 active:scale-95 transi ${exo.sansCharge ? "flex-1" : "shrink-0"}`}
              style={{ height: 48 }}
            >
              <Play size={16} strokeWidth={2.5} />
              Lancer · ≈ {Math.max(1, Math.round((5 + rounds * tabata.travail + (rounds - 1) * tabata.repos) / 60))} min
            </button>
          ) : (
            <button
              onClick={surRepos}
              className={`rounded-xl bg-carte2 px-4 font-bold text-sm flex items-center justify-center gap-2 active:scale-95 transi ${exo.sansCharge ? "flex-1" : "shrink-0"}`}
              style={{ height: 48 }}
            >
              <Timer size={17} className="text-accent transi" />
              Repos {exo.repos} s
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
