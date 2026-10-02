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
    try { return pick(await geo({ enableHighAccuracy: false, timeout: 8000, maximumAge: 300000 })); }
    catch (e) {
      if (e.code === 1) throw e; // user blocked location: respect it
      status.textContent = "Trying GPS…";
      try { return pick(await geo({ enableHighAccuracy: true, timeout: 10000, maximumAge: 0 })); }
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

  // ---- Traffic sources: OpenSky first, adsb.lol as automatic fallback ----
  const timeout = (ms) => AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined;

  async function fromOpenSky(lat, lon) {
    const dLat = 1, dLon = 1 / Math.max(Math.cos(toRad(lat)), 0.05);
    const url = `https://opensky-network.org/api/states/all?lamin=${lat - dLat}&lomin=${lon - dLon}&lamax=${lat + dLat}&lomax=${lon + dLon}`;
    const res = await fetch(url, { signal: timeout(7000) });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    return (data.states || [])
      .filter((s) => !s[8] && s[5] != null && s[6] != null && (s[7] ?? s[13]) != null)
      .map((s) => ({ callsign: (s[1] || "").trim() || s[0].toUpperCase(), country: s[2], alt: s[7] ?? s[13], speed: s[9], lat: s[6], lon: s[5] }));
  }

  async function fromAdsbLol(url) {
    const res = await fetch(url, { signal: timeout(10000) });
    if (!res.ok) {
      let t = ""; try { t = (await res.text()).slice(0, 500); } catch (_) {}
      throw new Error("HTTP " + res.status + (t ? ` (${t})` : ""));
    }
    const data = await res.json();
    return (data.ac || data.aircraft || [])
      .filter((a) => typeof a.alt_baro === "number" && a.lat != null && a.lon != null)
      .map((a) => ({
        callsign: (a.flight || "").trim() || (a.r || a.hex || "").toUpperCase(),
        country: a.country || countryFromHex(a.hex), type: a.t || "",
        alt: a.alt_baro * 0.3048, speed: (a.gs ?? 0) * 0.514444, lat: a.lat, lon: a.lon,
      }));
  }

  const why = (e) => (e && e.name === "TimeoutError" ? "timed out" : e && /^HTTP/.test(e.message) ? e.message : "blocked or unreachable");
  // Order: own server proxy (OpenSky signed-in, then adsb.lol) -> adsb.lol direct -> OpenSky anonymous
  async function getTraffic(lat, lon) {
    const fails = [];
    const la = lat.toFixed(3), lo = lon.toFixed(3);
    const steps = [
      ["proxy", () => fromAdsbLol(`/api/adsb?lat=${la}&lon=${lo}`)],
      ["adsb.lol", () => fromAdsbLol(`https://api.adsb.lol/v2/point/${la}/${lo}/50`)],
      ["OpenSky", () => fromOpenSky(lat, lon)],
    ];
    for (const [name, fn] of steps) {
      try { return await fn(); } catch (e) { fails.push(`${name}: ${why(e)}`); status.textContent = "Switching radar feed…"; }
    }
    const err = new Error("feeds"); err.detail = fails.join(". ") + "."; throw err;
  }

  // Country of registration from the ICAO 24-bit address block
  const ICAO = [
    [0xA00000,0xAFFFFF,"United States"],[0xC00000,0xC3FFFF,"Canada"],[0x400000,0x43FFFF,"United Kingdom"],
    [0x3C0000,0x3FFFFF,"Germany"],[0x380000,0x3BFFFF,"France"],[0x300000,0x33FFFF,"Italy"],[0x340000,0x37FFFF,"Spain"],
    [0x480000,0x487FFF,"Netherlands"],[0x488000,0x48FFFF,"Poland"],[0x448000,0x44FFFF,"Belgium"],[0x440000,0x447FFF,"Austria"],
    [0x4B0000,0x4B7FFF,"Switzerland"],[0x4B8000,0x4BFFFF,"Turkey"],[0x4A0000,0x4A7FFF,"Sweden"],[0x478000,0x47FFFF,"Norway"],
    [0x458000,0x45FFFF,"Denmark"],[0x460000,0x467FFF,"Finland"],[0x468000,0x46FFFF,"Greece"],[0x490000,0x497FFF,"Portugal"],
    [0x4CA000,0x4CAFFF,"Ireland"],[0x100000,0x1FFFFF,"Russia"],[0x800000,0x83FFFF,"India"],[0x788000,0x78FFFF,"Hong Kong"],
    [0x780000,0x7BFFFF,"China"],[0x840000,0x87FFFF,"Japan"],[0x718000,0x71FFFF,"South Korea"],[0x7C0000,0x7FFFFF,"Australia"],
    [0xC80000,0xC87FFF,"New Zealand"],[0xE00000,0xE3FFFF,"Brazil"],[0xE40000,0xE7FFFF,"Argentina"],[0x0D0000,0x0D7FFF,"Mexico"],
    [0x896000,0x896FFF,"United Arab Emirates"],[0x06A000,0x06AFFF,"Qatar"],[0x710000,0x717FFF,"Saudi Arabia"],
    [0x768000,0x76FFFF,"Singapore"],[0x750000,0x757FFF,"Malaysia"],[0x758000,0x75FFFF,"Philippines"],[0x880000,0x887FFF,"Thailand"],
    [0x888000,0x88FFFF,"Vietnam"],[0x8A0000,0x8A7FFF,"Indonesia"],[0x760000,0x767FFF,"Pakistan"],[0x770000,0x777FFF,"Sri Lanka"],
    [0x738000,0x73FFFF,"Israel"],[0x730000,0x737FFF,"Iran"],[0x010000,0x017FFF,"Egypt"],[0x008000,0x00FFFF,"South Africa"],
    [0x040000,0x047FFF,"Ethiopia"],
  ];
  const countryFromHex = (hex) => {
    const n = parseInt(hex, 16);
    const m = ICAO.find(([lo, hi]) => n >= lo && n <= hi);
    return m ? m[2] : "Unknown";
  };

  async function scan() {
    btn.disabled = true; card.hidden = true; blip.hidden = true;
    radar.classList.add("scanning");
    status.textContent = "Acquiring GPS fix…";
    try { audio = audio || new (window.AudioContext || window.webkitAudioContext)(); } catch (e) {}
    try {
      const pos = await getPosition();
      const { latitude: lat, longitude: lon } = pos; approx = pos.approx;
      status.textContent = "Sweeping airspace…";
      const flying = (await getTraffic(lat, lon))
        .map((p) => ({ ...p, dist: haversine(lat, lon, p.lat, p.lon), brg: bearing(lat, lon, p.lat, p.lon) }))
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
        ${p.type ? `<div><dt>Aircraft</dt><dd>${esc(p.type)}</dd></div>` : ""}
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
      : `Couldn't reach the radar feeds. Check your connection, turn off any VPN or ad blocker, and try again.${e.detail ? `<br><small>${e.detail}</small>` : ""}`;
    status.textContent = "Scan failed";
    card.innerHTML = `<p class="empty">${msg}</p>`; card.hidden = false; $("shareBtn").hidden = true;
  }
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const compass = (b) => ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"][Math.round(b / 45) % 8];

  btn.addEventListener("click", scan);

  // Share
  $("shareBtn").addEventListener("click", async () => {
    if (!last) return;
    const text = `There's a ${last.type ? last.type + " " : ""}flight from ${last.country} (${last.callsign}) at ${fmt(last.alt * 3.28084)} ft, just ${last.dist.toFixed(1)} miles from me right now! ✈️`;
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
