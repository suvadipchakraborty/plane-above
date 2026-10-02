(() => {
  const $ = (id) => document.getElementById(id);
  const radar = $("radar"), blip = $("blip"), card = $("card"), status = $("status"), btn = $("scanBtn");
  const RADAR_MILES = 50, M_PER_MI = 1609.344;
  let last = null, deferredPrompt = null, audio = null;

  // Haversine distance in miles
  const toRad = (d) => (d * Math.PI) / 180;
  function haversine(lat1, lon1, lat2, lon2) {
    const R = 3958.8, dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }
  function bearing(lat1, lon1, lat2, lon2) {
    const dLon = toRad(lon2 - lon1);
    const y = Math.sin(dLon) * Math.cos(toRad(lat2));
    const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) - Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLon);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  }

  function ping() {
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      const o = audio.createOscillator(), g = audio.createGain(), t = audio.currentTime;
      o.type = "sine"; o.frequency.setValueAtTime(1400, t); o.frequency.exponentialRampToValueAtTime(700, t + 0.4);
      g.gain.setValueAtTime(0.25, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
      o.connect(g).connect(audio.destination); o.start(t); o.stop(t + 0.5);
    } catch (e) {}
  }

  const geo = (opts) => new Promise((res, rej) =>
    navigator.geolocation ? navigator.geolocation.getCurrentPosition(res, rej, opts) : rej({ code: 0 }));
  const pick = (p) => ({ latitude: p.coords.latitude, longitude: p.coords.longitude, approx: false });

  // 1) fast network/Wi-Fi fix  2) high-accuracy GPS  3) approximate IP location (last resort)
  async function getPosition() {
    try { return pick(await geo({ enableHighAccuracy: false, timeout: 12000, maximumAge: 300000 })); }
    catch (e) {
      if (e.code === 1) throw e; // user blocked location: respect it
      status.textContent = "Trying GPS…";
      try { return pick(await geo({ enableHighAccuracy: true, timeout: 20000, maximumAge: 0 })); }
      catch (e2) {
        if (e2.code === 1) throw e2;
        status.textContent = "Using approximate location…";
        try {
          const j = await (await fetch("https://ipwho.is/")).json();
          if (j.success && j.latitude != null) return { latitude: j.latitude, longitude: j.longitude, approx: true };
        } catch (_) {}
        throw e2;
      }
    }
  }
  let approx = false;
  const note = () => (approx ? `<p class="note">Approximate location from your network. Distances may be off by several miles. Allow device location for an exact scan.</p>` : "");

  async function scan() {
    btn.disabled = true; card.hidden = true; blip.hidden = true;
    radar.classList.add("scanning");
    status.textContent = "Acquiring GPS fix…";
    try { audio = audio || new (window.AudioContext || window.webkitAudioContext)(); } catch (e) {}
    try {
      const pos = await getPosition();
      const { latitude: lat, longitude: lon } = pos; approx = pos.approx;
      status.textContent = "Sweeping airspace…";
      const dLat = 1, dLon = 1 / Math.max(Math.cos(toRad(lat)), 0.05);
      const url = `https://opensky-network.org/api/states/all?lamin=${lat - dLat}&lomin=${lon - dLon}&lamax=${lat + dLat}&lomax=${lon + dLon}`;
      const res = await fetch(url);
      if (res.status === 429) throw new Error("rate");
      if (!res.ok) throw new Error("api");
      const data = await res.json();

      const flying = (data.states || [])
        .filter((s) => !s[8] && s[5] != null && s[6] != null && (s[7] ?? s[13]) != null)
        .map((s) => ({
          callsign: (s[1] || "").trim() || s[0].toUpperCase(),
          country: s[2],
          alt: s[7] ?? s[13],
          speed: s[9],
          dist: haversine(lat, lon, s[6], s[5]),
          brg: bearing(lat, lon, s[6], s[5]),
        }))
        .sort((a, b) => a.dist - b.dist);

      if (!flying.length) { last = null; showEmpty(); return; }
      last = flying[0]; showPlane(last);
    } catch (e) {
      showError(e);
    } finally {
      radar.classList.remove("scanning"); btn.disabled = false; btn.textContent = "Scan Again";
    }
  }

  const fmt = (n) => Math.round(n).toLocaleString();

  function showPlane(p) {
    const ft = p.alt * 3.28084, mph = (p.speed ?? 0) * 2.23694, kt = (p.speed ?? 0) * 1.94384;
    const r = Math.min(p.dist / RADAR_MILES, 1) * 50;
    blip.style.left = 50 + r * Math.sin(toRad(p.brg)) + "%";
    blip.style.top = 50 - r * Math.cos(toRad(p.brg)) + "%";
    blip.hidden = false;
    status.textContent = "Target locked";
    card.innerHTML = `<div class="dist">${p.dist.toFixed(1)} miles away<small>${compass(p.brg)} of you</small></div>
      <dl class="grid">
        <div><dt>Callsign</dt><dd>${esc(p.callsign)}</dd></div>
        <div><dt>Origin</dt><dd>${esc(p.country)}</dd></div>
        <div><dt>Altitude</dt><dd>${fmt(ft)} ft</dd></div>
        <div><dt>Speed</dt><dd>${fmt(mph)} mph · ${fmt(kt)} kt</dd></div>
      </dl>${note()}`;
    card.hidden = false;
    if (navigator.vibrate) navigator.vibrate([60, 40, 120]);
    ping();
    if (navigator.share) $("shareBtn").hidden = false;
  }
  function showEmpty() {
    status.textContent = "No contacts";
    card.innerHTML = `<p class="empty">Airspace clear. No flights detected in your immediate vicinity.</p>${note()}`;
    card.hidden = false; $("shareBtn").hidden = true;
  }
  function showError(e) {
    const msg = e.code === 1 ? "Location is blocked for this site. Open your browser menu → Site settings → Location → Allow, then scan again."
      : e.code === 2 ? "Your phone couldn't work out its location. Turn on Location in your phone settings, then scan again."
      : e.code === 3 ? "Location timed out. Move near a window or open sky, then scan again."
      : e.message === "rate" ? "OpenSky rate limit reached. Wait a minute and try again."
      : e.code === 0 ? "This browser doesn't support location. Try opening the app in Chrome or Safari."
      : "Couldn't reach the OpenSky radar feed. Check your connection and try again.";
    status.textContent = "Scan failed";
    card.innerHTML = `<p class="empty">${msg}</p>`; card.hidden = false; $("shareBtn").hidden = true;
  }
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const compass = (b) => ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"][Math.round(b / 45) % 8];

  btn.addEventListener("click", scan);

  // Share
  $("shareBtn").addEventListener("click", async () => {
    if (!last) return;
    const text = `There's a flight from ${last.country} (${last.callsign}) at ${fmt(last.alt * 3.28084)} ft, just ${last.dist.toFixed(1)} miles from me right now! ✈️`;
    try { await navigator.share({ title: "Plane Above Me", text, url: "https://plane-above.suvadipchakraborty.workers.dev/" }); } catch (e) {}
  });

  // PWA install
  window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); deferredPrompt = e; $("installBtn").hidden = false; });
  $("installBtn").addEventListener("click", async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt(); await deferredPrompt.userChoice; deferredPrompt = null; $("installBtn").hidden = true;
  });
  window.addEventListener("appinstalled", () => ($("installBtn").hidden = true));

  if ("serviceWorker" in navigator) window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
})();
