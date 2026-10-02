// Serves the static site and proxies live traffic data.
// Source 1: OpenSky (signed in, via secrets OPENSKY_CLIENT_ID / OPENSKY_CLIENT_SECRET). Source 2: adsb.lol.
// Both are normalised to { ac: [...] } so the app handles them the same way.
let tok = { v: null, exp: 0 };

async function openskyToken(env) {
  if (tok.v && Date.now() < tok.exp) return tok.v;
  const r = await fetch("https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: env.OPENSKY_CLIENT_ID, client_secret: env.OPENSKY_CLIENT_SECRET }),
    signal: AbortSignal.timeout(6000),
  });
  if (!r.ok) throw new Error("token " + r.status);
  const j = await r.json();
  tok = { v: j.access_token, exp: Date.now() + (j.expires_in - 60) * 1000 };
  return tok.v;
}

async function fromOpenSky(env, lat, lon) {
  const token = await openskyToken(env);
  const dLat = 1, dLon = 1 / Math.max(Math.cos((lat * Math.PI) / 180), 0.05);
  const u = `https://opensky-network.org/api/states/all?lamin=${lat - dLat}&lomin=${lon - dLon}&lamax=${lat + dLat}&lomax=${lon + dLon}`;
  const r = await fetch(u, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error("opensky " + r.status);
  const j = await r.json();
  return {
    ac: (j.states || [])
      .filter((s) => !s[8] && s[5] != null && s[6] != null && (s[7] ?? s[13]) != null)
      .map((s) => ({ hex: s[0], flight: s[1] || "", country: s[2], alt_baro: (s[7] ?? s[13]) * 3.28084, gs: (s[9] ?? 0) * 1.94384, lat: s[6], lon: s[5] })),
  };
}

// Other free community feeds that use the same readsb JSON format as adsb.lol.
// Cloudflare shares egress IPs, so any single feed can rate-limit (429); having several makes this reliable.
const READSB = {
  "adsb.lol": (la, lo) => `https://api.adsb.lol/v2/point/${la}/${lo}/50`,
  "airplanes.live": (la, lo) => `https://api.airplanes.live/v2/point/${la}/${lo}/50`,
  "adsb.fi": (la, lo) => `https://opendata.adsb.fi/api/v2/lat/${la}/lon/${lo}/dist/50`,
  "adsb.one": (la, lo) => `https://api.adsb.one/v2/point/${la}/${lo}/50`,
};

async function fromReadsb(name, lat, lon) {
  const r = await fetch(READSB[name](lat.toFixed(2), lon.toFixed(2)), {
    headers: { "User-Agent": "plane-above-me", Accept: "application/json" },
    signal: AbortSignal.timeout(6000),
  });
  if (!r.ok) throw new Error(name + " " + r.status);
  const j = await r.json();
  const ac = j.ac || j.aircraft;
  if (!Array.isArray(ac)) throw new Error(name + " bad data");
  return { ac };
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (url.pathname !== "/api/adsb") return env.ASSETS.fetch(req);
    const lat = parseFloat(url.searchParams.get("lat")), lon = parseFloat(url.searchParams.get("lon"));
    if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180)
      return new Response("bad request", { status: 400 });
    const la = Math.round(lat * 100) / 100, lo = Math.round(lon * 100) / 100; // ~1 km rounding for privacy
    // Short edge cache so repeated scans don't hammer the upstream feeds (and trigger 429s)
    const cache = caches.default;
    const key = new Request(`https://cache.internal/adsb?lat=${la}&lon=${lo}`);
    const hit = await cache.match(key);
    if (hit) return hit;

    // Race every source in parallel; first one to return data wins.
    const sources = Object.keys(READSB).map((n) => [n, () => fromReadsb(n, la, lo)]);
    if (env.OPENSKY_CLIENT_ID && env.OPENSKY_CLIENT_SECRET) sources.push(["opensky", () => fromOpenSky(env, la, lo)]);
    const tried = [];
    try {
      const { data, name } = await Promise.any(
        sources.map(([name, fn]) => fn().then((data) => ({ data, name }), (e) => { tried.push(name + ": " + e.message); throw e; }))
      );
      const res = Response.json(data, { headers: { "cache-control": "public, max-age=8", "x-source": name } });
      ctx.waitUntil(cache.put(key, res.clone()));
      return res;
    } catch (_) {
      return new Response("all upstreams failed: " + tried.join(", "), { status: 502 });
    }
  },
};
