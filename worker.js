// Serves the static site and proxies live traffic data (several free ADS-B feeds, tried in order).
const SOURCES = [
  (la, lo) => `https://api.adsb.lol/v2/point/${la}/${lo}/50`,
  (la, lo) => `https://api.airplanes.live/v2/point/${la}/${lo}/50`,
  (la, lo) => `https://opendata.adsb.fi/api/v2/lat/${la}/lon/${lo}/dist/50`,
];

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname !== "/api/adsb") return env.ASSETS.fetch(req);
    const lat = parseFloat(url.searchParams.get("lat")), lon = parseFloat(url.searchParams.get("lon"));
    if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180)
      return new Response("bad request", { status: 400 });
    const la = lat.toFixed(2), lo = lon.toFixed(2); // ~1 km rounding: better cache hits, more privacy
    const tried = [];
    for (const build of SOURCES) {
      const src = build(la, lo);
      try {
        const r = await fetch(src, {
          headers: { "User-Agent": "plane-above-me (suvadipchakraborty.workers.dev)", Accept: "application/json" },
          signal: AbortSignal.timeout(6000),
          cf: { cacheEverything: true, cacheTtlByStatus: { "200-299": 15, "400-599": 0 } },
        });
        if (r.ok) {
          const j = await r.json();
          if (Array.isArray(j.ac)) return Response.json(j, { headers: { "cache-control": "no-store", "x-source": new URL(src).host } });
        }
        tried.push(new URL(src).host + ":" + r.status);
      } catch (e) {
        tried.push(new URL(src).host + ":err");
      }
    }
    return new Response("all upstreams failed: " + tried.join(", "), { status: 502 });
  },
};
