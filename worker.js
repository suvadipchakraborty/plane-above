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
  if (!r.ok) throw new Error("token HTTP " + r.status);
  const j = await r.json();
  tok = { v: j.access_token, exp: Date.now() + (j.expires_in - 60) * 1000 };
  return tok.v;
}

async function fromOpenSky(env, lat, lon) {
  let token = null;
  if (env) { try { token = await openskyToken(env); } catch (e) { throw new Error(e.name === "TimeoutError" ? "token timeout" : e.message); } }
  const dLat = 1, dLon = 1 / Math.max(Math.cos((lat * Math.PI) / 180), 0.05);
  const u = `https://opensky-network.org/api/states/all?lamin=${lat - dLat}&lomin=${lon - dLon}&lamax=${lat + dLat}&lomax=${lon + dLon}`;
  const r = await fetch(u, { headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error("states HTTP " + r.status);
  const j = await r.json();
  return {
    ac: (j.states || [])
      .filter((s) => !s[8] && s[5] != null && s[6] != null && (s[7] ?? s[13]) != null)
      .map((s) => ({ hex: s[0], flight: s[1] || "", country: s[2], alt_baro: (s[7] ?? s[13]) * 3.28084, gs: (s[9] ?? 0) * 1.94384, lat: s[6], lon: s[5] })),
  };
}

// adsb.fi is the one community feed that serves server-side callers (airplanes.live and adsb.one
// return 403 to everyone but feeders). It rate-limits to ~1 request/second, so variants run one after another.
const BROWSER_UA = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36";
const ADSBFI_TRIES = [
  (la, lo) => ["https://opendata.adsb.fi/api/v2/lat/" + la + "/lon/" + lo + "/dist/50", {}],
  (la, lo) => ["https://opendata.adsb.fi/api/v3/lat/" + la + "/lon/" + lo + "/dist/50", {}],
  (la, lo) => ["https://opendata.adsb.fi/api/v2/lat/" + la + "/lon/" + lo + "/dist/50", { "User-Agent": BROWSER_UA }],
];

async function getJson(url, headers, ms, label) {
  const r = await fetch(url, { headers: { Accept: "application/json", ...headers }, signal: AbortSignal.timeout(ms) });
  if (!r.ok) throw new Error(label + " HTTP " + r.status);
  return r.json();
}

async function fromAdsbFi(lat, lon) {
  const errs = [];
  for (const mk of ADSBFI_TRIES) {
    const [url, headers] = mk(lat.toFixed(2), lon.toFixed(2));
    try {
      const j = await getJson(url, headers, 5000, "adsb.fi");
      const ac = j.ac || j.aircraft;
      if (Array.isArray(ac)) return { ac };
      errs.push("bad data");
    } catch (e) { errs.push(e.name === "TimeoutError" ? "timeout" : e.message); }
  }
  throw new Error(errs.join(" / "));
}

async function fromAdsbLol(lat, lon) {
  const url = `https://api.adsb.lol/v2/point/${lat.toFixed(2)}/${lon.toFixed(2)}/50`;
  let j;
  try { j = await getJson(url, { "User-Agent": "plane-above-me" }, 5000, "adsb.lol"); }
  catch (e) {
    if (!/429/.test(e.message)) throw e;
    await new Promise((r) => setTimeout(r, 1500)); // rate-limited: wait once, then retry
    j = await getJson(url, { "User-Agent": "plane-above-me" }, 5000, "adsb.lol (retry)");
  }
  if (!Array.isArray(j.ac)) throw new Error("adsb.lol bad data");
  return { ac: j.ac };
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
    const goodKey = new Request(`https://cache.internal/adsb-last-good?lat=${la}&lon=${lo}`);
    const hit = await cache.match(key);
    if (hit) return hit;

    // Race every source in parallel; first one to return data wins.
    const sources = [["adsb.fi", () => fromAdsbFi(la, lo)], ["adsb.lol", () => fromAdsbLol(la, lo)]];
    if (env.OPENSKY_CLIENT_ID && env.OPENSKY_CLIENT_SECRET) sources.push(["opensky", () => fromOpenSky(env, la, lo)]);
    sources.push(["opensky-anon", () => fromOpenSky(null, la, lo)]);
    const tried = [];
    try {
      const { data, name } = await Promise.any(
        sources.map(([name, fn]) => fn().then((data) => ({ data, name }), (e) => { tried.push(name + ": " + (e.name === "TimeoutError" ? "timeout" : e.message)); throw e; }))
      );
      const res = Response.json(data, { headers: { "cache-control": "public, max-age=8", "x-source": name } });
      ctx.waitUntil(cache.put(key, res.clone()));
      ctx.waitUntil(cache.put(goodKey, Response.json(data, { headers: { "cache-control": "public, max-age=300" } })));
      return res;
    } catch (_) {
      // Every feed failed: serve the last good answer for this spot (up to 5 min old) rather than an error.
      const stale = await cache.match(goodKey);
      if (stale) return new Response(stale.body, { headers: { "content-type": "application/json", "cache-control": "no-store", "x-source": "stale" } });
      return new Response("all upstreams failed: " + tried.join(" | "), { status: 502 });
    }
  },
};
