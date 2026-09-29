# Diced – Google Sheets backend

`Code.gs` is a small Apps Script that lives inside your training-plan Google Sheet. It
does two things:

1. **Sets up the sheet**: it adds the tabs the Diced app writes to and rewires the
   existing tabs so weights and calories flow through automatically.
2. **Runs a private web app** that both phones talk to. Each phone sends its
   reviewed weigh-ins and meals, and reads back its daily and weekly numbers.

You only do this setup once, on a computer. Custom menus don't show up in the
Google Sheets phone app.

## One-time setup

1. **Open the Google Sheet.** If you only have `Road_to_Feb27_Training_Plan.xlsx`,
   upload it to Google Drive, open it, and choose **File → Save as Google Sheets**.
   Use that Google Sheets copy from now on.
2. **Open the script editor**: **Extensions → Apps Script**.
3. **Paste the code.** In the editor, open `Code.gs`, delete everything in it, paste
   the full contents of [`Code.gs`](Code.gs), and click **Save**.
4. **Replace the manifest.** Click **Project Settings** (the gear icon) and tick
   **Show "appsscript.json" manifest file in editor**. Go back to **Editor**, open
   `appsscript.json`, replace its contents with [`appsscript.json`](appsscript.json),
   and click **Save**. If your file had a different `"timeZone"`, you can keep yours.
   The script always uses the *spreadsheet's* time zone (File → Settings).
5. **Run the setup.** Choose `setupDiced` in the function dropdown at the top and
   click **Run**, then authorize it:
   **Review permissions → your account → Advanced → Go to … (unsafe) → Allow**.
   The warning appears because this is your own unpublished script. It asks for only
   two permissions: *this spreadsheet only* and *show menus and dialogs*.
6. **Deploy the web app.** Click **Deploy → New deployment**, click the gear next to
   *Select type*, choose **Web app**, and set:
   * **Execute as:** Me
   * **Who has access:** Anyone

   Click **Deploy** and copy the **Web app URL**. It ends in `/exec`. Work or school
   (Google Workspace) accounts sometimes don't offer *Anyone*. In that case, keep
   the sheet in a personal Google account.
7. **Reload the Google Sheet.** A **Diced** menu appears next to *Help*.
8. **Connect each phone.** Choose **Diced → Show app connection info**. If the URL
   box is empty or says it's the `/dev` test URL, paste the `/exec` URL from step 6.
   Only a `https://script.google.com/…/exec` address is accepted; the link and QR code
   appear once it is there. The sheet remembers it. Then, on **each phone**:
   * scan the QR code with the camera, or open the `diced://connect?...` link on the
     phone (for example, email it to yourself). The Diced app opens, tests the
     connection and asks whether the phone is **Her** or **Him**. If that phone is
     already connected to a different URL, the app first asks **Replace the sheet
     connection?** and names both addresses;
   * or paste the URL and the token on the app's **Connect the sheet** setup step
     (once set up: **Settings → Google Sheet → Change…**).

   The QR encoder is loaded from cdnjs, pinned with Subresource Integrity. If it
   can't load (offline, or blocked), the dialog says "QR code unavailable". Use the
   link instead.

## What setup changes in the workbook

| Where | Change |
|---|---|
| **Weight Log** (new) | One row per weigh-in. The app writes one row per person per day. You can also type rows yourself; leave *Entry ID* blank. |
| **Food Log** (new) | One row per meal, written after you review it in the app. You can edit these rows freely. |
| **Food Library** (new) | Your "usual meals" with confirmed calories, shared by both phones. |
| **Daily Log** (new, right after Weekly Check-in) | Formulas only. There's one row per day of the plan with each person's weight, calories, protein, calorie target and number of meals logged. Today's row is highlighted. On the right, the weekly block shows average intake, days logged and **implied maintenance**, which is a check on whether the photo-based calorie estimates run high or low. |
| **Weekly Check-in** | *Weight (lb)* for her (E) and him (K) becomes **that week's average of the daily weigh-ins**. Those columns are renamed *Avg weight (lb) auto* and are no longer yellow. The note at the top is updated. Any weight you had already typed there (e.g. week 1's 185) is first copied into Weight Log, dated that week's Monday, with Source = `migrated`. Only a number from 50 to 700 lb is copied, and only if Weight Log has no different weight for that Monday yet. Any other typed value (text such as `201.4 lb`, an out-of-range number, or a second weight for a Monday that is already logged) is kept as a **note on its cell**, and setup tells you how many there were. |
| **Dashboard** | The *NOW* formulas are wrapped in `ARRAYFORMULA`. In Google Sheets they were blank because the Excel "last value" trick doesn't work there. The *▶ His week / ▶ Her week* links are rewritten so Sheets can follow them. |
| **Game Plan** | The *HOW TO USE* text for Weekly Check-in now describes daily weigh-ins, and a *Daily Log* row is added. |
| Script properties | `DICED_TOKEN` (the app token) and `DICED_WEBAPP_URL` (if you pasted the URL). Document property `DICED_SCHEMA_VERSION`. |

Running setup again is safe; it gives the same result as running it once. Use
**Diced → Set up / repair Diced tabs** any time a formula gets typed over. A weight
typed into Weekly Check-in is copied into Weight Log before its formula is restored,
unless that Monday already has a Weight Log entry (the phone logs every day, Mondays
included). A typed value that isn't copied is kept as a note on its cell.

## After changing `Code.gs`

Paste the new code and click **Save**. The phones won't see it until you publish a
new version **of the same deployment**. That keeps the URL the same:

**Deploy → Manage deployments → select the web app → ✏️ Edit → Version: New version → Deploy**

Don't use *New deployment* for updates. That creates a second URL, and both phones
would need reconnecting. If the update changed the sheet layout, run
**Diced → Set up / repair Diced tabs** again.

## Rotating the token

Anyone with both the web-app URL and the token can read and write the logs. If the
token leaks, choose **Diced → Rotate app token**. The old token stops working
immediately. The dialog then shows a new link; reconnect both phones with it.

## Troubleshooting

| The app says… | Fix |
|---|---|
| `unauthorized` | The token changed or was mistyped. Reconnect using *Show app connection info*. |
| `not_found` (a tab is missing) | Run **Diced → Set up / repair Diced tabs**. |
| "The sheet is busy" | Both phones synced at once, or setup was running. Try again in a moment. |
| An HTML/sign-in page instead of JSON | The deployment isn't set to *Who has access: Anyone*. |
| "Diced only connects to a Google Apps Script web-app URL" or "This is the /dev test URL" | The phone has a URL that isn't the `https://script.google.com/…/exec` deployment URL. Reconnect using *Show app connection info*. |
| Old behaviour after a code change | You saved the code but didn't publish a **new version** (see above). |

## For developers

* The API and sheet layout are specified in [`docs/SHEET_SCHEMA.md`](../docs/SHEET_SCHEMA.md).
  `mobile/src/sync/contract.ts` mirrors it in TypeScript. Change all three together.
* `DICED_CONFIG` at the top of `Code.gs` maps each person to their columns.
* The web-app URL pattern (`DICED_EXEC_URL_RE`) is mirrored in
  `mobile/src/sync/webAppUrl.ts`; the phone refuses any other address. Change both
  together.
* Tests use Node's built-in runner with an in-memory fake of the Apps Script
  services (no npm install needed; Node 20+, 22 LTS recommended):

  ```sh
  node --test apps-script/test
  ```
