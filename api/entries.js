import {
  handle, send, readJson, requireMethod, requireUser, HttpError,
  ensureSchema, listEntries, insertBatch, updateProgress, deleteEntry,
} from './_lib.js';

// GET    /api/entries          -> all entries, newest first
// POST   /api/entries          -> add a batch { shared, reps: [...] }
// PATCH  /api/entries?id=...   -> save Registered/Recovered + Final status after OJT
// DELETE /api/entries?id=...   -> delete one entry
export default handle(async (req, res) => {
  requireMethod(req, res, ['GET', 'POST', 'PATCH', 'DELETE']);
  const email = requireUser(req);
  await ensureSchema();
  const id = new URL(req.url, 'http://localhost').searchParams.get('id');

  if (req.method === 'GET') return send(res, 200, { entries: await listEntries() });
  if (req.method === 'POST') return send(res, 201, { entries: await insertBatch(await readJson(req), email) });

  if (!id) throw new HttpError(400, 'Missing entry id.');
  if (req.method === 'PATCH') return send(res, 200, { entry: await updateProgress(id, await readJson(req), email) });
  await deleteEntry(id);
  return send(res, 200, { ok: true });
});
