// Jeu d'icônes dessiné pour le dashboard, grille 24 x 24.
// "body" = la forme principale (pleine en style "solid" et "color"),
// "detail" = les traits intérieurs (évidés en style plein).

const ICONS = {
  home: {
    color: '#E3A869',
    body: '<path d="M3.5 10.6 12 3.6l8.5 7v9.1a.8.8 0 0 1-.8.8H15v-6h-6v6H4.3a.8.8 0 0 1-.8-.8z"/>',
    detail: '',
  },
  volet: {
    color: '#7FAEDB',
    body: '<rect x="4" y="3.5" width="16" height="17" rx="1.6"/>',
    detail: '<path d="M4 8h16M4 12h16M4 16h16"/>',
  },
  radiateur: {
    color: '#E27C64',
    body: '<rect x="3.5" y="5" width="17" height="12.5" rx="2"/>',
    detail: '<path d="M8 7.5v7.5M12 7.5v7.5M16 7.5v7.5"/><path class="out" d="M6 17.5v2.5M18 17.5v2.5"/>',
  },
  energie: {
    color: '#EFC155',
    body: '<path d="M13.2 2.8 5 13.6h6.1l-.9 7.6 8.3-10.9h-6.2z"/>',
    detail: '',
  },
  ampoule: {
    color: '#F3D27A',
    body: '<path d="M12 3a6.2 6.2 0 0 0-3.7 11.2c.7.5 1.1 1.3 1.1 2.1v.7h5.2v-.7c0-.8.4-1.6 1.1-2.1A6.2 6.2 0 0 0 12 3z"/>',
    detail: '<path class="out" d="M9.6 19.6h4.8M10.6 22h2.8"/>',
  },
  prise: {
    color: '#A7BCCD',
    body: '<circle cx="12" cy="12" r="9"/>',
    detail: '<circle cx="8.4" cy="12.6" r="1.35"/><circle cx="15.6" cy="12.6" r="1.35"/><path d="M12 6.4v2.6"/>',
  },
  reglages: {
    color: '#9AA8B8',
    body: '<path d="M10.3 3h3.4l.5 2.4 1.6.9 2.3-.8 1.7 2.9-1.8 1.6v1.9l1.8 1.6-1.7 2.9-2.3-.8-1.6.9-.5 2.4h-3.4l-.5-2.4-1.6-.9-2.3.8L4.2 15.5 6 13.9V12L4.2 10.4 5.9 7.5l2.3.8 1.6-.9z"/>',
    detail: '<circle cx="12" cy="12" r="2.6"/>',
  },
};

export const TABS = [
  { id: 'accueil', icon: 'home', label: 'Accueil' },
  { id: 'volets', icon: 'volet', label: 'Volets' },
  { id: 'chauffage', icon: 'radiateur', label: 'Chauffage' },
  { id: 'energie', icon: 'energie', label: 'Énergie' },
  { id: 'eclairage', icon: 'ampoule', label: 'Éclairage' },
  { id: 'prises', icon: 'prise', label: 'Prises' },
];

// style : 'line' (trait fin), 'solid' (plein), 'color' (couleur, façon emoji)
// active : en style trait, l'onglet actif passe en plein
export function icon(name, style = 'line', active = false) {
  const ic = ICONS[name];
  if (!ic) return '';
  const filled = style === 'solid' || style === 'color' || active;
  const fill = style === 'color' ? ic.color : 'currentColor';
  const stroke = style === 'color' ? shade(ic.color) : 'currentColor';
  const body = filled
    ? `<g fill="${fill}" stroke="${stroke}" stroke-width="1.4" stroke-linejoin="round">${ic.body}</g>`
    : `<g fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round">${ic.body}</g>`;
  // détails : évidés (couleur du fond) quand la forme est pleine, sauf les traits extérieurs
  const detail = ic.detail
    ? `<g fill="none" stroke-width="1.5" stroke-linecap="round" class="ic-detail ${filled ? 'on-fill' : ''}" style="--ic-out:${stroke}">${ic.detail}</g>`
    : '';
  return `<svg class="ic ic-${style}" viewBox="0 0 24 24" aria-hidden="true">${body}${detail}</svg>`;
}

function shade(hex) {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.round(((n >> 16) & 255) * 0.62);
  const g = Math.round(((n >> 8) & 255) * 0.62);
  const b = Math.round((n & 255) * 0.62);
  return `rgb(${r},${g},${b})`;
}
