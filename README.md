# Training Batch Tracker

Add training batches (one row per rep), track FRC scores, OJT checkpoints and
Registered/Recovered counts, filter the report, and download everything as CSV.

There is no sign-in: **anyone with the link** can view, add, edit and delete
entries, including rep names and email ids. Only share the link with people who
should have that access.

## How it's built

- `index.html` — the whole page (form, report, detail view, CSV download).
- `api/entries.js` — Vercel serverless function: list, add a batch, update
  checkpoint counts, delete.
- `api/_lib.js` — shared server code (database and validation).
- Data lives in a Postgres database (Neon, added through Vercel). The table is
  created automatically the first time the app is used, with the two entries
  carried over from the earlier Claude version.

## Setup (one time, about 5 minutes)

### 1. Import the repository into Vercel
1. In Vercel, click **Add New → Project** and import `training_tracker`.
2. Leave **Framework Preset** as **Other** and every build setting at its default.
3. Click **Deploy**.

### 2. Add the database
1. In the Vercel project, open **Storage → Create Database → Neon (Postgres)**.
2. Create it (the free size is plenty) and **connect it to this project**.
   This adds a `DATABASE_URL` environment variable automatically.
3. Go to **Deployments**, open the latest one, and choose **⋯ → Redeploy**
   so the app picks up the database.

That's it. Open your Vercel address and start adding entries.

## Updating the app
Push changes to the `main` branch on GitHub and Vercel redeploys automatically.

## Notes

- **Everyone with the link shares the same entries** and can add, edit and delete them.
  If something is deleted by mistake, Neon can restore the database to an earlier
  point in time within its history window (short on the free plan). Downloading the
  CSV now and then is an easy extra backup.
- **Vercel plan:** Vercel's free Hobby plan is for personal, non-commercial use.
  A company tool like this falls under their Pro plan.
