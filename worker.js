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

async function fromAdsbLol(lat, lon) {
  const r = await fetch(`https://api.adsb.lol/v2/point/${lat.toFixed(2)}/${lon.toFixed(2)}/50`, {
    headers: { "User-Agent": "plane-above-me", Accept: "application/json" },
    signal: AbortSignal.timeout(6000),
  });
  if (!r.ok) throw new Error("adsb.lol " + r.status);
  const j = await r.json();
  if (!Array.isArray(j.ac)) throw new Error("adsb.lol bad data");
  return j;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname !== "/api/adsb") return env.ASSETS.fetch(req);
    const lat = parseFloat(url.searchParams.get("lat")), lon = parseFloat(url.searchParams.get("lon"));
    if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180)
      return new Response("bad request", { status: 400 });
    const la = Math.round(lat * 100) / 100, lo = Math.round(lon * 100) / 100; // ~1 km rounding for privacy
    const steps = [];
    if (env.OPENSKY_CLIENT_ID && env.OPENSKY_CLIENT_SECRET) steps.push(["opensky", () => fromOpenSky(env, la, lo)]);
    else steps.push(["opensky", async () => { throw new Error("secrets not set"); }]);
    steps.push(["adsb.lol", () => fromAdsbLol(la, lo)]);
    const tried = [];
    for (const [name, fn] of steps) {
      try {
        const data = await fn();
        return Response.json(data, { headers: { "cache-control": "no-store", "x-source": name } });
      } catch (e) {
        tried.push(name + ": " + e.message);
      }
    }
    return new Response("all upstreams failed: " + tried.join(", "), { status: 502 });
  },
};
