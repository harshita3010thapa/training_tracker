// Shared server code for the Training Batch Tracker.
// Files in /api that start with "_" are not deployed as endpoints.
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
  // Writes must come from this app's own page (other sites can't send this header without CORS).
  if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'tbt') {
    throw new HttpError(403, 'Request blocked.');
  }
}

/* ============================= database (Supabase) ============================= */

// Rows live in the Supabase table public.training_entries, reached through Supabase's REST API.
// The table has Row Level Security on with no public policies, so only this server
// (using the project's secret key) can read or write it.
const TABLE = 'training_entries';
const PAGE_SIZE = 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
let fetchImpl = (...args) => fetch(...args);

// Used only by the local test harness.
export function __setFetchForTest(fn) { fetchImpl = fn; }

function supabaseConfig() {
  const url = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '').trim().replace(/\/+$/, '');
  const key = (process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!url || !key) {
    throw new HttpError(500, 'Supabase is not connected. In Vercel, add SUPABASE_URL and SUPABASE_SECRET_KEY, then redeploy.');
  }
  return { url, key };
}

async function rest(method, query, body, prefer) {
  const { url, key } = supabaseConfig();
  // New keys (sb_secret_...) go in the apikey header only; legacy JWT keys also go in Authorization.
  const headers = { apikey: key, Accept: 'application/json' };
  if (key.startsWith('eyJ')) headers.Authorization = 'Bearer ' + key;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (prefer) headers.Prefer = prefer;
  const res = await fetchImpl(`${url}/rest/v1/${TABLE}${query ? '?' + query : ''}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok) {
    console.error('Supabase error', res.status, text);
    if (res.status === 401 || res.status === 403) {
      throw new HttpError(500, 'Supabase rejected the key. Check SUPABASE_SECRET_KEY in Vercel (use the secret or service_role key).');
    }
    if (data && (data.code === '42P01' || data.code === 'PGRST205')) {
      throw new HttpError(500, `The ${TABLE} table was not found in Supabase.`);
    }
    throw new HttpError(502, 'The database refused the change: ' + ((data && (data.message || data.hint)) || `error ${res.status}`));
  }
  return data;
}

const num = (v) => (v === null || v === undefined ? null : Number(v));

function rowToEntry(r) {
  return {
    id: r.id,
    data: {
      joiningDate: r.joining_date, repName: r.rep_name, repEmail: r.rep_email, vertical: r.vertical,
      frcStatus: r.frc_status,
      frc1: num(r.frc1), frc2: num(r.frc2), frc3: num(r.frc3), frc4: num(r.frc4), avgScore: num(r.avg_score),
      ojtStart: r.ojt_start, cp2: r.cp2_date, cp4: r.cp4_date, cp6: r.cp6_date,
      checkpointStats: {
        cp2: { registered: r.cp2_registered, recovered: r.cp2_recovered },
        cp4: { registered: r.cp4_registered, recovered: r.cp4_recovered },
        cp6: { registered: r.cp6_registered, recovered: r.cp6_recovered },
      },
      ojtStatus: r.ojt_status, exitDate: r.exit_date,
      createdAt: r.created_at, updatedAt: r.updated_at,
    },
  };
}

export async function listEntries() {
  const rows = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const page = await rest('GET', `select=*&order=created_at.desc,id.desc&limit=${PAGE_SIZE}&offset=${offset}`);
    rows.push(...(page || []));
    if (!page || page.length < PAGE_SIZE) break;
  }
  return rows.map(rowToEntry);
}

export async function insertBatch(body) {
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
      created_at: createdAt, updated_at: createdAt,
      joining_date: base.joiningDate, rep_name: repName, rep_email: repEmail, vertical: base.vertical,
      frc_status: frcStatus, frc1: scores.frc1, frc2: scores.frc2, frc3: scores.frc3, frc4: scores.frc4, avg_score: avgScore,
      ojt_start: notCleared ? null : base.ojtStart,
      cp2_date: notCleared ? null : base.cp2,
      cp4_date: notCleared ? null : base.cp4,
      cp6_date: notCleared ? null : base.cp6,
    };
  });

  // One request = one transaction: either every rep is saved or none are.
  const inserted = await rest('POST', 'select=*', rows, 'return=representation');
  return (inserted || []).map(rowToEntry);
}

export async function updateProgress(id, body) {
  if (!UUID_RE.test(String(id))) throw new HttpError(404, 'That entry no longer exists. It may have been deleted.');
  const input = (body && body.checkpointStats) || {};
  const patch = {};
  CHECKPOINTS.forEach((cp) => {
    const c = input[cp] || {};
    const registered = cleanCount(c.registered);
    const recovered = cleanCount(c.recovered);
    if (registered === undefined || recovered === undefined) {
      throw new HttpError(400, 'Registered and Recovered must be whole numbers of 0 or more.');
    }
    patch[`${cp}_registered`] = registered;
    patch[`${cp}_recovered`] = recovered;
  });
  patch.ojt_status = OJT_STATUSES.includes(body && body.ojtStatus) ? body.ojtStatus : null;
  patch.exit_date = patch.ojt_status === 'Exit' ? cleanDate(body.exitDate) : null;

  const filter = `id=eq.${id}&or=${encodeURIComponent('(frc_status.is.null,frc_status.neq."Not Cleared")')}`;
  const rows = await rest('PATCH', `${filter}&select=*`, patch, 'return=representation');
  if (rows && rows.length) return rowToEntry(rows[0]);
  const exists = await rest('GET', `id=eq.${id}&select=id`);
  if (!exists || !exists.length) throw new HttpError(404, 'That entry no longer exists. It may have been deleted.');
  throw new HttpError(409, "FRC isn't cleared for this rep, so there's no OJT data to save.");
}

export async function deleteEntry(id) {
  if (!UUID_RE.test(String(id))) return;
  await rest('DELETE', `id=eq.${id}`);
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
