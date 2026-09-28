/**
 * Diced — Apps Script backend for the "Road to Feb 27" training sheet.
 *
 * Paste this whole file into the sheet's Extensions → Apps Script editor (see
 * apps-script/README.md). The contract with the phone app lives in
 * docs/SHEET_SCHEMA.md and is mirrored by mobile/src/sync/contract.ts — change
 * all three together.
 */

const DICED_CONFIG = {
  schemaVersion: 1,
  people: [
    { label: 'Her', checkinWeightCol: 'E', daily: { weight: 'D', kcal: 'E', protein: 'F', target: 'G', meals: 'H' },
      weekly: { kcal: 'Q', protein: 'R', days: 'S', maintenance: 'T' } },
    { label: 'Him', checkinWeightCol: 'K', daily: { weight: 'I', kcal: 'J', protein: 'K', target: 'L', meals: 'M' },
      weekly: { kcal: 'U', protein: 'V', days: 'W', maintenance: 'X' } },
  ],
};

const DICED_VERSION = '0.1.0';

// Calorie-target rules from Game Plan → NUTRITION TARGETS, keyed by person label.
// Each returns the Daily Log formula for sheet row `r`.
const DICED_TARGET_FORMULAS = {
  Her: function (r, person) {
    const w = "'Weekly Check-in'!$" + person.checkinWeightCol + '$5:$' + person.checkinWeightCol + '$26';
    return '=IF(Dashboard!$C$10="","",MAX(1400,ROUND(IFERROR(CHOOSEROWS(FILTER(' + w + ',' + w +
      '<>"",\'Weekly Check-in\'!$A$5:$A$26<$B' + r + '),-1),Dashboard!$C$10)*12-550,-1)))';
  },
  Him: function (r) {
    return '=IF(Dashboard!$C$24="","",ROUND(Dashboard!$C$24*15+IF($B' + r + '<=13,250,-500),-1))';
  },
};

const DICED_SHEETS = {
  weightLog: 'Weight Log',
  foodLog: 'Food Log',
  library: 'Food Library',
  dailyLog: 'Daily Log',
  checkin: 'Weekly Check-in',
  dashboard: 'Dashboard',
  gamePlan: 'Game Plan',
};

const DICED_FIRST_ROW = 5; // workbook convention: row 4 = headers, data from row 5
const DICED_PLAN_DAYS = 154; // 22 weeks × 7 days → Daily Log rows 5..158
const DICED_PLAN_WEEKS = 22; // weekly rows 5..26, same rows as Weekly Check-in
const DICED_TOKEN_KEY = 'DICED_TOKEN';
const DICED_SCHEMA_KEY = 'DICED_SCHEMA_VERSION';
const DICED_URL_KEY = 'DICED_WEBAPP_URL';
const DICED_LOCK_MS = 20000;
const DICED_MAX_BATCH = 1000;
const DICED_MAX_TEXT = 20000;

const DICED_MEAL_SLOTS = ['Breakfast', 'Lunch', 'Dinner', 'Snack'];
const DICED_WEIGHT_SOURCES = ['photo', 'capture', 'manual', 'migrated'];
const DICED_CONFIDENCES = ['high', 'medium', 'low'];
const DICED_MEAL_METHODS = ['photo', 'label', 'barcode', 'library', 'restaurant', 'manual'];

// Colours taken from 'Weekly Check-in' rows 1-4 so the new tabs match the workbook.
const DICED_STYLE = {
  ink: '#1f2a44',
  muted: '#6b7280',
  headerBg: '#f3f4f6',
  groupBg: '#1f2a44',
  today: '#fff3c4',
  people: [
    { strong: '#c2185b', light: '#fce4ec' },
    { strong: '#1565c0', light: '#e3f2fd' },
  ],
};

const DICED_DATE_FORMAT = 'ddd, mmm d';
const DICED_DATETIME_FORMAT = 'yyyy-mm-dd hh:mm';
const DICED_TODAY_RULE = '=$A5=TODAY()';

const DICED_LOG_TABS = {
  weight: {
    name: DICED_SHEETS.weightLog,
    title: 'WEIGHT LOG',
    note: 'One row per weigh-in. The Diced app writes one row per person per day (upserted by ' +
      'Entry ID). You can type rows by hand too — leave Entry ID blank.',
    columns: [
      { key: 'date', header: 'Date', width: 100, format: DICED_DATE_FORMAT },
      { key: 'person', header: 'Person', width: 70, list: 'people' },
      { key: 'weightLb', header: 'Weight (lb)', width: 85, format: '0.0' },
      { key: 'time', header: 'Time', width: 60, format: '@' },
      { key: 'source', header: 'Source', width: 80 },
      { key: 'confidence', header: 'Confidence', width: 90 },
      { key: 'notes', header: 'Notes', width: 280, format: '@' },
      { key: 'entryId', header: 'Entry ID', width: 170, format: '@' },
      { key: 'loggedAt', header: 'Logged at', width: 130, format: DICED_DATETIME_FORMAT },
    ],
  },
  meal: {
    name: DICED_SHEETS.foodLog,
    title: 'FOOD LOG',
    note: 'One row per meal. Written by the Diced app after you review it; edit freely — ' +
      'the Daily Log recalculates.',
    columns: [
      { key: 'date', header: 'Date', width: 100, format: DICED_DATE_FORMAT },
      { key: 'time', header: 'Time', width: 60, format: '@' },
      { key: 'person', header: 'Person', width: 70, list: 'people' },
      { key: 'meal', header: 'Meal', width: 90, list: DICED_MEAL_SLOTS },
      { key: 'description', header: 'Description', width: 220, format: '@' },
      { key: 'kcal', header: 'Calories', width: 80, format: '#,##0' },
      { key: 'proteinG', header: 'Protein (g)', width: 80, format: '0' },
      { key: 'carbsG', header: 'Carbs (g)', width: 75, format: '0' },
      { key: 'fatG', header: 'Fat (g)', width: 70, format: '0' },
      { key: 'confidence', header: 'Confidence', width: 90 },
      { key: 'method', header: 'Method', width: 90 },
      { key: 'items', header: 'Items', width: 360, format: '@' },
      { key: 'notes', header: 'Notes', width: 280, format: '@' },
      { key: 'entryId', header: 'Entry ID', width: 170, format: '@' },
      { key: 'loggedAt', header: 'Logged at', width: 130, format: DICED_DATETIME_FORMAT },
    ],
  },
  library: {
    name: DICED_SHEETS.library,
    title: 'FOOD LIBRARY',
    note: "Meals you eat often, with calories you've confirmed. The app matches new photos " +
      'against this list first.',
    columns: [
      { key: 'name', header: 'Name', width: 220, format: '@' },
      { key: 'serving', header: 'Serving', width: 140, format: '@' },
      { key: 'kcal', header: 'Calories', width: 80, format: '#,##0' },
      { key: 'proteinG', header: 'Protein (g)', width: 80, format: '0' },
      { key: 'carbsG', header: 'Carbs (g)', width: 75, format: '0' },
      { key: 'fatG', header: 'Fat (g)', width: 70, format: '0' },
      { key: 'aliases', header: 'Aliases (comma-separated)', width: 220, format: '@' },
      { key: 'addedBy', header: 'Added by', width: 75, list: 'people' },
      { key: 'uses', header: 'Uses', width: 55, format: '0' },
      { key: 'updatedAt', header: 'Updated at', width: 130, format: DICED_DATETIME_FORMAT },
      { key: 'entryId', header: 'Entry ID', width: 170, format: '@' },
    ],
  },
};

const DICED_DAILY_NOTE = 'One row per day, filled automatically from Weight Log and Food Log. ' +
  "Weekly Check-in weights are the average of each week's days.";

const DICED_CHECKIN_NOTE = 'Weigh in every morning (after the bathroom, before food) — the Diced ' +
  "app reads your scale photos into Weight Log, and Weight here is that week's average. Measure " +
  'waist / shoulders / chest every other week. Yellow = you fill in; everything marked auto fills itself.';

const DICED_GAMEPLAN_CHECKIN = 'Weigh in every morning and snap a photo of the scale; the Diced app ' +
  'fills Weight Log and Food Log, Daily Log totals each day, and Weekly Check-in shows each ' +
  "week's average weight. Measure waist (and his shoulders/chest) every other Monday. Enter " +
  'average daily steps for the past week.';

const DICED_GAMEPLAN_ROW_PX = 60;

const DICED_GAMEPLAN_DAILY = 'One row per day: weight, calories, protein and calorie target for ' +
  'each of you. The weekly block on the right shows average intake and "implied maintenance" — ' +
  'a check on how accurate the calorie estimates are.';

// ───────────────────────────── Menu ─────────────────────────────

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Diced')
    .addItem('Set up / repair Diced tabs', 'setupDiced')
    .addItem('Show app connection info', 'showConnectionInfo')
    .addItem('Rotate app token', 'rotateToken')
    .addToUi();
}

function showConnectionInfo() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const token = ensureToken_();
  const setUp = !!ss.getSheetByName(DICED_SHEETS.weightLog);
  const html = HtmlService.createHtmlOutput(connectionInfoHtml_(webAppUrl_(), token, setUp))
    .setWidth(500)
    .setHeight(600);
  SpreadsheetApp.getUi().showModalDialog(html, 'Connect the Diced app');
}

function rotateToken() {
  const ui = SpreadsheetApp.getUi();
  const answer = ui.alert(
    'Rotate app token?',
    'Both phones stop syncing until you reconnect them with the new link. Continue?',
    ui.ButtonSet.YES_NO
  );
  if (answer !== ui.Button.YES) return;
  PropertiesService.getScriptProperties().setProperty(DICED_TOKEN_KEY, newToken_());
  showConnectionInfo();
}

/**
 * Called from the connection dialog (google.script.run) when the user pastes the
 * /exec URL, because getUrl() can keep returning the /dev URL for versioned
 * deployments.
 */
function saveWebAppUrl(url) {
  if (!isExecUrl_(url)) throw new Error('Expected the web app URL ending in /exec');
  PropertiesService.getScriptProperties().setProperty(DICED_URL_KEY, url);
  return true;
}

function isExecUrl_(url) {
  return typeof url === 'string' && /^https:\/\/\S+\/exec$/.test(url);
}

/** The deployed /exec URL if known, else whatever getUrl() says (a /dev URL or ''). */
function webAppUrl_() {
  let url = '';
  try {
    url = ScriptApp.getService().getUrl() || '';
  } catch (err) {
    url = '';
  }
  if (isExecUrl_(url)) return url;
  return PropertiesService.getScriptProperties().getProperty(DICED_URL_KEY) || url;
}

function connectLink_(url, token) {
  return 'diced://connect?url=' + encodeURIComponent(url) + '&token=' + encodeURIComponent(token);
}

function escapeHtml_(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Only an /exec URL works for the phones: the /dev URL (which getUrl() can return
 * when run from the editor) needs an editor's Google login. The page lets the user
 * paste the right URL and rebuilds the link + QR code client-side, so the token
 * never leaves the dialog.
 */
function connectionInfoHtml_(url, token, setUp) {
  const deployed = isExecUrl_(url);
  const initialUrl = deployed ? url : '';
  const link = initialUrl ? connectLink_(initialUrl, token) : '';
  const warnings = [];
  if (!setUp) {
    warnings.push('The Diced tabs are not set up yet — run <b>Diced → Set up / repair Diced tabs</b> first.');
  }
  if (!url) {
    warnings.push('The web app is not deployed yet. In the Apps Script editor choose <b>Deploy → New ' +
      'deployment → Web app</b> (Execute as: Me, Who has access: Anyone), then paste its URL below.');
  } else if (!deployed) {
    warnings.push('This is the test URL (ending in /dev), which phones cannot use. Copy the Web app URL ' +
      'ending in <b>/exec</b> from <b>Deploy → Manage deployments</b> and paste it below.');
  }
  const data = JSON.stringify({ token: token, saved: initialUrl }).replace(/</g, '\\u003c');
  return [
    '<!doctype html><html><head><base target="_blank">',
    '<style>',
    'body{font:13px/1.45 Arial,sans-serif;color:#1f2a44;margin:0 4px}',
    'label{display:block;font-weight:bold;margin:12px 0 4px}',
    'input{width:100%;box-sizing:border-box;padding:6px;font:12px monospace;border:1px solid #cbd5e1;border-radius:4px}',
    '.warn{background:#fff8e1;border:1px solid #f5d77a;padding:8px;border-radius:4px;margin:8px 0}',
    '#qr{margin:12px auto;width:220px;min-height:20px}',
    'a#link{word-break:break-all}',
    '.muted{color:#6b7280;font-size:12px}',
    '</style></head><body>',
    warnings.map(function (w) { return '<div class="warn">' + w + '</div>'; }).join(''),
    '<p>On each phone, scan the QR code with the camera (or open the link) — the Diced app fills in the ',
    'sheet address and token for you. You can also paste both into the app\'s Settings.</p>',
    '<label for="url">Web app URL</label>',
    '<input id="url" value="' + escapeHtml_(initialUrl) + '" placeholder="https://script.google.com/macros/s/…/exec">',
    '<label for="token">App token</label>',
    '<input id="token" readonly value="' + escapeHtml_(token) + '" onclick="this.select()">',
    '<label>Connect link</label>',
    '<div><a id="link" href="' + escapeHtml_(link) + '">' + escapeHtml_(link || '(paste the web app URL first)') + '</a></div>',
    '<div id="qr"></div>',
    '<p class="muted">Keep the token private: anyone with the URL and token can read and write the logs. ',
    'Use <b>Diced → Rotate app token</b> if it leaks, then reconnect both phones.</p>',
    '<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>',
    '<script>',
    'var DICED=' + data + ';',
    'function dicedRender(){',
    ' var url=document.getElementById("url").value.trim();',
    ' var a=document.getElementById("link"),qr=document.getElementById("qr");',
    ' qr.innerHTML="";',
    ' if(!/^https:\\/\\/\\S+\\/exec$/.test(url)){a.removeAttribute("href");a.textContent="(paste the web app URL ending in /exec)";return;}',
    ' var link="diced://connect?url="+encodeURIComponent(url)+"&token="+encodeURIComponent(DICED.token);',
    ' a.href=link;a.textContent=link;',
    ' if(url!==DICED.saved&&window.google&&google.script){DICED.saved=url;google.script.run.withFailureHandler(function(){}).saveWebAppUrl(url);}',
    ' try{new QRCode(qr,{text:link,width:220,height:220,correctLevel:QRCode.CorrectLevel.M});}',
    ' catch(e){qr.textContent="QR code unavailable — open the link on the phone instead.";}',
    '}',
    'document.getElementById("url").addEventListener("input",dicedRender);',
    'window.addEventListener("load",dicedRender);',
    '</script></body></html>',
  ].join('\n');
}

// ───────────────────────────── Setup ─────────────────────────────

/**
 * Creates / repairs the Diced tabs and rewires the existing ones. Idempotent:
 * running it twice leaves the workbook exactly as running it once.
 */
function setupDiced() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const lock = LockService.getScriptLock();
  lock.waitLock(DICED_LOCK_MS);
  let migrated = 0;
  try {
    const weightLog = ensureLogTab_(ss, DICED_LOG_TABS.weight);
    ensureLogTab_(ss, DICED_LOG_TABS.meal);
    ensureLogTab_(ss, DICED_LOG_TABS.library);
    ensureDailyLog_(ss);
    // Migration must read the typed weights before the formulas replace them.
    migrated = migrateCheckinWeights_(ss, weightLog);
    rewireCheckin_(ss);
    rewireDashboard_(ss);
    rewireGamePlan_(ss);
    ensureToken_();
    PropertiesService.getDocumentProperties()
      .setProperty(DICED_SCHEMA_KEY, String(DICED_CONFIG.schemaVersion));
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }
  const moved = migrated ? ' Moved ' + migrated + ' typed weight(s) into Weight Log.' : '';
  ss.toast('Diced tabs are ready.' + moved + ' Next: Diced → Show app connection info.', 'Diced', 8);
  return { migrated: migrated };
}

function ensureSheet_(ss, name, index) {
  return ss.getSheetByName(name) || ss.insertSheet(name, index);
}

function ensureRows_(sheet, lastRow) {
  const max = sheet.getMaxRows();
  if (max < lastRow) sheet.insertRowsAfter(max, lastRow - max);
}

function ensureColumns_(sheet, lastCol) {
  const max = sheet.getMaxColumns();
  if (max < lastCol) sheet.insertColumnsAfter(max, lastCol - max);
}

function writeTitle_(sheet, title, note) {
  sheet.getRange('A1').setValue(title).setFontWeight('bold').setFontSize(18).setFontColor(DICED_STYLE.ink);
  sheet.getRange('A2').setValue(note).setFontWeight('normal').setFontSize(9).setFontColor(DICED_STYLE.muted);
}

function styleHeader_(range, background) {
  range.setBackground(background)
    .setFontWeight('bold')
    .setFontSize(9)
    .setFontColor(DICED_STYLE.ink)
    .setHorizontalAlignment('center')
    .setVerticalAlignment('middle')
    .setWrap(true);
}

function styleGroup_(range, text, background) {
  range.breakApart().merge();
  range.getCell(1, 1).setValue(text);
  range.setBackground(background)
    .setFontWeight('bold')
    .setFontSize(11)
    .setFontColor('#ffffff')
    .setHorizontalAlignment('center')
    .setVerticalAlignment('middle');
}

function peopleLabels_() {
  return DICED_CONFIG.people.map(function (p) { return p.label; });
}

function listRule_(values) {
  return SpreadsheetApp.newDataValidation()
    .requireValueInList(values, true)
    .setAllowInvalid(false)
    .build();
}

function ensureLogTab_(ss, tab) {
  const sheet = ensureSheet_(ss, tab.name, ss.getNumSheets());
  const n = tab.columns.length;
  ensureColumns_(sheet, n);
  ensureRows_(sheet, DICED_FIRST_ROW);
  writeTitle_(sheet, tab.title, tab.note);
  const header = sheet.getRange(4, 1, 1, n);
  header.setValues([tab.columns.map(function (c) { return c.header; })]);
  styleHeader_(header, DICED_STYLE.headerBg);
  sheet.setRowHeight(4, 32);
  sheet.setFrozenRows(4);
  const dataRows = sheet.getMaxRows() - DICED_FIRST_ROW + 1;
  tab.columns.forEach(function (c, i) {
    sheet.setColumnWidth(i + 1, c.width);
    const column = sheet.getRange(DICED_FIRST_ROW, i + 1, dataRows, 1);
    if (c.format) column.setNumberFormat(c.format);
    if (c.list) column.setDataValidation(listRule_(c.list === 'people' ? peopleLabels_() : c.list));
  });
  return sheet;
}

// ── Daily Log ──

function lastDailyRow_() {
  return DICED_FIRST_ROW + DICED_PLAN_DAYS - 1;
}

function lastWeekRow_() {
  return DICED_FIRST_ROW + DICED_PLAN_WEEKS - 1;
}

function foodCount_(r, label) {
  return "COUNTIFS('Food Log'!$A$5:$A,$A" + r + ",'Food Log'!$C$5:$C,\"" + label + '")';
}

function foodSum_(r, label, col) {
  return "SUMIFS('Food Log'!$" + col + '$5:$' + col + ",'Food Log'!$A$5:$A,$A" + r +
    ",'Food Log'!$C$5:$C,\"" + label + '")';
}

/** Column specs for the per-day block (A..M): header, number format, width, formula for row r. */
function dailyColumns_() {
  const cols = [
    { col: 'A', header: 'Date', format: DICED_DATE_FORMAT, width: 95,
      formula: function (r) { return '=StartDate+' + (r - DICED_FIRST_ROW); } },
    { col: 'B', header: 'Week', format: '0', width: 50,
      formula: function (r) { return '=INT(($A' + r + '-StartDate)/7)+1'; } },
    { col: 'C', header: 'Day', format: '', width: 45,
      formula: function (r) { return '=TEXT($A' + r + ',"ddd")'; } },
  ];
  DICED_CONFIG.people.forEach(function (p) {
    const L = p.label;
    cols.push(
      { col: p.daily.weight, header: L + ' weight (lb)', format: '0.0', width: 80,
        formula: function (r) {
          return "=IFERROR(ROUND(AVERAGEIFS('Weight Log'!$C$5:$C,'Weight Log'!$A$5:$A,$A" + r +
            ",'Weight Log'!$B$5:$B,\"" + L + '"),1),"")';
        } },
      { col: p.daily.kcal, header: L + ' calories', format: '#,##0', width: 80,
        formula: function (r) { return '=IF(' + foodCount_(r, L) + '=0,"",' + foodSum_(r, L, 'F') + ')'; } },
      { col: p.daily.protein, header: L + ' protein (g)', format: '0', width: 80,
        formula: function (r) { return '=IF(' + foodCount_(r, L) + '=0,"",' + foodSum_(r, L, 'G') + ')'; } },
      { col: p.daily.target, header: L + ' calorie target', format: '#,##0', width: 85,
        formula: function (r) {
          const rule = DICED_TARGET_FORMULAS[L];
          return rule ? rule(r, p) : '';
        } },
      { col: p.daily.meals, header: L + ' meals logged', format: '0', width: 75,
        formula: function (r) { return '=IF(' + foodCount_(r, L) + '=0,"",' + foodCount_(r, L) + ')'; } }
    );
  });
  return cols;
}

/** Column specs for the weekly nutrition block (Q..X); row r ↔ week r-4. */
function weeklyColumns_() {
  const range = function (col) { return '$' + col + '$5:$' + col + '$' + lastDailyRow_(); };
  const weeks = range('B');
  const cols = [];
  DICED_CONFIG.people.forEach(function (p) {
    const L = p.label;
    const w = p.weekly;
    const checkin = "'Weekly Check-in'!$" + p.checkinWeightCol;
    cols.push(
      { col: w.kcal, header: L + ' avg kcal', format: '#,##0', width: 80,
        formula: function (r) {
          return '=IFERROR(ROUND(AVERAGEIFS(' + range(p.daily.kcal) + ',' + weeks + ',$P' + r + '),0),"")';
        } },
      { col: w.protein, header: L + ' avg protein (g)', format: '0', width: 85,
        formula: function (r) {
          return '=IFERROR(ROUND(AVERAGEIFS(' + range(p.daily.protein) + ',' + weeks + ',$P' + r + '),0),"")';
        } },
      { col: w.days, header: L + ' days logged', format: '0', width: 70,
        formula: function (r) {
          return '=COUNTIFS(' + weeks + ',$P' + r + ',' + range(p.daily.kcal) + ',">0")';
        } },
      { col: w.maintenance, header: L + ' implied maintenance', format: '#,##0', width: 100,
        formula: function (r) {
          const now = checkin + r;
          const prev = checkin + (r - 1);
          return '=IF(OR($P' + r + '=1,$' + w.days + r + '<4,N(' + now + ')=0,N(' + prev + ')=0),"",ROUND($' +
            w.kcal + r + '-(' + now + '-' + prev + ')*3500/7,-1))';
        } }
    );
  });
  return cols;
}

function ensureDailyLog_(ss) {
  const checkin = ss.getSheetByName(DICED_SHEETS.checkin);
  // getIndex() is 1-based, insertSheet's index 0-based: this lands right after Weekly Check-in.
  const sheet = ensureSheet_(ss, DICED_SHEETS.dailyLog, checkin ? checkin.getIndex() : ss.getNumSheets());
  const daily = dailyColumns_();
  const weekly = weeklyColumns_();
  const lastCol = dailyLogWidth_();
  const lastRow = lastDailyRow_();
  ensureColumns_(sheet, lastCol);
  ensureRows_(sheet, lastRow);
  writeTitle_(sheet, 'DAILY LOG', DICED_DAILY_NOTE);

  const rows = [];
  for (let r = DICED_FIRST_ROW; r <= lastRow; r++) rows.push(r);
  const weekRows = rows.slice(0, DICED_PLAN_WEEKS);

  styleHeader_(sheet.getRange(4, 1, 1, lastCol), DICED_STYLE.headerBg);
  writeFormulaColumns_(sheet, daily, rows);
  writeFormulaColumns_(sheet, weekly, weekRows);

  const weekCol = colIndex_('P');
  sheet.getRange(4, weekCol).setValue('Week');
  sheet.getRange(DICED_FIRST_ROW, weekCol, DICED_PLAN_WEEKS, 1)
    .setValues(weekRows.map(function (r) { return [r - DICED_FIRST_ROW + 1]; }))
    .setNumberFormat('0');
  sheet.setColumnWidth(weekCol, 50);
  sheet.setColumnWidth(colIndex_('N'), 20);
  sheet.setColumnWidth(colIndex_('O'), 20);

  DICED_CONFIG.people.forEach(function (p, i) {
    const colors = DICED_STYLE.people[i % DICED_STYLE.people.length];
    const dailyCols = objectValues_(p.daily).map(colIndex_);
    const weeklyCols = objectValues_(p.weekly).map(colIndex_);
    styleGroup_(spanRange_(sheet, 3, dailyCols), p.label.toUpperCase(), colors.strong);
    styleHeader_(spanRange_(sheet, 4, dailyCols), colors.light);
    styleHeader_(spanRange_(sheet, 4, weeklyCols), colors.light);
  });
  styleGroup_(sheet.getRange(3, weekCol, 1, lastCol - weekCol + 1), 'WEEKLY NUTRITION', DICED_STYLE.groupBg);
  sheet.setRowHeight(3, 22);
  sheet.setRowHeight(4, 32);

  sheet.setFrozenRows(4);
  sheet.setFrozenColumns(3);
  const lastDailyCol = Math.max.apply(null, daily.map(function (c) { return colIndex_(c.col); }));
  ensureTodayRule_(sheet, sheet.getRange(DICED_FIRST_ROW, 1, DICED_PLAN_DAYS, lastDailyCol));
  return sheet;
}

/** Rightmost Daily Log column used by any person (X with the default config). */
function dailyLogWidth_() {
  return Math.max.apply(null, dailyColumns_().concat(weeklyColumns_()).map(function (c) { return colIndex_(c.col); }));
}

function writeFormulaColumns_(sheet, columns, rows) {
  columns.forEach(function (c) {
    const col = colIndex_(c.col);
    sheet.getRange(4, col).setValue(c.header);
    const range = sheet.getRange(rows[0], col, rows.length, 1)
      .setFormulas(rows.map(function (r) { return [c.formula(r)]; }));
    if (c.format) range.setNumberFormat(c.format);
    sheet.setColumnWidth(col, c.width);
  });
}

function spanRange_(sheet, row, cols) {
  const first = Math.min.apply(null, cols);
  const last = Math.max.apply(null, cols);
  return sheet.getRange(row, first, 1, last - first + 1);
}

function ensureTodayRule_(sheet, range) {
  const rules = sheet.getConditionalFormatRules().filter(function (rule) {
    const cond = rule.getBooleanCondition();
    return !(cond && cond.getCriteriaValues()[0] === DICED_TODAY_RULE);
  });
  rules.push(SpreadsheetApp.newConditionalFormatRule()
    .whenFormulaSatisfied(DICED_TODAY_RULE)
    .setBackground(DICED_STYLE.today)
    .setRanges([range])
    .build());
  sheet.setConditionalFormatRules(rules);
}

// ── Existing tabs ──

/** Copies weights typed into Weekly Check-in (values, not formulas) into Weight Log, once. */
function migrateCheckinWeights_(ss, weightLog) {
  const checkin = ss.getSheetByName(DICED_SHEETS.checkin);
  if (!checkin) return 0;
  const tz = ss.getSpreadsheetTimeZone();
  const weeks = checkin.getRange(DICED_FIRST_ROW, 1, DICED_PLAN_WEEKS, 2).getValues();
  const loggedAt = new Date();
  const records = [];
  DICED_CONFIG.people.forEach(function (p) {
    const range = checkin.getRange(DICED_FIRST_ROW, colIndex_(p.checkinWeightCol), DICED_PLAN_WEEKS, 1);
    const values = range.getValues();
    const formulas = range.getFormulas();
    values.forEach(function (row, i) {
      const typed = formulas[i][0] === '' && row[0] !== '' && row[0] !== null;
      const lb = typed ? Number(row[0]) : NaN;
      if (!isFinite(lb) || lb < 50 || lb > 700) return;
      const monday = weekMonday_(ss, weeks[i][1], weeks[i][0]);
      if (!monday) return;
      const ymd = Utilities.formatDate(monday, tz, 'yyyy-MM-dd');
      records.push({
        date: Utilities.parseDate(ymd, tz, 'yyyy-MM-dd'),
        person: p.label,
        weightLb: lb,
        time: '',
        source: 'migrated',
        confidence: 'high',
        notes: 'Typed in Weekly Check-in before Diced was set up',
        entryId: 'w:' + p.label + ':' + ymd,
        loggedAt: loggedAt,
      });
    });
  });
  return insertMissing_(weightLog, DICED_LOG_TABS.weight, records);
}

function weekMonday_(ss, value, week) {
  if (isDate_(value)) return value;
  const start = namedValue_(ss, 'StartDate');
  if (!isDate_(start) || !(Number(week) >= 1)) return null;
  const tz = ss.getSpreadsheetTimeZone();
  const ymd = addDaysYmd_(Utilities.formatDate(start, tz, 'yyyy-MM-dd'), 7 * (Number(week) - 1));
  return Utilities.parseDate(ymd, tz, 'yyyy-MM-dd');
}

function checkinWeightFormula_(person, r) {
  const d = person.daily.weight;
  return "=IFERROR(ROUND(AVERAGEIFS('Daily Log'!$" + d + '$5:$' + d + '$' + lastDailyRow_() +
    ",'Daily Log'!$B$5:$B$" + lastDailyRow_() + ',$A' + r + '),1),"")';
}

function rewireCheckin_(ss) {
  const sheet = ss.getSheetByName(DICED_SHEETS.checkin);
  if (!sheet) return;
  sheet.getRange('A2').setValue(DICED_CHECKIN_NOTE);
  DICED_CONFIG.people.forEach(function (p) {
    const col = colIndex_(p.checkinWeightCol);
    const range = sheet.getRange(DICED_FIRST_ROW, col, DICED_PLAN_WEEKS, 1);
    const formulas = [];
    for (let r = DICED_FIRST_ROW; r <= lastWeekRow_(); r++) formulas.push([checkinWeightFormula_(p, r)]);
    range.setFormulas(formulas);
    // The target-weight column just left of the weight column is the neighbouring auto column.
    range.setBackground(sheet.getRange(DICED_FIRST_ROW, col - 1).getBackground());
    sheet.getRange(4, col).setValue('Avg weight (lb) auto');
  });
}

/** Excel's "last non-empty" LOOKUP only works in Sheets inside ARRAYFORMULA. */
function wrapLookupFormula_(formula) {
  if (!/LOOKUP\(\s*2\s*,\s*1\s*\/\s*\(/i.test(formula)) return formula;
  if (/^=\s*ARRAYFORMULA\s*\(/i.test(formula)) return formula;
  return '=ARRAYFORMULA(' + formula.replace(/^=\s*/, '') + ')';
}

/** Rewrites Excel-style internal links ("#'Sheet'!B…") to Sheets' "#gid=<id>&range=B…". */
function rewriteInternalLinks_(ss, formula) {
  return formula.replace(/"#(?:'((?:[^']|'')+)'|([A-Za-z0-9_.]+))!(\$?[A-Z]{1,3}\$?\d*)"/g,
    function (match, quoted, bare, ref) {
      const sheet = ss.getSheetByName(quoted ? quoted.replace(/''/g, "'") : bare);
      if (!sheet) return match;
      return '"#gid=' + sheet.getSheetId() + '&range=' + ref.replace(/\$/g, '') + '"';
    });
}

function rewireDashboard_(ss) {
  const sheet = ss.getSheetByName(DICED_SHEETS.dashboard);
  if (!sheet) return;
  // getDataRange always starts at A1, so grid indexes map straight to rows/columns.
  const formulas = sheet.getDataRange().getFormulas();
  formulas.forEach(function (row, i) {
    row.forEach(function (formula, j) {
      if (!formula) return;
      const next = rewriteInternalLinks_(ss, wrapLookupFormula_(formula));
      if (next !== formula) sheet.getRange(i + 1, j + 1).setFormula(next);
    });
  });
}

function rewireGamePlan_(ss) {
  const sheet = ss.getSheetByName(DICED_SHEETS.gamePlan);
  if (!sheet || sheet.getLastRow() < 1) return;
  const values = sheet.getRange(1, 2, sheet.getLastRow(), 2).getValues();
  const header = values.findIndex(function (row) {
    return /^HOW TO USE/i.test(String(row[0]).trim());
  });
  if (header < 0) return;
  let last = header;
  let hasDaily = false;
  for (let i = header + 1; i < values.length && String(values[i][0]).trim() !== ''; i++) {
    last = i;
    const label = String(values[i][0]).trim();
    if (label === DICED_SHEETS.checkin) {
      sheet.getRange(i + 1, 3).setValue(DICED_GAMEPLAN_CHECKIN);
      ensureRowHeight_(sheet, i + 1, DICED_GAMEPLAN_ROW_PX);
    }
    if (label === DICED_SHEETS.dailyLog) hasDaily = true;
  }
  if (hasDaily || last === header) return;
  const lastRow = last + 1;
  const target = lastRow + 1;
  const width = sheet.getMaxColumns();
  const next = target <= sheet.getMaxRows() ? sheet.getRange(target, 1, 1, width).getValues()[0] : [];
  if (next.some(function (v) { return v !== '' && v !== null; })) sheet.insertRowAfter(lastRow);
  ensureRows_(sheet, target);
  // Whole-row copy so the C:F merge and fonts of the row above come along.
  sheet.getRange(lastRow, 1, 1, width)
    .copyTo(sheet.getRange(target, 1, 1, width), SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false);
  sheet.setRowHeight(target, sheet.getRowHeight(lastRow));
  ensureRowHeight_(sheet, target, DICED_GAMEPLAN_ROW_PX);
  sheet.getRange(target, 2).setValue(DICED_SHEETS.dailyLog);
  sheet.getRange(target, 3).setValue(DICED_GAMEPLAN_DAILY);
}

/** Rows with explicit heights don't grow with wrapped text, so make room for ~3 lines. */
function ensureRowHeight_(sheet, row, px) {
  if (sheet.getRowHeight(row) < px) sheet.setRowHeight(row, px);
}

// ── Token ──

function newToken_() {
  return Utilities.getUuid().replace(/-/g, '').slice(0, 32);
}

function ensureToken_() {
  const props = PropertiesService.getScriptProperties();
  let token = props.getProperty(DICED_TOKEN_KEY);
  if (!token) {
    token = newToken_();
    props.setProperty(DICED_TOKEN_KEY, token);
  }
  return token;
}

/** Constant-time comparison: runtime depends only on the expected token's length. */
function tokensMatch_(given, expected) {
  if (typeof given !== 'string' || typeof expected !== 'string' || expected === '') return false;
  let diff = given.length ^ expected.length;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ (i < given.length ? given.charCodeAt(i) : 0);
  }
  return diff === 0;
}

// ───────────────────────────── Web app ─────────────────────────────

function doGet() {
  return json_({ ok: true, data: { service: 'diced', version: DICED_VERSION } });
}

const DICED_ACTIONS = {
  ping: actionPing_,
  upsertWeights: actionUpsertWeights_,
  upsertMeals: actionUpsertMeals_,
  deleteEntries: actionDeleteEntries_,
  getSummary: actionGetSummary_,
  listLibrary: actionListLibrary_,
  upsertLibrary: actionUpsertLibrary_,
};

function doPost(e) {
  try {
    const body = parseBody_(e);
    const expected = PropertiesService.getScriptProperties().getProperty(DICED_TOKEN_KEY);
    if (!tokensMatch_(body.token, expected || '')) {
      return json_({ ok: false, error: { code: 'unauthorized', message: 'Invalid or missing token' } });
    }
    const action = body.action;
    if (typeof action !== 'string' || !Object.prototype.hasOwnProperty.call(DICED_ACTIONS, action)) {
      throw invalid_('Unknown action: ' + String(action));
    }
    const payload = body.payload === undefined || body.payload === null ? {} : body.payload;
    if (typeof payload !== 'object' || Array.isArray(payload)) {
      throw invalid_('payload must be an object');
    }
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const ctx = { ss: ss, tz: ss.getSpreadsheetTimeZone() };
    return json_({ ok: true, data: DICED_ACTIONS[action](ctx, payload) });
  } catch (err) {
    const code = err && err.dicedCode ? err.dicedCode : 'internal';
    const message = err && err.message ? err.message : String(err);
    return json_({ ok: false, error: { code: code, message: message } });
  }
}

function parseBody_(e) {
  const raw = e && e.postData ? e.postData.contents : '';
  let body;
  try {
    body = JSON.parse(raw);
  } catch (err) {
    throw invalid_('Request body must be JSON');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw invalid_('Request body must be a JSON object');
  }
  return body;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function dicedError_(code, message) {
  const err = new Error(message);
  err.dicedCode = code;
  return err;
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(DICED_LOCK_MS);
  } catch (err) {
    throw dicedError_('internal', 'The sheet is busy — try again in a moment');
  }
  try {
    const result = fn();
    SpreadsheetApp.flush();
    return result;
  } finally {
    lock.releaseLock();
  }
}

function requireSheet_(ss, name) {
  const sheet = ss.getSheetByName(name);
  if (!sheet) {
    throw dicedError_('not_found', 'Tab "' + name + '" is missing — run Diced → Set up / repair Diced tabs');
  }
  return sheet;
}

// ── Actions ──

function actionPing_(ctx) {
  const tz = ctx.tz;
  const installed = Number(PropertiesService.getDocumentProperties().getProperty(DICED_SCHEMA_KEY) || 0);
  return {
    version: DICED_VERSION,
    schemaVersion: installed,
    spreadsheetName: ctx.ss.getName(),
    timezone: tz,
    people: peopleLabels_(),
    startDate: ymdOrEmpty_(namedValue_(ctx.ss, 'StartDate'), tz),
    eventDate: ymdOrEmpty_(namedValue_(ctx.ss, 'EventDate'), tz),
  };
}

function actionUpsertWeights_(ctx, payload) {
  const records = validateList_(payload.entries, 'entries', function (item) {
    const raw = requireObject_(item);
    return {
      entryId: requireText_(raw, 'entryId', 200),
      date: requireDate_(raw, 'date', ctx.tz),
      time: optionalTime_(raw, 'time'),
      person: requirePerson_(raw, 'person'),
      weightLb: requireNumber_(raw, 'weightLb', 50, 700),
      source: requireEnum_(raw, 'source', DICED_WEIGHT_SOURCES),
      confidence: requireEnum_(raw, 'confidence', DICED_CONFIDENCES),
      notes: optionalText_(raw, 'notes'),
    };
  });
  return upsertInto_(ctx, DICED_LOG_TABS.weight, records, true);
}

function actionUpsertMeals_(ctx, payload) {
  const records = validateList_(payload.entries, 'entries', function (item) {
    const raw = requireObject_(item);
    return {
      entryId: requireText_(raw, 'entryId', 200),
      date: requireDate_(raw, 'date', ctx.tz),
      time: optionalTime_(raw, 'time'),
      person: requirePerson_(raw, 'person'),
      meal: requireEnum_(raw, 'meal', DICED_MEAL_SLOTS),
      description: optionalText_(raw, 'description'),
      kcal: requireNumber_(raw, 'kcal', 0, 10000),
      proteinG: requireNumber_(raw, 'proteinG', 0, 2000),
      carbsG: requireNumber_(raw, 'carbsG', 0, 2000),
      fatG: requireNumber_(raw, 'fatG', 0, 2000),
      confidence: requireEnum_(raw, 'confidence', DICED_CONFIDENCES),
      method: requireEnum_(raw, 'method', DICED_MEAL_METHODS),
      items: optionalText_(raw, 'items'),
      notes: optionalText_(raw, 'notes'),
    };
  });
  return upsertInto_(ctx, DICED_LOG_TABS.meal, records, true);
}

function actionUpsertLibrary_(ctx, payload) {
  const records = validateList_(payload.items, 'items', function (item) {
    const raw = requireObject_(item);
    return {
      entryId: requireText_(raw, 'entryId', 200),
      name: requireText_(raw, 'name', 500),
      serving: optionalText_(raw, 'serving'),
      kcal: requireNumber_(raw, 'kcal', 0, 10000),
      proteinG: requireNumber_(raw, 'proteinG', 0, 2000),
      carbsG: requireNumber_(raw, 'carbsG', 0, 2000),
      fatG: requireNumber_(raw, 'fatG', 0, 2000),
      aliases: requireAliases_(raw, 'aliases'),
      // Hand-typed library rows may leave Added by blank; the phones send that blank back.
      addedBy: optionalPerson_(raw, 'addedBy'),
      uses: requireInteger_(raw, 'uses', 0, 1000000),
      updatedAt: optionalTimestamp_(raw, 'updatedAt'),
    };
  });
  return upsertInto_(ctx, DICED_LOG_TABS.library, records, false);
}

const DICED_DELETE_KINDS = { weight: 'weight', meal: 'meal', library: 'library' };

function actionDeleteEntries_(ctx, payload) {
  const kind = payload.kind;
  if (typeof kind !== 'string' || !Object.prototype.hasOwnProperty.call(DICED_DELETE_KINDS, kind)) {
    throw invalid_('kind must be one of weight, meal, library');
  }
  const ids = validateList_(payload.entryIds, 'entryIds', function (raw) {
    if (typeof raw !== 'string' || raw.trim() === '') throw invalid_('must be a non-empty string');
    return raw.trim();
  });
  const tab = DICED_LOG_TABS[DICED_DELETE_KINDS[kind]];
  const sheet = requireSheet_(ctx.ss, tab.name);
  if (!ids.length) return { deleted: 0 };
  return withLock_(function () {
    const wanted = {};
    ids.forEach(function (id) { wanted[id] = true; });
    const rows = readIds_(sheet, tab)
      .map(function (id, i) { return wanted[id] ? DICED_FIRST_ROW + i : 0; })
      .filter(function (r) { return r > 0; });
    deleteRows_(sheet, rows);
    return { deleted: rows.length };
  });
}

function actionGetSummary_(ctx, payload) {
  const person = requirePerson_(payload, 'person');
  const from = requireYmd_(payload, 'from');
  const to = requireYmd_(payload, 'to');
  const p = DICED_CONFIG.people.filter(function (x) { return x.label === person; })[0];
  const daily = requireSheet_(ctx.ss, DICED_SHEETS.dailyLog);
  const checkin = requireSheet_(ctx.ss, DICED_SHEETS.checkin);
  const grid = daily.getRange(DICED_FIRST_ROW, 1, DICED_PLAN_DAYS, dailyLogWidth_()).getValues();
  const checkinGrid = checkin
    .getRange(DICED_FIRST_ROW, 1, DICED_PLAN_WEEKS, Math.max(colIndex_(p.checkinWeightCol), 2))
    .getValues();
  const at = function (row, col) { return row[colIndex_(col) - 1]; };

  const days = [];
  grid.forEach(function (row, i) {
    const date = ymdOrEmpty_(row[0], ctx.tz);
    if (!date || date < from || date > to) return;
    days.push({
      date: date,
      week: numberOrNull_(row[1]) || Math.floor(i / 7) + 1,
      weightLb: numberOrNull_(at(row, p.daily.weight)),
      kcal: numberOrNull_(at(row, p.daily.kcal)),
      proteinG: numberOrNull_(at(row, p.daily.protein)),
      kcalTarget: numberOrNull_(at(row, p.daily.target)),
      meals: numberOrNull_(at(row, p.daily.meals)) || 0,
    });
  });

  const weightCol = colIndex_(p.checkinWeightCol);
  const weeks = grid.slice(0, DICED_PLAN_WEEKS).map(function (row, i) {
    const c = checkinGrid[i];
    return {
      week: numberOrNull_(at(row, 'P')) || i + 1,
      monday: ymdOrEmpty_(c[1], ctx.tz) || ymdOrEmpty_(grid[i * 7][0], ctx.tz),
      avgWeightLb: numberOrNull_(c[weightCol - 1]),
      targetWeightLb: numberOrNull_(c[weightCol - 2]),
      avgKcal: numberOrNull_(at(row, p.weekly.kcal)),
      avgProteinG: numberOrNull_(at(row, p.weekly.protein)),
      daysLogged: numberOrNull_(at(row, p.weekly.days)) || 0,
      impliedMaintenance: numberOrNull_(at(row, p.weekly.maintenance)),
    };
  });

  return { person: person, days: days, weeks: weeks, currentWeek: currentWeek_(ctx) };
}

function actionListLibrary_(ctx) {
  const tab = DICED_LOG_TABS.library;
  const sheet = requireSheet_(ctx.ss, tab.name);
  let rows = readRecords_(sheet, tab);
  // Rows typed by hand have no Entry ID; give them one so the phones can update them.
  const needsId = function (r) { return hasName_(r.record) && String(r.record.entryId).trim() === ''; };
  if (rows.some(needsId)) {
    rows = withLock_(function () {
      const fresh = readRecords_(sheet, tab);
      const idCol = columnOf_(tab, 'entryId');
      fresh.filter(needsId).forEach(function (r) {
        r.record.entryId = Utilities.getUuid();
        sheet.getRange(r.row, idCol).setValue(r.record.entryId);
      });
      return fresh;
    });
  }
  const items = rows
    .filter(function (r) { return hasName_(r.record); })
    .map(function (r) { return libraryItemFromRecord_(r.record); });
  return { items: items };
}

function hasName_(record) {
  return record.name !== null && String(record.name).trim() !== '';
}

function libraryItemFromRecord_(rec) {
  return {
    entryId: String(rec.entryId).trim(),
    name: String(rec.name).trim(),
    serving: String(rec.serving),
    kcal: numberOrNull_(rec.kcal) || 0,
    proteinG: numberOrNull_(rec.proteinG) || 0,
    carbsG: numberOrNull_(rec.carbsG) || 0,
    fatG: numberOrNull_(rec.fatG) || 0,
    aliases: String(rec.aliases).split(',')
      .map(function (a) { return a.trim(); })
      .filter(function (a) { return a !== ''; }),
    addedBy: String(rec.addedBy),
    uses: numberOrNull_(rec.uses) || 0,
    updatedAt: isDate_(rec.updatedAt) ? rec.updatedAt.toISOString() : String(rec.updatedAt),
  };
}

function currentWeek_(ctx) {
  const named = namedValue_(ctx.ss, 'CurWeek');
  if (typeof named === 'number' && isFinite(named)) return named;
  const start = namedValue_(ctx.ss, 'StartDate');
  if (!isDate_(start)) return 1;
  const today = Utilities.formatDate(new Date(), ctx.tz, 'yyyy-MM-dd');
  const days = daysBetweenYmd_(Utilities.formatDate(start, ctx.tz, 'yyyy-MM-dd'), today);
  return Math.min(DICED_PLAN_WEEKS, Math.max(1, Math.floor(days / 7) + 1));
}

// ── Sheet row I/O ──

function columnOf_(tab, key) {
  return tab.columns.map(function (c) { return c.key; }).indexOf(key) + 1;
}

/** Entry IDs of rows 5..lastRow (trimmed strings, '' for blanks). */
function readIds_(sheet, tab) {
  const last = sheet.getLastRow();
  if (last < DICED_FIRST_ROW) return [];
  return sheet.getRange(DICED_FIRST_ROW, columnOf_(tab, 'entryId'), last - DICED_FIRST_ROW + 1, 1)
    .getValues()
    .map(function (row) { return String(row[0]).trim(); });
}

function readRecords_(sheet, tab) {
  const last = sheet.getLastRow();
  if (last < DICED_FIRST_ROW) return [];
  return sheet.getRange(DICED_FIRST_ROW, 1, last - DICED_FIRST_ROW + 1, tab.columns.length)
    .getValues()
    .map(function (values, i) {
      const record = {};
      tab.columns.forEach(function (c, j) { record[c.key] = values[j]; });
      return { row: DICED_FIRST_ROW + i, record: record };
    });
}

function lastRowWithDate_(sheet) {
  const last = sheet.getLastRow();
  if (last < DICED_FIRST_ROW) return DICED_FIRST_ROW - 1;
  const col = sheet.getRange(DICED_FIRST_ROW, 1, last - DICED_FIRST_ROW + 1, 1).getValues();
  for (let i = col.length - 1; i >= 0; i--) {
    if (col[i][0] !== '' && col[i][0] !== null) return DICED_FIRST_ROW + i;
  }
  return DICED_FIRST_ROW - 1;
}

function toRow_(tab, record) {
  return tab.columns.map(function (c) {
    const v = record[c.key];
    if (c.key === 'aliases' && Array.isArray(v)) return safeText_(v.join(', '));
    return typeof v === 'string' ? safeText_(v) : v;
  });
}

/** A leading "=" would make Sheets store a formula; the apostrophe forces plain text. */
function safeText_(s) {
  return /^=/.test(s) ? "'" + s : s;
}

function upsertInto_(ctx, tab, records, stampLoggedAt) {
  const sheet = requireSheet_(ctx.ss, tab.name);
  if (!records.length) return { inserted: 0, updated: 0 };
  return withLock_(function () {
    const now = new Date();
    if (stampLoggedAt) records.forEach(function (r) { r.loggedAt = now; });
    return upsertRows_(sheet, tab, records);
  });
}

/**
 * Overwrites rows whose Entry ID matches in place; appends the rest after the last
 * row with data in column A (or with an Entry ID, so such a row is never clobbered).
 * Duplicate IDs within one batch collapse into one row holding the last values.
 */
function upsertRows_(sheet, tab, records) {
  const has = function (obj, key) { return Object.prototype.hasOwnProperty.call(obj, key); };
  const width = tab.columns.length;
  const existing = {};
  let lastUsed = lastRowWithDate_(sheet);
  readIds_(sheet, tab).forEach(function (id, i) {
    if (id === '') return;
    if (!has(existing, id)) existing[id] = DICED_FIRST_ROW + i;
    lastUsed = Math.max(lastUsed, DICED_FIRST_ROW + i);
  });
  const pending = {};
  const appends = [];
  let inserted = 0;
  let updated = 0;
  records.forEach(function (record) {
    const values = toRow_(tab, record);
    const id = record.entryId;
    if (has(existing, id)) {
      sheet.getRange(existing[id], 1, 1, width).setValues([values]);
      updated++;
    } else if (has(pending, id)) {
      appends[pending[id]] = values;
      updated++;
    } else {
      pending[id] = appends.length;
      appends.push(values);
      inserted++;
    }
  });
  if (appends.length) {
    ensureRows_(sheet, lastUsed + appends.length);
    sheet.getRange(lastUsed + 1, 1, appends.length, width).setValues(appends);
  }
  return { inserted: inserted, updated: updated };
}

/** Appends only records whose Entry ID is not in the sheet yet; returns how many. */
function insertMissing_(sheet, tab, records) {
  const existing = {};
  readIds_(sheet, tab).forEach(function (id) { existing[id] = true; });
  const fresh = records.filter(function (r) { return !existing[r.entryId]; });
  if (fresh.length) upsertRows_(sheet, tab, fresh);
  return fresh.length;
}

/** Deletes the given 1-based rows, bottom-up in contiguous runs so indexes stay valid. */
function deleteRows_(sheet, rows) {
  if (!rows.length) return;
  const sorted = rows.slice().sort(function (a, b) { return b - a; });
  // Sheets refuses to delete every non-frozen row, so keep one spare row around.
  const frozen = sheet.getFrozenRows();
  if (sheet.getMaxRows() - sorted.length <= frozen) sheet.insertRowsAfter(sheet.getMaxRows(), 1);
  let runEnd = sorted[0];
  let runStart = sorted[0];
  for (let i = 1; i <= sorted.length; i++) {
    const r = sorted[i];
    if (r === runStart - 1) {
      runStart = r;
      continue;
    }
    sheet.deleteRows(runStart, runEnd - runStart + 1);
    runEnd = r;
    runStart = r;
  }
}

// ── Validation ──
// Field checks throw bad_request errors; validateList_ prefixes the failing row's index.

function invalid_(message) {
  return dicedError_('bad_request', message);
}

function validateList_(list, name, validateOne) {
  if (!Array.isArray(list)) throw invalid_('payload.' + name + ' must be an array');
  if (list.length > DICED_MAX_BATCH) {
    throw invalid_('payload.' + name + ' has more than ' + DICED_MAX_BATCH + ' rows');
  }
  return list.map(function (raw, i) {
    try {
      return validateOne(raw);
    } catch (err) {
      if (!err || err.dicedCode !== 'bad_request') throw err;
      throw invalid_(name + '[' + i + ']: ' + err.message);
    }
  });
}

function requireObject_(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalid_('must be an object');
  return raw;
}

function requireText_(obj, key, max) {
  const v = obj[key];
  if (typeof v !== 'string' || v.trim() === '') throw invalid_(key + ' must be a non-empty string');
  if (v.length > max) throw invalid_(key + ' is longer than ' + max + ' characters');
  return v.trim();
}

function optionalText_(obj, key) {
  const v = obj[key];
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') throw invalid_(key + ' must be a string');
  if (v.length > DICED_MAX_TEXT) throw invalid_(key + ' is longer than ' + DICED_MAX_TEXT + ' characters');
  return v;
}

function requireEnum_(obj, key, allowed) {
  const v = obj[key];
  if (allowed.indexOf(v) < 0) throw invalid_(key + ' must be one of ' + allowed.join(', '));
  return v;
}

function requirePerson_(obj, key) {
  const v = obj[key];
  const labels = peopleLabels_();
  if (labels.indexOf(v) < 0) {
    throw invalid_('unknown ' + key + ' "' + String(v) + '" (expected ' + labels.join(' or ') + ')');
  }
  return v;
}

/** A person label, or '' (blank / missing) — never an unknown name. */
function optionalPerson_(obj, key) {
  const v = obj[key];
  if (v === undefined || v === null || v === '') return '';
  return requirePerson_(obj, key);
}

function requireNumber_(obj, key, min, max) {
  const v = obj[key];
  if (typeof v !== 'number' || !isFinite(v) || v < min || v > max) {
    throw invalid_(key + ' must be a number between ' + min + ' and ' + max);
  }
  return v;
}

function requireInteger_(obj, key, min, max) {
  const v = requireNumber_(obj, key, min, max);
  if (Math.floor(v) !== v) throw invalid_(key + ' must be a whole number');
  return v;
}

function requireAliases_(obj, key) {
  const v = obj[key];
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.some(function (a) { return typeof a !== 'string'; })) {
    throw invalid_(key + ' must be an array of strings');
  }
  // The sheet stores aliases comma-separated, so a comma inside one alias would split it.
  return v.map(function (a) { return a.replace(/,/g, ' ').trim(); }).filter(function (a) { return a !== ''; });
}

function optionalTime_(obj, key) {
  const v = obj[key];
  if (v === undefined || v === null || v === '') return '';
  if (typeof v !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) throw invalid_(key + ' must be HH:mm or empty');
  return v;
}

function optionalTimestamp_(obj, key) {
  const v = obj[key];
  if (v === undefined || v === null || v === '') return new Date();
  const d = typeof v === 'string' ? new Date(v) : null;
  if (!d || isNaN(d.getTime())) throw invalid_(key + ' must be an ISO timestamp');
  return d;
}

/** `YYYY-MM-DD` string that is a real calendar date. */
function requireYmd_(obj, key) {
  const v = obj[key];
  if (typeof v !== 'string' || !isValidYmd_(v)) throw invalid_(key + ' must be a date YYYY-MM-DD');
  return v;
}

/** Parses in the spreadsheet's time zone so the cell shows the same calendar day. */
function requireDate_(obj, key, tz) {
  const d = Utilities.parseDate(requireYmd_(obj, key), tz, 'yyyy-MM-dd');
  if (!isDate_(d)) throw invalid_(key + ' must be a date YYYY-MM-DD');
  return d;
}

// ── Small pure helpers ──

function isValidYmd_(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (y < 1900 || y > 2200) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

function addDaysYmd_(ymd, days) {
  const p = ymd.split('-').map(Number);
  return new Date(Date.UTC(p[0], p[1] - 1, p[2] + days)).toISOString().slice(0, 10);
}

function daysBetweenYmd_(a, b) {
  const pa = a.split('-').map(Number);
  const pb = b.split('-').map(Number);
  return Math.round((Date.UTC(pb[0], pb[1] - 1, pb[2]) - Date.UTC(pa[0], pa[1] - 1, pa[2])) / 86400000);
}

// Dates may come from another realm (tests) so instanceof is not reliable.
function isDate_(v) {
  return Object.prototype.toString.call(v) === '[object Date]' && !isNaN(v.getTime());
}

function ymdOrEmpty_(v, tz) {
  return isDate_(v) ? Utilities.formatDate(v, tz, 'yyyy-MM-dd') : '';
}

/** Computed cell value → number, or null for "", errors (#DIV/0! …) and text. */
function numberOrNull_(v) {
  return typeof v === 'number' && isFinite(v) ? v : null;
}

function namedValue_(ss, name) {
  const range = ss.getRangeByName(name);
  return range ? range.getValue() : null;
}

function objectValues_(obj) {
  return Object.keys(obj).map(function (k) { return obj[k]; });
}

function colIndex_(letters) {
  let n = 0;
  for (let i = 0; i < letters.length; i++) n = n * 26 + (letters.charCodeAt(i) - 64);
  return n;
}
