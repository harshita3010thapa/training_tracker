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
- `api/_lib.js` — shared server code (Supabase access and validation).
- Data lives in **Supabase**, in the table `public.training_entries`
  (project *Batch Handover Database*). One row per rep.
  Row Level Security is on with no public policies, so the table can only be read
  or changed through this app's server, which uses the project's secret key.

## Setup

### 1. Supabase (already done)
The `training_entries` table has been created in the *Batch Handover Database*
project, with the two entries carried over from the earlier Claude version.
You can see it under **Table Editor → training_entries**.

### 2. Vercel environment variables
In the Vercel project, open **Settings → Environment Variables** and add
(for *Production*, and *Preview* if you use it):

| Name | Value |
| --- | --- |
| `SUPABASE_URL` | `https://tzetzngxwzotwpfddgmc.supabase.co` |
| `SUPABASE_SECRET_KEY` | your project's secret key — see below |

**Where to find the secret key:** Supabase dashboard → *Batch Handover Database* →
**Project Settings → API Keys**. Copy a **Secret key** (starts with `sb_secret_`).
If you only see legacy keys, copy the **service_role** key instead.
Keep this key private: never put it in `index.html` or share it.

Then go to **Deployments**, open the latest one, and choose **⋯ → Redeploy**.

### 3. Clean up (optional)
The app no longer uses Neon. If you added a Neon database in Vercel, you can
disconnect it under **Storage**; the `DATABASE_URL` variable is no longer needed.

## Updating the app
Push changes to the `main` branch on GitHub and Vercel redeploys automatically.

## Table columns (`public.training_entries`)

| Column | Meaning |
| --- | --- |
| `id`, `created_at`, `updated_at` | set automatically |
| `joining_date`, `vertical`, `ojt_start` | shared batch details |
| `rep_name`, `rep_email` | required for every rep |
| `frc_status` | Cleared / Not Cleared / Pending |
| `frc1`–`frc4`, `avg_score` | 0–10 |
| `cp2_date`, `cp4_date`, `cp6_date` | checkpoint dates |
| `cp2_registered` … `cp6_recovered` | counts entered in the report's detail view |
| `ojt_status` | Final status after OJT: Cleared / Exit / OJT Extended |
| `exit_date` | date the rep exited (only when Final status is Exit) |

## Notes

- **Everyone with the link shares the same entries** and can add, edit and delete them.
  Downloading the CSV now and then is an easy backup.
- **Vercel plan:** Vercel's free Hobby plan is for personal, non-commercial use.
  A company tool like this falls under their Pro plan.
