'use strict';

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { Pool } = require('pg');
const fs = require('fs');
const { initialState } = require('./seed');
const A = require('./automation');

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
    CREATE TABLE IF NOT EXISTS app_config (
      key         text PRIMARY KEY,
      value       text NOT NULL,
      updated_at  timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS payment_event (
      id          bigserial PRIMARY KEY,
      received_at timestamptz NOT NULL DEFAULT now(),
      source      text NOT NULL,
      dedupe_key  text UNIQUE,
      sender      text,
      subject     text,
      excerpt     text,
      amount      numeric(14,2),
      ref         text,
      paid_on     date,
      cat_id      text,
      bill_name   text,
      month_key   text,
      status      text NOT NULL,
      detail      text
    );
    CREATE INDEX IF NOT EXISTS payment_event_recent ON payment_event (received_at DESC);
    CREATE TABLE IF NOT EXISTS notification_log (
      id          bigserial PRIMARY KEY,
      created_at  timestamptz NOT NULL DEFAULT now(),
      dedupe_key  text UNIQUE,
      kind        text NOT NULL,
      message     text NOT NULL,
      channels    text,
      ok          boolean NOT NULL DEFAULT true,
      error       text
    );
  `);

  const { rowCount } = await pool.query('SELECT 1 FROM ledger_state WHERE id = 1');
  if (!rowCount) {
    await pool.query('INSERT INTO ledger_state (id, data, version) VALUES (1, $1, 1)', [initialState()]);
    console.log('Seeded the ledger with the StarLine expense list.');
  }
  // Bring an existing ledger up to the current shape (adds autopay fields only).
  const before = await pool.query('SELECT data FROM ledger_state WHERE id = 1');
  // Postgres jsonb reorders keys, so compare with sorted keys.
  const canon = function (v) {
    if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
    if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(function (k) { return JSON.stringify(k) + ':' + canon(v[k]); }).join(',') + '}';
    return JSON.stringify(v);
  };
  const raw = canon(before.rows[0].data);
  if (canon(A.upgradeDoc(JSON.parse(JSON.stringify(before.rows[0].data)))) !== raw) {
    await mutateLedger(function () { return true; });
    console.log('Upgraded the ledger with autopay fields.');
  }
  if (!(await getConfig('ingest_token'))) await setConfig('ingest_token', crypto.randomBytes(24).toString('hex'));

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

// Read-modify-write the ledger document under a row lock, bumping its version
// so any open browser picks up the change. `fn` returns false to abort.
async function mutateLedger(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT data, version FROM ledger_state WHERE id = 1 FOR UPDATE');
    if (!rows.length) { await client.query('ROLLBACK'); return null; }
    const doc = A.upgradeDoc(rows[0].data);
    const result = await fn(doc);
    if (result === false) { await client.query('ROLLBACK'); return { result: result, version: Number(rows[0].version) }; }
    doc.meta.updatedAt = new Date().toISOString();
    const upd = await client.query(
      'UPDATE ledger_state SET data = $1, version = version + 1, updated_at = now() WHERE id = 1 RETURNING version', [doc]);
    await client.query('COMMIT');
    return { result: result, version: Number(upd.rows[0].version), doc: doc };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (e2) { /* ignore */ }
    throw e;
  } finally {
    client.release();
  }
}
async function readLedger() {
  const { rows } = await pool.query('SELECT data, version FROM ledger_state WHERE id = 1');
  return rows.length ? { doc: A.upgradeDoc(rows[0].data), version: Number(rows[0].version) } : null;
}

/* -------------------------------------------------------------- config --- */

async function getConfig(key) {
  const { rows } = await pool.query('SELECT value FROM app_config WHERE key = $1', [key]);
  return rows.length ? rows[0].value : null;
}
async function setConfig(key, value) {
  if (value == null || value === '') {
    await pool.query('DELETE FROM app_config WHERE key = $1', [key]);
    return;
  }
  await pool.query(
    'INSERT INTO app_config (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now()',
    [key, String(value)]);
}
async function ingestToken() { return process.env.INGEST_TOKEN || (await getConfig('ingest_token')); }

/* ------------------------------------------------------- notifications --- */

// Channels are configured from Settings (stored in app_config), with
// environment variables as an override for anyone who prefers them.
async function channels() {
  return {
    ntfy: process.env.NTFY_TOPIC || (await getConfig('ntfy_topic')) || '',
    ntfyServer: process.env.NTFY_SERVER || (await getConfig('ntfy_server')) || 'https://ntfy.sh',
    tgToken: process.env.TELEGRAM_BOT_TOKEN || (await getConfig('telegram_token')) || '',
    tgChat: process.env.TELEGRAM_CHAT_ID || (await getConfig('telegram_chat')) || '',
    webhook: process.env.NOTIFY_WEBHOOK_URL || (await getConfig('webhook_url')) || ''
  };
}

async function postWithTimeout(url, opts) {
  const ctl = new AbortController();
  const t = setTimeout(function () { ctl.abort(); }, 10000);
  try {
    const r = await fetch(url, Object.assign({ signal: ctl.signal }, opts));
    if (!r.ok) throw new Error(url.split('/')[2] + ' answered ' + r.status);
    return r;
  } finally { clearTimeout(t); }
}

// Sends `message` to every configured channel and records it in the log.
// With a dedupeKey, a message already recorded under that key is not sent again.
async function notify(kind, message, opts) {
  opts = opts || {};
  if (opts.dedupeKey) {
    const seen = await pool.query('SELECT 1 FROM notification_log WHERE dedupe_key = $1', [opts.dedupeKey]);
    if (seen.rowCount) return { skipped: true };
  }
  const ch = await channels();
  const sent = [], errors = [];
  const title = opts.title || 'StarLine bills';
  if (ch.ntfy) {
    try {
      await postWithTimeout(ch.ntfyServer.replace(/\/+$/, '') + '/' + encodeURIComponent(ch.ntfy), {
        method: 'POST', body: message,
        headers: { Title: title.replace(/[^\x20-\x7e]/g, ''), Priority: opts.urgent ? 'high' : 'default', Tags: opts.urgent ? 'warning' : 'moneybag' }
      });
      sent.push('ntfy');
    } catch (e) { errors.push('ntfy: ' + e.message); }
  }
  if (ch.tgToken && ch.tgChat) {
    try {
      await postWithTimeout('https://api.telegram.org/bot' + ch.tgToken + '/sendMessage', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: ch.tgChat, text: message, disable_web_page_preview: true })
      });
      sent.push('telegram');
    } catch (e) { errors.push('telegram: ' + e.message.replace(ch.tgToken, '***')); }
  }
  if (ch.webhook) {
    try {
      await postWithTimeout(ch.webhook, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: kind, title: title, text: message })
      });
      sent.push('webhook');
    } catch (e) { errors.push('webhook: ' + e.message); }
  }
  await pool.query(
    'INSERT INTO notification_log (dedupe_key, kind, message, channels, ok, error) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (dedupe_key) DO NOTHING',
    [opts.dedupeKey || null, kind, message, sent.join(', ') || 'in-app only', errors.length === 0, errors.join('; ') || null]);
  return { sent: sent, errors: errors };
}

/* ---------------------------------------------------------- automation --- */

async function reviewCount() {
  const { rows } = await pool.query("SELECT count(*)::int AS n FROM payment_event WHERE status = 'needs_review'");
  return rows[0].n;
}

let LAST_RUN = null;
// Runs every few minutes: builds the current month on the 1st and sends the
// morning digest once a day.
async function runAutomation(force) {
  const now = A.manilaParts();
  const led = await readLedger();
  if (!led) return null;
  const auto = led.doc.automation || {};
  if (auto.autoCreateMonth !== false && !(led.doc.months[now.key] && led.doc.months[now.key].rows.length)) {
    const res = await mutateLedger(function (d) {
      if (d.months[now.key] && d.months[now.key].rows.length) return false;
      return A.seedMonth(d, now.key) > 0;
    });
    if (res && res.result) await notify('month', 'StarLine bills — ' + now.key + ' has been set up from your bill list.', { dedupeKey: 'month:' + now.key });
  }
  LAST_RUN = new Date().toISOString();
  const hour = Number(auto.digestHour == null ? 8 : auto.digestHour);
  if (!force && now.hour < hour) return null;
  const fresh = await readLedger();
  const ov = A.buildOverview(fresh.doc, now.date);
  const text = A.digestText(fresh.doc, ov, await reviewCount());
  if (!text) {
    if (force) return { sent: [], empty: true };
    return null;
  }
  return notify('digest', text, { dedupeKey: force ? null : 'digest:' + now.date, urgent: ov.overdue.length > 0 });
}

// Takes a receipt (email body, SMS, or pasted text), works out which bill it
// pays and records it. Everything is logged in payment_event.
async function ingestReceipt(input) {
  const text = [input.subject, input.text].filter(Boolean).join('\n');
  const parsed = A.parseReceipt(text, input.receivedAt, input.from);
  const dedupeKey = input.messageId ? input.source + ':' + String(input.messageId).slice(0, 200)
    : (parsed.ref ? 'ref:' + parsed.ref : null);
  if (dedupeKey) {
    const seen = await pool.query('SELECT id, status FROM payment_event WHERE dedupe_key = $1', [dedupeKey]);
    if (seen.rowCount) return { status: 'duplicate', eventId: Number(seen.rows[0].id) };
  }
  const led = await readLedger();
  const match = A.matchBill(led.doc, text, parsed.amount);
  let status, outcome = null;
  // Forwarded mail also brings promos ("Get P99 data!"); only payment confirmations count.
  const looksPaid = input.source === 'manual' ? true : A.isPaymentConfirmation(text);
  if (parsed.amount == null || !looksPaid) status = 'ignored';
  else if (!match.best) status = 'needs_review';
  else {
    const res = await mutateLedger(function (d) {
      outcome = A.applyPayment(d, { catId: match.best, amount: parsed.amount, paidOn: parsed.date, ref: parsed.ref, method: parsed.method, source: input.source });
      return outcome.status === 'applied' ? outcome : false;
    });
    status = outcome.status === 'applied' ? 'applied' : (outcome.status === 'duplicate' ? 'duplicate' : 'needs_review');
    if (res && outcome.status === 'applied' && led.doc.automation.notifyOnPayment !== false) {
      await notify('paid', '✅ Paid · ' + outcome.name + ' · ' + A.fmtMoney(led.doc, parsed.amount) +
        (parsed.ref ? ' · ref ' + parsed.ref : '') + ' · recorded automatically', {});
    }
  }
  const cat = match.best ? led.doc.cats.find(function (c) { return c.id === match.best; }) : null;
  const ins = await pool.query(
    `INSERT INTO payment_event (source, dedupe_key, sender, subject, excerpt, amount, ref, paid_on, cat_id, bill_name, month_key, status, detail)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`,
    [input.source, dedupeKey, (input.from || '').slice(0, 200), A.maskCards(input.subject || '').slice(0, 300),
      A.maskCards(String(input.text || '').replace(/\s+/g, ' ')).slice(0, 1500), parsed.amount, parsed.ref || null, parsed.date,
      cat ? cat.id : null, cat ? cat.name : null, outcome && outcome.monthKey ? outcome.monthKey : null, status,
      JSON.stringify({ candidates: match.candidates })]);
  return { status: status, parsed: parsed, match: match, eventId: ins.rowCount ? Number(ins.rows[0].id) : null, outcome: outcome };
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
    res.json({ data: A.upgradeDoc(rows[0].data), version: Number(rows[0].version), updatedAt: rows[0].updated_at });
  } catch (e) { next(e); }
});

app.get('/api/state/version', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT version FROM ledger_state WHERE id = 1');
    res.json({ version: rows.length ? Number(rows[0].version) : 0 });
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
    A.upgradeDoc(data);
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

/* ------------------------------------------------------ automation api --- */

function clip(v, n) { return String(v == null ? '' : v).slice(0, n); }

// Receipt inbox for the Gmail forwarder (or any SMS forwarder).
// Auth: "Authorization: Bearer <token>" — the token is shown in Settings.
const ingestHits = new Map();
app.post('/api/ingest', async (req, res, next) => {
  try {
    const want = await ingestToken();
    const got = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '') || String(req.headers['x-ingest-token'] || '');
    const ok = want && got && got.length === want.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
    if (!ok) return res.status(401).json({ code: 'bad_token', message: 'Ingest token missing or wrong.' });
    const ip = req.ip || 'x', now = Date.now(), rec = ingestHits.get(ip) || { n: 0, t: now };
    if (now - rec.t > 60000) { rec.n = 0; rec.t = now; }
    if (++rec.n > 120) return res.status(429).json({ code: 'slow_down', message: 'Too many receipts in a minute.' });
    ingestHits.set(ip, rec);
    const b = req.body || {};
    const items = Array.isArray(b.items) ? b.items.slice(0, 50) : [b];
    const results = [];
    for (const it of items) {
      if (!it || (!it.text && !it.subject)) { results.push({ status: 'empty' }); continue; }
      const r = await ingestReceipt({
        source: clip(it.source || 'email', 20), messageId: it.messageId ? clip(it.messageId, 200) : null,
        from: clip(it.from, 200), subject: clip(it.subject, 300), text: clip(it.text, 20000),
        receivedAt: it.receivedAt || null
      });
      results.push({ status: r.status, bill: r.outcome && r.outcome.name, amount: r.parsed && r.parsed.amount });
    }
    res.json({ ok: true, results: results });
  } catch (e) { next(e); }
});

app.get('/api/automation', requireAuth, async (req, res, next) => {
  try {
    const led = await readLedger();
    const ov = A.buildOverview(led.doc);
    const events = await pool.query(
      'SELECT id, received_at, source, sender, subject, excerpt, amount, ref, paid_on::text AS paid_on, cat_id, bill_name, month_key, status, detail FROM payment_event ORDER BY received_at DESC LIMIT 60');
    const notes = await pool.query('SELECT id, created_at, kind, message, channels, ok, error FROM notification_log ORDER BY created_at DESC LIMIT 25');
    const ch = await channels();
    const last = await pool.query("SELECT max(received_at) AS t FROM payment_event WHERE source <> 'manual'");
    res.json({
      overview: ov,
      events: events.rows.map(function (r) {
        let detail = {};
        try { detail = JSON.parse(r.detail || '{}'); } catch (e) { detail = {}; }
        return Object.assign({}, r, { id: Number(r.id), amount: r.amount == null ? null : Number(r.amount), candidates: detail.candidates || [],
          detail: undefined });
      }),
      notifications: notes.rows.map(function (r) { return Object.assign({}, r, { id: Number(r.id) }); }),
      channels: { ntfy: !!ch.ntfy, telegram: !!(ch.tgToken && ch.tgChat), webhook: !!ch.webhook },
      lastReceiptAt: last.rows[0].t, lastRun: LAST_RUN, timezone: A.TZ
    });
  } catch (e) { next(e); }
});

app.post('/api/receipt/parse', requireAuth, async (req, res, next) => {
  try {
    const text = clip(req.body && req.body.text, 20000);
    const parsed = A.parseReceipt(text);
    const led = await readLedger();
    res.json({ parsed: parsed, match: A.matchBill(led.doc, text, parsed.amount) });
  } catch (e) { next(e); }
});

// Records a payment against a bill — from a pasted receipt, or when assigning
// a receipt the inbox could not match on its own.
app.post('/api/receipt/apply', requireAuth, async (req, res, next) => {
  try {
    const b = req.body || {};
    const amount = b.amount === '' || b.amount == null ? null : Number(b.amount);
    const paidOn = /^\d{4}-\d{2}-\d{2}$/.test(b.paidOn || '') ? b.paidOn : A.todayISO();
    let outcome = null;
    const res2 = await mutateLedger(function (d) {
      outcome = A.applyPayment(d, { catId: String(b.catId || ''), amount: amount, paidOn: paidOn, ref: clip(b.ref, 60), method: clip(b.method, 40), source: 'manual' });
      return outcome.status === 'applied' ? outcome : false;
    });
    if (outcome.status !== 'applied') {
      const msg = outcome.status === 'duplicate' ? 'That reference number is already recorded on this bill.'
        : outcome.status === 'no_open_line' ? 'This bill has no unpaid line around that date.' : 'Choose a bill first.';
      return res.status(409).json({ code: outcome.status, message: msg });
    }
    const led = await readLedger();
    const cat = led.doc.cats.find(function (c) { return c.id === b.catId; });
    if (b.eventId) {
      await pool.query("UPDATE payment_event SET status = 'applied', cat_id = $2, bill_name = $3, month_key = $4, amount = COALESCE($5, amount), paid_on = $6 WHERE id = $1",
        [Number(b.eventId), cat.id, cat.name, outcome.monthKey, amount, paidOn]);
    } else {
      await pool.query(
        `INSERT INTO payment_event (source, dedupe_key, excerpt, amount, ref, paid_on, cat_id, bill_name, month_key, status)
         VALUES ('manual', $1, $2, $3, $4, $5, $6, $7, $8, 'applied') ON CONFLICT (dedupe_key) DO NOTHING`,
        [b.ref ? 'ref:' + clip(b.ref, 60) : null, A.maskCards(clip(b.text, 1500).replace(/\s+/g, ' ')), amount, clip(b.ref, 60) || null, paidOn, cat.id, cat.name, outcome.monthKey]);
    }
    res.json({ ok: true, version: res2.version, outcome: outcome });
  } catch (e) { next(e); }
});

app.post('/api/events/:id/dismiss', requireAuth, async (req, res, next) => {
  try {
    await pool.query("UPDATE payment_event SET status = 'dismissed' WHERE id = $1 AND status = 'needs_review'", [Number(req.params.id)]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

app.post('/api/events/:id/undo', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await pool.query("SELECT id, cat_id, month_key, ref, paid_on::text AS paid_on FROM payment_event WHERE id = $1 AND status = 'applied'", [Number(req.params.id)]);
    if (!rows.length) return res.status(404).json({ code: 'not_found', message: 'That receipt is not recorded on a bill.' });
    let done = false;
    const r = await mutateLedger(function (d) { done = A.undoPayment(d, rows[0]); return done || false; });
    await pool.query("UPDATE payment_event SET status = 'needs_review', month_key = NULL WHERE id = $1", [rows[0].id]);
    res.json({ ok: true, reverted: done, version: r && r.version });
  } catch (e) { next(e); }
});

app.get('/api/settings/automation', requireAuth, async (req, res, next) => {
  try {
    const ch = await channels();
    const proto = req.headers['x-forwarded-proto'] || req.protocol;
    res.json({
      ingestUrl: proto + '://' + req.get('host') + '/api/ingest',
      ingestToken: await ingestToken(),
      tokenFromEnv: !!process.env.INGEST_TOKEN,
      ntfyTopic: ch.ntfy, ntfyServer: ch.ntfyServer,
      telegramChat: ch.tgChat, telegramTokenSet: !!ch.tgToken,
      webhookUrl: ch.webhook,
      fromEnv: { ntfy: !!process.env.NTFY_TOPIC, telegram: !!process.env.TELEGRAM_BOT_TOKEN, webhook: !!process.env.NOTIFY_WEBHOOK_URL }
    });
  } catch (e) { next(e); }
});

app.post('/api/settings/automation', requireAuth, async (req, res, next) => {
  try {
    const b = req.body || {};
    if ('ntfyTopic' in b) {
      const t = clip(b.ntfyTopic, 64).trim();
      if (t && !/^[A-Za-z0-9_-]{6,64}$/.test(t)) return res.status(400).json({ code: 'bad_topic', message: 'Use 6–64 letters, numbers, - or _ for the ntfy topic.' });
      await setConfig('ntfy_topic', t);
    }
    if ('ntfyServer' in b) {
      const u = clip(b.ntfyServer, 200).trim();
      if (u && !/^https:\/\/[^\s]+$/.test(u)) return res.status(400).json({ code: 'bad_url', message: 'The ntfy server must start with https://' });
      await setConfig('ntfy_server', u === 'https://ntfy.sh' ? '' : u);
    }
    if ('telegramToken' in b && b.telegramToken !== '__keep__') await setConfig('telegram_token', clip(b.telegramToken, 120).trim());
    if ('telegramChat' in b) await setConfig('telegram_chat', clip(b.telegramChat, 40).trim());
    if ('webhookUrl' in b) {
      const u = clip(b.webhookUrl, 500).trim();
      if (u && !/^https:\/\/[^\s]+$/.test(u)) return res.status(400).json({ code: 'bad_url', message: 'The webhook must be an https:// address.' });
      await setConfig('webhook_url', u);
    }
    if (b.rotateToken) {
      if (process.env.INGEST_TOKEN) return res.status(400).json({ code: 'env_token', message: 'The token comes from the INGEST_TOKEN variable on Railway — change it there.' });
      await setConfig('ingest_token', crypto.randomBytes(24).toString('hex'));
    }
    res.json({ ok: true });
  } catch (e) { next(e); }
});

app.post('/api/automation/test', requireAuth, async (req, res, next) => {
  try {
    const r = await notify('test', 'StarLine bills — test notification. If you can read this, reminders will reach you here.', {});
    if (!r.sent.length && !r.errors.length) return res.status(400).json({ code: 'no_channel', message: 'No notification channel is set up yet.' });
    res.json(r);
  } catch (e) { next(e); }
});

app.post('/api/automation/digest', requireAuth, async (req, res, next) => {
  try {
    const r = await runAutomation(true);
    res.json(r || { sent: [] });
  } catch (e) { next(e); }
});

app.get('/downloads/gmail-forwarder.gs', requireAuth, (req, res) => {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="starline-gmail-forwarder.gs"');
  res.send(fs.readFileSync(path.join(__dirname, 'automation', 'gmail-forwarder.gs'), 'utf8'));
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
    const tick = function () { runAutomation(false).catch(function (e) { console.error('Automation run failed:', e.message); }); };
    setTimeout(tick, 15000);
    setInterval(tick, 10 * 60 * 1000);
  })
  .catch((err) => {
    console.error('Startup failed:', err);
    process.exit(1);
  });
