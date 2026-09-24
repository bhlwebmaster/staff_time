# BHL Attendance

Clock-in app for the Philippine team, built to replace posting in the WhatsApp group.

- **Staff app** (`/`): tap your name, enter your 4-digit PIN, then tap **Clock in → Start lunch → End lunch → Clock out**. It shows UK time and Manila time, your OT bank, who else is in today, and a **Copy WhatsApp message** button that outputs the same format the group uses.
- **Admin** (`admin.html`): live board, timesheets, **Reports** (daily / weekly / monthly / custom dates, exported to PDF or CSV), edits to any entry (every change is logged), staff management, PIN resets, and **Access**, where admins create logins for other admins or finance.

Production app: there is no demo mode. If `config.js` is missing its Supabase settings, both pages show an "isn't set up yet" message instead of loading.

---

## Go live: Supabase + GitHub Pages (about 20 minutes, free)

Supabase stores the data and runs the one server-side piece (creating logins). GitHub Pages hosts the pages.

### 1. Supabase: database
1. Create a project at https://supabase.com. Pick a region near London or Singapore.
2. Go to **SQL Editor → New query**, paste all of `supabase/schema.sql`, and click **Run**.
3. Optional: run `supabase/seed.sql` to add Rae and Cess plus the entries already posted in WhatsApp (22–23 Sept).
4. Make yourself the first admin:
   - **Authentication → Users → Add user → Create new user**: enter your email and a password, and tick **Auto Confirm User**.
   - Back in **SQL Editor**, run:
     ```sql
     insert into public.admins (user_id, email, role)
     select id, email, 'admin' from auth.users where email = 'mylesjessop@me.com';
     ```
   You only do this once. Every other login is created from the admin page.
5. **Authentication → Sign In / Providers → Email**: turn off **Allow new users to sign up**, so nobody can create their own account.
6. **Project Settings → API** (or **API Keys**): copy the **Project URL** and the **anon / public** key.

### 2. Supabase: the "create logins" function
1. Go to **Edge Functions → Deploy a new function → Via Editor**.
2. Name it exactly `admin-users`.
3. Delete the sample code, paste all of `supabase/functions/admin-users/index.ts`, and click **Deploy**.
4. Open the function → **Details / Settings**, turn **off** "Verify JWT" (called "Enforce JWT verification" in some versions), and save.
   It's safe to turn this off because the function checks the caller's login and admin role itself.
   Supabase gives the function its secret key automatically, so you don't need to set anything else.

### 3. Put the keys in `config.js`
Edit these two lines with your values from step 1.6:
```js
SUPABASE_URL: "https://xxxx.supabase.co",
SUPABASE_ANON_KEY: "eyJhbGciOi...",
```
The anon key is designed to be public. **Never** put the service_role key in this file.

### 4. GitHub: upload the files
1. On https://github.com, click **+ → New repository**. Name it `bhl-attendance`, choose **Public** (Pages is free for public repos), and leave "Add a README" unticked. Click **Create repository**.
2. Click the **"uploading an existing file"** link. Open the unzipped `bhl-attendance` folder, select **everything inside it**, and drag it into the browser. Then click **Commit changes**.
   The repo's front page must show `index.html` directly, not inside a folder.
   Note: `.nojekyll` is a hidden file. On a Mac, press **Cmd+Shift+.** in Finder to show it so it gets included. If it's missing, use **Add file → Create new file**, name it `.nojekyll`, leave it empty and commit.

### 5. GitHub Pages: switch it on
1. In the repo, go to **Settings → Pages**.
2. **Source:** Deploy from a branch. **Branch:** `main`, folder `/ (root)`. Click **Save**.
3. Wait 1–2 minutes and refresh. The page shows your link:
   - Staff app: `https://bhlwebmaster.github.io/staff_time/`
   - Admin: `https://bhlwebmaster.github.io/staff_time/admin.html`

### 6. Quick test
1. Open the admin link and sign in.
2. **Access** tab: you're listed. Create a test finance login to check the function works.
3. **Staff** tab: add people, or check Rae and Cess are there if you ran the seed.
4. On your phone, open the staff link, tap a name, create a PIN, then clock in and clock out.
5. **Reports** → **Export PDF**.

### 7. Roll out
- Send staff the link. On the phone, **Share → Add to Home Screen** makes it open like an app.
- Bookmark `admin.html` for yourself and finance.
- **Updating later:** in the repo, use **Add file → Upload files**, drag in the changed files and commit. Pages republishes within a minute or two.
- **Optional custom domain** (e.g. `attendance.biohacklondon.com`): go to repo **Settings → Pages → Custom domain**, then add the CNAME record GitHub shows you at your domain's DNS.

### Troubleshooting
| You see | Fix |
|---|---|
| 404 on the Pages link | Wait 2 minutes; check Settings → Pages is set to `main` / root, and that `index.html` sits at the top of the repo. |
| "This app isn't set up yet" | `config.js` is missing its Supabase settings or was overwritten by a blank copy. |
| "User management isn't set up yet" | Deploy the `admin-users` Edge Function (step 2) with exactly that name. |
| Creating a login fails with a network or CORS error | Turn off "Verify JWT" on the function (step 2.4). |
| "This login doesn't have access" | That email isn't in the `admins` table. For your own first login, run the SQL in step 1.4. |
| Supabase project paused | The free tier pauses after about a week with no use. Click **Restore** in Supabase; daily clock-ins keep it awake. |

---

## Profiles and the game layer
- **Profile:** staff tap their avatar (or **Edit profile**) to pick one of 12 avatars or upload their own photo (cropped and shrunk to ~10 KB), plus a card colour and a tagline of up to 40 characters. It's saved with their PIN. Admins can remove a photo under Staff → Edit.
- **XP (resets monthly):** +10 on-time clock-in (+3 if late), +10 complete day, +5 lunch logged, +5 early bird (5+ min early). Levels: Rookie 0 · Regular 100 · Reliable 250 · Pro 450 · Ace 700 · Legend 1000.
- **Streak:** on-time days in a row; days off don't break it, a late clock-in resets it. Shown on each person's card.
- **Badges:** First Punch, Early Bird, On Fire, Iron Streak, Perfect Week, Lunch Pro, No Loose Ends, Extra Mile.
- Confetti plays for an on-time clock-in, a new badge or a level-up (not shown if the phone has "reduce motion" on).

## Weekly schedule
- **Usual week:** Staff → Edit → tick working days and set start/end (UK). Unticked = rest day.
- **Schedule tab:** change any date to a different shift, Rest Day, Vacation / Sick Leave, Holiday or Unpaid Leave, then **Save week**. **Copy last week** and **Reset to usual week** help.
- The homepage shows the week as a **Table** or an hour-by-hour **Timeline**. Clock-ins use that day's planned shift; rest days don't count as absences.

- **Staff requests:** staff can request changes to their own week (this week + next 2) from **My schedule**. Admins approve or reject under **Schedule** (orange number on the tab). Needs `supabase/requests.sql` (included in `database-update.sql`).
- **Status column:** on the homepage's Today view, each person shows Working / On lunch / Clocked out / Not in yet / Late / Absent / Rest day / leave.

## WhatsApp
After clocking in or out, staff tap **Copy & Send to WhatsApp Group**: the message is copied in the group's format, and they paste it into the WhatsApp group.

## Payroll
- Pay is **bi-monthly**: cut-offs 1st–15th and 16th–end, usually 10 working days (Settings → Working days per cut-off).
- Staff → Edit: set **Start date**, **Pay type** (Hourly, Daily, Weekly, Bi-monthly, Monthly) and rate. Fixed types: daily rate = pay per cut-off ÷ 10 (weekly: ÷ 5; monthly: half per cut-off); absences deducted at that rate.
- **Philippine public holidays** (Settings → Public holidays; 2026 and 2027 preloaded) make a working day a paid day off.
- Payroll → **+ New period**: pick the cut-off, check the payment date, add the exchange rate ₱/£ and total transfer fee ₱.
- Days worked, lates, undertime and absences come from attendance + schedule; type over any value to change it; add other deductions (CA, loans, taxes).
- Rules (per period): daily rate = rate ÷ working days; minute rate = daily ÷ paid minutes; lates/undertime × minute rate; absences (missed shifts + unpaid leave) × daily rate; paid leave is paid; transfer fee split by share of net pay.
- **Save draft**, then **Finalise & publish** → staff see their payslips under **My payslips**. Payslip PDF per person or all at once; CSV export.
- Only admins edit payroll; finance can view and download.

## Logins and roles
| Role | Can do |
|---|---|
| **Admin** | Everything: edit or add entries, manage staff and PINs, change settings, create, change or remove logins. |
| **Finance** | View the live board, timesheets and reports, and export CSV or PDF. Can't change anything; the database enforces this, not just the screen. |

To create a login, go to **Access → Create a login**: enter an email, pick a role, click **Generate** for a temporary password, then click **Create login**. Copy the details and send them privately. They sign in at `admin.html` and change their password under **Access → My password**. Admins can switch roles or remove a login from the same page. You can't remove or demote yourself, so there's always at least one admin.

## Reports
In **Admin → Reports**:
- **Daily**: one day, with hours per person plus each person's in, lunch and out.
- **Weekly**: Mon–Sun, with hours per person per day.
- **Monthly**: a calendar month, with hours per person per week.
- **Custom dates**: any from–to range. Up to 14 days shows by day, up to about 4 months by week, and longer ranges by month.

Use ← / → to step back or forward a period, and filter to one person if needed. **Export PDF** downloads a landscape A4 report: summary figures, the hours table with totals, full daily detail (missing clock-outs highlighted), and page numbers. **CSV** gives the same table in decimal hours for spreadsheets or invoicing.

## How the numbers work
All times are **UK time** (Europe/London). That's the "GMT" the team already uses in WhatsApp, and it follows BST automatically. You can change it in Settings.

| Term | Rule |
|---|---|
| **Worked** | Time out − time in − the lunch actually tapped (no lunch tapped = nothing taken off). |
| **Expected** | That day's schedule minus its planned lunch (Staff → Usual week, lunch per day). |
| **OT earned** | Worked − expected, in whole blocks (default 30 min: 45 extra → 30, 1:20 → 1:00). |
| **Short** | Worked below expected. Covered by OT in the same cut-off first; the rest is undertime in payroll. |
| **Late** | After start + grace. With "Judge by hours" (default), a day with its full hours isn't late. |
| **No lunch logged** | Planned lunch but no lunch taps: shown as a flag to check. |
| **Billable hrs** | Regular (capped at expected) + OT earned. |

**Offset days:** before clocking in, staff can open "Different schedule today?" and set, for example, 6:30–15:00 with the note "Offset against 30-minute OT yesterday". The shorter day then draws from their OT bank.

## Security model
- Staff never read or write tables directly. Every clock action goes through database functions that check the PIN (stored bcrypt-hashed) and use the **server clock**, so a phone's time can't be changed to fake a punch. After 5 wrong PINs, that name is locked for 15 minutes.
- Anyone with the link can see the team's names and today's status, the same as the WhatsApp group. History and reports are admin-only.
- Admin and finance users sign in with email and password. Row Level Security gives read access to everyone listed in `admins`, and write access only to the `admin` role. PIN hashes can't be read by any login.
- New logins are created by the `admin-users` Edge Function in Supabase. It checks that the caller is signed in with the admin role before using the service key, which never leaves Supabase.
- The GitHub repo is public, but it contains no secrets: the anon key is designed to be public, and the database rules plus the PIN checks protect the data.
- Every create, edit and delete on an attendance entry goes to `audit_log`, with who made it and before/after values. You can see it under "History" in the edit dialog.

## Files
```
index.html        staff app
admin.html        admin
config.js         your Supabase URL + anon key
assets/core.js    time zone maths + hours/OT rules (shared)
assets/api.js     Supabase calls (shows a "not set up" message if config.js is empty)
assets/staff.js   staff app logic
assets/admin.js   admin logic (reports, schedule, payroll, access)
assets/schedule.js  weekly schedule (table + timeline)
assets/payroll.js   pay calculation + payslip (screen + PDF)
assets/game.js    avatars, profiles, XP, streaks, badges
assets/style.css  styles (light + dark)
supabase/database-update.sql   run this in Supabase: everything below in one file
supabase/schema.sql   core tables, security, functions (safe to re-run)
supabase/payroll.sql  payroll tables
supabase/schedule.sql weekly schedule tables
supabase/requests.sql staff schedule requests + approval
supabase/security.sql locks internal/admin functions (Security Advisor)
supabase/production-cleanup.sql   optional: clear test entries before go-live
supabase/functions/admin-users/index.ts   Edge Function: create / change / remove logins
.nojekyll         tells GitHub Pages to serve files as-is
```
