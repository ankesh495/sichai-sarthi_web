// NO secrets in this file. Browser MQTT credentials are fetched from the server
// (Netlify Function) only after a valid login session cookie exists.
const BASE = 'sinchai-sarthi/';
const FN = '/.netlify/functions/auth';
const LIVE_MS = 15000, STALE_MS = 45000;   // telemetry every 5 s from device
let client = null, lastRx = 0, last = null, deviceOnline = null;
const $ = id => document.getElementById(id);

async function api(action, body) {
  const r = await fetch(`${FN}?a=${action}`, {
    method: body ? 'POST' : 'GET', credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined
  });
  return { ok: r.ok, status: r.status, data: await r.json().catch(() => ({})) };
}

// ---------- login ----------
$('loginForm').addEventListener('submit', async e => {
  e.preventDefault(); $('loginErr').textContent = '';
  const r = await api('login', { username: $('u').value, password: $('p').value });
  $('p').value = '';
  if (r.ok) startDashboard(); else $('loginErr').textContent = r.status === 429 ? 'Too many attempts' : 'Invalid username or password';
});
$('logout').addEventListener('click', async () => { await api('logout', {}); if (client) client.end(true); location.reload(); });

async function startDashboard() {
  const r = await api('creds');
  if (!r.ok) { $('login').hidden = false; $('dash').hidden = true; return; }   // not logged in
  $('login').hidden = true; $('dash').hidden = false;
  connectMqtt(r.data);
}

// ---------- MQTT over secure WebSocket ----------
function connectMqtt({ url, username, password }) {
  client = mqtt.connect(url, {                    // url must be wss://...
    username, password, clientId: 'web-' + Math.random().toString(16).slice(2, 10),
    reconnectPeriod: 4000, connectTimeout: 10000, clean: true
  });
  client.on('connect', () => {
    setText('mqttState', 'CONNECTED', 'ok');
    client.subscribe([BASE + 'main/#', BASE + 'transmitter/#', BASE + 'status/#'], { qos: 0 });
  });
  client.on('reconnect', () => setText('mqttState', 'RECONNECTING', 'warn'));
  client.on('close', () => setText('mqttState', 'DISCONNECTED', 'bad'));
  client.on('error', () => setText('mqttState', 'ERROR (check credentials/ACL)', 'bad'));
  client.on('message', (topic, buf) => {
    const msg = buf.toString();
    if (topic === BASE + 'status/main') { deviceOnline = (msg === 'online'); render(); return; }
    if (topic === BASE + 'main/telemetry') {
      try { last = JSON.parse(msg); lastRx = Date.now(); render(); } catch { /* ignore bad JSON */ }
    }
  });
}

// ---------- rendering ----------
function setText(id, t, cls) { const el = $(id); el.textContent = t; if (cls !== undefined) el.className = 'val ' + cls; }
const fmt = (v, u = '', d = 0) => (v === null || v === undefined) ? 'N/A' : Number(v).toFixed(d) + u;

function freshness() {
  const age = Date.now() - lastRx;
  if (!lastRx || deviceOnline === false) return 'off';
  return age < LIVE_MS ? 'live' : age < STALE_MS ? 'stale' : 'off';
}
function render() {
  const f = freshness(), b = $('liveBadge');
  b.className = 'badge ' + f; b.textContent = f === 'live' ? 'LIVE' : f === 'stale' ? 'STALE DATA' : 'OFFLINE';
  if (!last) return;
  const old = f !== 'live';                       // never show old values as live
  const d = last, s = d.solar || {}, n = d.npk || {};
  const show = (id, txt) => { $(id).textContent = old ? txt + ' (old)' : txt; $(id).style.opacity = old ? .5 : 1; };
  show('soil', fmt(d.soil, ' %')); show('temp', fmt(d.temperature, ' °C', 1)); show('hum', fmt(d.humidity, ' %'));
  show('npkN', fmt(n.n, ' mg/kg')); show('npkP', fmt(n.p, ' mg/kg')); show('npkK', fmt(n.k, ' mg/kg'));
  show('rain', d.rain === 'RAIN' ? 'RAIN DETECTED' : 'NO RAIN');
  show('pump', 'Pump: ' + d.pump); show('valve', 'Valve: ' + d.valve);
  show('flow', d.flow == null ? 'NOT CALIBRATED' : fmt(d.flow, ' L/min', 1)); show('total', fmt(d.total, ' L', 1));
  show('vcmd', fmt(s.v_cmd, '°')); show('hcmd', fmt(s.h_cmd, '°'));
  $('vmove').textContent = 'Movement: ' + (s.v_move || 'N/A'); $('hmove').textContent = 'Movement: ' + (s.h_move || 'N/A');
  setText('espnow', d.espnow ? 'CONNECTED' : 'DISCONNECTED', d.espnow ? 'ok' : 'bad');
  setText('wifi', d.wifi ? `CONNECTED (${d.rssi} dBm)` : 'DOWN', d.wifi ? 'ok' : 'bad');
  $('ts').textContent = (d.ts || '').replace('T', '  '); $('dev').textContent = d.device || '--';
  $('last').textContent = new Date(lastRx).toLocaleTimeString();
}
setInterval(render, 2000);

// ---------- controls ----------
function send(sub, payload) {
  if (!client || !client.connected) { $('toast').textContent = 'Not connected - command NOT sent'; return; }
  client.publish(BASE + 'commands/' + sub, payload, { qos: 1, retain: false }, err => {   // never retain commands
    $('toast').textContent = err ? 'Send failed (ACL?)' : `Sent: ${sub} = ${payload}`;
  });
}
document.addEventListener('click', e => {
  const t = e.target.closest('button[data-t]'); if (t) send(t.dataset.t, t.dataset.p);
});
document.querySelectorAll('.angles').forEach(row => {
  [0, 45, 90, 135, 180].forEach(a => {
    const b = document.createElement('button'); b.className = 'btn ghost ang';
    b.textContent = a + '°'; b.dataset.t = row.dataset.t; b.dataset.p = String(a); row.appendChild(b);
  });
});

startDashboard();   // resumes session if cookie is valid
