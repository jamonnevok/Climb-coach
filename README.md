# Climb Coach

Personal climbing training app: assessment → weakness ranking → block plan, guided timer with
Tindeq Progressor, load & A2-pulley protection, pain monitoring, sync between phone and laptop.

- **Free forever**: no paid service, no AI calls. Everything runs in your browser.
- **Your data stays yours**: stored on your devices (IndexedDB) and, if you enable sync, in a
  *private* GitHub Gist. The code repository can be public; it never contains your data or keys.
- **Works offline** once installed.

> Not medical advice. Pain rules and rehab protocols are generic. Red flags (pop, bowstringing,
> swelling, pain at rest > 3/10, no improvement after 2 weeks) mean: stop and see a physio.

---

## Setup (≈ 30 minutes, no coding)

You need: a computer with Chrome or Edge, your Android phone with Chrome, a free GitHub account.

### 1. Create a GitHub account and an empty repository

1. Go to <https://github.com/signup> and create an account (free plan).
2. Top-right **+** → **New repository**.
3. Name: `climb-coach`. Visibility: **Public** (needed for free GitHub Pages and free Actions
   minutes; your data is never in the repository). Do **not** add a README. → **Create repository**.

### 2. Upload the code

**Option A — GitHub website (simplest)**

1. On the new repository page click **uploading an existing file**.
2. Open the `climb-coach` folder on your computer, select **everything inside it**
   (`src`, `public`, `tests`, `scripts`, `index.html`, `package.json`, …) and drag it into the page.
   Do not upload a `node_modules` or `dist` folder if you have one.
3. **Commit changes**.
4. The website often skips folders starting with a dot. Check that `.github/workflows/` exists
   in the repository. If not, for each of the 3 files (`ci.yml`, `deploy.yml`, `garmin-sync.yml`):
   **Add file → Create new file**, type the name `.github/workflows/deploy.yml` (the slashes
   create the folders), paste the file content, **Commit changes**.
   Do the same for `.gitignore` if it is missing.

**Option B — GitHub Desktop** (<https://desktop.github.com>): *File → Clone repository*, copy the
project files into the cloned folder, *Commit to main*, *Push origin*. Hidden folders are included.

### 3. Turn on the website (GitHub Pages)

1. Repository → **Settings** → **Pages**.
2. **Source: GitHub Actions**.
3. Go to the **Actions** tab. If asked, click **I understand my workflows, enable them**.
4. Open **Deploy to GitHub Pages** → **Run workflow** (or simply push a change). After ~2 minutes
   the app is live at `https://<your-username>.github.io/climb-coach/`.
5. The **CI** workflow runs the type-check and all unit tests. A green tick = everything passes.
   A red cross does not stop the app from deploying; open the run to see what failed.

### 4. Install the app on your Android phone

1. Open `https://<your-username>.github.io/climb-coach/` in **Chrome** on the phone.
2. Chrome menu **⋮** → **Install app** (or **Add to Home screen** → **Install**).
3. Open it from the home-screen icon: it runs full screen and offline.
4. Follow the onboarding (profile, typical week, schedule, questionnaire, tests) → **Generate my plan**
   → review the weeks in **Plan** → **Validate**.

On the laptop: open the same address in Chrome or Edge; the install icon is in the address bar.

### 5. Sync phone ↔ laptop (optional, recommended)

1. On github.com: profile picture → **Settings** → **Developer settings** → **Personal access
   tokens** → **Tokens (classic)** → **Generate new token (classic)**.
2. Note: `climb-coach sync`. Expiration: 1 year (you will get a reminder e-mail). Scope: tick
   **only `gist`**. → **Generate token** and copy it (it is shown once).
3. In the app on the **phone**: **Settings → Data → Phone ↔ laptop sync** → paste the token →
   leave *Gist ID* empty → **Connect & sync**. A private gist is created.
4. On the **laptop**: same steps with the same token. The app finds the gist by itself.
5. Sync then runs automatically (opening the app, every 10 min, ~20 s after a change).
   The token is stored only on each device. If you ever leak it, delete it on GitHub and create a new one.

Every sync is a revision of the gist: <https://gist.github.com> → your gist → **Revisions** shows
the full history if you ever need to roll back.

### 6. Garmin import (optional)

Imports sleep duration, sleep score, HRV, resting heart rate and Body Battery (Instinct Crossover
Solar data, as provided by Garmin's Personal API). Requires step 5.

1. Sign in to **Garmin Connect on the web** → open the **Personal API key** page → **Create Key**,
   accept the terms, choose **1 year**, copy the key (shown once).
2. In the app: **Settings → Data**, note the Gist ID (or open your gist on gist.github.com: the ID
   is the last part of its address).
3. GitHub repository → **Settings → Secrets and variables → Actions → New repository secret**, add:
   - `GARMIN_API_KEY` = the Garmin key
   - `GIST_TOKEN` = the token from step 5
   - `GIST_ID` = the gist ID
4. **Actions** tab → **Garmin sync** → **Run workflow**. A green tick = data is in the gist; the
   app imports it on the next sync (**Settings → Data → Sync now**).
5. It then runs automatically twice a day (06:20 and 18:20 Brussels winter time).

Notes:
- Garmin may rate-limit; the Action makes only 4 requests per run and shows a warning (not a
  failure) if one data type is missing.
- Action logs of a public repository are public: the script prints only status codes and counts,
  never your health values.
- GitHub pauses scheduled workflows after 60 days without repository activity: re-enable
  *Garmin sync* in the **Actions** tab if that happens.
- Manual sleep entry (morning check-in) always works, with or without Garmin.

### 7. Pair the Tindeq Progressor

1. Do **not** pair the Progressor in Android Bluetooth settings.
2. Turn the Progressor on (press its button). Phone Bluetooth on; when Chrome asks, allow
   **Nearby devices** (Android 12+) or **Location** (older Android).
3. In the app: **Settings → Tindeq Progressor → Connect** (or the Tindeq card in a session) →
   choose **Progressor_xxxx** in the list.
4. Next time: **Reconnect** (one tap; on recent Chrome versions no device list is shown).
5. The Progressor switches itself off after a while when not connected: press its button, then
   **Reconnect**. Without Bluetooth every test can be entered manually.

---

## Daily use (2 minutes)

- **Morning**: Today → tap *Readiness* → 30-second check-in (sleep, fatigue, fingers…).
- **Session**: Today → *Start guided session*. Big timer, beeps, voice countdown, vibration;
  log each set (done, load, RPE, finger feeling). *Pain?* button anytime.
- **Unplanned climbing / other sport**: **+** button → quick log (minutes, RPE).
- **Proposals**: the app proposes (reschedule, lighter session, deload, progression…); nothing
  changes until you tap **Accept**.
- **Sunday**: weekly review card → *Open* → *Done*.
- **End of block**: run the tests, enter the results in **Log → Tests**, then **Plan → Build next block**.
- **Newborn period**: the app proposes *Newborn mode* from 1 March 2027 (change the date in
  **Settings → Mode**). Switching back to Normal starts a 3-week return ramp.

## Data safety

- Weekly automatic backup on each device (last 8 kept): **Settings → Data**.
- **Export CSV for Excel** (semicolons, decimal comma) and full **JSON export / import**.
- Old exports and old app versions are migrated automatically when imported.
- Uninstalling the app or clearing Chrome site data deletes local data: keep sync on or export first.

## For developers

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # unit tests (Vitest)
npm run typecheck  # TypeScript strict
npm run build      # type-check + production build into dist/
```

See [ARCHITECTURE.md](ARCHITECTURE.md) (modules, data model, rules, migrations) and
[ASSUMPTIONS.md](ASSUMPTIONS.md) (assumptions, limits, v2 ideas).

**Fallback sync (not implemented)**: if GitHub Gists ever become unsuitable, the same snapshot
JSON can be stored in a Supabase free-tier table (one row per user, `jsonb` column, row-level
security on `auth.uid()`); only `src/sync/gist.ts` would need a sibling implementation.
