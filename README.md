# Coachwork 💪

Programme d'entraînement 3 séances/semaine pour Esteban & Valérie — deux modes (full body ou haut/bas), suivi des séances, des charges, des mesures et de l'assiduité. Mobile-first, en français.

## Développement

```bash
npm install
npm run build        # génère dist/index.html (autonome) + artifact.html
npx http-server dist -c-1
```

- Source unique : `App.jsx` (React, export par défaut).
- `fetch-fonts.mjs` régénère `fonts.css` (Plus Jakarta Sans en data URI) si besoin.
- Persistance : `window.storage` → repli IndexedDB → mémoire. Jamais localStorage.
- `node serveur-e2e.mjs` sert `dist/` **et** les fonctions `api/` avec un Redis simulé (port 4531) : pratique pour tester la synchro, les espaces et les codes sans rien déployer.

## Déploiement

Vercel : build `npm run build`, dossier de sortie `dist` (voir `vercel.json`). Le dossier `api/` est déployé automatiquement en fonctions serverless.

## Synchronisation entre téléphones (optionnel, gratuit)

Par défaut les données restent sur chaque appareil. Pour que les deux téléphones voient les mêmes données (séances validées, charges, programmes) :

1. Dashboard Vercel → projet **coachwork** → onglet **Storage** → **Create Database** → **Upstash** (Redis, plan gratuit) → **Connect** au projet.
2. Redéployer (onglet Deployments → ⋯ → Redeploy, ou pousser n'importe quel commit).
3. C'est tout : l'app détecte l'API et affiche un petit nuage ☁ en haut à droite. Sans base, elle reste en mode local.

Notes : synchro « dernier écrit gagne » clé par clé, rafraîchie au lancement, au retour sur l'app et toutes les 45 s.

## Espaces et code d'accès

Un **espace** = un groupe de personnes qui s'entraînent ensemble (un duo, une bande de potes).
Chaque espace a son nom, son code, ses profils, ses programmes et son historique.
**Rien n'est partagé entre deux espaces**, ni sur le serveur, ni sur le téléphone.

Au premier lancement, l'app demande de **rejoindre** un espace (nom + code) ou d'en **créer** un.
Le choix est mémorisé sur l'appareil ; le bouton nuage en haut à droite permet d'en changer.

- Les codes ne sont **jamais stockés en clair** : seul un hachage scrypt salé est conservé.
- Après 10 essais ratés, l'espace se ferme pendant 15 minutes.
- Un code doit faire au moins 4 caractères.

### Espace d'origine (migration)

Au premier lancement, l'app crée automatiquement l'espace **Principal** à partir des données
déjà en place. Les téléphones déjà installés l'adoptent tout seuls : rien à ressaisir.

- Si la variable `COACHWORK_CODE` existe, cet espace prend ce code.
- Sinon il reste **sans code** (comportement historique) et l'app propose, dans *Ma semaine*,
  un bouton **Protéger par un code** pour en poser un sans passer par Vercel.

Le code d'un espace se change ensuite depuis l'app (l'ancien code est exigé).

## Un ami veut utiliser l'app ?

Il ouvre **votre URL**, crée son propre espace (nom + code de son choix) et c'est tout.
Ses données sont totalement séparées des vôtres — plus besoin de forker ni de déployer.

Dans son espace, il compose ses profils librement (bouton **+ Profil**) : prénom, couleur,
et surtout un **niveau de charges** dans *Mes repères* — Standard, ou Tout en douceur
(charges plus légères, articulations ménagées). Ce niveau pilote les charges conseillées
affichées sur chaque exercice.

Ne partagez le code d'un espace qu'avec les gens qui doivent y écrire.

## Partager un programme d'un espace à l'autre

Les programmes sont rangés dans l'espace, donc invisibles ailleurs. Pour en passer un à quelqu'un :

1. Dans **Mon programme**, l'icône de partage sur un programme perso génère un **code à 6 caractères**.
2. La personne saisit ce code dans son espace (**Mon programme → Importer**).
3. Elle reçoit une **copie indépendante** : la modifier ne touche pas l'original, et inversement.

Les exercices maison utilisés par le programme voyagent avec lui (sinon il arriverait troué).
Un code vaut 30 jours et ne donne accès **qu'à ce programme** — jamais à un espace ni à ses données.