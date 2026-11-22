# Assumptions, known limits and v2 ideas

## Assumptions made in v1 (all editable in the app or in `src/config`)

| Topic | Assumption |
|---|---|
| Profile | Birth year 1994, 4 years of structured training (edit in Settings → Profile). |
| Default days | Tue / Thu / Sat; 90 min weekdays, 180 min weekends. |
| Newborn preset | Suggested from 2027-03-01 (two weeks before the due date). |
| Cold start | Suggested typical week: 3 × 90 min at RPE 7, 3 finger sessions × 12 min on holds, high intensity. |
| Finger-load index | Grip factors (half crimp 1.0, open hand 0.85, full crimp 1.4, 2F pockets 1.3–1.4, mono 1.8), edge factor √(20/edge), linear intensity — **coaching practice**, not validated. Only meaningful compared with yourself over time. |
| Climbing exposure | Boulder try ≈ 0.4 min on holds, route burn ≈ 2.5 min; fallback 12–15 % of session time. |
| Norms | Indicative grade-based norms (max hang % BW, pull-up, lock-off, front lever, repeaters) — coaching heuristics, used for 50 % of the weakness score only. |
| Board vs outdoor | A gap > 1 sub-grade between Kilter and outdoor boulder grades counts as a technique / transfer weakness *to confirm*. |
| Progression | +2.5 % BW (rounded to 0.5 kg) if all sets done at mean RPE ≤ 8; max +2.5 % BW per week on finger loads; −5 % after two failed sessions. |
| Readiness | Weighted 1–5 check-in + sleep vs personal baseline (median of 28 days, default 7.5 h); newborn mode halves sleep weight and lowers thresholds. |
| Pain rules | Adapted from the pain-monitoring model for Achilles tendinopathy (Silbernagel 2007) — an extrapolation to fingers. |
| Tendon isometrics | Low-intensity long isometrics labelled **experimental** (rationale from engineered-ligament research, Baar 2017). |
| Critical force | Mean of the last 6 reps of an all-out 7:3 test (implementation choice; Giles 2019 validated the single-session approach). |
| Tindeq | Published Progressor BLE protocol; software tare by default; force-drop = 2 reps in a row > 15 % below reference. |
| Garmin | Personal API endpoints for sleep summaries, HRV and daily summaries; response field names (`sleepTimeSeconds`, `sleepScores.overall.value`, `lastNightAvg`, `restingHeartRate`, `bodyBatteryHighestValue`) are taken from Garmin's public data model and parsed defensively. **First run to verify** — if a value stays empty, the field name differs and only `src/sync/garmin.ts` needs adjusting. |
| Sync | Last-write-wins per record; both devices editing the same record within the same sync window → the later edit wins. |

## Known limits of v1

- **Not yet run end-to-end in a real browser by the author**: modules were unit-tested and
  type-checked in isolation; the CI workflow is the first full type-check + test + build of the
  assembled repository. Expect possibly a few small type fixes on the first run.
- **Reminders** only fire while the app is open or in the background; a fully closed PWA cannot be
  woken without a push server (not free / not serverless).
- **Web Bluetooth** works in Chrome / Edge (Android, Windows, macOS, Linux), not in Firefox or iOS Safari.
- **Garmin**: data arrives at most twice a day (Action schedule); Garmin does not publish rate limits.
- **ACWR** is a debated metric (Impellizzeri 2020): warning signal only, never an injury predictor.
- **Plan versions** store full snapshots; after many months the sync file grows (a few MB). Fine for
  Gists, but see v2.
- **CSV** is export-only (import is JSON).

## Suggested v2 improvements

1. **Plan history compaction**: keep full snapshots for the last 30 versions, reason/date only before (needs schema v2 + migration).
2. **Outdoor-day planner**: per-crag profile (rock, angle, holds) to pick the right taper and finger load before trips.
3. **Kilter / board log import** from CSV exports, to fill the grade pyramid and finger load automatically.
4. **Per-grip finger strength tests** (half crimp, open hand, 3F pocket) on the Tindeq with separate trends.
5. **Rate of force development** from Tindeq curves (contact strength / power tracking).
6. **Smarter climbing finger-load estimate** calibrated on your own Tindeq + RPE data (personal regression).
7. **Session templates library** in the UI (save a custom session, reuse it).
8. **Encrypted gist** (AES-GCM with a passphrase) so the gist content is unreadable even if the token leaks.
9. **Web Push via a free tier** (e.g. a Cloudflare Worker cron) for reminders when the app is closed.
10. **Supabase fallback sync** implementation (documented in README, not built).
11. **Shareable read-only report** (PDF of the block, re-test results and pain log) for a physio or coach.
12. **Multi-language UI** (French) once the English UI is stable.
