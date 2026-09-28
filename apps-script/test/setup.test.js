'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadCode, snapshot, formatDate } = require('./helpers/fakeGas');
const wb = require('./helpers/workbook');

function setUp(options) {
  const gas = loadCode(wb.buildWorkbook(), options);
  gas.call('setupDiced');
  return gas;
}

const sheet = (gas, name) => gas.ss.getSheetByName(name);
const formula = (gas, name, a1) => sheet(gas, name).getRange(a1).getFormula();
const value = (gas, name, a1) => sheet(gas, name).getRange(a1).getValue();
const fmt = (gas, name, a1) => sheet(gas, name).peek(...rc(a1)).fmt;

function rc(a1) {
  const m = /^([A-Z]+)(\d+)$/.exec(a1);
  let c = 0;
  for (const ch of m[1]) c = c * 26 + ch.charCodeAt(0) - 64;
  return [Number(m[2]), c];
}

test('creates the Diced tabs (Daily Log right after Weekly Check-in, logs at the end)', () => {
  const gas = setUp();
  assert.deepEqual(gas.ss.getSheets().map((s) => s.getName()), [
    'Dashboard', 'Game Plan', 'Weekly Check-in', 'Daily Log', 'His Workouts', 'Her Workouts',
    'Exercise Library', 'Chart Data', 'Weight Log', 'Food Log', 'Food Library',
  ]);
});

test('log tabs: title, note, headers, frozen rows, formats and validation', () => {
  const gas = setUp();
  const weight = sheet(gas, 'Weight Log');
  assert.equal(weight.getRange('A1').getValue(), 'WEIGHT LOG');
  assert.match(weight.getRange('A2').getValue(), /^One row per weigh-in\. The Diced app writes one/);
  assert.deepEqual(weight.getRange('A4:I4').getValues()[0], [
    'Date', 'Person', 'Weight (lb)', 'Time', 'Source', 'Confidence', 'Notes', 'Entry ID', 'Logged at',
  ]);
  assert.equal(weight.getFrozenRows(), 4);
  assert.equal(fmt(gas, 'Weight Log', 'A5').numberFormat, 'ddd, mmm d');
  assert.equal(fmt(gas, 'Weight Log', 'C900').numberFormat, '0.0');
  assert.equal(fmt(gas, 'Weight Log', 'D5').numberFormat, '@');
  assert.deepEqual(weight.getRange('B5').getDataValidation().values, ['Her', 'Him']);
  assert.equal(fmt(gas, 'Weight Log', 'A4').fontWeight, 'bold');

  const food = sheet(gas, 'Food Log');
  assert.equal(food.getRange('A1').getValue(), 'FOOD LOG');
  assert.deepEqual(food.getRange('A4:O4').getValues()[0], [
    'Date', 'Time', 'Person', 'Meal', 'Description', 'Calories', 'Protein (g)', 'Carbs (g)', 'Fat (g)',
    'Confidence', 'Method', 'Items', 'Notes', 'Entry ID', 'Logged at',
  ]);
  assert.deepEqual(food.getRange('C5').getDataValidation().values, ['Her', 'Him']);
  assert.deepEqual(food.getRange('D5').getDataValidation().values, ['Breakfast', 'Lunch', 'Dinner', 'Snack']);
  assert.equal(fmt(gas, 'Food Log', 'F5').numberFormat, '#,##0');
  assert.equal(fmt(gas, 'Food Log', 'G5').numberFormat, '0');

  const lib = sheet(gas, 'Food Library');
  assert.equal(lib.getRange('A1').getValue(), 'FOOD LIBRARY');
  assert.deepEqual(lib.getRange('A4:K4').getValues()[0], [
    'Name', 'Serving', 'Calories', 'Protein (g)', 'Carbs (g)', 'Fat (g)', 'Aliases (comma-separated)',
    'Added by', 'Uses', 'Updated at', 'Entry ID',
  ]);
  assert.deepEqual(lib.getRange('H5').getDataValidation().values, ['Her', 'Him']);
});

test('Daily Log per-day formulas match the schema exactly (rows 5 and 158)', () => {
  const gas = setUp();
  const f = (a1) => formula(gas, 'Daily Log', a1);
  assert.equal(f('A5'), '=StartDate+0');
  assert.equal(f('A6'), '=StartDate+1');
  assert.equal(f('A158'), '=StartDate+153');
  assert.equal(f('B5'), '=INT(($A5-StartDate)/7)+1');
  assert.equal(f('C5'), '=TEXT($A5,"ddd")');
  assert.equal(f('D5'),
    `=IFERROR(ROUND(AVERAGEIFS('Weight Log'!$C$5:$C,'Weight Log'!$A$5:$A,$A5,'Weight Log'!$B$5:$B,"Her"),1),"")`);
  assert.equal(f('E5'),
    `=IF(COUNTIFS('Food Log'!$A$5:$A,$A5,'Food Log'!$C$5:$C,"Her")=0,"",SUMIFS('Food Log'!$F$5:$F,'Food Log'!$A$5:$A,$A5,'Food Log'!$C$5:$C,"Her"))`);
  assert.equal(f('F5'),
    `=IF(COUNTIFS('Food Log'!$A$5:$A,$A5,'Food Log'!$C$5:$C,"Her")=0,"",SUMIFS('Food Log'!$G$5:$G,'Food Log'!$A$5:$A,$A5,'Food Log'!$C$5:$C,"Her"))`);
  assert.equal(f('G5'),
    `=IF(Dashboard!$C$10="","",MAX(1400,ROUND(IFERROR(CHOOSEROWS(FILTER('Weekly Check-in'!$E$5:$E$26,'Weekly Check-in'!$E$5:$E$26<>"",'Weekly Check-in'!$A$5:$A$26<$B5),-1),Dashboard!$C$10)*12-550,-1)))`);
  assert.equal(f('H5'),
    `=IF(COUNTIFS('Food Log'!$A$5:$A,$A5,'Food Log'!$C$5:$C,"Her")=0,"",COUNTIFS('Food Log'!$A$5:$A,$A5,'Food Log'!$C$5:$C,"Her"))`);
  assert.equal(f('I5'),
    `=IFERROR(ROUND(AVERAGEIFS('Weight Log'!$C$5:$C,'Weight Log'!$A$5:$A,$A5,'Weight Log'!$B$5:$B,"Him"),1),"")`);
  assert.equal(f('J5'),
    `=IF(COUNTIFS('Food Log'!$A$5:$A,$A5,'Food Log'!$C$5:$C,"Him")=0,"",SUMIFS('Food Log'!$F$5:$F,'Food Log'!$A$5:$A,$A5,'Food Log'!$C$5:$C,"Him"))`);
  assert.equal(f('L5'), '=IF(Dashboard!$C$24="","",ROUND(Dashboard!$C$24*15+IF($B5<=13,250,-500),-1))');
  assert.equal(f('M5'),
    `=IF(COUNTIFS('Food Log'!$A$5:$A,$A5,'Food Log'!$C$5:$C,"Him")=0,"",COUNTIFS('Food Log'!$A$5:$A,$A5,'Food Log'!$C$5:$C,"Him"))`);
  // Row 158 is day 153 (Sun Feb 28 2027); every reference follows the row.
  assert.equal(f('D158'),
    `=IFERROR(ROUND(AVERAGEIFS('Weight Log'!$C$5:$C,'Weight Log'!$A$5:$A,$A158,'Weight Log'!$B$5:$B,"Her"),1),"")`);
  assert.equal(f('G158'),
    `=IF(Dashboard!$C$10="","",MAX(1400,ROUND(IFERROR(CHOOSEROWS(FILTER('Weekly Check-in'!$E$5:$E$26,'Weekly Check-in'!$E$5:$E$26<>"",'Weekly Check-in'!$A$5:$A$26<$B158),-1),Dashboard!$C$10)*12-550,-1)))`);
  assert.equal(f('L158'), '=IF(Dashboard!$C$24="","",ROUND(Dashboard!$C$24*15+IF($B158<=13,250,-500),-1))');
  assert.equal(f('A159'), '');
  assert.equal(f('N5'), '');
});

test('Daily Log weekly block: literal weeks 1..22 and schema formulas (rows 5..26)', () => {
  const gas = setUp();
  const f = (a1) => formula(gas, 'Daily Log', a1);
  const daily = sheet(gas, 'Daily Log');
  assert.deepEqual(daily.getRange('P5:P26').getValues().map((r) => r[0]), Array.from({ length: 22 }, (_, i) => i + 1));
  assert.equal(f('P5'), '');
  assert.equal(f('Q5'), '=IFERROR(ROUND(AVERAGEIFS($E$5:$E$158,$B$5:$B$158,$P5),0),"")');
  assert.equal(f('R5'), '=IFERROR(ROUND(AVERAGEIFS($F$5:$F$158,$B$5:$B$158,$P5),0),"")');
  assert.equal(f('S5'), '=COUNTIFS($B$5:$B$158,$P5,$E$5:$E$158,">0")');
  assert.equal(f('T5'),
    `=IF(OR($P5=1,$S5<4,N('Weekly Check-in'!$E5)=0,N('Weekly Check-in'!$E4)=0),"",ROUND($Q5-('Weekly Check-in'!$E5-'Weekly Check-in'!$E4)*3500/7,-1))`);
  assert.equal(f('U5'), '=IFERROR(ROUND(AVERAGEIFS($J$5:$J$158,$B$5:$B$158,$P5),0),"")');
  assert.equal(f('W5'), '=COUNTIFS($B$5:$B$158,$P5,$J$5:$J$158,">0")');
  assert.equal(f('X26'),
    `=IF(OR($P26=1,$W26<4,N('Weekly Check-in'!$K26)=0,N('Weekly Check-in'!$K25)=0),"",ROUND($U26-('Weekly Check-in'!$K26-'Weekly Check-in'!$K25)*3500/7,-1))`);
  assert.equal(f('Q27'), '');
});

test('Daily Log headers, groups, freeze, formats and today highlight', () => {
  const gas = setUp();
  const daily = sheet(gas, 'Daily Log');
  assert.equal(daily.getRange('A1').getValue(), 'DAILY LOG');
  assert.match(daily.getRange('A2').getValue(), /^One row per day, filled automatically/);
  assert.deepEqual(daily.getRange('A4:M4').getValues()[0], [
    'Date', 'Week', 'Day', 'Her weight (lb)', 'Her calories', 'Her protein (g)', 'Her calorie target',
    'Her meals logged', 'Him weight (lb)', 'Him calories', 'Him protein (g)', 'Him calorie target',
    'Him meals logged',
  ]);
  assert.deepEqual(daily.getRange('P4:X4').getValues()[0], [
    'Week', 'Her avg kcal', 'Her avg protein (g)', 'Her days logged', 'Her implied maintenance',
    'Him avg kcal', 'Him avg protein (g)', 'Him days logged', 'Him implied maintenance',
  ]);
  assert.equal(daily.getRange('D3').getValue(), 'HER');
  assert.equal(daily.getRange('E3').getValue(), '', 'label only in the merge anchor');
  assert.equal(daily.getRange('I3').getValue(), 'HIM');
  assert.equal(daily.getRange('P3').getValue(), 'WEEKLY NUTRITION');
  assert.deepEqual(daily.merges.map((m) => daily.getRange(m.r1, m.c1, m.r2 - m.r1 + 1, m.c2 - m.c1 + 1).getA1Notation()).sort(),
    ['D3:H3', 'I3:M3', 'P3:X3']);
  assert.equal(daily.getFrozenRows(), 4);
  assert.equal(daily.getFrozenColumns(), 3);
  assert.equal(fmt(gas, 'Daily Log', 'A100').numberFormat, 'ddd, mmm d');
  assert.equal(fmt(gas, 'Daily Log', 'D5').numberFormat, '0.0');
  assert.equal(fmt(gas, 'Daily Log', 'E5').numberFormat, '#,##0');
  assert.equal(fmt(gas, 'Daily Log', 'T5').numberFormat, '#,##0');
  assert.equal(fmt(gas, 'Daily Log', 'D4').background, '#fce4ec');
  assert.equal(fmt(gas, 'Daily Log', 'K4').background, '#e3f2fd');
  const rules = daily.getConditionalFormatRules();
  assert.equal(rules.length, 1);
  assert.equal(rules[0].formula, '=$A5=TODAY()');
  assert.equal(rules[0].ranges[0].getA1Notation(), 'A5:M158');
});

test('Weekly Check-in weights become 7-day averages of the Daily Log', () => {
  const gas = setUp();
  const wci = sheet(gas, 'Weekly Check-in');
  assert.equal(formula(gas, 'Weekly Check-in', 'E5'),
    `=IFERROR(ROUND(AVERAGEIFS('Daily Log'!$D$5:$D$158,'Daily Log'!$B$5:$B$158,$A5),1),"")`);
  assert.equal(formula(gas, 'Weekly Check-in', 'K26'),
    `=IFERROR(ROUND(AVERAGEIFS('Daily Log'!$I$5:$I$158,'Daily Log'!$B$5:$B$158,$A26),1),"")`);
  assert.equal(wci.getRange('E4').getValue(), 'Avg weight (lb) auto');
  assert.equal(wci.getRange('K4').getValue(), 'Avg weight (lb) auto');
  assert.equal(wci.getRange('D4').getValue(), 'Target weight');
  assert.equal(wci.getRange('E5').getBackground(), '#ffffff');
  assert.equal(wci.getRange('K20').getBackground(), '#ffffff');
  assert.equal(wci.getRange('F5').getBackground(), '#fff8e1', 'other input columns keep their yellow');
  assert.match(wci.getRange('A2').getValue(), /^Weigh in every morning \(after the bathroom, before food\) — the Diced app/);
  const rules = wci.getConditionalFormatRules();
  assert.equal(rules.length, 2);
  assert.equal(rules[0].formula, '=$A5=CurWeek');
});

test('typed Weekly Check-in weights migrate into Weight Log once', () => {
  const gas = setUp();
  const log = sheet(gas, 'Weight Log');
  assert.equal(log.getLastRow(), 5);
  const [date, person, lb, time, source, confidence, notes, id, loggedAt] = log.getRange('A5:I5').getValues()[0];
  assert.equal(formatDate(date, wb.TZ, 'yyyy-MM-dd'), '2026-09-28');
  assert.deepEqual([person, lb, time, source, confidence, id], ['Her', 185, '', 'migrated', 'high', 'w:Her:2026-09-28']);
  assert.match(notes, /Weekly Check-in/);
  assert.equal(Object.prototype.toString.call(loggedAt), '[object Date]');
  assert.deepEqual(gas.callPlain('setupDiced'), { migrated: 0 });
  assert.equal(log.getLastRow(), 5);
});

test('re-running setup migrates a newly typed weight but never duplicates an Entry ID', () => {
  const gas = setUp();
  const wci = sheet(gas, 'Weekly Check-in');
  wci.getRange('K6').setValue(172.4); // typed over the formula: week 2, Him
  wci.getRange('E5').setValue(999); // out of range → not a weight, formula restored anyway
  const result = gas.call('setupDiced');
  assert.equal(result.migrated, 1);
  const log = sheet(gas, 'Weight Log');
  assert.equal(log.getLastRow(), 6);
  assert.deepEqual(log.getRange('B6:C6').getValues()[0], ['Him', 172.4]);
  assert.equal(log.getRange('H6').getValue(), 'w:Him:2026-10-05');
  assert.match(wci.getRange('K6').getFormula(), /^=IFERROR\(ROUND\(AVERAGEIFS\('Daily Log'!\$I/);
  assert.match(wci.getRange('E5').getFormula(), /^=IFERROR/);

  wci.getRange('K6').setValue(171); // same week again: Entry ID exists → skipped
  assert.equal(gas.call('setupDiced').migrated, 0);
  assert.equal(log.getLastRow(), 6);
});

test('Dashboard LOOKUP(2,1/(…)) formulas get wrapped in ARRAYFORMULA exactly once', () => {
  const gas = setUp();
  for (const [a1, col] of Object.entries(wb.DASHBOARD_LOOKUPS)) {
    const inner = wb.lookupFormula(col).slice(1);
    assert.equal(formula(gas, 'Dashboard', a1), `=ARRAYFORMULA(${inner})`, a1);
  }
  gas.call('setupDiced');
  assert.equal(formula(gas, 'Dashboard', 'F10'), `=ARRAYFORMULA(${wb.lookupFormula('E').slice(1)})`);
  assert.equal(formula(gas, 'Dashboard', 'F14'), `=IFERROR(AVERAGE('Weekly Check-in'!$I$5:$I$26),"")`);
  assert.match(formula(gas, 'Dashboard', 'C10'), /^=IFERROR\(INDEX/);
});

test('wrapLookupFormula_ leaves already-wrapped and unrelated formulas alone', () => {
  const gas = loadCode(wb.buildWorkbook());
  const wrap = (f) => gas.call('wrapLookupFormula_', f);
  assert.equal(wrap('=ArrayFormula(IFERROR(LOOKUP(2,1/(A1:A5<>""),A1:A5),""))'),
    '=ArrayFormula(IFERROR(LOOKUP(2,1/(A1:A5<>""),A1:A5),""))');
  assert.equal(wrap('=LOOKUP(2, 1/(A1:A5<>""), A1:A5)'), '=ARRAYFORMULA(LOOKUP(2, 1/(A1:A5<>""), A1:A5))');
  assert.equal(wrap('=VLOOKUP(2,A1:B5,2,0)'), '=VLOOKUP(2,A1:B5,2,0)');
});

test('Dashboard internal links are rewritten to #gid=…&range=…', () => {
  const gas = setUp();
  assert.equal(formula(gas, 'Dashboard', 'H5'),
    `=HYPERLINK("#gid=${wb.IDS.his}&range=B"&(MATCH(CurWeek,'His Workouts'!$A:$A,0)-2),"▶ His week")`);
  assert.equal(formula(gas, 'Dashboard', 'H6'),
    `=HYPERLINK("#gid=${wb.IDS.her}&range=B"&(MATCH(CurWeek,'Her Workouts'!$A:$A,0)-2),"▶ Her week")`);
  const rewrite = (f) => gas.call('rewriteInternalLinks_', gas.ss, f);
  assert.equal(rewrite('=HYPERLINK("#Dashboard!$B$4","Top")'), '=HYPERLINK("#gid=0&range=B4","Top")');
  assert.equal(rewrite('=HYPERLINK("#\'Nope\'!B2","x")'), '=HYPERLINK("#\'Nope\'!B2","x")');
});

test('Game Plan: Weekly Check-in text updated and a Daily Log row appended once', () => {
  const gas = setUp();
  const gp = sheet(gas, 'Game Plan');
  assert.match(gp.getRange('C50').getValue(), /^Weigh in every morning and snap a photo of the scale; the Diced app/);
  assert.equal(gp.getRange('B53').getValue(), 'Daily Log');
  assert.match(gp.getRange('C53').getValue(), /^One row per day: weight, calories, protein and calorie target/);
  assert.equal(gp.peek(53, 2).fmt.fontWeight, 'bold', 'formatting copied from the row above');
  assert.equal(gp.getRowHeight(53), 60, 'room for the longer text');
  assert.equal(gp.getRowHeight(50), 60);
  assert.equal(gp.getRowHeight(51), 30, 'other rows untouched');
  assert.ok(gp.merges.some((m) => m.r1 === 53 && m.c1 === 3 && m.c2 === 6), 'C53:F53 merged like the row above');
  gas.call('setupDiced');
  assert.equal(gp.getRange('B54').getValue(), '');
  assert.equal(gp.getLastRow(), 53);
});

test('Game Plan: a row is inserted when the row after the section is not empty', () => {
  const ss = wb.buildWorkbook();
  ss.getSheetByName('Game Plan').getRange('D53').setValue('something else');
  const gas = loadCode(ss);
  gas.call('setupDiced');
  const gp = ss.getSheetByName('Game Plan');
  assert.equal(gp.getRange('B53').getValue(), 'Daily Log');
  assert.equal(gp.getRange('D54').getValue(), 'something else');
});

test('setup stores a 32-char token and the schema version, and keeps the token', () => {
  const gas = setUp();
  const token = gas.scriptProps.getProperty('DICED_TOKEN');
  assert.match(token, /^[0-9a-f]{32}$/);
  assert.equal(gas.docProps.getProperty('DICED_SCHEMA_VERSION'), '1');
  gas.call('setupDiced');
  assert.equal(gas.scriptProps.getProperty('DICED_TOKEN'), token);
  assert.equal(gas.lock.waits, gas.lock.releases);
  assert.equal(gas.ss.toasts.length, 2);
});

test('setup is idempotent: running twice leaves the workbook identical to running once', () => {
  const gas = setUp();
  const once = snapshot(gas.ss);
  const props = [gas.scriptProps.getProperties(), gas.docProps.getProperties()];
  gas.call('setupDiced');
  assert.deepEqual(snapshot(gas.ss), once);
  assert.deepEqual([gas.scriptProps.getProperties(), gas.docProps.getProperties()], props);
});

test('setup tolerates a workbook without the plan tabs', () => {
  const ss = wb.buildWorkbook();
  ss.sheets = ss.sheets.filter((s) => !['Game Plan', 'Dashboard'].includes(s.getName()));
  const gas = loadCode(ss);
  assert.deepEqual(gas.callPlain('setupDiced'), { migrated: 1 });
  assert.ok(ss.getSheetByName('Daily Log'));
});

test('onOpen adds the Diced menu', () => {
  const gas = loadCode(wb.buildWorkbook());
  gas.call('onOpen');
  assert.deepEqual(JSON.parse(JSON.stringify(gas.ui.menus)), [{
    name: 'Diced',
    items: [
      { caption: 'Set up / repair Diced tabs', fn: 'setupDiced' },
      { caption: 'Show app connection info', fn: 'showConnectionInfo' },
      { caption: 'Rotate app token', fn: 'rotateToken' },
    ],
  }]);
});

test('connection info shows the /exec URL, token and an encoded diced://connect link', () => {
  const url = 'https://script.google.com/macros/s/AKfy_abc-123/exec';
  const gas = setUp({ webAppUrl: url });
  gas.call('showConnectionInfo');
  const token = gas.scriptProps.getProperty('DICED_TOKEN');
  const { html, title } = gas.ui.dialogs[0];
  assert.equal(title, 'Connect the Diced app');
  const link = `diced://connect?url=${encodeURIComponent(url)}&token=${token}`;
  assert.ok(html.includes(`href="${link.replace(/&/g, '&amp;')}"`), 'tappable link');
  assert.ok(html.includes(`value="${url}"`));
  assert.ok(html.includes(`value="${token}"`));
  assert.ok(!html.includes('not deployed'));
  assert.ok(!html.includes('not set up yet'));
});

test('connection info explains what to do before the web app is deployed', () => {
  const gas = loadCode(wb.buildWorkbook(), { webAppUrl: null });
  gas.call('showConnectionInfo');
  const { html } = gas.ui.dialogs[0];
  assert.match(html, /web app is not deployed yet/);
  assert.match(html, /not set up yet/);
  assert.match(html, /paste the web app URL first/);

  const dev = loadCode(wb.buildWorkbook(), { webAppUrl: 'https://script.google.com/macros/s/abc/dev' });
  dev.call('showConnectionInfo');
  assert.match(dev.ui.dialogs[0].html, /ending in \/dev/);
  assert.ok(!dev.ui.dialogs[0].html.includes('value="https://script.google.com/macros/s/abc/dev"'));
});

test('a pasted /exec URL is remembered when getUrl() only knows the /dev URL', () => {
  const exec = 'https://script.google.com/a/macros/example.com/s/AKfy123/exec';
  const gas = setUp({ webAppUrl: 'https://script.google.com/macros/s/head/dev' });
  assert.throws(() => gas.call('saveWebAppUrl', 'https://script.google.com/macros/s/head/dev'), /ending in \/exec/);
  assert.throws(() => gas.call('saveWebAppUrl', 'javascript:alert(1)//exec'), /ending in \/exec/);
  assert.equal(gas.call('saveWebAppUrl', exec), true);
  assert.equal(gas.scriptProps.getProperty('DICED_WEBAPP_URL'), exec);
  gas.call('showConnectionInfo');
  const { html } = gas.ui.dialogs.at(-1);
  assert.ok(html.includes(`value="${exec}"`));
  assert.ok(!html.includes('ending in /dev), which'));

  gas.env.webAppUrl = 'https://script.google.com/macros/s/newer/exec'; // a real /exec from getUrl wins
  gas.call('showConnectionInfo');
  assert.ok(gas.ui.dialogs.at(-1).html.includes('value="https://script.google.com/macros/s/newer/exec"'));
});

test('the dialog script is valid JavaScript with the token JSON-embedded', () => {
  const gas = setUp({ webAppUrl: null });
  gas.call('showConnectionInfo');
  const scripts = [...gas.ui.dialogs[0].html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.equal(scripts.length, 1);
  assert.doesNotThrow(() => new Function(scripts[0]));
  assert.ok(scripts[0].includes(JSON.stringify(gas.scriptProps.getProperty('DICED_TOKEN'))));
});

test('rotating the token asks first, then replaces it and shows the new link', () => {
  const gas = setUp({ webAppUrl: 'https://script.google.com/macros/s/x/exec' });
  const before = gas.scriptProps.getProperty('DICED_TOKEN');
  gas.ui.alertAnswer = 'NO';
  gas.call('rotateToken');
  assert.equal(gas.scriptProps.getProperty('DICED_TOKEN'), before);
  gas.ui.alertAnswer = 'YES';
  gas.call('rotateToken');
  const after = gas.scriptProps.getProperty('DICED_TOKEN');
  assert.notEqual(after, before);
  assert.match(after, /^[0-9a-f]{32}$/);
  assert.ok(gas.ui.dialogs.at(-1).html.includes(after));
});
