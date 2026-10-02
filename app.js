// ---------- CONFIG ----------
const CONFIG = {
  AIRLABS_API_KEY: 'YOUR_AIRLABS_API_KEY', // paste key once AirLabs approves you
  USE_API: false,                          // flip to true after adding the key
  API_BASE: 'https://airlabs.co/api/v9/',
  API_HUBS: ['LHR','JFK','DXB','SIN','FRA','DOH'], // departure hubs sampled by the daily seed
  MAX_GUESSES: 5,
  LAUNCH: '2026-10-01',                    // Flightdle #1
  SHARE_URL: 'https://plane-above.suvadipchakraborty.workers.dev'
};
const $ = id => document.getElementById(id);
const ARROWS = ['⬆️','↗️','➡️','↘️','⬇️','↙️','⬅️','↖️'];
const todayStr = new Date().toISOString().slice(0, 10); // UTC, so everyone shares one puzzle
const dayMs = s => Date.parse(s + 'T00:00:00Z');
const puzzleNo = Math.round((dayMs(todayStr) - dayMs(CONFIG.LAUNCH)) / 864e5) + 1;

// ---------- seeded RNG ----------
function hash(s){let h=2166136261;for(const c of s)h=Math.imul(h^c.charCodeAt(0),16777619);return h>>>0}
function mulberry32(a){return()=>{a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296}}

// ---------- geo ----------
const rad = d => d * Math.PI / 180;
function km(a, b) {
  const dLa = rad(b[1]-a[1]), dLo = rad(b[2]-a[2]);
  const h = Math.sin(dLa/2)**2 + Math.cos(rad(a[1]))*Math.cos(rad(b[1]))*Math.sin(dLo/2)**2;
  return 12742 * Math.asin(Math.sqrt(h));
}
function dir(a, b) {
  const p1 = rad(a[1]), p2 = rad(b[1]), dl = rad(b[2]-a[2]);
  const y = Math.sin(dl)*Math.cos(p2), x = Math.cos(p1)*Math.sin(p2) - Math.sin(p1)*Math.cos(p2)*Math.cos(dl);
  return Math.round(((Math.atan2(y, x)*180/Math.PI + 360) % 360) / 45) % 8;
}

// ---------- flight selection ----------
let AIRPORTS = {}, flight;
const label = c => `${AIRPORTS[c][0]} (${c})`;
const fmtTime = m => `${Math.floor(m/60)}h ${String(Math.round(m%60)).padStart(2,'0')}m`;

async function apiFlight(rng) { // Option B: AirLabs /routes. Returns null on any failure -> fallback.
  try {
    const hub = CONFIG.API_HUBS[Math.floor(rng()*CONFIG.API_HUBS.length)];
    const r = await fetch(`${CONFIG.API_BASE}routes?dep_iata=${hub}&api_key=${CONFIG.AIRLABS_API_KEY}`);
    const list = ((await r.json()).response || [])
      .filter(f => AIRPORTS[f.arr_iata] && f.duration)
      .sort((a, b) => (a.flight_iata || '').localeCompare(b.flight_iata || '')); // stable order = same pick for everyone
    if (!list.length) return null;
    const f = list[Math.floor(rng()*list.length)];
    return { o: f.dep_iata, d: f.arr_iata, airline: f.airline_iata, aircraft: f.aircraft_icao || 'Not listed', mins: f.duration };
  } catch { return null; }
}
async function pickFlight() {
  const rng = mulberry32(hash(todayStr));
  const routes = await (await fetch('routes.json')).json();
  const idx = Math.floor(rng()*routes.length); // consumed first so the fallback is identical with or without the API
  if (CONFIG.USE_API && !CONFIG.AIRLABS_API_KEY.startsWith('YOUR_')) {
    const f = await apiFlight(rng); if (f) return f;
  }
  const [o, d, airline, aircraft] = routes[idx];
  return { o, d, airline, aircraft, mins: km(AIRPORTS[o], AIRPORTS[d]) / 850 * 60 + 30 };
}

// ---------- state ----------
const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) || d } catch { return d } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)) } catch {} };
let stats = load('flightdle-stats', { played: 0, wins: 0, streak: 0, last: '' });
let st = load('flightdle-day', null);
if (!st || st.day !== todayStr) st = { day: todayStr, guesses: [], done: false, won: false };

// ---------- UI ----------
function addRow(g, animate) {
  const row = document.createElement('div'); row.className = 'row';
  [`${g.code}<small>${AIRPORTS[g.code][0]}</small>`, g.hit ? 'Arrived' : `${Math.round(g.km).toLocaleString()} km`, g.hit ? '🎯' : ARROWS[g.dir]].forEach((t, i) => {
    const d = document.createElement('div');
    d.className = `tile ${g.cls}${animate ? ' anim' : ''}`; d.style.setProperty('--i', i); d.innerHTML = t; row.append(d);
  });
  $('rows').append(row);
}
function renderLeft() {
  $('pass').style.setProperty('--p', st.won ? 1 : Math.min(st.guesses.length / CONFIG.MAX_GUESSES, 1) * 0.8);
  $('left').innerHTML = '';
  for (let i = 0; i < CONFIG.MAX_GUESSES; i++) {
    const s = document.createElement('i'), g = st.guesses[i];
    if (g) s.className = g.hit ? 'win' : 'on'; $('left').append(s);
  }
}
function grid(url = true) {
  const sq = g => g.hit ? '🟩' : g.cls === 'warm' ? '🟨' : '🟥';
  const score = st.won ? st.guesses.length : 'X';
  return `Flightdle #${puzzleNo} ✈️ ${score}/${CONFIG.MAX_GUESSES}\n` +
    st.guesses.map(g => sq(g) + (g.hit ? '🎯' : ARROWS[g.dir])).join('\n') + (url ? `\n${CONFIG.SHARE_URL}` : '');
}
function showModal() {
  $('m-title').textContent = st.won ? 'Cleared for landing!' : 'Diverted';
  $('m-sub').textContent = `Destination: ${label(flight.d)}`;
  $('s-played').textContent = stats.played; $('s-wins').textContent = stats.wins; $('s-streak').textContent = stats.streak;
  $('m-grid').textContent = grid(false); $('modal').hidden = false; tick();
}
function setDest(code, animate) {
  [...$('c-dest').children].forEach((el, i) => { el.textContent = code[i]; el.style.setProperty('--i', i); el.classList.add(st.won ? 'ok' : 'miss'); if (animate) el.classList.add('anim'); });
}
let timer;
function tick() {
  const n = new Date(), s = Math.max(0, Math.floor((Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate() + 1) - n) / 1000));
  $('m-next').textContent = [s/3600, s%3600/60, s%60].map(v => String(Math.floor(v)).padStart(2, '0')).join(':');
  clearTimeout(timer); if (!$('modal').hidden) timer = setTimeout(tick, 1000);
}
function finish(animated) {
  setDest(flight.d, animated); $('guess').disabled = $('go').disabled = true; $('results').hidden = false;
  setTimeout(showModal, animated ? 1600 : 0);
}

function resolve(v) {
  v = v.trim().toUpperCase(); if (!v) return null;
  if (AIRPORTS[v]) return v;
  const m = v.match(/\(([A-Z]{3})\)/); if (m && AIRPORTS[m[1]]) return m[1];
  return Object.keys(AIRPORTS).find(c => AIRPORTS[c][0].toUpperCase() === v) ||
         Object.keys(AIRPORTS).find(c => AIRPORTS[c][0].toUpperCase().startsWith(v)) || null;
}
function submit() {
  if (st.done) return;
  const code = resolve($('guess').value);
  if (!code) { $('msg').textContent = 'Airport not found. Pick one from the suggestions.'; return; }
  if (st.guesses.some(g => g.code === code)) { $('msg').textContent = 'You already tried that airport.'; return; }
  $('msg').textContent = ''; $('guess').value = '';
  const A = AIRPORTS[code], T = AIRPORTS[flight.d], d = km(A, T);
  const g = { code, km: d, dir: dir(A, T), hit: code === flight.d };
  g.cls = g.hit ? 'hit' : d < 1500 ? 'warm' : 'cold';
  st.guesses.push(g); addRow(g, true); renderLeft();
  if (g.hit || st.guesses.length >= CONFIG.MAX_GUESSES) {
    st.done = true; st.won = g.hit; recordStats(); finish(true);
  }
  save('flightdle-day', st);
}
function recordStats() {
  const y = new Date(dayMs(todayStr) - 864e5).toISOString().slice(0, 10);
  stats.played++; stats.last = todayStr;
  if (st.won) { stats.wins++; stats.streak = stats.lastWin === y ? stats.streak + 1 : 1; stats.lastWin = todayStr; }
  else stats.streak = 0;
  save('flightdle-stats', stats);
}

// ---------- share ----------
async function share() {
  const text = grid();
  try { if (navigator.share) { await navigator.share({ text }); return; } } catch (e) { if (e.name === 'AbortError') return; }
  try { await navigator.clipboard.writeText(text); $('share').textContent = 'Copied!'; }
  catch { $('share').textContent = 'Copy the grid manually'; }
  setTimeout(() => $('share').textContent = 'Share', 2000);
}

// ---------- PWA ----------
let promptEvt;
addEventListener('beforeinstallprompt', e => { e.preventDefault(); promptEvt = e; });
$('install').onclick = async () => {
  if (promptEvt) { promptEvt.prompt(); promptEvt = null; }
  else alert('To install: open your browser menu and choose "Add to Home Screen" (iPhone: Share, then Add to Home Screen).');
};
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

// ---------- init ----------
(async function init() {
  AIRPORTS = await (await fetch('airports.json')).json();
  $('ap').innerHTML = Object.keys(AIRPORTS).sort().map(c => `<option value="${label(c)}">`).join('');
  flight = await pickFlight();
  const fk = flight.o + flight.d; // reset saved progress if the puzzle changed
  if (st.f !== fk) st = { day: todayStr, guesses: [], done: false, won: false, f: fk };
  $('c-o-code').textContent = flight.o; $('c-o-city').textContent = AIRPORTS[flight.o][0]; $('c-airline').textContent = flight.airline;
  $('c-no').textContent = '#' + puzzleNo; $('c-date').textContent = new Date().toUTCString().slice(5, 16);
  $('c-aircraft').textContent = flight.aircraft;
  $('c-time').textContent = '~' + fmtTime(flight.mins);
  st.guesses.forEach(g => addRow(g, false)); renderLeft();
  if (st.done) finish(false);
  $('go').onclick = submit; $('guess').onkeydown = e => e.key === 'Enter' && submit();
  const seen = load('flightdle-seen', false), closeAbout = () => { $('about').hidden = true; save('flightdle-seen', true); };
  $('info').onclick = () => $('about').hidden = false; $('about-close').onclick = closeAbout;
  document.querySelectorAll('.modal').forEach(m => m.addEventListener('click', e => { if (e.target === m) { m.hidden = true; save('flightdle-seen', true); } }));
  addEventListener('keydown', e => { if (e.key === 'Escape') document.querySelectorAll('.modal').forEach(m => m.hidden = true); });
  if (!seen && !st.guesses.length) $('about').hidden = false;
  $('share').onclick = share; $('close').onclick = () => $('modal').hidden = true; $('results').onclick = showModal;
})();
