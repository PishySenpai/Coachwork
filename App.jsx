import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Dumbbell, Check, ChevronLeft, ChevronDown, Flame, Timer, HeartPulse,
  Wind, Leaf, Moon, ShieldCheck, Sparkles, TrendingUp, X, Plus, Salad,
  Stethoscope, Scale, Ruler,
} from "lucide-react";

/* ------------------------------------------------------------------ */
/* Persistance : window.storage → IndexedDB → mémoire                  */
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

async function ecrire(cle, valeur) {
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

function lundiDe(iso) {
  const [a, m, j] = iso.split("-").map(Number);
  const d = new Date(a, m - 1, j);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return cleJour(d);
}

function semainesAvant(isoLundi, n) {
  const [a, m, j] = isoLundi.split("-").map(Number);
  return cleJour(new Date(a, m - 1, j - 7 * n));
}

/* ------------------------------------------------------------------ */
/* Profils & mesures                                                   */
/* ------------------------------------------------------------------ */

const PROFILS = {
  esteban: { nom: "Esteban", initiale: "E", detail: "Reprise en main" },
  valerie: { nom: "Valérie", initiale: "V", detail: "Reprise en douceur" },
};

const MESURES_DEFAUT = {
  esteban: { age: "29", taille: "170", poids: "79" },
  valerie: { age: "54", taille: "154", poids: "65" },
};

/* ------------------------------------------------------------------ */
/* Les exercices (partagés entre les deux programmes : la charge       */
/* notée sur un exercice suit dans tous les modes)                     */
/* ------------------------------------------------------------------ */

const EXOS = {
  presse: {
    id: "presse",
    nom: "Presse à cuisses",
    zone: "Jambes",
    series: 3,
    reps: "12",
    repos: 90,
    charge: { esteban: "Départ conseillé : 40–60 kg", valerie: "Départ conseillé : 15–25 kg" },
    variante: "Poids libres : goblet squat avec un haltère.",
    conseil:
      "Pieds à largeur d’épaules, descends jusqu’à 90° et pousse sans jamais verrouiller les genoux.",
  },
  "dev-poitrine": {
    id: "dev-poitrine",
    nom: "Développé poitrine assis",
    zone: "Poussée",
    series: 3,
    reps: "10",
    repos: 90,
    charge: { esteban: "Départ conseillé : 20–30 kg", valerie: "Départ conseillé : 7,5–12,5 kg" },
    variante: "Poids libres : développé haltères sur banc.",
    conseil: "Omoplates serrées contre le dossier, pousse en expirant, redescends en 2 secondes.",
  },
  "tirage-vertical": {
    id: "tirage-vertical",
    nom: "Tirage vertical",
    zone: "Tirage",
    series: 3,
    reps: "10",
    repos: 90,
    charge: { esteban: "Départ conseillé : 30–40 kg", valerie: "Départ conseillé : 15–20 kg" },
    variante: "Machine à tractions assistées si disponible.",
    conseil: "Tire la barre vers le haut de la poitrine, coudes vers le bas — pas derrière la nuque.",
  },
  "leg-curl": {
    id: "leg-curl",
    nom: "Leg curl assis",
    zone: "Jambes",
    series: 2,
    reps: "12",
    repos: 60,
    charge: { esteban: "Départ conseillé : 25–35 kg", valerie: "Départ conseillé : 10–15 kg" },
    variante: "Version allongée selon les machines de la salle.",
    conseil: "Fléchis en 1 seconde, retiens la remontée en 3 secondes. Les ischios adorent la lenteur.",
  },
  planche: {
    id: "planche",
    nom: "Planche",
    zone: "Gainage",
    series: 3,
    reps: "20–40 s",
    repos: 60,
    sansCharge: true,
    charge: { esteban: "Sur les avant-bras, corps aligné", valerie: "Sur les genoux au départ — parfait aussi" },
    variante: "Trop facile ? Décolle un pied 5 s de chaque côté.",
    conseil: "Serre les fessiers et le ventre, ne laisse pas le bas du dos se creuser.",
  },
  goblet: {
    id: "goblet",
    nom: "Goblet squat",
    zone: "Jambes",
    series: 3,
    reps: "12",
    repos: 90,
    charge: { esteban: "Haltère de 10–16 kg", valerie: "Haltère de 4–8 kg" },
    variante: "Genoux sensibles ce jour-là ? Repasse sur la presse à cuisses.",
    conseil: "Haltère serré contre la poitrine, dos droit, talons au sol. Descends comme pour t’asseoir.",
  },
  "dev-epaules": {
    id: "dev-epaules",
    nom: "Développé épaules assis",
    zone: "Poussée",
    series: 3,
    reps: "10",
    repos: 90,
    charge: { esteban: "Départ conseillé : 15–20 kg", valerie: "Départ conseillé : 5–10 kg" },
    variante: "Poids libres : développé avec deux haltères légers.",
    conseil: "Ne hausse pas les épaules vers les oreilles ; le mouvement reste fluide, sans à-coups.",
  },
  rowing: {
    id: "rowing",
    nom: "Rowing assis machine",
    zone: "Tirage",
    series: 3,
    reps: "12",
    repos: 90,
    charge: { esteban: "Départ conseillé : 30–40 kg", valerie: "Départ conseillé : 15–20 kg" },
    variante: "Ou tirage horizontal à la poulie basse.",
    conseil: "Poitrine contre le support, tire les coudes vers l’arrière et serre les omoplates 1 seconde.",
  },
  "hip-thrust": {
    id: "hip-thrust",
    nom: "Pont fessier (hip thrust)",
    zone: "Jambes",
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
  "dead-bug": {
    id: "dead-bug",
    nom: "Dead bug",
    zone: "Gainage",
    series: 3,
    reps: "8 / côté",
    repos: 60,
    sansCharge: true,
    charge: { esteban: "Bras et jambe opposés tendus", valerie: "Amplitude réduite au départ" },
    variante: "Trop facile ? Ralentis encore le mouvement.",
    conseil: "Bas du dos plaqué au sol du début à la fin. Souffle en allongeant bras et jambe.",
  },
  "souleve-roumain": {
    id: "souleve-roumain",
    nom: "Soulevé de terre roumain, haltères",
    zone: "Jambes",
    series: 3,
    reps: "12",
    repos: 90,
    charge: { esteban: "2 haltères de 10–14 kg", valerie: "2 haltères de 4–6 kg" },
    variante: "Ou leg curl si le geste n’est pas encore à l’aise.",
    conseil:
      "Pousse les hanches vers l’arrière, dos plat, haltères qui glissent le long des cuisses. Tu dois sentir l’arrière des jambes, jamais le bas du dos.",
  },
  pompes: {
    id: "pompes",
    nom: "Pompes mains surélevées",
    zone: "Poussée",
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
  "tirage-horizontal": {
    id: "tirage-horizontal",
    nom: "Tirage horizontal à la poulie",
    zone: "Tirage",
    series: 3,
    reps: "12",
    repos: 90,
    charge: { esteban: "Départ conseillé : 25–35 kg", valerie: "Départ conseillé : 12–17 kg" },
    variante: "Ou rowing un bras avec haltère, genou sur le banc.",
    conseil: "Buste droit et stable, tire la poignée vers le nombril sans te balancer.",
  },
  "leg-extension": {
    id: "leg-extension",
    nom: "Leg extension",
    zone: "Jambes",
    series: 2,
    reps: "15",
    repos: 60,
    charge: { esteban: "Départ conseillé : 20–30 kg", valerie: "Départ conseillé : 10–15 kg" },
    variante: "Réglage : le coussin repose juste au-dessus des chevilles.",
    conseil: "Monte en 1 seconde, redescends en 3. Léger et propre plutôt que lourd et saccadé.",
  },
  "planche-laterale": {
    id: "planche-laterale",
    nom: "Planche latérale",
    zone: "Gainage",
    series: 2,
    reps: "15–25 s / côté",
    repos: 60,
    sansCharge: true,
    charge: { esteban: "Sur l’avant-bras, pieds empilés", valerie: "Genoux posés — version parfaite pour démarrer" },
    variante: "Trop facile ? Lève le bras libre vers le plafond.",
    conseil: "Hanches hautes, corps en ligne droite des épaules aux pieds (ou aux genoux).",
  },
};

/* ------------------------------------------------------------------ */
/* Les deux programmes                                                 */
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

const PROGRAMMES = {
  fullbody: {
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
  split: {
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
};

const TOUTES_SEANCES = [...PROGRAMMES.fullbody.seances, ...PROGRAMMES.split.seances];

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
    titre: "Full body ou Haut / Bas ?",
    texte: [
      "Full body : chaque muscle travaille 3 fois par semaine — c’est le format le plus efficace pour débuter, apprendre les gestes et perdre du gras. Reste dessus au moins 4 à 6 semaines.",
      "Haut / Bas : plus de volume par zone et des séances plus ciblées — agréable quand le full body devient routinier. Les charges que tu as notées te suivent d’un mode à l’autre : ce sont les mêmes exercices, réorganisés. Dans les deux cas, 3 séances par semaine avec un jour de repos entre deux.",
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
/* Petits composants                                                   */
/* ------------------------------------------------------------------ */

function CaseCoche({ coche, surClic, taille = "h-12 w-12" }) {
  return (
    <button
      onClick={surClic}
      aria-pressed={coche}
      aria-label={coche ? "Marquer comme à faire" : "Marquer comme fait"}
      className={`${taille} shrink-0 rounded-full border-2 flex items-center justify-center transi ${
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

/* ------------------------------------------------------------------ */
/* Application                                                         */
/* ------------------------------------------------------------------ */

function etatVide() {
  const seances = {};
  for (const s of TOUTES_SEANCES) seances[s.id] = {};
  return { seances, charges: {}, historique: [], mode: "fullbody", mesures: { age: "", taille: "", poids: "" } };
}

export default function App() {
  const [profil, setProfil] = useState("esteban");
  const [chargement, setChargement] = useState(true);
  const [store, setStore] = useState({ esteban: etatVide(), valerie: etatVide() });
  const [onglet, setOnglet] = useState("semaine");
  const [ouverte, setOuverte] = useState(null); // id de séance ou null
  const [minuteur, setMinuteur] = useState(null); // {total, restant, label}
  const [fete, setFete] = useState(null); // {s, deja}

  /* ---- chargement initial ---- */
  useEffect(() => {
    let vivant = true;
    (async () => {
      const res = {};
      for (const p of ["esteban", "valerie"]) {
        const seances = {};
        await Promise.all(
          TOUTES_SEANCES.map(async (s) => {
            seances[s.id] = (await lireProfil(p, `seance:${s.id}`)) || {};
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
          mode: mode === "split" ? "split" : "fullbody",
          mesures: { ...MESURES_DEFAUT[p], ...(mesures || {}) },
        };
      }
      let pSauve = await lire("app:profil");
      if (pSauve === "maman") pSauve = "valerie";
      if (!vivant) return;
      setStore(res);
      if (pSauve === "valerie" || pSauve === "esteban") setProfil(pSauve);
      setChargement(false);
    })();
    return () => { vivant = false; };
  }, []);

  /* ---- minuteur de repos ---- */
  useEffect(() => {
    if (!minuteur || minuteur.restant <= 0) return;
    const t = setInterval(() => {
      setMinuteur((cur) => (cur ? { ...cur, restant: Math.max(0, cur.restant - 1) } : cur));
    }, 1000);
    return () => clearInterval(t);
  }, [minuteur !== null && minuteur.restant > 0]);

  const finie = minuteur !== null && minuteur.restant === 0;
  useEffect(() => {
    if (!finie) return;
    try { if (navigator.vibrate) navigator.vibrate([150, 90, 150]); } catch (e) {}
    const t = setTimeout(() => setMinuteur(null), 4000);
    return () => clearTimeout(t);
  }, [finie]);

  /* ---- scroll en haut quand on ouvre une séance ---- */
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [ouverte, onglet]);

  /* ---- mutations ---- */
  const donnees = store[profil];

  function choisirProfil(p) {
    setProfil(p);
    ecrire("app:profil", p);
  }

  function basculerEtape(sid, eid) {
    setStore((prev) => {
      const p = prev[profil];
      const checks = { ...(p.seances[sid] || {}), [eid]: !(p.seances[sid] || {})[eid] };
      ecrire(`${profil}:seance:${sid}`, checks);
      return { ...prev, [profil]: { ...p, seances: { ...p.seances, [sid]: checks } } };
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

  function terminerSeance(sid) {
    const auj = cleJour();
    const deja = donnees.historique.some((h) => h.s === sid && lundiDe(h.d) === lundiDe(auj));
    const historique = deja ? donnees.historique : [...donnees.historique, { s: sid, d: auj }];
    setStore({
      ...store,
      [profil]: { ...donnees, historique, seances: { ...donnees.seances, [sid]: {} } },
    });
    ecrire(`${profil}:assiduite`, { historique });
    ecrire(`${profil}:seance:${sid}`, {});
    setOuverte(null);
    setFete({ s: sid, deja, total: historique.length });
  }

  /* ---- statistiques d’assiduité ---- */
  const stats = useMemo(() => {
    const lundiActuel = lundiDe(cleJour());
    const parSemaine = new Map();
    for (const h of donnees.historique) {
      const w = lundiDe(h.d);
      if (!parSemaine.has(w)) parSemaine.set(w, new Set());
      parSemaine.get(w).add(h.s);
    }
    const cetteSemaine = parSemaine.get(lundiActuel) || new Set();
    let serie = 0;
    let w = parSemaine.has(lundiActuel) ? lundiActuel : semainesAvant(lundiActuel, 1);
    while (parSemaine.has(w)) { serie++; w = semainesAvant(w, 1); }
    const barres = [];
    for (let i = 5; i >= 0; i--) {
      const wk = semainesAvant(lundiActuel, i);
      barres.push({ semaine: wk, n: (parSemaine.get(wk) || new Set()).size });
    }
    return { total: donnees.historique.length, cetteSemaine, serie, barres };
  }, [store, profil]);

  /* ---- écran de chargement ---- */
  if (chargement) {
    return (
      <div data-profil={profil} className="min-h-screen bg-fond text-encre font-jakarta flex flex-col items-center justify-center gap-4">
        <Dumbbell size={40} className="text-accent pulsation" />
        <p className="text-brume text-sm">Chargement de vos séances…</p>
      </div>
    );
  }

  const seanceOuverte = TOUTES_SEANCES.find((s) => s.id === ouverte) || null;

  return (
    <div data-profil={profil} className="min-h-screen bg-fond text-encre font-jakarta">
      <div className="mx-auto max-w-md px-4 pb-32">

        {/* ---------- en-tête ---------- */}
        <header className="pt-5 pb-4">
          <div className="flex items-center gap-2.5">
            <span className="h-9 w-9 rounded-xl bg-accent flex items-center justify-center transi">
              <Dumbbell size={20} className="text-accent-ink" strokeWidth={2.5} />
            </span>
            <div>
              <h1 className="text-lg font-extrabold leading-none tracking-tight">Coachwork</h1>
              <p className="text-brume text-xs mt-0.5">3 séances / semaine, à deux</p>
            </div>
          </div>

          {/* sélecteur de profil */}
          <div className="mt-4 grid grid-cols-2 gap-2" role="group" aria-label="Choisir le profil">
            {Object.entries(PROFILS).map(([id, p]) => {
              const actif = profil === id;
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
                    {p.initiale}
                  </span>
                  {p.nom}
                </button>
              );
            })}
          </div>
        </header>

        {/* ---------- vue séance détaillée ---------- */}
        {seanceOuverte ? (
          <VueSeance
            seance={seanceOuverte}
            profil={profil}
            checks={donnees.seances[seanceOuverte.id] || {}}
            charges={donnees.charges}
            surRetour={() => setOuverte(null)}
            surCoche={(eid) => basculerEtape(seanceOuverte.id, eid)}
            surCharge={noterCharge}
            surRepos={(exo) => setMinuteur({ total: exo.repos, restant: exo.repos, label: exo.nom })}
            surFin={() => terminerSeance(seanceOuverte.id)}
          />
        ) : (
          <>
            {/* onglets */}
            <div className="grid grid-cols-2 gap-1 rounded-2xl bg-carte p-1 border border-ligne mb-5">
              {[["semaine", "Ma semaine"], ["conseils", "Conseils"]].map(([id, nom]) => (
                <button
                  key={id}
                  onClick={() => setOnglet(id)}
                  className={`h-11 rounded-xl text-sm font-bold transi ${
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
                surOuvrir={setOuverte}
                surMode={choisirMode}
                surMesure={noterMesure}
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
        <div className="fixed bottom-4 left-4 right-4 z-40 mx-auto max-w-md vue">
          <div className="rounded-2xl bg-carte border bordure-accent-douce p-4 shadow-lg">
            {minuteur.restant > 0 ? (
              <>
                <div className="flex items-center gap-3">
                  <Timer size={20} className="text-accent shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-xs text-brume truncate">Repos — {minuteur.label}</p>
                    <p className="text-2xl font-extrabold chiffres leading-tight">
                      {Math.floor(minuteur.restant / 60)}:{String(minuteur.restant % 60).padStart(2, "0")}
                    </p>
                  </div>
                  <button
                    onClick={() => setMinuteur((c) => c && { ...c, restant: c.restant + 30, total: c.total + 30 })}
                    className="h-11 px-3 rounded-xl bg-carte2 text-sm font-bold flex items-center gap-1 active:scale-95 transi"
                  >
                    <Plus size={16} /> 30 s
                  </button>
                  <button
                    onClick={() => setMinuteur(null)}
                    aria-label="Arrêter le repos"
                    className="h-11 w-11 rounded-xl bg-carte2 flex items-center justify-center active:scale-95 transi"
                  >
                    <X size={18} className="text-brume" />
                  </button>
                </div>
                <div className="mt-3 h-1.5 rounded-full bg-carte2 overflow-hidden">
                  <div
                    className="h-full rounded-full bg-accent barre"
                    style={{ width: `${(minuteur.restant / minuteur.total) * 100}%` }}
                  />
                </div>
              </>
            ) : (
              <div className="flex items-center gap-3">
                <Sparkles size={20} className="text-accent" />
                <p className="font-bold flex-1">Repos terminé — à toi !</p>
                <button
                  onClick={() => setMinuteur(null)}
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
            <h2 className="mt-5 text-2xl font-extrabold tracking-tight">
              Séance validée !
            </h2>
            <p className="mt-2 text-douce text-sm leading-relaxed">
              {fete.deja
                ? "Déjà comptée cette semaine — double dose, chapeau."
                : MESSAGES_FETE[fete.total % MESSAGES_FETE.length]}
            </p>
            <p className="mt-4 text-brume text-xs chiffres">
              {stats.total} séance{stats.total > 1 ? "s" : ""} au total · {stats.cetteSemaine.size}/3 cette semaine
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

function VueSemaine({ profil, stats, donnees, surOuvrir, surMode, surMesure }) {
  const p = PROFILS[profil];
  const programme = PROGRAMMES[donnees.mode];
  const dateFr = new Intl.DateTimeFormat("fr-FR", {
    weekday: "long", day: "numeric", month: "long",
  }).format(new Date());

  return (
    <div key={profil} className="vue space-y-5">
      <div>
        <p className="text-xs uppercase tracking-widest text-accent font-bold transi">{dateFr}</p>
        <h2 className="text-2xl font-extrabold tracking-tight mt-1">
          Salut {p.nom} !
        </h2>
        <p className="text-brume text-sm mt-1">{p.detail} — on avance à ton rythme.</p>
      </div>

      {/* assiduité */}
      <section className="rounded-3xl bg-carte border border-ligne p-5">
        <div className="flex items-center gap-5">
          <Anneau fait={Math.min(stats.cetteSemaine.size, 3)} total={3} />
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

      {/* type d'entraînement */}
      <section>
        <h3 className="text-xs uppercase tracking-widest text-brume font-bold mb-3">
          Mon type d’entraînement
        </h3>
        <div className="grid grid-cols-2 gap-1 rounded-2xl bg-carte p-1 border border-ligne">
          {Object.entries(PROGRAMMES).map(([id, prog]) => (
            <button
              key={id}
              onClick={() => surMode(id)}
              className={`h-11 rounded-xl text-sm font-bold transi ${
                donnees.mode === id ? "bg-accent text-accent-ink" : "text-brume"
              }`}
            >
              {prog.nom}
            </button>
          ))}
        </div>
        <p className="text-brume text-xs mt-2 leading-relaxed">{programme.description}</p>
      </section>

      {/* séances */}
      <section>
        <h3 className="text-xs uppercase tracking-widest text-brume font-bold mb-3">
          Mes 3 séances de la semaine
        </h3>
        <div className="space-y-3">
          {programme.seances.map((s) => {
            const faite = stats.cetteSemaine.has(s.id);
            const nChecks = Object.values(donnees.seances[s.id] || {}).filter(Boolean).length;
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
          Chaque séance dure 45 à 60 min.
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
/* Vue séance détaillée                                                */
/* ------------------------------------------------------------------ */

function VueSeance({ seance, profil, checks, charges, surRetour, surCoche, surCharge, surRepos, surFin }) {
  const etapes = [
    { id: "echauffement" },
    ...seance.exos.map((e) => ({ id: e.id })),
    { id: "cardio" },
    { id: "retour" },
  ];
  const nFait = etapes.filter((e) => checks[e.id]).length;
  const tout = nFait === etapes.length;

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
        {seance.exos.map((exo, i) => (
          <CarteExo
            key={exo.id}
            numero={i + 1}
            total={seance.exos.length}
            exo={exo}
            profil={profil}
            coche={!!checks[exo.id]}
            poids={charges[exo.id] || ""}
            surCoche={() => surCoche(exo.id)}
            surPoids={(v) => surCharge(exo.id, v)}
            surRepos={() => surRepos(exo)}
          />
        ))}

        {/* cardio */}
        <EtapeSimple
          icone={HeartPulse}
          etiquette="Cardio — 15 à 20 min"
          coche={!!checks["cardio"]}
          surCoche={() => surCoche("cardio")}
        >
          <p className="text-sm text-douce leading-relaxed">{seance.cardio[profil]}</p>
        </EtapeSimple>

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

      {/* valider */}
      <button
        onClick={surFin}
        disabled={!tout}
        className={`mt-6 w-full rounded-2xl font-extrabold text-base transi ${
          tout ? "bg-accent text-accent-ink active:scale-98" : "bg-carte text-brume"
        }`}
        style={{ height: 56 }}
      >
        {tout ? "Valider la séance" : `Encore ${etapes.length - nFait} étape${etapes.length - nFait > 1 ? "s" : ""} à cocher`}
      </button>
      <p className="text-brume text-center text-xs mt-3 leading-relaxed">
        Douleur articulaire vive ? On passe l’exercice, sans culpabiliser — voir Conseils.
      </p>
    </div>
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

function CarteExo({ numero, total, exo, profil, coche, poids, surCoche, surPoids, surRepos }) {
  return (
    <div className={`rounded-2xl bg-carte border p-4 transi ${coche ? "bordure-accent-douce" : "border-ligne"}`}>
      <div className="flex items-start gap-3">
        <div className={`flex-1 min-w-0 ${coche ? "opacity-60" : ""}`}>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-accent-soft text-accent transi">
              {exo.zone}
            </span>
            <span className="text-brume text-xs chiffres">Exo {numero}/{total}</span>
          </div>
          <h3 className="font-bold text-base mt-1.5 leading-snug">{exo.nom}</h3>
          <p className="text-sm mt-1 chiffres">
            <strong className="text-accent transi">{exo.series} × {exo.reps}</strong>
            <span className="text-brume"> · repos {exo.repos} s</span>
          </p>
          <p className="text-xs text-douce mt-1.5 leading-relaxed">{exo.charge[profil]}</p>
        </div>
        <CaseCoche coche={coche} surClic={surCoche} />
      </div>

      <div className={coche ? "opacity-50" : ""}>
        <p className="text-xs text-brume mt-3 leading-relaxed">{exo.conseil}</p>
        <p className="text-xs text-brume mt-1.5 leading-relaxed italic">Variante : {exo.variante}</p>

        <div className="mt-3 flex items-center gap-2">
          {!exo.sansCharge && (
            <label className="flex-1 flex items-center gap-2 rounded-xl bg-carte2 px-3" style={{ height: 48 }}>
              <span className="text-xs text-brume shrink-0">Charge utilisée</span>
              <input
                type="text"
                inputMode="decimal"
                value={poids}
                onChange={(e) => surPoids(e.target.value)}
                placeholder="—"
                className="w-full min-w-0 bg-transparent text-right font-extrabold chiffres text-base outline-none placeholder-slate-600"
                aria-label={`Charge utilisée pour ${exo.nom}`}
              />
              <span className="text-xs text-brume shrink-0">kg</span>
            </label>
          )}
          <button
            onClick={surRepos}
            className={`rounded-xl bg-carte2 px-4 font-bold text-sm flex items-center justify-center gap-2 active:scale-95 transi ${exo.sansCharge ? "flex-1" : "shrink-0"}`}
            style={{ height: 48 }}
          >
            <Timer size={17} className="text-accent transi" />
            Repos {exo.repos} s
          </button>
        </div>
      </div>
    </div>
  );
}
