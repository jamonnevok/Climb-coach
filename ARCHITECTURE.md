# Architecture

Single-user, local-first PWA. React 18 + Vite + TypeScript (strict) + Tailwind. No backend.
Everything that decides anything is a **pure function** in `src/engine/` with unit tests; the UI
only displays derived state and turns taps into calls to `src/app/services.ts`.

```
UI (src/ui)  ──calls──▶  Services (src/app/services.ts)  ──▶  Repo (src/data/repo.ts)  ──▶  IndexedDB (src/data/db.ts)
     ▲                         │ uses pure engines                     ▲
     └──── derive() ◀──────────┘ (src/app/derive.ts)                  └── Sync / backup / CSV (src/sync)
```

## Folder map

| Folder | Content | Rule of thumb |
|---|---|---|
| `src/lib` | dates (local `YYYY-MM-DD`, weeks start Monday), ids, grade ladders (French / Font) | tiny, dependency-free |
| `src/data` | `schema.ts` (all persisted types), `defaults.ts`, `migrations.ts`, `merge.ts` (last-write-wins), `storage.ts` (interface + in-memory), `db.ts` (IndexedDB), `repo.ts` (the only writer) | every write goes through `Repo` |
| `src/config` | **editable JSON**: `exercises.json`, `plan-templates.json`, `thresholds.json`, `adaptation-rules.json`, `norms.json`, `rehab-protocols.json`, `references.json`; typed by `index.ts` | change behaviour here first |
| `src/engine` | load (Foster sRPE, finger-load index, EWMA ACWR, caps), coldStart, readiness, assessment (weakness ranking), progression, planRules, planGenerator, planOps, adaptation, pain, weeklyReview, injuryPatterns, library | pure, deterministic, tested |
| `src/timer` | `timerEngine` (wall-clock state machine), `guidedSession`, `cues` (audio / voice / vibration), `wakeLock` | engine is pure; cues/wakeLock are browser-only |
| `src/tindeq` | `protocol` (TLV encode/decode), `progressor` (client, transport-agnostic), `webBluetooth` (transport), `forceAnalysis`, `repeaterMonitor` | protocol + analysis are pure |
| `src/sync` | `gist` (sync), `garmin` (parser/import), `csv` (+ zip writer), `backup`, `autoSync`, `deviceState`, `download` | network code isolated here |
| `src/app` | `services` (actions), `derive` (everything the UI shows), `proposals` (daily rule run, dedup by key), `reminders` | glue between engines and UI |
| `src/ui` | `App`, hash `router`, `store` (context), `components/*`, `pages/*` | no business rules in components |
| `scripts` | `garmin-sync.mjs` (GitHub Action) | logs counts only, never values |
| `tests` | Vitest unit tests + `fixtures.ts` (owner profile) + UI smoke test | run `npm test` |

## Data model (schema v1)

All synced records extend `BaseRecord { id, createdAt, updatedAt, deleted? }`. Deletion =
tombstone (`deleted: true`), purged after 180 days. Units are metric.

| Store | Key | Notes |
|---|---|---|
| `profile` | id | **dated history**; latest by `date` is used |
| `settings` | `'settings'` | singleton; `tindeq`, `sync`, `backup` sub-objects are **device-local** (never taken from the other device in a merge) |
| `benchmarks` | id | max hang (kg added), weighted pull-up (reps → Epley 1RM), repeaters (kg removed), lock-off, front lever, board, campus, Tindeq peak / CF per hand |
| `questionnaires` | id | 15 items, 1–5 |
| `customExercises` | id | merged with `exercises.json` by `engine/library.ts` |
| `plans` | id | `macro` (blocks) + `weeks` (current block only) + `currentBlockIndex` |
| `planVersions` | id | full plan snapshot + date + reason + actor on every change |
| `sessions` | id | sets, sRPE, duration; cached `globalLoad`, `fingerLoad`, `restrictedGripLoad` |
| `climbs` | id | grade, style, tries/burns, angle, setting, rock, grips |
| `checkins` | `checkin-<date>` | one per day (deterministic id = no duplicates across devices) |
| `sleep` | `sleep-<date>-<source>` | manual or Garmin; Garmin preferred |
| `pain`, `injuries` | id | body-map location, moment, 0–10, red flags; episodes with protocol stage |
| `proposals` | id | `payload.key` prevents re-proposing (rejected stays rejected) |
| `weeklyReviews`, `forceCurves` | id | review summaries; downsampled Tindeq curves |

Device-only, never synced: Gist token (`localStorage['climbcoach.gistToken']`), sync / backup /
Garmin status (`climbcoach.device`), backups (separate IndexedDB `climb-coach-backups`).

## Where to change rules

| You want to change… | Edit |
|---|---|
| ACWR zones, windows, week-on-week flag (15 %), finger cap (+10 %), grip / edge factors, Tindeq thresholds, timer sounds | `src/config/thresholds.json` |
| Readiness weights & thresholds (incl. newborn), deload triggers, progression steps (+2.5 % BW, RPE ≤ 8), recovery spacing, pain thresholds, modes, macro cycle | `src/config/adaptation-rules.json` |
| Which exercises a session contains, per block and sessions/week; item priority (what the cap trims first) | `src/config/plan-templates.json` |
| Exercise rationale, references, timer pattern, finger intensity, evidence label | `src/config/exercises.json` (+ `references.json`; never invent a reference — leave `references: []` → shown as *coaching practice*) |
| Indicative grade norms | `src/config/norms.json` |
| Rehab stages | `src/config/rehab-protocols.json` |
| A rule's *logic* (not just a number) | the matching file in `src/engine/` + its test |

A config edit needs no migration. `tests/planGenerator.test.ts` checks that templates reference
existing exercises and that every reference id exists.

## How to add a migration (schema change)

1. Edit the types in `src/data/schema.ts` and set `SCHEMA_VERSION = N + 1`.
2. Append to `MIGRATIONS` in `src/data/migrations.ts`:
   ```ts
   { from: N, to: N + 1, description: 'what and why',
     up: (s) => ({ ...s, stores: { ...s.stores,
       climbs: (s.stores!.climbs ?? []).map((c) => ({ newField: 'default', ...(c as object) })) } }) }
   ```
   Migrations are pure functions on a JSON snapshot; never edit a shipped migration.
3. Add a fixture test in `tests/migrations.test.ts` (old snapshot in → expected shape out).
4. Optional fields that may simply be absent do not need a migration.

The same chain runs for the local database (with a pre-migration copy kept), for imported
files and for snapshots pulled from the Gist. Data written by a *newer* app version is refused
with a clear message (update the app first).

## Key algorithms (one line each)

- **Global load** = sRPE (0–10) × minutes (Foster 2001).
- **Finger load (FLU)** = seconds under finger load × relative intensity × grip factor × edge factor ÷ 10;
  climbing estimated from logged climbs (tries × 0.4 min / burns × 2.5 min, grade-relative intensity).
- **ACWR** = EWMA 7 d / EWMA 28 d, λ = 2/(N+1), daily series incl. rest days; seeded by the onboarding
  "typical week"; *calibrating* for 28 days. Separate global, finger and restricted-grip channels.
- **Finger cap** for a week = max(previous week, chronic × 7) × 1.10; restricted grips ≤ 25 % of it.
- **Plan**: macro blocks → week templates → loads from latest benchmarks → day scheduler
  (no back-to-back high-finger days, ≥ 2 days between max sessions) → caps trim lowest-priority items.
- **Adaptation**: missed → reschedule within week or drop; ≥ 2 of 5 triggers → early deload;
  readiness → lighter / rest / finger downgrade; pain traffic light → modify / stop / physio.
  All are proposals; `applyProposal` applies them only after a tap and logs a plan version.

## Testing

`npm test` runs: migrations, merge/repo, load & ACWR, cold start, assessment / readiness /
progression, plan generator (incl. config integrity), adaptation, timer, Tindeq protocol & analysis
(fake transport), services end-to-end, reminders, sync / Garmin / CSV / backup (fake GitHub),
and a UI smoke test rendering every page on empty and seeded data.

## Editing with an AI assistant

Give it this file plus the one engine or config file concerned. Ask it to: keep engines pure,
add or update the matching test, bump `SCHEMA_VERSION` + add a migration for any persisted shape
change, and never commit personal data or tokens.
