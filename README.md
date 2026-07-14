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

## Déploiement

Vercel : build `npm run build`, dossier de sortie `dist` (voir `vercel.json`). Le dossier `api/` est déployé automatiquement en fonctions serverless.

## Synchronisation entre téléphones (optionnel, gratuit)

Par défaut les données restent sur chaque appareil. Pour que les deux téléphones voient les mêmes données (séances validées, charges, programmes) :

1. Dashboard Vercel → projet **coachwork** → onglet **Storage** → **Create Database** → **Upstash** (Redis, plan gratuit) → **Connect** au projet.
2. Redéployer (onglet Deployments → ⋯ → Redeploy, ou pousser n'importe quel commit).
3. C'est tout : l'app détecte l'API et affiche un petit nuage ☁ en haut à droite. Sans base, elle reste en mode local.

Notes : synchro « dernier écrit gagne » clé par clé, rafraîchie au lancement, au retour sur l'app et toutes les 45 s.

## Code d'accès (recommandé si la synchro est activée)

Pour protéger les données maintenant que l'app est en ligne :

1. Dashboard Vercel → projet → **Settings** → **Environment Variables**.
2. Ajouter `COACHWORK_CODE` = le code de votre choix (ex. `2609`), tous les environnements.
3. **Redeploy**.

Au prochain lancement, l'app demande le code une seule fois par appareil (il reste mémorisé sur le téléphone, jamais synchronisé). L'API refuse toute lecture/écriture sans ce code : sans lui, un visiteur qui tombe sur l'URL ne voit qu'un écran de verrouillage. Pour changer le code : modifier la variable puis Redeploy — les téléphones redemanderont le nouveau code.

Sans `COACHWORK_CODE`, l'app fonctionne comme avant (pas d'écran de code).

## Un ami veut utiliser l'app ?

Chaque « duo » a son propre déploiement, ses propres données, son propre code :

1. L'ami se crée un compte GitHub + Vercel (gratuits), **fork** ce repo (bouton Fork sur GitHub), puis l'importe sur [vercel.com/new](https://vercel.com/new) — aucun réglage à changer.
2. En option : sa propre base Upstash (synchro) et son propre `COACHWORK_CODE`, comme ci-dessus.
3. Dans l'app, les prénoms se changent directement dans **Mes repères** (champ Prénom, un par profil) — pas besoin de toucher au code.

À savoir : les charges de départ conseillées et certains conseils (reprise à 54 ans…) ont été écrits pour Esteban & Valérie ; ils restent de bons ordres de grandeur pour des débutants, mais l'ami peut les ajuster dans `App.jsx` (dictionnaire `EXOS`) s'il veut personnaliser.

Ne partagez pas votre propre URL + code avec d'autres : tout le monde y écrirait dans les deux mêmes profils.
