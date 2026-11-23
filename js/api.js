// Accès à l'API de la Homey Pro avec une clé API (Réglages > Clés API dans Homey).

// Deux adresses : locale (à la maison, rapide) et cloud Athom (partout ailleurs).
// Si l'une ne répond pas, on bascule sur l'autre ; à distance, on reteste la locale toutes les minutes.
const net = (u) => (u || '').trim().replace(/\/+$/, '');
export class Homey {
  constructor(url, key, cloud) {
    this.local = net(url);
    this.cloud = net(cloud);
    this.key = (key || '').trim();
    this.mode = this.local ? 'local' : 'cloud';
    this.probeAt = 0;
    this.insightsErr = null; // dernier refus de lecture de l'historique (403 = droit manquant)
  }

  get url() { return this.mode === 'cloud' && this.cloud ? this.cloud : this.local || this.cloud; }
  get ready() { return Boolean((this.local || this.cloud) && this.key); }
  get distance() { return this.url === this.cloud && Boolean(this.cloud); }

  async req(path, opts = {}) {
    // à distance : un essai rapide de l'adresse locale de temps en temps (retour à la maison)
    if (this.distance && this.local && Date.now() - this.probeAt > 60e3) {
      this.probeAt = Date.now();
      try { await this.once(this.local, '/manager/devices/device/?probe=1', { timeout: 2500 }); this.mode = 'local'; } catch { /* toujours dehors */ }
    }
    try {
      return await this.once(this.url, path, opts);
    } catch (e) {
      // pas de réponse (et non un refus de la Homey) : on essaie l'autre adresse
      const autre = this.url === this.local ? this.cloud : this.local;
      if (e.status || !autre) throw e;
      const r = await this.once(autre, path, opts);
      this.mode = autre === this.cloud ? 'cloud' : 'local';
      this.probeAt = Date.now();
      return r;
    }
  }

  async once(base, path, { method = 'GET', body, timeout } = {}) {
    // l'adresse locale ne répond pas hors de la maison : on n'attend pas longtemps
    timeout = timeout || (base === this.local && this.cloud ? 4000 : 10000);
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetch(`${base}/api${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.key}`,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const err = new Error(`Homey ${res.status}`);
        err.status = res.status;
        try { const t = await res.text(); try { const j = JSON.parse(t); err.detail = j.error || j.message || t; } catch { err.detail = t; } } catch { /* sans détail */ }
        throw err;
      }
      const text = await res.text();
      return text ? JSON.parse(text) : null;
    } finally {
      clearTimeout(t);
    }
  }

  devices() { return this.req('/manager/devices/device/'); }
  device(id) { return this.req(`/manager/devices/device/${id}`); }
  zones() { return this.req('/manager/zones/zone/'); }
  users() { return this.req('/manager/users/user/'); }

  setCapability(deviceId, capabilityId, value) {
    return this.req(`/manager/devices/device/${deviceId}/capability/${encodeURIComponent(capabilityId)}`, {
      method: 'PUT',
      body: { value },
    });
  }

  // Image d'une caméra (snapshot) : l'adresse demande la clé, donc on passe par un blob.
  async imageURL(path) {
    const res = await fetch(`${this.url}${path.startsWith('/api') ? '' : '/api'}${path}`, {
      headers: { Authorization: `Bearer ${this.key}` },
    });
    if (!res.ok) throw new Error(`image ${res.status}`);
    return URL.createObjectURL(await res.blob());
  }

  triggerFlow(flowId) {
    return this.req(`/manager/flow/advancedflow/${flowId}/trigger`, { method: 'POST', body: {} });
  }

  // Historique d'une capacité (Insights). Deux formes d'adresse existent selon
  // la version de Homey : on essaie l'une puis l'autre.
  async insights(deviceId, capabilityId, resolution = 'today') {
    const uri = encodeURIComponent(`homey:device:${deviceId}`);
    const full = encodeURIComponent(`homey:device:${deviceId}:${capabilityId}`);
    // Forme officielle (client homey-api) : /log/<homey:device:ID>/<homey:device:ID:capacité>/entry
    const tries = [
      `/manager/insights/log/${uri}/${full}/entry?resolution=${resolution}`,
      `/manager/insights/log/${uri}/${encodeURIComponent(capabilityId)}/entry?resolution=${resolution}`,
      `/manager/insights/log/${full}/entry?resolution=${resolution}`,
    ];
    let err0 = null; // réponse de la forme officielle : c'est elle qui fait foi pour le diagnostic
    for (const [i, p] of tries.entries()) {
      try {
        const r = await this.req(p, { timeout: 12000 });
        const values = Array.isArray(r) ? r : r?.values;
        if (Array.isArray(values)) {
          this.insightsErr = null;
          return values
            .map((v) => ({ t: new Date(v.t).getTime(), v: v.v }))
            .filter((v) => typeof v.v === 'number' && !Number.isNaN(v.t));
        }
      } catch (e) {
        if (i === 0) err0 = e;
      }
    }
    // 401/403 : la clé n'a pas le droit « Journaux » ; 404 : pas de journal sous ce nom ; sans code : réseau
    this.insightsErr = !err0 ? null : err0.status === 401 || err0.status === 403 ? err0.status : err0.status || 'reseau';
    return null;
  }
}

export async function forecast(lat, lon) {
  const u = new URL('https://api.open-meteo.com/v1/forecast');
  u.search = new URLSearchParams({
    latitude: lat.toFixed(2),
    longitude: lon.toFixed(2),
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum',
    // conditions actuelles : utilisées quand la commune affichée n'est pas celle de la maison
    current: 'temperature_2m,relative_humidity_2m,wind_speed_10m,wind_direction_10m,wind_gusts_10m,pressure_msl,weather_code',
    timezone: 'Europe/Paris',
    forecast_days: '4',
  });
  const r = await fetch(u);
  if (!r.ok) throw new Error('météo');
  return r.json();
}

// Prévisions détaillées d'une ville : heure par heure (48 h) et 7 jours
export async function previsions(lat, lon) {
  const u = new URL('https://api.open-meteo.com/v1/forecast');
  u.search = new URLSearchParams({
    latitude: lat.toFixed(2),
    longitude: lon.toFixed(2),
    hourly: 'temperature_2m,weather_code,precipitation_probability,wind_speed_10m',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,wind_speed_10m_max,wind_gusts_10m_max,sunrise,sunset',
    timezone: 'Europe/Paris',
    forecast_days: '7',
  });
  const r = await fetch(u);
  if (!r.ok) throw new Error('météo');
  return r.json();
}

export async function geocode(name) {
  const u = new URL('https://geocoding-api.open-meteo.com/v1/search');
  u.search = new URLSearchParams({ name, count: '5', language: 'fr', countryCode: 'FR' });
  const r = await fetch(u);
  if (!r.ok) throw new Error('géocodage');
  const j = await r.json();
  return j.results || [];
}

// Actualité : flux du Monde « À la une » (ordre choisi par la rédaction) et « International ».
// Les sites d'info ne laissent pas une page web lire leurs flux directement : on passe par rss2json,
// qui les convertit. Seule l'adresse du flux est envoyée, rien sur la maison.
const FLUX = {
  une: 'https://www.lemonde.fr/rss/une.xml',
  monde: 'https://www.lemonde.fr/international/rss_full.xml',
  // Région : ici (ex-France Bleu) Hérault, « À la une » classée par sa rédaction
  region: 'https://www.francebleu.fr/rss/herault/a-la-une.xml',
};
async function flux(url) {
  const r = await fetch(`https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(url)}`);
  if (!r.ok) throw new Error('actu');
  const j = await r.json();
  if (j.status !== 'ok') throw new Error(j.message || 'actu');
  return (j.items || []).map((i) => ({
    titre: i.title,
    lien: i.link,
    resume: String(i.description || '').replace(/<[^>]+>/g, '').trim(),
    image: i.thumbnail || i.enclosure?.link || '',
    t: Date.parse(String(i.pubDate || '').replace(' ', 'T') + 'Z') || null,
    rubrique: (String(i.link || '').split('/')[3] || '').toLowerCase(),
  }));
}
export async function actualites(n = 3) {
  const [une, monde, region] = await Promise.all([flux(FLUX.une), flux(FLUX.monde).catch(() => []), flux(FLUX.region).catch(() => [])]);
  const vu = new Set();
  const prendre = (l, n) => l.filter((x) => !vu.has(x.lien) && vu.add(x.lien)).slice(0, n);
  const intl = (x) => x.rubrique === 'international';
  // magazine, tribunes et jeux vidéo : pas de « l'info la plus importante »
  const HORS = ['m-le-mag', 'idees', 'pixels', 'le-monde-et-vous', 'jeux'];
  const garde = (x) => !HORS.includes(x.rubrique);
  const mondeL = prendre([...une.filter(intl), ...monde.filter(garde)], n);
  const france = prendre(une.filter((x) => garde(x) && !intl(x)), n);
  const regionL = prendre(region.map((x) => ({ ...x, rubrique: '' })), n);
  return { monde: mondeL, france, region: regionL, at: Date.now() };
}
