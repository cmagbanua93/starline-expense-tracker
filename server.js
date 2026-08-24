'use strict';

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { Pool } = require('pg');
const { initialState } = require('./seed');

const PORT = process.env.PORT || 3000;
const SESSION_DAYS = 30;
const COOKIE = 'sl_sid';

/* ------------------------------------------------------------------ db --- */

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set. Point it at your Postgres instance.');
  process.exit(1);
}
const isLocal = /(^|@)(localhost|127\.0\.0\.1|\[::1\])/.test(url) || url.includes('.railway.internal');
const pool = new Pool({
  connectionString: url,
  ssl: isLocal ? false : { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 30000
});

async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ledger_state (
      id          smallint PRIMARY KEY,
      data        jsonb       NOT NULL,
      version     bigint      NOT NULL DEFAULT 1,
      updated_at  timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS app_admin (
      id          smallint PRIMARY KEY,
      username    text        NOT NULL,
      pass_hash   text        NOT NULL,
      updated_at  timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS app_session (
      sid         text PRIMARY KEY,
      expires_at  timestamptz NOT NULL,
      created_at  timestamptz NOT NULL DEFAULT now()
    );
  `);

  const { rowCount } = await pool.query('SELECT 1 FROM ledger_state WHERE id = 1');
  if (!rowCount) {
    await pool.query('INSERT INTO ledger_state (id, data, version) VALUES (1, $1, 1)', [initialState()]);
    console.log('Seeded the ledger with the StarLine expense list.');
  }

  const admin = await pool.query('SELECT 1 FROM app_admin WHERE id = 1');
  if (!admin.rowCount) {
    const user = process.env.ADMIN_USERNAME || 'admin';
    const pass = process.env.ADMIN_PASSWORD;
    if (!pass) {
      console.error('No administrator exists yet and ADMIN_PASSWORD is not set. Set it and restart.');
      process.exit(1);
    }
    await pool.query('INSERT INTO app_admin (id, username, pass_hash) VALUES (1, $1, $2)', [user, hash(pass)]);
    console.log('Created the administrator account "' + user + '" from ADMIN_PASSWORD.');
  }
}

/* ---------------------------------------------------------------- auth --- */

function hash(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(String(password), salt, 64, { N: 16384, r: 8, p: 1 });
  return 'scrypt$16384$' + salt.toString('hex') + '$' + key.toString('hex');
}
function verify(password, stored) {
  try {
    const parts = String(stored).split('$');
    if (parts.length !== 4 || parts[0] !== 'scrypt') return false;
    const salt = Buffer.from(parts[2], 'hex');
    const want = Buffer.from(parts[3], 'hex');
    const got = crypto.scryptSync(String(password), salt, want.length, { N: Number(parts[1]), r: 8, p: 1 });
    return crypto.timingSafeEqual(want, got);
  } catch (e) {
    return false;
  }
}

// Login throttling: per-IP, in memory. Enough for a single-admin app.
const attempts = new Map();
function throttled(ip) {
  const rec = attempts.get(ip);
  if (!rec) return false;
  if (Date.now() > rec.until) { attempts.delete(ip); return false; }
  return rec.count >= 10;
}
function recordFailure(ip) {
  const now = Date.now();
  const rec = attempts.get(ip);
  if (!rec || now > rec.until) attempts.set(ip, { count: 1, until: now + 15 * 60 * 1000 });
  else rec.count++;
}
function clearFailures(ip) { attempts.delete(ip); }

function readCookie(req, name) {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}
function setCookie(req, res, sid, maxAgeSeconds) {
  const secure = req.protocol === 'https' || req.headers['x-forwarded-proto'] === 'https';
  const bits = [
    COOKIE + '=' + encodeURIComponent(sid),
    'Path=/', 'HttpOnly', 'SameSite=Lax',
    'Max-Age=' + maxAgeSeconds
  ];
  if (secure) bits.push('Secure');
  res.setHeader('Set-Cookie', bits.join('; '));
}

async function currentSession(req) {
  const sid = readCookie(req, COOKIE);
  if (!sid) return null;
  const { rows } = await pool.query('SELECT sid FROM app_session WHERE sid = $1 AND expires_at > now()', [sid]);
  return rows.length ? sid : null;
}
async function requireAuth(req, res, next) {
  try {
    const sid = await currentSession(req);
    if (!sid) return res.status(401).json({ code: 'unauthorized', message: 'Please sign in again.' });
    req.sid = sid;
    next();
  } catch (e) { next(e); }
}

/* ----------------------------------------------------------------- app --- */

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '8mb' }));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data:",
    "connect-src 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
    "base-uri 'none'"
  ].join('; '));
  next();
});

app.get('/healthz', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true });
  } catch (e) {
    res.status(503).json({ ok: false });
  }
});

app.get('/api/session', async (req, res, next) => {
  try {
    const sid = await currentSession(req);
    const { rows } = await pool.query('SELECT username FROM app_admin WHERE id = 1');
    res.json({ authed: !!sid, username: rows.length ? rows[0].username : 'admin' });
  } catch (e) { next(e); }
});

app.post('/api/login', async (req, res, next) => {
  try {
    const ip = req.ip || 'unknown';
    if (throttled(ip)) {
      return res.status(429).json({ code: 'throttled', message: 'Too many failed attempts. Try again in 15 minutes.' });
    }
    const username = String((req.body && req.body.username) || '').trim();
    const password = String((req.body && req.body.password) || '');
    const { rows } = await pool.query('SELECT username, pass_hash FROM app_admin WHERE id = 1');
    const ok = rows.length &&
      username.toLowerCase() === rows[0].username.toLowerCase() &&
      verify(password, rows[0].pass_hash);
    if (!ok) {
      recordFailure(ip);
      return res.status(401).json({ code: 'bad_credentials', message: 'That username and passcode do not match.' });
    }
    clearFailures(ip);
    const sid = crypto.randomBytes(32).toString('hex');
    await pool.query(
      "INSERT INTO app_session (sid, expires_at) VALUES ($1, now() + ($2 || ' days')::interval)",
      [sid, String(SESSION_DAYS)]
    );
    await pool.query('DELETE FROM app_session WHERE expires_at < now()');
    setCookie(req, res, sid, SESSION_DAYS * 24 * 3600);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

app.post('/api/logout', async (req, res, next) => {
  try {
    const sid = readCookie(req, COOKIE);
    if (sid) await pool.query('DELETE FROM app_session WHERE sid = $1', [sid]);
    setCookie(req, res, '', 0);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

app.post('/api/password', requireAuth, async (req, res, next) => {
  try {
    const current = String((req.body && req.body.current) || '');
    const next_ = String((req.body && req.body.next) || '');
    if (next_.length < 8) {
      return res.status(400).json({ code: 'too_short', message: 'Use at least 8 characters.' });
    }
    const { rows } = await pool.query('SELECT pass_hash FROM app_admin WHERE id = 1');
    if (!rows.length || !verify(current, rows[0].pass_hash)) {
      return res.status(400).json({ code: 'bad_current', message: 'Current passcode is not right.' });
    }
    await pool.query('UPDATE app_admin SET pass_hash = $1, updated_at = now() WHERE id = 1', [hash(next_)]);
    // Every other session is invalidated; this one stays signed in.
    await pool.query('DELETE FROM app_session WHERE sid <> $1', [req.sid]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

app.get('/api/state', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT data, version, updated_at FROM ledger_state WHERE id = 1');
    if (!rows.length) return res.status(500).json({ code: 'missing', message: 'The ledger row is missing.' });
    res.json({ data: rows[0].data, version: Number(rows[0].version), updatedAt: rows[0].updated_at });
  } catch (e) { next(e); }
});

app.put('/api/state', requireAuth, async (req, res, next) => {
  try {
    const data = req.body && req.body.data;
    const version = Number(req.body && req.body.version);
    if (!data || typeof data !== 'object' || !data.meta || !Array.isArray(data.cats)) {
      return res.status(400).json({ code: 'bad_payload', message: 'That does not look like ledger data.' });
    }
    if (!Number.isFinite(version)) {
      return res.status(400).json({ code: 'bad_version', message: 'Missing version.' });
    }
    const upd = await pool.query(
      'UPDATE ledger_state SET data = $1, version = version + 1, updated_at = now() WHERE id = 1 AND version = $2 RETURNING version, updated_at',
      [data, version]
    );
    if (!upd.rowCount) {
      const cur = await pool.query('SELECT version FROM ledger_state WHERE id = 1');
      return res.status(409).json({
        code: 'conflict',
        message: 'The ledger was changed somewhere else.',
        version: cur.rows.length ? Number(cur.rows[0].version) : null
      });
    }
    res.json({ ok: true, version: Number(upd.rows[0].version), updatedAt: upd.rows[0].updated_at });
  } catch (e) { next(e); }
});

app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
  }
}));
app.get('*', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((err, req, res, _next) => {
  console.error(err);
  res.status(500).json({ code: 'server_error', message: 'Something went wrong on the server.' });
});

migrate()
  .then(() => {
    app.listen(PORT, '0.0.0.0', () => console.log('StarLine Ledger listening on ' + PORT));
  })
  .catch((err) => {
    console.error('Startup failed:', err);
    process.exit(1);
  });
