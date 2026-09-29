# Setting up Diced

Setup has four parts. Parts 1 and 2 happen once for the couple, and parts 3 and 4
happen on each phone.

1. [Connect the Google Sheet](#1-connect-the-google-sheet) (about 10 minutes, on a computer)
2. [Get a Claude API key](#2-get-a-claude-api-key)
3. [Install the app on each phone](#3-install-the-app-on-each-phone)
4. [First run and the weekly automation](#4-first-run-and-the-weekly-automation)

---

## 1. Connect the Google Sheet

The plan already lives in Google Sheets as **Road_to_Feb27_Training_Plan**. Share it
with your partner as an editor: Share → add their email → Editor.

Then install the Diced script into that sheet. The step-by-step guide is in
[`apps-script/README.md`](../apps-script/README.md). In short:

1. Open the sheet and go to **Extensions → Apps Script**. Paste `apps-script/Code.gs`
   and the manifest `apps-script/appsscript.json`.
2. Run **`setupDiced`** once and approve the permissions. This step:
   * adds **Weight Log**, **Food Log**, **Food Library** and **Daily Log** tabs
   * switches **Weekly Check-in → Weight** to the 7-day average of daily weigh-ins.
     A weight you already typed there (a number from 50 to 700 lb) is moved into Weight
     Log first, unless that week's Monday already has a different Weight Log entry. Any
     other typed value is kept as a note on its cell, and setup tells you how many.
   * fixes the Dashboard **NOW** column, which was blank after the Excel→Sheets
     conversion (an Excel-only formula pattern)
   * fixes the "▶ His week / ▶ Her week" links so they work in Sheets
3. **Deploy → New deployment → Web app** with *Execute as: Me* and *Who has access:
   Anyone*. "Anyone" only means the URL is reachable. Every request must also carry a
   secret token, and without it nothing can be read or written.
4. Reload the sheet, then open **Diced → Show app connection info**. If the URL box is
   empty or shows the `/dev` test URL, paste the Web app URL ending in `/exec` from
   step 3 (only `https://script.google.com/…/exec` addresses are accepted). The dialog
   then shows a `diced://connect?...` link and a QR code. Scan the QR code with each
   phone's camera, or send the link to both phones, for example in an email to
   yourselves.

## 2. Get a Claude API key

Create a key at [platform.claude.com](https://platform.claude.com) (API keys) and
add a payment method. Each phone stores the key in its secure storage, and the key
is only sent to Anthropic's API.

**Rough cost** at Claude Opus 5.5 pricing ($4 / $20 per million input/output tokens):
about **$2 per person per week** with ~3 photographed meals a day and a daily
weigh-in. "Thorough" accuracy mode roughly doubles the meal part. Sorting the week's
photos adds a few cents.

Optional: a free [USDA FoodData Central API key](https://fdc.nal.usda.gov/api-key-signup)
gives more generous rate limits than the shared demo key used by default.

## 3. Install the app on each phone

Diced is an Expo (React Native) app. It needs a real build, not Expo Go, because it
uses background tasks and full photo-library access.

Prerequisites: Node 22 LTS (or Node 20.19.4 or later: React Native 0.86 and Metro
need `^20.19.4`, `^22.13.0` or `>=24.3.0`), an [Expo account](https://expo.dev/signup),
and `npm install` inside `mobile/`.

**Android** (simplest route: sideload an APK)

```sh
cd mobile
npx eas-cli@latest build -p android --profile preview
```

EAS gives you a link or QR code for the `.apk`. Open it on the phone and allow
installing from that source.

**iPhone.** Apple only lets you install on registered devices, so you need an
[Apple Developer Program](https://developer.apple.com/programs/) membership:

```sh
cd mobile
npx eas-cli@latest device:create      # register each iPhone (opens a link on the phone)
npx eas-cli@latest build -p ios --profile preview
```

Alternatively, build locally with Xcode on a Mac (`npx expo run:ios --device`). A
free Apple ID (Personal Team) also works this way, but the app expires after 7 days.
Free teams can't sign the Push Notifications capability. Diced only uses local
notifications, so `mobile/plugins/withoutPushEntitlement.js` (listed first in
`app.json` → `plugins`) removes the `aps-environment` entitlement that
expo-notifications would otherwise add. Keep it first in the list, or the entitlement
comes back.

Before building, change the placeholder identifiers `com.example.diced` in
`mobile/app.json` to something unique to you, e.g. `com.yourname.diced`.

## 4. First run and the weekly automation

Scan the QR code from **Diced → Show app connection info** with the phone's camera, or
tap the `diced://connect` link. The app opens on **Connect sheet** with the URL and
token filled in, tests the connection and asks who uses this phone (Her / Him). Or
open the app and paste the URL and token on the **Connect the sheet** setup step
(later: **Settings → Google Sheet → Change…**). The app only connects to a
`https://script.google.com/…/exec` address. If the phone is already connected to a
different sheet URL, a link first asks **Replace the sheet connection?** and names both
addresses. Nothing is contacted until you tap **Use this new sheet**.

Setup then walks through these steps (a connect link covers the first two):

1. **Connect the sheet** (web-app URL and token)
2. **Who this phone logs for** (Her / Him)
3. **Claude API key.** **Test & save** checks it. If the test fails for a reason other
   than a rejected key (offline, rate limit, model not found), **Save anyway** keeps it.
4. **Photos permission.** Choose **Allow Full Access** (iOS) or **Allow all**
   (Android). With "limited/selected photos" the app can't see new photos.
5. **Notifications**, used for the weekly reminder (automatic mode) and "ready to review"
6. **Privacy choice.**
   * *Automatic (recommended):* small, metadata-stripped thumbnails of the week's
     photos are sent to Claude to find scale and food photos. Only those photos are then
     sent at full size to read the scale or estimate the meal. Screenshots are skipped
     on the phone. Images saved from WhatsApp, Signal, Telegram, Messenger and similar
     apps are skipped when their file name or album shows it. Photos saved from
     iMessage (or apps that don't save into an album of their own) look like camera
     photos and may be sent as small thumbnails.
   * *Manual:* nothing is scanned. You pick photos yourself or use **Quick log**.
7. **Weekly run**, the processing day and time (default Monday 9:00), plus *Also check
   for new photos daily*. On iPhone this step shows the Shortcuts automation below. In
   manual mode there is no schedule and no weekly reminder. If the reminder can't be
   scheduled (usually because notifications are off), the step says so and offers
   **Continue anyway** or **Try again**.

Background processing starts only after you tap **Start using Diced**. In automatic
mode the first run then looks back 8 days.

### How the weekly run happens

* **Android:** automatic. A background job wakes up roughly every 12 hours (less often
  when Android is saving battery). It does the weekly run at its first chance after
  your chosen time, so the run may come several hours after that time. Opening the app
  (or tapping the weekly reminder) runs it right away when it's due. With *Also check
  for new photos daily* on, it also keeps up with new photos about once a day. You get
  a notification when there's something to review.
* **iPhone:** iOS doesn't let apps run on a fixed schedule, so set up a Shortcuts
  automation (one time):
  1. Open **Shortcuts → Automation → New Automation → Time of Day**.
  2. Set the time and **Weekly** on your day, then choose **Run Immediately**.
  3. Choose **New Blank Automation**, add the action **Open URLs**, and enter
     `diced://process-week`.
  4. Tap **Done**.

  At that time the app opens and processes the week. It does this even when Diced was
  left open on the *Process photos* screen showing the previous result. As a backup,
  Diced also sends a weekly notification that does the same when tapped, and it catches
  up whenever you open the app.
* **Manual mode (either phone):** nothing runs on a schedule and there is no weekly
  reminder or Shortcuts automation. Add photos or type entries in **Quick log**.

A run can be cancelled from the *Process photos* screen. The rest is picked up by the
next run.

### Each week

1. Tap the "Ready to review" notification, or open **Review**.
2. Check each day's weigh-in. The app picks the earliest morning reading (from 04:00
   until the morning cutoff, 11:00 by default) and flags readings that are far from
   your recent trend. A reading you pick yourself stays picked when more photos of that
   day arrive.
3. Check each meal. Answer the quick questions (e.g. "Cooked in oil?"), fix
   portions, add notes, and use **Re-estimate** when needed. A **Check portion** badge
   means Claude's and the USDA numbers for an item disagree a lot. *Approve all
   confident* skips those meals, so check them yourself. Tap **Save as usual meal** for
   things you eat often. Both phones then reuse those numbers.
4. **Approve.** Approved entries are sent to the sheet a few seconds later, or tap
   **Sync now**. Rows appear in Weight Log / Food Log, and the Daily Log, Weekly
   Check-in and Dashboard update themselves. Editing an entry that is already in the
   sheet updates its row, and rejecting it deletes the row. A re-estimated meal goes
   back to review, and its row is updated once you approve it again.

### Tips for better calorie estimates

* Take the photo **before** eating from a slight angle, with the whole plate in
  frame. If you don't finish, take an "after" photo too, within 90 minutes. While the
  meal is still in review the app adds that photo to it, re-estimates and subtracts
  the leftovers. Otherwise open the meal and use **Same meal? → Merge**.
* Photos taken less than 20 minutes apart are one meal, even across midnight. You can
  change this in **Settings → Accuracy → Photos this close belong to one meal**.
  Automatic runs leave a meal photographed less than that long ago for the next run,
  so its later photos aren't split into another meal. A later photo within that gap of
  a meal still in review, from a run or from **Quick log**, is added to that meal.
* Photograph the **nutrition label or barcode** of packaged food. It gets read
  exactly.
* For a recognised chain restaurant (**Settings → Accuracy → Look up restaurant
  nutrition**), the published number replaces only the matching menu item. Sides and
  drinks are still estimated. The lookup is skipped when you added notes or answers,
  or the estimate mentions leftovers or eating only part of it.
* Set your **plate size** in Settings (measure your usual dinner plate).
* Watch the **Daily Log → Weekly nutrition → Implied maintenance** column. After a
  few weeks, if it's far from what the plan assumes, the estimates are running high
  or low. Adjust portions during review accordingly.

## Troubleshooting

| Symptom | Fix |
|---|---|
| "Diced only connects to a Google Apps Script web-app URL" or "This is the /dev test URL" | Use the `https://script.google.com/…/exec` URL exactly as **Diced → Show app connection info** shows it. |
| "Sheet returned a web page instead of JSON" | The web app isn't deployed with *Who has access: Anyone*. Fix the deployment and use its `/exec` URL from **Diced → Show app connection info**. |
| "unauthorized" | The token changed (**Rotate app token**). Open the new connect link on each phone. |
| Nothing found on iPhone | Photos permission is "Limited". Go to Settings → Diced → Photos → **Full Access**. |
| Weekly run didn't happen on iPhone | Check the Shortcuts automation is on and set to **Run Immediately**, or just open the app. It runs when due. |
| Weekly run is late on Android | Android runs background work at most about every 12 hours, and later when saving battery. Open the app; it runs when due. **Settings → Weekly run** shows whether background processing is restricted. |
| No weekly reminder | Manual mode has none. In automatic mode, turn on notifications (**Settings → Notifications**); the reminder is scheduled again then. |
| Claude key rejected | Paste it again in **Settings → Claude** and tap **Test & save**. |
