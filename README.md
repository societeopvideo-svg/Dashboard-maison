# Dashboard Maison

Tableau de bord web pour une Homey Pro, pensé pour un iPad. Il est servi par GitHub Pages et ne contient aucune donnée personnelle : la clé d'accès, les photos et les réglages restent dans le navigateur de l'iPad. Les noms des appareils sont lus en direct dans la Homey.

## Pages

- Accueil : météo (station et prévisions Open-Meteo), confort, énergie (production, achat ou revente, coût du jour, courbe), présence, alertes.
- Volets : par zone et un par un, boutons et curseur de position, portail.
- Chauffage : mode du gainable, consigne et mode Programme ou Manuel par pièce.
- Énergie : détail du jour, du mois et de l'année, et ce qui consomme en ce moment.
- Éclairage et Prises : par pièce, avec confirmation pour les prises protégées.

## Mise en route

1. Dans l'app Homey, crée une clé API avec des droits limités (voir le guide fourni à part).
2. Ouvre le site dans Safari sur l'iPad, puis Partager > Sur l'écran d'accueil.
3. Ouvre l'app, touche la roue dentée, saisis l'adresse de la Homey et la clé, puis choisis un code et active Face ID.

## Structure

- `js/config.js` : rôle de chaque appareil (identifiants Homey uniquement)
- `js/api.js` : accès à l'API Homey et à Open-Meteo
- `js/app.js` : pages, réglages, verrou
- `js/icons.js` : icônes en trois styles
- `css/style.css` : thème clair (beige) et sombre (bleu nuit)
