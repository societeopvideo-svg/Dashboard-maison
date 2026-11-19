import { CONFIG as C, DEFAUTS } from './config.js?v=20261119c';
import { Homey, forecast, geocode } from './api.js?v=20261119c';
import { icon, TABS } from './icons.js?v=20261119c';

/* ---------- Stockage local (iPad uniquement) ---------- */
const LS = 'maison.v1.';
const store = {
  get(k, d) { try { const v = localStorage.getItem(LS + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(LS + k, JSON.stringify(v)); return true; } catch { return false; } },
};

let S = { ...DEFAUTS, ...store.get('settings', {}) };
let lock = store.get('lock', { hash: null, salt: null, cred: null });
const saveSettings = () => { if (!store.set('settings', S)) toast('Mémoire de l’iPad pleine : réglage non enregistré'); };

const st = {
  devices: {}, zones: {}, users: {},
  ok: false, err: null, wx: null, wxAt: 0, curve: null, curveAt: 0,
  tab: store.get('tab', 'accueil'), lastTouch: 0, sheet: false, unlockedUntil: 0,
  lastReq: store.get('lastReq', {}), garageSince: store.get('garageSince', null),
};
let homey = new Homey(S.homeyUrl, S.cle);
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
  if (o) o.value = v;
}

async function send(id, c, v, { optimistic = true } = {}) {
  const before = cap(id, c);
  if (optimistic) { setLocal(id, c, v); render(); }
  try {
    await homey.setCapability(id, c, v);
  } catch (e) {
    setLocal(id, c, before);
    render();
    toast(e.status === 403 ? 'La clé n’a pas le droit de commander cet appareil' : 'Commande non envoyée, Homey injoignable');
    throw e;
  }
}

/* ---------- Horloge ---------- */
function tick() {
  const d = new Date();
  $('#time').textContent = d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  const txt = d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
  $('#date').textContent = txt.charAt(0).toUpperCase() + txt.slice(1);
}

function setStatus() {
  const s = $('#status');
  s.className = 'status ' + (!homey.ready ? '' : st.ok ? 'ok' : 'err');
  s.title = !homey.ready ? 'Non configuré' : st.ok ? 'Homey connectée' : 'Homey injoignable';
}

/* ---------- Données ---------- */
async function refresh() {
  if (!homey.ready) { setStatus(); return; }
  try {
    st.devices = await homey.devices();
    st.ok = true; st.err = null;
    trackGarage();
    sample();
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
  const [sol, achat] = await Promise.all([
    homey.insights(C.energie.solaire, 'measure_power'),
    homey.insights(C.energie.linky, 'measure_power'),
  ]);
  st.curve = sol && achat ? { sol, achat } : null;
  maybeRender();
}

// Échantillons locaux si l'historique Homey n'est pas lisible
function sample() {
  const now = Date.now();
  const key = 'samples.' + new Date().toISOString().slice(0, 10);
  const arr = store.get(key, []);
  if (arr.length && now - arr[arr.length - 1].t < 60e3) return;
  const e = energyNow();
  if (e.prod == null && e.achat == null) return;
  arr.push({ t: now, p: e.prod ?? 0, a: e.achat ?? 0 });
  store.set(key, arr.slice(-1500));
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(LS + 'samples.') && k !== LS + key) localStorage.removeItem(k);
  }
}

function trackGarage() {
  const closed = cap(C.portail.capteur, 'garagedoor_closed');
  if (closed === false && !st.garageSince) st.garageSince = Date.now();
  if (closed === true) st.garageSince = null;
  store.set('garageSince', st.garageSince);
}

function maybeRender() {
  if (st.sheet || Date.now() - st.lastTouch < 3500) return;
  render();
}

/* ---------- Calculs énergie ---------- */
function energyNow() {
  const hoy = cap(C.energie.solaire, 'measure_power');
  const fhe = hoy == null ? null : hoy * S.coefFHE;
  const prod = hoy == null ? null : hoy + fhe;
  const achatBrut = cap(C.energie.linky, 'measure_power');
  const revente = cap(C.energie.linky, 'apparent_power_instant_inject_capability') || 0;
  const achat = revente > 0 ? 0 : achatBrut;
  const kwhJour = cap(C.energie.compteur, 'meter_kwh_this_day');
  const aboJour = (S.aboMois * 12) / 365;
  const cout = kwhJour == null ? null : kwhJour * S.prixKwh + aboJour;
  const auto = prod && prod > 50 ? clamp((prod - revente) / prod, 0, 1) : null;
  const prodJour = cap(C.energie.solaire, 'meter_power.today');
  return { hoy, fhe, prod, achat, revente, kwhJour, aboJour, cout, auto, prodJourKwh: prodJour == null ? null : prodJour * (1 + S.coefFHE) };
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
  if (st.garageSince && Date.now() - st.garageSince > A.portailMinutes * 60e3) {
    out.push({ lvl: 'warn', txt: 'Portail du garage ouvert', when: `depuis ${Math.round((Date.now() - st.garageSince) / 60e3)} min`, tab: 'volets' });
  }
  const vide = nobodyHome();
  if (vide) {
    A.baies.forEach((id) => { if (cap(id, 'alarm_contact') === true) out.push({ lvl: 'warn', txt: `${nm(id)} : ouverte`, sub: 'Maison vide' }); });
    A.cameras.forEach((id) => { if (cap(id, 'alarm_motion') === true) out.push({ lvl: 'warn', txt: `Mouvement : ${nm(id)}`, sub: 'Maison vide' }); });
  }
  visible().forEach((d) => {
    const b = d.capabilitiesObj?.measure_battery?.value;
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
}

function render() {
  renderTabs();
  const v = $('#view');
  if (!homey.ready) { v.innerHTML = viewSetup(); return; }
  if (!Object.keys(st.devices).length) {
    v.innerHTML = `<div class="empty">${st.err ? 'Homey injoignable. Vérifie que l’iPad est sur le Wi-Fi de la maison, puis l’adresse dans les réglages.' : 'Connexion à la Homey…'}</div>`;
    return;
  }
  const views = { accueil: viewHome, volets: viewBlinds, chauffage: viewHeat, energie: viewEnergy, eclairage: viewLights, prises: viewPlugs };
  try { v.innerHTML = (views[st.tab] || viewHome)(); }
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

function cardWeather() {
  const M = C.meteo;
  const t = cap(M.exterieur, 'measure_temperature');
  let fc = '<p class="small muted" style="margin:16px 0 0">Indique la commune dans les réglages pour afficher les prévisions.</p>';
  if (st.wx?.daily) {
    const d = st.wx.daily;
    fc = '<div class="forecast">' + [0, 1, 2].map((i) => {
      const label = i === 0 ? 'Aujourd’hui' : new Date(d.time[i]).toLocaleDateString('fr-FR', { weekday: 'long' });
      return `<div><span style="text-transform:capitalize">${label}</span><span class="wx">${WX(d.weather_code[i])}</span><b>${nf(d.temperature_2m_max[i], 0)}°</b> · ${nf(d.temperature_2m_min[i], 0)}°<br><span class="small">pluie ${nf(d.precipitation_probability_max[i], 0)} %</span></div>`;
    }).join('') + '</div>';
  }
  return `<div class="card">
    <h2>Météo</h2>
    <div class="meteo-now">
      <div class="big">${nf(t, 1)}<span class="unit">°C</span></div>
      <div class="meteo-facts">
        <span>Humidité</span><b>${nf(cap(M.exterieur, 'measure_humidity'), 0)} %</b>
        <span>Vent</span><b>${nf(cap(M.vent, 'measure_wind_strength'), 0)} km/h ${DIR(cap(M.vent, 'measure_wind_angle'))}</b>
        <span>Rafales</span><b>${nf(cap(M.vent, 'measure_gust_strength'), 0)} km/h</b>
        <span>Pluie 24 h</span><b>${nf(cap(M.pluie, 'measure_rain.24h'), 1)} mm</b>
        <span>Pression</span><b>${nf(cap(M.station, 'measure_pressure'), 0)} hPa</b>
      </div>
    </div>${fc}
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
  const day0 = new Date(); day0.setHours(0, 0, 0, 0);
  const k = 1 + S.coefFHE;
  if (st.curve) {
    return {
      day0,
      prod: st.curve.sol.map((p) => ({ t: p.t, v: p.v * k })),
      achat: st.curve.achat.map((p) => ({ t: p.t, v: p.v })),
      src: 'Homey',
    };
  }
  const arr = store.get('samples.' + new Date().toISOString().slice(0, 10), []);
  if (arr.length < 3) return null;
  return { day0, prod: arr.map((s) => ({ t: s.t, v: s.p })), achat: arr.map((s) => ({ t: s.t, v: s.a })), src: 'iPad' };
}

function chartSVG(series, h = 120) {
  if (!series) return '<p class="small muted">La courbe apparaîtra au fil de la journée.</p>';
  const W = 600, H = h, t0 = series.day0.getTime(), span = 864e5;
  const all = [...series.prod, ...series.achat].map((p) => p.v);
  const ymax = Math.max(500, ...all) * 1.08;
  const X = (t) => (((t - t0) / span) * W).toFixed(1);
  const Y = (v) => (H - (clamp(v, 0, ymax) / ymax) * (H - 4)).toFixed(1);
  const area = (pts) => (pts.length ? `M${X(pts[0].t)},${H} ` + pts.map((p) => `L${X(p.t)},${Y(p.v)}`).join(' ') + ` L${X(pts[pts.length - 1].t)},${H} Z` : '');
  const line = (pts) => pts.map((p, i) => `${i ? 'L' : 'M'}${X(p.t)},${Y(p.v)}`).join(' ');
  const now = X(Date.now());
  const hours = [6, 12, 18].map((hh) => `<line x1="${(hh / 24) * W}" x2="${(hh / 24) * W}" y1="0" y2="${H}" stroke="var(--line)" stroke-dasharray="2 4" vector-effect="non-scaling-stroke"/>`).join('');
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    ${hours}
    <path d="${area(series.prod)}" fill="var(--sun)" fill-opacity=".28"/>
    <path d="${line(series.prod)}" fill="none" stroke="var(--sun)" stroke-width="1.6" vector-effect="non-scaling-stroke"/>
    <path d="${area(series.achat)}" fill="var(--grid)" fill-opacity=".35"/>
    <path d="${line(series.achat)}" fill="none" stroke="var(--muted)" stroke-width="1.4" vector-effect="non-scaling-stroke"/>
    <line x1="${now}" x2="${now}" y1="0" y2="${H}" stroke="var(--accent)" stroke-width="1" vector-effect="non-scaling-stroke"/>
  </svg><div class="hours"><span>0 h</span><span>6 h</span><span>12 h</span><span>18 h</span><span>24 h</span></div>`;
}

function cardEnergy() {
  const e = energyNow();
  const sens = e.revente > 0 ? { lbl: 'Revente', v: e.revente } : { lbl: 'Achat', v: e.achat };
  return `<div class="card span-2 tap" data-act="tab" data-id="energie">
    <div class="section-head"><h2>Énergie</h2>${e.auto != null ? `<span class="tag accent">Autoconsommation ${pct(e.auto)} %</span>` : ''}</div>
    <div class="kpis">
      <div class="kpi sun"><div class="lbl">Production</div><div class="val">${watts(e.prod)}</div><div class="small muted">dont FHE estimé ${e.fhe == null ? '–' : nf(e.fhe, 0) + ' W'}</div></div>
      <div class="kpi"><div class="lbl">${sens.lbl} réseau</div><div class="val">${watts(sens.v)}</div><div class="small muted">${nf(e.kwhJour, 1)} kWh achetés aujourd’hui</div></div>
      <div class="kpi"><div class="lbl">Coût du jour</div><div class="val">${nf(e.cout, 2)}<span class="unit">€</span></div><div class="small muted">abonnement compris</div></div>
    </div>
    <div class="chart">${chartSVG(curveSeries())}</div>
    <div class="legend"><span><i style="background:var(--sun);opacity:.6"></i>Production solaire (FHE estimé)</span><span><i style="background:var(--grid)"></i>Achat au réseau</span><span>Sous la courbe solaire, sans achat : autoconsommation</span></div>
  </div>`;
}

function avatarHTML(devId) {
  const a = S.avatars[devId] || {};
  const present = cap(devId, 'presence') === true;
  let src = a.photo || null;
  if (!src) {
    const u = findUser(devId, a.user);
    if (u) src = u.avatar || (u.athomId ? `https://api.athom.com/user/${u.athomId}/avatar` : null);
  }
  const z = a.zoom || 1, x = a.x || 0, y = a.y || 0;
  const ini = esc((findUser(devId, a.user)?.name || nm(devId)).replace(/^(iphone|ipad)\s*(de|d’|d')\s*/i, '').charAt(0).toUpperCase());
  const img = src ? `<img src="${esc(src)}" alt="" style="transform:translate(${x}%,${y}%) scale(${z})" onerror="this.remove()">` : '';
  return `<div class="avatar ${present ? 'on' : 'off'}" title="${present ? 'Présent' : 'Absent'}"><span class="ini">${ini}</span>${img}</div>`;
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
  return C.presence.map((id) => `<div class="card person">${avatarHTML(id)}</div>`).join('');
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
    } catch { camImg[id] = { ...(cur || {}), err: 'load' }; }
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
      : `<div class="cam-empty">${im.err === 'none' ? 'Pas d’image transmise à Homey' : im.err ? 'Image indisponible' : 'Chargement…'}</div>`;
    return `<button class="cam ${motion ? 'motion' : ''}" data-act="cam" data-id="${id}">
      ${body}
      <span class="cam-info"><span>${esc(nm(id))}</span><span>${motion ? '<b class="tag warn">Mouvement</b> ' : ''}${typeof bat === 'number' ? bat + ' %' : ''}${im.at ? ' · ' + hhmm(im.at) : ''}</span></span>
    </button>`;
  }).join('');
  return tiles ? `<div class="card span-2"><h2>Caméras</h2><div class="cams">${tiles}</div></div>` : '';
}

function cardLightsSummary() {
  const lights = visible().filter((d) => d.class === 'light' && has(d.id, 'onoff'));
  const on = lights.filter((d) => cap(d.id, 'onoff') === true).length;
  return `<div class="card tap ${on ? 'glow' : ''}" data-act="tab" data-id="eclairage"><h2>Lumière</h2>
    <div class="row between"><div class="mid">${on}<span class="unit">allumée${on > 1 ? 's' : ''}</span></div><div class="mid">${lights.length - on}<span class="unit">éteinte${lights.length - on > 1 ? 's' : ''}</span></div></div>
  </div>`;
}

function cardBlindsSummary() {
  const ids = [...C.volets.vie.items, ...C.volets.nuit.items];
  const up = ids.filter((id) => cap(id, 'windowcoverings_state') === 'up').length;
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
  <div class="grid">${cardAlerts(alerts())}${cardComfort()}${cardEnergy()}${cardCameras()}<div class="stack-col">${cardBlindsSummary()}${cardLightsSummary()}</div></div>`;
}

/* Volets */
const STATE = { up: 'Ouvert', down: 'Fermé', idle: 'Arrêté' };
function blindCtrl(id, group = false) {
  const etat = cap(id, 'windowcoverings_state');
  // Les volets ne remontent pas leur position réelle : on part de la dernière demande, sinon de l'état
  const pos = st.lastReq[id] ?? (etat === 'down' ? 0 : etat === 'up' ? 100 : cap(id, 'windowcoverings_set') != null ? pct(cap(id, 'windowcoverings_set')) : 100);
  return `<div class="ctrl">
    <div class="btns">
      <button class="btn" data-act="blind" data-id="${id}" data-v="up" aria-label="Monter">▲</button>
      <button class="btn" data-act="blind" data-id="${id}" data-v="idle" aria-label="Stop">■</button>
      <button class="btn" data-act="blind" data-id="${id}" data-v="down" aria-label="Descendre">▼</button>
    </div>
    <span class="small muted" data-pos="${id}">${pos} %</span>
  </div>
  <input type="range" min="0" max="100" step="5" value="${pos}" data-range="blind" data-id="${id}" aria-label="Position"${group ? '' : ''}>`;
}

function viewBlinds() {
  const zone = (title, z) => `<div class="zone-card">
      <div class="section-head"><h2>${title}</h2><span class="small muted">toute la zone</span></div>
      ${blindCtrl(z.groupe, true)}
    </div>
    <div class="grid dense" style="margin-bottom:28px">${z.items.map((id) => `<div class="card blind">
      <div class="row between"><div class="name">${esc(nm(id))}</div><span class="tag ${cap(id, 'windowcoverings_state') === 'up' ? 'accent' : ''}">${STATE[cap(id, 'windowcoverings_state')] || '–'}</span></div>
      ${blindCtrl(id)}
    </div>`).join('')}</div>`;
  const closed = cap(C.portail.capteur, 'garagedoor_closed');
  return `<h1>Volets</h1>
    ${zone('Zone vie', C.volets.vie)}
    ${zone('Zone nuit', C.volets.nuit)}
    <div class="card row between" style="max-width:520px">
      <div><h2 style="margin-bottom:4px">Portail</h2><div class="mid">${closed === false ? 'Ouvert' : closed === true ? 'Fermé' : '–'}</div></div>
      <button class="btn primary" data-act="portail">${closed === false ? 'Fermer' : 'Ouvrir'}</button>
    </div>`;
}

/* Chauffage */
function viewHeat() {
  const g = C.chauffage.gainable;
  const m = cap(g, 'cozytouch_hvac_mode');
  const modes = [['heat', 'Chauffage'], ['cool', 'Climatisation'], ['off', 'Arrêt']];
  const cards = C.chauffage.zones.map((z) => {
    const manuel = cap(z.id, 'cozytouch_heating_mode') === 'manual';
    const on = cap(z.id, 'onoff') !== false;
    const co2 = z.co2 ? cap(z.co2, 'measure_co2') : null;
    return `<div class="card zone ${on ? '' : 'off'}">
      <div class="row between"><div style="font-weight:500">${esc(nm(z.id))}</div><button class="switch ${on ? 'on' : ''}" data-act="zpower" data-id="${z.id}" aria-label="Marche / arrêt"></button></div>
      <div class="row between" style="margin:14px 0">
        <div class="temp">${nf(cap(z.id, 'measure_temperature'), 1)}<span class="unit">°C</span></div>
        ${co2 && co2 > C.alertes.co2 ? `<span class="tag warn">Aérer · ${nf(co2, 0)} ppm</span>` : ''}
      </div>
      <div class="row between wrap">
        <div class="seg">
          <button class="${manuel ? '' : 'on'}" data-act="zmode" data-id="${z.id}" data-flow="${z.bascule}" data-v="prog">Programme</button>
          <button class="${manuel ? 'on' : ''}" data-act="zmode" data-id="${z.id}" data-flow="${z.bascule}" data-v="manual">Manuel</button>
        </div>
        <div class="setp">
          <button class="btn sm" data-act="zset" data-id="${z.id}" data-v="-0.5" ${manuel && on ? '' : 'disabled'} aria-label="Baisser">−</button>
          <span class="v">${nf(cap(z.id, 'target_temperature'), 1)}°</span>
          <button class="btn sm" data-act="zset" data-id="${z.id}" data-v="0.5" ${manuel && on ? '' : 'disabled'} aria-label="Monter">+</button>
        </div>
      </div>
    </div>`;
  }).join('');
  return `<h1>Chauffage</h1>
    <div class="card row between wrap" style="margin-bottom:18px">
      <div><h2 style="margin-bottom:2px">${esc(nm(g) || 'Gainable')}</h2><span class="small muted">Mode général</span></div>
      <div class="seg">${modes.map(([v, l]) => `<button class="${m === v ? 'on' : ''}" data-act="hvac" data-v="${v}">${l}</button>`).join('')}</div>
    </div>
    <div class="grid">${cards}</div>`;
}

/* Énergie détaillée */
function viewEnergy() {
  const e = energyNow();
  const k = (c) => cap(C.energie.compteur, c);
  const now = new Date();
  const moisCout = k('meter_kwh_this_month') == null ? null : k('meter_kwh_this_month') * S.prixKwh + S.aboMois * (now.getDate() / new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate());
  const anCout = k('meter_kwh_this_year') == null ? null : k('meter_kwh_this_year') * S.prixKwh + S.aboMois * (now.getMonth() + now.getDate() / 31);
  const conso = visible()
    .filter((d) => typeof d.capabilitiesObj?.measure_power?.value === 'number' && ![C.energie.linky, C.energie.solaire, C.energie.compteur].includes(d.id) && d.class !== 'solarpanel')
    .sort((a, b) => b.capabilitiesObj.measure_power.value - a.capabilitiesObj.measure_power.value)
    .filter((d) => d.capabilitiesObj.measure_power.value > 1)
    .slice(0, 8);
  return `<h1>Énergie</h1>
  <div class="grid">
    ${cardEnergy().replace('tap" data-act="tab" data-id="energie"', '"')}
    <div class="card"><h2>Aujourd’hui</h2><div class="stack">
      <div class="row between"><span class="muted">Acheté</span><b>${nf(k('meter_kwh_this_day'), 1)} kWh</b></div>
      <div class="row between"><span class="muted">Produit (estimé)</span><b>${nf(e.prodJourKwh, 1)} kWh</b></div>
      <div class="row between"><span class="muted">Coût</span><b>${nf(e.cout, 2)} €</b></div>
      <div class="row between"><span class="muted">Pic de puissance</span><b>${nf(k('measure_watt_max.day'), 0)} W</b></div>
    </div></div>
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
    <div class="card"><h2>Tarif utilisé</h2><p class="small muted" style="margin:0">${nf(S.prixKwh, 4)} €/kWh · abonnement ${nf(S.aboMois, 2)} €/mois · FHE = Hoymiles × ${nf(S.coefFHE, 2)}. Modifiable dans les réglages.</p></div>
  </div>`;
}

/* Éclairage et prises */
function byZone(list) {
  const groups = {};
  list.forEach((d) => { const z = zoneName(d.zone) || 'Maison'; (groups[z] = groups[z] || []).push(d); });
  return Object.entries(groups).sort((a, b) => a[0].localeCompare(b[0], 'fr'));
}

function viewLights() {
  const lights = visible().filter((d) => d.class === 'light' && has(d.id, 'onoff'));
  if (!lights.length) return '<h1>Éclairage</h1><div class="empty">Aucun éclairage trouvé.</div>';
  return `<h1>Éclairage</h1><div class="grid">${byZone(lights).map(([z, list]) => {
    const anyOn = list.some((d) => cap(d.id, 'onoff'));
    return `<div class="card"><div class="section-head"><h2>${esc(z)}</h2>${anyOn ? `<button class="btn sm ghost" data-act="zoneoff" data-ids="${list.map((d) => d.id).join(',')}">Tout éteindre</button>` : ''}</div>
      ${list.map((d) => {
        const on = cap(d.id, 'onoff') === true;
        const dim = has(d.id, 'dim') ? pct(cap(d.id, 'dim') ?? 0) : null;
        return `<div class="dev"><div class="nm"><div>${esc(nm(d.id))}</div></div>
          ${dim != null ? `<input class="dim" type="range" min="1" max="100" value="${dim || 1}" data-range="dim" data-id="${d.id}" aria-label="Intensité" ${on ? '' : 'disabled style="opacity:.4"'}>` : ''}
          <button class="switch ${on ? 'on' : ''}" data-act="onoff" data-id="${d.id}" aria-label="Allumer / éteindre"></button></div>`;
      }).join('')}</div>`;
  }).join('')}</div>`;
}

function viewPlugs() {
  const plugs = visible().filter((d) => C.classesPrises.includes(d.class) && has(d.id, 'onoff'));
  return `<h1>Prises</h1><div class="grid">${byZone(plugs).map(([z, list]) => `<div class="card"><h2>${esc(z)}</h2>
    ${list.map((d) => {
      const on = cap(d.id, 'onoff') === true;
      const p = cap(d.id, 'measure_power');
      const prot = C.prisesProtegees.includes(d.id);
      return `<div class="dev"><div class="nm"><div>${esc(nm(d.id))}</div><div class="small muted">${typeof p === 'number' ? nf(p, 0) + ' W' : ''}${prot ? ' · protégée' : ''}</div></div>
        <button class="switch ${on ? 'on' : ''}" data-act="plug" data-id="${d.id}" aria-label="Allumer / couper"></button></div>`;
    }).join('')}</div>`).join('')}</div>`;
}

/* ---------- Feuilles ---------- */
function openSheet(html, onMount) {
  st.sheet = true;
  const root = $('#sheet-root');
  root.innerHTML = `<div class="sheet-bg"><div class="sheet" role="dialog" aria-modal="true">${html}</div></div>`;
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
const actions = {
  tab({ id }) { st.tab = id; store.set('tab', id); render(); window.scrollTo({ top: 0 }); },
  settings() { openSettings(); },
  async blind({ id, v }) {
    await send(id, 'windowcoverings_state', v).catch(() => {});
    if (v !== 'idle') { st.lastReq[id] = v === 'up' ? 100 : 0; store.set('lastReq', st.lastReq); }
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
  hvac({ v }) { send(C.chauffage.gainable, 'cozytouch_hvac_mode', v).catch(() => {}); },
  async zmode({ id, flow, v }) {
    if (cap(id, 'cozytouch_heating_mode') === v) return;
    setLocal(id, 'cozytouch_heating_mode', v); render();
    try { await homey.triggerFlow(flow); toast(v === 'manual' ? 'Pièce passée en manuel' : 'Retour au programme'); }
    catch (e) { setLocal(id, 'cozytouch_heating_mode', v === 'manual' ? 'prog' : 'manual'); render(); toast(e.status === 403 ? 'La clé n’a pas le droit de lancer les flows' : 'Commande non envoyée'); }
  },
  zset({ id, v }) {
    const t = clamp(Math.round(((cap(id, 'target_temperature') ?? 20) + Number(v)) * 2) / 2, 7, 30);
    setLocal(id, 'target_temperature', t); render();
    clearTimeout(zTimers[id]);
    zTimers[id] = setTimeout(() => send(id, 'target_temperature', t, { optimistic: false }).catch(() => {}), 900);
  },
  zpower({ id }) { send(id, 'onoff', cap(id, 'onoff') === false).catch(() => {}); },
  onoff({ id }) { send(id, 'onoff', !cap(id, 'onoff')).catch(() => {}); },
  zoneoff({ ids }) { ids.split(',').forEach((id) => { if (cap(id, 'onoff')) send(id, 'onoff', false).catch(() => {}); }); },
  cam({ id }) { openLive(id); },
  async plug({ id }) {
    const on = cap(id, 'onoff') === true;
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
    st.lastReq[id] = Number(r.value); store.set('lastReq', st.lastReq);
    send(id, 'windowcoverings_set', v, { optimistic: false }).catch(() => {});
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
async function openSettings() {
  if (!(await unlock())) return;
  const motion = visible().filter((d) => has(d.id, 'alarm_motion'));
  const users = Object.values(st.users || {});
  const styleSeg = [['line', 'Trait fin'], ['solid', 'Plein'], ['color', 'Couleur']];
  const av = C.presence.map((id) => {
    const a = S.avatars[id] || {};
    return `<div class="set-group" data-av="${id}">
      <div class="row" style="gap:18px;align-items:flex-start">${avatarHTML(id)}
        <div style="flex:1">
          <div class="field"><label>Compte Homey (avatar)</label><select data-s="avuser" data-id="${id}"><option value="">Automatique</option>${users.map((u) => `<option value="${esc(u.id)}" ${a.user === u.id ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}</select></div>
          <div class="row wrap"><label class="btn sm ghost" style="padding:0 14px">Remplacer par une photo<input type="file" accept="image/*" data-s="avphoto" data-id="${id}" hidden></label>${a.photo ? `<button class="btn sm ghost" data-s-act="avreset" data-id="${id}">Revenir à l’avatar Homey</button>` : ''}</div>
          <div class="field" style="margin-top:12px"><label>Zoom</label><input type="range" min="1" max="3" step="0.05" value="${a.zoom || 1}" data-s="avzoom" data-id="${id}"></div>
          <div class="field"><label>Centrage horizontal</label><input type="range" min="-30" max="30" step="1" value="${a.x || 0}" data-s="avx" data-id="${id}"></div>
          <div class="field"><label>Centrage vertical</label><input type="range" min="-30" max="30" step="1" value="${a.y || 0}" data-s="avy" data-id="${id}"></div>
        </div></div></div>`;
  }).join('');

  openSheet(`<div class="row between"><h3>Réglages</h3><button class="btn sm ghost" data-s-act="close">Fermer</button></div>

    <div class="set-group"><h4>Connexion à la Homey</h4>
      <div class="field"><label>Adresse de la Homey</label><input type="text" inputmode="url" name="homey-adresse" autocomplete="off" data-lpignore="true" data-1p-ignore data-s="homeyUrl" value="${esc(S.homeyUrl)}" placeholder="exemple : https://192-168-1-XX.homey.homeylocal.com" autocapitalize="off" autocorrect="off" spellcheck="false"><span class="hint">Adresse locale sécurisée de la Homey (voir le guide).</span></div>
      <div class="field"><label>Clé API</label><input type="text" class="secret" data-s="cle" value="${esc(S.cle)}" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" name="homey-api-key" data-lpignore="true" data-1p-ignore><span class="hint">Créée dans Homey : Réglages &gt; Clés API. Elle reste sur cet iPad.</span></div>
      <button class="btn sm" data-s-act="test">Tester la connexion</button> <span class="small muted" data-test></span>
    </div>

    <div class="set-group"><h4>Météo</h4>
      <div class="field"><label>Commune pour les prévisions</label><div class="row"><input type="text" data-s="communeQ" value="${esc(S.commune)}" style="flex:1"><button class="btn sm" data-s-act="geo">Chercher</button></div><span class="hint" data-geo>${S.lat != null ? `Position arrondie : ${nf(S.lat, 2)}, ${nf(S.lon, 2)}` : ''}</span></div>
    </div>

    <div class="set-group"><h4>Électricité</h4>
      <div class="row wrap" style="gap:14px">
        <div class="field" style="flex:1;min-width:150px"><label>Prix du kWh TTC (€)</label><input type="number" step="0.0001" min="0" data-s="prixKwh" value="${S.prixKwh}"></div>
        <div class="field" style="flex:1;min-width:150px"><label>Abonnement TTC (€/mois)</label><input type="number" step="0.01" min="0" data-s="aboMois" value="${S.aboMois}"></div>
        <div class="field" style="flex:1;min-width:150px"><label>Coefficient FHE</label><input type="number" step="0.01" min="0" max="3" data-s="coefFHE" value="${S.coefFHE}"><span class="hint">FHE = Hoymiles × ce nombre</span></div>
      </div>
    </div>

    <div class="set-group"><h4>Thème et écran</h4>
      <div class="field"><label>Style des icônes</label><div class="seg">${styleSeg.map(([v, l]) => `<button class="${S.iconStyle === v ? 'on' : ''}" data-s-act="style" data-v="${v}">${l}</button>`).join('')}</div></div>
      <div class="row between" style="margin:8px 0 12px"><div><div>Réveil à l’approche</div><div class="small muted">L’écran s’éteint après 3 min et se rallume quand le détecteur voit quelqu’un.</div></div><button class="switch ${S.reveil ? 'on' : ''}" data-s-act="reveil"></button></div>
      ${S.reveil ? `<div class="field"><label>Détecteur de mouvement</label><select data-s="reveilCapteur"><option value="">Choisir…</option>${motion.map((d) => `<option value="${d.id}" ${S.reveilCapteur === d.id ? 'selected' : ''}>${esc(nm(d.id))}</option>`).join('')}</select><span class="hint">Jamais la caméra de l’iPad.</span></div>` : ''}
    </div>

    <div class="set-group"><h4>Présence</h4><p class="small" style="margin-top:0">Les photos restent sur cet iPad. Anneau en couleur : présent ; gris : absent.</p>${users.length ? '' : '<p class="small" style="color:var(--warn)">La Homey ne donne pas la liste des comptes : la clé API n’a sans doute pas le droit « Utilisateurs : voir ». Sans lui, les avatars Homey ne peuvent pas s’afficher (tu peux quand même mettre une photo).</p>'}</div>${av}

    <div class="set-group"><h4>Verrou des réglages</h4>
      ${lock.hash ? '' : '<p class="small" style="color:var(--warn);margin-top:0">Aucun code pour l’instant : choisis-en un pour protéger les réglages.</p>'}
      <div class="row wrap"><button class="btn sm" data-s-act="pin">${lock.hash ? 'Changer le code' : 'Choisir un code'}</button>
      ${lock.hash ? (lock.cred ? '<button class="btn sm ghost" data-s-act="faceoff">Retirer Face ID</button>' : '<button class="btn sm" data-s-act="faceon">Activer Face ID</button>') : ''}</div>
    </div>`, bindSettings);
  paintRanges();
}

function bindSettings(el) {
  const reopen = () => { closeSheet(); st.unlockedUntil = Math.max(st.unlockedUntil, Date.now() + 60e3); openSettings(); };
  const avs = (id) => (S.avatars[id] = S.avatars[id] || {});
  const applyAvatar = (id) => {
    const box = el.querySelector(`[data-av="${id}"] .avatar`);
    if (box) box.outerHTML = avatarHTML(id);
  };

  el.addEventListener('change', async (e) => {
    const t = e.target, k = t.dataset.s;
    if (!k) return;
    if (k === 'homeyUrl' || k === 'cle') {
      let val = t.value.trim();
      if (k === 'homeyUrl' && val && !/^https?:\/\//.test(val)) val = 'https://' + val;
      S[k] = val; saveSettings();
      homey = new Homey(S.homeyUrl, S.cle);
    } else if (['prixKwh', 'aboMois', 'coefFHE'].includes(k)) {
      const n = parseFloat(String(t.value).replace(',', '.'));
      if (!Number.isNaN(n)) { S[k] = n; saveSettings(); }
    } else if (k === 'reveilCapteur') { S.reveilCapteur = t.value; saveSettings(); }
    else if (k === 'avuser') { avs(t.dataset.id).user = t.value || undefined; saveSettings(); applyAvatar(t.dataset.id); }
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
    if (a === 'close') { closeSheet(); refresh(); refreshSlow(); refreshWeather(true); refreshCurve(true); }
    else if (a === 'test') {
      const out = el.querySelector('[data-test]');
      out.textContent = 'Test…';
      try {
        const d = await new Homey(S.homeyUrl, S.cle).devices();
        out.textContent = `Connectée : ${Object.keys(d).length} appareils vus.`;
        refreshSlow();
      } catch (err) {
        out.textContent = err.status === 401 || err.status === 403 ? 'Clé refusée par la Homey.' : 'Homey injoignable depuis cet iPad (adresse, Wi-Fi ou blocage du navigateur).';
      }
    } else if (a === 'geo') {
      const q = el.querySelector('[data-s="communeQ"]').value.trim();
      const out = el.querySelector('[data-geo]');
      if (!q) return;
      out.textContent = 'Recherche…';
      try {
        const r = await geocode(q);
        if (!r.length) { out.textContent = 'Commune introuvable.'; return; }
        const c = r[0];
        S.commune = c.name; S.lat = Math.round(c.latitude * 100) / 100; S.lon = Math.round(c.longitude * 100) / 100;
        saveSettings();
        out.textContent = `${c.name}${c.admin2 ? ', ' + c.admin2 : ''} · position arrondie ${nf(S.lat, 2)}, ${nf(S.lon, 2)}`;
        refreshWeather(true);
      } catch { out.textContent = 'Recherche impossible pour le moment.'; }
    } else if (a === 'style') { S.iconStyle = b.dataset.v; saveSettings(); renderTabs(); reopen(); }
    else if (a === 'reveil') { S.reveil = !S.reveil; saveSettings(); reopen(); }
    else if (a === 'avreset') { delete avs(b.dataset.id).photo; saveSettings(); reopen(); }
    else if (a === 'pin') { closeSheet(); await setPin(); st.unlockedUntil = Date.now() + 60e3; openSettings(); }
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

/* ---------- Démarrage ---------- */
$('#btn-settings').addEventListener('click', () => openSettings());
tick(); setInterval(tick, 10e3);
render();
refresh().then(() => { refreshSlow(); refreshCurve(true); refreshCameras(true); });
refreshWeather(true);
setInterval(refresh, 5e3);
setInterval(refreshSlow, 10 * 60e3);
setInterval(() => { refreshWeather(); refreshCurve(); refreshCameras(); }, 60e3);
document.addEventListener('visibilitychange', () => { if (!document.hidden) { refresh(); refreshWeather(); refreshCurve(true); } });
armSleep();
