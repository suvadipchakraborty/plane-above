// Serves the static site and proxies live traffic data so the browser never calls adsb.lol directly.
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname !== "/api/adsb") return env.ASSETS.fetch(req);
    const lat = parseFloat(url.searchParams.get("lat")), lon = parseFloat(url.searchParams.get("lon"));
    if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180)
      return new Response("bad request", { status: 400 });
    try {
      const r = await fetch(`https://api.adsb.lol/v2/point/${lat.toFixed(3)}/${lon.toFixed(3)}/50`, {
        headers: { "User-Agent": "plane-above-me" },
        cf: { cacheTtl: 10, cacheEverything: true },
      });
      return new Response(r.body, { status: r.status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
    } catch (e) {
      return new Response("upstream error", { status: 502 });
    }
  },
};
