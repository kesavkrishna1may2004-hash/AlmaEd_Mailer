# AlmaEd Mailer

Outreach tools for **AlmaED**, which offers 1-on-1 mentoring by IIT, NIT and AIIMS students.

| Folder | What it is | Runs on |
| --- | --- | --- |
| [`email/`](email/) | Mail merge: a personalised email to every alumnus in the Sheet, about 100 a day | Google Apps Script, inside the Sheet |
| [`dashboard/`](dashboard/) | WhatsApp outreach dashboard: import contacts, start/pause, read and answer replies | **Vercel** (static site) |
| [`supabase/`](supabase/) | Database for contacts, messages, replies and settings, with login | **Supabase** |
| [`sender/`](sender/) | Links the spare WhatsApp number through [gowa](https://github.com/aldinokemal/go-whatsapp-web-multidevice) and does the sending | Your laptop (Windows/Mac), or any always-on server |

```
 Phone / laptop browser                        Your laptop (on 10am-7pm)
 ┌──────────────────────┐   ┌────────────┐    ┌──────────────────────────┐
 │ Dashboard on Vercel  │──▶│  Supabase  │◀──▶│ Sender ──▶ gowa ──▶ WhatsApp
 │ (login, import,      │   │ (data, auth│    │ (sends, reads replies,   │
 │  replies, settings)  │◀──│  job queue)│    │  runs dashboard jobs)    │
 └──────────────────────┘   └────────────┘    └──────────────────────────┘
```

WhatsApp needs a linked device that stays connected all the time. Vercel only runs short-lived functions, so the sending part stays on a computer you control, and everything else is online.

> **No personal data or secrets go in this repo.** The alumni `.xlsx`/`.csv`, `sender/config.json` (it holds the Supabase secret key), logs and the WhatsApp session are all in `.gitignore`.

---

## Deploy (about 15 minutes, all free tiers)

### 1. Supabase: database and login

1. Go to [supabase.com](https://supabase.com), sign in with GitHub and create a **New project**. Use region **Mumbai** and save the database password somewhere safe.
2. Open **SQL Editor → New query** and paste all of [`supabase/schema.sql`](supabase/schema.sql). On the **last line**, replace `you@example.com` with the email you'll sign in with. Click **Run**. You can run it again later; it only adds what is missing.
3. Open **Authentication → Users → Add user → Create new user**. Enter that email and a strong password, tick **Auto Confirm User**, and create the user.
4. Recommended: in **Authentication → Sign In / Providers**, turn off **Allow new users to sign up**. Only emails in the `admins` table can see data anyway.
5. Copy three values from **Project Settings → API Keys** (and **Data API** for the URL):

| Value | Looks like | Goes to |
| --- | --- | --- |
| Project URL | `https://abcdefgh.supabase.co` | Vercel **and** the sender |
| Publishable key (or legacy `anon` key) | `sb_publishable_…` | Vercel only |
| Secret key (or legacy `service_role` key) | `sb_secret_…` | The sender's `config.json` only. Never on Vercel or GitHub. |

### 2. Vercel: the dashboard

1. Merge this branch into `main` on GitHub, since Vercel deploys `main`.
2. On [vercel.com](https://vercel.com), sign in with GitHub, then **Add New… → Project → Import** `AlmaEd_Mailer`.
3. Set **Root Directory** to `dashboard` and leave Framework Preset as **Other**. `dashboard/vercel.json` already sets the build.
4. Add **Environment Variables**:
   - `SUPABASE_URL` = Project URL
   - `SUPABASE_ANON_KEY` = publishable (or anon) key
5. Click **Deploy** and open the address it gives you, for example `almaed-mailer.vercel.app`. Sign in with the user from step 1.3.

The build stops with a clear message if a variable is missing or if the secret key is pasted by mistake.

### 3. The sender on the laptop

1. Install [Node.js](https://nodejs.org) LTS (version 22 or newer).
2. Copy the `sender/` folder to the laptop, or use the ready zip that includes gowa. Then put the gowa program in `sender/gowa/` ([which file](sender/gowa/README.md)).
3. Double-click **Start AlmaED Sender** (`.bat` on Windows, `.command` on Mac). The first run creates `config.json` and stops. Paste the Project URL and the **secret** key into it and start the sender again.
4. On the dashboard: **Show QR code**, scan it from the spare phone, import the `.xlsx`, **Send test to my number**, then **Start sending**.

Plain-language steps and troubleshooting are in [`sender/SETUP GUIDE.txt`](sender/SETUP%20GUIDE.txt).

---

## How it works

- **Import:** the dashboard reads the `.xlsx` in the browser. It uses only the *WA number* column of each region tab and merges duplicates. It skips people whose call notes say *not interested*, *wrong number*, *blocked*, *not an alumnus* or *passed away*. Re-importing adds only new numbers.
- **Pacing:** a warm-up of 15, then 25, then 35 messages a day, and then the daily limit (default 50). Messages go out 90–240 s apart, only between 10:00 and 19:00 IST. A typing indicator shows first, and `[[Hi|Hello]]` variations keep messages from being identical.
- **Replies:** gowa sends replies to the sender through a signed webhook on `127.0.0.1`.
  - *Yes / please share / my son…* get the details and demo link automatically.
  - *No / not interested / stop* are closed.
  - Everything else waits under **Needs your reply**.
- **Dashboard → sender:** buttons like *Show QR code*, *Send test* and *Send reply* add a row to the `commands` table. The sender picks it up within seconds and writes back the result. The sender reports a heartbeat every 10 s, and the dashboard shows it as offline after 45 s without one.
- **Security:** every table has row-level security. Only signed-in users whose email is in `public.admins` can read or write. The publishable key on Vercel can do nothing by itself. The secret key stays on the sender's machine.

| Path | Purpose |
| --- | --- |
| `supabase/schema.sql` | Tables, admin check, RLS policies, default messages |
| `dashboard/index.html`, `app.js` | Dashboard UI and logic (supabase-js and SheetJS from jsDelivr, pinned with SRI) |
| `dashboard/rules.js` = `sender/src/rules.js` | Names, phone numbers, opt-out rules, reply classification, message variations |
| `dashboard/build.js`, `vercel.json` | Writes `config.js` from the Vercel env vars |
| `sender/src/index.js` | Sending loop, webhook, job runner, heartbeat |
| `sender/src/gowa.js` | gowa API client and process manager |

## Costs and limits

- **Supabase Free:** 500 MB database, which holds far more than this needs. A free project pauses after a week with no activity. The running sender keeps it active; if it does pause, open Supabase and click **Restore**.
- **Vercel Hobby:** free, but Vercel's terms limit Hobby to non-commercial use. If you'd rather stay clearly inside the terms for AlmaED, the same `dashboard/` folder deploys unchanged to Cloudflare Pages: build command `node build.js`, output folder `dist`, same two variables.
- **WhatsApp:** use a **spare number** and keep the daily limit at 80 or below. gowa is an unofficial client, so numbers that send many cold messages can be banned.

## Email (Google Apps Script)

1. Open the alumni Google Sheet while signed in to the account the emails should come from.
2. Go to **Extensions → Apps Script**, replace the sample code with [`email/AlmaED_Email.gs`](email/AlmaED_Email.gs), save, and reload the Sheet.
3. Use the new **AlmaED Email** menu:
   1. **Set up / refresh email list**
   2. **Send a test email to me**
   3. **Send next batch now**, or **Start auto-send (hourly)**
4. Edit the subject, body and daily limit in the *Email template* tab.
