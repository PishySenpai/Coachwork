import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Dumbbell, Check, ChevronLeft, ChevronDown, Flame, Timer, HeartPulse,
  Wind, Leaf, Moon, ShieldCheck, Sparkles, TrendingUp, X, Plus, Salad,
  Stethoscope, Scale, Cloud, CloudOff, Pencil, Trash2, Search,
  ChevronUp, Copy, SquarePen, ArrowLeftRight, Play, Pause, Share2, Download,
  RotateCcw, House, LayoutList, CalendarDays, CircleUser, Trophy, Zap, Weight, Activity,
  ArrowUpDown, ChevronRight, LogOut, Clock, Info, CalendarCheck, Users, UserPlus, Sun, SunMoon,
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

function idbCles() {
  return ouvrirIDB().then(
    (db) =>
      new Promise((res, rej) => {
        const r = db.transaction("kv", "readonly").objectStore("kv").getAllKeys();
        r.onsuccess = () => res(r.result || []);
        r.onerror = () => rej(r.error);
      })
  );
}

/* Les données sont rangées par espace sur l'appareil : deux espaces ouverts
   sur le même téléphone ne se mélangent jamais. Seules les clés qui
   identifient l'appareil restent hors de tout espace. */
function clePhysique(cle) {
  if (CLES_APPAREIL.has(cle)) return cle;
  return `${(espaceApp && espaceApp.id) || "local"}::${cle}`;
}

async function lire(cle) {
  const k = clePhysique(cle);
  try {
    const s = typeof window !== "undefined" ? window.storage : null;
    const fn = s && (s.getItem || s.get);
    if (typeof fn === "function") {
      const r = await fn.call(s, k);
      const v = r != null && typeof r === "object" && "value" in r ? r.value : r;
      return v == null ? null : JSON.parse(v);
    }
  } catch (e) {}
  try {
    const v = await idbLire(k);
    return v == null ? null : JSON.parse(v);
  } catch (e) {}
  return mem.has(k) ? JSON.parse(mem.get(k)) : null;
}

async function ecrireBrut(cle, valeur) {
  const k = clePhysique(cle);
  const v = JSON.stringify(valeur);
  mem.set(k, v);
  try {
    const s = typeof window !== "undefined" ? window.storage : null;
    const fn = s && (s.setItem || s.set);
    if (typeof fn === "function") {
      await fn.call(s, k, v);
      return;
    }
  } catch (e) {}
  try {
    await idbEcrire(k, v);
  } catch (e) {}
}

/* Reprise des données d'avant les espaces : on les range dans l'espace
   qui vient d'être adopté, une seule fois. */
async function migrerVersEspace(id) {
  try {
    const cles = await idbCles();
    const aMigrer = cles.filter(
      (k) => typeof k === "string" && !k.includes("::") && !CLES_APPAREIL.has(k)
    );
    if (!aMigrer.length) return;
    for (const k of aMigrer) {
      const cible = `${id}::${k}`;
      if (cles.includes(cible)) continue;
      const v = await idbLire(k);
      if (v != null) await idbEcrire(cible, v);
    }
  } catch (e) {}
}

/* ------------------------------------------------------------------ */
/* Synchronisation entre téléphones (API Vercel, si configurée)        */
/* Chaque clé porte un horodatage : le dernier écrit gagne.            */
/* ------------------------------------------------------------------ */

const API_SYNC = "/api/etat";
const API_ESPACE = "/api/espace";
const API_PARTAGE = "/api/partage";
/* Identifient l'appareil : hors espace, jamais synchronisées */
const CLES_APPAREIL = new Set(["app:code", "app:espace", "app:espacesConnus", "app:theme"]);
/* Rangées dans l'espace mais propres à l'appareil : jamais synchronisées */
const CLES_LOCALES = new Set(["app:profil", "app:horodatages", "app:code", "app:espace", "app:espacesConnus", "app:theme"]);

let horodatages = {};
let syncDisponible = false;
let codeApp = null; // code d'accès, gardé sur l'appareil uniquement
let espaceApp = null; // {id, nom} de l'espace ouvert sur cet appareil
const enAttente = new Map();
let minuteriePoussee = null;

function entetesSync(avecJson) {
  const h = {};
  if (avecJson) h["Content-Type"] = "application/json";
  if (codeApp) h["X-Code"] = codeApp;
  if (espaceApp && espaceApp.id) h["X-Espace"] = espaceApp.id;
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
  /* app déjà installée avant les espaces : on adopte celui que le serveur
     nous attribue, on y range les données locales existantes, et on reprend
     ses horodatages — sans rien demander à l'utilisateur */
  if (!espaceApp && j.espace) {
    espaceApp = { id: j.espace, nom: j.nom || j.espace, protege: j.protege !== false };
    await ecrireBrut("app:espace", espaceApp);
    await migrerVersEspace(espaceApp.id);
    const h = await lire("app:horodatages");
    if (h) horodatages = h;
  }
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

/* Niveau = jeu de charges conseillées d'un profil (les exercices donnent
   leurs repères pour ces deux niveaux, plus pour des prénoms en dur) */
const NIVEAUX = {
  standard: { nom: "Standard", detail: "Charges classiques, progression régulière" },
  doux: { nom: "Tout en douceur", detail: "Charges légères, articulations ménagées" },
};

const ACCENTS = [
  { id: "lime", nom: "Lime" },
  { id: "corail", nom: "Corail" },
  { id: "azur", nom: "Azur" },
  { id: "turquoise", nom: "Turquoise" },
  { id: "violet", nom: "Violet" },
];

/* Profils par défaut : le duo d'origine (mêmes identifiants qu'avant,
   donc les données déjà enregistrées restent en place) */
const PROFILS_DEFAUT = [
  { id: "esteban", nom: "Esteban", niveau: "standard", accent: "lime", detail: "Reprise en main" },
  { id: "valerie", nom: "Valérie", niveau: "doux", accent: "corail", detail: "Reprise en douceur" },
];

/* Un espace tout neuf démarre vierge : à chacun de composer ses profils */
const PROFILS_NEUFS = [{ id: "p1", nom: "Profil 1", niveau: "standard", accent: "lime" }];

const MESURES_DEFAUT = {
  esteban: { nom: "Esteban", age: "29", taille: "170", poids: "79" },
  valerie: { nom: "Valérie", age: "54", taille: "154", poids: "65" },
};

function nomAffiche(donneesProfil, prof) {
  const saisi = donneesProfil && donneesProfil.mesures ? (donneesProfil.mesures.nom || "").trim() : "";
  return saisi || (prof && prof.nom) || "Profil";
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
    charge: { standard: "Départ conseillé : 40–60 kg", doux: "Départ conseillé : 15–25 kg" },
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
    charge: { standard: "Haltère de 10–16 kg", doux: "Haltère de 4–8 kg" },
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
    charge: { standard: "2 haltères de 10–14 kg", doux: "2 haltères de 4–6 kg" },
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
    charge: { standard: "Départ conseillé : 25–35 kg", doux: "Départ conseillé : 10–15 kg" },
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
    charge: { standard: "Départ conseillé : 20–30 kg", doux: "Départ conseillé : 10–15 kg" },
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
      standard: "Haltère ou disque de 10–20 kg sur les hanches",
      doux: "Poids du corps, puis 5–10 kg quand c’est facile",
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
    charge: { standard: "Départ conseillé : 20–30 kg", doux: "Départ conseillé : 7,5–12,5 kg" },
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
    charge: { standard: "Départ conseillé : 15–20 kg", doux: "Départ conseillé : 5–10 kg" },
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
      standard: "Mains sur un banc bas, ou au sol",
      doux: "Mains sur une barre haute (cadre guidé)",
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
    charge: { standard: "Départ conseillé : 30–40 kg", doux: "Départ conseillé : 15–20 kg" },
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
    charge: { standard: "Départ conseillé : 30–40 kg", doux: "Départ conseillé : 15–20 kg" },
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
    charge: { standard: "Départ conseillé : 25–35 kg", doux: "Départ conseillé : 12–17 kg" },
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
    charge: { standard: "Sur les avant-bras, corps aligné", doux: "Sur les genoux au départ — parfait aussi" },
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
    charge: { standard: "Bras et jambe opposés tendus", doux: "Amplitude réduite au départ" },
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
    charge: { standard: "Sur l’avant-bras, pieds empilés", doux: "Genoux posés — version parfaite pour démarrer" },
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
    charge: { standard: "Barre seule pour apprendre, puis +2,5 kg par côté", doux: "Barre de la Smith seule, amplitude confortable" },
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
    charge: { standard: "2 haltères de 6–10 kg", doux: "Poids du corps, une main sur un support" },
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
    charge: { standard: "Départ conseillé : 35–50 kg", doux: "Départ conseillé : 15–25 kg" },
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
    charge: { standard: "Départ conseillé : 30–45 kg", doux: "Départ conseillé : 15–20 kg" },
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
    charge: { standard: "Départ conseillé : 10–15 kg", doux: "Départ conseillé : 5–7,5 kg" },
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
    charge: { standard: "Machine +20–40 kg, ou poids du corps sur une marche", doux: "Poids du corps sur une marche, en te tenant" },
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
    charge: { standard: "2 haltères de 10–14 kg", doux: "2 haltères de 3–5 kg" },
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
    charge: { standard: "15–25 kg machine, ou 2 haltères de 8–12 kg", doux: "5–10 kg machine, ou 2 haltères de 3–4 kg" },
    variante: "Pompes pieds au sol, mains sur banc incliné.",
    conseil: "Banc entre 30 et 45°. Vise le haut de la poitrine, sans cambrer le bas du dos.",
  },
  ecarte: {
    id: "ecarte",
    nom: "Écarté à la poulie vis-à-vis",
    zone: "Poitrine",
    series: 3,
    reps: "12",
    repos: 60,
    charge: { standard: "Départ conseillé : 10–15 kg par côté", doux: "Départ conseillé : 5–7,5 kg par côté" },
    variante: "Butterfly à la machine si les poulies sont prises.",
    conseil: "Bras presque tendus, grand mouvement d’accolade. Reste léger : c’est un exercice de finition.",
  },
  dips: {
    id: "dips",
    nom: "Dips assistés (machine)",
    zone: "Poitrine",
    series: 3,
    reps: "8",
    repos: 90,
    charge: { standard: "Assistance moyenne (–20 à –30 kg)", doux: "Assistance forte (–35 kg et plus)" },
    variante: "Ou pompes sur banc si la machine manque.",
    conseil: "Penche-toi légèrement en avant, descends jusqu’à 90° aux coudes — pas plus bas.",
  },
  "dev-couche-barre": {
    id: "dev-couche-barre",
    nom: "Développé couché à la barre",
    zone: "Poitrine",
    series: 3,
    reps: "8–10",
    repos: 120,
    charge: {
      standard: "Barre seule (20 kg) pour caler la technique, puis +2,5 kg par côté",
      doux: "Barre légère ou barre guidée (Smith), amplitude confortable",
    },
    variante: "À la barre guidée (Smith) ou aux haltères pour démarrer en sécurité.",
    conseil:
      "Omoplates serrées, pieds ancrés au sol, barre descendue au milieu de la poitrine puis poussée sans rebond. Toujours un pareur ou des sécurités quand tu charges.",
  },
  butterfly: {
    id: "butterfly",
    nom: "Butterfly (pec deck machine)",
    zone: "Poitrine",
    series: 3,
    reps: "12",
    repos: 60,
    charge: { standard: "Départ conseillé : 25–40 kg", doux: "Départ conseillé : 10–20 kg" },
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
    charge: { standard: "Départ conseillé : 20–30 kg", doux: "Départ conseillé : 10–15 kg" },
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
    charge: { standard: "2 haltères de 4–6 kg", doux: "2 haltères de 2–3 kg" },
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
    charge: { standard: "2 haltères de 4–6 kg", doux: "2 haltères de 2–3 kg" },
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
    charge: { standard: "Départ conseillé : 10–15 kg", doux: "Départ conseillé : 5–7,5 kg" },
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
    charge: { standard: "2 haltères de 10–14 kg", doux: "2 haltères de 4–6 kg" },
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
    charge: { standard: "Assistance –25 à –35 kg", doux: "Assistance –45 kg et plus" },
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
    charge: { standard: "Haltère de 10–16 kg", doux: "Haltère de 4–6 kg" },
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
    charge: { standard: "2 haltères de 6–10 kg", doux: "2 haltères de 2–4 kg" },
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
    charge: { standard: "2 haltères de 6–10 kg", doux: "2 haltères de 2–4 kg" },
    variante: "En alternant les bras pour rester propre.",
    conseil: "Paumes face à face, comme si tu plantais un clou. Zéro élan, zéro balancement.",
  },
  "triceps-poulie": {
    id: "triceps-poulie",
    nom: "Triceps à la poulie avec la barre",
    zone: "Bras",
    series: 3,
    reps: "12",
    repos: 60,
    charge: { standard: "Départ conseillé : 15–20 kg", doux: "Départ conseillé : 5–10 kg" },
    variante: "Version corde si tu veux plus d’amplitude en fin de mouvement.",
    conseil:
      "Barre droite ou coudée, prise largeur d’épaules, coudes soudés au buste. Tends complètement les bras vers le bas, remonte lentement sans décoller les coudes.",
  },
  "triceps-poulie-corde": {
    id: "triceps-poulie-corde",
    nom: "Triceps à la poulie avec la corde",
    zone: "Bras",
    series: 3,
    reps: "12",
    repos: 60,
    charge: { standard: "Départ conseillé : 12–17 kg", doux: "Départ conseillé : 5–10 kg" },
    variante: "Version barre pour charger un peu plus lourd.",
    conseil:
      "Coudes collés au corps, et surtout : écarte les deux brins de la corde en fin de mouvement, poignets vers l’extérieur. C’est là que le triceps se contracte le plus.",
  },
  "curl-poulie": {
    id: "curl-poulie",
    nom: "Biceps à la poulie",
    zone: "Bras",
    series: 3,
    reps: "12",
    repos: 60,
    charge: { standard: "Départ conseillé : 15–25 kg", doux: "Départ conseillé : 5–12 kg" },
    variante: "À la corde ou à la barre selon ce qui est libre.",
    conseil:
      "Debout face à la poulie basse, coudes fixes le long du buste. La poulie garde une tension constante du début à la fin — inutile de charger lourd, la descente lente fait le travail.",
  },
  crunch: {
    id: "crunch",
    nom: "Crunch au sol",
    zone: "Abdos & gainage",
    series: 3,
    reps: "15",
    repos: 45,
    sansCharge: true,
    charge: { standard: "Mains aux tempes", doux: "Bras tendus vers les genoux" },
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
    charge: { standard: "À la chaise romaine", doux: "Assise au bord d’un banc, mains derrière toi" },
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
    charge: { standard: "Disque ou haltère de 2,5–5 kg", doux: "Sans poids d’abord, mains jointes" },
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
    charge: { standard: "Rythme soutenu", doux: "Rythme lent, hanches bien stables" },
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
    charge: { standard: "Poids du corps, puis un disque de 5 kg contre la poitrine", doux: "Poids du corps, amplitude réduite" },
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
    charge: { standard: "Tiens 2 s en haut", doux: "Bras et jambe opposés en alternance" },
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
    charge: { standard: "Rythme soutenu, amplitude complète", doux: "Vers une chaise pour te repérer au départ" },
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
    charge: { standard: "Poids du corps, ou haltère de 12–20 kg tenu vertical", doux: "Poids du corps, puis haltère léger" },
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
    charge: { standard: "Poids du corps, puis 2 haltères de 6–10 kg", doux: "Poids du corps, une main en appui" },
    variante: "Chaise, banc ou marche : tout support stable fait l’affaire.",
    conseil: "Pied arrière posé sur le support, tout le poids sur la jambe avant. Descends droit, genou avant au-dessus de la cheville.",
  },

  /* --- Cardio. Dépense estimée avec les valeurs MET du 2024 Adult
     Compendium of Physical Activities (Herrmann et al., J Sport Health
     Sci 2024) — code de l'activité en commentaire.
     Cardio continu : `duree` (minutes), on note le temps fait.
     Cardio fractionné : séries classiques, au poids du corps. --- */
  "marche-inclinee": {
    id: "marche-inclinee",
    nom: "Marche inclinée sur tapis",
    zone: "Cardio",
    series: 1, reps: "20 min", repos: 0, duree: 20,
    sansCharge: true,
    met: { standard: 7.0, doux: 5.3 }, // 17035 (pente 6–10 %) · 17034 (pente 1–5 %)
    charge: {
      standard: "Pente 6–10 %, 5 à 5,5 km/h, sans te tenir aux barres",
      doux: "Pente 1–5 %, 4,5 à 5 km/h, à une allure où tu peux parler",
    },
    variante: "Dehors : une côte ou un chemin vallonné, à pas soutenus.",
    conseil: "Lâche les barres : s’y tenir enlève une bonne partie du travail. Buste droit, foulée naturelle — augmente la pente avant la vitesse.",
  },
  "marche-rapide": {
    id: "marche-rapide",
    nom: "Marche rapide",
    zone: "Cardio",
    series: 1, reps: "30 min", repos: 0, duree: 30,
    sansCharge: true,
    met: { standard: 5.5, doux: 4.8 }, // 17220 (6,5–7 km/h) · 17200 (5,5–6,2 km/h)
    charge: {
      standard: "6,5 à 7 km/h, sur tapis à plat ou dehors",
      doux: "5,5 à 6 km/h : le souffle un peu court, la conversation possible",
    },
    variante: "Parfaite les jours de repos : elle aide à récupérer sans fatiguer.",
    conseil: "Pas rapides plutôt que longs, bras qui balancent. Le bon rythme : tu peux parler, pas chanter.",
  },
  course: {
    id: "course",
    nom: "Course à pied (footing)",
    zone: "Cardio",
    series: 1, reps: "20 min", repos: 0, duree: 20,
    sansCharge: true,
    met: { standard: 8.5, doux: 6.0 }, // 12030 (8–8,4 km/h) · 12010 (marche-course alternée)
    charge: {
      standard: "8 à 9 km/h, souffle régulier",
      doux: "Alterne 2 min de marche rapide et 1 min de trot léger",
    },
    variante: "Sur tapis, règle 1 % de pente : c’est plus proche de la course dehors.",
    conseil: "Petites foulées, le pied se pose sous le corps et pas loin devant. Plus capable de dire une phrase entière ? Ralentis.",
  },
  velo: {
    id: "velo",
    nom: "Vélo d’appartement",
    zone: "Cardio",
    series: 1, reps: "20 min", repos: 0, duree: 20,
    sansCharge: true,
    met: { standard: 6.8, doux: 5.0 }, // 01224 (101–125 W) · 01216 (60 W)
    charge: {
      standard: "100 à 125 W, cadence 80–90 tr/min",
      doux: "50 à 70 W, cadence souple — zéro impact pour les genoux",
    },
    variante: "Version semi-allongée (dos soutenu) si ta salle en a une.",
    conseil: "Selle réglée : jambe presque tendue quand la pédale est en bas. Mouline plutôt que d’écraser les pédales.",
  },
  elliptique: {
    id: "elliptique",
    nom: "Vélo elliptique",
    zone: "Cardio",
    series: 1, reps: "20 min", repos: 0, duree: 20,
    sansCharge: true,
    met: { standard: 5.0, doux: 5.0 }, // 02048 (effort modéré)
    charge: {
      standard: "Résistance moyenne, une accélération d’1 min toutes les 3 min",
      doux: "Résistance légère, allure régulière — aucun impact",
    },
    variante: "Sans les poignées pour travailler l’équilibre et la sangle abdominale.",
    conseil: "Pousse et tire les poignées : les bras participent. Les talons restent en contact avec les pédales.",
  },
  rameur: {
    id: "rameur",
    nom: "Rameur",
    zone: "Cardio",
    series: 1, reps: "15 min", repos: 0, duree: 15,
    sansCharge: true,
    met: { standard: 7.5, doux: 5.0 }, // 02072 (100–149 W) · 02071 (moins de 100 W)
    charge: {
      standard: "100 à 150 W, 22 à 26 coups par minute",
      doux: "Moins de 100 W, 18 à 22 coups par minute, sans forcer",
    },
    variante: "Le dos tire ? Passe sur le vélo ou l’elliptique.",
    conseil: "À l’aller : jambes, puis buste, puis bras — et l’inverse au retour. Dos droit : ce sont surtout les jambes qui poussent.",
  },
  stepper: {
    id: "stepper",
    nom: "Stepper (simulateur d’escalier)",
    zone: "Cardio",
    series: 1, reps: "15 min", repos: 0, duree: 15,
    sansCharge: true,
    met: 9.3, // 02065
    charge: {
      standard: "Rythme régulier que tu peux tenir tout du long",
      doux: "Rythme lent, 10 min pour commencer — le vélo si les genoux protestent",
    },
    variante: "De vrais escaliers, à ton rythme.",
    conseil: "Tout le pied sur la marche, buste droit. Effleure les poignées sans t’y appuyer de tout ton poids.",
  },
  "corde-a-sauter": {
    id: "corde-a-sauter",
    nom: "Corde à sauter",
    zone: "Cardio",
    series: 5, reps: "1 min", repos: 45,
    sansCharge: true,
    met: { standard: 11.0, doux: 4.8 }, // 02068 · 12025 (trottiner sur place)
    charge: {
      standard: "Rythme régulier, petits sauts",
      doux: "Sans corde : petits pas sautillés sur place, à ton rythme",
    },
    variante: "Corde imaginaire si le plafond ou les genoux ne suivent pas.",
    conseil: "Sauts de 2–3 cm seulement, sur l’avant du pied. Ce sont les poignets qui font tourner la corde, pas les épaules.",
  },
  "jumping-jacks": {
    id: "jumping-jacks",
    nom: "Jumping jacks",
    zone: "Cardio",
    series: 3, reps: "40 s", repos: 30,
    sansCharge: true,
    met: { standard: 7.5, doux: 3.8 }, // 02020 (vigoureux) · 02022 (modéré)
    charge: {
      standard: "Rythme vif, réception souple",
      doux: "Sans saut : un pas sur le côté, les bras qui montent",
    },
    variante: "Version sans saut pour ménager les genoux.",
    conseil: "Réception sur l’avant du pied, genoux légèrement fléchis. Les bras se rejoignent au-dessus de la tête.",
  },
  "montees-genoux": {
    id: "montees-genoux",
    nom: "Montées de genoux",
    zone: "Cardio",
    series: 3, reps: "30 s", repos: 30,
    sansCharge: true,
    met: { standard: 7.5, doux: 3.8 }, // 02020 · 02022
    charge: {
      standard: "Genoux à hauteur de hanches, rythme vif",
      doux: "En marchant sur place, genoux hauts, sans sauter",
    },
    variante: "Talons-fesses pour varier.",
    conseil: "Buste droit, ventre serré, les bras accompagnent. Reste sur l’avant des pieds.",
  },
  burpees: {
    id: "burpees",
    nom: "Burpees",
    zone: "Cardio",
    series: 3, reps: "10", repos: 60,
    sansCharge: true,
    met: { standard: 7.5, doux: 3.8 }, // 02020 · 02022
    charge: {
      standard: "Avec la pompe et le saut",
      doux: "Sans saut ni pompe, mains sur un banc, pieds qui reculent en marchant",
    },
    variante: "Mains sur un banc pour une version plus douce.",
    conseil: "Accroupis-toi, mains au sol, pieds en arrière, retour, puis saut bras en l’air. La qualité avant la vitesse : dos gainé à chaque passage.",
  },
  "squat-saute": {
    id: "squat-saute",
    nom: "Squats sautés",
    zone: "Cardio",
    series: 3, reps: "12", repos: 60,
    sansCharge: true,
    met: { standard: 7.5, doux: 3.8 }, // 02020 · 02022
    charge: {
      standard: "Saut explosif, réception amortie",
      doux: "Sans saut : squat rapide en finissant sur la pointe des pieds",
    },
    variante: "Squat au poids du corps si les genoux n’aiment pas les sauts.",
    conseil: "Réception silencieuse sur l’avant du pied, genoux dans l’axe des pointes, et tu enchaînes directement la descente suivante.",
  },
};

/* Catalogue par zone (ordre d'affichage dans le sélecteur) */
const ZONES = [
  ["Jambes & fessiers", ["presse", "squat-barre", "goblet", "squat-sumo", "squat-pdc", "fentes", "fentes-bulgares", "souleve-roumain", "leg-curl", "leg-extension", "hip-thrust", "abduction", "adduction", "kickback-fessier", "mollets"]],
  ["Poitrine", ["dev-poitrine", "dev-couche-barre", "dev-couche", "dev-incline", "pompes", "butterfly", "ecarte", "pull-over", "dips"]],
  ["Épaules", ["dev-epaules", "elevations-laterales", "oiseau", "face-pull", "shrugs"]],
  ["Dos", ["tirage-vertical", "traction-assistee", "rowing", "tirage-horizontal", "rowing-haltere"]],
  ["Bras", ["curl-biceps", "curl-marteau", "curl-poulie", "triceps-poulie", "triceps-poulie-corde"]],
  ["Abdos & gainage", ["planche", "planche-laterale", "dead-bug", "crunch", "releve-genoux", "russian-twist", "mountain-climbers", "extension-lombaire", "superman"]],
  ["Cardio", ["marche-inclinee", "marche-rapide", "course", "velo", "elliptique", "rameur", "stepper", "corde-a-sauter", "jumping-jacks", "montees-genoux", "burpees", "squat-saute"]],
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
  Cardio: ["quadriceps", "fessiers", "mollets"],
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
  "dev-couche-barre": ["pectoraux", "triceps", "epaules"],
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
  "triceps-poulie-corde": ["triceps"],
  "curl-poulie": ["biceps", "avant-bras"],
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
  "marche-inclinee": ["fessiers", "ischios", "mollets", "quadriceps"],
  "marche-rapide": ["quadriceps", "mollets", "fessiers"],
  course: ["quadriceps", "ischios", "mollets", "fessiers"],
  velo: ["quadriceps", "fessiers", "mollets"],
  elliptique: ["quadriceps", "fessiers", "ischios", "epaules"],
  rameur: ["dorsaux", "quadriceps", "fessiers", "ischios", "biceps", "lombaires"],
  stepper: ["fessiers", "quadriceps", "mollets"],
  "corde-a-sauter": ["mollets", "quadriceps", "epaules", "avant-bras"],
  "jumping-jacks": ["mollets", "quadriceps", "fessiers", "epaules", "abducteurs"],
  "montees-genoux": ["quadriceps", "abdos", "mollets"],
  burpees: ["quadriceps", "fessiers", "pectoraux", "triceps", "abdos", "epaules"],
  "squat-saute": ["quadriceps", "fessiers", "mollets"],
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
  "cardio-continu": "Cardio continu",
  "cardio-fractionne": "Cardio fractionné",
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
  "dev-couche-barre": "poussee-poitrine",
  "dev-incline": "poussee-poitrine", pompes: "poussee-poitrine",
  ecarte: "poussee-poitrine", dips: "poussee-poitrine",
  butterfly: "poussee-poitrine", "pull-over": "poussee-poitrine",
  "dev-epaules": "epaules", "elevations-laterales": "epaules",
  oiseau: "arriere-epaule", "face-pull": "arriere-epaule",
  shrugs: "trapezes",
  "tirage-vertical": "tirage-vertical", "traction-assistee": "tirage-vertical",
  rowing: "tirage-horizontal", "tirage-horizontal": "tirage-horizontal", "rowing-haltere": "tirage-horizontal",
  "curl-biceps": "biceps", "curl-marteau": "biceps", "curl-poulie": "biceps",
  "triceps-poulie": "triceps", "triceps-poulie-corde": "triceps",
  planche: "gainage-ventral", "dead-bug": "gainage-ventral", "mountain-climbers": "gainage-ventral",
  "planche-laterale": "obliques", "russian-twist": "obliques",
  crunch: "abdos-flexion", "releve-genoux": "abdos-flexion",
  "extension-lombaire": "lombaires", superman: "lombaires",
  "marche-inclinee": "cardio-continu", "marche-rapide": "cardio-continu", course: "cardio-continu",
  velo: "cardio-continu", elliptique: "cardio-continu", rameur: "cardio-continu", stepper: "cardio-continu",
  "corde-a-sauter": "cardio-fractionne", "jumping-jacks": "cardio-fractionne",
  "montees-genoux": "cardio-fractionne", burpees: "cardio-fractionne", "squat-saute": "cardio-fractionne",
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

/* MET d'un exercice : la valeur du Compendium quand l'exercice en porte une
   (cardio), sinon l'estimation par famille de mouvement */
function metDe(exo, niveau) {
  if (exo && exo.met) {
    return typeof exo.met === "number" ? exo.met : exo.met[niveau] || exo.met.standard;
  }
  return metPourExo(exo);
}

/* charge moyenne d'un exercice fait (les séries peuvent différer) */
function chargeMoyenne(dexo) {
  const liste = (Array.isArray(dexo.charges) ? dexo.charges : [dexo.charge])
    .map(parseCharge)
    .filter((x) => x != null);
  return liste.length ? liste.reduce((a, b) => a + b, 0) / liste.length : null;
}

/* kcal d'un exercice fait, à partir des données figées de l'historique */
function kcalExo(dexo, poidsKg, { tabata, niveau, dico } = {}) {
  const exo = (dico && dico[dexo.id]) || EXOS[dexo.id];
  const met = tabata ? MET_TABATA : metDe(exo, niveau);
  let minutes;
  if (tabata) {
    minutes = (dexo.series * (tabata.travail + tabata.repos)) / 60;
  } else if (dexo.minutes) {
    minutes = dexo.minutes; // cardio continu : le temps réellement fait
  } else {
    minutes = minutesExo(dexo.series, exo ? exo.repos : 60);
  }
  const charge = chargeMoyenne(dexo);
  const bonusCharge = charge ? Math.min(0.3, charge / (poidsKg * 2)) : 0;
  return met * poidsKg * (minutes / 60) * (1 + bonusCharge);
}

/* Total séance : exercices faits + échauffement + étirements, et le cardio
   générique de fin de séance seulement s'il a été coché.
   `detail` vient du snapshot ; `poidsKg` du profil. */
function estimerCaloriesSeance(detail, poidsKg, { tabata = null, niveau = "standard", cardio = false, dico } = {}) {
  if (!poidsKg || !detail) return null;
  let kcal = 0;
  for (const dexo of detail) kcal += kcalExo(dexo, poidsKg, { tabata, niveau, dico });
  kcal += 3.5 * poidsKg * (7 / 60); // échauffement ~7 min doux
  if (cardio) kcal += 5 * poidsKg * (17 / 60); // cardio ~17 min modéré
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
  duree: { standard: "5 à 7 min", doux: "8 à 10 min" },
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
  standard:
    "15–20 min au choix : tapis incliné, vélo ou elliptique, à allure modérée. Option : quelques passages plus toniques d’une minute.",
  doux:
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
          standard:
            "Tapis : 15–20 min de marche rapide inclinée (5–8 %, 5,5–6,5 km/h). Option intervalles doux : 6 × (1 min tonique / 1 min tranquille).",
          doux:
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
          standard:
            "Elliptique : 15–20 min, résistance moyenne. Option : monte la résistance d’un cran 1 min sur 3.",
          doux: "Elliptique : 15 min tranquilles, résistance légère. Aucun impact, que du bénéfice.",
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
          standard:
            "Vélo : 15–20 min. Option : augmente la résistance d’un palier toutes les 5 min, puis redescends sur les 3 dernières.",
          doux:
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
          standard:
            "Tapis : 15–20 min de marche inclinée — les jambes sont fraîches, profites-en. Option : 6 × (1 min tonique / 1 min tranquille).",
          doux: "Vélo ou elliptique : 15–20 min à allure modérée, zéro impact.",
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
          standard: "Elliptique : 15 min tranquilles — les jambes ont déjà bien travaillé aujourd’hui.",
          doux: "Elliptique : 12–15 min très douces, résistance légère.",
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
          standard: "Vélo : 15–20 min. Option : augmente la résistance d’un palier toutes les 5 min.",
          doux: "Vélo : 15–20 min, selle bien réglée : jambe presque tendue quand la pédale est en bas.",
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
      /* un exercice de cardio continu dans la séance remplace le cardio générique */
      cardio: s.tabata || s.exoIds.some((eid) => dico[eid] && dico[eid].duree) ? null : CARDIO_GENERIQUE,
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
    id: "cardio",
    icone: HeartPulse,
    titre: "Le cardio, bien dosé",
    texte: [
      "Le repère de l’OMS (2020) pour les adultes : 150 à 300 min d’endurance modérée par semaine, ou 75 à 150 min d’effort soutenu, en plus du renforcement musculaire au moins 2 jours par semaine. Tes séances en couvrent déjà une bonne partie ; la marche des jours off fait le reste.",
      "Le bon rythme se règle au souffle : en modéré, tu peux parler mais pas chanter ; en soutenu, seulement quelques mots. Chaque exercice cardio de l’app donne des réglages pour ton niveau (pente, watts, cadence), et l’énergie dépensée est estimée avec le Compendium of Physical Activities (2024), la référence scientifique en la matière.",
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
/* chargesSeries : {slotId: {exo, v: [charge de chaque série]}} — saisies du jour
   durees : {slotId: {exo, v: minutes}} — cardio continu
   debut / maj : jour de la première action, horodatage de la dernière
   (sert à valider toute seule une séance oubliée) */
function seanceVierge() {
  return { coches: {}, series: {}, remplacements: {}, ajouts: [], ordre: [], chargesSeries: {}, durees: {} };
}

function normaliserSeance(brut) {
  if (!brut) return seanceVierge();
  if (brut.coches)
    return {
      coches: brut.coches,
      series: brut.series || {},
      remplacements: brut.remplacements || {},
      ajouts: brut.ajouts || [],
      ordre: brut.ordre || [],
      chargesSeries: brut.chargesSeries || {},
      durees: brut.durees || {},
      ...(brut.debut ? { debut: brut.debut, maj: brut.maj || 0, ...(brut.t0 ? { t0: brut.t0 } : {}) } : {}),
    };
  return { ...seanceVierge(), coches: brut };
}

/* retire un emplacement (ajout) et nettoie tout ce qui s'y rattache */
function retirerSlot(seance, slotId) {
  const sansCle = (o) => { const c = { ...o }; delete c[slotId]; return c; };
  return {
    ...seance,
    coches: sansCle(seance.coches),
    series: sansCle(seance.series),
    remplacements: sansCle(seance.remplacements),
    chargesSeries: sansCle(seance.chargesSeries),
    durees: sansCle(seance.durees),
    ajouts: seance.ajouts.filter((a) => a.slotId !== slotId),
    ordre: seance.ordre.filter((id) => id !== slotId),
  };
}

/* Séance réellement commencée (et pas juste ouverte pour regarder) :
   une étape cochée, une série faite, une charge ou une durée notée */
function seanceDemarree(et) {
  return (
    Object.values(et.coches).some((v) => v === true) ||
    Object.values(et.series).some((n) => n > 0) ||
    Object.values(et.chargesSeries).some((c) => c && Array.isArray(c.v) && c.v.some((x) => x != null)) ||
    Object.keys(et.durees).length > 0
  );
}

/* Oubli de validation : commencée un jour passé, et plus touchée depuis
   3 h (une séance à cheval sur minuit n'est pas coupée en deux) */
const DELAI_OUBLI = 3 * 3600 * 1000;
function seanceOubliee(et, auj, maintenant) {
  return !!et.debut && et.debut < auj && maintenant - (et.maj || 0) > DELAI_OUBLI && seanceDemarree(et);
}

/* Programmes supprimés : gardés 3 jours, restaurables, puis effacés */
const DUREE_CORBEILLE = 3 * 24 * 3600 * 1000;
function purgerCorbeille(liste, maintenant = Date.now()) {
  return (Array.isArray(liste) ? liste : []).filter(
    (e) => e && e.prog && maintenant - e.supprimeLe < DUREE_CORBEILLE
  );
}

/* dernière performance enregistrée par exercice (séance validée la plus récente) */
function dernieresPerfsDe(historique) {
  const m = {};
  for (let i = historique.length - 1; i >= 0; i--) {
    const h = historique[i];
    if (!h.detail) continue;
    for (const dexo of h.detail) {
      if (!m[dexo.id]) m[dexo.id] = { ...dexo, d: h.d };
    }
  }
  return m;
}

/* Charges affichées sur n séries : celle saisie aujourd'hui pour la série,
   sinon celle de la même série la dernière fois, sinon la charge notée sur
   l'exercice. Une charge changée à la main se reporte sur les séries
   suivantes qui n'ont pas la leur. */
function chargesDeSerie(n, entree, exoId, perf, chargeGlobale) {
  const saisies = entree && entree.exo === exoId && Array.isArray(entree.v) ? entree.v : [];
  const avant = perf
    ? Array.isArray(perf.charges) && perf.charges.length
      ? perf.charges.map((c) => c || "")
      : perf.charge
      ? [perf.charge]
      : []
    : [];
  const out = [];
  let report = null;
  for (let i = 0; i < n; i++) {
    const parDefaut =
      report != null ? report : avant.length ? avant[Math.min(i, avant.length - 1)] : chargeGlobale || "";
    if (saisies[i] != null) {
      out.push(saisies[i]);
      if (saisies[i] !== parDefaut) report = saisies[i];
    } else {
      out.push(parDefaut);
    }
  }
  return out;
}

function formatKg(n) {
  return String(Math.round(n * 10) / 10).replace(".", ",");
}

/* « 50 kg », ou « 50 / 52,5 / 55 kg » quand les séries diffèrent */
function texteCharges(dexo) {
  const liste = Array.isArray(dexo.charges) ? dexo.charges.filter(Boolean) : [];
  if (liste.length > 1 && new Set(liste).size > 1) return `${liste.join(" / ")} kg`;
  const c = liste[0] || dexo.charge;
  return c ? `${c} kg` : "";
}

/* résumé d'un exercice fait : « 3 × 12 · 50 kg » ou « 25 min » */
function texteDetail(dexo) {
  if (dexo.minutes) return `${dexo.minutes} min`;
  const ch = texteCharges(dexo);
  return `${dexo.series} × ${dexo.reps}${ch ? ` · ${ch}` : ""}`;
}

/* ordre d'affichage des emplacements : l'ordre choisi pour la séance du jour
   d'abord (s'il existe), puis tout emplacement non encore classé */
function ordonnerSlots(slots, ordre) {
  if (!ordre || !ordre.length) return slots;
  const rang = new Map(ordre.map((id, i) => [id, i]));
  return [...slots].sort((a, b) => {
    const ra = rang.has(a.slotId) ? rang.get(a.slotId) : Infinity;
    const rb = rang.has(b.slotId) ? rang.get(b.slotId) : Infinity;
    return ra - rb;
  });
}

/* emplacements d'une séance = exercices du programme + ajouts du jour,
   dans l'ordre choisi pour la séance */
function slotsDe(seance, et, dico) {
  return ordonnerSlots(
    [
      ...seance.exos.map((e) => ({ slotId: e.id, base: e, rounds: (seance.rounds && seance.rounds[e.id]) || 8, ajout: false })),
      ...et.ajouts
        .map((a) => ({ slotId: a.slotId, base: dico[a.exoId], rounds: a.rounds || 8, ajout: true }))
        .filter((s) => s.base),
    ],
    et.ordre
  );
}

function exoDuSlot(s, et, dico) {
  return (et.remplacements[s.slotId] && dico[et.remplacements[s.slotId]]) || s.base;
}

/* Instantané d'une séance à la validation : ce qui a vraiment été fait
   (variantes comprises), séries, charges de chaque série ou durée, et
   l'énergie dépensée estimée. Un exercice commencé compte, même incomplet. */
function instantaneSeance(seance, et, donnees, dico, niveau) {
  const perfs = dernieresPerfsDe(donnees.historique);
  const detail = [];
  for (const s of slotsDe(seance, et, dico)) {
    const exo = exoDuSlot(s, et, dico);
    if (!exo) continue;
    const coche = !!et.coches[s.slotId];
    const base = { id: exo.id, nom: exo.nom };

    if (seance.tabata) {
      if (!coche && !(et.series[s.slotId] > 0)) continue;
      detail.push({
        ...base,
        series: s.rounds,
        reps: `rounds tabata ${seance.tabata.travail}/${seance.tabata.repos}`,
        charge: exo.sansCharge ? null : donnees.charges[exo.id] || null,
      });
      continue;
    }

    if (exo.duree) {
      const d = et.durees[s.slotId];
      const saisie = d && d.exo === exo.id ? d.v : null;
      if (!coche && saisie == null) continue;
      const minutes = saisie != null ? saisie : (perfs[exo.id] && perfs[exo.id].minutes) || exo.duree;
      detail.push({ ...base, series: 1, reps: `${minutes} min`, minutes, charge: null });
      continue;
    }

    const entree = et.chargesSeries[s.slotId];
    const nbSaisies = entree && entree.exo === exo.id ? entree.v.filter((x) => x != null && x !== "").length : 0;
    let n = et.series[s.slotId] || 0;
    if (!n && coche) n = exo.series;
    if (!n && !exo.sansCharge) n = nbSaisies;
    if (!n) continue;
    if (exo.sansCharge) {
      detail.push({ ...base, series: n, reps: exo.reps, charge: null });
      continue;
    }
    const charges = chargesDeSerie(n, entree, exo.id, perfs[exo.id], donnees.charges[exo.id]).map((c) => c || null);
    const valeurs = charges.map(parseCharge).filter((x) => x != null);
    detail.push({
      ...base,
      series: n,
      reps: exo.reps,
      /* la plus lourde de la séance : c'est elle que suit la courbe de progrès */
      charge: valeurs.length ? formatKg(Math.max(...valeurs)) : null,
      charges,
    });
  }
  const kcal = estimerCaloriesSeance(detail, parseCharge(donnees.mesures.poids), {
    tabata: seance.tabata || null,
    niveau,
    cardio: !!seance.cardio && !!et.coches.cardio,
    dico,
  });
  return { detail, kcal };
}

/* À la validation, la charge notée sur chaque exercice devient celle de sa
   dernière série : c'est le point de départ affiché tant qu'il n'y a pas
   d'historique pour cet exercice (et la charge des séances tabata). */
function chargesApres(charges, detail) {
  let maj = charges;
  for (const dexo of detail) {
    const derniere = Array.isArray(dexo.charges) ? [...dexo.charges].reverse().find(Boolean) : null;
    if (derniere && maj[dexo.id] !== derniere) maj = { ...maj, [dexo.id]: derniere };
  }
  return maj;
}

/* Durée réelle d'une séance (de la première action à la fin), en minutes.
   Rien en dessous de 5 min ou au-delà de 4 h : la mesure n'aurait pas de sens. */
function dureeSeance(et, fin) {
  if (!et.t0) return null;
  const min = Math.round((fin - et.t0) / 60000);
  return min >= 5 && min <= 240 ? min : null;
}

/* Records battus : charge plus lourde que tout ce qui a été noté avant sur
   l'exercice (un premier passage n'est pas un record, il n'y a rien à battre) */
function recordsBattus(detail, historique) {
  const max = {};
  for (const h of historique) {
    for (const d of h.detail || []) {
      const c = parseCharge(d.charge);
      if (c != null && (max[d.id] == null || c > max[d.id])) max[d.id] = c;
    }
  }
  return detail
    .filter((d) => {
      const c = parseCharge(d.charge);
      return c != null && max[d.id] != null && c > max[d.id];
    })
    .map((d) => ({ id: d.id, nom: d.nom, charge: d.charge, gain: formatKg(parseCharge(d.charge) - max[d.id]) }));
}

/* Volume soulevé d'un exercice fait (kg) : Σ charge × répétitions par série */
function volumeExo(dexo) {
  const reps = parseInt(String(dexo.reps || ""), 10);
  if (!reps || dexo.minutes) return 0;
  const charges = Array.isArray(dexo.charges) && dexo.charges.length
    ? dexo.charges
    : Array.from({ length: dexo.series || 0 }, () => dexo.charge);
  return charges.reduce((tot, c) => tot + (parseCharge(c) || 0) * reps, 0);
}

async function chargerTout() {
  const persos = (await lire("app:programmesPerso")) || [];
  const exosPerso = (await lire("app:exosPerso")) || [];
  const brutCorbeille = await lire("app:corbeille");
  const corbeille = purgerCorbeille(brutCorbeille);
  if (Array.isArray(brutCorbeille) && corbeille.length !== brutCorbeille.length) {
    ecrire("app:corbeille", corbeille); // plus de 3 jours : effacés pour de bon
  }
  const brutProfils = await lire("app:profils");
  /* le duo d'origine garde ses profils ; tout autre espace démarre vierge */
  const origine = !espaceApp || espaceApp.id === "principal";
  const profils =
    Array.isArray(brutProfils) && brutProfils.length
      ? brutProfils
      : origine
      ? PROFILS_DEFAUT
      : PROFILS_NEUFS;
  /* les séances des programmes en corbeille aussi : une restauration
     les retrouve telles qu'elles étaient */
  const ids = idsSeancesDe([...persos, ...corbeille.map((e) => e.prog)]);
  const res = {};
  for (const p of profils.map((x) => x.id)) {
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
      mesures: { ...(MESURES_DEFAUT[p] || {}), ...(mesures || {}) },
    };
  }
  return { persos, exosPerso, corbeille, profils, res };
}

/* ------------------------------------------------------------------ */
/* Petits composants                                                   */
/* ------------------------------------------------------------------ */

/* Case à cocher ronde (étapes, exercices) */
function CaseCoche({ coche, surClic, taille = 44, etiquette }) {
  return (
    <button
      onClick={surClic}
      aria-pressed={coche}
      aria-label={etiquette || (coche ? "Marquer comme à faire" : "Marquer comme fait")}
      className="shrink-0 flex items-center justify-center"
      style={{ height: taille, width: taille }}
    >
      <span
        className={`rounded-full flex items-center justify-center transi ${
          coche ? "bg-accent" : "border-2 border-carte3 active:scale-90"
        }`}
        style={{ height: taille - 8, width: taille - 8 }}
      >
        {coche && <Check className="pop text-accent-ink" size={Math.round(taille * 0.42)} strokeWidth={3.5} />}
      </span>
    </button>
  );
}

/* Anneau de progression (semaine, repos, fête, tabata) */
function Anneau({ fait, total, taille = 112, epaisseur = 10, children }) {
  const R = (taille - epaisseur) / 2;
  const C = 2 * Math.PI * R;
  const frac = total ? Math.max(0, Math.min(fait / total, 1)) : 0;
  return (
    <div className="relative shrink-0" style={{ width: taille, height: taille }}>
      <svg viewBox={`0 0 ${taille} ${taille}`} width={taille} height={taille} className="-rotate-90">
        <circle cx={taille / 2} cy={taille / 2} r={R} fill="none" strokeWidth={epaisseur} className="stroke-piste" />
        <circle
          cx={taille / 2} cy={taille / 2} r={R} fill="none" strokeWidth={epaisseur} strokeLinecap="round"
          className="stroke-accent anneau"
          strokeDasharray={C}
          strokeDashoffset={C * (1 - frac)}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">{children}</div>
    </div>
  );
}

/* Séances par semaine : une barre par semaine, l'objectif en pointillé ;
   les semaines où l'objectif est atteint sont en pleine couleur */
function Barres({ barres, objectif = 3 }) {
  const max = Math.max(objectif, ...barres.map((b) => b.n), 1);
  const H = 96;
  return (
    <div className="relative">
      <div
        className="absolute left-0 right-0 border-t border-dashed border-carte3"
        style={{ bottom: 22 + (objectif / max) * H }}
        aria-hidden="true"
      />
      <div className="flex items-end gap-2">
        {barres.map((b, i) => {
          const actuelle = i === barres.length - 1;
          return (
            <div key={b.semaine} className="flex-1 flex flex-col items-center gap-1.5">
              <span className={`text-[11px] chiffres font-bold ${b.n ? "text-douce" : "text-transparent"}`}>{b.n}</span>
              <div className="w-full flex items-end" style={{ height: H }}>
                <div
                  className={`w-full rounded-[7px] barre ${b.n ? "bg-accent" : "bg-carte2"}`}
                  style={{
                    height: b.n ? `${(b.n / max) * 100}%` : 6,
                    opacity: b.n && b.n < objectif ? 0.42 : 1,
                  }}
                />
              </div>
              <span className={`text-[10px] chiffres ${actuelle ? "text-douce font-bold" : "text-sourd"}`}>
                {b.semaine.slice(8, 10)}/{b.semaine.slice(5, 7)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* Titre de section, avec une action éventuelle à droite */
function Section({ titre, action, surAction, children, className = "" }) {
  return (
    <section className={className}>
      {titre && (
        <div className="flex items-baseline justify-between gap-3 mb-2.5 px-1">
          <h2 className="text-[15px] font-bold tracking-tight">{titre}</h2>
          {action && (
            <button onClick={surAction} className="text-[13px] font-bold text-accent transi active:opacity-70">
              {action}
            </button>
          )}
        </div>
      )}
      {children}
    </section>
  );
}

/* Ligne de réglage façon iOS : icône, libellé, valeur ou contrôle à droite */
function Ligne({ icone: Icone, libelle, detail, children, surClic, danger }) {
  const Balise = surClic ? "button" : "div";
  return (
    <Balise
      onClick={surClic}
      className={`w-full flex items-center gap-3 px-4 min-h-[56px] py-2.5 text-left ${surClic ? "active:bg-carte2 transi" : ""}`}
    >
      {Icone && (
        <span className={`h-8 w-8 rounded-[10px] flex items-center justify-center shrink-0 ${danger ? "bg-rouge-doux" : "bg-carte2"}`}>
          <Icone size={16} className={danger ? "text-rouge" : "text-douce"} />
        </span>
      )}
      <span className="flex-1 min-w-0">
        <span className={`block text-[15px] font-semibold ${danger ? "text-rouge" : ""}`}>{libelle}</span>
        {detail && <span className="block text-xs text-brume mt-0.5 leading-snug">{detail}</span>}
      </span>
      {children}
    </Balise>
  );
}

function Accordeon({ icone: Icone, titre, texte, accent }) {
  const [ouvert, setOuvert] = useState(false);
  return (
    <div>
      <button
        onClick={() => setOuvert(!ouvert)}
        className="w-full flex items-center gap-3 px-4 min-h-[56px] py-2.5 text-left active:bg-carte2 transi"
        aria-expanded={ouvert}
      >
        <span className={`h-8 w-8 rounded-[10px] flex items-center justify-center shrink-0 transi ${accent ? "bg-accent-soft" : "bg-carte2"}`}>
          <Icone size={16} className={accent ? "text-accent" : "text-douce"} />
        </span>
        <span className="flex-1 font-semibold text-[15px]">{titre}</span>
        <ChevronDown size={18} className={`text-sourd shrink-0 transi ${ouvert ? "rotate-180" : ""}`} />
      </button>
      {ouvert && (
        <div className="px-4 pb-4 pl-[60px] deplie space-y-2">
          {texte.map((p, i) => (
            <p key={i} className="text-sm leading-relaxed text-douce">{p}</p>
          ))}
        </div>
      )}
    </div>
  );
}

/* Écran d'entrée : rejoindre un espace existant ou en créer un.
   Un espace = un groupe (un duo, une bande de potes) avec ses données à lui. */
function EcranEspace({ erreur, occupe, nomInitial, surOuvrir, surCreer }) {
  const [mode, setMode] = useState("rejoindre"); // "rejoindre" | "creer"
  const [nom, setNom] = useState(nomInitial || "");
  const [code, setCode] = useState("");
  const creation = mode === "creer";
  /* un espace pas encore protégé s'ouvre sans code : on n'exige rien pour rejoindre */
  const pret = nom.trim().length > 0 && (!creation || code.trim().length >= 4);

  return (
    <div data-accent="lime" className="coquille bg-fond text-encre font-jakarta">
      <div className="min-h-full flex flex-col justify-center px-6 py-10 mx-auto max-w-sm vue">
        <div className="relative mx-auto">
          <div className="absolute inset-0 rounded-[26px] bg-accent blur-2xl opacity-30" aria-hidden="true" />
          <span className="relative h-[76px] w-[76px] rounded-[26px] bg-accent flex items-center justify-center">
            <Dumbbell size={34} className="text-accent-ink" strokeWidth={2.4} />
          </span>
        </div>
        <h1 className="mt-7 titre-xl text-center">Coachwork</h1>
        <p className="text-brume text-[15px] mt-3 leading-relaxed text-center">
          {creation
            ? "Choisis un nom d’espace et un code : tes potes entreront avec ces deux-là."
            : "Entre le nom de ton espace et son code pour retrouver tes séances."}
        </p>

        <div className="mt-8 grid grid-cols-2 gap-1 rounded-2xl bg-carte p-1">
          {[["rejoindre", "Rejoindre"], ["creer", "Créer"]].map(([id, libelle]) => (
            <button
              key={id}
              onClick={() => setMode(id)}
              className={`h-11 rounded-xl text-sm font-bold transi ${
                mode === id ? "bg-carte3 text-encre" : "text-brume"
              }`}
            >
              {libelle}
            </button>
          ))}
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!pret || occupe) return;
            (creation ? surCreer : surOuvrir)(nom.trim(), code.trim());
          }}
          className="mt-4 space-y-2.5"
        >
          <input
            type="text"
            value={nom}
            onChange={(e) => setNom(e.target.value)}
            placeholder="Nom de l’espace (ex. : Team Kevin)"
            autoComplete="off"
            className="w-full rounded-2xl bg-carte px-5 text-[16px] font-semibold outline-none placeholder-sourd focus:bg-carte2 transi"
            style={{ height: 56 }}
            aria-label="Nom de l’espace"
          />
          <input
            type="password"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder={creation ? "Code à créer (4 caractères min.)" : "Code de l’espace"}
            autoComplete="off"
            className="w-full rounded-2xl bg-carte px-5 text-[16px] font-semibold outline-none placeholder-sourd focus:bg-carte2 transi"
            style={{ height: 56 }}
            aria-label="Code de l’espace"
          />
          {erreur && <p className="text-rouge text-sm pt-1 text-center">{erreur}</p>}
          <button
            type="submit"
            disabled={!pret || occupe}
            className={`!mt-5 w-full rounded-2xl font-extrabold text-base transi ${
              !pret || occupe ? "bg-carte2 text-sourd" : "bg-accent text-accent-ink active:scale-98 lueur-accent"
            }`}
            style={{ height: 58 }}
          >
            {occupe ? "Vérification…" : creation ? "Créer mon espace" : "Entrer"}
          </button>
        </form>

        <p className="text-sourd text-xs mt-6 leading-relaxed text-center">
          Chaque espace a ses propres profils, programmes et historiques. Rien n’est partagé
          entre deux espaces.
        </p>
      </div>
    </div>
  );
}

/* Les surcouches (feuilles, chrono Tabata, fête, barre de validation) se
   rattachent à l'écran applicatif et non à <body> : voir .ecran dans input.css */
function coucheModale() {
  return document.getElementById("ecran") || document.body;
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
  const [store, setStore] = useState(() =>
    Object.fromEntries(PROFILS_DEFAUT.map((p) => [p.id, etatVide()]))
  );
  const [profils, setProfils] = useState(PROFILS_DEFAUT);
  const [programmesPerso, setProgrammesPerso] = useState([]);
  const [exosPerso, setExosPerso] = useState([]);
  const [syncEtat, setSyncEtat] = useState("off"); // "ok" | "off"
  const [onglet, setOnglet] = useState("accueil"); // accueil | programmes | progres | journal | profil
  const [ouverte, setOuverte] = useState(null); // id de séance ou null
  const [edition, setEdition] = useState(null); // null | {id} | {nouveau:true}
  const [minuteur, setMinuteur] = useState(null); // {finA, total, label}
  const [, setTic] = useState(0); // re-rendu périodique pendant le repos
  const [fete, setFete] = useState(null); // {titre, deja, total}
  const [verrou, setVerrou] = useState(null); // null | {erreur?, occupe?}
  const [espace, setEspace] = useState(null); // {id, nom} de l’espace ouvert
  const [espacesConnus, setEspacesConnus] = useState([]); // ouverts sur cet appareil
  const [listeEspaces, setListeEspaces] = useState(false); // panneau caché (triple tap)
  const [codePartage, setCodePartage] = useState(null); // {code, nom, nbExos}
  const [importOuvert, setImportOuvert] = useState(false);
  const [corbeille, setCorbeille] = useState([]); // programmes supprimés (3 jours)
  const [corbeilleOuverte, setCorbeilleOuverte] = useState(false);
  const [toast, setToast] = useState(null); // {message, action?: {libelle, fn}, duree?}
  const [verifOubli, setVerifOubli] = useState(0); // déclenche la recherche de séances oubliées
  const [theme, setTheme] = useState("sombre"); // sombre | clair | auto (réglage de l'appareil)
  const [clairSysteme, setClairSysteme] = useState(() => {
    try { return window.matchMedia("(prefers-color-scheme: light)").matches; } catch (e) { return false; }
  });
  const themeEffectif = theme === "auto" ? (clairSysteme ? "clair" : "sombre") : theme;
  const vivantRef = useRef(true);
  /* dernier état connu, pour les actions différées (bouton « Annuler » d'un toast) */
  const etatRef = useRef({});

  async function afficherDonnees() {
    const { persos, exosPerso: ep, corbeille: cb, profils: pf, res } = await chargerTout();
    let pSauve = await lire("app:profil");
    if (pSauve === "maman") pSauve = "valerie";
    if (!vivantRef.current) return;
    setProgrammesPerso(persos);
    setExosPerso(ep);
    setCorbeille(cb);
    setProfils(pf);
    setStore(res);
    setProfil(pf.some((x) => x.id === pSauve) ? pSauve : pf[0].id);
    setChargement(false);
  }

  /* ---- chargement initial : horodatages → code → serveur → état local ---- */
  useEffect(() => {
    vivantRef.current = true;
    (async () => {
      /* l'apparence d'abord, pour ne pas afficher le chargement dans le mauvais thème */
      const t = await lire("app:theme");
      if (vivantRef.current && ["sombre", "clair", "auto"].includes(t)) setTheme(t);
      /* puis l'espace : il détermine où les données sont rangées */
      codeApp = await lire("app:code");
      espaceApp = await lire("app:espace");
      horodatages = (await lire("app:horodatages")) || {};
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
      setEspace(espaceApp);
      setEspacesConnus((await lire("app:espacesConnus")) || []);
      /* espace adopté automatiquement (migration) : on le retient aussi */
      if (espaceApp) await memoriserEspace(espaceApp, codeApp || "");
      await afficherDonnees();
      /* séances oubliées : seulement sur des données fraîches (synchro à jour,
         ou appareil seul) — sinon un téléphone hors ligne validerait une
         séance que l'autre a déjà validée */
      if (statut === "ok" || statut === "maj" || !espaceApp) setVerifOubli((n) => n + 1);
    })();
    return () => { vivantRef.current = false; };
  }, []);

  /* ---- ouverture / création d'un espace ---- */
  async function tenterEspace(nom, code, creer) {
    setVerrou({ occupe: true });
    let rep;
    try {
      rep = await fetch(API_ESPACE, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: creer ? "creer" : "ouvrir", nom, code }),
      });
    } catch (e) {
      setVerrou({ erreur: "Serveur injoignable — réessaie dans un instant." });
      return;
    }
    let corps = {};
    try { corps = await rep.json(); } catch (e) {}

    if (!rep.ok) {
      const messages = {
        404: "Cet espace n’existe pas — vérifie le nom, ou crée-le.",
        401: "Code incorrect, réessaie.",
        409: "Ce nom d’espace est déjà pris, choisis-en un autre.",
        429: "Trop d’essais. Patiente une quinzaine de minutes.",
      };
      setVerrou({ erreur: messages[rep.status] || corps.erreur || "Impossible d’ouvrir cet espace." });
      return;
    }
    if (corps.sync === false) {
      /* pas de base configurée : l'app reste utilisable en local */
      setVerrou(null);
      setSyncEtat("off");
      await afficherDonnees();
      return;
    }

    const infos = { id: corps.id, nom: corps.nom, protege: corps.protege !== false };
    espaceApp = infos;
    codeApp = code;
    await ecrireBrut("app:espace", infos);
    await ecrireBrut("app:code", code);
    /* chaque espace a ses propres données locales : on reprend les siennes */
    horodatages = (await lire("app:horodatages")) || {};
    try {
      await tirerDepuisServeur();
    } catch (e) {}
    setEspace(infos);
    await memoriserEspace(infos, code);
    setSyncEtat("ok");
    setVerrou(null);
    await afficherDonnees();
    setVerifOubli((n) => n + 1);
  }

  /* ---- partage d'un programme d'un espace à l'autre (copie par code) ---- */

  /* on emporte les exercices maison utilisés, sinon le programme arrive troué */
  async function partagerProgramme(id) {
    const prog = programmesPerso.find((p) => p.id === id);
    if (!prog) return { erreur: "programme introuvable" };
    const utilises = new Set(prog.seances.flatMap((s) => s.exoIds));
    const emportes = exosPerso.filter((e) => utilises.has(e.id));
    let rep, corps = {};
    try {
      rep = await fetch(API_PARTAGE, {
        method: "POST",
        headers: entetesSync(true),
        body: JSON.stringify({ action: "creer", programme: prog, exos: emportes }),
      });
      corps = await rep.json();
    } catch (e) {
      return { erreur: "Serveur injoignable — réessaie dans un instant." };
    }
    if (!rep.ok) return { erreur: corps.erreur || "Partage impossible." };
    if (corps.sync === false) return { erreur: "La synchro doit être active pour partager." };
    return { code: corps.code, nom: corps.nom, nbExos: emportes.length };
  }

  /* import : copie indépendante, avec les exercices maison manquants */
  async function importerProgramme(code) {
    let rep, corps = {};
    try {
      rep = await fetch(API_PARTAGE, {
        method: "POST",
        headers: entetesSync(true),
        body: JSON.stringify({ action: "lire", code }),
      });
      corps = await rep.json();
    } catch (e) {
      return { erreur: "Serveur injoignable — réessaie dans un instant." };
    }
    if (rep.status === 404) return { erreur: "Code inconnu ou expiré." };
    if (!rep.ok) return { erreur: corps.erreur || "Import impossible." };

    const recu = corps.programme;
    /* exercices maison absents ici : on les ajoute au catalogue */
    const connus = new Set([...Object.keys(EXOS), ...exosPerso.map((e) => e.id)]);
    const nouveaux = (recu.exos || []).filter((e) => e && e.id && !connus.has(e.id));
    if (nouveaux.length) {
      const listeExos = [...exosPerso, ...nouveaux];
      setExosPerso(listeExos);
      await ecrire("app:exosPerso", listeExos);
    }

    const id = `perso-${Date.now()}`;
    const prog = {
      id,
      nom: recu.nom,
      seances: recu.seances.map((s, i) => ({
        nom: s.nom || `Séance ${i + 1}`,
        exoIds: [...s.exoIds],
        ...(s.tabata ? { tabata: s.tabata, rounds: s.rounds || {} } : {}),
      })),
    };
    const liste = [...programmesPerso, prog];
    setProgrammesPerso(liste);
    await ecrire("app:programmesPerso", liste);
    choisirMode(id);
    return { ok: true, nom: prog.nom, nbExos: nouveaux.length };
  }

  /* trois appuis rapprochés sur l'haltère : panneau des espaces */
  const tapsHaltere = useRef({ n: 0, t: 0 });
  function tapHaltere() {
    const maintenant = Date.now();
    const etat = tapsHaltere.current;
    etat.n = maintenant - etat.t < 600 ? etat.n + 1 : 1;
    etat.t = maintenant;
    if (etat.n >= 3) {
      etat.n = 0;
      try { if (navigator.vibrate) navigator.vibrate(12); } catch (e) {}
      setListeEspaces(true);
    }
  }

  /* Espaces déjà ouverts sur ce téléphone : liste locale, jamais envoyée au
     serveur — elle sert au raccourci de bascule (triple tap sur l'haltère). */
  async function memoriserEspace(infos, code) {
    const liste = await lire("app:espacesConnus");
    const autres = (Array.isArray(liste) ? liste : []).filter((e) => e.id !== infos.id);
    const maj = [{ ...infos, code }, ...autres].slice(0, 8);
    await ecrireBrut("app:espacesConnus", maj);
    setEspacesConnus(maj);
  }

  async function oublierEspace(id) {
    const autres = espacesConnus.filter((e) => e.id !== id);
    await ecrireBrut("app:espacesConnus", autres);
    setEspacesConnus(autres);
  }

  /* poser ou remplacer le code de l'espace, sans passer par Vercel */
  async function definirCodeEspace(nouveauCode) {
    if (!espaceApp) return { erreur: "aucun espace ouvert" };
    let rep, corps = {};
    try {
      rep = await fetch(API_ESPACE, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "definirCode",
          nom: espaceApp.id,
          code: codeApp || "",
          nouveauCode,
        }),
      });
      corps = await rep.json();
    } catch (e) {
      return { erreur: "Serveur injoignable — réessaie dans un instant." };
    }
    if (!rep.ok) return { erreur: corps.erreur || "Impossible d’enregistrer le code." };
    codeApp = nouveauCode;
    espaceApp = { ...espaceApp, protege: true };
    await ecrireBrut("app:code", nouveauCode);
    await ecrireBrut("app:espace", espaceApp);
    setEspace(espaceApp);
    return { ok: true };
  }

  /* quitter l'espace : on n'efface que ce qui identifie l'appareil */
  function quitterEspace() {
    espaceApp = null;
    codeApp = null;
    ecrireBrut("app:espace", null);
    ecrireBrut("app:code", null);
    setEspace(null);
    setVerrou({});
  }

  /* ---- rafraîchissement périodique quand la synchro est active ---- */
  useEffect(() => {
    if (syncEtat !== "ok") return;
    const rafraichir = async () => {
      try {
        const statut = await tirerDepuisServeur();
        if (statut === "maj") {
          const { persos, exosPerso: ep, corbeille: cb, profils: pf, res } = await chargerTout();
          setProgrammesPerso(persos);
          setExosPerso(ep);
          setCorbeille(cb);
          setProfils(pf);
          setStore(res);
        }
        if (statut === "maj" || statut === "ok") {
          setVerifOubli((n) => n + 1);
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

  /* ---- appareil seul (pas d'espace) : on guette aussi le changement de
     jour, l'app pouvant rester ouverte en arrière-plan toute la nuit ---- */
  useEffect(() => {
    if (chargement || syncEtat === "ok" || espace) return;
    const verifier = () => setVerifOubli((n) => n + 1);
    const t = setInterval(verifier, 5 * 60 * 1000);
    const vis = () => { if (document.visibilityState === "visible") verifier(); };
    document.addEventListener("visibilitychange", vis);
    return () => { clearInterval(t); document.removeEventListener("visibilitychange", vis); };
  }, [chargement, syncEtat, espace]);

  /* ---- apparence : clair, sombre, ou celle du téléphone (auto) ----
     data-apparence et pas data-theme : la visionneuse d'artefacts pose déjà
     data-theme sur la page */
  useEffect(() => {
    document.documentElement.dataset.apparence = themeEffectif;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", themeEffectif === "clair" ? "#F4F5F7" : "#08090C");
  }, [themeEffectif]);

  useEffect(() => {
    if (theme !== "auto") return;
    let mq;
    try { mq = window.matchMedia("(prefers-color-scheme: light)"); } catch (e) { return; }
    const maj = () => setClairSysteme(mq.matches);
    maj();
    if (mq.addEventListener) mq.addEventListener("change", maj);
    else mq.addListener(maj);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener("change", maj);
      else mq.removeListener(maj);
    };
  }, [theme]);

  function choisirTheme(t) {
    setTheme(t);
    ecrireBrut("app:theme", t);
  }

  /* ---- enregistrement du service worker (notifications + hors-ligne) ---- */
  useEffect(() => {
    try {
      if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
    } catch (e) {}
  }, []);

  /* ---- zoom désactivé : Safari ignore user-scalable=no hors app installée.
     `touch-action: pan-y` (CSS) supprime le double-tap et le pincement ;
     ici on neutralise en plus les gestes de zoom propres à iOS.
     Volontairement rien sur le double-tap en JS : ça annulerait le second
     clic quand on tape vite deux pastilles de série. ---- */
  useEffect(() => {
    const stop = (e) => e.preventDefault();
    const stopPincement = (e) => { if (e.touches && e.touches.length > 1) e.preventDefault(); };
    document.addEventListener("gesturestart", stop);
    document.addEventListener("gesturechange", stop);
    document.addEventListener("gestureend", stop);
    document.addEventListener("touchmove", stopPincement, { passive: false });
    return () => {
      document.removeEventListener("gesturestart", stop);
      document.removeEventListener("gesturechange", stop);
      document.removeEventListener("gestureend", stop);
      document.removeEventListener("touchmove", stopPincement);
    };
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
  const profilActif = profils.find((p) => p.id === profil) || profils[0];
  const niveauActif = (profilActif && profilActif.niveau) || "standard";
  const accentActif = (profilActif && profilActif.accent) || "lime";
  const donnees = store[profil] || etatVide();
  const progActuel = programmes.find((p) => p.id === donnees.mode) || programmes[0];

  function choisirProfil(p) {
    setProfil(p);
    ecrire("app:profil", p);
  }

  function enregistrerProfils(liste) {
    setProfils(liste);
    ecrire("app:profils", liste);
  }

  /* nouveau profil : identifiant unique et durable, données vierges */
  function ajouterProfil() {
    const id = `profil-${Date.now().toString(36)}`;
    const pris = new Set(profils.map((p) => p.accent));
    const libre = (ACCENTS.find((a) => !pris.has(a.id)) || ACCENTS[0]).id;
    enregistrerProfils([
      ...profils,
      { id, nom: `Profil ${profils.length + 1}`, niveau: "standard", accent: libre },
    ]);
    setStore((prev) => ({ ...prev, [id]: etatVide() }));
    choisirProfil(id);
    setOnglet("profil");
  }

  function majProfil(id, patch) {
    enregistrerProfils(profils.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  }

  /* suppression : on retire aussi les données du profil (local + synchro) */
  function supprimerProfil(id) {
    if (profils.length <= 1) return;
    const reste = profils.filter((p) => p.id !== id);
    enregistrerProfils(reste);
    for (const suffixe of ["charges", "assiduite", "mode", "mesures"]) {
      ecrire(`${id}:${suffixe}`, null);
    }
    setStore((prev) => {
      const c = { ...prev };
      delete c[id];
      return c;
    });
    if (profil === id) choisirProfil(reste[0].id);
  }

  /* les feuilles sont portalées sur <body> : il porte aussi l'accent du profil */
  useEffect(() => {
    document.body.dataset.accent = accentActif;
  }, [accentActif]);

  /* Toute modification d'une séance passe par ici. `activite` : l'action
     prouve que la séance a vraiment commencé (coche, série, charge, durée) —
     on date alors la séance, pour pouvoir la valider si elle est oubliée. */
  function modifierSeance(sid, transformer, activite = false) {
    setStore((prev) => {
      const p = prev[profil];
      if (!p) return prev;
      const seance = normaliserSeance(p.seances[sid]);
      let maj = transformer(seance);
      if (!maj || maj === seance) return prev;
      if (activite) {
        const enCours = seanceDemarree(seance) && seance.debut;
        maj = {
          ...maj,
          debut: enCours ? seance.debut : cleJour(),
          t0: enCours && seance.t0 ? seance.t0 : Date.now(),
          maj: Date.now(),
        };
      }
      ecrire(`${profil}:seance:${sid}`, maj);
      return { ...prev, [profil]: { ...p, seances: { ...p.seances, [sid]: maj } } };
    });
  }

  function basculerEtape(sid, eid) {
    modifierSeance(sid, (s) => ({ ...s, coches: { ...s.coches, [eid]: !s.coches[eid] } }), true);
  }

  /* n séries faites sur un emplacement d'exercice ; il se coche tout seul
     quand toutes les séries prévues sont faites. `figer` : les charges
     affichées des séries faites sont retenues telles quelles. */
  function noterSeries(sid, slotId, cible, n, figer = null) {
    modifierSeance(
      sid,
      (s) => {
        let chargesSeries = s.chargesSeries;
        if (figer && n > 0) {
          const ent = chargesSeries[slotId];
          const v = ent && ent.exo === figer.exo ? [...ent.v] : [];
          for (let i = 0; i < n; i++) {
            if (v[i] == null && figer.valeurs[i]) v[i] = figer.valeurs[i];
          }
          chargesSeries = { ...chargesSeries, [slotId]: { exo: figer.exo, v } };
        }
        return {
          ...s,
          coches: { ...s.coches, [slotId]: n >= cible },
          series: { ...s.series, [slotId]: n },
          chargesSeries,
        };
      },
      true
    );
  }

  /* charge d'une série précise (pyramide, série plus légère en fin…) */
  function noterChargeSerie(sid, slotId, exoId, index, valeur) {
    modifierSeance(
      sid,
      (s) => {
        const ent = s.chargesSeries[slotId];
        const v = ent && ent.exo === exoId ? [...ent.v] : [];
        while (v.length < index) v.push(null);
        v[index] = valeur;
        return { ...s, chargesSeries: { ...s.chargesSeries, [slotId]: { exo: exoId, v } } };
      },
      true
    );
  }

  /* cardio continu : minutes faites (l'exercice est alors coché) */
  function noterDuree(sid, slotId, exoId, minutes) {
    modifierSeance(
      sid,
      (s) => ({
        ...s,
        coches: { ...s.coches, [slotId]: true },
        durees: { ...s.durees, [slotId]: { exo: exoId, v: minutes } },
      }),
      true
    );
  }

  /* remplace l'exercice d'un emplacement par une variante (humeur du jour,
     machine prise…) ; revient au programme d'origine à la validation */
  function remplacerExo(sid, slotId, nouvelId) {
    modifierSeance(sid, (s) => {
      const remplacements = { ...s.remplacements };
      if (nouvelId === slotId) delete remplacements[slotId];
      else remplacements[slotId] = nouvelId;
      return { ...s, remplacements };
    });
  }

  /* ajout / retrait d'un exercice sur la séance en cours (ne touche pas au
     programme) : toggle par exercice depuis le sélecteur */
  function basculerAjout(sid, exoId) {
    modifierSeance(sid, (s) => {
      const existant = s.ajouts.find((a) => a.exoId === exoId && !s.remplacements[a.slotId]);
      if (existant) return retirerSlot(s, existant.slotId);
      const slotId = `ajout-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      return { ...s, ajouts: [...s.ajouts, { slotId, exoId, rounds: 8 }] };
    });
  }

  function retirerAjout(sid, slotId) {
    modifierSeance(sid, (s) => retirerSlot(s, slotId));
  }

  /* réordonne un exercice dans la séance du jour (le programme reste intact) */
  function deplacerSlot(sid, slotIds, slotId, dir) {
    modifierSeance(sid, (s) => {
      const liste = [...slotIds];
      const i = liste.indexOf(slotId);
      const j = i + dir;
      if (i === -1 || j < 0 || j >= liste.length) return s;
      [liste[i], liste[j]] = [liste[j], liste[i]];
      return { ...s, ordre: liste };
    });
  }

  function reinitialiserOrdre(sid) {
    modifierSeance(sid, (s) => ({ ...s, ordre: [] }));
  }

  function noterRoundsAjout(sid, slotId, rounds) {
    modifierSeance(sid, (s) => ({
      ...s,
      ajouts: s.ajouts.map((a) => (a.slotId === slotId ? { ...a, rounds } : a)),
    }));
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
    /* instantané : exercices réellement faits (programme + ajouts), séries,
       charges de chaque série, durées */
    const etatSeance = normaliserSeance(donnees.seances[seance.id]);
    const { detail, kcal } = instantaneSeance(seance, etatSeance, donnees, dicoExos, niveauActif);
    /* chaque validation est enregistrée — y compris la même séance refaite
       dans la semaine (ça arrive, et ça compte) */
    const repeat = donnees.historique.some((h) => h.s === seance.id && lundiDe(h.d) === lundiDe(auj));
    const duree = dureeSeance(etatSeance, Date.now());
    const records = recordsBattus(detail, donnees.historique);
    const historique = [
      ...donnees.historique,
      {
        s: seance.id, d: auj, titre: seance.titre, detail, kcal,
        ...(duree ? { duree } : {}),
        ...(records.length ? { records: records.map((r) => r.id) } : {}),
      },
    ];
    const vierge = seanceVierge();
    setStore((prev) => {
      const p = prev[profil];
      const chargesMaj = chargesApres(p.charges, detail);
      ecrire(`${profil}:assiduite`, { historique });
      ecrire(`${profil}:seance:${seance.id}`, vierge);
      if (chargesMaj !== p.charges) ecrire(`${profil}:charges`, chargesMaj);
      return {
        ...prev,
        [profil]: { ...p, historique, charges: chargesMaj, seances: { ...p.seances, [seance.id]: vierge } },
      };
    });
    setOuverte(null);
    setFete({ titre: seance.titre, repeat, total: historique.length, kcal, duree, nbExos: detail.length, records });
  }

  /* Séances commencées puis oubliées (pas validées avant la fin de la
     journée) : on les valide à la date où elles ont été faites. Une séance
     ouverte juste pour regarder ne compte pas — il faut une coche, une
     série, une charge ou une durée notée. */
  function autoValiderOublis() {
    const auj = cleJour();
    const maintenant = Date.now();
    const aValider = [];
    for (const prof of profils) {
      const d = store[prof.id];
      if (!d) continue;
      for (const [sid, brut] of Object.entries(d.seances)) {
        const et = normaliserSeance(brut);
        if (!seanceOubliee(et, auj, maintenant)) continue;
        const def = toutesSeances.find((s) => s.id === sid);
        if (def) aValider.push({ prof, sid, def, debut: et.debut });
      }
    }
    if (!aValider.length) return;

    setStore((prev) => {
      let suivant = prev;
      for (const v of aValider) {
        const d = suivant[v.prof.id];
        if (!d) continue;
        const et = normaliserSeance(d.seances[v.sid]);
        if (!seanceOubliee(et, auj, maintenant)) continue; // traitée entre-temps
        const { detail, kcal } = instantaneSeance(v.def, et, d, dicoExos, v.prof.niveau || "standard");
        const historique = [
          ...d.historique,
          {
            s: v.sid, d: et.debut, titre: v.def.titre, detail, kcal, auto: true,
            ...(dureeSeance(et, et.maj) ? { duree: dureeSeance(et, et.maj) } : {}),
          },
        ];
        const vierge = seanceVierge();
        const chargesMaj = chargesApres(d.charges, detail);
        ecrire(`${v.prof.id}:assiduite`, { historique });
        ecrire(`${v.prof.id}:seance:${v.sid}`, vierge);
        if (chargesMaj !== d.charges) ecrire(`${v.prof.id}:charges`, chargesMaj);
        suivant = {
          ...suivant,
          [v.prof.id]: { ...d, historique, charges: chargesMaj, seances: { ...d.seances, [v.sid]: vierge } },
        };
      }
      return suivant;
    });
    if (aValider.some((v) => v.prof.id === profil && v.sid === ouverte)) setOuverte(null);

    const premier = aValider[0];
    const qui = premier.prof.id !== profil ? ` (${nomAffiche(store[premier.prof.id], premier.prof)})` : "";
    setToast({
      message:
        aValider.length === 1
          ? `Séance oubliée, validée pour toi : ${premier.def.titre}${qui}, ${FORMAT_JOUR.format(depuisCle(premier.debut))}.`
          : `${aValider.length} séances oubliées ont été validées automatiquement, à leur date.`,
      action: {
        libelle: "Voir",
        fn: () => {
          setEdition(null);
          setOuverte(null);
          setOnglet("journal");
          if (premier.prof.id !== etatRef.current.profil) choisirProfil(premier.prof.id);
        },
      },
      duree: 10000,
    });
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

  /* Suppression = mise à la corbeille : le programme reste restaurable
     3 jours (avec ses séances en cours), puis s'efface tout seul */
  function supprimerProgramme(id) {
    const prog = programmesPerso.find((p) => p.id === id);
    if (!prog) return;
    const liste = programmesPerso.filter((p) => p.id !== id);
    setProgrammesPerso(liste);
    ecrire("app:programmesPerso", liste);
    const corb = [
      { prog, supprimeLe: Date.now(), actif: donnees.mode === id },
      ...purgerCorbeille(corbeille).filter((e) => e.prog.id !== id),
    ];
    setCorbeille(corb);
    ecrire("app:corbeille", corb);
    if (donnees.mode === id) choisirMode("fullbody");
    setEdition(null);
    setToast({
      message: `« ${prog.nom} » est dans la corbeille pour 3 jours.`,
      action: { libelle: "Annuler", fn: () => restaurerProgramme(id) },
      duree: 8000,
    });
  }

  /* lit l'état le plus récent : peut être appelée depuis un toast affiché
     plusieurs secondes après la suppression */
  function restaurerProgramme(id) {
    const { corbeille: corb, programmesPerso: progs } = etatRef.current;
    const entree = corb.find((e) => e.prog.id === id);
    if (!entree) return;
    const reste = corb.filter((e) => e.prog.id !== id);
    setCorbeille(reste);
    ecrire("app:corbeille", reste);
    if (!progs.some((p) => p.id === id)) {
      const liste = [...progs, entree.prog];
      setProgrammesPerso(liste);
      ecrire("app:programmesPerso", liste);
    }
    if (entree.actif) choisirMode(id);
    setToast({ message: `« ${entree.prog.nom} » est de retour.`, duree: 4000 });
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
    for (let i = 7; i >= 0; i--) {
      const wk = semainesAvant(lundiActuel, i);
      barres.push({ semaine: wk, n: nParSemaine.get(wk) || 0 });
    }
    /* jours de la semaine en cours où une séance a été validée */
    const jours = {};
    let kcalSemaine = 0;
    /* 30 derniers jours : énergie, volume soulevé, séances */
    const depuis = cleJour(new Date(Date.now() - 29 * 86400000));
    let kcal30 = 0, volume30 = 0, n30 = 0, minutes30 = 0;
    for (const h of donnees.historique) {
      if (lundiDe(h.d) === lundiActuel) {
        jours[h.d] = (jours[h.d] || 0) + 1;
        kcalSemaine += h.kcal || 0;
      }
      if (h.d >= depuis) {
        n30++;
        kcal30 += h.kcal || 0;
        minutes30 += h.duree || 0;
        for (const d of h.detail || []) volume30 += volumeExo(d);
      }
    }
    return {
      total: donnees.historique.length, cetteSemaine, nCetteSemaine, serie, barres,
      jours, kcalSemaine, kcal30, volume30, n30, minutes30,
    };
  }, [store, profil]);

  etatRef.current = { corbeille, programmesPerso, profil };

  /* recherche des séances oubliées, une fois l'état à jour rendu */
  useEffect(() => {
    if (chargement || verrou || !verifOubli) return;
    autoValiderOublis();
  }, [verifOubli, chargement]);

  /* ---- écran de verrouillage ---- */
  if (verrou) {
    return (
      <EcranEspace
        erreur={verrou.erreur}
        occupe={!!verrou.occupe}
        nomInitial={espace ? espace.nom : ""}
        surOuvrir={(nom, code) => tenterEspace(nom, code, false)}
        surCreer={(nom, code) => tenterEspace(nom, code, true)}
      />
    );
  }

  /* ---- écran de chargement ---- */
  if (chargement) {
    return (
      <div data-accent={accentActif} className="coquille bg-fond text-encre font-jakarta flex flex-col items-center justify-center gap-5">
        <span className="h-16 w-16 rounded-[22px] bg-accent flex items-center justify-center pulsation">
          <Dumbbell size={28} className="text-accent-ink" strokeWidth={2.4} />
        </span>
        <p className="text-brume text-sm">Chargement de vos séances…</p>
      </div>
    );
  }

  const seanceOuverte = toutesSeances.find((s) => s.id === ouverte) || null;
  /* tous les exercices du programme de la séance ouverte (toutes séances
     confondues) : les variantes proposées n'en reprennent aucun */
  const progOuvert = seanceOuverte
    ? programmes.find((p) => p.seances.some((s) => s.id === seanceOuverte.id))
    : null;
  const idsProgrammeOuvert = new Set(
    progOuvert ? progOuvert.seances.flatMap((s) => s.exos.map((e) => e.id)) : []
  );
  const pleinEcran = !!edition || !!seanceOuverte;

  /* re-toucher l'onglet actif remonte en haut de la page */
  function changerOnglet(id) {
    if (id === onglet && defileur.current) defileur.current.scrollTo({ top: 0, behavior: "smooth" });
    setOnglet(id);
  }

  return (
    <div id="ecran" data-accent={accentActif} className="ecran bg-fond text-encre font-jakarta">
      <div ref={defileur} className="coquille">
        <div className={`mx-auto max-w-md px-5 ${pleinEcran ? "pb-40" : "pb-36"}`}>
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
              niveau={niveauActif}
              etat={normaliserSeance(donnees.seances[seanceOuverte.id])}
              charges={donnees.charges}
              dico={dicoExos}
              tousExos={tousExos}
              faiteCetteSemaine={stats.cetteSemaine.has(seanceOuverte.id)}
              idsProgramme={idsProgrammeOuvert}
              surRetour={() => setOuverte(null)}
              surCoche={(eid) => basculerEtape(seanceOuverte.id, eid)}
              surSeries={(slotId, cible, n, figer) => noterSeries(seanceOuverte.id, slotId, cible, n, figer)}
              surChargeSerie={(slotId, exoId, i, v) => noterChargeSerie(seanceOuverte.id, slotId, exoId, i, v)}
              surDuree={(slotId, exoId, minutes) => noterDuree(seanceOuverte.id, slotId, exoId, minutes)}
              surRemplacer={(slotId, nouvelId) => remplacerExo(seanceOuverte.id, slotId, nouvelId)}
              surCharge={noterCharge}
              surRepos={lancerRepos}
              historique={donnees.historique}
              exosPerso={exosPerso}
              surSauverExo={sauverExoPerso}
              surSupprimerExo={supprimerExoPerso}
              surBasculerAjout={(exoId) => basculerAjout(seanceOuverte.id, exoId)}
              surRetirerAjout={(slotId) => retirerAjout(seanceOuverte.id, slotId)}
              surRoundsAjout={(slotId, rounds) => noterRoundsAjout(seanceOuverte.id, slotId, rounds)}
              surDeplacer={(slotIds, slotId, dir) => deplacerSlot(seanceOuverte.id, slotIds, slotId, dir)}
              surReinitOrdre={() => reinitialiserOrdre(seanceOuverte.id)}
              surFin={() => terminerSeance(seanceOuverte)}
              surFinAvecSauvegarde={(exoIds) => terminerAvecSauvegarde(seanceOuverte, exoIds)}
              surAnnuler={() => retirerValidation(seanceOuverte.id)}
            />
          ) : (
            <>
              <BarreHaut
                profils={profils}
                store={store}
                profilActif={profil}
                espace={espace}
                syncEtat={syncEtat}
                surHaltere={tapHaltere}
                surChoisir={choisirProfil}
                surAjouter={ajouterProfil}
                surEspace={() => changerOnglet("profil")}
              />

              {onglet === "accueil" ? (
                <VueAccueil
                  profil={profil}
                  profilObj={profilActif}
                  donnees={donnees}
                  stats={stats}
                  progActuel={progActuel}
                  espace={espace}
                  syncEtat={syncEtat}
                  surOuvrir={setOuverte}
                  surProgrammes={() => changerOnglet("programmes")}
                  surProfil={() => changerOnglet("profil")}
                  surJournal={() => changerOnglet("journal")}
                />
              ) : onglet === "programmes" ? (
                <VueProgrammes
                  profil={profil}
                  programmes={programmes}
                  progActuel={progActuel}
                  stats={stats}
                  syncEtat={syncEtat}
                  corbeille={corbeille}
                  surMode={choisirMode}
                  surOuvrir={setOuverte}
                  surPartager={async (id) => setCodePartage(await partagerProgramme(id))}
                  surImporter={() => setImportOuvert(true)}
                  surCreer={() => setEdition({ nouveau: true })}
                  surEditer={(id) => setEdition({ id })}
                  surCorbeille={() => setCorbeilleOuverte(true)}
                />
              ) : onglet === "progres" ? (
                <VueProgres
                  profil={profil}
                  historique={donnees.historique}
                  dico={dicoExos}
                  stats={stats}
                  objectif={progActuel.seances.length}
                />
              ) : onglet === "journal" ? (
                <VueHistorique
                  profil={profil}
                  historique={donnees.historique}
                  toutesSeances={toutesSeances}
                  surSupprimer={supprimerEntree}
                />
              ) : (
                <VueProfil
                  profil={profil}
                  profilObj={profilActif}
                  profils={profils}
                  donnees={donnees}
                  espace={espace}
                  syncEtat={syncEtat}
                  surMesure={noterMesure}
                  surMajProfil={(patch) => majProfil(profil, patch)}
                  surSupprimerProfil={() => supprimerProfil(profil)}
                  surAjouterProfil={ajouterProfil}
                  surDefinirCode={definirCodeEspace}
                  surChangerEspace={quitterEspace}
                  theme={theme}
                  surTheme={choisirTheme}
                />
              )}
            </>
          )}
        </div>
      </div>

      {!pleinEcran && (
        <NavBas
          onglet={onglet}
          surChoisir={changerOnglet}
          alerteProfil={syncEtat === "ok" && !!espace && espace.protege === false}
        />
      )}

      {/* ---------- minuteur de repos flottant ---------- */}
      {minuteur && (
        <MinuteurRepos
          minuteur={minuteur}
          reste={resteRepos}
          surProlonger={prolongerRepos}
          surArreter={arreterRepos}
        />
      )}

      {codePartage && (
        <FeuilleCodePartage resultat={codePartage} surFermer={() => setCodePartage(null)} />
      )}

      {importOuvert && (
        <FeuilleImport surImporter={importerProgramme} surFermer={() => setImportOuvert(false)} />
      )}

      {corbeilleOuverte && (
        <FeuilleCorbeille
          entrees={purgerCorbeille(corbeille)}
          surRestaurer={restaurerProgramme}
          surFermer={() => setCorbeilleOuverte(false)}
        />
      )}

      {toast && <Toast toast={toast} surFermer={() => setToast(null)} />}

      {listeEspaces && (
        <FeuilleEspaces
          espaces={espacesConnus}
          actuel={espace}
          surBasculer={(e) => { setListeEspaces(false); tenterEspace(e.id, e.code || "", false); }}
          surOublier={oublierEspace}
          surAutre={() => { setListeEspaces(false); quitterEspace(); }}
          surFermer={() => setListeEspaces(false)}
        />
      )}

      {/* ---------- fête de fin de séance ---------- */}
      {fete && <FeteSeance fete={fete} stats={stats} surFermer={() => setFete(null)} />}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Feuilles, navigation et vues principales                            */
/* ------------------------------------------------------------------ */

/* Feuille du bas commune : voile, poignée, en-tête (icône, titre, fermer) */
function Feuille({ titre, sousTitre, icone: Icone, surFermer, children, sansEntete = false }) {
  useVerrouScroll();
  return createPortal(
    <div className="fixed inset-0 z-50 voile font-jakarta text-encre flex items-end" onClick={surFermer}>
      <div
        className="feuille w-full mx-auto max-w-md rounded-t-4xl bg-carte px-5 pt-2.5 coussin-bas ombre-feuille"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={titre}
      >
        <div className="poignee mx-auto mb-4" />
        {!sansEntete && (
          <div className="flex items-center gap-3 mb-4">
            {Icone && (
              <span className="h-11 w-11 rounded-2xl bg-accent-soft flex items-center justify-center shrink-0 transi">
                <Icone size={20} className="text-accent transi" />
              </span>
            )}
            <div className="flex-1 min-w-0">
              <h3 className="font-extrabold text-[17px] leading-tight tracking-tight truncate">{titre}</h3>
              {sousTitre && <p className="text-brume text-xs mt-0.5">{sousTitre}</p>}
            </div>
            <button
              onClick={surFermer}
              aria-label="Fermer"
              className="h-10 w-10 rounded-full bg-carte2 flex items-center justify-center shrink-0 active:scale-95 transi"
            >
              <X size={17} className="text-brume" />
            </button>
          </div>
        )}
        {children}
      </div>
    </div>,
    coucheModale()
  );
}

/* Petit message en haut de l'écran, avec une action éventuelle (Annuler, Voir) */
function Toast({ toast, surFermer }) {
  useEffect(() => {
    const t = setTimeout(surFermer, toast.duree || 6000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toast]);
  return createPortal(
    <div className="fixed left-3 right-3 z-50 mx-auto max-w-md toast-haut font-jakarta text-encre surgit" role="status">
      <div className="rounded-[22px] verre p-2 pl-4 flex items-center gap-2">
        <p className="flex-1 min-w-0 text-sm leading-snug text-douce py-1.5">{toast.message}</p>
        {toast.action && (
          <button
            onClick={() => { toast.action.fn(); surFermer(); }}
            className="h-10 px-4 rounded-full bg-accent text-accent-ink text-sm font-extrabold shrink-0 active:scale-95 transi"
          >
            {toast.action.libelle}
          </button>
        )}
        <button
          onClick={surFermer}
          aria-label="Fermer le message"
          className="h-10 w-9 rounded-full flex items-center justify-center shrink-0 active:scale-95 transi"
        >
          <X size={16} className="text-brume" />
        </button>
      </div>
    </div>,
    coucheModale()
  );
}

function delaiRestant(ms) {
  const h = Math.max(1, Math.ceil(ms / 3600000));
  return h >= 24 ? `dans ${Math.ceil(h / 24)} j` : `dans ${h} h`;
}

/* Corbeille : programmes supprimés depuis moins de 3 jours */
function FeuilleCorbeille({ entrees, surRestaurer, surFermer }) {
  const maintenant = Date.now();
  return (
    <Feuille titre="Corbeille" sousTitre="Vidée automatiquement au bout de 3 jours" icone={Trash2} surFermer={surFermer}>
      {entrees.length === 0 ? (
        <p className="text-brume text-sm py-3 leading-relaxed">La corbeille est vide.</p>
      ) : (
        <div className="space-y-2 max-h-72 overflow-y-auto defile">
          {entrees.map((e) => {
            const n = e.prog.seances.length;
            return (
              <div key={e.prog.id} className="rounded-2xl surface-2 p-3 pl-4 flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <p className="font-bold text-[15px] truncate">{e.prog.nom}</p>
                  <p className="text-brume text-xs mt-0.5">
                    {n} séance{n > 1 ? "s" : ""} · effacé {delaiRestant(e.supprimeLe + DUREE_CORBEILLE - maintenant)}
                  </p>
                </div>
                <button
                  onClick={() => surRestaurer(e.prog.id)}
                  className="h-11 px-4 rounded-full bg-accent text-accent-ink text-sm font-extrabold flex items-center gap-1.5 shrink-0 active:scale-95 transi"
                >
                  <RotateCcw size={15} strokeWidth={2.5} /> Restaurer
                </button>
              </div>
            );
          })}
        </div>
      )}
    </Feuille>
  );
}

/* Code de partage d'un programme : à transmettre à qui on veut */
function FeuilleCodePartage({ resultat, surFermer }) {
  const [copie, setCopie] = useState(false);

  async function copier() {
    try {
      await navigator.clipboard.writeText(resultat.code);
      setCopie(true);
      setTimeout(() => setCopie(false), 2000);
    } catch (e) {}
  }

  if (resultat.erreur) {
    return (
      <Feuille titre="Partage impossible" icone={Share2} surFermer={surFermer}>
        <p className="text-brume text-sm leading-relaxed">{resultat.erreur}</p>
        <button
          onClick={surFermer}
          className="mt-5 w-full h-14 rounded-2xl bg-carte2 text-douce font-bold active:scale-98 transi"
        >
          Fermer
        </button>
      </Feuille>
    );
  }

  return (
    <Feuille titre={resultat.nom} sousTitre="Code de partage" icone={Share2} surFermer={surFermer}>
      <p
        className="w-full rounded-3xl surface-2 text-center font-extrabold chiffres flex items-center justify-center"
        style={{ height: 84, fontSize: 38, letterSpacing: 8 }}
      >
        {resultat.code}
      </p>
      <p className="text-brume text-[13px] mt-4 leading-relaxed">
        Transmets ce code : depuis son espace, la personne le saisit dans{" "}
        <strong className="text-douce">Programmes → Importer</strong> et reçoit une copie
        indépendante.
        {resultat.nbExos > 0
          ? ` Tes ${resultat.nbExos} exercice${resultat.nbExos > 1 ? "s" : ""} maison partent avec.`
          : ""}{" "}
        Le code reste valable 30 jours et ne donne accès qu’à ce programme.
      </p>
      <button
        onClick={copier}
        className="mt-5 w-full h-14 rounded-2xl bg-accent text-accent-ink font-extrabold text-base active:scale-98 transi flex items-center justify-center gap-2 lueur-accent"
      >
        {copie ? <Check size={18} strokeWidth={3} /> : <Copy size={18} />}
        {copie ? "Copié !" : "Copier le code"}
      </button>
    </Feuille>
  );
}

/* Saisie d'un code reçu : importe une copie du programme */
function FeuilleImport({ surImporter, surFermer }) {
  const [code, setCode] = useState("");
  const [erreur, setErreur] = useState(null);
  const [occupe, setOccupe] = useState(false);
  const [fait, setFait] = useState(null);

  async function valider(e) {
    e.preventDefault();
    if (code.trim().length < 4 || occupe) return;
    setOccupe(true);
    setErreur(null);
    const r = await surImporter(code.trim().toUpperCase());
    setOccupe(false);
    if (r && r.erreur) setErreur(r.erreur);
    else setFait(r);
  }

  if (fait) {
    return (
      <Feuille titre={fait.nom} surFermer={surFermer} sansEntete>
        <div className="text-center pt-2">
          <span className="mx-auto h-16 w-16 rounded-full bg-accent flex items-center justify-center pop">
            <Check size={30} strokeWidth={3} className="text-accent-ink" />
          </span>
          <h3 className="mt-4 titre-l">{fait.nom}</h3>
          <p className="text-brume text-sm mt-2 leading-relaxed">
            Le programme est copié dans ton espace et déjà sélectionné.
            {fait.nbExos > 0
              ? ` ${fait.nbExos} exercice${fait.nbExos > 1 ? "s" : ""} maison ${
                  fait.nbExos > 1 ? "ont" : "a"
                } rejoint ton catalogue.`
              : ""}{" "}
            Modifie-le comme tu veux : l’original n’en saura rien.
          </p>
          <button
            onClick={surFermer}
            className="mt-6 w-full h-14 rounded-2xl bg-accent text-accent-ink font-extrabold text-base active:scale-98 transi"
          >
            C’est parti
          </button>
        </div>
      </Feuille>
    );
  }

  return (
    <Feuille titre="Importer un programme" sousTitre="Avec le code reçu" icone={Download} surFermer={surFermer}>
      <form onSubmit={valider}>
        <input
          type="text"
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          placeholder="7K2MPQ"
          autoComplete="off"
          autoCapitalize="characters"
          className="w-full rounded-3xl surface-2 px-4 text-center font-extrabold chiffres outline-none placeholder-sourd"
          style={{ height: 72, fontSize: 30, letterSpacing: 6 }}
          aria-label="Code de partage"
        />
        {erreur && <p className="text-rouge text-sm mt-3 text-center">{erreur}</p>}
        <button
          type="submit"
          disabled={code.trim().length < 4 || occupe}
          className={`mt-4 w-full h-14 rounded-2xl font-extrabold text-base transi ${
            code.trim().length < 4 || occupe ? "bg-carte2 text-sourd" : "bg-accent text-accent-ink active:scale-98"
          }`}
        >
          {occupe ? "Import en cours…" : "Importer"}
        </button>
      </form>
      <p className="text-sourd text-xs mt-3 leading-relaxed text-center">
        Tu recevras une copie : la modifier ne touchera pas l’original.
      </p>
    </Feuille>
  );
}

/* Panneau caché (trois appuis sur l'haltère) : bascule entre les espaces déjà
   ouverts sur ce téléphone. Rien n'est demandé au serveur pour l'afficher. */
function FeuilleEspaces({ espaces, actuel, surBasculer, surOublier, surAutre, surFermer }) {
  return (
    <Feuille titre="Mes espaces" sousTitre="Ceux déjà ouverts sur ce téléphone" icone={Users} surFermer={surFermer}>
      {espaces.length === 0 ? (
        <p className="text-brume text-sm py-2 leading-relaxed">
          Aucun espace mémorisé pour l’instant. Ceux que tu ouvriras apparaîtront ici.
        </p>
      ) : (
        <div className="space-y-2 max-h-72 overflow-y-auto defile">
          {espaces.map((e) => {
            const ici = actuel && actuel.id === e.id;
            return (
              <div key={e.id} className={`rounded-2xl flex items-stretch transi ${ici ? "surface-2 contour-accent" : "surface-2"}`}>
                <button
                  onClick={() => !ici && surBasculer(e)}
                  className="flex-1 min-w-0 p-3 flex items-center gap-3 text-left active:scale-98 transi"
                >
                  <span className={`h-10 w-10 rounded-xl flex items-center justify-center shrink-0 transi ${ici ? "bg-accent" : "bg-carte3"}`}>
                    {ici ? (
                      <Check size={17} strokeWidth={3.5} className="text-accent-ink" />
                    ) : (
                      <Dumbbell size={16} className="text-brume" />
                    )}
                  </span>
                  <span className="min-w-0">
                    <span className="font-bold text-[15px] block truncate">{e.nom}</span>
                    <span className="text-brume text-xs block">
                      {ici ? "Espace actuel" : e.protege === false ? "Sans code" : "Protégé"}
                    </span>
                  </span>
                </button>
                {!ici && (
                  <button
                    onClick={() => surOublier(e.id)}
                    aria-label={`Oublier ${e.nom}`}
                    className="px-4 flex items-center justify-center shrink-0 active:scale-95 transi"
                  >
                    <Trash2 size={15} className="text-sourd" />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
      <button
        onClick={surAutre}
        className="mt-3 w-full h-12 rounded-2xl border border-dashed border-carte3 text-douce text-sm font-bold flex items-center justify-center gap-2 active:scale-98 transi"
      >
        <Plus size={17} className="text-accent transi" /> Ouvrir un autre espace
      </button>
      <p className="text-sourd text-xs mt-3 leading-relaxed">
        Cette liste ne quitte jamais ce téléphone — les espaces des autres n’y figurent pas.
      </p>
    </Feuille>
  );
}

/* Espace encore accessible à qui a l'URL : on propose de poser un code */
function CarteProtection({ surDefinirCode }) {
  const [ouvert, setOuvert] = useState(false);
  const [code, setCode] = useState("");
  const [erreur, setErreur] = useState(null);
  const [occupe, setOccupe] = useState(false);

  async function valider(e) {
    e.preventDefault();
    if (code.trim().length < 4 || occupe) return;
    setOccupe(true);
    setErreur(null);
    const r = await surDefinirCode(code.trim());
    setOccupe(false);
    if (r && r.erreur) setErreur(r.erreur);
    else { setOuvert(false); setCode(""); }
  }

  return (
    <section className="rounded-3xl degrade-heros p-4">
      <div className="flex gap-3">
        <span className="h-9 w-9 rounded-xl bg-accent-soft flex items-center justify-center shrink-0">
          <ShieldCheck size={18} className="text-accent transi" />
        </span>
        <div className="flex-1 min-w-0">
          <p className="text-[15px] font-bold">Cet espace n’a pas encore de code</p>
          <p className="text-xs leading-relaxed text-brume mt-1">
            N’importe qui connaissant l’adresse peut voir et modifier vos séances. Le code sera
            demandé une seule fois par téléphone.
          </p>
          {ouvert ? (
            <form onSubmit={valider} className="mt-3">
              <input
                type="password"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="Nouveau code (4 caractères min.)"
                autoComplete="off"
                className="w-full rounded-2xl bg-carte2 px-4 text-center font-bold outline-none placeholder-sourd"
                style={{ height: 50 }}
                aria-label="Nouveau code de l’espace"
              />
              {erreur && <p className="text-rouge text-xs mt-2">{erreur}</p>}
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  onClick={() => { setOuvert(false); setErreur(null); }}
                  className="h-11 px-4 rounded-full bg-carte2 text-brume text-sm font-bold active:scale-95 transi"
                >
                  Annuler
                </button>
                <button
                  type="submit"
                  disabled={code.trim().length < 4 || occupe}
                  className={`flex-1 h-11 rounded-full font-extrabold text-sm transi ${
                    code.trim().length < 4 || occupe ? "bg-carte2 text-sourd" : "bg-accent text-accent-ink active:scale-98"
                  }`}
                >
                  {occupe ? "Enregistrement…" : "Protéger l’espace"}
                </button>
              </div>
            </form>
          ) : (
            <button
              onClick={() => setOuvert(true)}
              className="mt-3 h-11 px-5 rounded-full bg-accent text-accent-ink font-extrabold text-sm active:scale-98 transi"
            >
              Protéger par un code
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

/* Barre du haut : logo (trois appuis = espaces), espace, avatars des profils */
function BarreHaut({ profils, store, profilActif, espace, syncEtat, surHaltere, surChoisir, surAjouter, surEspace }) {
  const serre = profils.length > 3;
  return (
    <header className="pt-4 pb-6 flex items-center gap-3">
      {/* raccourci discret : trois appuis ouvrent la liste des espaces */}
      <button
        onClick={surHaltere}
        aria-label="Coachwork"
        className="h-10 w-10 rounded-[14px] bg-accent flex items-center justify-center shrink-0 transi lueur-accent"
      >
        <Dumbbell size={19} className="text-accent-ink" strokeWidth={2.5} />
      </button>
      <button onClick={surEspace} className="flex-1 min-w-0 text-left" aria-label="Espace et réglages">
        <span className="block text-[15px] font-extrabold leading-none tracking-tight">Coachwork</span>
        <span className="mt-1.5 flex items-center gap-1.5 text-xs text-brume min-w-0">
          <span className={`h-1.5 w-1.5 rounded-full shrink-0 transi ${syncEtat === "ok" ? "bg-accent" : "bg-sourd"}`} />
          <span className="truncate">{espace ? espace.nom : "Sur cet appareil"}</span>
        </span>
      </button>
      <div className="flex items-center shrink-0" role="group" aria-label="Choisir le profil">
        {profils.map((p, i) => {
          const actif = p.id === profilActif;
          const nom = nomAffiche(store[p.id], p);
          return (
            <button
              key={p.id}
              onClick={() => surChoisir(p.id)}
              aria-label={`Profil ${nom}`}
              aria-pressed={actif}
              data-accent={p.accent || "lime"}
              className={`relative rounded-full flex items-center justify-center font-extrabold text-[13px] shrink-0 transi pastille-${
                p.accent || "lime"
              } encre-pastille ${actif ? "anneau-accent z-10" : "scale-[0.86] opacity-80 active:scale-75"}`}
              style={{ height: 34, width: 34, marginLeft: i === 0 ? 0 : serre ? -6 : 8 }}
            >
              {nom.charAt(0).toUpperCase()}
            </button>
          );
        })}
        {profils.length < 6 && (
          <button
            onClick={surAjouter}
            aria-label="Ajouter un profil"
            className="ml-2.5 h-[34px] w-[34px] rounded-full border border-dashed border-carte3 text-brume flex items-center justify-center active:scale-95 transi"
          >
            <Plus size={16} />
          </button>
        )}
      </div>
    </header>
  );
}

const ONGLETS = [
  { id: "accueil", libelle: "Accueil", icone: House },
  { id: "programmes", libelle: "Programmes", icone: LayoutList },
  { id: "progres", libelle: "Progrès", icone: TrendingUp },
  { id: "journal", libelle: "Journal", icone: CalendarDays },
  { id: "profil", libelle: "Profil", icone: CircleUser },
];

/* Navigation flottante du bas (à portée de pouce) */
function NavBas({ onglet, surChoisir, alerteProfil }) {
  return (
    <nav className="fixed left-3 right-3 z-40 mx-auto max-w-md nav-bas" aria-label="Navigation principale">
      <div className="verre rounded-[26px] h-[66px] px-1 flex items-stretch">
        {ONGLETS.map(({ id, libelle, icone: Icone }) => {
          const actif = onglet === id;
          return (
            <button
              key={id}
              onClick={() => surChoisir(id)}
              aria-current={actif ? "page" : undefined}
              className="flex-1 min-w-0 flex flex-col items-center justify-center gap-1"
            >
              <span className={`relative h-8 w-[52px] rounded-full flex items-center justify-center transi ${actif ? "bg-accent-soft" : ""}`}>
                <Icone size={21} strokeWidth={actif ? 2.4 : 1.9} className={`transi ${actif ? "text-accent" : "text-brume"}`} />
                {id === "profil" && alerteProfil && (
                  <span className="absolute top-0.5 right-3 h-2 w-2 rounded-full pastille-alerte" />
                )}
              </span>
              <span className={`text-[10.5px] leading-none transi truncate max-w-full ${actif ? "text-encre font-bold" : "text-brume font-semibold"}`}>
                {libelle}
              </span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}

/* « Séance A — Fondations » → ["Séance A", "Fondations"] */
function decouperTitre(titre) {
  const i = titre.indexOf(" — ");
  return i === -1 ? [null, titre] : [titre.slice(0, i), titre.slice(i + 3)];
}

const FORMAT_JOUR_COURT = new Intl.DateTimeFormat("fr-FR", { weekday: "short" });
const FORMAT_MOIS = new Intl.DateTimeFormat("fr-FR", { month: "long", year: "numeric" });

function formatNombre(n) {
  return Math.round(n).toLocaleString("fr-FR");
}

/* ------------------------------------------------------------------ */
/* Accueil : aujourd'hui, la prochaine séance, la semaine              */
/* ------------------------------------------------------------------ */

function VueAccueil({
  profil, profilObj, donnees, stats, progActuel, espace, syncEtat,
  surOuvrir, surProgrammes, surProfil, surJournal,
}) {
  const nom = nomAffiche(donnees, profilObj);
  const auj = cleJour();
  const objectif = progActuel.seances.length;
  /* prochaine séance : une séance commencée d'abord, sinon la première pas encore faite */
  const enCours = progActuel.seances.find((s) => seanceDemarree(normaliserSeance(donnees.seances[s.id])));
  const aFaire = progActuel.seances.find((s) => !stats.cetteSemaine.has(s.id));
  const prochaine = enCours || aFaire || null;
  const reste = Math.max(0, objectif - stats.nCetteSemaine);
  const phrase = enCours
    ? "Ta séance t’attend là où tu l’as laissée."
    : !prochaine
    ? "Semaine bouclée. Tout le reste, c’est du bonus."
    : stats.nCetteSemaine === 0
    ? "Nouvelle semaine, page blanche. On s’y met ?"
    : `Encore ${reste} séance${reste > 1 ? "s" : ""} pour boucler la semaine.`;

  const lundi = depuisCle(lundiDe(auj));
  const jours = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(lundi);
    d.setDate(d.getDate() + i);
    return cleJour(d);
  });
  const [jourOuvert, setJourOuvert] = useState(null); // date du jour touché

  return (
    <div key={profil} className="vue space-y-7">
      <div>
        <p className="text-[13px] font-semibold text-brume first-letter:uppercase">{FORMAT_JOUR.format(new Date())}</p>
        <h1 className="titre-xl mt-1.5">Salut {nom}</h1>
        <p className="text-douce text-[15px] mt-2 leading-snug">{phrase}</p>

        {/* la semaine en un coup d'œil : un tap sur un jour en montre le détail */}
        <div className="mt-5 grid grid-cols-7 gap-1">
          {jours.map((j, i) => {
            const n = stats.jours[j] || 0;
            const ajd = j === auj;
            const futur = j > auj;
            return (
              <button
                key={j}
                onClick={() => setJourOuvert(j)}
                aria-label={`${FORMAT_JOUR.format(depuisCle(j))} : ${
                  n ? `${n} séance${n > 1 ? "s" : ""}` : futur ? "à venir" : "aucune séance"
                }`}
                className="flex flex-col items-center gap-1.5 py-0.5 rounded-2xl active:scale-90 transi"
              >
                <span className={`text-[11px] font-semibold ${ajd ? "text-accent" : "text-sourd"}`}>{"LMMJVSD"[i]}</span>
                <span
                  className={`h-9 w-9 rounded-full flex items-center justify-center text-[14px] font-bold chiffres transi ${
                    n ? "bg-accent text-accent-ink" : ajd ? "contour-accent text-encre" : futur ? "text-sourd" : "text-douce"
                  }`}
                >
                  {Number(j.slice(8))}
                </span>
                <span className={`h-1 w-1 rounded-full ${n > 1 ? "bg-accent" : "bg-transparent"}`} />
              </button>
            );
          })}
        </div>
        {jourOuvert && (
          <FeuilleJour
            iso={jourOuvert}
            entrees={donnees.historique.filter((h) => h.d === jourOuvert)}
            prochaine={prochaine}
            enCours={!!enCours}
            surCommencer={(id) => { setJourOuvert(null); surOuvrir(id); }}
            surJournal={() => { setJourOuvert(null); surJournal(); }}
            surFermer={() => setJourOuvert(null)}
          />
        )}
      </div>

      {/* la prochaine séance, en grand */}
      {prochaine ? (
        <CarteProchaine
          seance={prochaine}
          etat={normaliserSeance(donnees.seances[prochaine.id])}
          enCours={!!enCours}
          surOuvrir={() => surOuvrir(prochaine.id)}
        />
      ) : (
        <section className="rounded-4xl degrade-heros p-6 text-center">
          <Anneau fait={1} total={1} taille={84} epaisseur={8}>
            <Check size={30} strokeWidth={3} className="text-accent transi" />
          </Anneau>
          <h2 className="titre-l mt-4">Objectif atteint</h2>
          <p className="text-brume text-sm mt-1.5 leading-relaxed">
            {stats.nCetteSemaine} séance{stats.nCetteSemaine > 1 ? "s" : ""} cette semaine. Envie de rab ? Refais
            celle de ton choix.
          </p>
          <div className="mt-4 flex flex-wrap justify-center gap-2">
            {progActuel.seances.map((s) => (
              <button
                key={s.id}
                onClick={() => surOuvrir(s.id)}
                className="h-10 px-4 rounded-full bg-carte2 text-sm font-bold active:scale-95 transi"
              >
                {decouperTitre(s.titre)[1]}
              </button>
            ))}
          </div>
        </section>
      )}

      {/* chiffres de la semaine */}
      <div className="grid grid-cols-3 gap-2.5">
        <button onClick={surJournal} className="surface rounded-3xl p-3.5 text-left active:scale-98 transi">
          <Anneau fait={stats.nCetteSemaine} total={objectif} taille={40} epaisseur={5} />
          <p className="mt-3 text-[20px] font-extrabold chiffres leading-none">
            {stats.nCetteSemaine}<span className="text-brume text-sm font-bold">/{objectif}</span>
          </p>
          <p className="text-[11px] text-brume mt-1 leading-tight">cette semaine</p>
        </button>
        <div className="surface rounded-3xl p-3.5">
          <span className="h-10 w-10 rounded-full bg-accent-soft flex items-center justify-center transi">
            <Flame size={19} className="text-accent transi" />
          </span>
          <p className="mt-3 text-[20px] font-extrabold chiffres leading-none">{stats.serie}</p>
          <p className="text-[11px] text-brume mt-1 leading-tight">
            semaine{stats.serie > 1 ? "s" : ""} d’affilée
          </p>
        </div>
        <div className="surface rounded-3xl p-3.5">
          <span className="h-10 w-10 rounded-full bg-accent-soft flex items-center justify-center transi">
            <Zap size={18} className="text-accent transi" />
          </span>
          <p className="mt-3 text-[20px] font-extrabold chiffres leading-none">{formatNombre(stats.kcalSemaine)}</p>
          <p className="text-[11px] text-brume mt-1 leading-tight">kcal dépensées</p>
        </div>
      </div>

      {/* espace encore ouvert à tous */}
      {syncEtat === "ok" && espace && espace.protege === false && (
        <button onClick={surProfil} className="w-full surface rounded-3xl p-4 flex items-center gap-3 text-left active:scale-98 transi">
          <span className="h-10 w-10 rounded-xl bg-accent-soft flex items-center justify-center shrink-0">
            <ShieldCheck size={18} className="text-accent transi" />
          </span>
          <span className="flex-1 min-w-0">
            <span className="block text-[15px] font-bold">Protège ton espace</span>
            <span className="block text-xs text-brume mt-0.5">Il n’a pas encore de code d’accès</span>
          </span>
          <ChevronRight size={18} className="text-sourd" />
        </button>
      )}

      {/* les séances de la semaine */}
      <Section titre="Cette semaine" action="Changer de programme" surAction={surProgrammes}>
        <ListeSeances seances={progActuel.seances} donnees={donnees} stats={stats} surOuvrir={surOuvrir} />
        <p className="text-sourd text-xs mt-3 px-1 leading-relaxed">
          {progActuel.nom} · l’ordre est libre, avec un jour de repos entre deux séances. Oublié de
          valider ? Une séance commencée se valide toute seule à sa date.
        </p>
      </Section>
    </div>
  );
}

/* Détail d'un jour de la semaine (accueil) : les séances validées ce jour-là,
   ou, pour aujourd'hui et les jours à venir, la prochaine séance au programme */
function FeuilleJour({ iso, entrees, prochaine, enCours, surCommencer, surJournal, surFermer }) {
  const auj = cleJour();
  const date = depuisCle(iso);
  const titre = FORMAT_JOUR.format(date).replace(/^./, (c) => c.toUpperCase());
  const minutes = entrees.reduce((t, h) => t + (h.duree || 0), 0);
  const kcal = entrees.reduce((t, h) => t + (h.kcal || 0), 0);
  const sousTitre = entrees.length
    ? [
        `${entrees.length} séance${entrees.length > 1 ? "s" : ""}`,
        minutes ? `${minutes} min` : null,
        kcal ? `≈ ${kcal} kcal` : null,
      ].filter(Boolean).join(" · ")
    : iso === auj
    ? "Aujourd’hui"
    : iso > auj
    ? "À venir"
    : "Jour de repos";

  return (
    <Feuille titre={titre} sousTitre={sousTitre} icone={CalendarDays} surFermer={surFermer}>
      {entrees.length > 0 ? (
        <div className="space-y-3 max-h-[58vh] overflow-y-auto defile">
          {entrees.map((h, i) => {
            const infos = infosSeance(h);
            return (
              <div key={i} className="rounded-3xl surface-2 p-3.5">
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className="font-bold text-[15px] truncate">{decouperTitre(h.titre || "Séance")[1]}</span>
                  <BadgesSeance h={h} />
                </div>
                {infos.length > 0 && <p className="text-brume text-xs mt-0.5 mb-2.5">{infos.join(" · ")}</p>}
                <DetailSeance h={h} />
              </div>
            );
          })}
        </div>
      ) : iso < auj ? (
        <div className="rounded-3xl surface-2 p-5 flex gap-3.5 items-start">
          <span className="h-10 w-10 rounded-full bg-carte3 flex items-center justify-center shrink-0">
            <Moon size={18} className="text-douce" />
          </span>
          <p className="text-sm text-douce leading-relaxed">
            Pas de séance ce jour-là. Le repos fait partie du programme : c’est pendant ces
            jours-là que le muscle se reconstruit.
          </p>
        </div>
      ) : (
        <div className="rounded-3xl surface-2 p-4">
          <p className="text-sm text-douce leading-relaxed">
            {iso === auj
              ? enCours
                ? "Ta séance du jour est en cours."
                : "Pas encore de séance aujourd’hui."
              : prochaine
              ? "Ce jour arrive bientôt. Prochaine séance au programme :"
              : "Ce jour arrive bientôt. Ton objectif de la semaine est déjà atteint."}
          </p>
          {prochaine && (
            <button
              onClick={() => surCommencer(prochaine.id)}
              className="mt-3 w-full h-[52px] rounded-2xl bg-accent text-accent-ink font-extrabold text-[15px] flex items-center justify-center gap-2 active:scale-98 transi"
            >
              <Play size={16} strokeWidth={2.6} className="fill-current" />
              {enCours ? "Reprendre" : "Commencer"} · {decouperTitre(prochaine.titre)[1]}
            </button>
          )}
        </div>
      )}
      {entrees.length > 0 && (
        <button
          onClick={surJournal}
          className="mt-3 w-full h-12 rounded-2xl text-sm font-bold text-accent flex items-center justify-center gap-1.5 active:scale-98 transi"
        >
          Voir dans le journal <ChevronRight size={16} />
        </button>
      )}
    </Feuille>
  );
}

/* Carte « prochaine séance » : titre en grand, muscles, bouton principal */
function CarteProchaine({ seance, etat, enCours, surOuvrir }) {
  const [etiquette, titre] = decouperTitre(seance.titre);
  const muscles = [...new Set(seance.exos.flatMap((e) => e.muscles || []))];
  const nbEtapes = seance.exos.length + etat.ajouts.length + (seance.cardio ? 1 : 0) + 2;
  const nFait = Object.values(etat.coches).filter((v) => v === true).length;
  return (
    <section className="rounded-4xl degrade-heros p-5 relative overflow-hidden">
      <div className="flex items-center gap-2 text-xs font-bold text-accent transi">
        <span className={`h-2 w-2 rounded-full bg-accent ${enCours ? "pulsation" : ""}`} />
        {enCours ? "En cours" : "Prochaine séance"}
        {etiquette && <span className="text-brume font-semibold">· {etiquette}</span>}
      </div>
      <div className="mt-2 flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <h2 className="text-[28px] font-extrabold leading-[1.05] tracking-[-0.03em]">{titre}</h2>
          <p className="text-sm text-douce mt-2 leading-snug">{seance.resume}</p>
        </div>
        <SchemaMuscles muscles={muscles} hauteur={74} />
      </div>
      <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1.5 text-xs font-semibold text-brume">
        <span className="flex items-center gap-1.5">
          <Dumbbell size={13} /> {seance.exos.length} exercice{seance.exos.length > 1 ? "s" : ""}
        </span>
        <span className="flex items-center gap-1.5">
          <Clock size={13} /> {seance.tabata ? "≈ 20 min" : "45–60 min"}
        </span>
        <span className="flex items-center gap-1.5 first-letter:uppercase">
          <Activity size={13} /> {seance.sousTitre}
        </span>
      </div>
      {enCours && (
        <div className="mt-4">
          <div className="h-1.5 rounded-full bg-carte3 overflow-hidden">
            <div className="h-full rounded-full bg-accent barre" style={{ width: `${(nFait / nbEtapes) * 100}%` }} />
          </div>
          <p className="text-[11px] text-brume mt-1.5 chiffres">{nFait}/{nbEtapes} étapes</p>
        </div>
      )}
      <button
        onClick={surOuvrir}
        className="mt-5 w-full h-14 rounded-2xl bg-accent text-accent-ink font-extrabold text-base flex items-center justify-center gap-2 active:scale-98 transi lueur-accent"
      >
        <Play size={18} strokeWidth={2.6} className="fill-current" />
        {enCours ? "Reprendre la séance" : "Commencer la séance"}
      </button>
    </section>
  );
}

/* Liste compacte des séances d'un programme, avec leur état de la semaine */
function ListeSeances({ seances, donnees, stats, surOuvrir }) {
  return (
    <div className="surface rounded-3xl divide-y divide-ligne overflow-hidden">
      {seances.map((s) => {
        const faite = stats.cetteSemaine.has(s.id);
        const enCours = !faite && seanceDemarree(normaliserSeance(donnees.seances[s.id]));
        const [, titre] = decouperTitre(s.titre);
        return (
          <button
            key={s.id}
            onClick={() => surOuvrir(s.id)}
            className="w-full flex items-center gap-3.5 px-4 py-3.5 text-left active:bg-carte2 transi"
          >
            <span
              className={`h-11 w-11 rounded-[14px] flex items-center justify-center text-[15px] font-extrabold shrink-0 transi ${
                faite ? "bg-accent text-accent-ink" : enCours ? "bg-accent-soft text-accent" : "bg-carte2 text-douce"
              }`}
            >
              {faite ? <Check size={20} strokeWidth={3} /> : s.badge}
            </span>
            <span className="flex-1 min-w-0">
              <span className="font-bold text-[15px] block truncate">{titre}</span>
              <span className="text-brume text-xs block truncate mt-0.5">{s.resume}</span>
            </span>
            <span
              className={`text-[11px] font-bold px-2.5 py-1 rounded-full shrink-0 transi ${
                faite ? "bg-accent-soft text-accent" : enCours ? "bg-carte3 text-encre" : "text-sourd"
              }`}
            >
              {faite ? "Faite" : enCours ? "En cours" : "À faire"}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Programmes                                                          */
/* ------------------------------------------------------------------ */

function VueProgrammes({
  profil, programmes, progActuel, stats, syncEtat, corbeille = [],
  surMode, surOuvrir, surPartager, surImporter, surCreer, surEditer, surCorbeille,
}) {
  const nbCorbeille = purgerCorbeille(corbeille).length;
  const autres = programmes.filter((p) => p.id !== progActuel.id);
  const persos = autres.filter((p) => p.perso);
  const base = autres.filter((p) => !p.perso);
  const carte = (prog, actif) => (
    <CarteProgramme
      key={prog.id}
      prog={prog}
      actif={actif}
      stats={stats}
      surChoisir={() => surMode(prog.id)}
      surOuvrir={surOuvrir}
      surPartager={() => surPartager(prog.id)}
      surEditer={() => surEditer(prog.id)}
    />
  );

  return (
    <div key={profil} className="vue space-y-7">
      <div>
        <h1 className="titre-xl">Programmes</h1>
        <p className="text-douce text-[15px] mt-2 leading-snug">Choisis celui de la semaine, ou compose le tien.</p>
        <div className={`mt-5 grid gap-2.5 ${syncEtat === "ok" ? "grid-cols-2" : "grid-cols-1"}`}>
          <button
            onClick={surCreer}
            className="h-[52px] rounded-2xl bg-accent text-accent-ink font-extrabold text-[15px] flex items-center justify-center gap-2 active:scale-98 transi lueur-accent"
          >
            <Plus size={18} strokeWidth={2.6} /> Créer
          </button>
          {syncEtat === "ok" && (
            <button
              onClick={surImporter}
              aria-label="Importer un programme partagé"
              className="h-[52px] rounded-2xl surface-2 font-bold text-[15px] flex items-center justify-center gap-2 active:scale-98 transi"
            >
              <Download size={17} /> Importer
            </button>
          )}
        </div>
      </div>

      <Section titre="En ce moment">{carte(progActuel, true)}</Section>

      {persos.length > 0 && (
        <Section titre="Mes programmes">
          <div className="space-y-3">{persos.map((p) => carte(p, false))}</div>
        </Section>
      )}

      {base.length > 0 && (
        <Section titre="Programmes du coach">
          <div className="space-y-3">{base.map((p) => carte(p, false))}</div>
        </Section>
      )}

      {nbCorbeille > 0 && (
        <button
          onClick={surCorbeille}
          className="w-full h-12 rounded-2xl surface text-brume text-sm font-bold flex items-center justify-center gap-2 active:scale-98 transi"
        >
          <Trash2 size={15} />
          Corbeille · {nbCorbeille} programme{nbCorbeille > 1 ? "s" : ""} récupérable{nbCorbeille > 1 ? "s" : ""}
        </button>
      )}
    </div>
  );
}

function CarteProgramme({ prog, actif, stats, surChoisir, surOuvrir, surPartager, surEditer }) {
  const n = prog.seances.length;
  return (
    <div className={`rounded-4xl p-5 transi ${actif ? "degrade-heros" : "surface"}`}>
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          {actif && (
            <span className="inline-flex items-center gap-1.5 text-[11px] font-bold text-accent uppercase tracking-wider mb-1.5 transi">
              <span className="h-1.5 w-1.5 rounded-full bg-accent" /> Programme actif
            </span>
          )}
          <h3 className="text-[19px] font-extrabold tracking-tight leading-tight">{prog.nom}</h3>
          <p className={`text-brume text-[13px] mt-1 leading-snug ${actif ? "" : "line-clamp-2"}`}>
            {prog.perso ? `Programme perso · ${n} séance${n > 1 ? "s" : ""}` : prog.description}
          </p>
        </div>
        {prog.perso && (
          <div className="flex gap-1.5 shrink-0">
            <button
              onClick={surPartager}
              aria-label={`Partager le programme ${prog.nom}`}
              className="h-10 w-10 rounded-full bg-carte2 flex items-center justify-center active:scale-95 transi"
            >
              <Share2 size={16} className="text-douce" />
            </button>
            <button
              onClick={surEditer}
              aria-label={`Modifier le programme ${prog.nom}`}
              className="h-10 w-10 rounded-full bg-carte2 flex items-center justify-center active:scale-95 transi"
            >
              <Pencil size={16} className="text-douce" />
            </button>
          </div>
        )}
      </div>

      {actif ? (
        <div className="mt-4 space-y-2">
          {prog.seances.map((s) => {
            const faite = stats.cetteSemaine.has(s.id);
            const [, titre] = decouperTitre(s.titre);
            return (
              <button
                key={s.id}
                onClick={() => surOuvrir(s.id)}
                className="w-full rounded-2xl bg-carte2 px-3 py-2.5 flex items-center gap-3 text-left active:scale-98 transi"
              >
                <span
                  className={`h-9 w-9 rounded-xl flex items-center justify-center text-sm font-extrabold shrink-0 transi ${
                    faite ? "bg-accent text-accent-ink" : "bg-carte3 text-douce"
                  }`}
                >
                  {faite ? <Check size={17} strokeWidth={3} /> : s.badge}
                </span>
                <span className="flex-1 min-w-0">
                  <span className="block text-sm font-bold truncate">{titre}</span>
                  <span className="block text-xs text-brume truncate">{s.resume}</span>
                </span>
                <ChevronRight size={17} className="text-sourd shrink-0" />
              </button>
            );
          })}
        </div>
      ) : (
        <>
          <div className="mt-3.5 flex flex-wrap gap-1.5">
            {prog.seances.map((s) => (
              <span key={s.id} className="px-2.5 py-1 rounded-full bg-carte2 text-xs font-semibold text-douce">
                {decouperTitre(s.titre)[1]}
              </span>
            ))}
          </div>
          <button
            onClick={surChoisir}
            className="mt-4 w-full h-12 rounded-2xl bg-carte2 text-sm font-bold active:scale-98 transi"
          >
            Choisir ce programme
          </button>
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Profil : repères, niveau, couleur, espace, conseils                 */
/* ------------------------------------------------------------------ */

function ChampLigne({ libelle, valeur, placeholder, unite, numerique, surChange }) {
  return (
    <label className="flex items-center gap-3 px-4 min-h-[56px]">
      <span className="text-[15px] font-semibold flex-1">{libelle}</span>
      <input
        type="text"
        inputMode={numerique ? "decimal" : "text"}
        value={valeur}
        onChange={(e) => surChange(e.target.value)}
        placeholder={placeholder || "—"}
        className="w-36 min-w-0 bg-transparent text-right text-[15px] font-bold chiffres outline-none placeholder-sourd"
        aria-label={unite ? `${libelle} (${unite})` : libelle}
      />
      {unite && <span className="text-sm text-brume w-7 shrink-0">{unite}</span>}
    </label>
  );
}

function VueProfil({
  profil, profilObj, profils, donnees, espace, syncEtat,
  surMesure, surMajProfil, surSupprimerProfil, surAjouterProfil, surDefinirCode, surChangerEspace,
  theme = "sombre", surTheme,
}) {
  const p = profilObj;
  const nom = nomAffiche(donnees, p);
  const niveau = p.niveau || "standard";
  const accent = p.accent || "lime";
  const age = parseCharge(donnees.mesures.age);
  /* le conseil « densité osseuse » n'a de sens qu'après 50 ans */
  const noteOsseuse = age != null && age >= 50;
  const n = donnees.historique.length;

  return (
    <div key={profil} className="vue space-y-7">
      <div className="flex flex-col items-center text-center pt-1">
        <span
          className={`h-24 w-24 rounded-full pastille-${accent} encre-pastille flex items-center justify-center text-[40px] font-extrabold transi`}
          style={{ boxShadow: "0 16px 40px -12px var(--accent-bordure)" }}
        >
          {nom.charAt(0).toUpperCase()}
        </span>
        <h1 className="titre-l mt-4">{nom}</h1>
        <p className="text-brume text-sm mt-1">
          {NIVEAUX[niveau].nom} · {n} séance{n > 1 ? "s" : ""} au compteur
        </p>
      </div>

      <Section titre="Mes repères">
        <div className="surface rounded-3xl divide-y divide-ligne">
          <ChampLigne libelle="Prénom" valeur={donnees.mesures.nom || ""} placeholder={p.nom} surChange={(v) => surMesure("nom", v)} />
          <ChampLigne libelle="Âge" unite="ans" numerique valeur={donnees.mesures.age || ""} surChange={(v) => surMesure("age", v)} />
          <ChampLigne libelle="Taille" unite="cm" numerique valeur={donnees.mesures.taille || ""} surChange={(v) => surMesure("taille", v)} />
          <ChampLigne libelle="Poids" unite="kg" numerique valeur={donnees.mesures.poids || ""} surChange={(v) => surMesure("poids", v)} />
        </div>
        <p className="text-sourd text-xs mt-2.5 px-1 leading-relaxed">
          Le poids n’est qu’un repère parmi d’autres — les séances faites et les charges qui
          montent racontent mieux l’histoire. Il sert aussi à estimer l’énergie dépensée.
        </p>
      </Section>

      <Section titre="Niveau de charges">
        <div className="grid grid-cols-2 gap-2.5">
          {Object.entries(NIVEAUX).map(([id, nv]) => {
            const choisi = niveau === id;
            return (
              <button
                key={id}
                onClick={() => surMajProfil({ niveau: id })}
                aria-pressed={choisi}
                className={`rounded-3xl p-4 text-left transi ${choisi ? "degrade-heros contour-accent" : "surface"}`}
              >
                <span className={`h-5 w-5 rounded-full flex items-center justify-center transi ${choisi ? "bg-accent" : "border-2 border-carte3"}`}>
                  {choisi && <Check size={12} strokeWidth={4} className="text-accent-ink" />}
                </span>
                <span className="block text-[15px] font-bold mt-3">{nv.nom}</span>
                <span className="block text-xs text-brume mt-1 leading-snug">{nv.detail}</span>
              </button>
            );
          })}
        </div>
        <p className="text-sourd text-xs mt-2.5 px-1 leading-relaxed">
          Il règle les charges et les réglages cardio conseillés sur chaque exercice.
        </p>
      </Section>

      <Section titre="Ma couleur">
        <div className="surface rounded-3xl p-4 flex justify-between">
          {ACCENTS.map((a) => {
            const choisi = accent === a.id;
            return (
              <button
                key={a.id}
                onClick={() => surMajProfil({ accent: a.id })}
                aria-label={a.nom}
                aria-pressed={choisi}
                data-accent={a.id}
                className={`h-11 w-11 rounded-full pastille-${a.id} flex items-center justify-center active:scale-95 transi ${
                  choisi ? "anneau-accent" : "scale-90"
                }`}
              >
                {choisi && <Check size={18} strokeWidth={3.5} className="encre-pastille" />}
              </button>
            );
          })}
        </div>
      </Section>

      <Section titre="Apparence">
        <div className="surface rounded-3xl p-1.5 grid grid-cols-3 gap-1.5" role="group" aria-label="Apparence">
          {[["sombre", "Sombre", Moon], ["clair", "Clair", Sun], ["auto", "Auto", SunMoon]].map(([id, libelle, Icone]) => {
            const choisi = theme === id;
            return (
              <button
                key={id}
                onClick={() => surTheme(id)}
                aria-pressed={choisi}
                className={`h-[62px] rounded-[20px] flex flex-col items-center justify-center gap-1 text-[13px] font-bold transi ${
                  choisi ? "bg-accent text-accent-ink" : "text-brume active:bg-carte2"
                }`}
              >
                <Icone size={18} strokeWidth={2.2} />
                {libelle}
              </button>
            );
          })}
        </div>
        <p className="text-sourd text-xs mt-2.5 px-1 leading-relaxed">
          Auto suit le réglage du téléphone. Ce choix ne vaut que pour cet appareil.
        </p>
      </Section>

      <Section titre="Espace">
        <div className="surface rounded-3xl divide-y divide-ligne overflow-hidden">
          <Ligne
            icone={syncEtat === "ok" ? Cloud : CloudOff}
            libelle={espace ? espace.nom : "Sur cet appareil"}
            detail={
              syncEtat === "ok"
                ? "Synchronisé : vos téléphones voient les mêmes données"
                : "Données sur cet appareil uniquement"
            }
          />
          {syncEtat === "ok" && espace && espace.protege !== false && (
            <Ligne icone={ShieldCheck} libelle="Protégé par un code" detail="Demandé une seule fois par téléphone" />
          )}
          {espace && (
            <Ligne icone={LogOut} libelle="Changer d’espace" surClic={surChangerEspace}>
              <ChevronRight size={18} className="text-sourd" />
            </Ligne>
          )}
        </div>
        {syncEtat === "ok" && espace && espace.protege === false && (
          <div className="mt-3">
            <CarteProtection surDefinirCode={surDefinirCode} />
          </div>
        )}
        {syncEtat !== "ok" && (
          <p className="text-sourd text-xs mt-2.5 px-1 leading-relaxed">
            Pour voir les séances des autres depuis ton téléphone, active le stockage sur Vercel
            (voir le README du projet) — 2 minutes, gratuit.
          </p>
        )}
      </Section>

      {noteOsseuse && (
        <section className="rounded-3xl degrade-heros p-4 flex gap-3">
          <HeartPulse size={20} className="text-accent shrink-0 mt-0.5 transi" />
          <p className="text-sm leading-relaxed text-douce">
            <strong className="text-encre">Le renfo, ton meilleur allié.</strong> Il entretient la
            densité osseuse et le muscle — exactement ce qu’il faut à {age} ans. Machines assises,
            cardio sans impact, et zéro pression : la douceur d’abord, toujours.
          </p>
        </section>
      )}

      <Section titre="Conseils du coach">
        <div className="surface rounded-3xl divide-y divide-ligne overflow-hidden">
          {CONSEILS.map((c) => (
            <Accordeon
              key={c.id}
              icone={c.icone}
              titre={c.titre}
              texte={c.texte}
              accent={niveau === "doux" && c.id === "cinquante-quatre"}
            />
          ))}
        </div>
      </Section>

      <Section titre="Profils">
        <div className="surface rounded-3xl divide-y divide-ligne overflow-hidden">
          {profils.length < 6 && (
            <Ligne icone={UserPlus} libelle="Ajouter un profil" detail="Un prénom, une couleur, un niveau" surClic={surAjouterProfil}>
              <ChevronRight size={18} className="text-sourd" />
            </Ligne>
          )}
          {profils.length > 1 && (
            <Ligne icone={Trash2} danger libelle="Supprimer ce profil" detail="Avec toutes ses données">
              <BoutonSuppression etiquette="Supprimer ce profil" surConfirmer={surSupprimerProfil} />
            </Ligne>
          )}
        </div>
      </Section>

      <p className="text-sourd text-center text-xs leading-relaxed px-4">
        Avant de commencer, un avis médical est recommandé — surtout pour une reprise après une
        longue pause. Ce programme ne le remplace pas.
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Minuteur de repos flottant & fête de fin de séance                  */
/* ------------------------------------------------------------------ */

function MinuteurRepos({ minuteur, reste, surProlonger, surArreter }) {
  const fini = reste <= 0;
  return (
    <div className="fixed left-3 right-3 z-40 mx-auto max-w-md barre-flottante surgit" role="timer">
      <div className="verre rounded-[26px] p-2 pl-2.5 flex items-center gap-3">
        {fini ? (
          <>
            <span className="h-12 w-12 rounded-full bg-accent flex items-center justify-center shrink-0 pop">
              <Sparkles size={20} className="text-accent-ink" />
            </span>
            <p className="font-extrabold flex-1">Repos terminé — à toi !</p>
            <button
              onClick={surArreter}
              aria-label="Fermer"
              className="h-11 w-11 rounded-full bg-carte2 flex items-center justify-center shrink-0 active:scale-95 transi"
            >
              <X size={18} className="text-brume" />
            </button>
          </>
        ) : (
          <>
            <Anneau fait={reste} total={minuteur.total} taille={48} epaisseur={4}>
              <Timer size={16} className="text-accent transi" />
            </Anneau>
            <div className="flex-1 min-w-0">
              <p className="text-[11px] text-brume truncate">Repos · {minuteur.label}</p>
              <p className="text-[24px] font-extrabold chiffres leading-tight tracking-tight">
                {Math.floor(reste / 60)}:{String(reste % 60).padStart(2, "0")}
              </p>
            </div>
            <button
              onClick={surProlonger}
              className="h-11 px-3.5 rounded-full bg-carte2 text-sm font-bold flex items-center gap-1 shrink-0 active:scale-95 transi"
            >
              <Plus size={15} /> 30 s
            </button>
            <button
              onClick={surArreter}
              aria-label="Arrêter le repos"
              className="h-11 w-11 rounded-full bg-carte2 flex items-center justify-center shrink-0 active:scale-95 transi"
            >
              <X size={18} className="text-brume" />
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function FeteSeance({ fete, stats, surFermer }) {
  useVerrouScroll();
  /* quelques éclats qui jaillissent autour de la coche */
  const eclats = useMemo(
    () =>
      Array.from({ length: 16 }, (_, i) => {
        const a = (i / 16) * Math.PI * 2;
        const r = 66 + (i % 3) * 20;
        return { dx: Math.cos(a) * r, dy: Math.sin(a) * r, t: 5 + (i % 4) * 2, d: (i % 5) * 0.05 };
      }),
    []
  );
  const records = fete.records || [];
  const message = fete.repeat
    ? "Deuxième fois cette semaine sur cette séance — double dose, chapeau. Elle compte, évidemment."
    : MESSAGES_FETE[fete.total % MESSAGES_FETE.length];

  return createPortal(
    <div className="fixed inset-0 z-50 voile font-jakarta text-encre flex items-center justify-center p-5" onClick={surFermer}>
      <div
        className="w-full max-w-sm rounded-[32px] degrade-heros p-6 pt-9 text-center surgit"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Séance validée"
      >
        <div className="relative mx-auto h-24 w-24">
          {eclats.map((e, i) => (
            <span
              key={i}
              className="eclat absolute left-1/2 top-1/2 rounded-full bg-accent"
              style={{
                width: e.t, height: e.t, marginLeft: -e.t / 2, marginTop: -e.t / 2,
                "--dx": `${e.dx}px`, "--dy": `${e.dy}px`, animationDelay: `${0.12 + e.d}s`,
              }}
            />
          ))}
          <span className="relative h-24 w-24 rounded-full bg-accent flex items-center justify-center pop lueur-accent">
            <Check size={46} strokeWidth={3.2} className="text-accent-ink" />
          </span>
        </div>
        <h2 className="mt-6 titre-l">Séance validée !</h2>
        <p className="mt-1 text-brume text-sm">{fete.titre}</p>
        <p className="mt-3 text-douce text-[15px] leading-relaxed">{message}</p>

        <div className="mt-5 grid grid-cols-3 gap-2">
          {[
            [Clock, fete.duree ? `${fete.duree}` : "—", fete.duree ? "min" : "", "durée"],
            [Dumbbell, String(fete.nbExos || 0), "", fete.nbExos > 1 ? "exercices" : "exercice"],
            [Zap, fete.kcal ? `${fete.kcal}` : "—", fete.kcal ? "kcal" : "", "dépensées"],
          ].map(([Icone, valeur, unite, libelle]) => (
            <div key={libelle} className="rounded-2xl bg-carte2 py-3 px-2">
              <Icone size={15} className="text-accent mx-auto transi" />
              <p className="mt-1.5 text-[19px] font-extrabold chiffres leading-none">
                {valeur}
                {unite && <span className="text-xs text-brume font-bold"> {unite}</span>}
              </p>
              <p className="text-[11px] text-brume mt-1">{libelle}</p>
            </div>
          ))}
        </div>

        {records.length > 0 && (
          <div className="mt-3 rounded-2xl bg-or-doux p-3.5 text-left">
            <p className="text-or font-extrabold text-sm flex items-center gap-2">
              <Trophy size={16} /> Nouveau{records.length > 1 ? "x" : ""} record{records.length > 1 ? "s" : ""} !
            </p>
            {records.map((r) => (
              <p key={r.id} className="text-sm mt-1.5 flex items-baseline justify-between gap-3">
                <span className="text-douce truncate">{r.nom}</span>
                <span className="font-bold chiffres shrink-0">
                  {r.charge} kg <span className="text-or">+{r.gain}</span>
                </span>
              </p>
            ))}
          </div>
        )}

        <p className="mt-4 text-sourd text-xs chiffres">
          {stats.total} séance{stats.total > 1 ? "s" : ""} au total · {stats.nCetteSemaine} cette semaine
        </p>
        <button
          onClick={surFermer}
          className="mt-5 w-full h-14 rounded-2xl bg-accent text-accent-ink font-extrabold text-base active:scale-98 transi"
        >
          Continuer
        </button>
      </div>
    </div>,
    coucheModale()
  );
}

/* ------------------------------------------------------------------ */
/* Progrès : chiffres clés, assiduité, records, courbe par exercice    */
/* ------------------------------------------------------------------ */

function CourbeCharge({ points }) {
  const L = 320;
  const H = 160;
  const mgG = 30;
  const mgB = 14;
  const mgT = 20;
  const mgD = 12;
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
  const ticks = [haut0, (haut0 + haut1) / 2, haut1];

  return (
    <svg viewBox={`0 0 ${L} ${H}`} width="100%" role="img" aria-label="Évolution de la charge" style={{ display: "block" }}>
      <defs>
        <linearGradient id="degrade-courbe" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" className="stop-accent" stopOpacity="0.32" />
          <stop offset="100%" className="stop-accent" stopOpacity="0" />
        </linearGradient>
      </defs>
      {ticks.map((t, i) => (
        <g key={i}>
          <line x1={mgG} y1={y(t)} x2={L - mgD} y2={y(t)} className="grille-progres" />
          <text x={mgG - 7} y={y(t) + 3} textAnchor="end" className="axe-progres chiffres">
            {Math.round(t)}
          </text>
        </g>
      ))}
      <path d={aire} className="aire-progres" />
      <path d={ligne} className="ligne-progres" fill="none" />
      {points.map((p, i) => (
        <circle
          key={i}
          cx={x(i)}
          cy={y(p.charge)}
          r={i === n - 1 ? 5.5 : 3.5}
          className={i === n - 1 ? "point-final" : "point-progres"}
        />
      ))}
      <text
        x={x(n - 1) > L - 40 ? x(n - 1) + 6 : x(n - 1)}
        y={y(vals[n - 1]) - 12}
        textAnchor={x(n - 1) > L - 40 ? "end" : "middle"}
        className="valeur-progres chiffres"
      >
        {vals[n - 1]} kg
      </text>
    </svg>
  );
}

function Tuile({ icone: Icone, valeur, unite, libelle }) {
  return (
    <div className="surface rounded-3xl p-4">
      <span className="h-9 w-9 rounded-full bg-accent-soft flex items-center justify-center transi">
        <Icone size={17} className="text-accent transi" />
      </span>
      <p className="mt-3.5 flex items-baseline gap-1">
        <span className="chiffre-xl">{valeur}</span>
        {unite && <span className="text-sm font-bold text-brume">{unite}</span>}
      </p>
      <p className="text-xs text-brume mt-1.5 leading-snug">{libelle}</p>
    </div>
  );
}

function VueProgres({ profil, historique, dico, stats, objectif = 3 }) {
  const [tousRecords, setTousRecords] = useState(false);
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

  /* record de chaque exercice (charge la plus lourde, et quand) */
  const records = useMemo(() => {
    const m = new Map();
    for (const s of series) {
      let best = null;
      for (const pt of s.points) if (!best || pt.charge > best.charge) best = pt;
      if (best) m.set(s.id, { id: s.id, nom: s.nom, charge: best.charge, d: best.d, n: s.points.length });
    }
    return [...m.values()].sort((a, b) => (a.d < b.d ? 1 : a.d > b.d ? -1 : b.charge - a.charge));
  }, [series]);

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
  const il30 = cleJour(new Date(Date.now() - 29 * 86400000));
  const volume = stats.volume30 >= 1000
    ? [String(Math.round(stats.volume30 / 100) / 10).replace(".", ","), "t"]
    : [formatNombre(stats.volume30), "kg"];

  return (
    <div key={profil} className="vue space-y-7">
      <div>
        <h1 className="titre-xl">Progrès</h1>
        <p className="text-douce text-[15px] mt-2 leading-snug">Les chiffres qui prouvent que ça avance.</p>
      </div>

      <div className="grid grid-cols-2 gap-2.5">
        <Tuile icone={CalendarCheck} valeur={stats.n30} libelle={`séance${stats.n30 > 1 ? "s" : ""} sur 30 jours · ${stats.total} au total`} />
        <Tuile icone={Flame} valeur={stats.serie} unite={stats.serie > 1 ? "sem." : "sem."} libelle="d’affilée avec au moins une séance" />
        <Tuile icone={Zap} valeur={formatNombre(stats.kcal30)} unite="kcal" libelle="dépensées sur 30 jours (estimation)" />
        <Tuile icone={Weight} valeur={volume[0]} unite={volume[1]} libelle="soulevés sur 30 jours (charge × reps)" />
      </div>

      <Section titre="Assiduité">
        <div className="surface rounded-3xl p-4 pt-3">
          <Barres barres={stats.barres} objectif={objectif} />
          <p className="text-sourd text-xs mt-3 leading-relaxed">
            Séances par semaine sur 8 semaines. Le pointillé, c’est ton objectif ({objectif}) : les
            semaines qui l’atteignent sont en pleine couleur.
          </p>
        </div>
      </Section>

      {series.length === 0 ? (
        <section className="surface rounded-4xl p-8 text-center">
          <span className="mx-auto h-16 w-16 rounded-full bg-accent-soft flex items-center justify-center">
            <TrendingUp size={28} className="text-accent transi" />
          </span>
          <h3 className="mt-4 font-bold text-base">Ta courbe de force arrive</h3>
          <p className="text-brume text-sm mt-2 leading-relaxed">
            Note tes charges pendant les séances : dès qu’un exercice aura été fait, ses records et
            sa progression s’afficheront ici.
          </p>
        </section>
      ) : (
        <>
          <Section
            titre="Records"
            action={records.length > 5 ? (tousRecords ? "Moins" : `Tout voir (${records.length})`) : null}
            surAction={() => setTousRecords(!tousRecords)}
          >
            <div className="surface rounded-3xl divide-y divide-ligne overflow-hidden">
              {(tousRecords ? records : records.slice(0, 5)).map((r) => (
                <div key={r.id} className="flex items-center gap-3 px-4 py-3">
                  <span className={`h-9 w-9 rounded-full flex items-center justify-center shrink-0 ${r.d >= il30 ? "bg-or-doux" : "bg-carte2"}`}>
                    <Trophy size={16} className={r.d >= il30 ? "text-or" : "text-sourd"} />
                  </span>
                  <span className="flex-1 min-w-0">
                    <span className="block text-sm font-bold truncate">{r.nom}</span>
                    <span className="block text-xs text-brume">
                      {FORMAT_MINI.format(depuisCle(r.d))}
                      {r.d >= il30 ? " · récent" : ""}
                    </span>
                  </span>
                  <span className="text-[17px] font-extrabold chiffres shrink-0">
                    {String(r.charge).replace(".", ",")} <span className="text-xs text-brume font-bold">kg</span>
                  </span>
                </div>
              ))}
            </div>
          </Section>

          <Section titre="Courbe de charge">
            {/* roulette de sélection, triée par catégorie */}
            <RoueExercices categories={categories} choisi={courant.id} surChoisir={setChoisi} />
            <div className="surface rounded-3xl p-4 mt-2.5">
              <div className="flex items-baseline justify-between gap-3 mb-2">
                <h3 className="font-bold text-[15px] leading-tight min-w-0 truncate">{courant.nom}</h3>
                {courant.points.length > 1 && (() => {
                  const delta = courant.points[courant.points.length - 1].charge - courant.points[0].charge;
                  return (
                    <span
                      className={`text-[13px] font-extrabold chiffres shrink-0 px-2 py-0.5 rounded-full ${
                        delta > 0 ? "bg-accent-soft text-accent" : "bg-carte2 text-brume"
                      }`}
                    >
                      {delta > 0 ? "+" : ""}{delta.toLocaleString("fr-FR")} kg
                    </span>
                  );
                })()}
              </div>
              {courant.points.length > 1 ? (
                <CourbeCharge points={courant.points} />
              ) : (
                <div className="rounded-2xl bg-carte2 p-5 text-center">
                  <p className="chiffre-xl">{courant.points[0].charge} kg</p>
                  <p className="text-brume text-xs mt-2">
                    Une seule mesure pour l’instant — refais cet exercice pour voir la courbe monter.
                  </p>
                </div>
              )}
              <div className="mt-3 flex items-center justify-between text-xs text-brume chiffres">
                <span>
                  Première : {courant.points[0].charge} kg · {FORMAT_MINI.format(depuisCle(courant.points[0].d))}
                </span>
                <span>Dernière : {courant.points[courant.points.length - 1].charge} kg</span>
              </div>
            </div>
            <p className="text-sourd text-xs mt-2.5 px-1 leading-relaxed">
              La série la plus lourde de chaque séance. Quand tu tiens toutes tes séries au haut de
              la fourchette, monte d’un cran.
            </p>
          </Section>
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Journal : calendrier du mois et séances passées                     */
/* ------------------------------------------------------------------ */

function CalendrierMois({ historique, mois, surMois }) {
  const auj = cleJour();
  const premier = new Date(mois.a, mois.m, 1);
  const nbJours = new Date(mois.a, mois.m + 1, 0).getDate();
  const decalage = (premier.getDay() + 6) % 7;
  const parJour = {};
  let kcal = 0, n = 0;
  for (const h of historique) {
    const d = depuisCle(h.d);
    if (d.getFullYear() === mois.a && d.getMonth() === mois.m) {
      parJour[h.d] = (parJour[h.d] || 0) + 1;
      kcal += h.kcal || 0;
      n++;
    }
  }
  const maintenant = new Date();
  const moisCourant = mois.a === maintenant.getFullYear() && mois.m === maintenant.getMonth();
  const cases = [...Array(decalage).fill(null), ...Array.from({ length: nbJours }, (_, i) => i + 1)];
  const libelleMois = FORMAT_MOIS.format(premier);

  return (
    <section className="surface rounded-4xl p-4">
      <div className="flex items-center gap-2 mb-3">
        <button
          onClick={() => surMois(-1)}
          aria-label="Mois précédent"
          className="h-9 w-9 rounded-full bg-carte2 flex items-center justify-center active:scale-95 transi"
        >
          <ChevronLeft size={17} className="text-douce" />
        </button>
        <p className="flex-1 text-center text-[15px] font-bold first-letter:uppercase">{libelleMois}</p>
        <button
          onClick={() => surMois(1)}
          disabled={moisCourant}
          aria-label="Mois suivant"
          className={`h-9 w-9 rounded-full bg-carte2 flex items-center justify-center transi ${moisCourant ? "opacity-30" : "active:scale-95"}`}
        >
          <ChevronRight size={17} className="text-douce" />
        </button>
      </div>
      <div className="grid grid-cols-7 gap-y-1.5 text-center">
        {["L", "M", "M", "J", "V", "S", "D"].map((j, i) => (
          <span key={i} className="text-[11px] font-semibold text-sourd pb-1">{j}</span>
        ))}
        {cases.map((jour, i) => {
          if (!jour) return <span key={i} />;
          const iso = cleJour(new Date(mois.a, mois.m, jour));
          const fait = parJour[iso] || 0;
          const ajd = iso === auj;
          const futur = iso > auj;
          return (
            <span key={i} className="flex justify-center">
              <span
                className={`h-9 w-9 rounded-full flex items-center justify-center text-[13px] font-bold chiffres transi ${
                  fait ? "bg-accent text-accent-ink" : ajd ? "contour-accent text-encre" : futur ? "text-sourd" : "text-douce"
                }`}
              >
                {jour}
              </span>
            </span>
          );
        })}
      </div>
      <p className="text-xs text-brume mt-3 text-center chiffres">
        {n ? `${n} séance${n > 1 ? "s" : ""} en ${libelleMois.split(" ")[0]}${kcal ? ` · ≈ ${formatNombre(kcal)} kcal` : ""}` : "Aucune séance ce mois-ci"}
      </p>
    </section>
  );
}

/* « 3 exos · 52 min · ≈ 290 kcal » */
function infosSeance(h) {
  return [
    h.detail ? `${h.detail.length} exo${h.detail.length > 1 ? "s" : ""}` : null,
    h.duree ? `${h.duree} min` : null,
    h.kcal ? `≈ ${h.kcal} kcal` : null,
  ].filter(Boolean);
}

/* Exercices faits lors d'une séance validée : séries, charges, records */
function DetailSeance({ h }) {
  if (!h.detail || !h.detail.length) {
    return (
      <p className="text-brume text-xs leading-relaxed">
        Détail non enregistré — les séances validées à partir de maintenant
        garderont leurs exercices, séries et charges.
      </p>
    );
  }
  return (
    <div className="rounded-2xl bg-carte2 p-3 space-y-2">
      {h.detail.map((dexo, j) => {
        const ch = texteCharges(dexo);
        /* charges différentes d'une série à l'autre : sur une 2e ligne */
        const variees = ch.includes("/");
        const record = h.records && h.records.includes(dexo.id);
        return (
          <div key={j}>
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-[13px] font-bold text-douce truncate flex items-center gap-1.5">
                {record && <Trophy size={12} className="text-or shrink-0" />}
                {dexo.nom}
              </span>
              <span className="text-xs text-brume chiffres shrink-0">
                {dexo.minutes
                  ? `${dexo.minutes} min`
                  : `${dexo.series} × ${dexo.reps}${ch && !variees ? ` · ${ch}` : ""}`}
              </span>
            </div>
            {variees && <p className="text-xs text-brume chiffres text-right">{ch}</p>}
          </div>
        );
      })}
    </div>
  );
}

/* Badges d'une séance validée : record battu, validation automatique */
function BadgesSeance({ h }) {
  return (
    <>
      {h.records && h.records.length > 0 && (
        <Trophy size={14} className="text-or shrink-0" aria-label="Record battu" />
      )}
      {h.auto && (
        <span
          className="text-[10px] font-bold px-1.5 py-0.5 rounded-md bg-carte2 text-brume shrink-0"
          title="Validée automatiquement : la séance avait été commencée puis oubliée"
        >
          auto
        </span>
      )}
    </>
  );
}

function VueHistorique({ profil, historique, toutesSeances, surSupprimer }) {
  const [deplie, setDeplie] = useState(null);
  const [mois, setMois] = useState(() => {
    const d = new Date();
    return { a: d.getFullYear(), m: d.getMonth() };
  });
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
    decouperTitre(h.titre || (toutesSeances.find((s) => s.id === h.s) || {}).titre || "Séance")[1];

  function changerMois(dir) {
    setMois(({ a, m }) => {
      const d = new Date(a, m + dir, 1);
      return { a: d.getFullYear(), m: d.getMonth() };
    });
  }

  const lundiActuel = lundiDe(cleJour());

  return (
    <div key={profil} className="vue space-y-7">
      <div>
        <h1 className="titre-xl">Journal</h1>
        <p className="text-douce text-[15px] mt-2 leading-snug">Chaque séance validée, avec ce que tu y as fait.</p>
      </div>

      <CalendrierMois historique={historique} mois={mois} surMois={changerMois} />

      {!historique.length ? (
        <section className="surface rounded-4xl p-8 text-center">
          <span className="mx-auto h-16 w-16 rounded-full bg-accent-soft flex items-center justify-center">
            <Flame size={28} className="text-accent transi" />
          </span>
          <h3 className="mt-4 font-bold text-base">Aucune séance pour l’instant</h3>
          <p className="text-brume text-sm mt-2 leading-relaxed">
            Chaque séance validée s’affichera ici. La première est la plus belle — elle t’attend
            sur l’accueil.
          </p>
        </section>
      ) : (
        groupes.map(({ semaine, entrees }) => (
          <Section
            key={semaine}
            titre={
              semaine === lundiActuel
                ? `Cette semaine · ${entrees.length} séance${entrees.length > 1 ? "s" : ""}`
                : `Semaine du ${FORMAT_COURT.format(depuisCle(semaine))} · ${entrees.length}`
            }
          >
            <div className="space-y-2">
              {entrees.map((h, i) => {
                const cle = `${semaine}-${h.s}-${h.d}-${i}`;
                const ouvert = deplie === cle;
                const date = depuisCle(h.d);
                const infos = infosSeance(h);
                return (
                  <div key={cle} className="surface rounded-3xl overflow-hidden">
                    <div className="p-3 pl-3.5 flex items-center gap-2">
                      <button
                        onClick={() => setDeplie(ouvert ? null : cle)}
                        aria-expanded={ouvert}
                        className="flex-1 min-w-0 flex items-center gap-3.5 text-left"
                      >
                        <span className="w-11 shrink-0 text-center">
                          <span className="block text-[21px] font-extrabold leading-none chiffres">{date.getDate()}</span>
                          <span className="block text-[11px] text-brume mt-1">{FORMAT_JOUR_COURT.format(date)}</span>
                        </span>
                        <span className="w-px self-stretch bg-ligne" />
                        <span className="flex-1 min-w-0">
                          <span className="flex items-center gap-1.5 min-w-0">
                            <span className="font-bold text-[15px] truncate">{titreDe(h)}</span>
                            <BadgesSeance h={h} />
                          </span>
                          <span className="text-brume text-xs block mt-0.5 truncate">{infos.join(" · ")}</span>
                        </span>
                        <ChevronDown size={17} className={`text-sourd shrink-0 mr-1 transi ${ouvert ? "rotate-180" : ""}`} />
                      </button>
                    </div>
                    {ouvert && (
                      <div className="px-3.5 pb-3.5 deplie">
                        <DetailSeance h={h} />
                        <div className="mt-3 flex items-center gap-2 pl-1">
                          <span className="flex-1 text-xs text-sourd">Validée par erreur ?</span>
                          <BoutonSuppression
                            etiquette="Supprimer cette séance de l’historique"
                            surConfirmer={() => surSupprimer(h)}
                          />
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </Section>
        ))
      )}

      {historique.length > 0 && (
        <p className="text-sourd text-center text-xs leading-relaxed px-4">
          Une séance validée par erreur (ou validée « auto » alors que c’était un essai) ?
          Supprime-la ici, l’assiduité se recalcule toute seule.
        </p>
      )}
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
        <div className="flex items-center gap-3 pt-4 mb-6">
          <button
            onClick={surFermer}
            aria-label="Annuler et revenir"
            className="h-11 w-11 rounded-full surface-2 flex items-center justify-center shrink-0 active:scale-95 transi"
          >
            <ChevronLeft size={21} />
          </button>
          <div className="flex-1 min-w-0">
            <h2 className="titre-l">Nouveau programme</h2>
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
              className="w-full rounded-3xl surface p-4 flex items-center gap-4 text-left active:scale-98 transi"
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
      <div className="flex items-center gap-3 pt-4 mb-6">
        <button
          onClick={surFermer}
          aria-label="Annuler et revenir"
          className="h-11 w-11 rounded-full surface-2 flex items-center justify-center shrink-0 active:scale-95 transi"
        >
          <ChevronLeft size={21} />
        </button>
        <div className="flex-1 min-w-0">
          <h2 className="titre-l">
            {initial ? "Modifier le programme" : "Nouveau programme"}
          </h2>
          <p className="text-brume text-xs mt-0.5">Les exercices s’enchaînent dans l’ordre affiché</p>
        </div>
      </div>

      <label className="block mb-5">
        <span className="text-[13px] font-bold text-douce block mb-2 px-1">
          Nom du programme
        </span>
        <input
          type="text"
          value={nom}
          onChange={(e) => setNom(e.target.value)}
          placeholder="Ex. : Spécial jambes, Semaine légère…"
          className="w-full rounded-2xl surface px-4 font-bold text-base outline-none placeholder-sourd focus:bg-carte2 transi"
          style={{ height: 52 }}
        />
      </label>

      <div className="space-y-4">
        {seances.map((s, i) => (
          <section key={i} className="rounded-4xl surface p-4">
            <div className="flex items-center gap-2 mb-3">
              <span className="h-9 w-9 rounded-xl bg-accent-soft text-accent flex items-center justify-center font-extrabold shrink-0 transi">
                {i + 1}
              </span>
              <input
                type="text"
                value={s.nom}
                onChange={(e) => majSeance(i, { nom: e.target.value })}
                placeholder={`Séance ${i + 1}`}
                className="flex-1 min-w-0 rounded-xl bg-carte2 px-3 font-bold text-sm outline-none placeholder-sourd"
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
              className={`w-full rounded-2xl p-3 mb-3 flex items-center gap-3 text-left transi ${
                s.tabata ? "bg-accent-soft contour-accent" : "bg-carte2"
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
                    <li key={exoId} className="rounded-2xl bg-carte2 p-2 pl-3 flex items-center gap-2">
                      <span className="text-brume text-xs chiffres shrink-0 w-4">{idx + 1}</span>
                      <span className="flex-1 min-w-0">
                        <span className="font-bold text-sm block truncate">{exo.nom}</span>
                        <span className="text-brume text-xs block chiffres">
                          {s.tabata
                            ? `${(s.rounds && s.rounds[exoId]) || 8} rounds`
                            : exo.duree
                            ? `${exo.duree} min`
                            : `${exo.series} × ${exo.reps}`} · {exo.zone}
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
              className="mt-2 w-full h-12 rounded-xl border border-dashed border-carte3 text-douce text-sm font-bold flex items-center justify-center gap-2 active:scale-98 transi"
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
          className="mt-3 w-full h-12 rounded-2xl border border-dashed border-carte3 text-brume text-sm font-bold flex items-center justify-center gap-2 active:scale-98 transi"
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
function SelecteurExos({ nomSeance, exoIds, indisponibles = null, dico, exosPerso, surSauverExo, surSupprimerExo, surBasculer, surFermer }) {
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
            <h2 className="titre-l">Ajouter des exercices</h2>
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

        <label className="flex items-center gap-2.5 rounded-2xl surface px-4 shrink-0" style={{ height: 50 }}>
          <Search size={18} className="text-brume shrink-0" />
          <input
            type="text"
            value={recherche}
            onChange={(e) => setRecherche(e.target.value)}
            placeholder="Rechercher un exercice…"
            className="w-full min-w-0 bg-transparent text-sm font-bold outline-none placeholder-sourd"
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
                zone === z ? "bg-accent text-accent-ink" : "bg-carte2 text-brume"
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
            className="w-full h-12 rounded-2xl border border-dashed border-carte3 text-douce text-sm font-bold flex items-center justify-center gap-2 active:scale-98 transi"
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
              <p className="text-[13px] font-bold text-douce mb-2 px-1">{sec.zone}</p>
              <div className="space-y-2">
                {sec.exos.map((exo) => {
                  const choisi = exoIds.includes(exo.id);
                  /* déjà dans la séance : on ne l'ajoute pas une deuxième fois */
                  const pris = !choisi && !!indisponibles && indisponibles.has(exo.id);
                  return (
                    <div
                      key={exo.id}
                      className={`rounded-3xl flex items-stretch transi ${
                        choisi ? "surface contour-accent" : "surface"
                      } ${pris ? "opacity-50" : ""}`}
                    >
                      <button
                        onClick={() => !pris && surBasculer(exo.id)}
                        disabled={pris}
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
                            {pris
                              ? "Déjà dans la séance"
                              : exo.duree
                              ? `${exo.duree} min en continu`
                              : `${exo.series} × ${exo.reps} · repos ${exo.repos} s`}
                          </span>
                        </span>
                        {!pris && (
                          <span
                            className={`h-9 w-9 rounded-full flex items-center justify-center shrink-0 transi ${
                              choisi ? "bg-accent" : "bg-carte2"
                            }`}
                          >
                            {choisi
                              ? <Check size={18} strokeWidth={3.5} className="text-accent-ink pop" />
                              : <Plus size={18} className="text-brume" />}
                          </span>
                        )}
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
    coucheModale()
  );
}

/* Intensité d'un cardio maison → MET pour l'estimation d'énergie
   (classes de l'OMS / ACSM : modéré de 3 à 6 MET, soutenu au-delà) */
const INTENSITES = [
  { id: "douce", nom: "Douce", met: 3.5 },
  { id: "moderee", nom: "Modérée", met: 5 },
  { id: "soutenue", nom: "Soutenue", met: 7.5 },
];

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
  const [consigne, setConsigne] = useState(
    initial && initial.charge ? initial.charge.standard || initial.charge.esteban || "" : ""
  );
  const [conseil, setConseil] = useState(initial ? initial.conseil || "" : "");
  const [groupe, setGroupe] = useState(initial ? initial.groupe || null : null);
  /* cardio : en durée (tapis, vélo…) ou en séries (fractionné) */
  const [enDuree, setEnDuree] = useState(initial ? !!initial.duree : true);
  const [duree, setDuree] = useState(initial && initial.duree ? String(initial.duree) : "20");
  const [intensite, setIntensite] = useState(() => {
    const met = initial && typeof initial.met === "number" ? initial.met : 5;
    return INTENSITES.reduce((a, b) => (Math.abs(b.met - met) < Math.abs(a.met - met) ? b : a)).id;
  });
  const cardio = zone === "Cardio";
  const continu = cardio && enDuree;

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
    const minutes = Math.max(1, parseInt(duree, 10) || 20);
    surSauver({
      id: initial ? initial.id : `exo-${Date.now()}`,
      perso: true,
      nom: nom.trim(),
      zone,
      muscles,
      series: continu ? 1 : Math.max(1, parseInt(series, 10) || 3),
      reps: continu ? `${minutes} min` : reps.trim() || "12",
      repos: continu ? 0 : parseInt(repos, 10) || 60,
      sansCharge: continu ? true : sansCharge,
      ...(continu ? { duree: minutes } : {}),
      ...(cardio ? { met: INTENSITES.find((i) => i.id === intensite).met } : {}),
      groupe: groupe || (cardio ? (continu ? "cardio-continu" : "cardio-fractionne") : undefined),
      charge: { standard: texteConsigne, doux: texteConsigne },
      variante: "",
      conseil: conseil.trim(),
    });
  }

  const etiquette = "text-[13px] font-bold text-douce block mb-2 px-1";

  return (
    <div className="fixed inset-0 z-50 bg-fond overflow-y-auto defile coussin-haut">
      <div className="mx-auto w-full max-w-md px-4 pb-10">
        <div className="flex items-center gap-3 pt-5 pb-4">
          <button
            onClick={surFermer}
            aria-label="Annuler"
            className="h-11 w-11 rounded-full surface-2 flex items-center justify-center shrink-0 active:scale-95 transi"
          >
            <ChevronLeft size={21} />
          </button>
          <div className="flex-1 min-w-0">
            <h2 className="titre-l">
              {initial ? "Modifier l’exercice" : "Mon exercice"}
            </h2>
            <p className="text-brume text-xs mt-0.5">Il rejoindra le catalogue de l’espace</p>
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
              className="w-full rounded-2xl surface px-4 font-bold text-base outline-none placeholder-sourd focus:bg-carte2 transi"
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
                    zone === z ? "bg-accent text-accent-ink" : "bg-carte2 text-brume"
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

          {cardio && (
            <div>
              <span className={etiquette}>Format</span>
              <div className="grid grid-cols-2 gap-1.5">
                {[[true, "En durée", "tapis, vélo, rameur…"], [false, "En séries", "fractionné, HIIT"]].map(([v, titre, detail]) => (
                  <button
                    key={titre}
                    onClick={() => setEnDuree(v)}
                    aria-pressed={enDuree === v}
                    className={`rounded-xl px-3 py-2 text-left transi ${
                      enDuree === v ? "bg-accent text-accent-ink" : "bg-carte2 text-douce"
                    }`}
                  >
                    <span className="block text-sm font-bold">{titre}</span>
                    <span className={`block text-xs mt-0.5 ${enDuree === v ? "opacity-75" : "text-brume"}`}>{detail}</span>
                  </button>
                ))}
              </div>
              {continu && (
                <div className="mt-3 flex gap-1.5">
                  {["10", "15", "20", "30", "45"].map((d) => (
                    <button
                      key={d}
                      onClick={() => setDuree(d)}
                      className={`flex-1 rounded-xl text-sm font-bold chiffres transi ${
                        duree === d ? "bg-accent text-accent-ink" : "bg-carte2 text-brume"
                      }`}
                      style={{ height: 44 }}
                    >
                      {d} min
                    </button>
                  ))}
                </div>
              )}
              <span className={`${etiquette} mt-4`}>Intensité</span>
              <div className="flex gap-1.5">
                {INTENSITES.map((i) => (
                  <button
                    key={i.id}
                    onClick={() => setIntensite(i.id)}
                    className={`flex-1 rounded-xl text-sm font-bold transi ${
                      intensite === i.id ? "bg-accent text-accent-ink" : "bg-carte2 text-brume"
                    }`}
                    style={{ height: 44 }}
                  >
                    {i.nom}
                  </button>
                ))}
              </div>
              <p className="text-brume text-xs mt-2 leading-relaxed">
                Douce : tu peux chanter. Modérée : parler, pas chanter. Soutenue : quelques mots
                seulement. Sert à estimer l’énergie dépensée.
              </p>
            </div>
          )}

          {!continu && (
          <>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <span className={etiquette}>Séries</span>
              <div className="flex gap-1.5">
                {["2", "3", "4"].map((s) => (
                  <button
                    key={s}
                    onClick={() => setSeries(s)}
                    className={`flex-1 rounded-xl text-sm font-bold chiffres transi ${
                      series === s ? "bg-accent text-accent-ink" : "bg-carte2 text-brume"
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
                className="w-full rounded-2xl surface px-3 text-center font-bold text-sm outline-none placeholder-sourd chiffres"
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
                    repos === r ? "bg-accent text-accent-ink" : "bg-carte2 text-brume"
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
            className={`w-full rounded-2xl p-3.5 flex items-center gap-3 text-left transi ${
              sansCharge ? "surface contour-accent" : "surface"
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
          </>
          )}

          <label className="block">
            <span className={etiquette}>Consigne de départ (optionnel)</span>
            <input
              type="text"
              value={consigne}
              onChange={(e) => setConsigne(e.target.value)}
              placeholder="Ex. : Départ conseillé : 20–30 kg"
              className="w-full rounded-2xl surface px-4 text-sm font-bold outline-none placeholder-sourd"
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
              className="w-full rounded-2xl surface px-4 py-3 text-sm outline-none placeholder-sourd resize-none leading-relaxed"
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

/* Chrono de la séance en cours (depuis la première action) */
function Chrono({ depuis }) {
  const [, setT] = useState(0);
  useEffect(() => {
    const i = setInterval(() => setT((x) => x + 1), 1000);
    return () => clearInterval(i);
  }, []);
  const s = Math.max(0, Math.floor((Date.now() - depuis) / 1000));
  /* au-delà de 4 h, c'est une séance oubliée : pas de chrono absurde */
  if (s > 4 * 3600) return null;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return (
    <span className="h-9 px-3 rounded-full surface-2 flex items-center gap-1.5 text-[13px] font-bold chiffres shrink-0" aria-label="Durée de la séance">
      <Clock size={13} className="text-accent transi" />
      {h ? `${h}:${String(m).padStart(2, "0")}` : m}:{sec}
    </span>
  );
}

function VueSeance({
  seance, profil, niveau, etat, charges, dico, tousExos, faiteCetteSemaine, historique, idsProgramme,
  exosPerso, surSauverExo, surSupprimerExo,
  surRetour, surCoche, surSeries, surChargeSerie, surDuree, surRemplacer, surCharge, surRepos,
  surBasculerAjout, surRetirerAjout, surRoundsAjout, surDeplacer, surReinitOrdre,
  surFin, surFinAvecSauvegarde, surAnnuler,
}) {
  const checks = etat.coches;
  const [ajoutOuvert, setAjoutOuvert] = useState(false);
  const [tabataActif, setTabataActif] = useState(null); // {slotId, exo, rounds}
  const dernieresPerfs = useMemo(() => dernieresPerfsDe(historique), [historique]);
  /* feuille de charge : {exo} (charge unique, tabata) ou {exo, slotId, index} (une série) */
  const [roue, setRoue] = useState(null);
  const [roueDuree, setRoueDuree] = useState(null); // {exo, slotId, minutes}
  const [confirmation, setConfirmation] = useState(false); // séance écourtée
  const [modeOrdre, setModeOrdre] = useState(false);
  /* exercice déplié : celui choisi à la main, sinon le premier pas encore fait */
  const [ouvertManuel, setOuvertManuel] = useState(null); // slotId | "aucun" | null
  const [etapeOuverte, setEtapeOuverte] = useState(() =>
    !etat.coches.echauffement && !seanceDemarree(etat) ? "echauffement" : null
  );

  /* emplacements = exercices du programme + ajouts propres à cette séance,
     dans l'ordre choisi pour la séance du jour */
  const slots = slotsDe(seance, etat, dico);
  const slotIds = slots.map((s) => s.slotId);
  const ordreModifie = etat.ordre && etat.ordre.length > 0;

  const etapes = [
    { id: "echauffement" },
    ...slots.map((s) => ({ id: s.slotId })),
    ...(seance.cardio ? [{ id: "cardio" }] : []),
    { id: "retour" },
  ];
  const nFait = etapes.filter((e) => checks[e.id]).length;
  const tout = nFait === etapes.length;
  const peutValider = nFait > 0 || seanceDemarree(etat);
  const avancement =
    (nFait +
      slots.reduce((tot, s) => {
        if (checks[s.slotId]) return tot;
        const exo = exoDuSlot(s, etat, dico);
        const n = etat.series[s.slotId] || 0;
        return tot + (exo && exo.series ? Math.min(0.9, n / exo.series) : 0);
      }, 0)) /
    etapes.length;
  /* exercices réellement faits (variante affichée, pas l'emplacement) */
  const exosFaits = slots
    .filter((s) => checks[s.slotId] || etat.series[s.slotId] > 0)
    .map((s) => etat.remplacements[s.slotId] || s.base.id);
  const affiches = slots.map((s) => exoDuSlot(s, etat, dico).id);

  const premierNonFait = slots.find((s) => !checks[s.slotId]);
  const ouvert = modeOrdre
    ? null
    : ouvertManuel === "aucun"
    ? null
    : ouvertManuel && slotIds.includes(ouvertManuel)
    ? ouvertManuel
    : premierNonFait
    ? premierNonFait.slotId
    : null;

  /* l'exercice ouvert vient d'être terminé : on passe au suivant */
  const cochesAvant = useRef(checks);
  useEffect(() => {
    if (ouvertManuel && ouvertManuel !== "aucun" && checks[ouvertManuel] && !cochesAvant.current[ouvertManuel]) {
      setOuvertManuel(null);
    }
    cochesAvant.current = checks;
  });

  const [etiquette, titre] = decouperTitre(seance.titre);

  /* cocher une étape ouverte la replie : on passe à la suite */
  function cocherEtape(id) {
    if (!checks[id] && etapeOuverte === id) setEtapeOuverte(null);
    surCoche(id);
  }

  return (
    <div key={`${profil}-${seance.id}`} className="vue">
      {/* en-tête collant : retour, titre, chrono, réorganiser, progression */}
      <div className="entete-collante -mx-5 px-5 pb-3">
        <div className="flex items-center gap-2.5">
          <button
            onClick={surRetour}
            aria-label="Retour à ma semaine"
            className="h-11 w-11 rounded-full surface-2 flex items-center justify-center shrink-0 active:scale-95 transi"
          >
            <ChevronLeft size={21} />
          </button>
          <div className="flex-1 min-w-0">
            <p className="text-[11px] font-semibold text-brume truncate first-letter:uppercase">{etiquette || seance.sousTitre}</p>
            <h1 className="text-[19px] font-extrabold tracking-tight leading-tight truncate">{titre}</h1>
          </div>
          {etat.t0 && seanceDemarree(etat) ? <Chrono depuis={etat.t0} /> : null}
          <button
            onClick={() => setModeOrdre(!modeOrdre)}
            aria-label="Réorganiser les exercices"
            aria-pressed={modeOrdre}
            className={`h-11 w-11 rounded-full flex items-center justify-center shrink-0 active:scale-95 transi ${
              modeOrdre ? "bg-accent text-accent-ink" : "surface-2 text-douce"
            }`}
          >
            <ArrowUpDown size={17} />
          </button>
        </div>
        <div className="mt-3 flex items-center gap-2.5">
          <div className="flex-1 h-1.5 rounded-full bg-carte2 overflow-hidden">
            <div className="h-full rounded-full bg-accent barre" style={{ width: `${avancement * 100}%` }} />
          </div>
          <span className="text-[11px] font-bold text-brume chiffres">{nFait}/{etapes.length}</span>
        </div>
      </div>

      {/* séance déjà validée cette semaine */}
      {faiteCetteSemaine && (
        <div className="rounded-3xl degrade-heros p-3 pl-4 mb-3 flex items-center gap-3">
          <span className="h-9 w-9 rounded-full bg-accent flex items-center justify-center shrink-0 transi">
            <Check size={18} strokeWidth={3} className="text-accent-ink" />
          </span>
          <p className="flex-1 text-sm font-bold">Validée cette semaine</p>
          <button
            onClick={surAnnuler}
            className="h-10 px-3.5 rounded-full bg-carte2 text-xs font-bold text-douce active:scale-95 transi"
          >
            Annuler la validation
          </button>
        </div>
      )}

      {modeOrdre && (
        <div className="rounded-2xl bg-accent-soft px-4 py-3 mb-3 flex items-center gap-3 deplie">
          <ArrowUpDown size={16} className="text-accent shrink-0 transi" />
          <p className="flex-1 text-xs text-douce leading-snug">
            Change l’ordre pour aujourd’hui seulement — le programme ne bouge pas.
          </p>
          <button onClick={() => setModeOrdre(false)} className="text-sm font-extrabold text-accent transi">
            OK
          </button>
        </div>
      )}

      <div className="space-y-2.5">
        {/* échauffement */}
        {!modeOrdre && (
          <EtapeSimple
            icone={Wind}
            etiquette="Échauffement"
            detail={`${ECHAUFFEMENT.duree[niveau]} · non négociable`}
            coche={!!checks["echauffement"]}
            surCoche={() => cocherEtape("echauffement")}
            ouvert={etapeOuverte === "echauffement"}
            surOuvrir={() => setEtapeOuverte(etapeOuverte === "echauffement" ? null : "echauffement")}
          >
            <p className="text-sm text-douce leading-relaxed">
              {ECHAUFFEMENT.duree[niveau]} de cardio très doux (vélo ou elliptique), puis :
            </p>
            <ul className="mt-2 space-y-1.5">
              {ECHAUFFEMENT.mobilite.map((m, i) => (
                <li key={i} className="text-[13px] text-brume leading-relaxed flex gap-2.5">
                  <span className="h-1.5 w-1.5 rounded-full bg-accent shrink-0 mt-2" />{m}
                </li>
              ))}
            </ul>
          </EtapeSimple>
        )}

        {/* exercices (programme + ajouts) */}
        {slots.map((s, i) => {
          const exoAffiche = exoDuSlot(s, etat, dico);
          /* Variantes : même famille de mouvement, mais jamais un exercice déjà
             au programme (toutes séances confondues) ni déjà affiché ailleurs
             dans la séance. On peut toujours revenir à l'exercice d'origine. */
          const ailleurs = new Set(affiches.filter((_, j) => j !== i));
          const variantes = exoAffiche.groupe
            ? tousExos.filter(
                (e) =>
                  e.groupe === exoAffiche.groupe &&
                  (e.id === exoAffiche.id ||
                    (e.id === s.base.id && !ailleurs.has(e.id)) ||
                    (!idsProgramme.has(e.id) && !ailleurs.has(e.id)))
              )
            : [];
          const seriesFaites = etat.series[s.slotId] || 0;
          const continu = !seance.tabata && !!exoAffiche.duree;
          const parSerie = !seance.tabata && !continu && !exoAffiche.sansCharge;
          const nbLignes = Math.min(8, Math.max(exoAffiche.series, seriesFaites));
          const chargesLignes = parSerie
            ? chargesDeSerie(
                nbLignes,
                etat.chargesSeries[s.slotId],
                exoAffiche.id,
                dernieresPerfs[exoAffiche.id],
                charges[exoAffiche.id]
              )
            : null;
          const dureeSaisie = etat.durees[s.slotId];
          const minutes = continu
            ? dureeSaisie && dureeSaisie.exo === exoAffiche.id
              ? dureeSaisie.v
              : (dernieresPerfs[exoAffiche.id] && dernieresPerfs[exoAffiche.id].minutes) || exoAffiche.duree
            : null;
          return (
            <CarteExo
              key={s.slotId}
              numero={i + 1}
              total={slots.length}
              exo={exoAffiche}
              nomOriginal={!s.ajout && exoAffiche.id !== s.base.id ? s.base.nom : null}
              estAjout={s.ajout}
              variantes={variantes}
              profil={profil}
              niveau={niveau}
              coche={!!checks[s.slotId]}
              seriesFaites={seriesFaites}
              chargesLignes={chargesLignes}
              minutes={minutes}
              poids={charges[exoAffiche.id] || ""}
              dernierePerf={dernieresPerfs[exoAffiche.id]}
              tabata={seance.tabata || null}
              rounds={s.rounds}
              ouvert={ouvert === s.slotId}
              modeOrdre={modeOrdre}
              surOuvrir={() => setOuvertManuel(ouvert === s.slotId ? "aucun" : s.slotId)}
              surCoche={() => surCoche(s.slotId)}
              surSeries={(n) =>
                surSeries(
                  s.slotId,
                  exoAffiche.series,
                  n,
                  chargesLignes ? { exo: exoAffiche.id, valeurs: chargesLignes } : null
                )
              }
              surRoue={() => setRoue({ exo: exoAffiche })}
              surRoueSerie={(index) => setRoue({ exo: exoAffiche, slotId: s.slotId, index, valeur: chargesLignes[index] })}
              surRoueDuree={() => setRoueDuree({ exo: exoAffiche, slotId: s.slotId, minutes })}
              surRepos={() => surRepos(exoAffiche)}
              surTabata={() => setTabataActif({ slotId: s.slotId, exo: exoAffiche, rounds: s.rounds })}
              surRetirer={s.ajout ? () => surRetirerAjout(s.slotId) : null}
              surMonter={i > 0 ? () => surDeplacer(slotIds, s.slotId, -1) : null}
              surDescendre={i < slots.length - 1 ? () => surDeplacer(slotIds, s.slotId, 1) : null}
              surRoundsCycle={
                s.ajout && seance.tabata
                  ? () => {
                      const paliers = [2, 4, 6, 8, 10, 12];
                      const prochain = paliers[(paliers.indexOf(s.rounds) + 1) % paliers.length] || 8;
                      surRoundsAjout(s.slotId, prochain);
                    }
                  : null
              }
              surVariante={(dir) => {
                if (variantes.length < 2) return;
                const idx = variantes.findIndex((e) => e.id === exoAffiche.id);
                const prochaine = variantes[(idx + dir + variantes.length) % variantes.length];
                surRemplacer(s.slotId, prochaine.id);
              }}
            />
          );
        })}

        {/* ajouter un exercice à la volée / remettre l'ordre du programme
            (ni l'un ni l'autre ne modifie le programme) */}
        {modeOrdre ? (
          ordreModifie && (
            <button
              onClick={surReinitOrdre}
              aria-label="Remettre l’ordre du programme"
              className="w-full h-12 rounded-2xl surface text-brume text-sm font-bold active:scale-98 transi"
            >
              Revenir à l’ordre d’origine
            </button>
          )
        ) : (
          <button
            onClick={() => setAjoutOuvert(true)}
            className="w-full h-[52px] rounded-3xl border border-dashed border-carte3 text-douce text-sm font-bold flex items-center justify-center gap-2 active:scale-98 transi"
          >
            <Plus size={17} className="text-accent transi" /> Ajouter un exercice
          </button>
        )}

        {/* cardio (pas en tabata : le tabata EST le cardio) */}
        {!modeOrdre && seance.cardio && (
          <EtapeSimple
            icone={HeartPulse}
            etiquette="Cardio"
            detail="15 à 20 min"
            coche={!!checks["cardio"]}
            surCoche={() => cocherEtape("cardio")}
            ouvert={etapeOuverte === "cardio"}
            surOuvrir={() => setEtapeOuverte(etapeOuverte === "cardio" ? null : "cardio")}
          >
            <p className="text-sm text-douce leading-relaxed">{seance.cardio[niveau]}</p>
          </EtapeSimple>
        )}

        {/* retour au calme */}
        {!modeOrdre && (
          <EtapeSimple
            icone={Leaf}
            etiquette="Retour au calme"
            detail="5 min · étirements doux"
            coche={!!checks["retour"]}
            surCoche={() => cocherEtape("retour")}
            ouvert={etapeOuverte === "retour"}
            surOuvrir={() => setEtapeOuverte(etapeOuverte === "retour" ? null : "retour")}
          >
            <p className="text-sm text-douce leading-relaxed">{RETOUR_AU_CALME}</p>
          </EtapeSimple>
        )}
      </div>

      <p className="text-sourd text-center text-xs mt-5 leading-relaxed px-2">
        Douleur articulaire vive ? On passe l’exercice, sans culpabiliser. Oublié de valider ? Elle
        se validera toute seule demain, à la date d’aujourd’hui.
      </p>

      {/* valider (une séance écourtée se valide aussi) — barre fixée en bas */}
      {createPortal(
        <div className="fixed inset-x-0 bottom-0 z-30 font-jakarta text-encre pointer-events-none">
          <div
            className="mx-auto max-w-md px-4 pt-6 barre-action pointer-events-auto degrade-bas"
          >
            <button
              onClick={() => (tout ? surFin() : setConfirmation(true))}
              disabled={!peutValider}
              className={`w-full rounded-2xl font-extrabold text-base flex items-center justify-center gap-2 transi ${
                peutValider ? "bg-accent text-accent-ink active:scale-98 lueur-accent" : "bg-carte2 text-sourd"
              }`}
              style={{ height: 56 }}
            >
              {peutValider && <Check size={19} strokeWidth={3} />}
              {!peutValider
                ? "Coche au moins une étape"
                : tout
                ? "Valider la séance"
                : `Valider la séance (${nFait}/${etapes.length})`}
            </button>
          </div>
        </div>,
        coucheModale()
      )}

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
          exo={roue.exo}
          sousTitre={roue.slotId ? `Série ${roue.index + 1} · charge utilisée` : "Charge utilisée"}
          valeurInitiale={roue.slotId ? roue.valeur || "" : charges[roue.exo.id] || ""}
          sansEffacer={!!roue.slotId}
          surValider={(v) => {
            if (roue.slotId) surChargeSerie(roue.slotId, roue.exo.id, roue.index, v);
            else surCharge(roue.exo.id, v);
            setRoue(null);
          }}
          surFermer={() => setRoue(null)}
        />
      )}

      {roueDuree && (
        <FeuilleDuree
          exo={roueDuree.exo}
          valeurInitiale={roueDuree.minutes}
          surValider={(m) => { surDuree(roueDuree.slotId, roueDuree.exo.id, m); setRoueDuree(null); }}
          surFermer={() => setRoueDuree(null)}
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

      {ajoutOuvert && (
        <SelecteurExos
          nomSeance={`À ajouter à ${seance.titre}`}
          exoIds={etat.ajouts.filter((a) => !etat.remplacements[a.slotId]).map((a) => a.exoId)}
          indisponibles={
            new Set(
              slots
                .filter((s) => !s.ajout || etat.remplacements[s.slotId])
                .map((s) => exoDuSlot(s, etat, dico).id)
            )
          }
          dico={dico}
          exosPerso={exosPerso}
          surSauverExo={surSauverExo}
          surSupprimerExo={surSupprimerExo}
          surBasculer={surBasculerAjout}
          surFermer={() => setAjoutOuvert(false)}
        />
      )}
    </div>
  );
}

/* Feuille de confirmation : séance écourtée */
function ConfirmationEcourtee({ nFait, total, nbExosFaits, surValider, surValiderEtGarder, surFermer }) {
  return (
    <Feuille titre="Séance écourtée" surFermer={surFermer} sansEntete>
      <h3 className="titre-l">Séance écourtée</h3>
      <p className="text-douce text-[15px] mt-2 leading-relaxed">
        {nFait > 0
          ? `${nFait} étape${nFait > 1 ? "s" : ""} sur ${total} — c’est déjà ça de pris, et ça compte pareil pour ton assiduité.`
          : "Quelques séries seulement — c’est déjà ça de pris : la séance est enregistrée avec ce que tu as fait, et elle compte pour ton assiduité."}
      </p>
      <div className="mt-5 space-y-2">
        <button
          onClick={surValider}
          className="w-full rounded-2xl bg-accent text-accent-ink font-extrabold text-base active:scale-98 transi"
          style={{ height: 56 }}
        >
          Valider la séance
        </button>
        {nbExosFaits > 0 && (
          <button
            onClick={surValiderEtGarder}
            className="w-full rounded-2xl bg-carte2 font-bold text-sm text-douce active:scale-98 transi px-4"
            style={{ height: 56 }}
          >
            Valider + garder cette version en programme « express »
          </button>
        )}
        <button
          onClick={surFermer}
          className="w-full rounded-2xl text-brume font-bold text-sm active:scale-98 transi"
          style={{ height: 48 }}
        >
          Continuer la séance
        </button>
      </div>
    </Feuille>
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
            className="h-11 w-11 rounded-full surface-2 flex items-center justify-center shrink-0 active:scale-95 transi"
          >
            <X size={20} className="text-brume" />
          </button>
        </div>

        <div className="flex-1 flex flex-col items-center justify-center gap-6">
          <p className={`uppercase tracking-[0.22em] font-extrabold text-[15px] transi ${couleur}`}>{libelle}</p>
          <Anneau fait={finie ? 1 : fraction} total={1} taille={268} epaisseur={14}>
            <span
              className={`chiffres font-extrabold leading-none transi ${finie || phase.type === "travail" ? "text-accent" : ""}`}
              style={{ fontSize: 108, letterSpacing: "-0.04em" }}
            >
              {finie ? "💪" : reste}
            </span>
            <span className="text-brume text-sm font-semibold chiffres mt-3">
              {phase.type === "prep" || finie ? `${rounds} rounds` : `Round ${phase.round}/${rounds}`}
            </span>
          </Anneau>
          {/* un trait par round : ceux qui sont faits s'allument */}
          <div className="flex flex-wrap justify-center gap-1.5 max-w-[260px]">
            {Array.from({ length: rounds }).map((_, i) => {
              const faits = finie
                ? rounds
                : phase.type === "travail"
                ? phase.round - 1
                : phase.type === "repos"
                ? phase.round
                : 0;
              return (
                <span
                  key={i}
                  className={`h-1.5 w-6 rounded-full transi ${
                    i < faits ? "bg-accent" : i === faits && phase.type === "travail" ? "bg-accent pulsation" : "bg-carte3"
                  }`}
                />
              );
            })}
          </div>
        </div>

        <button
          onClick={basculerPause}
          disabled={finie}
          className={`w-full rounded-2xl font-extrabold text-base flex items-center justify-center gap-2 transi ${
            pause ? "bg-accent text-accent-ink" : "surface-2 text-douce"
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
    coucheModale()
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

  const H = 152;
  const LH = 40;
  return (
    <div className="rounded-3xl surface p-3">
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

function FeuilleCharge({ exo, sousTitre = "Charge utilisée", valeurInitiale, sansEffacer = false, surValider, surFermer }) {
  const nombre = parseFloat(String(valeurInitiale).replace(",", "."));
  const initEntier = Number.isFinite(nombre) ? Math.max(0, Math.min(300, Math.floor(nombre))) : 20;
  const initDec = Number.isFinite(nombre) && Math.round((nombre % 1) * 10) >= 3 ? 1 : 0;
  const [entier, setEntier] = useState(initEntier);
  const [dec, setDec] = useState(initDec);
  const [cle, setCle] = useState(0); // remonte les roues après un ajustement rapide

  const valeur = dec === 1 ? `${entier},5` : String(entier);

  /* raccourcis : ±2,5 kg, +5 kg sans faire tourner la roue */
  function ajuster(delta) {
    const n = Math.max(0, Math.min(300.5, entier + dec * 0.5 + delta));
    setEntier(Math.floor(n));
    setDec(n % 1 ? 1 : 0);
    setCle((k) => k + 1);
  }

  return (
    <Feuille titre={exo.nom} sousTitre={sousTitre} surFermer={surFermer}>
      <div className="relative flex items-center justify-center gap-1">
        <div
          className="absolute pointer-events-none rounded-2xl bg-carte2"
          style={{ top: (200 - ROUE_H) / 2, height: ROUE_H, left: 16, right: 16 }}
        />
        <Roue key={`e${cle}`} valeurs={ROUE_ENTIERS} index={entier} surIndex={setEntier} largeur={96} />
        <Roue key={`d${cle}`} valeurs={ROUE_DECIMALES} index={dec} surIndex={setDec} largeur={64} />
        <div style={{ height: 200 }} className="relative flex items-center">
          <span className="font-bold text-brume text-sm pl-1">kg</span>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-3 gap-2">
        {[[-2.5, "−2,5"], [2.5, "+2,5"], [5, "+5"]].map(([d, libelle]) => (
          <button
            key={libelle}
            onClick={() => ajuster(d)}
            className="h-11 rounded-full bg-carte2 text-sm font-bold chiffres active:scale-95 transi"
          >
            {libelle} kg
          </button>
        ))}
      </div>

      <div className="mt-4 flex items-center gap-2">
        {!sansEffacer && (
          <button
            onClick={() => surValider("")}
            className="h-14 px-5 rounded-2xl bg-carte2 text-brume text-sm font-bold active:scale-95 transi"
          >
            Effacer
          </button>
        )}
        <button
          onClick={() => surValider(valeur)}
          className="flex-1 h-14 rounded-2xl bg-accent text-accent-ink font-extrabold text-base active:scale-98 transi chiffres"
        >
          Valider {valeur} kg
        </button>
      </div>
    </Feuille>
  );
}

/* Durée faite sur un exercice de cardio continu (roue de 1 à 120 min) */
const ROUE_MINUTES = Array.from({ length: 120 }, (_, i) => String(i + 1));

function FeuilleDuree({ exo, valeurInitiale, surValider, surFermer }) {
  const init = Math.max(1, Math.min(120, parseInt(valeurInitiale, 10) || exo.duree || 20));
  const [idx, setIdx] = useState(init - 1);
  const [cle, setCle] = useState(0);
  const minutes = idx + 1;

  return (
    <Feuille titre={exo.nom} sousTitre="Durée faite" surFermer={surFermer}>
      <div className="relative flex items-center justify-center gap-1">
        <div
          className="absolute pointer-events-none rounded-2xl bg-carte2"
          style={{ top: (200 - ROUE_H) / 2, height: ROUE_H, left: 16, right: 16 }}
        />
        <Roue key={cle} valeurs={ROUE_MINUTES} index={idx} surIndex={setIdx} largeur={96} />
        <div style={{ height: 200 }} className="relative flex items-center">
          <span className="font-bold text-brume text-sm pl-1">min</span>
        </div>
      </div>
      <div className="mt-3 grid grid-cols-5 gap-1.5">
        {[10, 15, 20, 30, 45].map((m) => (
          <button
            key={m}
            onClick={() => { setIdx(m - 1); setCle((k) => k + 1); }}
            className={`h-11 rounded-full text-sm font-bold chiffres active:scale-95 transi ${
              minutes === m ? "bg-accent-soft text-accent" : "bg-carte2"
            }`}
          >
            {m}
          </button>
        ))}
      </div>
      <button
        onClick={() => surValider(minutes)}
        className="mt-4 w-full h-14 rounded-2xl bg-accent text-accent-ink font-extrabold text-base active:scale-98 transi chiffres"
      >
        Valider {minutes} min
      </button>
    </Feuille>
  );
}

/* Étape simple (échauffement, cardio, retour au calme) : repliable */
function EtapeSimple({ icone: Icone, etiquette, detail, coche, surCoche, ouvert, surOuvrir, children }) {
  return (
    <div className="surface rounded-3xl overflow-hidden">
      <div className="flex items-center gap-3 p-2.5 pl-3.5">
        <span className={`h-10 w-10 rounded-full flex items-center justify-center shrink-0 transi ${coche ? "bg-accent-soft" : "bg-carte2"}`}>
          <Icone size={18} className={`transi ${coche ? "text-accent" : "text-douce"}`} />
        </span>
        <button onClick={surOuvrir} aria-expanded={!!ouvert} className="flex-1 min-w-0 text-left py-1">
          <span className={`block font-bold text-[15px] transi ${coche ? "text-brume" : ""}`}>{etiquette}</span>
          {detail && <span className="block text-xs text-brume mt-0.5">{detail}</span>}
        </button>
        <CaseCoche coche={coche} surClic={surCoche} />
      </div>
      {ouvert && <div className="px-4 pb-4 pt-0.5 deplie">{children}</div>}
    </div>
  );
}

/* Pastille d'état d'un exercice : numéro, anneau de séries, ou coche */
function StatutExo({ numero, coche, estAjout, fait, total, surClic }) {
  return (
    <button
      onClick={surClic}
      aria-pressed={coche}
      aria-label={coche ? "Marquer comme à faire" : "Marquer comme fait"}
      className="shrink-0 h-11 w-11 flex items-center justify-center active:scale-90 transi"
    >
      {coche ? (
        <span className="h-10 w-10 rounded-full bg-accent flex items-center justify-center">
          <Check size={19} strokeWidth={3.2} className="text-accent-ink pop" />
        </span>
      ) : fait > 0 ? (
        <Anneau fait={fait} total={total} taille={40} epaisseur={3.5}>
          <span className="text-[13px] font-extrabold chiffres">{numero}</span>
        </Anneau>
      ) : (
        <span className="h-10 w-10 rounded-full bg-carte2 flex items-center justify-center text-[14px] font-extrabold chiffres text-douce">
          {estAjout ? <Plus size={16} /> : numero}
        </span>
      )}
    </button>
  );
}

function CarteExo({
  numero, total, exo, nomOriginal, estAjout, variantes = [], profil, niveau, coche, seriesFaites,
  chargesLignes, minutes, poids, dernierePerf, tabata, rounds, ouvert, modeOrdre,
  surOuvrir, surCoche, surSeries, surRoue, surRoueSerie, surRoueDuree, surRepos, surVariante, surTabata,
  surRetirer, surRoundsCycle, surMonter, surDescendre,
}) {
  const aVariantes = variantes.length > 1;
  const continu = !tabata && !!exo.duree;
  const parSerie = !!chargesLignes;
  const nbPastilles = Math.min(6, Math.max(exo.series, seriesFaites));
  const [glisse, setGlisse] = useState(0);
  const depart = useRef(null);
  /* consignes techniques repliées pour un exercice déjà pratiqué */
  const [technique, setTechnique] = useState(!dernierePerf);

  function toucheDebut(e) {
    if (!aVariantes || !ouvert) return;
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

  /* résumé sur une ligne (carte repliée) */
  const chargesFaites = parSerie ? chargesLignes.slice(0, seriesFaites).filter(Boolean) : [];
  const texteChargesFaites = chargesFaites.length
    ? ` · ${new Set(chargesFaites).size === 1 ? chargesFaites[0] : chargesFaites.join(" / ")} kg`
    : "";
  const resume = tabata
    ? `${rounds} rounds · ${tabata.travail} s / ${tabata.repos} s`
    : continu
    ? `${minutes} min en continu`
    : seriesFaites > 0
    ? `${seriesFaites}/${exo.series} séries${texteChargesFaites}`
    : `${exo.series} × ${exo.reps}${parSerie && chargesLignes[0] ? ` · ${chargesLignes[0]} kg` : ""}`;

  const muscles = (exo.muscles || []).map((m) => MUSCLES_LIBELLES[m]).filter(Boolean).join(" · ") || "—";
  const consigne = (exo.charge && (exo.charge[niveau] || exo.charge.standard)) || "";

  /* ---------- carte repliée ---------- */
  if (!ouvert) {
    return (
      <div className={`surface rounded-3xl transi ${coche ? "opacity-80" : ""}`}>
        <div className="flex items-center gap-2 p-2.5 pl-2.5">
          <StatutExo
            numero={numero}
            coche={coche}
            estAjout={estAjout}
            fait={tabata || continu ? 0 : seriesFaites}
            total={exo.series}
            surClic={surCoche}
          />
          <button onClick={surOuvrir} aria-expanded={false} className="flex-1 min-w-0 text-left py-1">
            <span className={`block font-bold text-[15px] truncate transi ${coche ? "text-brume" : ""}`}>{exo.nom}</span>
            <span className="block text-xs text-brume truncate mt-0.5 chiffres">
              {estAjout ? "Ajout · " : ""}{resume}
            </span>
          </button>
          {modeOrdre ? (
            <div className="flex items-center gap-1 shrink-0">
              <button
                onClick={surMonter || undefined}
                disabled={!surMonter}
                aria-label={`Monter ${exo.nom} dans la séance`}
                className={`h-10 w-10 rounded-full bg-carte2 flex items-center justify-center transi ${surMonter ? "active:scale-95" : "opacity-30"}`}
              >
                <ChevronUp size={17} className="text-douce" />
              </button>
              <button
                onClick={surDescendre || undefined}
                disabled={!surDescendre}
                aria-label={`Descendre ${exo.nom} dans la séance`}
                className={`h-10 w-10 rounded-full bg-carte2 flex items-center justify-center transi ${surDescendre ? "active:scale-95" : "opacity-30"}`}
              >
                <ChevronDown size={17} className="text-douce" />
              </button>
            </div>
          ) : (
            <button onClick={surOuvrir} aria-label={`Ouvrir ${exo.nom}`} className="h-10 w-8 flex items-center justify-center shrink-0">
              <ChevronDown size={18} className="text-sourd" />
            </button>
          )}
        </div>
      </div>
    );
  }

  /* ---------- carte dépliée : l'exercice en cours ---------- */
  return (
    <div
      onTouchStart={toucheDebut}
      onTouchMove={toucheBouge}
      onTouchEnd={toucheFin}
      className="surface rounded-4xl contour-accent p-4 pt-3 deplie"
      style={{
        touchAction: "pan-y",
        transform: glisse ? `translateX(${glisse}px)` : undefined,
        transition: glisse ? "none" : "transform 0.2s ease",
      }}
    >
      <div className="flex items-start gap-2 -ml-1.5">
        <StatutExo
          numero={numero}
          coche={coche}
          estAjout={estAjout}
          fait={tabata || continu ? 0 : seriesFaites}
          total={exo.series}
          surClic={surCoche}
        />
        <button onClick={surOuvrir} aria-expanded className="flex-1 min-w-0 text-left pt-1">
          <span className="flex items-center gap-1.5 flex-wrap text-[11px] font-bold">
            <span className="text-accent transi uppercase tracking-wider">{exo.zone}</span>
            <span className="text-sourd">·</span>
            <span className="text-brume chiffres">{estAjout ? "Ajout du jour" : `Exo ${numero}/${total}`}</span>
          </span>
          <span className="block font-extrabold text-[19px] leading-tight tracking-tight mt-1">{exo.nom}</span>
        </button>
        <button onClick={surOuvrir} aria-label={`Replier ${exo.nom}`} className="h-10 w-8 flex items-center justify-center shrink-0">
          <ChevronUp size={18} className="text-sourd" />
        </button>
      </div>

      {nomOriginal && (
        <p className="text-xs text-accent transi mt-1.5">En remplacement de : {nomOriginal}</p>
      )}

      {/* objectif + repère (dernière fois ou consigne) */}
      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <span className="px-2.5 py-1 rounded-full bg-accent-soft text-accent text-xs font-extrabold chiffres transi">
          {tabata ? `${rounds} rounds` : continu ? `${exo.duree} min` : `${exo.series} × ${exo.reps}`}
        </span>
        <span className="px-2.5 py-1 rounded-full bg-carte2 text-brume text-xs font-semibold chiffres">
          {tabata ? `${tabata.travail} s / ${tabata.repos} s` : continu ? "en continu" : `repos ${exo.repos} s`}
        </span>
        {estAjout && surRoundsCycle && (
          <button
            onClick={surRoundsCycle}
            aria-label="Changer le nombre de rounds"
            className="px-2.5 py-1 rounded-full bg-carte2 text-accent text-xs font-extrabold chiffres active:scale-95 transi"
          >
            ×{rounds}
          </button>
        )}
      </div>
      {(continu || !dernierePerf) && consigne && (
        <p className="text-[13px] text-douce mt-2.5 leading-relaxed">{consigne}</p>
      )}
      {dernierePerf && (
        <p className="text-[13px] mt-2 leading-relaxed">
          <span className="text-brume">Dernière fois · </span>
          <span className="text-douce font-semibold chiffres">{texteDetail(dernierePerf)}</span>
          <span className="text-sourd"> · {FORMAT_MINI.format(depuisCle(dernierePerf.d))}</span>
        </p>
      )}

      {/* tableau des séries : une ligne par série, avec SA charge */}
      {parSerie && (
        <div className="mt-4">
          <div className="flex items-center gap-2 px-1 pb-1.5 text-sourd font-bold uppercase tracking-wider" style={{ fontSize: 10 }}>
            <span className="w-7 text-center">Série</span>
            <span className="flex-1 pl-1">Charge</span>
            <span className="w-12 text-center">Reps</span>
            <span className="w-11 text-center">Fait</span>
          </div>
          <div className="space-y-1.5">
            {chargesLignes.map((c, i) => {
              const faite = i < seriesFaites;
              const prochaine = i === seriesFaites;
              return (
                <div
                  key={i}
                  className={`flex items-center gap-2 rounded-2xl px-1 transi ${faite ? "bg-accent-soft" : prochaine ? "bg-carte2" : ""}`}
                  style={{ height: 52 }}
                >
                  <span className={`w-7 text-center text-[15px] font-extrabold chiffres transi ${faite ? "text-accent" : prochaine ? "text-encre" : "text-sourd"}`}>
                    {i + 1}
                  </span>
                  <button
                    onClick={() => surRoueSerie(i)}
                    aria-label={`Charge de la série ${i + 1} : ${c || "non renseignée"}`}
                    className={`flex-1 min-w-0 h-10 rounded-xl px-3 flex items-center gap-1.5 active:scale-98 transi ${
                      prochaine ? "bg-carte3" : faite ? "bg-transparent" : "bg-carte2"
                    }`}
                  >
                    <span className="flex-1 min-w-0 text-left font-extrabold chiffres text-[17px] truncate">{c || "—"}</span>
                    <span className="text-xs text-brume shrink-0">kg</span>
                    <ChevronDown size={13} className="text-sourd shrink-0" />
                  </button>
                  <span className="w-12 text-center text-xs text-brume chiffres truncate">{exo.reps}</span>
                  <button
                    onClick={() => surSeries(i + 1 === seriesFaites ? i : i + 1)}
                    aria-pressed={faite}
                    aria-label={`Série ${i + 1} ${faite ? "faite" : "à faire"}`}
                    className="w-11 h-11 flex items-center justify-center shrink-0"
                  >
                    <span
                      className={`h-9 w-9 rounded-full flex items-center justify-center transi ${
                        faite ? "bg-accent" : prochaine ? "border-2 battement" : "border-2 border-carte3"
                      }`}
                      style={!faite && prochaine ? { borderColor: "var(--accent-bordure)" } : undefined}
                    >
                      {faite && <Check size={17} strokeWidth={3.5} className="text-accent-ink pop" />}
                    </span>
                  </button>
                </div>
              );
            })}
          </div>
          <div className="flex items-center gap-2 pt-2.5">
            {seriesFaites >= exo.series && chargesLignes.length < 8 ? (
              <button
                onClick={() => surSeries(seriesFaites + 1)}
                className="h-10 px-3.5 rounded-full bg-carte2 text-douce text-xs font-bold flex items-center gap-1 active:scale-95 transi"
              >
                <Plus size={14} /> Série bonus
              </button>
            ) : (
              <span className="text-xs text-brume chiffres px-1">{seriesFaites}/{exo.series} séries</span>
            )}
            <span className="flex-1" />
            <button
              onClick={surRepos}
              className="h-10 px-3.5 rounded-full bg-carte2 text-xs font-bold flex items-center gap-1.5 active:scale-95 transi"
            >
              <Timer size={15} className="text-accent transi" />
              Repos {exo.repos} s
            </button>
          </div>
        </div>
      )}

      {/* au poids du corps : des pastilles suffisent */}
      {!tabata && !continu && !parSerie && (
        <div className="mt-4">
          <div className="flex items-center gap-2 flex-wrap">
            {Array.from({ length: nbPastilles }).map((_, i) => (
              <button
                key={i}
                onClick={() => surSeries(i + 1 === seriesFaites ? i : i + 1)}
                aria-label={`Série ${i + 1} ${i < seriesFaites ? "faite" : "à faire"}`}
                className={`h-11 w-11 rounded-full text-sm font-extrabold chiffres transi ${
                  i < seriesFaites ? "bg-accent text-accent-ink" : "bg-carte2 text-brume active:scale-95"
                }`}
              >
                {i < seriesFaites ? <Check size={17} strokeWidth={3.5} className="mx-auto pop" /> : i + 1}
              </button>
            ))}
            {seriesFaites >= exo.series && nbPastilles < 6 && (
              <button
                onClick={() => surSeries(seriesFaites + 1)}
                aria-label="Ajouter une série bonus"
                className="h-11 w-11 rounded-full border border-dashed border-carte3 text-brume flex items-center justify-center active:scale-95 transi"
              >
                <Plus size={16} />
              </button>
            )}
          </div>
          <div className="flex items-center gap-2 pt-3">
            <span className="text-xs text-brume chiffres px-1">{seriesFaites}/{exo.series} séries</span>
            <span className="flex-1" />
            <button
              onClick={surRepos}
              className="h-10 px-3.5 rounded-full bg-carte2 text-xs font-bold flex items-center gap-1.5 active:scale-95 transi"
            >
              <Timer size={15} className="text-accent transi" />
              Repos {exo.repos} s
            </button>
          </div>
        </div>
      )}

      {/* cardio continu : on note le temps fait */}
      {continu && (
        <button
          onClick={surRoueDuree}
          aria-label={`Durée faite sur ${exo.nom} : ${minutes} minutes`}
          className="mt-4 w-full flex items-center gap-3 rounded-2xl bg-carte2 px-4 text-left active:scale-98 transi"
          style={{ height: 60 }}
        >
          <Timer size={18} className="text-accent shrink-0 transi" />
          <span className="text-sm text-brume shrink-0">Durée faite</span>
          <span className="flex-1 min-w-0 text-right font-extrabold chiffres text-[22px]">{minutes}</span>
          <span className="text-sm text-brume shrink-0">min</span>
          <ChevronDown size={15} className="text-sourd shrink-0" />
        </button>
      )}

      {/* tabata : charge unique et chrono guidé */}
      {tabata && (
        <div className="mt-4 flex items-center gap-2">
          {!exo.sansCharge && (
            <button
              onClick={surRoue}
              aria-label={`Charge utilisée pour ${exo.nom} : ${poids || "non renseignée"}`}
              className="flex-1 flex items-center gap-2 rounded-2xl bg-carte2 px-4 text-left active:scale-98 transi"
              style={{ height: 52 }}
            >
              <span className="text-xs text-brume shrink-0">Charge</span>
              <span className="flex-1 min-w-0 text-right font-extrabold chiffres text-base truncate">{poids || "—"}</span>
              <span className="text-xs text-brume shrink-0">kg</span>
            </button>
          )}
          <button
            onClick={surTabata}
            className={`rounded-2xl bg-accent text-accent-ink px-5 font-extrabold text-sm flex items-center justify-center gap-2 active:scale-95 transi lueur-accent ${exo.sansCharge ? "flex-1" : "shrink-0"}`}
            style={{ height: 52 }}
          >
            <Play size={16} strokeWidth={2.6} className="fill-current" />
            Lancer · ≈ {Math.max(1, Math.round((5 + rounds * tabata.travail + (rounds - 1) * tabata.repos) / 60))} min
          </button>
        </div>
      )}

      {/* actions secondaires */}
      <div className="mt-4 flex flex-wrap gap-2">
        {aVariantes && (
          <button
            onClick={() => surVariante(1)}
            aria-label={`Changer d'exercice (${variantes.length} variantes)`}
            className="h-10 px-3.5 rounded-full bg-carte2 text-xs font-bold text-douce flex items-center gap-1.5 active:scale-95 transi"
          >
            <ArrowLeftRight size={14} className="text-accent transi" />
            Variante {variantes.findIndex((e) => e.id === exo.id) + 1}/{variantes.length}
          </button>
        )}
        <button
          onClick={() => setTechnique(!technique)}
          aria-expanded={technique}
          className="h-10 px-3.5 rounded-full bg-carte2 text-xs font-bold text-douce flex items-center gap-1.5 active:scale-95 transi"
        >
          <Info size={14} className="text-accent transi" />
          Technique
          <ChevronDown size={13} className={`transi ${technique ? "rotate-180" : ""}`} />
        </button>
        {surRetirer && (
          <button
            onClick={surRetirer}
            aria-label={`Retirer ${exo.nom} de la séance`}
            className="h-10 px-3.5 rounded-full bg-carte2 text-xs font-bold text-brume flex items-center gap-1.5 active:scale-95 transi"
          >
            <Trash2 size={14} /> Retirer
          </button>
        )}
      </div>
      {aVariantes && (
        <p className="text-[11px] text-sourd mt-2 px-1">Glisse la carte sur le côté pour changer d’exercice.</p>
      )}

      {/* muscles toujours visibles ; consignes techniques dépliables */}
      <div className="mt-3 rounded-2xl bg-carte2 p-3 flex items-center gap-3">
        <SchemaMuscles muscles={exo.muscles || []} hauteur={technique ? 92 : 50} />
        <div className="flex-1 min-w-0">
          <p className="text-[10px] font-bold text-sourd uppercase tracking-wider">Muscles</p>
          <p className="text-xs text-douce mt-1 leading-snug">{muscles}</p>
        </div>
      </div>
      {technique && (exo.conseil || exo.variante) && (
        <div className="px-1 deplie">
          {exo.conseil ? <p className="text-[13px] text-douce mt-3 leading-relaxed">{exo.conseil}</p> : null}
          {exo.variante ? (
            <p className="text-xs text-brume mt-2 leading-relaxed italic">Variante : {exo.variante}</p>
          ) : null}
        </div>
      )}
    </div>
  );
}
