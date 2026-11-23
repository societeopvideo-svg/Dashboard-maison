import { CONFIG as C, DEFAUTS } from './config.js?v=20261123p';
import { Homey, forecast, geocode, actualites, previsions } from './api.js?v=20261123p';
import { icon, TABS } from './icons.js?v=20261123p';

/* ---------- Stockage local (iPad uniquement) ---------- */
const LS = 'maison.v1.';
const store = {
  get(k, d) { try { const v = localStorage.getItem(LS + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(LS + k, JSON.stringify(v)); return true; } catch { return false; } },
};

let S = { ...DEFAUTS, ...store.get('settings', {}) };
let lock = store.get('lock', { hash: null, salt: null, cred: null });
const saveSettings = () => { if (!store.set('settings', S)) toast('Mémoire de l’iPad pleine : réglage non enregistré'); };
const saveSettings2 = () => store.set('settings', S);

const st = {
  devices: {}, zones: {}, users: {},
  ok: false, err: null, wx: null, wxAt: 0, curve: ((c) => (c && c.jour === new Date().toDateString() ? c : null))(store.get('courbeJour2', null)), curveAt: 0,
  tab: store.get('tab', 'accueil'), lastTouch: 0, sheet: false, unlockedUntil: 0,
  lastReq: store.get('lastReq', {}), garageSince: store.get('garageSince', null),
};
let homey = new Homey(S.homeyUrl, S.cle, S.homeyCloud);
const CAMS = C.cameras || C.alertes?.cameras || [];

/* ---------- Outils ---------- */
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nf = (v, d = 1) => (v == null || Number.isNaN(Number(v)) ? '–' : Number(v).toLocaleString('fr-FR', { minimumFractionDigits: d, maximumFractionDigits: d }));
const watts = (v) => (v == null ? '–' : v >= 1000 ? `${nf(v / 1000, 2)}<span class="unit">kW</span>` : `${nf(v, 0)}<span class="unit">W</span>`);
const dev = (id) => st.devices[id];
const cap = (id, c) => st.devices[id]?.capabilitiesObj?.[c]?.value;
const has = (id, c) => Boolean(st.devices[id]?.capabilitiesObj?.[c]);
const nm = (id) => (dev(id)?.name || '').replace(/\s+/g, ' ').trim();
const zoneName = (zid) => (st.zones[zid]?.name || '').trim();
const excluded = (d) => C.exclureZones.includes(d.zone) || C.exclureAppareils.includes(d.id);
const visible = () => Object.values(st.devices).filter((d) => !excluded(d));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const pct = (v) => Math.round(clamp(v, 0, 1) * 100);

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove('show'), 2600);
}

function setLocal(id, c, v) {
  const o = st.devices[id]?.capabilitiesObj?.[c];
  if (o) { o.value = v; o.lastUpdated = new Date().toISOString(); }
}

async function send(id, c, v, { optimistic = true } = {}) {
  const before = cap(id, c);
  if (optimistic) { setLocal(id, c, v); render(); }
  try {
    await homey.setCapability(id, c, v);
    if (injoignables[id]) { delete injoignables[id]; store.set('injoignables', injoignables); }
  } catch (e) {
    // Lampe sans courant (coupée à l'interrupteur) : la Homey répond mais l'appareil ne répond pas
    const absent = e.status !== 403 && /atteint|joignable|reach|respond|offline|timeout/i.test(String(e.detail || ''));
    if (absent) {
      injoignables[id] = Date.now(); store.set('injoignables', injoignables);
      render();
      toast(`${nm(id)} ne répond pas : sans doute coupée à l’interrupteur`);
      throw e;
    }
    setLocal(id, c, before);
    render();
    toast(e.status === 403 ? 'La clé n’a pas le droit de commander cet appareil' : 'Commande non envoyée, Homey injoignable');
    throw e;
  }
}

// Appareils qui n'ont pas répondu à la dernière commande (gardé sur l'iPad).
// Ils redeviennent normaux dès que la Homey reçoit un nouvel état de leur part.
const injoignables = store.get('injoignables', {});
function estInjoignable(d) {
  const t = injoignables[d.id];
  if (!t) return false;
  const maj = Date.parse(d.capabilitiesObj?.onoff?.lastUpdated || '');
  if (maj && maj > t + 5000) { delete injoignables[d.id]; store.set('injoignables', injoignables); return false; }
  return true;
}

/* ---------- Thème clair / sombre ---------- */
// auto = suit l'iPad ; light / dark = choisi à la main dans les réglages
function applyTheme() {
  const t = S.theme || 'auto';
  const root = document.documentElement;
  if (t === 'auto') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', t);
  const sombre = t === 'dark' || (t === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => { m.removeAttribute('media'); m.setAttribute('content', sombre ? '#0F1B2D' : '#F4EEE3'); });
}
applyTheme();
let saisonVue = saison();
const etatSoiree = () => C.presence.map((id) => enSoiree(S.avatars[id] || {})).join();
let soirVu = etatSoiree();
setInterval(() => {
  const soir = etatSoiree();
  if (saison() !== saisonVue || soir !== soirVu) { saisonVue = saison(); soirVu = soir; render(); }
}, 60e3);
try { matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme); } catch { /* ancien Safari */ }

/* ---------- Horloge ---------- */
function tick() {
  const d = new Date();
  $('#time').textContent = d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  const txt = d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
  $('#date').textContent = txt.charAt(0).toUpperCase() + txt.slice(1);
}

function setStatus() {
  const s = $('#status');
  s.className = 'status ' + (!homey.ready ? '' : st.ok ? (homey.distance ? 'ok dist' : 'ok') : 'err');
  s.title = !homey.ready ? 'Non configuré' : st.ok ? (homey.distance ? 'Homey connectée à distance (cloud)' : 'Homey connectée à la maison') : 'Homey injoignable';
}

/* ---------- Données ---------- */
async function refresh() {
  if (!homey.ready) { setStatus(); return; }
  try {
    st.devices = await homey.devices();
    st.ok = true; st.err = null;
    trackGarage();
    idxSample();
    sample();
    liveSample();
    wakeOnMotion();
  } catch (e) {
    st.ok = false; st.err = e;
  }
  setStatus();
  maybeRender();
}

async function refreshSlow() {
  if (!homey.ready) return;
  try { st.zones = await homey.zones(); } catch { /* sans les zones, les noms de pièces manquent */ }
  try { st.users = await homey.users(); } catch { st.users = {}; }
  maybeRender();
}

async function refreshWeather(force = false) {
  if (S.lat == null || S.lon == null) { st.wx = null; return; }
  if (!force && Date.now() - st.wxAt < 30 * 60e3) return;
  try { st.wx = await forecast(S.lat, S.lon); st.wxAt = Date.now(); maybeRender(); } catch { /* garde l'ancienne */ }
}

async function refreshCurve(force = false) {
  if (!homey.ready || (!force && Date.now() - st.curveAt < 5 * 60e3)) return;
  st.curveAt = Date.now();
  // Selon la version de Homey, la puissance est enregistrée sous measure_power ou energy_power
  // Historique enregistré par la Homey depuis minuit : continu même quand l'iPad était en veille
  const hist = async (id, caps) => { for (const c of caps) { const r = await homey.insights(id, c, 'today'); if (r && r.length) return r; } return null; };
  const P = ['measure_power', 'energy_power'];
  const [sol, impI, expo, achatVA, injVA] = await Promise.all([
    hist(C.energie.solaire, P),
    hist(C.energie.linky, ['meter_power.imported']),
    hist(C.energie.linky, ['meter_power.exported']),
    hist(C.energie.linky, P),
    hist(C.energie.linky, ['apparent_power_instant_inject_capability']),
  ]);
  // vraie puissance achetée / revendue = vitesse des index (la puissance apparente surestime l'achat)
  const achat = impI?.length > 1 ? deriveW(impI) : achatVA;
  const inj = expo?.length > 1 ? deriveW(expo) : injVA;
  // on garde la dernière courbe connue (et sur l'iPad) : elle reste affichée en permanence
  // Mémoire du jour : on fusionne avec ce qui était déjà gardé, la courbe ne fait que s'allonger.
  // Si la Homey ne répond pas (hors connexion, droit manquant), la courbe gardée reste affichée.
  const jour = new Date().toDateString();
  const old = st.curve && st.curve.jour === jour ? st.curve : null;
  if (sol && achat) {
    st.curve = { sol: unirPts(old?.sol, sol), achat: unirPts(old?.achat, achat), inj: unirPts(old?.inj, inj || []), exp0: old?.exp0 ?? expo?.[0]?.v ?? null, jour };
    store.set('courbeJour2', st.curve);
  }
  st.curveErr = sol && achat ? null : homey.insightsErr || 'vide';
  maybeRender();
}

// Fusion de deux séries (même créneau : la valeur la plus récente gagne), triée par heure
function unirPts(a, b) {
  const m = new Map();
  (a || []).forEach((p) => m.set(p.t, p));
  (b || []).forEach((p) => m.set(p.t, p));
  return [...m.values()].sort((x, y) => x.t - y.t);
}
// Jour local (et non UTC : entre minuit et 1 h, l'UTC est encore la veille)
const jourLocal = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// Relevés de l'iPad, une fois par minute, gardés toute la journée : ils servent
// si l'historique Homey n'est pas lisible
function sample() {
  const now = Date.now();
  const key = 'samples.' + jourLocal();
  const arr = store.get(key, []);
  if (arr.length && now - arr[arr.length - 1].t < 60e3) return;
  const e = energyNow();
  if (e.prod == null && e.achat == null) return;
  arr.push({ t: now, p: e.prod ?? 0, a: e.achat ?? 0, r: e.revente ?? 0 });
  store.set(key, arr.slice(-1500));
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    const hierK = LS + 'samples.' + jourLocal(new Date(now - 864e5));
    if (k && k.startsWith(LS + 'samples.') && k !== LS + key && k !== hierK) localStorage.removeItem(k);
  }
}

function trackGarage() {
  const closed = cap(C.portail.capteur, 'garagedoor_closed');
  if (closed === false && !st.garageSince) st.garageSince = Date.now();
  if (closed === true) st.garageSince = null;
  store.set('garageSince', st.garageSince);
}

/* Mise à jour sans clignotement : on compare la nouvelle page à l'ancienne et on ne touche
   qu'aux éléments qui changent. Une image dont l'adresse ne change pas n'est jamais recréée. */
let derniereVue = '';
function majDOM(cible, html) {
  if (html === derniereVue && cible.childNodes.length) return;
  derniereVue = html;
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  fusion(cible, tpl.content);
}
function fusion(ancien, nouveau) {
  const a = [...ancien.childNodes], n = [...nouveau.childNodes];
  for (let i = 0; i < n.length; i++) {
    const x = a[i], y = n[i];
    if (!x) { ancien.appendChild(y); continue; }
    if (x.nodeType !== y.nodeType || x.nodeName !== y.nodeName) { ancien.replaceChild(y, x); continue; }
    if (x.nodeType === 3 || x.nodeType === 8) { if (x.nodeValue !== y.nodeValue) x.nodeValue = y.nodeValue; continue; }
    if (x.nodeType !== 1) continue;
    // attributs
    for (const at of [...x.attributes]) if (!y.hasAttribute(at.name)) x.removeAttribute(at.name);
    for (const at of [...y.attributes]) if (x.getAttribute(at.name) !== at.value) x.setAttribute(at.name, at.value);
    // valeur des curseurs et champs (la propriété ne suit pas toujours l'attribut)
    if ((x.nodeName === 'INPUT' || x.nodeName === 'SELECT') && document.activeElement !== x && 'value' in y && x.value !== y.value) x.value = y.value;
    if (x.nodeName === 'IMG' || x.nodeName === 'VIDEO') continue; // jamais recréer une image
    fusion(x, y);
  }
  // éléments en trop
  for (let i = a.length - 1; i >= n.length; i--) if (a[i].parentNode === ancien) ancien.removeChild(a[i]);
}

function maybeRender() {
  if (st.sheet || Date.now() - st.lastTouch < 3500) return;
  render();
}

/* ---------- Achat / revente réels ---------- */
// La puissance « measure_power » du Linky est apparente (VA) : avec l'onduleur de la batterie elle reste
// vers 600 VA même quand on n'achète presque rien. La vraie puissance se lit dans la vitesse à laquelle
// avancent les index d'achat et de revente (précis au Wh). Fenêtre adaptative : au moins 5 Wh d'écart
// ou 5 minutes au plus, 30 s au moins.
const idx = { imp: [], exp: [] };
const SEUIL_RESEAU = 50; // en dessous : réseau au repos (comme l'app SolaX)
function idxSample() {
  const t = Date.now();
  [['imp', 'meter_power.imported'], ['exp', 'meter_power.exported']].forEach(([k, c]) => {
    const v = cap(C.energie.linky, c);
    if (typeof v !== 'number') return;
    const a = idx[k];
    if (!a.length || a[a.length - 1].v !== v || t - a[a.length - 1].t > 30e3) a.push({ t, v });
    while (a.length && t - a[0].t > 6 * 60e3) a.shift();
  });
}
function idxPower(a) {
  if (a.length < 2) return null;
  const fin = a[a.length - 1], now = Date.now();
  if (now - a[0].t < 30e3) return null; // pas encore assez de recul
  // on remonte jusqu'à avoir 5 Wh d'écart (ou le plus vieux relevé, 5 min max)
  let deb = a[0];
  for (let i = a.length - 2; i >= 0; i--) { deb = a[i]; if ((fin.v - a[i].v) * 1000 >= 5 && now - a[i].t >= 30e3) break; }
  const dt = (now - deb.t) / 36e5; // en heures, jusqu'à maintenant (l'index n'a pas bougé depuis le dernier relevé)
  const w = dt > 0 ? Math.max(0, ((fin.v - deb.v) * 1000) / dt) : null;
  return w != null && w > 15000 ? null : w; // valeur impossible (compteur 9 kVA) : on l'ignore
}
// Au démarrage, les 6 dernières minutes d'index sont lues dans l'historique de la Homey
async function seedIdx() {
  if (!homey.ready) return;
  for (const [k, c] of [['imp', 'meter_power.imported'], ['exp', 'meter_power.exported']]) {
    const r = await homey.insights(C.energie.linky, c, 'lastHour');
    if (!r?.length) continue;
    const t0 = Date.now() - 6 * 60e3;
    const pts = r.filter((p) => p.t >= t0);
    // l'historique doit coller à l'index actuel (sinon ce n'est pas le bon journal) : moins de 0,5 kWh d'écart
    const now = cap(C.energie.linky, k === 'imp' ? 'meter_power.imported' : 'meter_power.exported');
    if (!pts.length || typeof now !== 'number' || Math.abs(now - pts[pts.length - 1].v) > 0.5) continue;
    idx[k] = [...pts, ...idx[k].filter((p) => !pts.length || p.t > pts[pts.length - 1].t)];
  }
  maybeRender();
}
// Historique d'un index (kWh) → puissance moyenne sur chaque intervalle (W)
function deriveW(pts) {
  const out = [];
  for (let i = 1; i < pts.length; i++) {
    const dt = (pts[i].t - pts[i - 1].t) / 36e5;
    if (dt <= 0) continue;
    out.push({ t: pts[i].t, v: Math.max(0, ((pts[i].v - pts[i - 1].v) * 1000) / dt) });
  }
  return out;
}

/* ---------- Calculs énergie ---------- */
function energyNow() {
  const hoy = cap(C.energie.solaire, 'measure_power');
  const fhe = hoy == null ? null : hoy * S.coefFHE;
  const prod = hoy == null ? null : hoy + fhe;
  // achat / revente réels (index du Linky) ; à défaut, les anciennes mesures
  const pImp = idxPower(idx.imp), pExp = idxPower(idx.exp);
  const brutA = pImp ?? cap(C.energie.linky, 'measure_power');
  const brutR = pExp ?? (cap(C.energie.linky, 'apparent_power_instant_inject_capability') || 0);
  // sur une même fenêtre, le compteur ne fait que l'un ou l'autre : on garde le solde
  const achat = brutA == null ? null : Math.max(0, brutA - brutR);
  const revente = Math.max(0, brutR - (brutA ?? 0));
  const kwhJour = cap(C.energie.compteur, 'meter_kwh_this_day');
  const aboJour = (S.aboMois * 12) / 365;
  const cout = kwhJour == null ? null : kwhJour * S.prixKwh + aboJour;
  const auto = prod && prod > 50 ? clamp((prod - revente) / prod, 0, 1) : null;
  const prodJour = cap(C.energie.solaire, 'meter_power.today');
  // Part de la consommation de la maison couverte par le solaire (100 % = aucun achat)
  const conso = prod == null || achat == null ? null : Math.max(0, prod - revente) + achat;
  const couv = conso && conso > 50 ? clamp(Math.max(0, prod - revente) / conso, 0, 1) : null;
  // Batterie SolaX : > 0 = elle se charge (elle prend de l'énergie), < 0 = elle alimente la maison
  const batt = cap(C.energie.batterie, 'measure_power');
  const battPct = cap(C.energie.batterie, 'measure_battery');
  // Ce que la maison consomme vraiment : réseau + panneaux − surplus envoyé − ce qui part dans la batterie
  const maison = prod == null || achat == null ? null : Math.max(0, achat + prod - revente - (batt ?? 0));
  return { hoy, fhe, prod, achat, revente, couv, conso, maison, batt, battPct, kwhJour, aboJour, cout, auto, prodJourKwh: prodJour == null ? null : prodJour * (1 + S.coefFHE) };
}

/* ---------- Alertes ---------- */
function nobodyHome() {
  const vals = C.presence.map((id) => cap(id, 'presence'));
  return vals.length > 0 && vals.every((v) => v === false);
}

function alerts() {
  const out = [];
  const A = C.alertes;
  if (cap(A.fumee, 'alarm_smoke') === true) out.push({ lvl: 'alert', txt: 'Fumée détectée', sub: nm(A.fumee), fire: true });
  const cp = coupureReseau();
  if (cp) out.push({ lvl: 'alert', txt: 'Coupure du réseau électrique', sub: `La batterie alimente la maison (${nf(cap(C.energie.batterie, 'measure_battery'), 0)} %)`, when: cp.depuis ? `depuis ${hhmm(cp.depuis)}` : '', tab: 'energie' });
  if (st.garageSince && Date.now() - st.garageSince > A.portailMinutes * 60e3) {
    out.push({ lvl: 'warn', txt: 'Portail du garage ouvert', when: `depuis ${Math.round((Date.now() - st.garageSince) / 60e3)} min`, tab: 'volets' });
  }
  const vide = nobodyHome();
  if (vide) {
    A.baies.forEach((id) => { if (cap(id, 'alarm_contact') === true) out.push({ lvl: 'warn', txt: `${nm(id)} : ouverte`, sub: 'Maison vide' }); });
    A.cameras.forEach((id) => { if (cap(id, 'alarm_motion') === true) out.push({ lvl: 'warn', txt: `Mouvement : ${nm(id)}`, sub: 'Maison vide' }); });
  }
  visible().forEach((d) => {
    const b = d.class === 'battery' ? null : d.capabilitiesObj?.measure_battery?.value; // batterie maison : pas une pile
    if (typeof b !== 'number') return;
    if (b < A.batterie.urgente) out.push({ lvl: 'warn', txt: 'Pile à remplacer maintenant', sub: `${nm(d.id)} · ${b} %` });
    else if (b < A.batterie.faible) out.push({ lvl: 'info', txt: 'Pile à prévoir', sub: `${nm(d.id)} · ${b} %` });
  });
  return out;
}

/* ---------- Rendu ---------- */
function renderTabs() {
  const style = S.iconStyle;
  const nav = $('#tabs');
  nav.className = `tabs style-${style}`;
  nav.innerHTML = TABS.map((t) => `<button data-act="tab" data-id="${t.id}" class="${st.tab === t.id ? 'on' : ''}" aria-label="${t.label}">${icon(t.icon, style, st.tab === t.id && style === 'line')}</button>`).join('');
  $('#btn-settings').innerHTML = icon('reglages', style === 'color' ? 'color' : 'line');
  if (!$('#btn-refresh').classList.contains('turn')) $('#btn-refresh').innerHTML = icon('actualiser', 'line');
}

function render() {
  renderTabs();
  const v = $('#view');
  if (!homey.ready) { v.innerHTML = viewSetup(); return; }
  if (!Object.keys(st.devices).length) {
    v.innerHTML = `<div class="empty">${st.err ? 'Homey injoignable. Vérifie que l’iPad est sur le Wi-Fi de la maison, puis l’adresse dans les réglages.' : 'Connexion à la Homey…'}</div>`;
    return;
  }
  const views = { accueil: viewHome, volets: viewBlinds, chauffage: viewHeat, energie: viewEnergy, conso: viewConso, eclairage: viewLights, prises: viewPlugs };
  if (st.tab === 'conso') refreshConso();
  try { majDOM(v, (views[st.tab] || viewHome)()); }
  catch (e) { v.innerHTML = `<div class="empty">Erreur d’affichage : ${esc(e.message)}<br>Recharge la page (Cmd + Maj + R). Si ça persiste, envoie ce message.</div>`; console.error(e); return; }
  const fire = alerts().find((a) => a.fire);
  let f = $('#fire');
  if (fire && !f) { f = document.createElement('div'); f.id = 'fire'; f.className = 'fire'; document.body.appendChild(f); }
  if (f) { if (fire) f.innerHTML = `<div>Fumée détectée<div class="small" style="font-weight:400;margin-top:12px">${esc(fire.sub)}</div></div>`; else f.remove(); }
  paintRanges();
}


function paintRanges() {
  document.querySelectorAll('input[type=range]').forEach((r) => r.style.setProperty('--p', `${((r.value - r.min) / (r.max - r.min)) * 100}%`));
}

function viewSetup() {
  return `<div class="setup card">
    <h1>Bienvenue</h1>
    <p class="muted">Pour afficher la maison, le dashboard a besoin de l’adresse de ta Homey et d’une clé d’accès. Touche la roue dentée en haut à droite.</p>
    <button class="btn primary wide" data-act="settings">Ouvrir les réglages</button>
  </div>`;
}

/* Accueil */
const WX = (c) => (c === 0 ? '☀️' : c <= 2 ? '🌤️' : c === 3 ? '☁️' : c <= 48 ? '🌫️' : c <= 67 ? '🌧️' : c <= 77 ? '❄️' : c <= 82 ? '🌦️' : '⛈️');
const DIR = (a) => (a == null ? '' : ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'][Math.round(a / 45) % 8]);

// Distance en km entre deux points (pour savoir si la commune affichée est celle de la maison)
function distanceKm(a, b) {
  const R = 6371, rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
const communeMaison = () => S.lat == null || S.lon == null || !C.maison || distanceKm({ lat: S.lat, lon: S.lon }, C.maison) < 6;

function cardWeather() {
  const M = C.meteo;
  const chezNous = communeMaison();
  const cur = st.wx?.current;
  // Mesures : capteurs Netatmo de la maison, ou météo locale de la commune choisie
  const v = chezNous
    ? { t: cap(M.exterieur, 'measure_temperature'), hum: cap(M.exterieur, 'measure_humidity'), vent: cap(M.vent, 'measure_wind_strength'), dir: cap(M.vent, 'measure_wind_angle'), raf: cap(M.vent, 'measure_gust_strength'), pluie: cap(M.pluie, 'measure_rain.24h'), pres: cap(M.station, 'measure_pressure'), src: 'Station de la maison' }
    : { t: cur?.temperature_2m, hum: cur?.relative_humidity_2m, vent: cur?.wind_speed_10m, dir: cur?.wind_direction_10m, raf: cur?.wind_gusts_10m, pluie: st.wx?.daily?.precipitation_sum?.[0], pres: cur?.pressure_msl, code: cur?.weather_code, src: 'Météo locale (Open-Meteo)' };
  let fc = '<p class="small muted" style="margin:16px 0 0">Indique la commune dans les réglages pour afficher les prévisions.</p>';
  if (st.wx?.daily) {
    const d = st.wx.daily;
    fc = '<div class="forecast">' + [0, 1, 2].map((i) => {
      const label = i === 0 ? 'Aujourd’hui' : new Date(d.time[i]).toLocaleDateString('fr-FR', { weekday: 'long' });
      return `<div><span style="text-transform:capitalize">${label}</span><span class="wx">${WX(d.weather_code[i])}</span><b>${nf(d.temperature_2m_max[i], 0)}°</b> · ${nf(d.temperature_2m_min[i], 0)}°<br><span class="small">pluie ${nf(d.precipitation_probability_max[i], 0)} %</span></div>`;
    }).join('') + '</div>';
  }
  return `<div class="card">
    <h2>Météo · <button class="wx-place" data-act="meteo">${esc(S.commune || 'Choisir une ville')} <span class="wx-chev">▾</span></button></h2>
    <div class="meteo-body"><div class="meteo-now">
      <div class="big">${!chezNous && v.code != null ? `<span class="wx-now">${WX(v.code)}</span>` : ''}${nf(v.t, 1)}<span class="unit">°C</span></div>
      <div class="meteo-facts">
        <span>Humidité</span><b>${nf(v.hum, 0)} %</b>
        <span>Vent</span><b>${nf(v.vent, 0)} km/h ${DIR(v.dir)}</b>
        <span>Rafales</span><b>${nf(v.raf, 0)} km/h</b>
        <span>Pluie 24 h</span><b>${nf(v.pluie, 1)} mm</b>
        <span>Pression</span><b>${nf(v.pres, 0)} hPa</b>
      </div>
    </div>${fc}<p class="meteo-src">${v.src}</p></div>
  </div>`;
}

function cardComfort() {
  const rows = C.chauffage.zones.map((z) => {
    const manuel = cap(z.id, 'cozytouch_heating_mode') === 'manual';
    const co2 = z.co2 ? cap(z.co2, 'measure_co2') : null;
    const off = cap(z.id, 'onoff') === false;
    const tags = [manuel ? '<span class="tag accent">Manuel</span>' : '', co2 && co2 > C.alertes.co2 ? `<span class="tag warn">Aérer · ${nf(co2, 0)} ppm</span>` : '', off ? '<span class="tag">Arrêt</span>' : ''].join(' ');
    return `<div>${esc(nm(z.id))} ${tags}</div><div class="t">${nf(cap(z.id, 'measure_temperature'), 1)}°</div><div class="c">${off ? '' : '→ ' + nf(cap(z.id, 'target_temperature'), 1) + '°'}</div>`;
  }).join('');
  return `<div class="card tap" data-act="tab" data-id="chauffage"><h2>Confort</h2><div class="temps">${rows}</div></div>`;
}

function curveSeries() {
  // Journée de minuit à minuit
  const day0 = new Date(); day0.setHours(0, 0, 0, 0);
  const t0 = day0.getTime(), t1 = t0 + 864e5;
  // la courbe gardée d'hier ne sert plus après minuit
  if (st.curve && st.curve.jour && st.curve.jour !== day0.toDateString()) st.curve = null;
  const k = 1 + S.coefFHE;
  // Autoconsommation = production − ce qui part sur le réseau (injection Linky)
  const near = (arr, t) => { let best = null, d = 6 * 60e3; for (const p of arr) { const x = Math.abs(p.t - t); if (x < d) { d = x; best = p; } } return best ? best.v : 0; };
  if (st.curve) {
    // L'historique Homey fait des moyennes sur 5 min : quand un nuage passe, le même créneau
    // contient un peu d'achat ET un peu d'injection. Le compteur ne peut pas faire les deux
    // à la fois : on garde seulement le solde du créneau.
    const inj = st.curve.inj;
    // dès qu'il y a du surplus envoyé au réseau sur un créneau, il n'y a pas d'achat (comme Ecojoko)
    const achat = st.curve.achat.map((p) => { const i = near(inj, p.t); return { t: p.t, v: i > 20 ? 0 : Math.max(0, p.v - i) }; });
    const injNet = st.curve.achat.length ? inj.map((p) => ({ t: p.t, v: Math.max(0, p.v - near(st.curve.achat, p.t)) })) : inj;
    const prodH = st.curve.sol.map((p) => ({ t: p.t, v: p.v * k }));
    const autoH = prodH.map((p) => ({ t: p.t, v: Math.max(0, p.v - near(injNet, p.t)) }));
    // en continu : on prolonge avec les relevés des dernières minutes, jusqu'à maintenant
    const prod = prolonge(prodH, directE.map((x) => ({ t: x.t, v: x.p })));
    const auto = prolonge(autoH, directE.map((x) => ({ t: x.t, v: Math.max(0, x.p - x.r) })));
    const achatC = prolonge(achat, directE.map((x) => ({ t: x.t, v: x.r > 20 ? 0 : x.a })));
    const dans = (l) => l.filter((p) => p.t >= t0);
    return { day0, t0, t1, prod: dans(prod), auto: dans(auto), achat: dans(achatC), src: 'Homey' };
  }
  const arr = store.get('samples.' + jourLocal(), []).filter((x) => x.t >= t0);
  if (arr.length < 3) return null;
  return { day0, t0, t1, prod: arr.map((s) => ({ t: s.t, v: s.p })), auto: arr.map((s) => ({ t: s.t, v: Math.max(0, s.p - (s.r || 0)) })), achat: arr.map((s) => ({ t: s.t, v: s.a })), src: 'iPad' };
}

// Graphique de la journée, façon Ecojoko : minuit → minuit, se remplit au fil de la journée.
// Une seule échelle en watts : achat au réseau au-dessus de zéro ; en dessous, la production
// (autoconsommation en vert, surplus envoyé au réseau en bleu).
function pas(v) { const p = 10 ** Math.floor(Math.log10(v)); return [1, 2, 2.5, 5, 10].map((m) => m * p).find((x) => v / x <= 4) || p * 10; }
function chartSVG(series, h = 190) {
  if (!series) return '<p class="small muted">La courbe apparaîtra au fil de la journée.</p>';
  const W = 600, H = h, t0 = series.t0 ?? series.day0.getTime(), span = (series.t1 ?? t0 + 864e5) - t0;
  const surplus = series.prod.map((p, i) => ({ t: p.t, v: Math.max(0, p.v - (series.auto?.[i]?.v ?? 0)) }));
  const maxH = Math.max(500, ...series.achat.map((p) => p.v));
  const maxB = Math.max(500, ...series.prod.map((p) => p.v));
  const step = pas(Math.max(maxH, maxB) / 2);
  const haut = Math.ceil(maxH / step) * step, bas = Math.ceil(maxB / step) * step;
  const axe = (haut / (haut + bas)) * H; // même échelle au-dessus et en dessous
  const Y = (v) => (axe - (v / (haut + bas)) * H).toFixed(1); // v positif = achat, négatif = production
  const X = (t) => (((t - t0) / span) * W).toFixed(1);
  const aire = (pts, sgn) => (pts.length ? `M${X(pts[0].t)},${axe.toFixed(1)} ` + pts.map((p) => `L${X(p.t)},${Y(sgn * p.v)}`).join(' ') + ` L${X(pts[pts.length - 1].t)},${axe.toFixed(1)} Z` : '');
  const ligne = (pts, sgn) => pts.map((p, i) => `${i ? 'L' : 'M'}${X(p.t)},${Y(sgn * p.v)}`).join(' ');
  // graduations en watts (texte à gauche, hors du dessin)
  const grad = [];
  for (let v = haut; v >= -bas; v -= step) grad.push(v);
  const lignesG = grad.filter((v) => v !== 0).map((v) => `<line x1="0" x2="${W}" y1="${Y(v)}" y2="${Y(v)}" stroke="var(--line)" vector-effect="non-scaling-stroke"/>`).join('');
  const heures = [1, 5, 9, 13, 17, 21];
  const lignesH = heures.map((hh) => `<line x1="${X(t0 + hh * 36e5)}" x2="${X(t0 + hh * 36e5)}" y1="0" y2="${H}" stroke="var(--line)" stroke-dasharray="2 4" vector-effect="non-scaling-stroke"/>`).join('');
  const now = X(Date.now());
  return `<div class="ek"><div class="ek-y">${grad.filter((v) => v !== -bas).map((v) => `<span style="top:${((Y(v) / H) * 100).toFixed(2)}%">${v === 0 ? '0' : `${nf(v, 0)} W`}</span>`).join('')}</div>
    <div class="ek-plot"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="height:${h}px">
      ${lignesG}${lignesH}
      <path d="${aire(series.achat, 1)}" class="ek-achat"/>
      <path d="${ligne(series.achat, 1)}" class="ek-achat-l" vector-effect="non-scaling-stroke"/>
      <path d="${aire(series.prod, -1)}" class="ek-surplus"/>
      <path d="${aire(series.auto || [], -1)}" class="ek-auto"/>
      <path d="${ligne(series.prod, -1)}" class="ek-prod-l" vector-effect="non-scaling-stroke"/>
      <line x1="0" x2="${W}" y1="${axe.toFixed(1)}" y2="${axe.toFixed(1)}" class="ek-zero" vector-effect="non-scaling-stroke"/>
      <line x1="${now}" x2="${now}" y1="0" y2="${H}" class="ek-now" vector-effect="non-scaling-stroke"/>
    </svg>
    <div class="cb-lbls">${heures.map((hh) => `<span style="left:${(((hh * 36e5) / span) * 100).toFixed(2)}%">${pad2(hh)}:00</span>`).join('')}</div></div></div>`;
}

// Pourquoi la courbe n'est pas complète (affiché sous le graphique, seulement en cas de souci)
function noteCourbe() {
  const e = st.curveErr;
  if (!e || !homey.ready) return '';
  const t = e === 401 || e === 403
    ? 'La Homey refuse de donner l’historique : la clé API n’a pas le droit « Journaux ». Crée une clé avec ce droit (app Homey > Réglages > Clés API). En attendant, la courbe ne contient que les moments où l’iPad était allumé.'
    : st.curve ? 'Historique de la Homey non lu pour le moment : courbe gardée en mémoire, elle sera complétée à la prochaine lecture.'
    : 'Historique de la Homey non lu : la courbe ne contient que les moments où l’iPad était allumé.';
  return `<p class="small muted ek-note">${t}</p>`;
}

function cardEnergy(h = 190) {
  const e = energyNow();
  // totaux du jour, comme Ecojoko : acheté | surplus envoyé au réseau
  const expNow = cap(C.energie.linky, 'meter_power.exported');
  let surplusJ = st.curve?.exp0 != null && typeof expNow === 'number' ? Math.max(0, expNow - st.curve.exp0) : null;
  if (surplusJ != null && surplusJ > 60) surplusJ = null; // valeur incohérente : on n'affiche rien
  // Lecture du Linky : rien acheté au réseau = la maison vit sur sa production (autoconsommation)
  const autoconso = (e.achat ?? 0) < 20 && (e.prod ?? 0) > 50;
  const sens = e.revente > 0 ? { lbl: 'Surplus vers le réseau', v: e.revente } : autoconso ? { lbl: 'Autoconsommation', v: null } : { lbl: 'Achat réseau', v: e.achat };
  return `<div class="card span-2 tap" data-act="tab" data-id="energie">
    <div class="section-head"><h2>Énergie</h2><span class="row" style="gap:6px">${e.couv != null ? `<span class="tag accent" title="Part de ta consommation couverte par le solaire">Solaire ${pct(e.couv)} % de la conso</span>` : ''}${e.auto != null ? `<span class="tag" title="Part de la production utilisée par la maison">Production utilisée ${pct(e.auto)} %</span>` : ''}</span></div>
    <div class="kpis">
      <div class="kpi sun"><div class="lbl">Production</div><div class="val">${watts(e.prod)}</div><div class="small muted">dont FHE estimé ${e.fhe == null ? '–' : nf(e.fhe, 0) + ' W'}</div></div>
      <div class="kpi ${autoconso || e.revente > 0 ? 'ok' : ''}"><div class="lbl">${sens.lbl}</div><div class="val">${sens.v == null ? '0<span class="unit">W acheté</span>' : watts(sens.v)}</div><div class="small muted">${autoconso || e.revente > 0 ? 'maison 100 % solaire en ce moment' : `${nf(e.kwhJour, 1)} kWh achetés aujourd’hui`}</div></div>
      <div class="kpi"><div class="lbl">Coût du jour</div><div class="val">${nf(e.cout, 2)}<span class="unit">€</span></div><div class="small muted">abonnement compris</div></div>
    </div>
    <div class="ek-tot"><span>Aujourd’hui</span><b>${nf(e.kwhJour, 1)}<small> kWh achetés</small></b><i></i><b>${surplusJ == null ? '–' : nf(surplusJ, 2)}<small> kWh de surplus</small></b></div>
    <div class="chart">${chartSVG(curveSeries(), h)}</div>${noteCourbe()}
    <div class="legend"><span><i class="lg-achat"></i>Achat au réseau</span><span><i style="background:var(--ok);opacity:.7"></i>Autoconsommation</span><span><i class="lg-surplus"></i>Surplus envoyé au réseau</span><span><i class="lg-prod"></i>Production (Hoymiles + FHE estimé)</span></div>
  </div>`;
}

// Saison du jour (dates fixes proches des équinoxes et solstices)
const SAISONS = [['printemps', 'Printemps'], ['ete', 'Été'], ['automne', 'Automne'], ['hiver', 'Hiver']];
function saison(d = new Date()) {
  const md = (d.getMonth() + 1) * 100 + d.getDate();
  if (md >= 320 && md < 621) return 'printemps';
  if (md >= 621 && md < 922) return 'ete';
  if (md >= 922 && md < 1221) return 'automne';
  return 'hiver';
}
// Plage « Soirée » d'une personne (par défaut 19:00 → 07:00, peut passer minuit)
function minutes(hm) { const [h, m] = String(hm || '').split(':').map(Number); return Number.isFinite(h) ? h * 60 + (m || 0) : null; }
function enSoiree(a, d = new Date()) {
  const de = minutes(a.soirDe || '19:00'), fin = minutes(a.soirA || '07:00');
  if (de == null || fin == null || de === fin) return false;
  const n = d.getHours() * 60 + d.getMinutes();
  return de < fin ? n >= de && n < fin : n >= de || n < fin;
}
// Une image qui ne se charge pas passe à la suivante de sa liste, puis disparaît (l'initiale reste)
// Images d'avatar qui n'ont pas pu se charger : écartées 10 min (un raté réseau ne doit pas les bannir)
const avEchecs = new Map();
const avIntrouvables = { has: (u) => { const t = avEchecs.get(u); if (t && Date.now() - t < 10 * 60e3) return true; avEchecs.delete(u); return false; } };
window.avSuivant = (img) => {
  avEchecs.set(img.getAttribute('src'), Date.now());
  // quand les images « sortie » sont épuisées, l'avatar de repli reprend le style normal (gris si absent)
  const n = +(img.dataset.sortie || 0);
  if (n > 0) { img.dataset.sortie = n - 1; if (n - 1 === 0) img.parentElement?.classList.remove('sortie'); }
  const l = JSON.parse(img.dataset.alts || '[]');
  if (!l.length) { img.remove(); return; }
  img.dataset.alts = JSON.stringify(l.slice(1));
  img.src = l[0];
};

function avatarHTML(devId, cls = '') {
  const a = S.avatars[devId] || {};
  const present = cap(devId, 'presence') === true;
  // Ordre : avatar de saison ajouté dans les réglages, puis fichier de saison du site
  // (img/avatars/<nom>-<saison>.png ou .jpg), puis photo choisie, puis avatar Homey
  const sz = saison();
  const sources = [];
  // on saute les images déjà reconnues introuvables (sinon elles sont recherchées à chaque mise à jour)
  const ajoute = (...l) => l.forEach((u) => { if (u && !avIntrouvables.has(u)) sources.push(u); });
  const cle = C.avatarsFichiers?.[devId];
  // Priorité : « Sortir » quand la personne est absente, sinon « Soirée » dans la plage horaire, sinon la saison
  const absent = cap(devId, 'presence') === false;
  const special = absent ? 'sortie' : enSoiree(a) ? 'soiree' : null;
  if (special) {
    ajoute(a.saisons?.[special]);
    if (cle) ajoute(`img/avatars/${cle}-${special}.png`, `img/avatars/${cle}-${special}.jpg`);
  }
  const nbSortie = sources.length;
  ajoute(a.saisons?.[sz]);
  if (cle) ajoute(`img/avatars/${cle}-${sz}.png`, `img/avatars/${cle}-${sz}.jpg`);
  ajoute(a.photo);
  const u = findUser(devId, a.user);
  if (u) ajoute(u.avatar || (u.athomId ? `https://api.athom.com/user/${u.athomId}/avatar` : null));
  const src = sources[0] || null;
  const z = a.zoom || 1, x = a.x || 0, y = a.y || 0;
  const img = src ? `<img src="${esc(src)}" alt="" style="transform:translate(${x}%,${y}%) scale(${z})" data-alts="${esc(JSON.stringify(sources.slice(1)))}" data-sortie="${nbSortie}" onerror="avSuivant(this)">` : '';
  const enSortie = nbSortie > 0;
  return `<div class="avatar ${cls} ${present ? 'on' : 'off'} ${enSortie ? 'sortie' : ''}" title="${present ? 'Présent' : 'Absent'}">${img}</div>`;
}

function findUser(devId, userId) {
  const users = Object.values(st.users || {});
  if (userId) return users.find((u) => u.id === userId) || null;
  const n = nm(devId).toLowerCase();
  return users.find((u) => {
    const first = (u.name || '').split(/\s+/)[0].toLowerCase();
    return first.length > 2 && (n.includes(first) || first.startsWith(n.replace(/^(iphone|ipad)\s*(de|d’|d')\s*/i, '').slice(0, 4)));
  }) || null;
}

function cardsPresence() {
  return C.presence.map((id) => avatarHTML(id, 'tile')).join('');
}

/* Caméras : dernière image transmise à Homey */
const camImg = {}; // id -> { url, at, err }
function camImagePath(id) {
  const imgs = dev(id)?.images;
  if (!Array.isArray(imgs) || !imgs.length) return null;
  const o = imgs[0].imageObj || imgs[0];
  return o?.url ? { url: o.url, at: o.lastUpdated ? new Date(o.lastUpdated).getTime() : null } : null;
}
async function refreshCameras(force = false) {
  if (!homey.ready) return;
  await Promise.all(CAMS.map(async (id) => {
    const p = camImagePath(id);
    const cur = camImg[id];
    if (!p) { camImg[id] = { err: 'none' }; return; }
    if (!force && cur?.url && cur.at === p.at && Date.now() - (cur.fetched || 0) < 60e3) return;
    try {
      const url = await homey.imageURL(p.url);
      if (cur?.url) URL.revokeObjectURL(cur.url);
      camImg[id] = { url, at: p.at, fetched: Date.now() };
    } catch (e) { camImg[id] = { ...(cur || {}), err: 'load', code: e.status || null }; }
  }));
  maybeRender();
}
const hhmm = (t) => new Date(t).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

function cardCameras() {
  const tiles = CAMS.filter((id) => dev(id)).map((id) => {
    const im = camImg[id] || {};
    const motion = cap(id, 'alarm_motion') === true;
    const bat = cap(id, 'measure_battery');
    const body = im.url
      ? `<img src="${im.url}" alt="">`
      : `<div class="cam-empty">${im.err === 'none' ? 'Pas d’image transmise à Homey' : im.err ? (im.code === 401 || im.code === 403 ? `Image refusée par la Homey (code ${im.code})` : im.code >= 500 ? 'La caméra n’a pas fourni d’image à la Homey (app Arlo Connect en erreur)' : im.code ? `Image indisponible (code ${im.code})` : `Image indisponible (Homey injoignable${homey.distance ? ' à distance' : ''})`) : 'Chargement…'}</div>`;
    return `<button class="cam ${motion ? 'motion' : ''}" data-act="cam" data-id="${id}">
      ${body}
      <span class="cam-info"><span>${esc(nm(id))}</span><span>${motion ? '<b class="tag warn">Mouvement</b> ' : ''}${typeof bat === 'number' ? bat + ' %' : ''}${im.at ? ' · ' + hhmm(im.at) : ''}</span></span>
    </button>`;
  }).join('');
  return tiles ? `<div class="card span-2"><h2>Caméras</h2><div class="cams">${tiles}</div></div>` : '';
}

function cardLightsSummary() {
  const lights = visible().filter((d) => d.class === 'light' && has(d.id, 'onoff'));
  const on = lights.filter(lampOn).length;
  return `<div class="card tap ${on ? 'glow' : ''}" data-act="tab" data-id="eclairage"><h2>Lumière</h2>
    <div class="row between"><div class="mid">${on}<span class="unit">allumée${on > 1 ? 's' : ''}</span></div><div class="mid">${lights.length - on}<span class="unit">éteinte${lights.length - on > 1 ? 's' : ''}</span></div></div>
  </div>`;
}

function cardBlindsSummary() {
  const ids = [...C.volets.vie.items, ...C.volets.nuit.items];
  const up = ids.filter((id) => blindInfo(id).open).length;
  const garage = cap(C.portail.capteur, 'garagedoor_closed');
  return `<div class="card tap" data-act="tab" data-id="volets"><h2>Volets</h2>
    <div class="row between"><div class="mid">${up}<span class="unit">ouverts</span></div><div class="mid">${ids.length - up}<span class="unit">fermés</span></div></div>
    <p class="small muted" style="margin:12px 0 0">Portail ${garage === false ? '<b style="color:var(--warn)">ouvert</b>' : 'fermé'}</p>
  </div>`;
}

function cardAlerts(list) {
  if (!list.length) return '';
  const order = { alert: 0, warn: 1, info: 2 };
  list.sort((a, b) => order[a.lvl] - order[b.lvl]);
  return `<div class="card alerts full"><h2>Alertes</h2>${list.map((a) => `<div class="al ${a.lvl}" ${a.tab ? `data-act="tab" data-id="${a.tab}"` : ''}><span class="dot"></span><div><div>${esc(a.txt)}</div>${a.sub ? `<div class="small muted">${esc(a.sub)}</div>` : ''}</div>${a.when ? `<span class="when">${esc(a.when)}</span>` : ''}</div>`).join('')}</div>`;
}

function viewHome() {
  return `<div class="home-top">${cardsPresence()}${cardWeather()}</div>
  <div class="grid">${cardAlerts(alerts())}${cardInfo()}${cardComfort()}${cardEnergy()}${cardBattery().replace('class="card batt-card"', 'class="card batt-card tap" data-act="tab" data-id="energie"')}${cardCameras()}<div class="stack-col">${cardBlindsSummary()}${cardLightsSummary()}</div></div>`;
}

/* Fenêtre météo : choix rapide parmi les favoris + prévisions détaillées de la ville */
const prevCache = {};
function villesMeteo() {
  const l = [];
  if (C.maison) l.push({ name: C.maison.nom, lat: C.maison.lat, lon: C.maison.lon, maison: true });
  (S.favoris || []).forEach((f) => { if (!l.some((x) => x.name === f.name && Math.abs(x.lat - f.lat) < 0.01)) l.push(f); });
  if (S.commune && S.lat != null && !l.some((x) => Math.abs(x.lat - S.lat) < 0.01 && Math.abs(x.lon - S.lon) < 0.01)) l.push({ name: S.commune, lat: S.lat, lon: S.lon });
  return l;
}
function contenuMeteo() {
  const villes = villesMeteo();
  const cur = (v) => S.lat != null ? Math.abs(v.lat - S.lat) < 0.01 && Math.abs(v.lon - S.lon) < 0.01 : v.maison;
  const chips = villes.map((v, i) => `<button class="chip-v ${cur(v) ? 'on' : ''}" data-m="${i}">${v.maison ? '⌂ ' : ''}${esc(v.name)}</button>`).join('');
  const key = S.lat != null ? `${S.lat.toFixed(2)},${S.lon.toFixed(2)}` : 'maison';
  const p = prevCache[key];
  let corps = '<p class="muted" style="margin:30px 0;text-align:center">Chargement des prévisions…</p>';
  if (p?.err) corps = '<p class="muted" style="margin:30px 0;text-align:center">Prévisions indisponibles pour le moment.</p>';
  else if (p?.data) {
    const h = p.data.hourly, d = p.data.daily;
    const maintenant = Date.now();
    const idx = h.time.map((t, i) => [Date.parse(t), i]).filter(([t]) => t >= maintenant - 36e5).slice(0, 24).filter((_, k) => k % 2 === 0).map(([, i]) => i);
    const heures = idx.map((i) => `<div class="mh"><span>${new Date(h.time[i]).getHours()} h</span><span class="wx">${WX(h.weather_code[i])}</span><b>${nf(h.temperature_2m[i], 0)}°</b><span class="small">${nf(h.precipitation_probability[i], 0)} %</span></div>`).join('');
    const jours = d.time.map((t, i) => {
      const lbl = i === 0 ? 'Aujourd’hui' : i === 1 ? 'Demain' : new Date(t).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric' });
      return `<div class="md"><span class="md-j">${lbl}</span><span class="wx">${WX(d.weather_code[i])}</span><span class="md-t"><b>${nf(d.temperature_2m_max[i], 0)}°</b> <span class="muted">${nf(d.temperature_2m_min[i], 0)}°</span></span>
        <span class="md-p">💧 ${nf(d.precipitation_probability_max[i], 0)} %${d.precipitation_sum[i] >= 0.1 ? ` · ${nf(d.precipitation_sum[i], 1)} mm` : ''}</span><span class="md-v">💨 ${nf(d.wind_speed_10m_max[i], 0)} km/h${d.wind_gusts_10m_max[i] > 50 ? ` · rafales ${nf(d.wind_gusts_10m_max[i], 0)}` : ''}</span></div>`;
    }).join('');
    const sol = d.sunrise?.[0] ? `<p class="small muted" style="margin:6px 0 0">Lever ${d.sunrise[0].slice(11, 16)} · coucher ${d.sunset[0].slice(11, 16)}</p>` : '';
    corps = `<h4>Prochaines heures</h4><div class="mheures">${heures}</div><h4>7 jours</h4><div class="mjours">${jours}</div>${sol}`;
  }
  return `<div class="set-head"><h1>Météo · ${esc(S.commune || C.maison?.nom || '')}</h1><button class="btn primary" data-m="fermer">Fermer</button></div>
    <div class="mchips">${chips}</div>
    ${(S.favoris || []).length ? '' : '<p class="small muted">Ajoute des communes favorites dans les réglages (tuile Météo) pour les retrouver ici.</p>'}
    ${corps}`;
}
async function chargerPrevisions() {
  const lat = S.lat ?? C.maison?.lat, lon = S.lon ?? C.maison?.lon;
  if (lat == null) return;
  const key = S.lat != null ? `${S.lat.toFixed(2)},${S.lon.toFixed(2)}` : 'maison';
  if (prevCache[key]?.data && Date.now() - prevCache[key].at < 30 * 60e3) return;
  try { prevCache[key] = { data: await previsions(lat, lon), at: Date.now() }; }
  catch { prevCache[key] = { err: true, at: Date.now() }; }
  const el = document.querySelector('.sheet.meteo');
  if (el) el.innerHTML = contenuMeteo();
}
function openMeteo() {
  openSheet(contenuMeteo(), (el) => {
    el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-m]');
      if (!b) return;
      if (b.dataset.m === 'fermer') { closeSheet(); return; }
      const v = villesMeteo()[+b.dataset.m];
      if (!v) return;
      if (v.maison) { S.commune = v.name; S.lat = v.lat; S.lon = v.lon; }
      else { S.commune = v.name; S.lat = v.lat; S.lon = v.lon; }
      saveSettings();
      el.innerHTML = contenuMeteo();
      refreshWeather(true);
      chargerPrevisions();
    });
    chargerPrevisions();
  }, 'meteo');
}

/* Info : l'actualité la plus importante, France et Monde (Le Monde, mis à jour toutes les 30 min) */
const news = { data: store.get('actu2', null), busy: false, ouvert: null };
async function refreshNews(force = false) {
  if (news.busy || (!force && news.data && Date.now() - news.data.at < 30 * 60e3)) return;
  news.busy = true;
  try { news.data = await actualites(); store.set('actu2', news.data); }
  catch (e) { console.warn('actu', e); }
  news.busy = false;
  maybeRender();
}
function ilya(t) {
  if (!t) return '';
  const m = Math.round((Date.now() - t) / 60e3);
  if (m < 1) return 'à l’instant';
  if (m < 60) return `il y a ${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `il y a ${h} h`;
  return new Date(t).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
}
const RUBRIQUES = { politique: 'Politique', societe: 'Société', economie: 'Économie', planete: 'Planète', sport: 'Sport', culture: 'Culture', idees: 'Idées', pixels: 'Pixels', sciences: 'Sciences', international: 'International', 'm-le-mag': 'M', education: 'Éducation', sante: 'Santé' };
function cardInfo() {
  refreshNews();
  const d = news.data;
  const col = (titre, l) => `<div class="info-col"><h3>${titre}</h3>${(l || []).map((x) => {
    const open = news.ouvert === x.lien;
    return `<div class="info-it ${open ? 'open' : ''}" data-act="info" data-id="${esc(x.lien)}">
      ${x.image ? `<img src="${esc(x.image)}" alt="" loading="lazy" onerror="this.remove()">` : ''}
      <div class="info-tx"><div class="info-t">${esc(x.titre)}</div>
        <div class="info-m">${x.rubrique !== 'international' && RUBRIQUES[x.rubrique] ? `${esc(RUBRIQUES[x.rubrique])} · ` : ''}${ilya(x.t)}</div>
        ${open && x.resume ? `<p class="info-r">${esc(x.resume)}</p><a class="info-l" href="${esc(x.lien)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">Lire l’article ›</a>` : ''}
      </div></div>`;
  }).join('') || '<p class="small muted">Chargement…</p>'}</div>`;
  return `<div class="card span-2 info"><div class="section-head"><h2>Info</h2><span class="small muted">Le Monde · ici Hérault${d ? ` · ${ilya(d.at)}` : ''}</span></div>
    ${d || news.busy ? `<div class="info-cols">${col('Monde', d?.monde)}${col('France', d?.france)}${col('Région', d?.region)}</div>` : '<p class="small muted">Actualité indisponible pour le moment.</p>'}
  </div>`;
}

/* Volets */
/* État réel d'un volet.
   Homey garde deux informations : l'état (monter / stop / descendre) et la position (0 = fermé, 1 = ouvert).
   Selon la commande utilisée (bouton, Alexa, flow), une seule des deux est mise à jour :
   on retient donc la plus récente, ou la dernière demande faite depuis le dashboard. */
function capTime(id, c) {
  const t = Date.parse(st.devices[id]?.capabilitiesObj?.[c]?.lastUpdated || '');
  return Number.isNaN(t) ? 0 : t;
}
function blindInfo(id) {
  // Comme l'app Homey : la position (0 = fermé, 1 = ouvert) fait foi dès qu'elle existe.
  // L'état (monter / stop / descendre) ne sert que si l'appareil n'a pas de position.
  const state = cap(id, 'windowcoverings_state');
  const set = cap(id, 'windowcoverings_set');
  const req = st.lastReq[id];
  const tR = req && typeof req === 'object' ? req.t : 0;
  const tP = Math.max(capTime(id, 'windowcoverings_set'), capTime(id, 'windowcoverings_state'));
  let p = null, label = null;
  if (tR && tR > tP) p = req.v;                       // commande envoyée à l'instant depuis le dashboard
  else if (typeof set === 'number') p = pct(set);
  else if (state === 'up') p = 100;
  else if (state === 'down') p = 0;
  else if (state === 'idle') label = 'Arrêté';
  if (!label) label = p == null ? '–' : p >= 95 ? 'Ouvert' : p <= 5 ? 'Fermé' : `Ouvert à ${p} %`;
  return { p, open: p == null ? null : p > 5, label };
}

function blindCtrl(id) {
  const pos = blindInfo(id).p ?? 100;
  return `<div class="ctrl">
    <div class="btns">
      <button class="btn" data-act="blind" data-id="${id}" data-v="up" aria-label="Monter">▲</button>
      <button class="btn" data-act="blind" data-id="${id}" data-v="idle" aria-label="Stop">■</button>
      <button class="btn" data-act="blind" data-id="${id}" data-v="down" aria-label="Descendre">▼</button>
    </div>
    <span class="small muted" data-pos="${id}">${pos} %</span>
  </div>
  <input type="range" min="0" max="100" step="5" value="${pos}" data-range="blind" data-id="${id}" aria-label="Position">`;
}

function viewBlinds() {
  const zone = (title, z, cls) => {
    const pos = blindInfo(z.groupe).p ?? 100;
    const open = z.items.filter((id) => blindInfo(id).open).length;
    return `<div class="zone-bar ${cls}">
      <div class="zb-title"><b>${title}</b><span>${open} ouvert${open > 1 ? 's' : ''} sur ${z.items.length}</span></div>
      <div class="btns">
        <button class="btn sm" data-act="blind" data-id="${z.groupe}" data-v="up" aria-label="Monter toute la zone">▲</button>
        <button class="btn sm" data-act="blind" data-id="${z.groupe}" data-v="idle" aria-label="Stop">■</button>
        <button class="btn sm" data-act="blind" data-id="${z.groupe}" data-v="down" aria-label="Descendre toute la zone">▼</button>
      </div>
      <input type="range" min="0" max="100" step="5" value="${pos}" data-range="blind" data-id="${z.groupe}" aria-label="Position de toute la zone">
      <span class="small" data-pos="${z.groupe}">${pos} %</span>
    </div>
    <div class="grid dense" style="margin-bottom:26px">${z.items.map((id) => {
      const inf = blindInfo(id);
      return `<div class="card blind ${cls}">
      <div class="row between"><div class="name">${esc(nm(id))}</div><span class="tag ${inf.open ? 'accent' : ''}">${inf.label}</span></div>
      ${blindCtrl(id)}
    </div>`;
    }).join('')}</div>`;
  };
  const closed = cap(C.portail.capteur, 'garagedoor_closed');
  return `<h1>Volets</h1>
    ${zone('Zone vie', C.volets.vie, 'z-vie')}
    ${zone('Zone nuit', C.volets.nuit, 'z-nuit')}
    <div class="card portail">
      <div><h2>Portail</h2><div class="pv ${closed === false ? 'ouvert' : ''}">${closed === false ? 'Ouvert' : closed === true ? 'Fermé' : '–'}</div></div>
      <button class="btn sm primary" data-act="portail">${closed === false ? 'Fermer' : 'Ouvrir'}</button>
    </div>`;
}

/* Chauffage */
/* Modes du gainable : lus dans la Homey (liste fournie par l'app Cozytouch), sinon liste par défaut */
const HVAC_FR = { heat: 'Chauffage', heating: 'Chauffage', cool: 'Climatisation', cooling: 'Climatisation', dry: 'Déshumidification', drying: 'Déshumidification', dehumidify: 'Déshumidification', auto: 'Auto', fan: 'Ventilation', fan_only: 'Ventilation', off: 'Arrêt', stop: 'Arrêt' };
function hvacModes(g) {
  const vals = st.devices[g]?.capabilitiesObj?.cozytouch_hvac_mode?.values;
  const list = Array.isArray(vals) && vals.length
    ? vals.map((v) => [v.id, HVAC_FR[v.id] || (typeof v.title === 'object' ? v.title.fr || v.title.en : v.title) || v.id])
    : [['heat', 'Chauffage'], ['cool', 'Climatisation'], ['dry', 'Déshumidification'], ['auto', 'Auto'], ['off', 'Arrêt']];
  const order = ['heat', 'heating', 'cool', 'cooling', 'dry', 'drying', 'dehumidify', 'auto', 'fan', 'fan_only', 'off', 'stop'];
  return list.sort((a, b) => (order.indexOf(a[0]) + 99) % 99 - (order.indexOf(b[0]) + 99) % 99);
}
const isCoolMode = (m) => ['cool', 'cooling', 'dry', 'drying', 'dehumidify'].includes(m);

// En Auto, c'est le gainable qui choisit chauffage ou clim : on lit ce qu'il fait réellement,
// d'après le mode de travail des zones (thermostat_mode : heat / cool).
function modeEffectif(m, zoneId) {
  if (m !== 'auto') return m;
  const lire = (id) => cap(id, 'thermostat_mode');
  const z = zoneId ? lire(zoneId) : null;
  const tous = C.chauffage.zones.map((x) => lire(x.id)).filter(Boolean);
  const v = z || (tous.includes('cool') ? 'cool' : tous[0]);
  return isCoolMode(v) ? 'cool' : 'heat';
}

// Pastille : bleu (trop froid), vert (dans la plage), rouge (trop chaud)
function tempColor(t, zone, mode) {
  if (typeof t !== 'number') return 'none';
  const [lo, hi] = isCoolMode(mode) ? C.seuils.clim : (C.seuils.chauffage[zone] || C.seuils.chauffage.vie);
  return t < lo ? 'cold' : t > hi ? 'hot' : 'ok';
}

function viewHeat() {
  const g = C.chauffage.gainable;
  const m = cap(g, 'cozytouch_hvac_mode');
  const modes = hvacModes(g);
  const plage = (zone, zid) => { const [lo, hi] = isCoolMode(modeEffectif(m, zid)) ? C.seuils.clim : C.seuils.chauffage[zone]; return `${lo}–${hi} °C`; };
  const cards = C.chauffage.zones.map((z) => {
    const pm = pendingMode[z.id];
    const manuel = pm ? pm.v === 'manual' : cap(z.id, 'cozytouch_heating_mode') === 'manual';
    const confirme = !pm && cap(z.id, 'cozytouch_heating_mode') === 'manual';
    const on = cap(z.id, 'onoff') !== false && m !== 'off';
    const co2 = z.co2 ? cap(z.co2, 'measure_co2') : null;
    const t = cap(z.id, 'measure_temperature');
    return `<div class="card zone ${on ? '' : 'off'}">
      <div class="row between"><div><div style="font-weight:500">${esc(nm(z.id))}</div><div class="small muted">Zone ${z.zone === 'nuit' ? 'nuit' : 'vie'}${pm ? ` · <span class="wait">passage en ${pm.v === 'manual' ? 'manuel' : 'programme'}…</span>` : pendingSet[z.id] != null ? ' · <span class="wait">envoi de la consigne…</span>' : ''}</div></div><button class="switch ${cap(z.id, 'onoff') !== false ? 'on' : ''}" data-act="zpower" data-id="${z.id}" aria-label="Marche / arrêt"></button></div>
      <div class="row between" style="margin:14px 0">
        <div class="tdot ${tempColor(t, z.zone, modeEffectif(m, z.id))}" title="Plage de confort ${plage(z.zone, z.id)}"><b>${nf(t, 1)}</b><span>°C</span></div>
        <div style="text-align:right">${co2 && co2 > C.alertes.co2 ? `<span class="tag warn">Aérer · ${nf(co2, 0)} ppm</span><br>` : ''}<span class="small muted">confort ${plage(z.zone, z.id)}</span></div>
      </div>
      <div class="row between wrap">
        <div class="seg">
          <button class="${manuel ? '' : 'on'}" data-act="zmode" data-id="${z.id}" data-flow="${z.bascule}" data-v="prog">Programme</button>
          <button class="${manuel ? 'on' : ''}" data-act="zmode" data-id="${z.id}" data-flow="${z.bascule}" data-v="manual">Manuel</button>
        </div>
        <div class="setp">
          <button class="btn sm" data-act="zset" data-id="${z.id}" data-v="-0.5" ${confirme && on ? '' : 'disabled'} aria-label="Baisser">−</button>
          <span class="v ${pendingSet[z.id] != null ? 'wait' : ''}">${nf(cap(z.id, 'target_temperature'), 1)}°</span>
          <button class="btn sm" data-act="zset" data-id="${z.id}" data-v="0.5" ${confirme && on ? '' : 'disabled'} aria-label="Monter">+</button>
        </div>
      </div>
    </div>`;
  }).join('');
  let label = (modes.find(([v]) => v === m) || [null, m || '–'])[1];
  if (m === 'auto') label += isCoolMode(modeEffectif(m)) ? ' · climatisation en cours' : ' · chauffage en cours';
  return `<h1>Chauffage</h1>
    <div class="card hvac-card" style="margin-bottom:18px">
      <div><h2 style="margin-bottom:2px">${esc(nm(g) || 'Gainable')}</h2><span class="small muted">Mode actuel : <b>${esc(label)}</b></span></div>
      <div class="seg hvac-seg">${modes.map(([v, l]) => `<button class="${m === v ? 'on' : ''}" data-act="hvac" data-v="${esc(v)}">${esc(l)}</button>`).join('')}</div>
    </div>
    <div class="legend-dots"><span><i class="cold"></i>trop frais</span><span><i class="ok"></i>dans la plage</span><span><i class="hot"></i>trop chaud</span><span class="muted">${isCoolMode(modeEffectif(m)) ? 'plages de climatisation' : 'plages de chauffage'}</span></div>
    <div class="grid">${cards}</div>`;
}

/* Piles et batteries : vert au-dessus de 15 %, orange de 6 à 15 %, rouge à 5 % et moins */
function cardBatteries() {
  const list = visible()
    .filter((d) => typeof d.capabilitiesObj?.measure_battery?.value === 'number' && d.class !== 'battery') // pas la batterie de la maison
    .map((d) => ({ d, b: Math.round(d.capabilitiesObj.measure_battery.value) }))
    .sort((x, y) => x.b - y.b);
  if (!list.length) return '';
  const niv = (b) => (b <= 5 ? 'red' : b <= 15 ? 'orange' : 'green');
  const nb = { red: 0, orange: 0 };
  list.forEach(({ b }) => { const n = niv(b); if (n in nb) nb[n]++; });
  const resume = nb.red ? `<span class="tag alert">${nb.red} à changer</span>` : nb.orange ? `<span class="tag warn">${nb.orange} à prévoir</span>` : '<span class="tag">Tout va bien</span>';
  return `<div class="card span-2"><div class="section-head"><h2>Piles et batteries</h2>${resume}</div>
    <div class="bats">${list.map(({ d, b }) => `<div class="bat ${niv(b)}">
      <div class="bat-top"><span class="bat-pct">${b}<small>%</small></span><span class="bat-ico"><i style="width:${clamp(b, 3, 100)}%"></i></span></div>
      <div class="bat-nm">${esc(nm(d.id))}</div><div class="small muted">${esc(zoneName(d.zone))}</div></div>`).join('')}</div>
    <div class="legend"><span><i style="background:var(--b-green)"></i>plus de 15 %</span><span><i style="background:var(--b-orange)"></i>6 à 15 %</span><span><i style="background:var(--b-red)"></i>5 % et moins</span></div>
  </div>`;
}

/* Énergie détaillée */
/* ---------- Batterie et plan de la maison ---------- */
// Coupure du réseau : l'onduleur SolaX est en mode EPS (secours), la batterie alimente la maison
function coupureReseau() {
  const o = dev(C.energie.batterie)?.capabilitiesObj?.alarm_generic;
  if (o?.value !== true) return null;
  const t = o.lastUpdated ? new Date(o.lastUpdated).getTime() : null;
  return { depuis: t, minutes: t ? Math.max(0, Math.round((Date.now() - t) / 60e3)) : null };
}
// kWh chargés / déchargés aujourd'hui : compteur actuel − compteur à minuit.
// Valeur de minuit lue dans l'historique Homey ; sinon, premier relevé vu aujourd'hui (gardé sur l'iPad).
const battMinuit = { jour: null, c0: null, d0: null, depuis: null, lu: 0 };
async function refreshBattJour() {
  const B = C.energie.batterie;
  if (!B || !homey.ready || !dev(B)) return;
  const jour = new Date().toDateString();
  if (battMinuit.jour === jour && battMinuit.depuis === 0) return; // déjà la vraie valeur de minuit
  if (battMinuit.jour === jour && Date.now() - battMinuit.lu < 15 * 60e3) return;
  battMinuit.lu = Date.now();
  const premier = async (c) => { const r = await homey.insights(B, c, 'today'); return r?.length ? r[0] : null; };
  const [c, d] = await Promise.all([premier('meter_power.charged'), premier('meter_power.discharged')]);
  const minuit = new Date(); minuit.setHours(0, 0, 0, 0);
  if (c && d && c.t - minuit.getTime() < 20 * 60e3) Object.assign(battMinuit, { jour, c0: c.v, d0: d.v, depuis: 0 });
  else {
    const g = store.get('battJour', null);
    if (g && g.jour === jour) Object.assign(battMinuit, g);
    else {
      const c1 = cap(B, 'meter_power.charged'), d1 = cap(B, 'meter_power.discharged');
      if (typeof c1 !== 'number' || typeof d1 !== 'number') return;
      Object.assign(battMinuit, { jour, c0: c1, d0: d1, depuis: Date.now() });
      store.set('battJour', { jour, c0: c1, d0: d1, depuis: Date.now() });
    }
  }
  maybeRender();
}
function battJour() {
  const B = C.energie.batterie;
  const c = cap(B, 'meter_power.charged'), d = cap(B, 'meter_power.discharged');
  if (battMinuit.jour !== new Date().toDateString() || typeof c !== 'number' || battMinuit.c0 == null) return null;
  return { charge: Math.max(0, c - battMinuit.c0), decharge: Math.max(0, d - battMinuit.d0), depuis: battMinuit.depuis };
}

// Batterie dessinée : un rectangle, et dedans une barre qui se remplit avec la charge
function battGauge(pct, etat, big = true) {
  const p = clamp(Number(pct) || 0, 0, 100);
  const niv = p <= 10 ? 'bas' : p <= 25 ? 'moyen' : 'ok';
  return `<div class="batt ${big ? 'big' : ''} ${etat}" role="img" aria-label="Batterie ${Math.round(p)} %">
    <div class="batt-corps"><div class="batt-niv ${niv}" style="width:${p}%"></div><span class="batt-pct">${nf(p, 0)}<small>%</small></span>${etat === 'charge' ? `<span class="batt-eclair">${icon('energie', 'line')}</span>` : ''}</div><div class="batt-borne"></div></div>`;
}
function cardBattery() {
  const B = C.energie.batterie;
  if (!B || !dev(B)) return '';
  const e = energyNow();
  const w = e.batt;
  const etat = w == null ? 'repos' : w > 30 ? 'charge' : w < -30 ? 'decharge' : 'repos';
  const cp = coupureReseau();
  const lib = cp ? 'Secours EPS' : { charge: 'En charge', decharge: 'Alimente la maison', repos: 'Au repos' }[etat];
  const derniere = cap(B, 'derniere_coupure');
  const restant = e.battPct == null ? null : (e.battPct / 100) * S.battKwh;
  const j = battJour();
  const depuis = j?.depuis ? ` <span class="muted">(depuis ${hhmm(j.depuis)})</span>` : '';
  return `<div class="card batt-card${cp ? ' eps' : ''}"><div class="section-head"><h2>Batterie</h2><span class="tag ${cp ? 'alerte' : etat === 'repos' ? '' : 'accent'}">${lib}</span></div>
    ${cp ? `<div class="batt-eps"><b>⚡ Coupure du réseau</b><span>La batterie alimente la maison${cp.depuis ? ` depuis ${hhmm(cp.depuis)} (${cp.minutes} min)` : ''}</span></div>` : ''}
    ${battGauge(e.battPct, etat)}
    <div class="batt-info"><div><div class="lbl">Énergie restante</div><b>${restant == null ? '–' : `≈ ${nf(restant, 1)} kWh`}</b><div class="small muted">sur ${nf(S.battKwh, 1)} kWh</div></div>
      <div><div class="lbl">${etat === 'decharge' ? 'Donne' : 'Reçoit'}</div><b>${w == null ? '–' : watts(Math.abs(w))}</b><div class="small muted">${cap(B, 'measure_temperature') != null ? `${nf(cap(B, 'measure_temperature'), 0)} °C · ` : ''}${cap(B, 'measure_voltage') != null ? `${nf(cap(B, 'measure_voltage'), 0)} V` : ''}</div></div></div>
    <div class="batt-jour"><div><span class="lbl">Chargé aujourd’hui</span><b>${j ? nf(j.charge, 2) : '–'}<small> kWh</small></b></div><i></i><div><span class="lbl">Déchargé aujourd’hui</span><b>${j ? nf(j.decharge, 2) : '–'}<small> kWh</small></b></div></div>${depuis ? `<p class="small muted" style="margin:6px 0 0">Comptage${depuis}</p>` : ''}${!cp && derniere ? `<p class="small muted" style="margin:6px 0 0">Dernière coupure du réseau : ${esc(derniere)}</p>` : ''}
  </div>`;
}

// Image de la maison (rendu 3D fourni par Olivier) : gardée seulement sur l'iPad, jamais dans le dépôt public.
// Les lignes d'énergie sont posées dessus aux positions de C.planMaison (en pixels de l'image d'origine).
let maisonCache = store.get('maisonImg', null);
const fluxPath = (d, w, inverse, cls, seuil = 20) => (w == null || Math.abs(w) < seuil
  ? `<path d="${d}" class="iso-l ${cls} off"/>`
  : `<path d="${d}" class="iso-l ${cls} on ${Math.abs(w) > 2000 ? 'v3' : Math.abs(w) > 600 ? 'v2' : 'v1'}${inverse ? ' rev' : ''}"/>`);
function planPhoto(img, e) {
  const M = C.planMaison;
  const pct = clamp((e.battPct ?? 0) / 100, 0, 1);
  const kw = (w) => (w == null ? '–' : Math.abs(w) >= 1000 ? `${nf(Math.abs(w) / 1000, 2)} kW` : `${nf(Math.abs(w), 0)} W`);
  const pill = ([x, y], txt, cls) => { const w = txt.length * 13 + 34; return `<g class="iso-pill grand ${cls}" transform="translate(${x},${y})"><rect x="${(-w / 2).toFixed(0)}" y="-21" width="${w.toFixed(0)}" height="42" rx="21"/><text text-anchor="middle" y="8">${esc(txt)}</text></g>`; };
  const [bx, by, bw, bh] = M.batterie, [cx, cy, cw, ch] = M.coffret, [p1, p2, p3] = M.pylone;
  const resTxt = coupureReseau() ? 'Réseau coupé' : e.revente >= SEUIL_RESEAU ? `Revente ${kw(e.revente)}` : (e.achat ?? 0) >= SEUIL_RESEAU ? `Achat ${kw(e.achat)}` : 'Réseau au repos';
  const batTxt = (e.batt ?? 0) > 30 ? `Charge ${kw(e.batt)}` : (e.batt ?? 0) < -30 ? `Décharge ${kw(e.batt)}` : 'Batterie au repos';
  // pylône dessiné dans le ciel, à droite (le rendu n'en a pas)
  const pyl = `<path d="M${p1 - 14},${p3} L${p1},${p2} L${p1 + 14},${p3} M${p1 - 10},${p3 - 40} L${p1 + 10},${p3 - 40} M${p1 - 6},${p3 - 80} L${p1 + 6},${p3 - 80} M${p1 - 10},${p3 - 40} L${p1 + 6},${p3 - 80} M${p1 + 10},${p3 - 40} L${p1 - 6},${p3 - 80} M${p1 - 30},${p2 + 16} L${p1 + 30},${p2 + 16} M${p1 - 20},${p2 + 4} L${p1 + 20},${p2 + 4}" class="iso-pylone photo"/>`;
  return `<svg class="hp photo" viewBox="${M.cadre.join(' ')}" role="img" aria-label="Plan énergie de la maison">
    <image href="${img}" x="0" y="0" width="${M.largeur}" height="${M.hauteur}" preserveAspectRatio="xMidYMid slice"/>
    ${pyl}
    ${coupureReseau() ? `<path d="${M.reseau}" class="iso-l reseau coupe"/>` : fluxPath(M.reseau, e.revente > 0 ? e.revente : e.achat, e.revente > 0, 'reseau', SEUIL_RESEAU)}
    ${fluxPath(M.solaire, e.prod, false, 'solaire')}
    ${fluxPath(M.bat, e.batt, (e.batt ?? 0) > 0, 'bat')}
    ${fluxPath(M.maison, e.maison, false, 'maison')}
    <rect x="${bx}" y="${by}" width="${bw}" height="${bh}" rx="3" class="ph-batt"/>
    <rect x="${bx + 3}" y="${(by + bh - 3 - (bh - 6) * pct).toFixed(1)}" width="${bw - 6}" height="${((bh - 6) * pct).toFixed(1)}" rx="2" class="iso-batt-niv ${pct <= 0.1 ? 'bas' : pct <= 0.25 ? 'moyen' : 'ok'}"/>
    <rect x="${cx}" y="${cy}" width="${cw}" height="${ch}" rx="2" class="ph-coffret"/>
    ${pill(M.etiquettes.reseau, resTxt, coupureReseau() ? 'reseau coupe' : 'reseau')}
    ${pill(M.etiquettes.solaire, `Panneaux ${kw(e.prod)}`, 'solaire')}
    ${pill(M.etiquettes.bat, `${batTxt} · ${e.battPct == null ? '–' : nf(e.battPct, 0)} %`, 'bat')}
    ${pill(M.etiquettes.maison, `Maison ${kw(e.maison)}`, 'maison')}
  </svg>`;
}

// Plan de la maison (la vraie, d'après photo de face et vue du ciel) : plain-pied crème en L,
// toits en tuiles à croupes, pergola à gauche, porche dans l'angle, panneaux sur l'aile du fond,
// garage à droite. Vue presque de face ; lignes en tirets qui défilent dans le sens de l'énergie.
function cardHousePlan() {
  const e = energyNow();
  const S0 = 30;
  const P = (x, y, z) => [(x - y * 0.4) * S0, (x * 0.04 + y * 0.42) * S0 - z * S0 * 1.35];
  let mnX = Infinity, mnY = Infinity, mxX = -Infinity, mxY = -Infinity;
  const pt = (x, y, z) => { const [a, b] = P(x, y, z); mnX = Math.min(mnX, a); mxX = Math.max(mxX, a); mnY = Math.min(mnY, b); mxY = Math.max(mxY, b); return `${a.toFixed(1)},${b.toFixed(1)}`; };
  const poly = (pts, cls) => `<path d="M${pts.map((p) => pt(...p)).join(' L')} Z" class="${cls}"/>`;
  const line = (pts) => `M${pts.map((p) => pt(...p)).join(' L')}`;
  const box = (x0, x1, y0, y1, z0, z1, cls) =>
    poly([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], `${cls} f-top`)
    + poly([[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]], `${cls} f-y`)
    + poly([[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]], `${cls} f-x`);
  const H = 2.8, L = 17;
  const pct = clamp((e.battPct ?? 0) / 100, 0, 1);
  const allume = (e.maison ?? 0) > 20 ? ' on' : '';
  const out = [];

  out.push(poly([[-5.3, -0.3, 0], [22.6, -0.3, 0], [22.6, 11.6, 0], [-5.3, 11.6, 0]], 'iso-sol'));
  // pylône du réseau, à droite
  const px = 21, py = 8.6, ph = 4.6;
  const pyl = [];
  [[-0.32, -0.32], [0.32, -0.32], [0.32, 0.32], [-0.32, 0.32]].forEach(([dx, dy]) => pyl.push(line([[px + dx, py + dy, 0], [px + dx * 0.25, py + dy * 0.25, ph]])));
  [1.4, 2.8, 4.1].forEach((z) => { const r = 0.32 - (z / ph) * 0.24; pyl.push(line([[px - r, py + r, z], [px + r, py + r, z], [px + r, py - r, z]])); });
  pyl.push(line([[px - 1.2, py, ph - 0.9], [px + 1.2, py, ph - 0.9]]), line([[px - 0.75, py, ph - 0.3], [px + 0.75, py, ph - 0.3]]));
  const pylone = `<path d="${pyl.join(' ')}" class="iso-pylone"/>`; // dessiné après la maison (il est devant)

  // Maison en L (vue du ciel) : aile longue au fond (x 0→L, y 0→6), aile avant à gauche (x 0→6, y 6→10)
  // qui avance vers la rue ; même pente partout, donc mêmes faîtages et une noue dans l'angle.
  const W = 6, F = 10.2; // largeur des ailes, avant de l'aile gauche
  out.push(box(0, L, 0, W, 0, H, 'mz-mur'));
  out.push(box(0, W, W, F, 0, H, 'mz-mur'));
  const o = 0.3, ze = H + 0.05, h = W / 2 + o, zr = ze + h * 0.42; // pente ~23°
  const E = { bg: [-o, -o, ze], bd: [L + o, -o, ze], ad: [L + o, W + o, ze], coin: [W + o, W + o, ze], fd: [W + o, F + o, ze], fg: [-o, F + o, ze] };
  const Rg = [W / 2, W / 2, zr], Rd = [L - W / 2, W / 2, zr], Rf = [W / 2, F + o - h, zr];
  // pans cachés d'abord (silhouette), puis pans visibles
  out.push(poly([E.bg, E.bd, Rd, Rg], 'mz-tuile arriere'));
  out.push(poly([E.bg, E.fg, Rf, Rg], 'mz-tuile croupe'));
  out.push(poly([E.coin, E.ad, Rd, Rg], 'mz-tuile'));                      // pan avant de l'aile longue
  out.push(poly([E.bd, E.ad, Rd], 'mz-tuile croupe'));                     // croupe droite
  out.push(poly([E.coin, E.fd, Rf, Rg], 'mz-tuile croupe'));               // pan droit de l'aile avant
  out.push(poly([E.fg, E.fd, Rf], 'mz-tuile'));                            // croupe avant
  out.push(`<path d="${line([Rg, Rd])} ${line([Rg, Rf])} ${line([E.ad, Rd])} ${line([E.fg, Rf])} ${line([E.fd, Rf])} ${line([E.coin, Rg])}" class="mz-aretier"/>`);
  // panneaux sur le pan avant de l'aile longue, à droite de l'angle
  const rp = (x, t) => [x, W + o - h * t, ze + (zr - ze) * t + 0.05];
  for (let r = 0; r < 2; r++) for (let c = 0; c < 9; c++) {
    const x0 = 8.6 + c * 0.62, t0 = 0.12 + r * 0.32;
    out.push(poly([rp(x0, t0), rp(x0 + 0.56, t0), rp(x0 + 0.56, t0 + 0.29), rp(x0, t0 + 0.29)], 'iso-pv'));
  }
  // ouvertures : façade de l'aile avant (y = F) et de l'aile longue (y = W)
  const face = (y, x0, x1, z0, z1, cls) => poly([[x0, y + 0.01, z0], [x1, y + 0.01, z0], [x1, y + 0.01, z1], [x0, y + 0.01, z1]], cls);
  out.push(face(F, 1.2, 1.75, 0.35, 2.45, 'mz-vitre' + allume));            // haute fenêtre étroite
  out.push(face(W, 10.2, 10.75, 1.35, 2.05, 'mz-vitre petite' + allume));    // petite fenêtre
  out.push(face(W, 11.3, 12.2, 0.75, 2.05, 'mz-cadre'));                     // fenêtre à cadre blanc
  out.push(face(W, 11.4, 12.1, 0.85, 1.95, 'mz-vitre' + allume));
  out.push(face(W, 13.4, 16.1, 0, 2.2, 'mz-garage'));                        // porte de garage
  out.push(`<path d="${[0.45, 0.9, 1.35, 1.8].map((z) => line([[13.4, W + 0.02, z], [16.1, W + 0.02, z]])).join(' ')}" class="mz-lame"/>`);
  // porche d'entrée dans l'angle du L, toit plat bordé de gris
  out.push(box(W, W + 2.1, W, W + 2.6, 0, 3.05, 'mz-mur'));
  out.push(box(W - 0.1, W + 2.2, W - 0.1, W + 2.7, 2.85, 3.15, 'mz-bord'));
  out.push(face(W + 2.6, W + 0.35, W + 1.75, 0, 2.5, 'mz-ombre'));
  out.push(face(W + 2.61, W + 0.7, W + 1.4, 0, 2.1, 'mz-porte'));
  // batterie (à droite du garage) et coffret électrique
  out.push(box(16.4, 17, W, W + 0.35, 0.2, 1.8, 'iso-batt'));
  out.push(poly([[16.5, W + 0.36, 0.32], [16.9, W + 0.36, 0.32], [16.9, W + 0.36, 0.32 + 1.36 * pct], [16.5, W + 0.36, 0.32 + 1.36 * pct]], 'iso-batt-niv ' + (pct <= 0.1 ? 'bas' : pct <= 0.25 ? 'moyen' : 'ok')));
  out.push(box(12.6, 13.1, W, W + 0.22, 0.9, 1.65, 'iso-coffret'));
  // pergola bioclimatique à gauche de l'aile avant
  const pg = [];
  [[-4.4, 4.6], [-4.4, F + 0.5], [-0.15, F + 0.5]].forEach(([x, y]) => pg.push(box(x - 0.12, x + 0.12, y - 0.12, y + 0.12, 0, 2.55, 'mz-pergola')));
  pg.push(box(-4.55, 0, 4.45, F + 0.65, 2.45, 2.75, 'mz-pergola'));
  pg.push(`<path d="${Array.from({ length: 13 }, (_, i) => line([[-4.45 + i * 0.35, 4.55, 2.76], [-4.45 + i * 0.35, F + 0.55, 2.76]])).join(' ')}" class="mz-lames-pg"/>`);
  out.push(pg.join(''));

  out.push(pylone);
  // lignes d'énergie
  const [ax, ay] = P(px - 1.2, py, ph - 0.9), [bx, by] = P(17.3, W + 0.2, 2.2);
  const reseauD = `M${pt(px - 1.2, py, ph - 0.9)} Q${((ax + bx) / 2).toFixed(1)},${(Math.max(ay, by) + 30).toFixed(1)} ${pt(17.3, W + 0.2, 2.2)} L${pt(13.3, W + 0.25, 2.2)} L${pt(12.95, W + 0.23, 1.65)}`;
  const solD = line([[12.5, W + 0.33, ze + 0.05], [12.5, W + 0.25, 2.45], [12.75, W + 0.23, 1.65]]);
  const battD = line([[16.4, W + 0.3, 1.1], [13.1, W + 0.25, 1.1]]);
  const maisonD = line([[12.85, W + 0.25, 0.9], [12.85, W + 0.3, 0.45], [W + 2.15, W + 0.3, 0.45], [W + 2.15, W + 1.6, 0.45]]);
  // Sans flux : ligne pleine et fixe. Avec flux : tirets qui défilent, dans le sens du tracé
  // ou à l'envers ; plus la puissance est forte, plus ils vont vite.
  const vit = (w) => (Math.abs(w) > 2000 ? 'v3' : Math.abs(w) > 600 ? 'v2' : 'v1');
  const flux = (d, w, inverse, cls, seuil = 20) => (w == null || Math.abs(w) < seuil
    ? `<path d="${d}" class="iso-l ${cls} off"/>`
    : `<path d="${d}" class="iso-l ${cls} on ${vit(w)}${inverse ? ' rev' : ''}"/>`);
  out.push(coupureReseau() ? `<path d="${reseauD}" class="iso-l reseau coupe"/>` : flux(reseauD, e.revente > 0 ? e.revente : e.achat, e.revente > 0, 'reseau', SEUIL_RESEAU)); // achat : pylône → maison
  out.push(flux(solD, e.prod, false, 'solaire'));
  out.push(flux(battD, e.batt, (e.batt ?? 0) > 0, 'bat'));                                // décharge : batterie → coffret
  out.push(flux(maisonD, e.maison, false, 'maison'));

  // étiquettes
  const pill = (x, y, z, txt, cls, dx = 0, dy = 0) => { const [a, b] = P(x, y, z); const w = txt.length * 9.6 + 26; mnX = Math.min(mnX, a + dx - w / 2); mxX = Math.max(mxX, a + dx + w / 2); mnY = Math.min(mnY, b + dy - 18); mxY = Math.max(mxY, b + dy + 18); return `<g class="iso-pill ${cls}" transform="translate(${(a + dx).toFixed(1)},${(b + dy).toFixed(1)})"><rect x="${(-w / 2).toFixed(1)}" y="-16" width="${w.toFixed(1)}" height="32" rx="16"/><text text-anchor="middle" y="6">${esc(txt)}</text></g>`; };
  const kw = (w) => (w == null ? '–' : Math.abs(w) >= 1000 ? `${nf(Math.abs(w) / 1000, 2)} kW` : `${nf(Math.abs(w), 0)} W`);
  const resTxt = coupureReseau() ? 'Réseau coupé' : e.revente >= SEUIL_RESEAU ? `Revente ${kw(e.revente)}` : (e.achat ?? 0) >= SEUIL_RESEAU ? `Achat ${kw(e.achat)}` : 'Réseau au repos';
  const batTxt = (e.batt ?? 0) > 30 ? `Charge ${kw(e.batt)}` : (e.batt ?? 0) < -30 ? `Décharge ${kw(e.batt)}` : 'Batterie au repos';
  out.push(pill(px, py, ph, resTxt, coupureReseau() ? 'reseau coupe' : 'reseau', -30, -26));
  out.push(pill(11, 3, zr, `Panneaux ${kw(e.prod)}`, 'solaire', 0, -28));
  out.push(pill(16.7, W + 0.4, 0, `${batTxt} · ${e.battPct == null ? '–' : nf(e.battPct, 0)} %`, 'bat', -20, 34));
  out.push(pill(3, F, 0, `Maison ${kw(e.maison)}`, 'maison', 0, 34));
  const pad = 6;
  const vb = `${(mnX - pad).toFixed(0)} ${(mnY - pad).toFixed(0)} ${(mxX - mnX + 2 * pad).toFixed(0)} ${(mxY - mnY + 2 * pad).toFixed(0)}`;

  const j = battJour();
  const exp = cap(C.energie.linky, 'meter_power.exported');
  const expJ = st.curve?.exp0 != null && typeof exp === 'number' && exp - st.curve.exp0 < 60 ? Math.max(0, exp - st.curve.exp0) : null;
  const maisonJ = e.kwhJour == null || e.prodJourKwh == null ? null : Math.max(0, e.kwhJour + e.prodJourKwh - (expJ ?? 0) - (j ? j.charge - j.decharge : 0));
  const bloc = (cls, lbl, w, jour, sous) => `<div class="hp-v ${cls}"><span class="lbl">${lbl}</span><b>${w == null ? '–' : watts(Math.abs(w))}</b><span class="small muted">${sous}</span><span class="small">${jour}</span></div>`;
  return `<div class="card span-2 hp-card"><div class="section-head"><h2>La maison en direct</h2><span class="small muted">les lignes défilent dans le sens de l’énergie · ligne fixe = rien ne passe</span></div>
  ${maisonCache && C.planMaison ? planPhoto(maisonCache, e) : `<svg class="hp iso" viewBox="${vb}" role="img" aria-label="Plan énergie de la maison">${out.join('')}</svg>`}
  <div class="hp-vals">
    ${bloc('reseau', e.revente > 0 ? 'Réseau · revente' : 'Réseau · achat', e.revente > 0 ? e.revente : e.achat, `${nf(e.kwhJour, 1)} kWh achetés${expJ != null ? ` · ${nf(expJ, 1)} revendus` : ''}`, 'aujourd’hui')}
    ${bloc('solaire', 'Panneaux', e.prod, `${nf(e.prodJourKwh, 1)} kWh produits`, 'dont FHE estimé')}
    ${bloc('bat', (e.batt ?? 0) > 30 ? 'Batterie · charge' : (e.batt ?? 0) < -30 ? 'Batterie · décharge' : 'Batterie', e.batt, j ? `+${nf(j.charge, 1)} / −${nf(j.decharge, 1)} kWh` : '–', `${e.battPct == null ? '–' : nf(e.battPct, 0)} %`)}
    ${bloc('maison', 'Maison', e.maison, `${nf(maisonJ, 1)} kWh consommés`, 'estimé')}
  </div></div>`;
}

function viewEnergy() {
  const e = energyNow();
  const k = (c) => cap(C.energie.compteur, c);
  const now = new Date();
  const moisCout = k('meter_kwh_this_month') == null ? null : k('meter_kwh_this_month') * S.prixKwh + S.aboMois * (now.getDate() / new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate());
  const anCout = k('meter_kwh_this_year') == null ? null : k('meter_kwh_this_year') * S.prixKwh + S.aboMois * (now.getMonth() + now.getDate() / 31);
  const conso = visible()
    .filter((d) => typeof d.capabilitiesObj?.measure_power?.value === 'number' && ![C.energie.linky, C.energie.solaire, C.energie.compteur].includes(d.id) && d.class !== 'solarpanel' && d.class !== 'battery')
    .sort((a, b) => b.capabilitiesObj.measure_power.value - a.capabilitiesObj.measure_power.value)
    .filter((d) => d.capabilitiesObj.measure_power.value > 1)
    .slice(0, 8);
  return `<h1>Énergie</h1>
  <div class="grid">
    ${cardHousePlan()}${cardBattery()}
    ${cardEnergy(260).replace('tap" data-act="tab" data-id="energie"', '"')}
    <div class="card"><h2>Aujourd’hui</h2><div class="stack">
      <div class="row between"><span class="muted">Acheté</span><b>${nf(k('meter_kwh_this_day'), 1)} kWh</b></div>
      <div class="row between"><span class="muted">Produit (estimé)</span><b>${nf(e.prodJourKwh, 1)} kWh</b></div>
      <div class="row between"><span class="muted">Coût</span><b>${nf(e.cout, 2)} €</b></div>
      <div class="row between"><span class="muted">Pic de puissance</span><b>${nf(k('measure_watt_max.day'), 0)} W</b></div>
    </div><p class="tarif-note">Tarif ${nf(S.prixKwh, 4)} €/kWh · abonnement ${nf(S.aboMois, 2)} €/mois · FHE = Hoymiles × ${nf(S.coefFHE, 2)} · modifiable dans les réglages</p></div>
    <div class="card"><h2>Ce mois-ci</h2><div class="stack">
      <div class="row between"><span class="muted">Acheté</span><b>${nf(k('meter_kwh_this_month'), 0)} kWh</b></div>
      <div class="row between"><span class="muted">Coût estimé</span><b>${nf(moisCout, 2)} €</b></div>
      <div class="row between"><span class="muted">Mois dernier</span><b>${nf(k('meter_kwh_last_month'), 0)} kWh</b></div>
      <div class="row between"><span class="muted">Pic du mois</span><b>${nf(k('measure_watt_max.month'), 0)} W</b></div>
    </div></div>
    <div class="card"><h2>Cette année</h2><div class="stack">
      <div class="row between"><span class="muted">Acheté</span><b>${nf(k('meter_kwh_this_year'), 0)} kWh</b></div>
      <div class="row between"><span class="muted">Coût estimé</span><b>${nf(anCout, 0)} €</b></div>
      <div class="row between"><span class="muted">Revendu (compteur)</span><b>${nf(cap(C.energie.linky, 'meter_power.exported'), 0)} kWh</b></div>
    </div></div>
    <div class="card"><h2>Qui consomme en ce moment</h2>${conso.length ? conso.map((d) => `<div class="dev"><div class="nm"><div>${esc(nm(d.id))}</div><div class="small muted">${esc(zoneName(d.zone))}</div></div><b>${nf(d.capabilitiesObj.measure_power.value, 0)} W</b></div>`).join('') : '<p class="muted">Rien de notable.</p>'}</div>
    ${cardBatteries()}
  </div>`;
}

/* ---------- Consommation : historique jour / mois / année ---------- */
// Source : index « énergie importée » du Linky (historique Homey), complété par une copie gardée
// sur l'iPad pour ne rien perdre quand la Homey efface ses vieilles données.
const histo = store.get('histo', { j: {}, m: {}, a: {} });
const cs = { at: 0, busy: false, vue: store.get('consoVue', 'jours'), sel: null };
const pad2 = (n) => String(n).padStart(2, '0');
const cleJour = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const cleMois = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
const MOIS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];

async function refreshConso(force = false) {
  if (!homey.ready || cs.busy || (!force && Date.now() - cs.at < 30 * 60e3)) return;
  cs.busy = true; cs.at = Date.now();
  try {
    const L = C.energie.linky, cap0 = 'meter_power.imported';
    const [court, long] = await Promise.all([homey.insights(L, cap0, 'last31Days'), homey.insights(L, cap0, 'last2Years')]);
    const now = cap(L, cap0);
    // index le plus proche d'un instant donné (les relevés sont espacés de quelques heures)
    const idx = (pts, T) => { let b = null, d = Infinity; for (const p of pts) { const x = Math.abs(p.t - T); if (x < d) { d = x; b = p; } } return b && d < 3 * 864e5 ? b.v : null; };
    const diff = (pts, a, b) => { const va = idx(pts, a); const vb = b > Date.now() - 6 * 36e5 && typeof now === 'number' ? now : idx(pts, b); return va != null && vb != null && vb >= va ? vb - va : null; };
    const auj = new Date(); auj.setHours(0, 0, 0, 0);
    if (court && court.length) {
      for (let i = 31; i >= 1; i--) {
        const d0 = new Date(auj); d0.setDate(d0.getDate() - i); const d1 = new Date(d0); d1.setDate(d1.getDate() + 1);
        if (d0.getTime() < court[0].t - 6 * 36e5) continue;
        const v = diff(court, d0.getTime(), d1.getTime()); if (v != null) histo.j[cleJour(d0)] = +v.toFixed(2);
      }
    }
    const pts = [...(long || []), ...(court || [])].sort((a, b) => a.t - b.t);
    if (pts.length) {
      for (let k = 24; k >= 0; k--) {
        const m0 = new Date(auj.getFullYear(), auj.getMonth() - k, 1); const m1 = new Date(m0.getFullYear(), m0.getMonth() + 1, 1);
        if (m0.getTime() < pts[0].t - 2 * 864e5) continue; // pas d'historique aussi loin
        const v = diff(pts, m0.getTime(), Math.min(m1.getTime(), Date.now())); if (v != null) histo.m[cleMois(m0)] = +v.toFixed(1);
      }
    }
    // Compteurs remis à zéro par « Prix consommation » : les plus fiables pour le jour, le mois et l'année en cours
    const k = (c) => cap(C.energie.compteur, c);
    const hier = new Date(auj); hier.setDate(hier.getDate() - 1);
    if (typeof k('meter_kwh_last_day') === 'number') histo.j[cleJour(hier)] = +k('meter_kwh_last_day').toFixed(2);
    const mp = new Date(auj.getFullYear(), auj.getMonth() - 1, 1);
    if (typeof k('meter_kwh_last_month') === 'number') histo.m[cleMois(mp)] = +k('meter_kwh_last_month').toFixed(1);
    if (typeof k('meter_kwh_last_year') === 'number') histo.a[auj.getFullYear() - 1] = +k('meter_kwh_last_year').toFixed(0);
    // années terminées : somme des mois connus si le compteur ne la donne pas
    const ans = {}; Object.entries(histo.m).forEach(([cm, v]) => { const y = cm.slice(0, 4); ans[y] = (ans[y] || 0) + v; });
    Object.entries(ans).forEach(([y, v]) => { if (+y < auj.getFullYear() && histo.a[y] == null) histo.a[y] = +v.toFixed(0); });
    // on garde 400 jours
    Object.keys(histo.j).sort().slice(0, -400).forEach((x) => delete histo.j[x]);
    store.set('histo', histo);
  } catch (e) { console.warn('conso', e); }
  cs.busy = false;
  maybeRender();
}

function barsSVG(items, { h = 170, sel = null, ghost = null } = {}) {
  // items : [{ lbl, v, cur }] ; ghost : valeurs de comparaison (année précédente)
  if (!items.some((x) => x.v != null)) return '<p class="small muted">Pas encore d’historique pour cette période. Il se remplit au fil des jours.</p>';
  const W = 600, H = h, n = items.length, gap = n > 20 ? 3 : 8;
  const vmax = Math.max(1, ...items.map((x) => x.v || 0), ...(ghost || []).map((v) => v || 0)) * 1.12;
  const bw = (W - gap * (n - 1)) / n;
  const Y = (v) => H - (v / vmax) * (H - 6);
  const bars = items.map((x, i) => {
    const X = i * (bw + gap);
    const g = ghost && ghost[i] != null ? `<rect x="${(X + bw * 0.18).toFixed(1)}" y="${Y(ghost[i]).toFixed(1)}" width="${(bw * 0.64).toFixed(1)}" height="${(H - Y(ghost[i])).toFixed(1)}" rx="2" class="cb-ghost"/>` : '';
    const b = x.v != null ? `<rect x="${X.toFixed(1)}" y="${Y(x.v).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(1.5, H - Y(x.v)).toFixed(1)}" rx="${Math.min(4, bw / 3).toFixed(1)}" class="cb ${x.cur ? 'cur' : ''} ${sel === i ? 'sel' : ''}"/>` : '';
    return `<g data-act="cbar" data-i="${i}">${g}${b}<rect x="${X.toFixed(1)}" y="0" width="${(bw + gap).toFixed(1)}" height="${H}" fill="transparent"/></g>`;
  }).join('');
  const step = n > 20 ? 5 : 1;
  const lbls = items.map((x, i) => `<span style="left:${(((i * (bw + gap)) + bw / 2) / W * 100).toFixed(2)}%">${i % step === 0 || i === n - 1 ? esc(x.lbl) : ''}</span>`).join('');
  return `<svg class="cbars" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="height:${h}px">${bars}</svg><div class="cb-lbls">${lbls}</div>`;
}

function viewConso() {
  const k = (c) => cap(C.energie.compteur, c);
  const e = energyNow();
  const prix = S.prixKwh;
  const now = new Date();
  const eur = (kwh) => (kwh == null ? '–' : `${nf(kwh * prix, 2)} €`);
  const kpi = (lbl, kwh, sub) => `<div class="kpi"><div class="lbl">${lbl}</div><div class="val">${nf(kwh, kwh != null && kwh < 100 ? 1 : 0)}<span class="unit">kWh</span></div><div class="small muted">${eur(kwh)}${sub ? ' · ' + sub : ''}</div></div>`;
  const anNb = now.getFullYear();
  // Année en cours : le compteur « Prix consommation » a pu démarrer en cours d'année,
  // on prend le plus grand entre lui et la somme des mois connus par l'index Linky
  const sommeMois = Object.entries(histo.m).filter(([cm]) => cm.startsWith(`${anNb}-`) && cm !== cleMois(now)).reduce((t, [, v]) => t + v, 0) + (k('meter_kwh_this_month') || 0);
  const anKwh = Math.max(k('meter_kwh_this_year') || 0, sommeMois) || null;
  const top = `<div class="card"><div class="section-head"><h2>Achat au réseau</h2><span class="tag">remise à zéro le 1er janvier</span></div>
    <div class="kpis kpis4">
      ${kpi('Aujourd’hui', k('meter_kwh_this_day'), `hier ${nf(k('meter_kwh_last_day'), 1)} kWh`)}
      ${kpi('Ce mois-ci', k('meter_kwh_this_month'), `${MOIS[(now.getMonth() + 11) % 12]} ${nf(k('meter_kwh_last_month'), 0)} kWh`)}
      ${kpi(`Année ${anNb}`, anKwh, histo.a[anNb - 1] != null ? `${anNb - 1} : ${nf(histo.a[anNb - 1], 0)} kWh` : '')}
    </div>
    <p class="small muted" style="margin:10px 0 0">Coût hors abonnement, au tarif de ${nf(prix, 4)} €/kWh. Abonnement : ${nf(S.aboMois, 2)} €/mois.</p></div>`;

  // Historique
  let items = [], ghost = null, titre = '', total = null;
  if (cs.vue === 'jours') {
    for (let i = 29; i >= 0; i--) {
      const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - i);
      const v = i === 0 ? k('meter_kwh_this_day') : histo.j[cleJour(d)];
      items.push({ lbl: String(d.getDate()), v: typeof v === 'number' ? v : null, cur: i === 0, long: d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' }) });
    }
    titre = '30 derniers jours';
  } else if (cs.vue === 'mois') {
    for (let m = 0; m < 12; m++) {
      const cm = `${anNb}-${pad2(m + 1)}`;
      const v = m === now.getMonth() ? k('meter_kwh_this_month') ?? histo.m[cm] : m < now.getMonth() ? histo.m[cm] : null;
      items.push({ lbl: MOIS[m].replace('.', ''), v: typeof v === 'number' ? v : null, cur: m === now.getMonth(), long: `${MOIS[m]} ${anNb}` });
    }
    ghost = Array.from({ length: 12 }, (_, m) => histo.m[`${anNb - 1}-${pad2(m + 1)}`] ?? null);
    titre = `Mois de ${anNb}`;
  } else {
    const ys = Object.keys(histo.a).map(Number).filter((y) => y < anNb);
    const y0 = Math.min(anNb - 2, ...ys);
    for (let y = y0; y <= anNb; y++) {
      const v = y === anNb ? anKwh : histo.a[y];
      items.push({ lbl: String(y), v: typeof v === 'number' ? v : null, cur: y === anNb, long: y === anNb ? `${y} (en cours)` : String(y) });
    }
    titre = 'Par année';
  }
  total = items.reduce((t, x) => t + (x.v || 0), 0);
  const sel = cs.sel != null && items[cs.sel]?.v != null ? items[cs.sel] : null;
  const info = sel ? `<b>${esc(sel.long)}</b> · ${nf(sel.v, sel.v < 100 ? 1 : 0)} kWh · ${eur(sel.v)}` : `Total affiché : <b>${nf(total, 0)} kWh</b> · ${eur(total)} <span class="muted">· touche une barre pour le détail</span>`;
  const seg = [['jours', 'Jours'], ['mois', 'Mois'], ['annees', 'Années']].map(([v, l]) => `<button class="${cs.vue === v ? 'on' : ''}" data-act="cvue" data-v="${v}">${l}</button>`).join('');
  const hist = `<div class="card c-full"><div class="section-head"><h2>Historique · ${titre}</h2><div class="seg">${seg}</div></div>
    ${barsSVG(items, { sel: cs.sel, ghost })}
    <div class="c-info">${info}</div>
    ${ghost ? `<div class="legend"><span><i style="background:var(--accent)"></i>${anNb}</span><span><i class="lg-ghost"></i>${anNb - 1}</span></div>` : ''}</div>`;

  // Consommation instantanée par appareil
  const appareils = appareilsMesures().filter((x) => x.w >= 1);
  const mesure = appareils.reduce((t, x) => t + x.w, 0);
  const maison = e.conso;
  const reste = maison != null ? Math.max(0, maison - mesure) : null;
  const lignes = [...appareils, ...(reste != null && reste >= 20 ? [{ nom: 'Reste de la maison', w: reste, piece: 'non mesuré', autre: true }] : [])];
  const wmax = Math.max(1, ...lignes.map((x) => x.w));
  const inst = `<div class="card"><div class="section-head"><h2>En ce moment, par appareil</h2><span class="tag accent">Maison ${maison != null ? watts(maison) : '–'}</span></div>
    ${lignes.length ? `<div class="hbars">${lignes.map((x) => `<div class="hb ${x.autre ? 'autre' : ''}"><div class="hb-nm">${esc(x.nom)}<small>${esc(x.piece || '')}</small></div>
      <div class="hb-track"><i style="width:${Math.max(1.5, (x.w / wmax) * 100).toFixed(1)}%"></i></div><b>${watts(x.w)}</b></div>`).join('')}</div>` : '<p class="muted">Aucun appareil mesuré ne consomme en ce moment.</p>'}
    <p class="small muted" style="margin:10px 0 0">Mis à jour toutes les 5 secondes. « Maison » = achat réseau + production solaire utilisée. « Reste » = ce qui n’est pas mesuré par une prise.</p></div>`;

  return `<h1>Consommation</h1><div class="cgrid">${top}${inst}${hist}${zonesAppareils()}</div>`;
}

/* ---------- Courbe par appareil : direct, jour, mois, année ---------- */
function appareilsMesures() {
  return Object.values(st.devices)
    .filter((d) => typeof d.capabilitiesObj?.measure_power?.value === 'number' && ![C.energie.linky, C.energie.solaire, C.energie.compteur, C.portail.relais].includes(d.id) && d.class !== 'solarpanel' && d.class !== 'battery' && !C.exclureZones.includes(d.zone))
    .filter((d) => !C.exclureAppareils.includes(d.id) || C.consoInclure?.includes(d.id))
    .map((d) => ({ id: d.id, nom: d.id === C.consoGainable ? 'Gainable (estimé)' : nm(d.id), w: d.capabilitiesObj.measure_power.value, piece: zoneName(d.zone) }))
    .sort((a, b) => b.w - a.w);
}

// Relevés en direct gardés en mémoire (20 dernières minutes, toutes les 5 s)
const direct = {};
// Relevés énergie de la maison (toutes les 5 s, 2 h) pour prolonger les courbes jusqu'à maintenant
const directE = [];
// Moyenne par minute : les relevés de 5 s rejoignent l'historique Homey sans faire de dents de scie
function parMinute(pts) {
  const b = new Map();
  pts.forEach((p) => { const k = Math.floor(p.t / 60e3); const x = b.get(k) || { s: 0, n: 0 }; x.s += p.v; x.n++; b.set(k, x); });
  return [...b.entries()].map(([k, x]) => ({ t: k * 60e3 + 30e3, v: x.s / x.n }));
}
// Historique + relevés récents postérieurs au dernier point de l'historique
function prolonge(hist, recents) {
  const fin = hist.length ? hist[hist.length - 1].t : 0;
  return [...hist, ...parMinute(recents.filter((p) => p.t > fin))];
}

function liveSample() {
  const t = Date.now();
  const e = energyNow();
  if (e.prod != null || e.achat != null) {
    directE.push({ t, p: e.prod ?? 0, a: e.achat ?? 0, r: e.revente ?? 0 });
    while (directE.length && t - directE[0].t > 2 * 36e5) directE.shift();
  }
  Object.values(st.devices).forEach((d) => {
    const w = d.capabilitiesObj?.measure_power?.value;
    if (typeof w !== 'number') return;
    const a = (direct[d.id] = direct[d.id] || []);
    a.push({ t, v: w });
    while (a.length && t - a[0].t > 60 * 60e3) a.shift();
  });
}

const cd = { cache: {}, busy: false };
// Jour = 24 h glissantes, Mois = 30 jours glissants, Année = 12 mois glissants (jamais de remise à zéro)
const RES = { direct: 'lastHour', jour: 'last24Hours', mois: 'last31Days', annee: 'last2Years' };
const FENETRE = { jour: 864e5, mois: 30 * 864e5, annee: 365 * 864e5 };

const cdFile = new Set();
// Courbes gardées sur l'iPad (onglet choisi de chaque tuile) : affichées tout de suite à l'ouverture
Object.assign(cd.cache, Object.fromEntries(Object.entries(store.get('courbesApp', {})).map(([k, v]) => [k, { ...v, at: 0 }])));
function sauveCourbes() {
  const garde = {};
  Object.entries(cd.cache).forEach(([k, v]) => { const [id, vue] = k.split('|'); if (vue !== 'direct' && (cdVues[id] || 'direct') === vue && v.pts?.length) garde[k] = { pts: v.pts, kwhPts: v.kwhPts }; });
  store.set('courbesApp', garde);
}
async function chargeAppareil(id, vue) {
  const key = `${id}|${vue}`;
  const c = cd.cache[key];
  // Direct : l'heure passée n'est lue qu'une fois, ensuite les relevés de l'iPad prennent le relais
  if (c && (vue === 'direct' || Date.now() - c.at < 5 * 60e3)) return;
  if (cd.busy) { cdFile.add(key); return; }
  cd.busy = true;
  try {
    let pts = null;
    for (const capId of ['measure_power', 'energy_power']) { pts = await homey.insights(id, capId, RES[vue]); if (pts && pts.length) break; }
    let kwhPts = null;
    if (has(id, 'meter_power')) kwhPts = await homey.insights(id, 'meter_power', RES[vue]);
    const debut = FENETRE[vue] ? Date.now() - FENETRE[vue] : 0;
    const coupe = (l) => (l || []).filter((p) => p.t >= debut).map((p) => ({ t: p.t, v: Math.round(p.v * 100) / 100 }));
    if ((pts && pts.length) || !c) cd.cache[key] = { at: Date.now(), pts: coupe(pts), kwhPts: coupe(kwhPts) };
    else c.at = Date.now(); // rien reçu : on garde la dernière courbe connue
    sauveCourbes();
  } catch { if (c) c.at = Date.now(); else cd.cache[key] = { at: Date.now(), pts: [], kwhPts: [] }; }
  cd.busy = false;
  cdFile.delete(key);
  const suivant = cdFile.values().next().value;
  if (suivant) { const [i, v] = suivant.split('|'); cdFile.delete(suivant); chargeAppareil(i, v); }
  else maybeRender();
}

// inverse : le temps va de droite à gauche (le plus récent à gauche)
function lineSVG(pts, { t0, t1, h = 180, ticks = [], centre = false, inverse = false, now: repereNow = false }) {
  if (!pts || pts.length < 2) {
    if (!repereNow) return '<p class="small muted" style="margin:30px 0">Pas encore de relevés pour cette période.</p>';
    pts = pts || [];
  }
  const W = 600, H = h, span = t1 - t0;
  const vmax = Math.max(10, ...pts.map((p) => p.v)) * 1.1;
  const tNow = Date.now();
  const pos = (t) => (inverse ? (t1 - t) / span : (t - t0) / span);
  const X = (t) => (pos(t) * W).toFixed(1);
  const Y = (v) => (H - (Math.max(0, v) / vmax) * (H - 6)).toFixed(1);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${X(p.t)},${Y(p.v)}`).join(' ');
  const area = pts.length ? `M${X(pts[0].t)},${H} ${pts.map((p) => `L${X(p.t)},${Y(p.v)}`).join(' ')} L${X(pts[pts.length - 1].t)},${H} Z` : '';
  const marque = repereNow && tNow > t0 && tNow < t1 ? `<line x1="${X(tNow)}" x2="${X(tNow)}" y1="0" y2="${H}" stroke="var(--accent)" stroke-width="1" stroke-opacity=".6" vector-effect="non-scaling-stroke"/>` : '';
  const grid = ticks.map((tk) => `<line x1="${X(tk.t)}" x2="${X(tk.t)}" y1="0" y2="${H}" stroke="var(--line)" stroke-dasharray="2 4" vector-effect="non-scaling-stroke"/>`).join('');
  const mid = [0.5].map((f) => `<line x1="0" x2="${W}" y1="${Y(vmax / 1.1 * f)}" y2="${Y(vmax / 1.1 * f)}" stroke="var(--line)" vector-effect="non-scaling-stroke"/>`).join('');
  return `<div class="chart-wrap"><svg class="cline" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="height:${h}px">${grid}${mid}
    <path d="${area}" fill="var(--accent)" fill-opacity=".16"/>
    <path d="${line}" fill="none" stroke="var(--accent)" stroke-width="1.8" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>${marque}</svg>
    <span class="axis-lbl top ${inverse ? 'right' : ''}">${watts(vmax / 1.1)}</span></div>
    <div class="cb-lbls ${centre ? '' : 'edge'}">${ticks.map((tk) => `<span style="left:${(pos(tk.t) * 100).toFixed(2)}%">${esc(tk.l)}</span>`).join('')}</div>`;
}

// Onglet choisi pour chaque tuile (retenu sur l'iPad)
const cdVues = store.get('consoTuiles2', {});
let trancheDirect = null;

function calculPeriode(id, vue) {
  const now = Date.now();
  const d0 = new Date(); d0.setHours(0, 0, 0, 0);
  let pts, t0, t1 = now, ticks = [];
  if (vue === 'direct') {
    // Une heure affichée, heures croissantes vers la droite. Au début, la courbe part de l'heure
    // d'ouverture (à gauche) et se remplit vers la droite ; une fois pleine, elle glisse en continu
    // (jamais de remise à zéro) : l'instant présent reste près du bord droit.
    const cinq = 5 * 60e3;
    if (!trancheDirect) trancheDirect = Math.floor(now / cinq) * cinq;
    t0 = Math.max(trancheDirect, Math.ceil(now / cinq) * cinq - 55 * 60e3); t1 = t0 + 60 * 60e3;
    pts = (direct[id] || []).filter((p) => p.t >= t0);
    const hm = (tq) => { const d = new Date(tq); return `${d.getHours()}:${pad2(d.getMinutes())}`; };
    const q = 15 * 60e3;
    ticks.push({ t: t0, l: hm(t0) });
    for (let tq = Math.ceil((t0 + 1) / q) * q; tq <= t1; tq += q) {
      if (tq - ticks[ticks.length - 1].t >= 14 * 60e3 && t1 - tq >= 0) ticks.push({ t: tq, l: hm(tq) });
    }
  } else {
    chargeAppareil(id, vue);
    const c = cd.cache[`${id}|${vue}`];
    pts = c ? prolonge(c.pts, direct[id] || []) : null;
    t1 = now; t0 = now - FENETRE[vue];
    if (vue === 'jour') {
      // repères aux vraies heures, toutes les 8 h
      const dd = new Date(t0); dd.setMinutes(0, 0, 0);
      for (let t = dd.getTime() + 36e5; t < t1; t += 36e5) if (new Date(t).getHours() % 8 === 0) ticks.push({ t, l: new Date(t).getHours() === 0 ? 'minuit' : `${new Date(t).getHours()} h` });
    } else if (vue === 'mois') {
      for (let k = 3; k >= 0; k--) { const t = now - k * 8 * 864e5 - 864e5; ticks.push({ t, l: new Date(t).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }).replace('.', '') }); }
    } else {
      const m = new Date(t0); m.setDate(1); m.setHours(0, 0, 0, 0);
      for (m.setMonth(m.getMonth() + 1); m.getTime() < t1; m.setMonth(m.getMonth() + 3)) ticks.push({ t: m.getTime(), l: MOIS[m.getMonth()].replace('.', '') });
    }
  }
  let kwh = null;
  const c = cd.cache[`${id}|${vue}`];
  if (vue !== 'direct' && c && c.kwhPts.length >= 2) kwh = Math.max(0, c.kwhPts[c.kwhPts.length - 1].v - c.kwhPts[0].v);
  if (kwh == null && pts && pts.length >= 2) { kwh = 0; for (let i = 1; i < pts.length; i++) kwh += ((pts[i - 1].v + pts[i].v) / 2) * ((pts[i].t - pts[i - 1].t) / 36e5) / 1000; }
  const pic = pts && pts.length ? Math.max(...pts.map((p) => p.v)) : null;
  return { pts, t0, t1, ticks, kwh, pic };
}

function tuileAppareil(x, cls) {
  const vue = cdVues[x.id] || 'direct';
  const r = calculPeriode(x.id, vue);
  const seg = [['direct', 'Direct'], ['jour', 'Jour'], ['mois', 'Mois'], ['annee', 'Année']].map(([v, l]) => `<button class="${vue === v ? 'on' : ''}" data-act="ctvue" data-id="${x.id}" data-v="${v}">${l}</button>`).join('');
  const periode = { direct: '1 h', jour: '24 h', mois: '30 j', annee: '12 mois' }[vue];
  // Couleur selon la consommation en cours : vert faible, orange moyenne, rouge élevée
  const [s1, s2] = C.seuilsConso || [150, 800];
  const niveau = x.w < 1 ? '' : x.w < s1 ? 'c-faible' : x.w < s2 ? 'c-moyen' : 'c-eleve';
  return `<div class="card ctile ${cls} ${niveau}">
    <div class="ct-head"><div class="ct-nm"><b>${esc(x.nom)}</b><small>${esc(x.piece || '')}</small></div><span class="ct-w">${watts(x.w)}</span></div>
    <div class="seg ct-seg">${seg}</div>
    ${r.pts === null ? '<p class="small muted ct-wait">Chargement de la courbe…</p>' : lineSVG(r.pts, { t0: r.t0, t1: r.t1, ticks: r.ticks, h: 84, now: vue === 'direct' })}
    <div class="ct-foot"><span>${periode} : <b>${r.kwh == null ? '–' : `${nf(r.kwh, r.kwh < 10 ? 2 : 1)} kWh`}</b>${r.kwh == null ? '' : ` · ${nf(r.kwh * S.prixKwh, 2)} €`}</span><span class="muted">pic ${r.pic == null ? '–' : watts(r.pic)}</span></div>
  </div>`;
}

function zonesAppareils() {
  const liste = appareilsMesures();
  if (!liste.length) return '';
  const groupes = { vie: [], nuit: [], autres: [] };
  liste.forEach((x) => groupes[zoneDePiece(st.devices[x.id]?.zone)].push(x));
  const ZONES = [['vie', 'Zone vie', 'z-vie'], ['nuit', 'Zone nuit', 'z-nuit'], ['autres', 'Extérieur et maison entière', 'z-autres']];
  return `<div class="c-full"><div class="lzones">${ZONES.map(([k, titre, cls]) => {
    const l = groupes[k];
    if (!l.length) return '';
    const w = l.reduce((t, x) => t + x.w, 0);
    const ids = l.map((x) => x.id);
    const par = Object.fromEntries(l.map((x) => [x.id, x]));
    return `<section class="lzone ${cls}"><div class="lz-head"><div class="zb-title"><b>${titre}</b><span>${l.length} appareil${l.length > 1 ? 's' : ''} mesuré${l.length > 1 ? 's' : ''} · ${nf(w, 0)} W en ce moment</span></div></div>
      ${colonnes(ids, () => 1, (id) => tuileAppareil(par[id], cls))}</section>`;
  }).join('')}</div></div>`;
}

/* Éclairage et prises */
function byZone(list) {
  const groups = {};
  list.forEach((d) => { const z = zoneName(d.zone) || 'Maison'; (groups[z] = groups[z] || []).push(d); });
  return Object.entries(groups).sort((a, b) => a[0].localeCompare(b[0], 'fr'));
}

// Une lampe Hue coupée à l'interrupteur devient injoignable mais garde « allumée » dans la Homey
const lampOff = (d) => d.available === false || estInjoignable(d);
const lampOn = (d) => !lampOff(d) && cap(d.id, 'onoff') === true;
// Pièce → zone vie / nuit : déduit des volets, plus les pièces sans volet (config.piecesZone)
function zoneDePiece(zoneId) {
  for (const k of ['vie', 'nuit']) {
    if ((C.piecesZone?.[k] || []).includes(zoneId)) return k;
    if (C.volets[k].items.some((id) => st.devices[id]?.zone === zoneId)) return k;
  }
  return 'autres';
}

// Répartit les tuiles de pièce en deux colonnes de hauteur proche (l'ordre importe peu)
function colonnes(zids, poids, html) {
  if (zids.length < 2) return `<div class="lcols one"><div class="lcol">${zids.map(html).join('')}</div></div>`;
  const cols = [[], []], h = [0, 0];
  [...zids].sort((a, b) => poids(b) - poids(a)).forEach((z) => { const i = h[0] <= h[1] ? 0 : 1; cols[i].push(z); h[i] += poids(z); });
  return `<div class="lcols">${cols.map((c) => `<div class="lcol">${c.map(html).join('')}</div>`).join('')}</div>`;
}

function viewLights() {
  const lights = visible().filter((d) => d.class === 'light' && has(d.id, 'onoff') && !(C.eclairageExclureZones || []).includes(d.zone));
  if (!lights.length) return '<h1>Éclairage</h1><div class="empty">Aucun éclairage trouvé.</div>';
  const pieces = {};
  lights.forEach((d) => { (pieces[d.zone] = pieces[d.zone] || []).push(d); });
  const card = (zid, list, cls) => {
    const ids = list.filter((d) => !lampOff(d)).map((d) => d.id).join(',');
    const nbOn = list.filter(lampOn).length;
    const btn = list.length > 1 ? `<button class="btn sm lampbtn ${nbOn ? 'on' : ''}" data-act="zonelights" data-ids="${ids}" data-v="${nbOn ? 'off' : 'on'}" ${ids ? '' : 'disabled'}>${nbOn ? 'Tout éteindre' : 'Tout allumer'}</button>` : '';
    return `<div class="card lamps ${cls}"><div class="section-head"><h2>${esc(zoneName(zid) || 'Maison')}</h2>${btn}</div>
      ${list.map((d) => {
        const inj = lampOff(d);
        const on = lampOn(d);
        const dim = has(d.id, 'dim') ? pct(cap(d.id, 'dim') ?? 0) : null;
        const sub = inj ? 'éteinte · coupée à l’interrupteur' : on && dim != null ? `${dim} %` : '';
        // Compact : nom + interrupteur, le curseur d'intensité n'apparaît que lampe allumée
        return `<div class="lamp2 ${on ? 'on' : ''} ${inj ? 'off-line' : ''}">
          <div class="l2-row"><div class="nm"><div>${esc(nm(d.id))}</div>${sub ? `<div class="small muted">${sub}</div>` : ''}</div>
          <button class="switch ${on ? 'on' : ''}" data-act="onoff" data-id="${d.id}" aria-label="Allumer / éteindre"></button></div>
          ${dim != null && on ? `<input class="dim" type="range" min="1" max="100" value="${dim || 1}" data-range="dim" data-id="${d.id}" aria-label="Intensité">` : ''}</div>`;
      }).join('')}</div>`;
  };
  // [clé, titre, classe, bouton « Tout éteindre » sur le cadre]
  const ZONES = [['vie', 'Zone vie', 'z-vie', true], ['nuit', 'Zone nuit', 'z-nuit', false], ['autres', 'Extérieur et annexes', 'z-autres', true]];
  return `<h1>Éclairage</h1><div class="lzones">${ZONES.map(([k, titre, cls, btnZone]) => {
    const zids = Object.keys(pieces).filter((zid) => zoneDePiece(zid) === k)
      .sort((a, b) => (zoneName(a) || '').localeCompare(zoneName(b) || '', 'fr', { numeric: true }));
    if (!zids.length) return '';
    const all = zids.flatMap((zid) => pieces[zid]);
    const nbOn = all.filter(lampOn).length;
    return `<section class="lzone ${cls}"><div class="lz-head"><div class="zb-title"><b>${titre}</b><span>${nbOn ? `${nbOn} allumée${nbOn > 1 ? 's' : ''} sur ${all.length}` : 'tout est éteint'}</span></div>
      ${nbOn && btnZone ? `<button class="btn sm" data-act="zonelights" data-ids="${all.filter(lampOn).map((d) => d.id).join(',')}" data-v="off" style="margin-left:auto">Tout éteindre</button>` : ''}</div>
      ${colonnes(zids, (zid) => 1.6 + pieces[zid].reduce((t, d) => t + (lampOn(d) && has(d.id, 'dim') ? 1.9 : 1), 0), (zid) => card(zid, pieces[zid], cls))}</section>`;
  }).join('')}</div>`;
}

function viewPlugs() {
  const plugs = visible().filter((d) => C.classesPrises.includes(d.class) && has(d.id, 'onoff'));
  if (!plugs.length) return '<h1>Prises</h1><div class="empty">Aucune prise trouvée.</div>';
  const plugOn = (d) => !estInjoignable(d) && cap(d.id, 'onoff') === true;
  const prot = (d) => C.prisesProtegees.includes(d.id);
  const pieces = {};
  plugs.forEach((d) => { (pieces[d.zone] = pieces[d.zone] || []).push(d); });
  const card = (zid, list, cls) => {
    return `<div class="card lamps ${cls}"><div class="section-head"><h2>${esc(zoneName(zid) || 'Maison')}</h2></div>
      ${list.map((d) => {
        const on = plugOn(d);
        const inj = estInjoignable(d);
        const w = cap(d.id, 'measure_power');
        const sub = [inj ? 'ne répond pas' : typeof w === 'number' ? `${nf(w, 0)} W` : '', prot(d) ? 'protégée' : ''].filter(Boolean).join(' · ');
        return `<div class="lamp2 ${on ? 'on' : ''} ${inj ? 'off-line' : ''}"><div class="l2-row"><div class="nm"><div>${esc(nm(d.id))}</div>${sub ? `<div class="small muted">${sub}</div>` : ''}</div>
          <button class="switch ${on ? 'on' : ''}" data-act="plug" data-id="${d.id}" aria-label="Allumer / couper"></button></div></div>`;
      }).join('')}</div>`;
  };
  const ZONES = [['vie', 'Zone vie', 'z-vie'], ['nuit', 'Zone nuit', 'z-nuit'], ['autres', 'Extérieur et annexes', 'z-autres']];
  return `<h1>Prises</h1><div class="lzones">${ZONES.map(([k, titre, cls]) => {
    const zids = Object.keys(pieces).filter((zid) => zoneDePiece(zid) === k)
      .sort((a, b) => (zoneName(a) || '').localeCompare(zoneName(b) || '', 'fr', { numeric: true }));
    if (!zids.length) return '';
    const all = zids.flatMap((zid) => pieces[zid]);
    const nbOn = all.filter(plugOn).length;
    const w = all.reduce((t, d) => t + (plugOn(d) && typeof cap(d.id, 'measure_power') === 'number' ? cap(d.id, 'measure_power') : 0), 0);
    return `<section class="lzone ${cls}"><div class="lz-head"><div class="zb-title"><b>${titre}</b><span>${nbOn ? `${nbOn} allumée${nbOn > 1 ? 's' : ''} sur ${all.length}${w >= 1 ? ` · ${nf(w, 0)} W` : ''}` : 'tout est coupé'}</span></div></div>
      ${colonnes(zids, (zid) => 1.4 + pieces[zid].length, (zid) => card(zid, pieces[zid], cls))}</section>`;
  }).join('')}</div>`;
}

/* ---------- Feuilles ---------- */
function openSheet(html, onMount, cls = '') {
  st.sheet = true;
  const root = $('#sheet-root');
  root.innerHTML = `<div class="sheet-bg ${cls}"><div class="sheet ${cls}" role="dialog" aria-modal="true">${html}</div></div>`;
  root.firstChild.addEventListener('click', (e) => { if (e.target === root.firstChild) closeSheet(); });
  onMount?.(root.querySelector('.sheet'));
}
function closeSheet() { stopLive(); $('#sheet-root').innerHTML = ''; st.sheet = false; render(); }

function confirmSheet(title, text, ok = 'Confirmer') {
  return new Promise((resolve) => {
    openSheet(`<h3>${esc(title)}</h3><p>${esc(text)}</p><div class="actions"><button class="btn ghost" data-x="no">Annuler</button><button class="btn primary" data-x="yes">${esc(ok)}</button></div>`, (el) => {
      el.addEventListener('click', (e) => {
        const b = e.target.closest('[data-x]');
        if (!b) return;
        e.stopPropagation();
        closeSheet();
        resolve(b.dataset.x === 'yes');
      });
    });
    const bg = $('#sheet-root .sheet-bg');
    bg.addEventListener('click', (e) => { if (e.target === bg) resolve(false); });
  });
}

/* ---------- Caméras : vidéo en direct ----------
   Même échange que l'app web Homey : offre WebRTC envoyée à /manager/videos/video/:id/offer,
   réponse SDP renvoyée par la Homey, puis maintien du flux toutes les 60 s. */
function videoOf(devId) {
  const v = (dev(devId)?.videos || []).find((x) => x.type === 'camera' && x.videoObj?.id);
  return v ? v.videoObj : null;
}

let live = null; // { pc, keep, closed }
function stopLive() {
  if (!live) return;
  live.closed = true;
  clearInterval(live.keep);
  try { live.pc.close(); } catch { /* déjà fermée */ }
  live = null;
}

async function startLive(videoObj, videoEl, setMsg) {
  stopLive();
  const me = { closed: false };
  live = me;
  const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }], bundlePolicy: 'max-compat', iceCandidatePoolSize: 10 });
  me.pc = pc;
  pc.addTransceiver('audio', { direction: 'recvonly' });
  pc.addTransceiver('video', { direction: 'recvonly' });
  if (videoObj.options?.dataChannel !== false) pc.createDataChannel('data');
  const stream = new MediaStream();
  pc.ontrack = (e) => {
    if (me.closed || !e.track) return;
    stream.addTrack(e.track);
    if (stream.getVideoTracks().length) { videoEl.srcObject = stream; videoEl.play().catch(() => {}); setMsg(''); }
  };
  pc.onconnectionstatechange = () => { if (!me.closed && pc.connectionState === 'failed') setMsg('Connexion vidéo perdue.', true); };
  await pc.setLocalDescription(await pc.createOffer());
  await new Promise((ok) => {
    if (pc.iceGatheringState === 'complete') return ok();
    const t = setTimeout(ok, 2500);
    pc.addEventListener('icecandidate', (e) => { if (!e.candidate) { clearTimeout(t); ok(); } });
  });
  if (me.closed) return;
  const r = await homey.req(`/manager/videos/video/${videoObj.id}/offer`, { method: 'POST', body: { offer: pc.localDescription.sdp }, timeout: 30000 });
  if (me.closed) return;
  if (!r || typeof r.answerSdp !== 'string') throw new Error('réponse vidéo invalide');
  await pc.setRemoteDescription({ type: 'answer', sdp: r.answerSdp.replace(/a=sendrecv/g, 'a=sendonly') });
  if (r.streamId) {
    me.keep = setInterval(() => homey.req(`/manager/videos/video/${videoObj.id}/keep-alive`, { method: 'POST', body: { streamId: r.streamId } }).catch(() => {}), 60e3);
  }
}

function openLive(id) {
  const im = camImg[id] || {};
  const vo = videoOf(id);
  openSheet(`<div class="row between"><h3>${esc(nm(id))}</h3><div class="row"><button class="btn sm ghost" data-x="sound" ${vo ? '' : 'hidden'}>Son</button><button class="btn sm ghost" data-x="close">Fermer</button></div></div>
    <div class="live">
      ${im.url ? `<img class="live-poster" src="${im.url}" alt="">` : ''}
      <video class="live-video" autoplay playsinline muted></video>
      <div class="live-msg" data-msg>${vo ? 'Connexion au direct…' : 'Cette caméra ne propose pas de vidéo en direct dans Homey.'}</div>
      ${vo ? '<span class="live-badge">EN DIRECT</span>' : ''}
    </div>
    <p class="small" data-note>${vo ? 'Le direct passe par la Homey. Avec Arlo, la première tentative échoue parfois : le dashboard réessaie tout seul.' : (im.at ? 'Dernière image : ' + hhmm(im.at) + '.' : '')}</p>`, async (el) => {
    const video = el.querySelector('video');
    const msg = el.querySelector('[data-msg]');
    const setMsg = (t, err) => { msg.textContent = t; msg.hidden = !t; msg.classList.toggle('err', !!err); if (!t) el.querySelector('.live').classList.add('playing'); };
    const close = () => { stopLive(); closeSheet(); };
    el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-x]');
      if (!b) return;
      e.stopPropagation();
      if (b.dataset.x === 'close') close();
      if (b.dataset.x === 'sound') { video.muted = !video.muted; b.textContent = video.muted ? 'Son' : 'Couper le son'; video.play().catch(() => {}); }
    });
    $('#sheet-root .sheet-bg').addEventListener('click', (e) => { if (e.target.classList.contains('sheet-bg')) stopLive(); });
    if (!vo) return;
    for (let essai = 1; essai <= 2; essai++) {
      try {
        await startLive(vo, video, setMsg);
        // si aucune image n'arrive en 12 s, on retente une fois
        const ok = await new Promise((res) => { const t0 = Date.now(); const iv = setInterval(() => { if (!live) { clearInterval(iv); res(true); } else if (video.srcObject) { clearInterval(iv); res(true); } else if (Date.now() - t0 > 12000) { clearInterval(iv); res(false); } }, 300); });
        if (ok || !live) return;
        if (essai === 1) setMsg('La caméra se réveille, nouvel essai…');
      } catch (err) {
        if (!live && !st.sheet) return;
        if (essai === 1) { setMsg('La caméra se réveille, nouvel essai…'); continue; }
        setMsg(err.status === 403 ? 'La clé API n’a pas accès à la vidéo.' : 'Direct indisponible pour le moment. Réessaie dans un instant ou ouvre l’app Arlo.', true);
        return;
      }
    }
    if (live && !video.srcObject) { stopLive(); setMsg('Direct indisponible pour le moment. Réessaie dans un instant ou ouvre l’app Arlo.', true); }
  });
}

/* ---------- Actions ---------- */
const zTimers = {};
const pendingMode = {}; // pièce -> mode demandé, en attente de confirmation
const pendingSet = {};  // pièce -> consigne demandée, en attente de confirmation
// Interroge la Homey jusqu'à ce que la valeur demandée soit confirmée (ou délai dépassé)
async function attendre(id, c, v, delai) {
  const fin = Date.now() + delai;
  while (Date.now() < fin) {
    await new Promise((r) => setTimeout(r, 2500));
    try {
      const d = await homey.device(id);
      if (d) st.devices[id] = d;
      if (d?.capabilitiesObj?.[c]?.value === v) return true;
    } catch { /* on réessaie */ }
  }
  return false;
}
const actions = {
  ctvue({ id, v }) { cdVues[id] = v; store.set('consoTuiles2', cdVues); render(); },
  cvue({ v }) { cs.vue = v; cs.sel = null; store.set('consoVue', v); render(); },
  cbar({ i }) { cs.sel = cs.sel === +i ? null : +i; render(); },
  meteo() { openMeteo(); },
  info({ id }) { news.ouvert = news.ouvert === id ? null : id; render(); },
  tab({ id }) { st.tab = id; store.set('tab', id); render(); window.scrollTo({ top: 0 }); $('#view').scrollTop = 0; },
  settings() { openSettings(); },
  async blind({ id, v }) {
    await send(id, 'windowcoverings_state', v).catch(() => {});
    // garder la position cohérente avec l'état (sinon Homey garde deux informations contradictoires)
    if (v !== 'idle' && has(id, 'windowcoverings_set')) send(id, 'windowcoverings_set', v === 'up' ? 1 : 0, { optimistic: false }).catch(() => {});
    if (v !== 'idle') { st.lastReq[id] = { v: v === 'up' ? 100 : 0, t: Date.now() }; store.set('lastReq', st.lastReq); }
  },
  async portail() {
    const closed = cap(C.portail.capteur, 'garagedoor_closed');
    const ok = await confirmSheet(closed === false ? 'Fermer le portail ?' : 'Ouvrir le portail ?', 'Le portail va se mettre en mouvement.', closed === false ? 'Fermer' : 'Ouvrir');
    if (!ok) return;
    try {
      await homey.setCapability(C.portail.relais, 'onoff', true);
      setTimeout(() => homey.setCapability(C.portail.relais, 'onoff', false).catch(() => {}), 1000);
      toast('Commande envoyée au portail');
    } catch { toast('Commande non envoyée, Homey injoignable'); }
  },
  async hvac({ v }) {
    const g = C.chauffage.gainable;
    if (cap(g, 'cozytouch_hvac_mode') === v) return;
    const l = (hvacModes(g).find(([x]) => x === v) || [v, v])[1];
    if (!(await confirmSheet(`Passer le gainable en « ${l} » ?`, 'Le changement s’applique à toutes les pièces.', 'Changer'))) return;
    send(g, 'cozytouch_hvac_mode', v).catch(() => {});
  },
  async zmode({ id, flow, v }) {
    if (pendingMode[id]) { toast('Changement de mode déjà en cours…'); return; }
    if (cap(id, 'cozytouch_heating_mode') === v) return;
    const avant = cap(id, 'cozytouch_heating_mode');
    pendingMode[id] = { v, since: Date.now() };
    render();
    // 1) on demande directement le mode voulu (pas d'« inverser ») ; 2) secours : le flow de bascule
    try {
      await homey.setCapability(id, 'cozytouch_heating_mode', v);
    } catch (e) {
      try { await homey.triggerFlow(flow); }
      catch (e2) { delete pendingMode[id]; render(); toast(e2.status === 403 ? 'La clé n’a pas le droit de changer le mode' : 'Commande non envoyée'); return; }
    }
    // 3) on attend que la pièce confirme (jusqu'à 30 s)
    const ok = await attendre(id, 'cozytouch_heating_mode', v, 30000);
    delete pendingMode[id];
    if (ok) toast(`${nm(id)} : ${v === 'manual' ? 'passée en manuel, tu peux régler la consigne' : 'retour au programme'}`);
    else { setLocal(id, 'cozytouch_heating_mode', avant); toast(`${nm(id)} n’a pas confirmé le changement de mode. Réessaie dans un instant.`); }
    render();
  },
  zset({ id, v }) {
    if (pendingMode[id]) { toast('Attends que la pièce confirme le mode manuel'); return; }
    if (cap(id, 'cozytouch_heating_mode') !== 'manual') { toast('Passe d’abord la pièce en Manuel'); return; }
    const o = st.devices[id]?.capabilitiesObj?.target_temperature || {};
    const lo = typeof o.min === 'number' ? o.min : 7, hi = typeof o.max === 'number' ? o.max : 30;
    const t = clamp(Math.round(((cap(id, 'target_temperature') ?? 20) + Number(v)) * 2) / 2, lo, hi);
    if (t === cap(id, 'target_temperature')) { toast(`Consigne limitée entre ${nf(lo, 1)}° et ${nf(hi, 1)}°`); return; }
    setLocal(id, 'target_temperature', t); pendingSet[id] = t; render();
    clearTimeout(zTimers[id]);
    zTimers[id] = setTimeout(async () => {
      try { await homey.setCapability(id, 'target_temperature', t); }
      catch { delete pendingSet[id]; toast('Consigne non envoyée, Homey injoignable'); render(); return; }
      const ok = await attendre(id, 'target_temperature', t, 20000);
      delete pendingSet[id];
      if (!ok) toast(`${nm(id)} n’a pas gardé la consigne de ${nf(t, 1)}°. Vérifie qu’elle est bien en Manuel.`);
      render();
    }, 900);
  },
  zpower({ id }) { send(id, 'onoff', cap(id, 'onoff') === false).catch(() => {}); },
  // Une lampe marquée injoignable s'affiche éteinte : un appui essaie donc de l'allumer
  onoff({ id }) { const d = dev(id); const v = d && d.class === 'light' ? !lampOn(d) : !cap(id, 'onoff'); send(id, 'onoff', v).catch(() => {}); },
  zonelights({ ids, v }) { const on = v === 'on'; ids.split(',').filter(Boolean).forEach((id) => { if (cap(id, 'onoff') !== on) send(id, 'onoff', on).catch(() => {}); }); },
  zoneoff({ ids }) { ids.split(',').forEach((id) => { if (cap(id, 'onoff')) send(id, 'onoff', false).catch(() => {}); }); },
  cam({ id }) { openLive(id); },
  async plug({ id }) {
    const d = dev(id);
    const on = d ? !estInjoignable(d) && cap(id, 'onoff') === true : cap(id, 'onoff') === true;
    if (on && C.prisesProtegees.includes(id)) {
      const ok = await confirmSheet(`Couper « ${nm(id)} » ?`, 'Cet appareil est protégé : le couper peut interrompre un cycle ou un équipement.', 'Couper');
      if (!ok) return;
    }
    send(id, 'onoff', !on).catch(() => {});
  },
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const fn = actions[el.dataset.act];
  if (fn) { e.preventDefault(); fn(el.dataset, el); }
});

document.addEventListener('input', (e) => {
  const r = e.target.closest('input[type=range]');
  if (!r) return;
  st.lastTouch = Date.now();
  r.style.setProperty('--p', `${((r.value - r.min) / (r.max - r.min)) * 100}%`);
  if (r.dataset.range === 'blind') { const l = document.querySelector(`[data-pos="${r.dataset.id}"]`); if (l) l.textContent = `${r.value} %`; }
});

document.addEventListener('change', (e) => {
  const r = e.target.closest('input[data-range]');
  if (!r) return;
  const id = r.dataset.id, v = Number(r.value) / 100;
  if (r.dataset.range === 'blind') {
    st.lastReq[id] = { v: Number(r.value), t: Date.now() }; store.set('lastReq', st.lastReq);
    send(id, 'windowcoverings_set', v, { optimistic: false }).catch(() => {});
    // à fond en haut ou en bas : l'état suit aussi
    if (has(id, 'windowcoverings_state') && (v >= 0.99 || v <= 0.01)) send(id, 'windowcoverings_state', v >= 0.99 ? 'up' : 'down', { optimistic: false }).catch(() => {});
  } else if (r.dataset.range === 'dim') {
    send(id, 'dim', v, { optimistic: false }).catch(() => {});
  }
});

['pointerdown', 'keydown'].forEach((ev) => document.addEventListener(ev, () => { st.lastTouch = Date.now(); wake(); }, { passive: true }));

/* ---------- Verrou des réglages : Face ID (clé d'accès) ou code ---------- */
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
async function sha(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return b64(d);
}

async function faceId() {
  if (!lock.cred || !window.PublicKeyCredential) return false;
  try {
    await navigator.credentials.get({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        allowCredentials: [{ type: 'public-key', id: unb64(lock.cred) }],
        userVerification: 'required',
        timeout: 60000,
      },
    });
    return true;
  } catch { return false; }
}

async function registerFaceId() {
  try {
    const cred = await navigator.credentials.create({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        rp: { name: 'Dashboard Maison' },
        user: { id: crypto.getRandomValues(new Uint8Array(16)), name: 'proprietaire', displayName: 'Propriétaire' },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'preferred' },
        timeout: 60000,
      },
    });
    lock.cred = b64(cred.rawId);
    store.set('lock', lock);
    return true;
  } catch { return false; }
}

function pinPad(title) {
  return new Promise((resolve) => {
    let code = '';
    const draw = (el) => { el.querySelector('.pin').innerHTML = [0, 1, 2, 3].map((i) => `<span class="${i < code.length ? 'f' : ''}"></span>`).join(''); };
    openSheet(`<h3 style="text-align:center">${esc(title)}</h3><div class="pin"></div>
      <div class="keypad">${[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `<button data-k="${n}">${n}</button>`).join('')}<button data-k="x" aria-label="Annuler">✕</button><button data-k="0">0</button><button data-k="b" aria-label="Effacer">⌫</button></div>`, (el) => {
      draw(el);
      el.addEventListener('click', (e) => {
        const b = e.target.closest('[data-k]');
        if (!b) return;
        e.stopPropagation();
        const k = b.dataset.k;
        if (k === 'x') { closeSheet(); resolve(null); return; }
        if (k === 'b') code = code.slice(0, -1); else if (code.length < 4) code += k;
        draw(el);
        if (code.length === 4) { const c = code; setTimeout(() => { closeSheet(); resolve(c); }, 120); }
      });
    });
    const bg = $('#sheet-root .sheet-bg');
    bg.addEventListener('click', (e) => { if (e.target === bg) resolve(null); });
  });
}

let fails = 0, blockedUntil = 0;
async function unlock() {
  if (!lock.hash) return true; // pas encore de code : première configuration
  if (Date.now() < st.unlockedUntil) return true;
  if (await faceId()) { st.unlockedUntil = Date.now() + 5 * 60e3; return true; }
  if (Date.now() < blockedUntil) { toast('Trop d’essais, réessaie dans 30 secondes'); return false; }
  const c = await pinPad('Code des réglages');
  if (c == null) return false;
  if ((await sha(lock.salt + c)) === lock.hash) { fails = 0; st.unlockedUntil = Date.now() + 5 * 60e3; return true; }
  fails += 1;
  if (fails >= 5) { blockedUntil = Date.now() + 30e3; fails = 0; }
  toast('Code incorrect');
  return false;
}

async function setPin() {
  const a = await pinPad('Nouveau code (4 chiffres)');
  if (a == null) return false;
  const b = await pinPad('Confirme le code');
  if (b == null) return false;
  if (a !== b) { toast('Les deux codes ne correspondent pas'); return false; }
  lock.salt = b64(crypto.getRandomValues(new Uint8Array(16)));
  lock.hash = await sha(lock.salt + a);
  store.set('lock', lock);
  toast('Code enregistré');
  return true;
}

/* ---------- Réglages ---------- */
async function openSettings(scroll = 0) {
  if (!(await unlock())) return;
  const motion = visible().filter((d) => has(d.id, 'alarm_motion'));
  const users = Object.values(st.users || {});
  const styleSeg = [['line', 'Trait fin'], ['solid', 'Plein'], ['color', 'Couleur']];
  const av = C.presence.map((id) => {
    const a = S.avatars[id] || {};
    return `<div class="card set-card" data-av="${id}"><h2>Avatar</h2>
      <div class="row" style="gap:18px;align-items:stretch">${avatarHTML(id, 'tile set-tile')}
        <div style="flex:1;min-width:0">
          <div class="field"><label>Compte Homey</label><select data-s="avuser" data-id="${id}"><option value="">Automatique</option>${users.map((u) => `<option value="${esc(u.id)}" ${a.user === u.id ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}</select></div>
          <div class="row wrap"><label class="btn sm ghost" style="padding:0 14px">Choisir une photo<input type="file" accept="image/*" data-s="avphoto" data-id="${id}" hidden></label>${a.photo ? `<button class="btn sm ghost" data-s-act="avreset" data-id="${id}">Revenir à l’avatar Homey</button>` : ''}</div>
        </div></div>
      <div class="field" style="margin-top:14px"><label>Avatars de saison <span class="muted">· saison actuelle : ${SAISONS.find(([k]) => k === saison())[1]}</span></label>
        <div class="av-saisons">${[...SAISONS, ['sortie', 'Sortir'], ['soiree', 'Soirée']].map(([k, l]) => `<div class="av-s ${k === saison() ? 'now' : ''}">
          <label class="av-s-img">${a.saisons?.[k] ? `<img src="${esc(a.saisons[k])}" alt="">` : `<span>+</span>`}<input type="file" accept="image/*" data-s="avsaison" data-id="${id}" data-saison="${k}" hidden></label>
          <span class="small">${l}</span>${a.saisons?.[k] ? `<button class="av-s-del" data-s-act="avsaisondel" data-id="${id}" data-saison="${k}" aria-label="Retirer">×</button>` : ''}</div>`).join('')}</div>
        <span class="hint">L’avatar change tout seul le 20 mars, le 21 juin, le 22 septembre et le 21 décembre.</span></div>
      <div class="field"><label>Heures de l’avatar « Soirée »</label><div class="row" style="gap:10px;align-items:center"><span class="small muted">de</span><input type="time" data-s="avsoirde" data-id="${id}" value="${esc(a.soirDe || '19:00')}" style="width:auto"><span class="small muted">à</span><input type="time" data-s="avsoira" data-id="${id}" value="${esc(a.soirA || '07:00')}" style="width:auto"></div>
        <span class="hint">« Sortir » s’affiche (en gris) quand la personne est absente. « Soirée » s’affiche à la maison pendant ces heures.</span></div>
      <div class="field"><label>Zoom</label><input type="range" min="1" max="3" step="0.05" value="${a.zoom || 1}" data-s="avzoom" data-id="${id}"></div>
      <div class="field"><label>Centrage horizontal</label><input type="range" min="-30" max="30" step="1" value="${a.x || 0}" data-s="avx" data-id="${id}"></div>
      <div class="field"><label>Centrage vertical</label><input type="range" min="-30" max="30" step="1" value="${a.y || 0}" data-s="avy" data-id="${id}"></div>
    </div>`;
  }).join('');

  openSheet(`<div class="set-head"><h1>Réglages</h1><button class="btn primary" data-s-act="close">Fermer</button></div>
  ${users.length ? '' : '<div class="card set-note">La Homey ne donne pas la liste des comptes : la clé API n’a sans doute pas le droit « Utilisateurs : voir ». Sans lui, les avatars Homey ne s’affichent pas (tu peux mettre une photo à la place).</div>'}
  <div class="grid set-grid">

    <div class="card set-card"><h2>Connexion à la Homey</h2>
      <div class="field"><label>Adresse de la Homey</label><input type="text" inputmode="url" name="homey-adresse" autocomplete="off" data-lpignore="true" data-1p-ignore data-s="homeyUrl" value="${esc(S.homeyUrl)}" placeholder="exemple : https://192-168-1-XX.homey.homeylocal.com" autocapitalize="off" autocorrect="off" spellcheck="false"><span class="hint">Adresse locale sécurisée, utilisée à la maison.</span></div>
      <div class="field"><label>Adresse hors de la maison</label><input type="text" inputmode="url" name="homey-cloud" autocomplete="off" data-lpignore="true" data-1p-ignore data-s="homeyCloud" value="${esc(S.homeyCloud)}" placeholder="exemple : https://xxxxxxxx.connect.athom.com" autocapitalize="off" autocorrect="off" spellcheck="false"><span class="hint">Adresse cloud de la Homey. Le dashboard y passe tout seul quand l’adresse locale ne répond pas.</span></div>
      <div class="field"><label>Clé API</label><input type="text" class="secret" data-s="cle" value="${esc(S.cle)}" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" name="homey-api-key" data-lpignore="true" data-1p-ignore><span class="hint">Elle reste sur cet appareil.</span></div>
      <div class="row wrap"><button class="btn sm" data-s-act="test">Tester la connexion</button><span class="small muted" data-test></span></div>
    </div>

    <div class="card set-card"><h2>Météo</h2>
      <div class="field"><label>Commune affichée</label><div class="mid" style="font-size:22px">${S.commune ? esc(S.commune) : '<span class="muted">Aucune</span>'}</div></div>
      ${(S.favoris || []).length ? `<div class="field"><label>Favoris (touche pour choisir)</label><div class="chips">${S.favoris.map((f, i) => `<span class="chip ${f.name === S.commune && f.lat === S.lat ? 'on' : ''}"><button data-s-act="favpick" data-i="${i}">${esc(f.name)}${f.admin ? ` <span class="muted">${esc(f.admin)}</span>` : ''}</button><button class="x" data-s-act="favdel" data-i="${i}" aria-label="Retirer">×</button></span>`).join('')}</div></div>` : ''}
      <div class="field"><label>Ajouter une commune</label><div class="row"><input type="text" data-s="communeQ" value="" placeholder="ex. : Montpellier" style="flex:1"><button class="btn sm" data-s-act="geo">Chercher</button></div><span class="hint" data-geo>Les communes choisies sont gardées en favoris.</span><div class="chips" data-georesults></div></div>
    </div>

    <div class="card set-card"><h2>Électricité</h2>
      <div class="field"><label>Prix du kWh TTC (€)</label><input type="number" step="0.0001" min="0" data-s="prixKwh" value="${S.prixKwh}"></div>
      <div class="field"><label>Abonnement TTC (€/mois)</label><input type="number" step="0.01" min="0" data-s="aboMois" value="${S.aboMois}"></div>
      <div class="field"><label>Capacité de la batterie (kWh)</label><input type="number" step="0.1" min="0" data-s="battKwh" value="${S.battKwh}"><span class="hint">Sert à calculer l’énergie restante</span></div>
      <div class="field"><label>Coefficient FHE</label><input type="number" step="0.01" min="0" max="3" data-s="coefFHE" value="${S.coefFHE}"><span class="hint">FHE = Hoymiles × ce nombre</span></div>
    </div>

    <div class="card set-card"><h2>Thème et écran</h2>
      <div class="field"><label>Image de la maison (page Énergie)</label><input type="file" accept="image/*" data-s="maisonimg">${maisonCache ? '<button class="btn sm" data-s-act="maisonoff">Retirer l’image</button>' : ''}<span class="hint">Gardée sur cet iPad uniquement. Les lignes d’énergie sont posées dessus.</span></div>
      <div class="field"><label>Thème</label><div class="seg">${[['auto', 'Système'], ['light', 'Clair'], ['dark', 'Sombre']].map(([v, l]) => `<button class="${(S.theme || 'auto') === v ? 'on' : ''}" data-s-act="theme" data-v="${v}">${l}</button>`).join('')}</div><span class="hint">« Système » suit le réglage clair / sombre de l’iPad.</span></div>
      <div class="field"><label>Style des icônes</label><div class="seg">${styleSeg.map(([v, l]) => `<button class="${S.iconStyle === v ? 'on' : ''}" data-s-act="style" data-v="${v}">${l}</button>`).join('')}</div></div>
      <div class="row between" style="margin:8px 0 12px;gap:14px"><div><div>Réveil à l’approche</div><div class="small muted">L’écran s’éteint après 3 min et se rallume quand le détecteur voit quelqu’un.</div></div><button class="switch ${S.reveil ? 'on' : ''}" data-s-act="reveil"></button></div>
      ${S.reveil ? `<div class="field"><label>Détecteur de mouvement</label><select data-s="reveilCapteur"><option value="">Choisir…</option>${motion.map((d) => `<option value="${d.id}" ${S.reveilCapteur === d.id ? 'selected' : ''}>${esc(nm(d.id))}</option>`).join('')}</select><span class="hint">Jamais la caméra de l’iPad.</span></div>` : ''}
    </div>

    ${av}

    <div class="card set-card"><h2>Verrou des réglages</h2>
      ${lock.hash ? '<p class="small muted" style="margin-top:0">Les réglages s’ouvrent avec Face ID ou ton code.</p>' : '<p class="small" style="color:var(--warn);margin-top:0">Aucun code pour l’instant : choisis-en un pour protéger les réglages.</p>'}
      <div class="row wrap"><button class="btn sm" data-s-act="pin">${lock.hash ? 'Changer le code' : 'Choisir un code'}</button>
      ${lock.hash ? (lock.cred ? '<button class="btn sm ghost" data-s-act="faceoff">Retirer Face ID</button>' : '<button class="btn sm" data-s-act="faceon">Activer Face ID</button>') : ''}</div>
    </div>
  </div>`, (el) => { bindSettings(el); if (scroll) el.scrollTop = scroll; }, 'full');
  paintRanges();
}

function bindSettings(el) {
  const reopen = () => { const sc = el.scrollTop; closeSheet(); st.unlockedUntil = Math.max(st.unlockedUntil, Date.now() + 60e3); openSettings(sc); };
  const avs = (id) => (S.avatars[id] = S.avatars[id] || {});
  const applyAvatar = (id) => {
    const box = el.querySelector(`[data-av="${id}"] .avatar`);
    if (box) box.outerHTML = avatarHTML(id, 'tile set-tile');
  };

  el.addEventListener('change', async (e) => {
    const t = e.target, k = t.dataset.s;
    if (!k) return;
    if (k === 'homeyUrl' || k === 'cle' || k === 'homeyCloud') {
      let val = t.value.trim();
      if (k !== 'cle' && val && !/^https?:\/\//.test(val)) val = 'https://' + val;
      S[k] = val; saveSettings();
      homey = new Homey(S.homeyUrl, S.cle, S.homeyCloud);
    } else if (['prixKwh', 'aboMois', 'coefFHE', 'battKwh'].includes(k)) {
      const n = parseFloat(String(t.value).replace(',', '.'));
      if (!Number.isNaN(n)) { S[k] = n; saveSettings(); }
    } else if (k === 'reveilCapteur') { S.reveilCapteur = t.value; saveSettings(); }
    else if (k === 'avuser') { avs(t.dataset.id).user = t.value || undefined; saveSettings(); applyAvatar(t.dataset.id); }
    else if ((k === 'avsoirde' || k === 'avsoira') && t.value) { avs(t.dataset.id)[k === 'avsoirde' ? 'soirDe' : 'soirA'] = t.value; saveSettings(); applyAvatar(t.dataset.id); }
    else if (k === 'avsaison' && t.files?.[0]) {
      const data = await shrink(t.files[0], 360);
      const a = avs(t.dataset.id);
      a.saisons = { ...(a.saisons || {}), [t.dataset.saison]: data };
      if (!saveSettings2()) { delete a.saisons[t.dataset.saison]; toast('Image trop lourde pour la mémoire de l’iPad'); }
      reopen();
    }
    else if (k === 'maisonimg' && t.files?.[0]) {
      const data = await shrink(t.files[0], 1200);
      if (store.set('maisonImg', data)) { maisonCache = data; toast('Image de la maison enregistrée'); } else toast('Image trop lourde pour la mémoire de l’iPad');
      reopen();
    }
    else if (k === 'avphoto' && t.files?.[0]) {
      const data = await shrink(t.files[0]);
      const a = avs(t.dataset.id);
      a.photo = data; a.zoom = 1; a.x = 0; a.y = 0;
      saveSettings(); reopen();
    }
  });

  el.addEventListener('input', (e) => {
    const t = e.target, k = t.dataset.s;
    if (!['avzoom', 'avx', 'avy'].includes(k)) return;
    const a = avs(t.dataset.id);
    a[{ avzoom: 'zoom', avx: 'x', avy: 'y' }[k]] = Number(t.value);
    saveSettings(); applyAvatar(t.dataset.id);
  });

  el.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-s-act]');
    if (!b) return;
    e.stopPropagation();
    const a = b.dataset.sAct;
    if (a === 'maisonoff') { store.set('maisonImg', null); maisonCache = null; reopen(); return; }
    if (a === 'close') { closeSheet(); refresh(); refreshSlow(); refreshWeather(true); refreshCurve(true); }
    else if (a === 'test') {
      const out = el.querySelector('[data-test]');
      out.textContent = 'Test…';
      // chaque adresse testée séparément, puis la lecture de l'historique (courbe Énergie)
      const essai = async (url) => {
        if (!url) return 'non renseignée';
        try { const d = await new Homey(url, S.cle).devices(); return `OK (${Object.keys(d).length} appareils)`; }
        catch (err) { return err.status === 401 || err.status === 403 ? 'clé refusée' : 'ne répond pas'; }
      };
      const [loc, dist] = await Promise.all([essai(S.homeyUrl), essai(S.homeyCloud)]);
      const h = new Homey(S.homeyUrl, S.cle, S.homeyCloud);
      const hist = (await h.insights(C.energie.linky, 'energy_power', 'today')) || (await h.insights(C.energie.linky, 'measure_power', 'today'));
      const histTxt = hist?.length ? `OK (${hist.length} points depuis minuit)` : h.insightsErr === 401 || h.insightsErr === 403 ? `refusé (code ${h.insightsErr}) : droit « Journaux » manquant sur la clé` : `non lu${h.insightsErr ? ` (code ${h.insightsErr})` : ''}`;
      const det = !hist?.length && h.insightsDetail ? `<br><span class="muted">Réponse de la Homey : ${esc(h.insightsDetail)}</span>` : '';
      out.innerHTML = `À la maison : <b>${loc}</b><br>Hors de la maison : <b>${dist}</b><br>Historique énergie : <b>${histTxt}</b>${det}<br><span class="muted">Clé utilisée : …${esc(S.cle.slice(-4))}</span>`;
      if (loc.startsWith('OK') || dist.startsWith('OK')) refreshSlow();
    } else if (a === 'geo') {
      const q = el.querySelector('[data-s="communeQ"]').value.trim();
      const out = el.querySelector('[data-geo]');
      const box = el.querySelector('[data-georesults]');
      if (!q) return;
      out.textContent = 'Recherche…'; box.innerHTML = '';
      try {
        const r = await geocode(q);
        if (!r.length) { out.textContent = 'Commune introuvable.'; return; }
        out.textContent = 'Touche la bonne commune :';
        el._geo = r;
        box.innerHTML = r.map((c, i) => `<span class="chip"><button data-s-act="geopick" data-i="${i}">${esc(c.name)} <span class="muted">${esc(c.admin2 || c.admin1 || '')}</span></button></span>`).join('');
      } catch { out.textContent = 'Recherche impossible pour le moment.'; }
    } else if (a === 'geopick' || a === 'favpick') {
      const src = a === 'geopick' ? el._geo?.[b.dataset.i] : S.favoris?.[b.dataset.i];
      if (!src) return;
      const f = a === 'geopick'
        ? { name: src.name, admin: src.admin2 || src.admin1 || '', lat: Math.round(src.latitude * 100) / 100, lon: Math.round(src.longitude * 100) / 100 }
        : src;
      S.commune = f.name; S.lat = f.lat; S.lon = f.lon;
      S.favoris = [f, ...(S.favoris || []).filter((x) => !(x.lat === f.lat && x.lon === f.lon))].slice(0, 10);
      saveSettings(); refreshWeather(true); reopen();
    } else if (a === 'favdel') {
      S.favoris = (S.favoris || []).filter((_, i) => String(i) !== b.dataset.i);
      saveSettings(); reopen();
    } else if (a === 'theme') { S.theme = b.dataset.v; saveSettings(); applyTheme(); reopen();
    } else if (a === 'style') { S.iconStyle = b.dataset.v; saveSettings(); renderTabs(); reopen(); }
    else if (a === 'reveil') { S.reveil = !S.reveil; saveSettings(); reopen(); }
    else if (a === 'avsaisondel') { const x = avs(b.dataset.id); if (x.saisons) delete x.saisons[b.dataset.saison]; saveSettings(); reopen(); }
    else if (a === 'avreset') { delete avs(b.dataset.id).photo; saveSettings(); reopen(); }
    else if (a === 'pin') { const sc = el.scrollTop; closeSheet(); await setPin(); st.unlockedUntil = Date.now() + 60e3; openSettings(sc); }
    else if (a === 'faceon') { const ok = await registerFaceId(); toast(ok ? 'Face ID activé' : 'Face ID non activé'); reopen(); }
    else if (a === 'faceoff') { lock.cred = null; store.set('lock', lock); reopen(); }
  });
}

function shrink(file, max = 640) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const s = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(img.src);
      resolve(c.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

/* ---------- Veille / réveil (désactivé par défaut) ---------- */
let sleepTimer;
function armSleep() {
  clearTimeout(sleepTimer);
  if (!S.reveil || !S.reveilCapteur) return;
  sleepTimer = setTimeout(() => { if (!st.sheet) $('#sleep').hidden = false; }, 3 * 60e3);
}
function wake() { $('#sleep').hidden = true; armSleep(); }
function wakeOnMotion() { if (S.reveil && S.reveilCapteur && cap(S.reveilCapteur, 'alarm_motion') === true && !$('#sleep').hidden) wake(); }

/* ---------- Plein écran (sans les barres du navigateur) ---------- */
const fsEl = () => document.fullscreenElement || document.webkitFullscreenElement;
const fsOk = () => Boolean(document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen);
// pleinVoulu : le plein écran a été demandé avec le bouton et pas quitté avec lui.
// Si Safari en sort tout seul (geste de glissement), le prochain toucher le relance.
let pleinVoulu = false;
// Lancé depuis l'icône de l'écran d'accueil : pas de barres Safari, donc rien à quitter.
// C'est le seul plein écran que les gestes de l'iPad ne peuvent pas interrompre.
const appli = () => navigator.standalone === true || matchMedia('(display-mode: standalone)').matches || matchMedia('(display-mode: fullscreen)').matches;
document.documentElement.classList.toggle('appli', appli());
function paintFullBtn() {
  const b = $('#btn-full');
  if (!b) return;
  b.hidden = appli() || !fsOk();
  const on = Boolean(fsEl());
  document.documentElement.classList.toggle('fs', on);
  b.innerHTML = icon(on ? 'reduire' : 'pleinecran', 'line');
  b.setAttribute('aria-label', on ? 'Quitter le plein écran' : 'Plein écran');
}
async function entrerPlein() {
  const d = document.documentElement;
  await (d.requestFullscreen || d.webkitRequestFullscreen).call(d);
}
async function toggleFull() {
  try {
    if (fsEl()) { pleinVoulu = false; await (document.exitFullscreen || document.webkitExitFullscreen).call(document); }
    else {
      pleinVoulu = true; await entrerPlein();
      // une fois : expliquer comment avoir un plein écran qui ne saute jamais
      if (!store.get('astuceAccueil', false)) { store.set('astuceAccueil', true); setTimeout(astuceAccueil, 600); }
    }
  } catch { toast('Plein écran refusé par le navigateur'); }
  paintFullBtn();
}
function astuceAccueil() {
  openSheet(`<h3>Un plein écran qui ne saute plus</h3>
    <p>Dans Safari, le plein écran peut s’arrêter quand le doigt glisse : l’iPad le décide, la page ne peut pas l’empêcher.</p>
    <p>Pour l’avoir en permanence : dans Safari, touche <b>Partager</b> puis <b>Sur l’écran d’accueil</b>, et ouvre ensuite le dashboard avec l’icône « Maison ». Il s’affiche alors sans aucune barre, et le glissement fait seulement défiler la page.</p>
    <p class="small muted">L’app de l’écran d’accueil a sa propre mémoire : il faudra y saisir une fois les adresses et la clé dans les réglages.</p>
    <div class="actions"><button class="btn primary" data-x="ok">Compris</button></div>`, (el) => {
    el.addEventListener('click', (e) => { if (e.target.closest('[data-x]')) closeSheet(); });
  });
}
function changementPlein() {
  paintFullBtn();
  if (!fsEl() && pleinVoulu) toast('Touche l’écran pour revenir en plein écran. Sans coupure : ajoute le dashboard à l’écran d’accueil.');
}
document.addEventListener('fullscreenchange', changementPlein);
document.addEventListener('webkitfullscreenchange', changementPlein);
// Le navigateur n'autorise le plein écran qu'après un geste : on profite du prochain toucher
document.addEventListener('pointerup', (e) => {
  if (!pleinVoulu || fsEl() || e.target.closest('#btn-full')) return;
  entrerPlein().catch(() => {});
}, true);

/* ---------- Actualiser sans quitter le plein écran ---------- */
// 1) relit tout dans la Homey et sur Internet (météo), la page reste en plein écran ;
// 2) si une nouvelle version a été mise sur GitHub, recharge la page pour la prendre.
const VERSION = new URL(import.meta.url).searchParams.get('v') || '';
async function actualiser() {
  const b = $('#btn-refresh');
  if (b.classList.contains('turn')) return;
  b.classList.add('turn');
  try {
    const r = await fetch(`index.html?t=${Date.now()}`, { cache: 'no-store' });
    const html = r.ok ? await r.text() : '';
    const v = (html.match(/app\.js\?v=([\w-]+)/) || [])[1];
    if (v && VERSION && v !== VERSION) {
      toast('Nouvelle version du dashboard : rechargement…');
      setTimeout(() => location.reload(), 900);
      return;
    }
  } catch { /* pas de vérification de version hors ligne */ }
  try {
    cd.cache = {}; cs.at = 0;
    await refresh();
    await Promise.all([refreshSlow(), refreshWeather(true), refreshCurve(true), refreshCameras(true), refreshConso(true), refreshNews(true)].map((p) => Promise.resolve(p).catch(() => {})));
    render();
    toast(st.ok ? 'Données actualisées' : 'Homey injoignable');
  } finally { b.classList.remove('turn'); }
}

/* ---------- Démarrage ---------- */
$('#btn-refresh').addEventListener('click', actualiser);
$('#btn-settings').addEventListener('click', () => openSettings());
$('#btn-full').addEventListener('click', toggleFull);
paintFullBtn();
tick(); setInterval(tick, 10e3);
render();
refresh().then(() => { seedIdx(); refreshSlow(); refreshCurve(true); refreshCameras(true); refreshBattJour(); });
refreshWeather(true);
setInterval(refresh, 5e3);
setInterval(refreshSlow, 10 * 60e3);
setInterval(() => { refreshWeather(); refreshCurve(); refreshCameras(); refreshBattJour(); }, 60e3);
// Au réveil de l'iPad (écran déverrouillé, retour dans Safari ou l'app) : on relit tout de suite
// l'historique de la Homey, qui a continué d'enregistrer pendant la veille → courbe sans trou
const auReveil = () => { if (!document.hidden) { refresh(); refreshWeather(); refreshCurve(true); } };
document.addEventListener('visibilitychange', auReveil);
window.addEventListener('pageshow', auReveil);
window.addEventListener('focus', auReveil);
armSleep();
