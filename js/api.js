// Accès à l'API de la Homey Pro avec une clé API (Réglages > Clés API dans Homey).

export class Homey {
  constructor(url, key) {
    this.url = (url || '').trim().replace(/\/+$/, '');
    this.key = (key || '').trim();
  }

  get ready() { return Boolean(this.url && this.key); }

  async req(path, { method = 'GET', body, timeout = 8000 } = {}) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetch(`${this.url}/api${path}`, {
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
    const tries = [
      `/manager/insights/log/${uri}/${encodeURIComponent(capabilityId)}/entry?resolution=${resolution}`,
      `/manager/insights/log/${full}/entry?resolution=${resolution}`,
    ];
    for (const p of tries) {
      try {
        const r = await this.req(p, { timeout: 10000 });
        const values = Array.isArray(r) ? r : r?.values;
        if (Array.isArray(values)) {
          return values
            .map((v) => ({ t: new Date(v.t).getTime(), v: v.v }))
            .filter((v) => typeof v.v === 'number' && !Number.isNaN(v.t));
        }
      } catch (e) { /* forme suivante */ }
    }
    return null;
  }
}

export async function forecast(lat, lon) {
  const u = new URL('https://api.open-meteo.com/v1/forecast');
  u.search = new URLSearchParams({
    latitude: lat.toFixed(2),
    longitude: lon.toFixed(2),
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max',
    timezone: 'Europe/Paris',
    forecast_days: '4',
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
export async function actualites() {
  const [une, monde] = await Promise.all([flux(FLUX.une), flux(FLUX.monde).catch(() => [])]);
  const vu = new Set();
  const prendre = (l, n) => l.filter((x) => !vu.has(x.lien) && vu.add(x.lien)).slice(0, n);
  const intl = (x) => x.rubrique === 'international';
  // magazine, tribunes et jeux vidéo : pas de « l'info la plus importante »
  const HORS = ['m-le-mag', 'idees', 'pixels', 'le-monde-et-vous', 'jeux'];
  const garde = (x) => !HORS.includes(x.rubrique);
  const france = prendre(une.filter((x) => garde(x) && !intl(x)), 4);
  const mondeL = prendre([...une.filter(intl), ...monde.filter(garde)], 4);
  return { france, monde: mondeL, at: Date.now() };
}
