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

Vercel : build `npm run build`, dossier de sortie `dist` (voir `vercel.json`).
