// ================= CONFIG =================
const CFG = {
  WS_URL: 'wss://YOUR-CLUSTER.s1.eu.hivemq.cloud:8884/mqtt',   // HiveMQ host
  VIEW:    { u: 'web-view',    p: 'CHANGE_ME' },  // HiveMQ account: SIRF subscribe
  CONTROL: { u: 'web-control', p: 'CHANGE_ME' },  // HiveMQ account: SIRF publish commands/#  (CHANGE_ME = controls band)
  CITY: 'Jaipur, Rajasthan', LAT: 26.91, LON: 75.79
};
// OPTIONAL password lock (abhi band). Basic lock hai, asli security nahi - dekhiye niche note.
// Chalu karne ke liye enabled:true karein aur sha256 mein hash daalein (hash banane ka tarika alag message mein).
const LOCK = { enabled: false, sha256: '' };   // hash of "username:password"

const B = 'sinchai-sarthi/', LIVE = 15000, STALE = 45000;
const $ = s => document.querySelector(s), $$ = s => document.querySelectorAll(s);
const ls = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const sv = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
let D = null, last = 0, online = null, viewC = null, ctlC = null;
let R = ls('ranges', { soil: [40, 60], temp: [15, 25], hum: [50, 70] }), H = ls('hist', []), N = [], act = {};

// ---------- themes ----------
const THEMES = [['green', '🌿 Green'], ['dark', '🌙 Dark'], ['blue', '💧 Blue'], ['orange', '🌾 Orange']];
function setTheme(t) { document.documentElement.dataset.theme = t; sv('theme', t);
  $$('#themes button').forEach(b => b.classList.toggle('on', b.dataset.th === t)); }
$('#themes').innerHTML = THEMES.map(([k, n]) => `<button class="th" data-th="${k}">${n}</button>`).join('');
$('#themes').addEventListener('click', e => { const b = e.target.closest('[data-th]'); if (b) setTheme(b.dataset.th); });
const cycle = () => { const i = THEMES.findIndex(t => t[0] === document.documentElement.dataset.theme); setTheme(THEMES[(i + 1) % THEMES.length][0]); };
$('#themeBtn1').onclick = cycle; $('#themeBtn2').onclick = cycle;
setTheme(ls('theme', 'green'));

// ---------- welcome ----------
function tick() { const n = new Date();
  $('#date').textContent = n.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'short', year: 'numeric' });
  $('#time').textContent = n.toLocaleTimeString('en-IN'); }
tick(); setInterval(tick, 1000);
$('#city').textContent = CFG.CITY;
fetch(`https://api.open-meteo.com/v1/forecast?latitude=${CFG.LAT}&longitude=${CFG.LON}&current=temperature_2m`)
  .then(r => r.json()).then(j => $('#wx').textContent = Math.round(j.current.temperature_2m) + '°C (live)')
  .catch(() => $('#wx').textContent = 'Weather unavailable');

function openApp() { $('#home').hidden = true; $('#lock').hidden = true; $('#app').hidden = false; connect(); }
$('#start').onclick = () => { if (LOCK.enabled && sessionStorage.getItem('unlocked') !== '1') $('#lock').hidden = false; else openApp(); };

// ---------- optional lock ----------
async function sha(s) { const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join(''); }
$('#lockForm').addEventListener('submit', async e => { e.preventDefault();
  if (await sha($('#lu').value + ':' + $('#lp').value) === LOCK.sha256) { try { sessionStorage.setItem('unlocked', '1'); } catch {} openApp(); }
  else $('#lerr').textContent = 'Wrong username or password'; $('#lp').value = ''; });

// ---------- navigation ----------
function show(id) { $$('.sec').forEach(s => s.hidden = s.id !== id);
  $$('#menu [data-s]').forEach(b => b.classList.toggle('on', b.dataset.s === id));
  $('#menu').classList.remove('open');
  if (id === 'history') chart(); if (id === 'notif') $('#nc').textContent = ''; }
$$('#menu [data-s]').forEach(b => b.onclick = () => show(b.dataset.s));
$('#burger').onclick = () => $('#menu').classList.toggle('open');

// ---------- MQTT over secure WebSocket (wss/TLS) ----------
const mk = c => mqtt.connect(CFG.WS_URL, { username: c.u, password: c.p, reconnectPeriod: 4000, connectTimeout: 10000,
  clientId: 'web-' + Math.random().toString(16).slice(2, 10) });
const mqs = (t, c) => { $('#mq').textContent = t; $('#mq').className = c; };
function connect() {
  if (viewC) return;
  viewC = mk(CFG.VIEW);
  viewC.on('connect', () => { mqs('CONNECTED', 'ok'); viewC.subscribe([B + 'main/#', B + 'transmitter/#', B + 'status/#']); });
  viewC.on('reconnect', () => mqs('RECONNECTING', 'warn'));
  viewC.on('close', () => mqs('DISCONNECTED', 'bad'));
  viewC.on('error', () => mqs('ERROR (credentials/ACL?)', 'bad'));
  viewC.on('message', (t, buf) => { const m = buf.toString();
    if (t === B + 'status/main') { online = m === 'online'; if (!online) note('ESP32 offline ho gaya'); render(); }
    else if (t === B + 'main/telemetry') { try { D = JSON.parse(m); last = Date.now(); record(); alerts(); render(); } catch {} } });
  if (!CFG.CONTROL.p.includes('CHANGE_ME')) ctlC = mk(CFG.CONTROL);
}
function send(sub, p) {
  if (!ctlC || !ctlC.connected) return $('#toast').textContent = 'Control band hai ya connect nahi - command NAHI gaya';
  ctlC.publish(B + 'commands/' + sub, p, { qos: 1, retain: false },
    e => $('#toast').textContent = e ? 'Send failed (ACL?)' : `Sent: ${sub} = ${p}`);
}
document.addEventListener('click', e => { const b = e.target.closest('button[data-t]'); if (b) send(b.dataset.t, b.dataset.p); });
$$('.ang').forEach(r => [0, 45, 90, 135, 180].forEach(a => { const b = document.createElement('button');
  b.textContent = a + '°'; b.dataset.t = r.dataset.t; b.dataset.p = a; r.appendChild(b); }));

// ---------- render ----------
const f = (v, u = '', d = 0) => v == null ? 'N/A' : Number(v).toFixed(d) + u;
function fresh() { if (!last || online === false) return 'off'; const a = Date.now() - last; return a < LIVE ? 'live' : a < STALE ? 'stale' : 'off'; }
function render() {
  const s = fresh(), bd = $('#badge');
  bd.className = 'badge ' + s; bd.textContent = s === 'live' ? 'LIVE' : s === 'stale' ? 'STALE DATA' : 'OFFLINE';
  if (!D) return;
  const o = s !== 'live' ? ' (old)' : '', so = D.solar || {}, n = D.npk || {};
  const V = { soil: f(D.soil, ' %'), temp: f(D.temperature, ' °C', 1), hum: f(D.humidity, ' %'),
    rain: D.rain === 'RAIN' ? 'RAIN DETECTED' : 'NO RAIN', valve: D.valve === 'ON' ? 'OPEN' : 'CLOSED', pump: D.pump,
    flow: D.flow == null ? 'NOT CALIBRATED' : f(D.flow, ' L/min', 1), total: f(D.total, ' L', 1),
    v: f(so.v_cmd, '°'), h: f(so.h_cmd, '°'), vm: 'Movement: ' + (so.v_move || 'N/A'), hm: 'Movement: ' + (so.h_move || 'N/A'),
    espnow: D.espnow ? 'CONNECTED' : 'DISCONNECTED', wifi: D.wifi ? `CONNECTED (${D.rssi} dBm)` : 'DOWN',
    ts: (D.ts || '').replace('T', ' '), last: new Date(last).toLocaleTimeString(),
    n: f(n.n, ' mg/kg'), p: f(n.p, ' mg/kg'), k: f(n.k, ' mg/kg') };
  const live = ['soil', 'temp', 'hum', 'rain', 'flow', 'total', 'v', 'h', 'n', 'p', 'k'];
  $$('[data-k]').forEach(el => { const k = el.dataset.k; if (V[k] === undefined) return;
    el.textContent = V[k] + (live.includes(k) ? o : ''); el.style.opacity = o ? .5 : 1; });
  $('#tb').innerHTML = [['soil', 'Soil Moisture', D.soil, '%'], ['temp', 'Temperature', D.temperature, '°C'], ['hum', 'Humidity', D.humidity, '%']]
    .map(([k, nm, v, u]) => { const [a, b] = R[k]; const st = v == null ? ['N/A', ''] : v < a ? ['LOW', 'warn'] : v > b ? ['HIGH', 'bad'] : ['OK', 'ok'];
      return `<tr><td>${nm}</td><td>${v == null ? 'N/A' : v + u}</td><td>${a}–${b}${u}</td><td class="${st[1]}">${st[0]}</td></tr>`; }).join('')
    + `<tr><td>Rain</td><td>${V.rain}</td><td>Dry</td><td class="${D.rain === 'RAIN' ? 'warn' : 'ok'}">${D.rain === 'RAIN' ? 'RAIN' : 'OK'}</td></tr>`;
}
setInterval(render, 2000);

// ---------- settings ----------
$('#rng').innerHTML = [['soil', 'Soil Moisture %'], ['temp', 'Temperature °C'], ['hum', 'Humidity %']].map(([k, nm]) =>
  `<p>${nm}: <input type="number" data-r="${k}" data-i="0" value="${R[k][0]}"> to <input type="number" data-r="${k}" data-i="1" value="${R[k][1]}"></p>`).join('');
$('#rng').addEventListener('change', e => { const i = e.target; if (!i.dataset.r) return;
  R[i.dataset.r][+i.dataset.i] = +i.value; sv('ranges', R); render(); });

// ---------- history ----------
function record() { if (D.soil == null) return; const t = Date.now();
  if (H.length && t - H[H.length - 1].t < 30000) return;
  H.push({ t, soil: D.soil, temp: D.temperature, hum: D.humidity }); if (H.length > 300) H.shift(); sv('hist', H); }
function chart() {
  const k = $('#hsel').value, p = H.map(x => x[k]).filter(v => v != null), svg = $('#ch');
  if (p.length < 2) { svg.innerHTML = ''; $('#hs').textContent = 'Abhi kam data hai, dashboard khula rakhiye.'; return; }
  const mn = Math.min(...p), mx = Math.max(...p), r = (mx - mn) || 1;
  svg.innerHTML = `<polyline fill="none" stroke="var(--acc)" stroke-width="2" vector-effect="non-scaling-stroke" points="${
    p.map((v, i) => `${i / (p.length - 1) * 300},${110 - (v - mn) / r * 100}`).join(' ')}"/>`;
  $('#hs').textContent = `Points: ${p.length} | Min ${mn} | Max ${mx} | Latest ${p[p.length - 1]}`; }
$('#hsel').onchange = chart;

// ---------- notifications ----------
function note(m) { N.unshift(new Date().toLocaleTimeString() + ' - ' + m); N = N.slice(0, 30);
  $('#nl').innerHTML = N.map(x => `<p>🔔 ${x}</p>`).join('');
  if ($('#notif').hidden) $('#nc').textContent = Math.min(N.length, 9); }
function alerts() {
  const c = { dry: D.soil != null && D.soil < R.soil[0], hot: D.temperature != null && D.temperature > R.temp[1], rain: D.rain === 'RAIN', tx: !D.espnow };
  const msg = { dry: 'Mitti sookhi hai - paani dene ka samay', hot: 'Temperature ideal se zyada hai', rain: 'Baarish detect hui', tx: 'Transmitter disconnected' };
  for (const k in c) { if (c[k] && !act[k]) note(msg[k]); act[k] = c[k]; } }
