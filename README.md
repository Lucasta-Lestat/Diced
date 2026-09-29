# Diced

Diced is a prototype phone app (iOS + Android) that turns the photos already on your
phone into rows in your training-plan Google Sheet:

* **Scale photos → daily weight.** The app finds photos of the bathroom-scale display,
  reads the number, and logs one weigh-in per day. The sheet's Weekly Check-in shows
  each week's 7-day average.
* **Food photos → calories.** The app groups food photos into meals and estimates
  calories and macros with Claude. The estimates are itemised and checked against
  USDA / Open Food Facts data, and you review them before they're written to the
  Food Log.

In the default automatic mode it runs weekly on its own. On Android it uses a
background job (roughly every 12 hours, so the weekly run can come some hours after
the chosen time). On iPhone a Shortcuts automation opens the app (iOS doesn't allow
fixed-time background jobs). In manual mode nothing is scanned; you add photos or type
entries in Quick log.

| Where | What |
|---|---|
| [`docs/SETUP.md`](docs/SETUP.md) | Start here: connect the sheet, install on both phones, weekly automation |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | How it works, platform differences, calorie-accuracy strategy |
| [`docs/SHEET_SCHEMA.md`](docs/SHEET_SCHEMA.md) | New sheet tabs and formulas, plus the app ↔ sheet API |
| [`apps-script/`](apps-script) | Google Apps Script installed into the sheet (sets up tabs; receives data from the app) |
| [`mobile/`](mobile) | Expo SDK 57 app (TypeScript, expo-router) |

## Development

Node 22 LTS (or 20.19.4+, as React Native 0.86 / Metro require).

```sh
cd mobile
npm install
npx tsc --noEmit        # typecheck
npx jest                # unit tests
npx expo lint           # lint
npx expo-doctor         # dependency / config checks
npx expo run:android    # or run:ios — needs a development build (not Expo Go)

node --test ../apps-script/test   # Apps Script tests (no dependencies)
```
