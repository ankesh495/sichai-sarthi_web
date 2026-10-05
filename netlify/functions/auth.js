// CONFIG BLOCK: set the three MQTT web-account values here; environment overrides are optional.
const SESSION_SECRET = "6d1b3def56ea67e6b9bf567423e2c8be6da9d6075a273c138d8a769dcf56e828";
const MQTT_WEB_URL  = "[wss://YOUR-CLUSTER.s1.eu.hivemq.cloud:8884/mqtt]";
const MQTT_WEB_USER = "[web account username]";
const MQTT_WEB_PASS = "[web account password]";

const crypto = require('node:crypto');
const SALT_HEX = '62439252f8180bc657651cb6b7d8dfe5';
const HASH_HEX = '0d5de3db78f82bf43f3b83c463259a2e8e84ce267cac3c6358e7125e9260e6400c73e2a814492a9a39e92f52d84f0e932fe315963aa20ae315c86cf5e8191739';
const failures = new Map();
const sessionLifetime = 2592000;
const failureWindow = 15 * 60 * 1000;

function config() {
  return {
    secret: process.env.SESSION_SECRET || SESSION_SECRET,
    url: process.env.MQTT_WEB_URL || MQTT_WEB_URL,
    username: process.env.MQTT_WEB_USER || MQTT_WEB_USER,
    password: process.env.MQTT_WEB_PASS || MQTT_WEB_PASS
  };
}

function response(statusCode, data, extraHeaders = {}) {
  return {statusCode, headers: {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extraHeaders}, body: JSON.stringify(data)};
}

function equalBuffers(first, second) {
  return first.length === second.length && crypto.timingSafeEqual(first, second);
}

function signature(body) {
  return crypto.createHmac('sha256', config().secret).update(body).digest('base64url');
}

function validSession(headers) {
  const cookies = headers.cookie || headers.Cookie || '';
  const cookie = cookies.split(';').map(part => part.trim()).find(part => part.startsWith('ss='));
  if (!cookie) return false;
  const token = cookie.slice(3);
  if (token.length > 1024) return false;
  const parts = token.split('.');
  if (parts.length !== 2 || !parts.every(part => /^[A-Za-z0-9_-]+$/.test(part))) return false;
  const [body, receivedSignature] = parts;
  if (!equalBuffers(Buffer.from(receivedSignature), Buffer.from(signature(body)))) return false;
  try {
    const session = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    const now = Math.floor(Date.now() / 1000);
    return Number.isSafeInteger(session.exp) && session.exp > now && session.exp <= now + sessionLifetime;
  } catch {
    return false;
  }
}

function sessionCookie(token, maxAge) {
  return `ss=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAge}`;
}

exports.handler = async (event) => {
  const action = event.queryStringParameters?.a;
  const headers = event.headers || {};
  const expectedMethod = {login: 'POST', creds: 'GET', logout: 'POST'}[action];
  if (!expectedMethod) return response(404, {error: 'Route not found'});
  if (event.httpMethod !== expectedMethod) return response(405, {error: 'Method not allowed'}, {Allow: expectedMethod});
  if (action === 'logout') return response(200, {ok: true}, {'Set-Cookie': sessionCookie('', 0)});
  if (action === 'creds') {
    if (!validSession(headers)) return response(401, {error: 'Please sign in'});
    const {url, username, password} = config();
    return response(200, {url, username, password});
  }
  const now = Date.now();
  for (const [address, entry] of failures) {
    if (now - entry.since >= failureWindow) failures.delete(address);
  }
  const ip = headers['x-nf-client-connection-ip'] || headers['X-Nf-Client-Connection-Ip'] || 'unknown';
  const previous = failures.get(ip);
  if (previous?.count >= 8) return response(429, {error: 'Too many attempts. Try again in 15 minutes.'}, {'Retry-After': String(Math.max(1, Math.ceil((failureWindow - (now - previous.since)) / 1000)))});
  let valid = false;
  try {
    const rawBody = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : event.body || '';
    if (rawBody.length > 4096) throw new Error('Invalid request');
    const input = JSON.parse(rawBody);
    if (typeof input.username === 'string' && input.username.length <= 100 && typeof input.password === 'string' && input.password.length <= 1024) {
      const usernameMatches = equalBuffers(Buffer.from(input.username, 'utf8'), Buffer.from('sinchai_sarthi_7', 'utf8'));
      const passwordMatches = equalBuffers(crypto.scryptSync(input.password, SALT_HEX, 64), Buffer.from(HASH_HEX, 'hex'));
      valid = usernameMatches && passwordMatches;
    }
  } catch {
    valid = false;
  }
  if (!valid) {
    const entry = previous || {count: 0, since: now};
    entry.count += 1;
    if (failures.size >= 10000 && !failures.has(ip)) failures.delete(failures.keys().next().value);
    failures.set(ip, entry);
    await new Promise(resolve => setTimeout(resolve, 800));
    return entry.count >= 8 ? response(429, {error: 'Too many attempts. Try again in 15 minutes.'}, {'Retry-After': '900'}) : response(401, {error: 'Invalid username or password'});
  }
  failures.delete(ip);
  const body = Buffer.from(JSON.stringify({exp: Math.floor(Date.now() / 1000) + sessionLifetime})).toString('base64url');
  return response(200, {ok: true}, {'Set-Cookie': sessionCookie(`${body}.${signature(body)}`, sessionLifetime)});
};
