/* cloud/gateway.js — the login gate that lets the station run on a public server.
 *
 * The station's sidecar is a single-user loopback app: it binds 127.0.0.1, pins the Host header to loopback,
 * and injects its API token into the page it serves. That is safe on a laptop and UNSAFE on the internet,
 * because anyone who could load the page would get the token. So the sidecar stays on 127.0.0.1 inside the
 * container, and this gateway is the only thing exposed:
 *
 *   1. Every request needs a signed session cookie, issued after the password (GATEWAY_PASSWORD) is entered.
 *   2. Authenticated requests are proxied to the sidecar with Host and Origin rewritten to the loopback
 *      address the sidecar expects, so its own Host/Origin checks still pass and still protect it.
 *   3. Streaming responses (SSE) are piped straight through; websocket upgrades are tunnelled too.
 *   4. Failed logins are rate-limited per IP to slow password guessing.
 *
 * Node core modules only, so it runs with no npm install.
 */
'use strict';
const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');

const PUBLIC_PORT = Number(process.env.PORT) || 8080;            // Railway injects PORT
const UPSTREAM_PORT = Number(process.env.STARNET_PORT) || 8787;  // the sidecar's loopback port
const UPSTREAM_HOST = '127.0.0.1';
const UPSTREAM_ORIGIN = `http://${UPSTREAM_HOST}:${UPSTREAM_PORT}`;
const PASSWORD = String(process.env.GATEWAY_PASSWORD || '');
const SESSION_DAYS = Number(process.env.GATEWAY_SESSION_DAYS) || 30;
const COOKIE = 'gw_session';

if (PASSWORD.length < 12) {
  console.error('[gateway] GATEWAY_PASSWORD must be set and at least 12 characters. Refusing to start.');
  process.exit(1);
}
// Sessions are HMAC-signed with a key derived from the password, so changing the password logs everyone out.
const SIGNING_KEY = crypto.createHash('sha256').update('gateway-session:' + PASSWORD).digest();

function sign(value) { return crypto.createHmac('sha256', SIGNING_KEY).update(value).digest('base64url'); }
function makeSession() {
  const expires = Date.now() + SESSION_DAYS * 86400000;
  const body = `${expires}.${crypto.randomBytes(16).toString('base64url')}`;
  return `${body}.${sign(body)}`;
}
function sessionValid(token) {
  if (!token) return false;
  const i = token.lastIndexOf('.');
  if (i < 0) return false;
  const body = token.slice(0, i), mac = token.slice(i + 1);
  const want = sign(body);
  if (mac.length !== want.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(want))) return false;
  return Number(body.split('.')[0]) > Date.now();
}
function readCookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return '';
}
function passwordOk(given) {
  const a = crypto.createHash('sha256').update(String(given)).digest();
  const b = crypto.createHash('sha256').update(PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
}

// ---- brute-force brake: 8 failed attempts per IP per 15 minutes ----
const failures = new Map();
function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
}
function locked(ip) {
  const f = failures.get(ip);
  if (!f) return false;
  if (Date.now() - f.first > 15 * 60000) { failures.delete(ip); return false; }
  return f.count >= 8;
}
function noteFailure(ip) {
  const f = failures.get(ip);
  if (!f || Date.now() - f.first > 15 * 60000) failures.set(ip, { first: Date.now(), count: 1 });
  else f.count++;
}

function isHttps(req) { return String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https'; }

const LOGIN_PAGE = (msg) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Bullpen · Sign in</title>
<style>
  :root{--bg:#0f1115;--card:#171a21;--text:#e8e6e1;--muted:#9a9890;--accent:#e0a33a;--err:#e5736b}
  @media (prefers-color-scheme: light){:root{--bg:#f4f2ee;--card:#fff;--text:#1d1c1a;--muted:#6b6862;--accent:#b5761a;--err:#b3362c}}
  *{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);
  color:var(--text);font:16px/1.4 system-ui,-apple-system,sans-serif;padding:16px}
  form{background:var(--card);padding:28px;border-radius:14px;width:100%;max-width:360px;display:grid;gap:14px}
  h1{margin:0;font-size:20px}p{margin:0;color:var(--muted);font-size:14px}
  input{width:100%;padding:12px;border-radius:9px;border:1px solid #8884;background:transparent;color:inherit;font-size:16px}
  button{padding:12px;border:0;border-radius:9px;background:var(--accent);color:#111;font-weight:600;font-size:16px}
  .err{color:var(--err)}
</style></head><body>
<form method="post" action="/__gateway/login">
  <h1>Bullpen</h1><p>Enter your station password.</p>
  ${msg ? `<p class="err">${msg}</p>` : ''}
  <input type="password" name="password" autocomplete="current-password" autofocus required>
  <button type="submit">Sign in</button>
</form></body></html>`;

function sendLogin(res, status, msg) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(LOGIN_PAGE(msg));
}

function handleLogin(req, res) {
  const ip = clientIp(req);
  if (locked(ip)) return sendLogin(res, 429, 'Too many attempts. Wait 15 minutes and try again.');
  let body = '';
  req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
  req.on('end', () => {
    const given = new URLSearchParams(body).get('password') || '';
    if (!passwordOk(given)) { noteFailure(ip); return sendLogin(res, 401, 'Wrong password.'); }
    failures.delete(ip);
    const attrs = ['Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${SESSION_DAYS * 86400}`];
    if (isHttps(req)) attrs.push('Secure');
    res.writeHead(303, { 'set-cookie': `${COOKIE}=${makeSession()}; ${attrs.join('; ')}`, location: '/' });
    res.end();
  });
}

function upstreamHeaders(req) {
  const h = { ...req.headers };
  h.host = `${UPSTREAM_HOST}:${UPSTREAM_PORT}`;          // the sidecar pins Host to loopback
  if (h.origin) h.origin = UPSTREAM_ORIGIN;               // and checks Origin against its own address
  if (h.referer) {
    try { const u = new URL(h.referer); h.referer = UPSTREAM_ORIGIN + u.pathname + u.search; } catch (_) { delete h.referer; }
  }
  // never pass the gateway session through to the station
  if (h.cookie) {
    const kept = h.cookie.split(';').map((s) => s.trim()).filter((s) => !s.startsWith(COOKIE + '='));
    if (kept.length) h.cookie = kept.join('; '); else delete h.cookie;
  }
  return h;
}

const server = http.createServer((req, res) => {
  if (req.url === '/__gateway/health') { res.writeHead(200); return res.end('ok'); }
  if (req.url === '/__gateway/login' && req.method === 'POST') return handleLogin(req, res);
  if (req.url === '/__gateway/logout') {
    res.writeHead(303, { 'set-cookie': `${COOKIE}=; Path=/; Max-Age=0`, location: '/' });
    return res.end();
  }
  if (!sessionValid(readCookie(req, COOKIE))) {
    // API calls get a plain 401 so the app fails visibly instead of rendering a login page as data
    if (req.url.startsWith('/api/')) { res.writeHead(401, { 'content-type': 'text/plain' }); return res.end('sign in required'); }
    return sendLogin(res, 200, '');
  }

  const up = http.request({
    host: UPSTREAM_HOST, port: UPSTREAM_PORT, method: req.method, path: req.url, headers: upstreamHeaders(req),
  }, (upRes) => {
    const headers = { ...upRes.headers };
    // the sidecar may emit loopback-absolute redirects; keep them on the public origin
    if (headers.location && headers.location.startsWith(UPSTREAM_ORIGIN)) headers.location = headers.location.slice(UPSTREAM_ORIGIN.length) || '/';
    res.writeHead(upRes.statusCode, upRes.statusMessage, headers);
    if (typeof res.flushHeaders === 'function') res.flushHeaders();   // SSE: headers out before the first event
    upRes.pipe(res);
  });
  up.on('error', (err) => {
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<p style="font-family:system-ui;padding:24px">The station is starting up or restarting. Refresh in a few seconds.</p>');
    } else res.destroy(err);
  });
  req.on('aborted', () => up.destroy());
  req.pipe(up);
});

// websocket / upgrade tunnel (authenticated the same way)
server.on('upgrade', (req, socket, head) => {
  if (!sessionValid(readCookie(req, COOKIE))) { socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n'); return; }
  const up = net.connect(UPSTREAM_PORT, UPSTREAM_HOST, () => {
    const h = upstreamHeaders(req);
    let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
    for (const [k, v] of Object.entries(h)) for (const one of [].concat(v)) raw += `${k}: ${one}\r\n`;
    up.write(raw + '\r\n');
    if (head && head.length) up.write(head);
    up.pipe(socket); socket.pipe(up);
  });
  up.on('error', () => socket.destroy());
  socket.on('error', () => up.destroy());
});

server.keepAliveTimeout = 65000;   // longer than Railway's proxy idle timeout
server.headersTimeout = 66000;
server.requestTimeout = 0;         // SSE streams stay open indefinitely
server.listen(PUBLIC_PORT, '0.0.0.0', () => {
  console.log(`[gateway] listening on :${PUBLIC_PORT}, proxying to ${UPSTREAM_ORIGIN}`);
});
