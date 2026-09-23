import { handle, send, requireMethod, currentUser, ALLOWED_DOMAIN } from './_lib.js';

// GET /api/session — who is signed in, plus what the sign-in button needs.
export default handle(async (req, res) => {
  requireMethod(req, res, ['GET']);
  send(res, 200, {
    email: currentUser(req),
    allowedDomain: ALLOWED_DOMAIN,
    googleClientId: process.env.GOOGLE_CLIENT_ID || null,
  });
});
