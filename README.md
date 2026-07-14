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

Notes : synchro « dernier écrit gagne » clé par clé, rafraîchie au lancement, au retour sur l'app et toutes les 45 s. L'endpoint `/api/etat` n'est pas authentifié — la confidentialité repose sur l'URL du déploiement (app personnelle).
