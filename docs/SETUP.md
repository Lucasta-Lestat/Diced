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
     Anything you already typed there is moved into Weight Log first, so no data is lost.
   * fixes the Dashboard **NOW** column, which was blank after the Excel→Sheets
     conversion (an Excel-only formula pattern)
   * fixes the "▶ His week / ▶ Her week" links so they work in Sheets
3. **Deploy → New deployment → Web app** with *Execute as: Me* and *Who has access:
   Anyone*. "Anyone" only means the URL is reachable. Every request must also carry a
   secret token, and without it nothing can be read or written.
4. Reload the sheet, then open **Diced → Show app connection info**. It shows a
   `diced://connect?...` link. Send it to both phones, for example in a message to
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

Prerequisites: Node 20+, an [Expo account](https://expo.dev/signup), and
`npm install` inside `mobile/`.

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
free Apple ID also works this way, but the app expires after 7 days.

Before building, change the placeholder identifiers `com.example.diced` in
`mobile/app.json` to something unique to you, e.g. `com.yourname.diced`.

## 4. First run and the weekly automation

Open the `diced://connect` link on the phone, or paste the URL and token in
Settings. The onboarding then walks through:

1. **Who this phone logs for** (Her / Him)
2. **Claude API key**
3. **Photos permission.** Choose **Allow Full Access** (iOS) or **Allow all**
   (Android). With "limited/selected photos" the app can't see new photos.
4. **Notifications**, used for the weekly reminder and "ready to review"
5. **Privacy choice.**
   * *Automatic (recommended):* small, metadata-stripped thumbnails of the week's
     photos (screenshots and messaging-app images are skipped on the phone) are sent
     to Claude to find scale and food photos. Only those photos are then sent at
     full size to read the scale or estimate the meal.
   * *Manual:* nothing is scanned. You pick photos yourself or use **Quick log**.
6. **Schedule**, the weekly processing day and time (default Monday 9:00)

### How the weekly run happens

* **Android:** automatic. A background job runs at least twice a day and does the
  weekly run when it's due. With "daily processing" on, it also keeps up with new
  photos every day. You get a notification when there's something to review.
* **iPhone:** iOS doesn't let apps run on a fixed schedule, so set up a Shortcuts
  automation (one time):
  1. Open **Shortcuts → Automation → New Automation → Time of Day**.
  2. Set the time and **Weekly** on your day, then choose **Run Immediately**.
  3. Choose **New Blank Automation**, add the action **Open URLs**, and enter
     `diced://process-week`.
  4. Tap **Done**.

  At that time the app opens and processes the week. As a backup, Diced also sends a
  weekly notification that does the same when tapped, and it catches up whenever
  you open the app.

### Each week

1. Tap the notification, or open **Review**.
2. Check each day's weigh-in. The app picks the earliest morning reading, and flags
   readings that are far from your recent trend.
3. Check each meal. Answer the quick questions (e.g. "Cooked in oil?"), fix
   portions, add notes, and use **Re-estimate** when needed. Tap **Save as usual
   meal** for things you eat often. Both phones then reuse those numbers.
4. **Approve**, then **Sync**. Rows appear in Weight Log / Food Log, and the Daily
   Log, Weekly Check-in and Dashboard update themselves.

### Tips for better calorie estimates

* Take the photo **before** eating from a slight angle, with the whole plate in
  frame. If you don't finish, take an "after" photo too; the app subtracts
  leftovers.
* Photograph the **nutrition label or barcode** of packaged food. It gets read
  exactly.
* Set your **plate size** in Settings (measure your usual dinner plate).
* Watch the **Daily Log → Weekly nutrition → Implied maintenance** column. After a
  few weeks, if it's far from what the plan assumes, the estimates are running high
  or low. Adjust portions during review accordingly.

## Troubleshooting

| Symptom | Fix |
|---|---|
| "Sheet returned a web page instead of JSON" | The web app isn't deployed with *Who has access: Anyone*, or the URL is the `/dev` one. Use the `/exec` URL from **Diced → Show app connection info**. |
| "unauthorized" | The token changed (**Rotate app token**). Open the new connect link on each phone. |
| Nothing found on iPhone | Photos permission is "Limited". Go to Settings → Diced → Photos → **Full Access**. |
| Weekly run didn't happen on iPhone | Check the Shortcuts automation is on and set to **Run Immediately**, or just open the app. It runs when due. |
| Claude key rejected | Re-enter it in Settings → Claude API key → Test. |
