// Shared server code for the Training Batch Tracker.
// Files in /api that start with "_" are not deployed as endpoints.
import crypto from 'node:crypto';
import { neon } from '@neondatabase/serverless';

export const ALLOWED_DOMAIN = (process.env.ALLOWED_DOMAIN || 'accredian.com').trim().toLowerCase();
const SESSION_COOKIE = 'tbt_session';
const SESSION_SECONDS = 7 * 24 * 60 * 60;
const MAX_REPS_PER_BATCH = 50;
const FRC_STATUSES = ['Cleared', 'Not Cleared', 'Pending'];
const OJT_STATUSES = ['Cleared', 'Exit', 'OJT Extended'];
const CHECKPOINTS = ['cp2', 'cp4', 'cp6'];

/* ============================= responses & errors ============================= */

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

export function handle(fn) {
  return async function handler(req, res) {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof HttpError) return send(res, err.status, { error: err.message });
      console.error(err);
      send(res, 500, { error: 'Something went wrong on the server. Please try again.' });
    }
  };
}

export async function readJson(req) {
  try {
    if (req.body !== undefined && req.body !== null) {
      return typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString('utf8');
    return text ? JSON.parse(text) : {};
  } catch {
    throw new HttpError(400, 'The request body was not valid JSON.');
  }
}

export function requireMethod(req, res, methods) {
  if (!methods.includes(req.method)) {
    res.setHeader('Allow', methods.join(', '));
    throw new HttpError(405, 'Method not allowed.');
  }
  // Writes must come from this app's own page (a custom header can't be sent cross-site without CORS).
  if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'tbt') {
    throw new HttpError(403, 'Request blocked.');
  }
}

/* ============================= sessions ============================= */

const b64url = (buf) => Buffer.from(buf).toString('base64url');

function sessionSecret() {
  const secret = process.env.SESSION_SECRET || '';
  if (secret.length < 16) throw new HttpError(500, 'SESSION_SECRET is not set in Vercel (use a long random value).');
  return secret;
}

function signSession(email) {
  const payload = b64url(JSON.stringify({ email, exp: Math.floor(Date.now() / 1000) + SESSION_SECONDS }));
  const sig = b64url(crypto.createHmac('sha256', sessionSecret()).update(payload).digest());
  return payload + '.' + sig;
}

function readSession(token) {
  const [payload, sig] = String(token || '').split('.');
  if (!payload || !sig) return null;
  const expected = crypto.createHmac('sha256', sessionSecret()).update(payload).digest();
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data.exp || data.exp < Math.floor(Date.now() / 1000)) return null;
    if (!String(data.email || '').endsWith('@' + ALLOWED_DOMAIN)) return null;
    return data.email;
  } catch {
    return null;
  }
}

function cookies(req) {
  const out = {};
  String(req.headers.cookie || '').split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

function cookieAttrs(maxAge) {
  const secure = process.env.VERCEL ? '; Secure' : '';
  return `; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

export function setSessionCookie(res, email) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${signSession(email)}${cookieAttrs(SESSION_SECONDS)}`);
}

export function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${cookieAttrs(0)}`);
}

export function currentUser(req) {
  return readSession(cookies(req)[SESSION_COOKIE]);
}

export function requireUser(req) {
  const email = currentUser(req);
  if (!email) throw new HttpError(401, `Sign in with your @${ALLOWED_DOMAIN} Google account.`);
  return email;
}

/* ============================= Google sign-in check ============================= */

let jwksCache = { keys: null, at: 0 };
async function googleKeys(force) {
  if (!force && jwksCache.keys && Date.now() - jwksCache.at < 60 * 60 * 1000) return jwksCache.keys;
  const r = await fetch(process.env.GOOGLE_JWKS_URL || 'https://www.googleapis.com/oauth2/v3/certs');
  if (!r.ok) throw new HttpError(502, "Couldn't reach Google to check your sign-in. Please try again.");
  const body = await r.json();
  jwksCache = { keys: body.keys || [], at: Date.now() };
  return jwksCache.keys;
}

export async function verifyGoogleIdToken(token) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) throw new HttpError(500, 'GOOGLE_CLIENT_ID is not set in Vercel.');
  const fail = () => new HttpError(401, 'Google sign-in could not be verified. Please try again.');
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw fail();
  let header, payload;
  try {
    header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch { throw fail(); }
  if (header.alg !== 'RS256' || !header.kid) throw fail();

  let jwk = (await googleKeys(false)).find((k) => k.kid === header.kid);
  if (!jwk) jwk = (await googleKeys(true)).find((k) => k.kid === header.kid);
  if (!jwk) throw fail();
  const valid = crypto.verify('RSA-SHA256', Buffer.from(parts[0] + '.' + parts[1]),
    crypto.createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(parts[2], 'base64url'));
  if (!valid) throw fail();

  const now = Math.floor(Date.now() / 1000);
  if (!['accounts.google.com', 'https://accounts.google.com'].includes(payload.iss)) throw fail();
  if (payload.aud !== clientId) throw fail();
  if (!(payload.exp > now - 60)) throw new HttpError(401, 'Your Google sign-in expired. Please sign in again.');
  if (payload.email_verified !== true && payload.email_verified !== 'true') throw fail();

  const email = String(payload.email || '').toLowerCase();
  const hd = String(payload.hd || '').toLowerCase();
  if (hd !== ALLOWED_DOMAIN || !email.endsWith('@' + ALLOWED_DOMAIN)) {
    throw new HttpError(403, `Only @${ALLOWED_DOMAIN} Google accounts can use this tracker. You signed in as ${email || 'another account'}.`);
  }
  return email;
}

/* ============================= database ============================= */

let sqlFn = null;
let schemaReady = false;

function sql() {
  if (!sqlFn) {
    const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
    if (!url) throw new HttpError(500, 'No database is connected. In Vercel, add a Neon Postgres database under Storage, then redeploy.');
    sqlFn = neon(url);
  }
  return sqlFn;
}

// Used only by the local test harness.
export function __setSqlForTest(fn) { sqlFn = fn; schemaReady = false; }

// Entries carried over from the Claude version of the tracker.
// Added once, only when the table is first created.
const SEED_ENTRIES = [
  { id: 'ntm2x6nbfpj3600ikz3e', createdAt: '2026-09-23T07:15:48.330Z', data: {
    repName: 'Harshita Handa', repEmail: 'Harshita.handa@accredian.com', joiningDate: '2026-08-17',
    vertical: 'IIM Lucknow Chief Human Resources Officer Programme (The CHRO Program)', frcStatus: 'Cleared',
    frc1: 5, frc2: 4.5, frc3: 6, frc4: null, avgScore: 5.17,
    ojtStart: '2026-09-01', cp2: '2026-09-15', cp4: '2026-09-29', cp6: '2026-10-13',
    checkpointStats: { cp2: { registered: 1, recovered: 1 }, cp4: { registered: null, recovered: null }, cp6: { registered: null, recovered: null } },
    ojtStatus: 'Cleared', createdAt: '2026-09-23T07:15:48.330Z', updatedAt: '2026-09-23T09:39:07.823Z' } },
  { id: 'zs675j2byjvuzg0muu05', createdAt: '2026-09-23T08:11:06.354Z', data: {
    repName: 'Anand Giri', repEmail: 'Anand.giri@accredian.com', joiningDate: '2026-08-17',
    vertical: 'IIM Lucknow Chief Human Resources Officer Programme (The CHRO Program)', frcStatus: 'Cleared',
    frc1: 5.5, frc2: 6, frc3: 6.5, frc4: null, avgScore: 6,
    ojtStart: '2026-09-01', cp2: '2026-09-15', cp4: '2026-09-29', cp6: '2026-10-13',
    checkpointStats: { cp2: { registered: 2, recovered: 2 }, cp4: { registered: 4, recovered: null }, cp6: { registered: 1, recovered: null } },
    ojtStatus: 'Cleared', createdAt: '2026-09-23T08:11:06.354Z', updatedAt: '2026-09-23T10:58:44.512Z' } },
];

export async function ensureSchema() {
  if (schemaReady) return;
  const db = sql();
  const existing = await db`SELECT to_regclass('public.entries') IS NOT NULL AS ok`;
  await db`CREATE TABLE IF NOT EXISTS entries (
    id text PRIMARY KEY,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    data jsonb NOT NULL
  )`;
  if (!existing[0] || !existing[0].ok) {
    await db`INSERT INTO entries (id, created_at, data)
      SELECT e->>'id', (e->>'createdAt')::timestamptz, e->'data'
      FROM jsonb_array_elements(${JSON.stringify(SEED_ENTRIES)}::jsonb) AS e
      ON CONFLICT (id) DO NOTHING`;
  }
  schemaReady = true;
}

export async function listEntries() {
  const rows = await sql()`SELECT id, data FROM entries ORDER BY created_at DESC, id DESC LIMIT 5000`;
  return rows.map((r) => ({ id: r.id, data: typeof r.data === 'string' ? JSON.parse(r.data) : r.data }));
}

export async function insertBatch(body, email) {
  const shared = (body && body.shared) || {};
  const reps = Array.isArray(body && body.reps) ? body.reps : [];
  if (reps.length < 1) throw new HttpError(400, 'Add at least one rep.');
  if (reps.length > MAX_REPS_PER_BATCH) throw new HttpError(400, `Up to ${MAX_REPS_PER_BATCH} reps can be added at once.`);

  const base = {
    joiningDate: cleanDate(shared.joiningDate),
    vertical: cleanText(shared.vertical),
    ojtStart: cleanDate(shared.ojtStart),
    cp2: cleanDate(shared.cp2),
    cp4: cleanDate(shared.cp4),
    cp6: cleanDate(shared.cp6),
  };
  const start = Date.now();
  const rows = reps.map((rep, i) => {
    const label = `Rep ${i + 1}`;
    const repName = cleanText(rep && rep.repName);
    const repEmail = cleanText(rep && rep.repEmail);
    if (!repName) throw new HttpError(400, `${label}: rep name is required.`);
    if (!repEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(repEmail)) throw new HttpError(400, `${label}: enter a valid email id.`);
    const frcStatus = FRC_STATUSES.includes(rep.frcStatus) ? rep.frcStatus : null;
    const scores = {};
    ['frc1', 'frc2', 'frc3', 'frc4'].forEach((k) => {
      const v = cleanScore(rep[k]);
      if (v === undefined) throw new HttpError(400, `${label}: FRC scores must be numbers from 0 to 10.`);
      scores[k] = v;
    });
    const filled = Object.values(scores).filter((v) => v !== null);
    const avgScore = filled.length ? Math.round(filled.reduce((a, b) => a + b, 0) / filled.length * 100) / 100 : null;
    const notCleared = frcStatus === 'Not Cleared';
    // Later reps in a batch get a later timestamp, so the newest-first report shows the last row on top.
    const createdAt = new Date(start + i).toISOString();
    return {
      id: crypto.randomUUID(),
      createdAt,
      data: {
        joiningDate: base.joiningDate, repName, repEmail, vertical: base.vertical,
        frcStatus, ...scores, avgScore,
        ojtStart: notCleared ? null : base.ojtStart,
        cp2: notCleared ? null : base.cp2,
        cp4: notCleared ? null : base.cp4,
        cp6: notCleared ? null : base.cp6,
        createdAt, updatedAt: createdAt, createdBy: email,
      },
    };
  });

  await sql()`INSERT INTO entries (id, created_at, data)
    SELECT e->>'id', (e->>'createdAt')::timestamptz, e->'data'
    FROM jsonb_array_elements(${JSON.stringify(rows)}::jsonb) AS e`;
  return rows.map((r) => ({ id: r.id, data: r.data }));
}

export async function updateProgress(id, body, email) {
  const input = (body && body.checkpointStats) || {};
  const checkpointStats = {};
  CHECKPOINTS.forEach((cp) => {
    const c = input[cp] || {};
    const registered = cleanCount(c.registered);
    const recovered = cleanCount(c.recovered);
    if (registered === undefined || recovered === undefined) {
      throw new HttpError(400, 'Registered and Recovered must be whole numbers of 0 or more.');
    }
    checkpointStats[cp] = { registered, recovered };
  });
  const ojtStatus = OJT_STATUSES.includes(body && body.ojtStatus) ? body.ojtStatus : null;
  const patch = { checkpointStats, ojtStatus, updatedAt: new Date().toISOString(), updatedBy: email };

  const rows = await sql()`UPDATE entries
    SET data = data || ${JSON.stringify(patch)}::jsonb, updated_at = now()
    WHERE id = ${id} AND coalesce(data->>'frcStatus', '') <> 'Not Cleared'
    RETURNING id, data`;
  if (rows.length) return { id: rows[0].id, data: typeof rows[0].data === 'string' ? JSON.parse(rows[0].data) : rows[0].data };
  const exists = await sql()`SELECT 1 AS one FROM entries WHERE id = ${id}`;
  if (!exists.length) throw new HttpError(404, 'That entry no longer exists. It may have been deleted.');
  throw new HttpError(409, "FRC isn't cleared for this rep, so there's no OJT data to save.");
}

export async function deleteEntry(id) {
  await sql()`DELETE FROM entries WHERE id = ${id}`;
}

/* ============================= validation ============================= */

function cleanText(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, 200);
  return s || null;
}
function cleanDate(v) {
  const s = String(v || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(s + 'T00:00:00Z');
  return isNaN(d) || d.toISOString().slice(0, 10) !== s ? null : s;
}
// null = blank, undefined = invalid
function cleanScore(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return isNaN(n) || n < 0 || n > 10 ? undefined : n;
}
function cleanCount(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return !Number.isInteger(n) || n < 0 || n > 100000 ? undefined : n;
}
