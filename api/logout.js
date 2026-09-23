import { handle, send, requireMethod, clearSessionCookie } from './_lib.js';

// POST /api/logout
export default handle(async (req, res) => {
  requireMethod(req, res, ['POST']);
  clearSessionCookie(res);
  send(res, 200, { ok: true });
});
