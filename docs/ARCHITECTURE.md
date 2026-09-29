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
  plugins/            local config plugins (withoutPushEntitlement.js)
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
| **Classification from small thumbnails** (`cloud_thumbnails` mode) | Works on both platforms without extra native ML libraries. Screenshots are excluded on-device first, and so are images whose file name or album shows a messaging app (WhatsApp, Signal, Telegram, Messenger, Viber, WeChat, Android "… Images" folders; `photos/heuristics.ts`, `PhotoAsset.fromMessagingAlbum`). Photos saved from iMessage, or from apps that save into no album of their own, look like camera photos and can't be excluded. Thumbnails are 384 px, re-encoded (EXIF/GPS stripped). `manual` mode sends nothing automatically. An on-device ML Kit pre-filter is a planned upgrade (see Roadmap). |
| **Local notifications only** | The weekly reminder and "ready to review" are scheduled on the phone; there is no push server. `mobile/plugins/withoutPushEntitlement.js` (first in `app.json` → `plugins`) removes the iOS `aps-environment` entitlement that the expo-notifications plugin adds, so a free Apple ID (Personal Team) can sign a local Xcode build. |
| **Only Apps Script `/exec` URLs** | The phone sends its token and entries only to `https://script.google.com/…/s/<id>/exec` (`sync/webAppUrl.ts`, the same regex as `DICED_EXEC_URL_RE` in `Code.gs`), whatever a connect link or paste says. |
| **One official weigh-in per person per day**, Entry ID `w:<person>:<date>` | Makes sheet writes idempotent; weekly average = mean of daily values (not of photos). |
| **Human review before anything reaches the sheet** | Photo-based calorie estimates are commonly 20–40 % off; review + notes + clarifying questions + saved "usual meals" are the main accuracy levers. |

## Platform behavior (why the scheduler looks the way it does)

| | Android | iOS |
|---|---|---|
| Photo access | `READ_MEDIA_IMAGES` (Android 13+); partial access (Android 14 "selected photos") is detected and shown as a warning | Full Access required; `limited` detected and shown as a warning |
| Weekly automation | `expo-background-task` (WorkManager, `minimumInterval` 12 h, a *minimum* delay, so at most about twice a day and later under Doze / App Standby); the task checks `isWeeklyRunDue` / `isDailyRunDue` and processes with an ~8 min budget, so the weekly run happens at the first wake-up after the slot. Plus "run if due" whenever the app comes to the foreground, and the weekly reminder | Background tasks are opportunistic (BGTaskScheduler decides). Primary trigger: a **Shortcuts personal automation** (weekly, "Run Immediately") that opens `diced://process-week`; fallback: weekly local notification whose tap opens the same link; plus "run if due" whenever the app comes to the foreground |
| Before onboarding / manual mode | The background task is registered only once `onboardingComplete`; before that `dueAutoRun` returns null and the task does nothing. Manual mode has no weekly reminder (`ui/reminder.ts` cancels it, and `scheduleWeeklyReminder` itself refuses) | Same; no Shortcuts automation is suggested in manual mode |
| Budget per background run | ~8 min | ~25 s (the pipeline is resumable) |

## Deep links (scheme `diced`)

| URL | Route | Behavior |
|---|---|---|
| `diced://process-week` | `src/app/process-week.tsx` | Starts (or joins) the shared UI run `startSharedRun('deeplink')` (`src/ui/autoRun.ts`) with progress and **Cancel**, then offers "Review". A link that arrives while the screen shows a result starts a new run |
| `diced://review` | `src/app/review/index.tsx` | Review queue |
| `diced://connect?url=…&token=…` | `src/app/connect.tsx` | Prefills sheet URL + token, tests with `ping` (never automatically for a non-Apps-Script host), lets the user pick Her/Him. If the phone is connected to a different URL, first asks **Replace the sheet connection?** naming both destinations; nothing is contacted before "Use this new sheet". Reachable before onboarding |

## Pipeline (src/pipeline/process.ts)

1. **Window**: `nextScanWindow(settings, now)` (since `lastScanEnd`, first run = last 8 days).
2. **Scan**: `listPhotosInRange` (plus messaging-app albums in the window, flagged `fromMessagingAlbum`) → drop photos already hand-picked under a `picked:<file name>` id (same name, ≤2 s apart; `photos/appFiles.withoutPickedDuplicates`) → `insertNewPhotos` (records with `localDate`, `excludedReason` from `exclusionReason`).
3. **Classify** (cloud mode): `listUnclassified` → thumbnails → `classifyBatch` in batches of 16, ≤2 concurrent → `setClassification`.
4. **Scale photos**: `listUnprocessed(['scale'])` → `prepareScaleImage` (up to 2576 px long edge and 3.75 MP, so the API doesn't downscale again) → `readScale` → candidates → `buildWeightEntries` (merging with existing entries for those days; morning = 04:00 to the cutoff; a reading the user picked stays picked) → `upsertWeightEntry` → `markProcessed`.
5. **Food photos**: `listUnprocessed(['food','nutrition_label'])` → `groupMealPhotos` (time gap only, `mealGroupingMinutes`, also across midnight). Automatic runs (weekly / daily / background) hold back a group whose last photo is younger than the gap, and groups near a photo whose classification failed for the first time. A group within the gap of a `needs_review` meal of the same person is added to that meal, which is re-estimated with all its photos; a leftovers-only group joins the nearest such meal up to 90 min before it (`LEFTOVERS_ATTACH_MINUTES`). Otherwise per group: `libraryCandidates`, `estimateMeal` (`prepareForModel`, 1568 px), `reconcileEstimate` → new `MealEntry` (needs_review) → `markProcessed`.
6. **Finish**: `updateSettings({lastScanEnd: window.endMs})` only if not partial; `recordRun`; `notifyReviewReady` when something new needs review and the run was automatic.

Errors on one photo are stored with `setPhotoError` and do not stop the run. The AI
calls use limited concurrency (≤3) and respect the time budget / abort signal. At most
2 full-size image decodes run at once (`photos/images.ts` `DECODE_LIMIT`). Claude request
timeouts follow the effort (120 s low, 300 s medium, 600 s high). Quick-log captures and
hand-picked photos use the same stages; a failed quick-log meal capture is not retried
by later runs (the user retakes it).

## Sync (src/sync/syncQueue.ts)

* Approve / reject / manual entries (and edits of synced entries) trigger a debounced,
  best-effort sync ~3 s after the last decision; *Sync now* runs it directly. Every
  background sync notifies Home and Review to reload (`subscribeSyncDone`).
* Each entry is checked against the sheet's bounds before sending. An out-of-range
  weigh-in or meal is marked `sync_error` with a readable message on its own instead of
  failing the batch. Marking entries synced or failed only touches rows whose
  `updated_at` is unchanged, so a reject or re-estimate made while a request was in
  flight is kept.
* A meal that may already be in the sheet (`inSheet`, or status approved / synced /
  sync_error) gets its sheet row deleted when it is rejected or merged away.
* Food Library: pull (`listLibrary`) first, then push; `uses` sent = the sheet's count +
  this phone's `pendingUses`. The push is skipped when the pull failed.
* The cached `getSummary` result is keyed by person and sheet URL.
* The sheet's Notes column gets readable text only (`check_portion:<item>` becomes
  `check portion of <item>`).

## Calorie-accuracy strategy

1. **Itemised estimates with grams** — the model lists components with gram weights;
   calories are recomputed from **USDA FoodData Central** per-100 g data where a good
   match exists, with the model's number kept for transparency. Big disagreements are
   flagged for review.
2. **Exact numbers when available** — nutrition-facts labels are read exactly
   (method `label`); legible barcodes are validated (GTIN check digit) and looked up in
   **Open Food Facts**; recognised chain restaurants/brands can use a **web search for
   published nutrition** (setting). The published figure replaces only the model item
   that matches the menu item (sides and drinks stay estimated), and the lookup is
   skipped when the user added notes or answers or the estimate mentions leftovers or
   partial eating.
3. **Multiple photos per meal** — photos within 20 min (setting) are one meal: extra
   angles help portions, and a later "after" photo lets the model subtract leftovers.
   A leftovers-only photo up to 90 min later is added to the meal still in review
   (and the model flags leftovers-only photos, `leftovers_only`, instead of logging
   them as eaten).
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
| `_layout.tsx` | Stack. On mount: `getDb()`, `configureNotifications()`, listen for notification links; `Stack.Protected` keeps everything but `onboarding` and `connect` behind `onboardingComplete`. Once onboarded: register the background task, re-arm the weekly reminder (`ui/reminder.armWeeklyReminder`, cancelled in manual mode), and on foreground run processing if the weekly/daily run is due (cloud mode + configured; skipped only while a screen holds a run, `holdScreenRun`) and sync approved entries. |
| `index.tsx` (Home) | Person + sheet status; this week's weigh-ins (from local entries + cached summary: 7-day avg vs target); today's calories vs target; buttons: *Process new photos*, *Review (N)*, *Quick log*; last run summary. Reloads on focus, on return to the foreground and after every background sync, and refetches the summary when it is over 1 h old, from an earlier week, or from another sheet URL. Offers *Allow photo access* while the permission is undetermined. |
| `review/index.tsx` | Queue grouped by day: weight cards (value, flags, candidate thumbnails) and meal cards (thumbnail, title, kcal ± range, P/C/F, confidence, questions badge). *Approve all confident*, per-card approve/reject; *Sync now*. Approve / reject / manual entries (and edits of synced entries) push to the sheet ~3 s after the last decision (`requestSync` in `src/ui/autoRun.ts`, debounced, best-effort). |
| `review/meal/[id].tsx` | Photos, items with editable grams, totals (editable), clarifying questions as chips, notes, *Re-estimate*, *Save as usual meal*, merge with previous meal, slot/time, approve/reject. Portion flags (`check_portion:<item>`) show as a *Check portion* notice and item badge, not as assumptions. A re-estimate or merge that finds the meal changed meanwhile saves nothing and reloads the meal. |
| `review/weight/[id].tsx` | Photo(s), pick candidate, edit value, notes, approve/reject. |
| `capture.tsx` | Quick log: take a photo of the scale or a meal (expo-image-picker camera) or pick from the library, or type a manual weight/meal. A meal photo within the grouping gap of a meal in review (or a leftovers-only photo up to 90 min later) is added to that meal. On Android, a system-picker pick without an `assetId` is matched to its MediaStore entry by file name / size / time (`ui/pickerMapping.matchLibraryAsset`), else stored as `picked:<file name>`. |
| `process-week.tsx` | Deep-link target; progress UI for a processing run. Holds the run (`holdScreenRun`) from its first effect so the catch-up doesn't start a second one; joins a run already in flight; Cancel reaches the shared run (`cancelSharedRun`). |
| `connect.tsx` | Deep-link target for sheet connection (see Deep links). |
| `settings.tsx` | Person, sheet URL/token (+ test, *Change…* → `/connect`), Claude key (+ test; *Save anyway* unless the key itself was rejected), USDA key (optional), schedule (weekday/time) + iOS Shortcuts instructions (automatic mode only), daily processing, classification mode (switching re-arms or cancels the weekly reminder), accuracy mode, web lookup, plate size, scale unit, meal grouping minutes, morning cutoff, model id; *Run now*, *Sync now*, recent runs. |
| `onboarding.tsx` | Steps: welcome → connect sheet (paste here, or open the diced://connect link / QR code) → pick person → Claude key → photo permission (explain full access) → notifications → privacy consent for cloud classification → schedule (+ iOS Shortcuts how-to; manual mode: no schedule or reminder; stays on the step with *Continue anyway* / *Try again* if the reminder can't be scheduled) → done. |

## Roadmap (not in the prototype)

* On-device pre-filter with ML Kit image labeling / text recognition so only likely
  food/scale photos are ever uploaded.
* Server proxy for the Claude key; per-user auth instead of a shared token.
* Generalize the sheet: people/goals from a Config tab instead of `DICED_CONFIG`.
