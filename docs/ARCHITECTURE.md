# Diced — architecture

Diced is a cross-platform (iOS + Android) Expo app that turns photos already on the
phone into rows in the couple's Google Sheet:

* **Scale photos → daily weigh-ins.** Find photos of the bathroom-scale display, read
  the number, keep one official reading per day, write it to `Weight Log`. The sheet's
  `Weekly Check-in` shows each week's 7-day average.
* **Food photos → meal calories.** Find photos of food, group them into meals,
  estimate calories/macros with Claude (itemised, database-checked), let the user
  review/correct, write to `Food Log`.

Each person runs the app on their own phone; a phone is bound to one person
(`Her` / `Him`) in Settings.

```
 phone (Expo app)                                    Google
 ┌───────────────────────────────────────────┐       ┌───────────────────────────┐
 │ scheduler (weekly/daily, deep link, BG)   │       │ Apps Script web app       │
 │   → pipeline: scan → exclude → classify   │ HTTPS │  (Code.gs, bound to sheet) │
 │     → read scale / estimate meals         │──────▶│  upsert Weight/Food Log,   │
 │     → reconcile (USDA / OFF / library)    │ JSON  │  Food Library, summary     │
 │   → SQLite (review queue)                 │◀──────│                            │
 │ review UI → approve → sync queue          │       │ Sheet: Daily Log formulas, │
 └──────────────┬────────────────────────────┘       │ Weekly Check-in averages   │
                │ images (EXIF-stripped)             └───────────────────────────┘
                ▼
        Claude API (claude-opus-5-5, fallbacks: 'default')
        USDA FoodData Central, Open Food Facts
```

## Repository layout

```
docs/                 ARCHITECTURE.md, SHEET_SCHEMA.md (+ setup / accuracy docs)
apps-script/          Code.gs (single file to paste), appsscript.json, test/ (node:test)
mobile/               Expo SDK 57 app (expo-router, TypeScript strict)
  src/types.ts        shared domain types            ← orchestrator-owned
  src/lib/            dates, ids, log                ← orchestrator-owned
  src/sync/contract.ts  Apps Script wire types       ← orchestrator-owned
  src/config/ src/db/ src/sync/                      ← data-layer builder
  src/photos/ src/scheduling/                        ← photos/scheduling builder
  src/ai/                                            ← AI builder
  src/nutrition/ src/pipeline/                       ← nutrition/pipeline builder
  src/app/ src/ui/ app.json                          ← UI builder
```

Every module's public API is already declared (stub files that throw
`not implemented`). Builders implement their own files, keep exported signatures
(additive exports are fine), and may add private helper files inside their own
folders. Pure logic lives in files with no native imports so Jest can test it.

## Key decisions

| Decision | Why |
|---|---|
| **Expo (React Native) + expo-router** | One TypeScript codebase for both phones; Expo modules cover media library, SQLite, secure storage, notifications, background tasks. Needs a development build (not Expo Go) because of background tasks / full photo access. |
| **Apps Script web app instead of Sheets API + Google Sign-In** | No Google Cloud project or OAuth consent screen (testing-mode refresh tokens expire after 7 days, which would silently break a weekly automation). Both phones POST to one URL with a shared token; the script runs as the sheet owner. Writes are serialized with `LockService`. |
| **Claude called directly from the phone** with the user's own key in SecureStore | Simplest for a two-person prototype. The key never leaves the device except to api.anthropic.com. (A proxy can be added later without changing the pipeline.) |
| **Classification from small thumbnails** (`cloud_thumbnails` mode) | Works on both platforms without extra native ML libraries. Screenshots / messaging-app images are excluded on-device first; thumbnails are 384 px, re-encoded (EXIF/GPS stripped). `manual` mode sends nothing automatically. An on-device ML Kit pre-filter is a planned upgrade (see Roadmap). |
| **One official weigh-in per person per day**, Entry ID `w:<person>:<date>` | Makes sheet writes idempotent; weekly average = mean of daily values (not of photos). |
| **Human review before anything reaches the sheet** | Photo-based calorie estimates are commonly 20–40 % off; review + notes + clarifying questions + saved "usual meals" are the main accuracy levers. |

## Platform behavior (why the scheduler looks the way it does)

| | Android | iOS |
|---|---|---|
| Photo access | `READ_MEDIA_IMAGES` (Android 13+); partial access (Android 14 "selected photos") is detected and shown as a warning | Full Access required; `limited` detected and shown as a warning |
| Weekly automation | `expo-background-task` (WorkManager) every ≥12 h; the task checks `isWeeklyRunDue` / `isDailyRunDue` and processes with an ~8 min budget | Background tasks are opportunistic (BGTaskScheduler decides). Primary trigger: a **Shortcuts personal automation** (weekly, "Run Immediately") that opens `diced://process-week`; fallback: weekly local notification whose tap opens the same link; plus "run if due" whenever the app comes to the foreground |
| Budget per background run | ~8 min | ~25 s (the pipeline is resumable) |

## Deep links (scheme `diced`)

| URL | Route | Behavior |
|---|---|---|
| `diced://process-week` | `src/app/process-week.tsx` | Starts `processPhotos({reason:'deeplink'})` with a progress UI, then offers "Review" |
| `diced://review` | `src/app/review/index.tsx` | Review queue |
| `diced://connect?url=…&token=…` | `src/app/connect.tsx` | Prefills sheet URL + token, tests with `ping`, lets the user pick Her/Him |

## Pipeline (src/pipeline/process.ts)

1. **Window**: `nextScanWindow(settings, now)` (since `lastScanEnd`, first run = last 8 days).
2. **Scan**: `listPhotosInRange` → `insertNewPhotos` (records with `localDate`, `excludedReason` from `exclusionReason`).
3. **Classify** (cloud mode): `listUnclassified` → thumbnails → `classifyBatch` in batches of 16, ≤2 concurrent → `setClassification`.
4. **Scale photos**: `listUnprocessed(['scale'])` → `prepareForModel` → `readScale` → candidates → `buildWeightEntries` (merging with existing entries for those days) → `upsertWeightEntry` → `markProcessed`.
5. **Food photos**: `listUnprocessed(['food','nutrition_label'])` → `groupMealPhotos` → per group: `libraryCandidates`, `estimateMeal`, `reconcileEstimate` → new `MealEntry` (needs_review) → `markProcessed`.
6. **Finish**: `updateSettings({lastScanEnd: window.endMs})` only if not partial; `recordRun`; `notifyReviewReady` when something new needs review and the run was automatic.

Errors on one photo are stored with `setPhotoError` and do not stop the run. The AI
calls use limited concurrency (≤3) and respect the time budget / abort signal.

## Calorie-accuracy strategy

1. **Itemised estimates with grams** — the model lists components with gram weights;
   calories are recomputed from **USDA FoodData Central** per-100 g data where a good
   match exists, with the model's number kept for transparency. Big disagreements are
   flagged for review.
2. **Exact numbers when available** — nutrition-facts labels are read exactly
   (method `label`); legible barcodes are validated (GTIN check digit) and looked up in
   **Open Food Facts**; recognised chain restaurants/brands can use a **web search for
   published nutrition** (setting).
3. **Multiple photos per meal** — photos within 20 min are one meal: extra angles help
   portions, and a later "after" photo lets the model subtract leftovers.
4. **Personal Food Library** — meals you confirm can be saved as "usual meals" (shared
   by both phones via the sheet); future photos that match reuse the confirmed numbers.
5. **Clarifying questions + notes** — the model asks ≤3 targeted questions (cooking
   oil, dressing, portion) only when the answer moves the total >10 %; answering or
   adding a note re-estimates.
6. **Scale reference** — the household's plate diameter is given to the model.
7. **Thorough mode** — two independent estimates; disagreement lowers confidence.
8. **Calibration in the sheet** — Daily Log's weekly block computes *implied
   maintenance* from logged intake and the change in weekly average weight. If it
   drifts far from the plan's assumption, the estimates are systematically off.

## UI (src/app, expo-router)

| Route | Purpose |
|---|---|
| *(entry)* `mobile/index.ts` | Custom entry: imports `src/scheduling/defineTasks.ts` (calls `defineBackgroundTask()` in the global scope — a headless background launch mounts no views, so route files never run) and then `expo-router/entry`. |
| `_layout.tsx` | Stack. On mount: `getDb()`, `configureNotifications()`, register background task, listen for notification links, redirect to `/onboarding` until `onboardingComplete`; on foreground: run processing if weekly/daily run is due (cloud mode + configured) and sync approved entries. |
| `index.tsx` (Home) | Person + sheet status; this week's weigh-ins (from local entries + cached summary: 7-day avg vs target); today's calories vs target; buttons: *Process new photos*, *Review (N)*, *Quick log*; last run summary. |
| `review/index.tsx` | Queue grouped by day: weight cards (value, flags, candidate thumbnails) and meal cards (thumbnail, title, kcal ± range, P/C/F, confidence, questions badge). *Approve all confident*, per-card approve/reject; *Sync now*. Approve / reject / manual entries (and edits of synced entries) push to the sheet ~3 s after the last decision (`requestSync` in `src/ui/autoRun.ts`, debounced, best-effort). |
| `review/meal/[id].tsx` | Photos, items with editable grams, totals (editable), clarifying questions as chips, notes, *Re-estimate*, *Save as usual meal*, merge with previous meal, slot/time, approve/reject. |
| `review/weight/[id].tsx` | Photo(s), pick candidate, edit value, notes, approve/reject. |
| `capture.tsx` | Quick log: take a photo of the scale or a meal (expo-image-picker camera) or pick from the library, or type a manual weight/meal. |
| `process-week.tsx` | Deep-link target; progress UI for a processing run. |
| `connect.tsx` | Deep-link target for sheet connection. |
| `settings.tsx` | Person, sheet URL/token (+ test), Claude key (+ test), USDA key (optional), schedule (weekday/time) + iOS Shortcuts instructions, daily processing, classification mode, accuracy mode, web lookup, plate size, scale unit, meal grouping minutes, morning cutoff, model id; *Run now*, *Sync now*, recent runs. |
| `onboarding.tsx` | Steps: welcome → connect sheet (paste or deep link) → pick person → Claude key → photo permission (explain full access) → notifications → privacy consent for cloud classification → schedule (+ iOS Shortcuts how-to) → done. |

## Roadmap (not in the prototype)

* On-device pre-filter with ML Kit image labeling / text recognition so only likely
  food/scale photos are ever uploaded.
* Server proxy for the Claude key; per-user auth instead of a shared token.
* Generalize the sheet: people/goals from a Config tab instead of `DICED_CONFIG`.
