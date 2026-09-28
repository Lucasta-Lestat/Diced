# Google Sheet schema & Apps Script API contract

This document is the single source of truth shared by the Apps Script backend
(`apps-script/Code.gs`) and the mobile app (`mobile/src/sync/*`). If you change
anything here, change both sides.

The target spreadsheet is the Google Sheets conversion of
`Road_to_Feb27_Training_Plan.xlsx` (tabs: Dashboard, Game Plan, Weekly Check-in,
His Workouts, Her Workouts, Exercise Library, Chart Data). `setupDiced()` in the
Apps Script adds the tabs below and rewires the existing ones. It must be
**idempotent**: running it twice leaves the workbook identical to running it once.

Named ranges already in the workbook: `StartDate` (`'Game Plan'!C5`, Mon Sep 28 2026),
`EventDate` (`'Game Plan'!C6`), `CurWeek` (`Dashboard!C5`).

## People

The workbook tracks two people with the labels **`Her`** and **`Him`** (these are
the values used in every `Person` column). They are configured in one constant at
the top of `Code.gs` so the workbook can be generalized later:

```js
const DICED_CONFIG = {
  schemaVersion: 1,
  people: [
    { label: 'Her', checkinWeightCol: 'E', daily: { weight: 'D', kcal: 'E', protein: 'F', target: 'G', meals: 'H' },
      weekly: { kcal: 'Q', protein: 'R', days: 'S', maintenance: 'T' } },
    { label: 'Him', checkinWeightCol: 'K', daily: { weight: 'I', kcal: 'J', protein: 'K', target: 'L', meals: 'M' },
      weekly: { kcal: 'U', protein: 'V', days: 'W', maintenance: 'X' } },
  ],
};
```

## Conventions (match the existing workbook)

* Row 1 = tab title (bold, large), row 2 = one-line note, row 3 = group headers
  (optional), **row 4 = column headers, data starts at row 5**.
* Dates are real date values (not text), formatted `ddd, mmm d` in log tabs.
* Weight in lb with 1 decimal (`0.0`), calories `#,##0`, grams `0`.
* Everything derived is a formula. The app only ever writes to the raw log tabs
  (`Weight Log`, `Food Log`, `Food Library`).

## Verified Google Sheets formula behavior (tested 2026-09-28)

| Pattern | Result in Sheets |
|---|---|
| `=IFERROR(LOOKUP(2,1/(R<>""),R),"")` (Excel "last non-empty") | **Broken** – implicit intersection returns the same-row value or `""` |
| `=ARRAYFORMULA(IFERROR(LOOKUP(2,1/(R<>""),R),""))` | Works (last non-empty) |
| `=IFERROR(CHOOSEROWS(FILTER(R,R<>""),-1),"")` | Works |
| `=MATCH(TRUE(),INDEX(R<>"",0),0)` | Works (first non-empty) |
| `AVERAGEIFS` / `SUMIFS` over cells that hold formula `""` | `""` cells are ignored; no match → `#DIV/0!` (wrap in `IFERROR`) |
| `COUNTIF(R,"<>")` | Counts formula-`""` cells as non-empty – **do not use** |
| `COUNTIFS(R,"")` | Counts formula-`""` cells as empty |
| `FILTER` with several conditions | Works |

## New tab: `Weight Log` (raw; written by the app, humans may add rows)

| Col | Header | Type / notes |
|---|---|---|
| A | Date | date |
| B | Person | `Her` / `Him` (data validation list from config) |
| C | Weight (lb) | number `0.0` |
| D | Time | text `HH:mm` (local time of the photo) or blank |
| E | Source | `photo` / `capture` / `manual` / `migrated` |
| F | Confidence | `high` / `medium` / `low` |
| G | Notes | text |
| H | Entry ID | text, unique. App uses `w:<person>:<YYYY-MM-DD>` (one official reading per person per day) |
| I | Logged at | datetime of last write |

Title row 1: `WEIGHT LOG`. Note row 2: `One row per weigh-in. The Diced app writes one
row per person per day (upserted by Entry ID). You can type rows by hand too — leave
Entry ID blank.`

## New tab: `Food Log` (raw)

| Col | Header | Type / notes |
|---|---|---|
| A | Date | date |
| B | Time | text `HH:mm` |
| C | Person | `Her` / `Him` |
| D | Meal | `Breakfast` / `Lunch` / `Dinner` / `Snack` |
| E | Description | short title, e.g. `Chicken burrito bowl` |
| F | Calories | number |
| G | Protein (g) | number |
| H | Carbs (g) | number |
| I | Fat (g) | number |
| J | Confidence | `high` / `medium` / `low` |
| K | Method | `photo` / `label` / `barcode` / `library` / `restaurant` / `manual` |
| L | Items | text: `chicken breast 150 g (248 kcal) · white rice 180 g (234 kcal) · …` |
| M | Notes | text (user notes + key assumptions) |
| N | Entry ID | text, unique (uuid from the app) |
| O | Logged at | datetime |

Title `FOOD LOG`; note: `One row per meal. Written by the Diced app after you review
it; edit freely — the Daily Log recalculates.`

## New tab: `Food Library` (shared "usual meals", synced to both phones)

| Col | Header |
|---|---|
| A | Name |
| B | Serving |
| C | Calories |
| D | Protein (g) |
| E | Carbs (g) |
| F | Fat (g) |
| G | Aliases (comma-separated) |
| H | Added by (`Her`/`Him`) |
| I | Uses |
| J | Updated at |
| K | Entry ID |

Title `FOOD LIBRARY`; note: `Meals you eat often, with calories you've confirmed.
The app matches new photos against this list first.`

## New tab: `Daily Log` (formulas only; one row per day)

Title `DAILY LOG`; note: `One row per day, filled automatically from Weight Log and
Food Log. Weekly Check-in weights are the average of each week's days.`

Row 3 group headers: `D3:H3` merged = `HER`, `I3:M3` merged = `HIM`,
`P3:X3` merged = `WEEKLY NUTRITION`.

Rows 5..158 = days 0..153 of the plan (22 weeks × 7 days, Mon Sep 28 2026 →
Sun Feb 28 2027). Row `r` holds day `n = r - 5`.

| Col | Header | Row-5 formula (fill down to row 158) |
|---|---|---|
| A | Date | `=StartDate+0` (row r: `=StartDate+(r-5)`) — write the literal offset per row |
| B | Week | `=INT(($A5-StartDate)/7)+1` |
| C | Day | `=TEXT($A5,"ddd")` |
| D | Her weight (lb) | `=IFERROR(ROUND(AVERAGEIFS('Weight Log'!$C$5:$C,'Weight Log'!$A$5:$A,$A5,'Weight Log'!$B$5:$B,"Her"),1),"")` |
| E | Her calories | `=IF(COUNTIFS('Food Log'!$A$5:$A,$A5,'Food Log'!$C$5:$C,"Her")=0,"",SUMIFS('Food Log'!$F$5:$F,'Food Log'!$A$5:$A,$A5,'Food Log'!$C$5:$C,"Her"))` |
| F | Her protein (g) | same as E but summing `'Food Log'!$G$5:$G` |
| G | Her calorie target | `=IF(Dashboard!$C$10="","",MAX(1400,ROUND(IFERROR(CHOOSEROWS(FILTER('Weekly Check-in'!$E$5:$E$26,'Weekly Check-in'!$E$5:$E$26<>"",'Weekly Check-in'!$A$5:$A$26<$B5),-1),Dashboard!$C$10)*12-550,-1)))` |
| H | Her meals logged | `=IF(COUNTIFS('Food Log'!$A$5:$A,$A5,'Food Log'!$C$5:$C,"Her")=0,"",COUNTIFS('Food Log'!$A$5:$A,$A5,'Food Log'!$C$5:$C,"Her"))` |
| I | Him weight (lb) | like D with `"Him"` |
| J | Him calories | like E with `"Him"` |
| K | Him protein (g) | like F with `"Him"` |
| L | Him calorie target | `=IF(Dashboard!$C$24="","",ROUND(Dashboard!$C$24*15+IF($B5<=13,250,-500),-1))` |
| M | Him meals logged | like H with `"Him"` |
| N | *(blank spacer)* | |
| O | *(blank spacer)* | |

The her/him calorie-target formulas reproduce the workbook's own rules
(Game Plan → NUTRITION TARGETS): her `max(1400, weight×12 − 550)` using her most
recent weekly average *before* that week (falls back to her start weight); him
`start weight × 15 + 250` during Build (weeks 1–13) and `− 500` during the Cut.

**Weekly nutrition block** (rows 5..26 = weeks 1..22; row `r` ↔ week `r-4`, the
same row as that week in `Weekly Check-in`):

| Col | Header | Row-5 formula |
|---|---|---|
| P | Week | literal `1..22` |
| Q | Her avg kcal | `=IFERROR(ROUND(AVERAGEIFS($E$5:$E$158,$B$5:$B$158,$P5),0),"")` |
| R | Her avg protein (g) | `=IFERROR(ROUND(AVERAGEIFS($F$5:$F$158,$B$5:$B$158,$P5),0),"")` |
| S | Her days logged | `=COUNTIFS($B$5:$B$158,$P5,$E$5:$E$158,">0")` |
| T | Her implied maintenance | `=IF(OR($P5=1,$S5<4,N('Weekly Check-in'!$E5)=0,N('Weekly Check-in'!$E4)=0),"",ROUND($Q5-('Weekly Check-in'!$E5-'Weekly Check-in'!$E4)*3500/7,-1))` |
| U..X | Him … | same with `J`, `K`, `W`, `'Weekly Check-in'!$K` |

"Implied maintenance" = average intake minus the calories implied by the change in
weekly average weight (3,500 kcal per lb). If it sits well above the plan's assumed
maintenance, calorie estimates are probably running low (or the reverse) — this is
the calibration check for photo-based calorie estimates.

Formatting: freeze 4 rows and 3 columns; header styling copied from
`Weekly Check-in!A3:T4`; conditional format highlights the row where `$A5=TODAY()`;
number formats as in Conventions.

## Changes to existing tabs

### Weekly Check-in
* `E5:E26` (her weight) become
  `=IFERROR(ROUND(AVERAGEIFS('Daily Log'!$D$5:$D$158,'Daily Log'!$B$5:$B$158,$A5),1),"")`
* `K5:K26` (his weight) become the same with `'Daily Log'!$I$5:$I$158`.
* Headers `E4`, `K4` → `Avg weight (lb) auto` (other auto columns end in ` auto`).
* Background of `E5:E26` / `K5:K26` → the background used by the neighbouring auto
  column (`D5` / `J5`); do **not** touch conditional-format rules.
* Note `A2` → `Weigh in every morning (after the bathroom, before food) — the Diced
  app reads your scale photos into Weight Log, and Weight here is that week's
  average. Measure waist / shoulders / chest every other week. Yellow = you fill in;
  everything marked auto fills itself.`
* **Migration (once):** every week row whose `E` or `K` held a typed number (not a
  formula) before setup is copied into `Weight Log` as
  `Date = that week's Monday ('Weekly Check-in'!B)`, `Source = migrated`,
  `Entry ID = w:<person>:<YYYY-MM-DD>`, *before* the formulas replace it. (Today
  `E5 = 185` for Her.) Skip if a Weight Log row with that Entry ID already exists.

### Dashboard
* Every formula containing `LOOKUP(2,1/(` that is not already wrapped gets wrapped:
  `=X` → `=ARRAYFORMULA(X)` (fixes the blank **NOW** column; 12 cells: `F10:F13`,
  `F24:F31`).
* `H5`/`H6`: internal links use Excel syntax (`"#'His Workouts'!B"&…`), which Sheets
  can't follow. Rewrite to `"#gid=<sheetId>&range=B"&…` using the real sheet ids,
  keeping the `MATCH(...)` part and the link text.

### Game Plan
* In the HOW TO USE THIS WORKBOOK section, the row whose column B is
  `Weekly Check-in` → column C text: `Weigh in every morning and snap a photo of the
  scale; the Diced app fills Weight Log and Food Log, Daily Log totals each day, and
  Weekly Check-in shows each week's average weight. Measure waist (and his
  shoulders/chest) every other Monday. Enter average daily steps for the past week.`
* Append one row after the last HOW TO USE row: B = `Daily Log`, C = `One row per day:
  weight, calories, protein and calorie target for each of you. The weekly block on
  the right shows average intake and "implied maintenance" — a check on how accurate
  the calorie estimates are.` (copy formatting from the row above). Skip if a row
  with B = `Daily Log` exists.

## Apps Script web-app API

Deployed as a web app (*Execute as: Me*, *Who has access: Anyone*). Every request is
a `POST` with `Content-Type: text/plain;charset=utf-8` (avoids a CORS preflight)
and a JSON body:

```json
{ "token": "<shared secret>", "action": "<name>", "payload": { } }
```

Responses are always HTTP 200 JSON:

```json
{ "ok": true, "data": { } }
{ "ok": false, "error": { "code": "unauthorized|bad_request|not_found|internal", "message": "..." } }
```

The token is a random 32-char string generated by `setupDiced()` and stored in
Script Properties (`DICED_TOKEN`). Compare in constant time. All writes run under
`LockService.getScriptLock()` (wait up to 20 s) because both phones may sync at once.

`doGet` returns `{ ok: true, data: { service: "diced", version } }` without auth
(health check only — no data).

### Actions

| action | payload | data |
|---|---|---|
| `ping` | `{}` | `{ version, schemaVersion, spreadsheetName, timezone, people: string[], startDate: "YYYY-MM-DD", eventDate: "YYYY-MM-DD" }` |
| `upsertWeights` | `{ entries: SheetWeightRow[] }` | `{ inserted: number, updated: number }` |
| `upsertMeals` | `{ entries: SheetMealRow[] }` | `{ inserted: number, updated: number }` |
| `deleteEntries` | `{ kind: "weight" \| "meal" \| "library", entryIds: string[] }` | `{ deleted: number }` |
| `getSummary` | `{ person: string, from: "YYYY-MM-DD", to: "YYYY-MM-DD" }` | `SheetSummary` |
| `listLibrary` | `{}` | `{ items: SheetLibraryItem[] }` |
| `upsertLibrary` | `{ items: SheetLibraryItem[] }` | `{ inserted: number, updated: number }` |

Types (TypeScript source of truth: `mobile/src/sync/contract.ts`):

```ts
interface SheetWeightRow { entryId: string; date: string; time: string; person: string;
  weightLb: number; source: 'photo'|'capture'|'manual'|'migrated';
  confidence: 'high'|'medium'|'low'; notes: string }
interface SheetMealRow { entryId: string; date: string; time: string; person: string;
  meal: 'Breakfast'|'Lunch'|'Dinner'|'Snack'; description: string; kcal: number;
  proteinG: number; carbsG: number; fatG: number; confidence: 'high'|'medium'|'low';
  method: 'photo'|'label'|'barcode'|'library'|'restaurant'|'manual'; items: string; notes: string }
interface SheetLibraryItem { entryId: string; name: string; serving: string; kcal: number;
  proteinG: number; carbsG: number; fatG: number; aliases: string[]; addedBy: string;
  uses: number; updatedAt: string /* ISO */ }
interface SheetSummary {
  person: string;
  days: { date: string; week: number; weightLb: number|null; kcal: number|null;
          proteinG: number|null; kcalTarget: number|null; meals: number }[];
  weeks: { week: number; monday: string; avgWeightLb: number|null; targetWeightLb: number|null;
           avgKcal: number|null; avgProteinG: number|null; daysLogged: number;
           impliedMaintenance: number|null }[];
  currentWeek: number;
}
```

Semantics:
* Upserts match on Entry ID; a row with the same Entry ID is overwritten in place,
  otherwise appended after the last used row. `Logged at` is set on every write.
* Dates are interpreted in the **spreadsheet's** time zone
  (`Utilities.parseDate(date, ss.getSpreadsheetTimeZone(), 'yyyy-MM-dd')`).
* Validation: unknown `person` → `bad_request`; `weightLb` must be 50–700;
  `kcal` 0–10000; dates must parse. Reject the whole request on the first invalid row
  (report its index) so a sync is all-or-nothing.
* `getSummary` reads **computed values** from `Daily Log` (`days`, filtered to
  `from..to`) and from `Weekly Check-in` (`D`/`J` target weight, `E`/`K` average) plus
  the Daily Log weekly block (`weeks`, all 22). Empty strings become `null`.
* `listLibrary` returns all rows with a non-empty Name.

## Custom menu

`onOpen` adds a **Diced** menu: `Set up / repair Diced tabs` (runs `setupDiced`),
`Show app connection info` (dialog with the web-app URL from
`ScriptApp.getService().getUrl()`, the token, and a `diced://connect?url=…&token=…`
link to open on each phone), `Rotate app token`.
