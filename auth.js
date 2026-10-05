// Server-side login + session + restricted MQTT credentials.
// Env vars (Netlify > Site settings > Environment variables) - NEVER commit them:
//   DASH_USER, DASH_PASS_SALT, DASH_PASS_HASH, SESSION_SECRET,
//   MQTT_WEB_URL (wss://HOST:8884/mqtt), MQTT_WEB_USER, MQTT_WEB_PASS  (restricted "web" account only)
// Generate hash:  node -e "const c=require('crypto');const s=c.randomBytes(16).toString('hex');console.log(s,c.scryptSync('YOUR_PASSWORD',s,64).toString('hex'))"
const crypto = require('crypto');
const TTL = 8 * 3600;
const fails = new Map();   // best-effort throttle (resets on cold start)

const sign = body => crypto.createHmac('sha256', process.env.SESSION_SECRET).update(body).digest('base64url');
function makeToken() {
  const body = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + TTL })).toString('base64url');
  return body + '.' + sign(body);
}
function valid(cookieHeader) {
  const m = /(?:^|;\s*)ss=([^;]+)/.exec(cookieHeader || ''); if (!m) return false;
  const [body, sig] = m[1].split('.'); if (!body || !sig) return false;
  const a = Buffer.from(sig), b = Buffer.from(sign(body));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  try { return JSON.parse(Buffer.from(body, 'base64url').toString()).exp > Date.now() / 1000; } catch { return false; }
}
const json = (code, obj, extra = {}) => ({ statusCode: code, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra }, body: JSON.stringify(obj) });
const cookie = (v, age) => `ss=${v}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${age}`;

exports.handler = async event => {
  const a = (event.queryStringParameters || {}).a;
  const ip = event.headers['x-nf-client-connection-ip'] || 'x';

  if (a === 'login' && event.httpMethod === 'POST') {
    if ((fails.get(ip) || 0) >= 8) return json(429, { error: 'locked' });
    let u = '', p = '';
    try { ({ username: u = '', password: p = '' } = JSON.parse(event.body || '{}')); } catch {}
    const expected = Buffer.from(process.env.DASH_PASS_HASH || '', 'hex');
    const got = crypto.scryptSync(String(p), process.env.DASH_PASS_SALT || '', 64);
    const userOk = u.length === (process.env.DASH_USER || '').length &&
      crypto.timingSafeEqual(Buffer.from(u), Buffer.from(process.env.DASH_USER));
    const passOk = expected.length === got.length && crypto.timingSafeEqual(expected, got);
    if (userOk && passOk) { fails.delete(ip); return json(200, { ok: true }, { 'Set-Cookie': cookie(makeToken(), TTL) }); }
    fails.set(ip, (fails.get(ip) || 0) + 1);
    await new Promise(r => setTimeout(r, 800));
    return json(401, { error: 'invalid' });
  }
  if (a === 'logout') return json(200, { ok: true }, { 'Set-Cookie': cookie('', 0) });
  if (a === 'creds') {
    if (!valid(event.headers.cookie)) return json(401, { error: 'unauthorized' });
    return json(200, { url: process.env.MQTT_WEB_URL, username: process.env.MQTT_WEB_USER, password: process.env.MQTT_WEB_PASS });
  }
  return json(404, { error: 'not found' });
};
