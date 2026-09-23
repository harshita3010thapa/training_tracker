# Training Batch Tracker

Add training batches (one row per rep), track FRC scores, OJT checkpoints and
Registered/Recovered counts, filter the report, and download everything as CSV.

Anyone with an **@accredian.com Google account** can sign in and use it. Everyone
else is turned away, and the check happens on the server.

## How it's built

- `index.html` — the whole page (form, report, detail view, CSV download).
- `api/` — Vercel serverless functions:
  - `session.js` — who is signed in
  - `login.js` / `logout.js` — Google sign-in, sets a 7-day session cookie
  - `entries.js` — list, add a batch, update checkpoint counts, delete
  - `_lib.js` — shared code (database, sign-in checks, validation)
- Data lives in a Postgres database (Neon, added through Vercel). The table is
  created automatically the first time the app is used, with the two entries
  carried over from the earlier Claude version.

## Setup (one time, about 15 minutes)

### 1. Import the repository into Vercel
1. In Vercel, click **Add New → Project** and import `training_tracker`.
2. Leave **Framework Preset** as **Other** and every build setting at its default.
3. Click **Deploy**. The first deploy works, but sign-in won't until steps 2–4 are done.
4. Note your site address, e.g. `https://training-tracker.vercel.app`.

### 2. Add the database
1. In the Vercel project, open **Storage → Create Database → Neon (Postgres)**.
2. Create it (the free size is plenty) and **connect it to this project**.
   This adds a `DATABASE_URL` environment variable automatically.

### 3. Create the Google sign-in client
Do this with your Accredian Google account at <https://console.cloud.google.com>.
1. Create (or pick) a project inside the **accredian.com** organization.
2. Open **Google Auth Platform** (older name: *APIs & Services → OAuth consent screen*):
   - App name: `Training Batch Tracker`
   - Audience / User type: **Internal** — this limits sign-in to accredian.com accounts.
3. Open **Clients** (or *Credentials*) → **Create client** → **Web application**:
   - **Authorized JavaScript origins:** your Vercel address from step 1,
     e.g. `https://training-tracker.vercel.app` (no trailing slash).
     Add a custom domain here too if you use one.
4. Copy the **Client ID** (it ends in `.apps.googleusercontent.com`).

If you can't choose *Internal* or create the client, ask your Google Workspace admin;
some organizations restrict who can create these.

### 4. Add environment variables in Vercel
**Project → Settings → Environment Variables**, for *Production* (and *Preview* if you use it):

| Name | Value |
| --- | --- |
| `GOOGLE_CLIENT_ID` | the Client ID from step 3 |
| `SESSION_SECRET` | a long random string, at least 32 characters (e.g. from a password generator) |
| `ALLOWED_DOMAIN` | optional — defaults to `accredian.com` |

Then go to **Deployments**, open the latest one, and choose **⋯ → Redeploy**
so the new variables take effect.

### 5. Use it
Open your Vercel address, click **Sign in with Google**, and choose your
@accredian.com account. Share the address with your team.

## Notes

- **Sign-in is checked on the server.** The server verifies Google's signature,
  that the email is verified, and that it belongs to the Accredian Workspace
  (`hd = accredian.com`). A non-Accredian account gets a clear "not allowed" message.
- **Everyone who signs in shares the same entries** and can add, edit and delete them.
  Each entry records who added or last updated it (`createdBy` / `updatedBy`).
- **Vercel plan:** Vercel's free Hobby plan is for personal, non-commercial use.
  A company tool like this falls under their Pro plan.
- **Preview deployments** get their own addresses. Sign-in only works on addresses
  listed in step 3's *Authorized JavaScript origins*.
