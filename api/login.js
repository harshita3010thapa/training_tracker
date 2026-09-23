import { handle, send, readJson, requireMethod, verifyGoogleIdToken, setSessionCookie } from './_lib.js';

// POST /api/login { credential } — the Google ID token from "Sign in with Google".
export default handle(async (req, res) => {
  requireMethod(req, res, ['POST']);
  const { credential } = await readJson(req);
  const email = await verifyGoogleIdToken(credential);
  setSessionCookie(res, email);
  send(res, 200, { email });
});
