'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadCode, formatDate } = require('./helpers/fakeGas');
const wb = require('./helpers/workbook');

/** Workbook after setupDiced, plus an authenticated API caller. */
function connected() {
  const gas = loadCode(wb.buildWorkbook());
  gas.call('setupDiced');
  const token = gas.scriptProps.getProperty('DICED_TOKEN');
  const api = (action, payload) => gas.post({ token, action, payload });
  return { gas, token, api, sheet: (name) => gas.ss.getSheetByName(name) };
}

const weight = (over = {}) => ({
  entryId: 'w:Her:2026-09-29', date: '2026-09-29', time: '07:12', person: 'Her', weightLb: 184.6,
  source: 'photo', confidence: 'high', notes: '', ...over,
});

const meal = (over = {}) => ({
  entryId: 'm-1', date: '2026-09-29', time: '12:30', person: 'Him', meal: 'Lunch',
  description: 'Chicken burrito bowl', kcal: 820, proteinG: 52, carbsG: 85, fatG: 28,
  confidence: 'medium', method: 'photo',
  items: 'chicken breast 150 g (248 kcal) · white rice 180 g (234 kcal)', notes: 'extra salsa', ...over,
});

const libraryItem = (over = {}) => ({
  entryId: 'lib-1', name: 'Overnight oats', serving: '1 jar', kcal: 420, proteinG: 24, carbsG: 55, fatG: 11,
  aliases: ['oats', 'breakfast jar'], addedBy: 'Her', uses: 3, updatedAt: '2026-09-28T13:45:00.000Z', ...over,
});

const ymd = (d) => formatDate(d, wb.TZ, 'yyyy-MM-dd');

test('doGet is an unauthenticated JSON health check', () => {
  const gas = loadCode(wb.buildWorkbook());
  const out = gas.call('doGet', {});
  assert.equal(out.getMimeType(), 'JSON');
  assert.deepEqual(JSON.parse(out.getContent()), { ok: true, data: { service: 'diced', version: '0.1.0' } });
});

test('doPost rejects a wrong, missing or not-yet-generated token', () => {
  const { gas, token, sheet } = connected();
  const unauthorized = { ok: false, error: { code: 'unauthorized', message: 'Invalid or missing token' } };
  assert.deepEqual(gas.post({ token: token.slice(0, -1) + 'x', action: 'ping', payload: {} }), unauthorized);
  assert.deepEqual(gas.post({ token: token + 'extra', action: 'ping', payload: {} }), unauthorized);
  assert.deepEqual(gas.post({ action: 'upsertWeights', payload: { entries: [weight()] } }), unauthorized);
  assert.equal(sheet('Weight Log').getLastRow(), 5, 'nothing written');

  const fresh = loadCode(wb.buildWorkbook());
  assert.deepEqual(fresh.post({ token: '', action: 'ping', payload: {} }), unauthorized);
});

test('tokensMatch_ compares whole strings', () => {
  const gas = loadCode(wb.buildWorkbook());
  const eq = (a, b) => gas.call('tokensMatch_', a, b);
  assert.equal(eq('abc', 'abc'), true);
  assert.equal(eq('abd', 'abc'), false);
  assert.equal(eq('ab', 'abc'), false);
  assert.equal(eq('abcd', 'abc'), false);
  assert.equal(eq('', ''), false);
  assert.equal(eq(undefined, 'abc'), false);
  assert.equal(eq(123, '123'), false);
});

test('doPost reports malformed requests as bad_request', () => {
  const { gas, token, api } = connected();
  assert.equal(gas.post('not json').error.code, 'bad_request');
  assert.equal(gas.post('[1,2]').error.code, 'bad_request');
  assert.equal(gas.call('doPost', {}).getMimeType(), 'JSON');
  assert.equal(api('dropTables', {}).error.code, 'bad_request');
  assert.equal(api('constructor', {}).error.code, 'bad_request');
  assert.equal(gas.post({ token, action: 'upsertWeights', payload: [] }).error.code, 'bad_request');
  assert.equal(api('upsertWeights', {}).error.message, 'payload.entries must be an array');
});

test('ping describes the sheet', () => {
  const { api } = connected();
  assert.deepEqual(api('ping', {}), {
    ok: true,
    data: {
      version: '0.1.0', schemaVersion: 1, spreadsheetName: 'Road to Feb 27 Training Plan',
      timezone: 'America/New_York', people: ['Her', 'Him'], startDate: '2026-09-28', eventDate: '2027-02-27',
    },
  });
});

test('validation rejects the whole batch and reports the first bad row', () => {
  const { api, sheet, gas } = connected();
  const waits = gas.lock.waits;
  const bad = (entries) => api('upsertWeights', { entries });

  let res = bad([weight(), weight({ entryId: 'w:Her:2026-09-30', weightLb: 20 })]);
  assert.deepEqual(res, {
    ok: false, error: { code: 'bad_request', message: 'entries[1]: weightLb must be a number between 50 and 700' },
  });
  res = bad([weight({ person: 'Them' })]);
  assert.equal(res.error.code, 'bad_request');
  assert.match(res.error.message, /^entries\[0\]: unknown person "Them"/);
  assert.match(bad([weight({ date: '2026-02-30' })]).error.message, /^entries\[0\]: date must be a date/);
  assert.match(bad([weight({ date: '09/29/2026' })]).error.message, /date/);
  assert.match(bad([weight({ time: '7:5' })]).error.message, /time must be HH:mm/);
  assert.match(bad([weight({ weightLb: '184' })]).error.message, /weightLb/);
  assert.match(bad([weight({ source: 'guess' })]).error.message, /source must be one of/);
  assert.match(bad([weight({ entryId: '' })]).error.message, /entryId/);
  assert.match(bad([null]).error.message, /^entries\[0\]: must be an object/);

  const meals = (entries) => api('upsertMeals', { entries });
  assert.match(meals([meal(), meal(), meal({ kcal: 10001 })]).error.message, /^entries\[2\]: kcal must be a number between 0 and 10000/);
  assert.match(meals([meal({ meal: 'Brunch' })]).error.message, /meal must be one of/);
  assert.match(meals([meal({ method: 'vibes' })]).error.message, /method must be one of/);
  assert.match(meals([meal({ proteinG: -1 })]).error.message, /proteinG/);

  assert.equal(sheet('Weight Log').getLastRow(), 5, 'only the migrated row');
  assert.equal(sheet('Food Log').getLastRow(), 4);
  assert.equal(gas.lock.waits, waits, 'invalid requests never take the lock');
});

test('upsertWeights inserts, then overwrites in place by Entry ID', () => {
  const { api, sheet, gas } = connected();
  const log = sheet('Weight Log');
  assert.deepEqual(api('upsertWeights', { entries: [weight({ notes: 'first read' })] }), {
    ok: true, data: { inserted: 1, updated: 0 },
  });
  assert.equal(log.getLastRow(), 6, 'appended after the migrated row');
  const row = log.getRange('A6:I6').getValues()[0];
  assert.equal(ymd(row[0]), '2026-09-29');
  assert.deepEqual(row.slice(1, 8), ['Her', 184.6, '07:12', 'photo', 'high', 'first read', 'w:Her:2026-09-29']);
  assert.equal(Object.prototype.toString.call(row[8]), '[object Date]', 'Logged at');
  assert.equal(gas.lock.held, false);

  assert.deepEqual(api('upsertWeights', { entries: [weight({ weightLb: 184.2, confidence: 'medium' })] }).data, {
    inserted: 0, updated: 1,
  });
  assert.equal(log.getLastRow(), 6);
  assert.deepEqual(log.getRange('B6:H6').getValues()[0], ['Her', 184.2, '07:12', 'photo', 'medium', '', 'w:Her:2026-09-29']);

  // The migrated Monday reading can be corrected from the app too.
  const fix = weight({ entryId: 'w:Her:2026-09-28', date: '2026-09-28', weightLb: 185.4, source: 'manual' });
  assert.deepEqual(api('upsertWeights', { entries: [fix] }).data, { inserted: 0, updated: 1 });
  assert.deepEqual(log.getRange('B5:E5').getValues()[0], ['Her', 185.4, '07:12', 'manual']);
});

test('duplicate Entry IDs in one batch end up as one row with the last values', () => {
  const { api, sheet } = connected();
  const res = api('upsertWeights', { entries: [weight({ weightLb: 184 }), weight({ weightLb: 183.8 })] });
  assert.deepEqual(res.data, { inserted: 1, updated: 1 });
  assert.equal(sheet('Weight Log').getLastRow(), 6);
  assert.equal(sheet('Weight Log').getRange('C6').getValue(), 183.8);
});

test('rows are appended after the last used row, growing the sheet if needed', () => {
  const { api, sheet } = connected();
  const log = sheet('Weight Log');
  log.getRange('A6:C6').setValues([[wb.planDate(2), 'Him', 176]]); // typed by hand, no Entry ID
  log.getRange('G9').setValue('stray note without a date');
  log.deleteRows(10, log.getMaxRows() - 9); // sheet now ends at row 9
  const entries = [1, 2, 3, 4].map((d) => weight({ entryId: `w:Her:d${d}`, date: `2026-10-0${d}` }));
  assert.deepEqual(api('upsertWeights', { entries }).data, { inserted: 4, updated: 0 });
  assert.equal(log.getRange('A6:C6').getValues()[0][2], 176, 'hand-typed row untouched');
  assert.equal(log.getRange('G9').getValue(), 'stray note without a date', 'a note below the data survives');
  assert.deepEqual(log.getRange('H7:H9').getValues().map((r) => r[0]), ['', '', ''], 'blank rows above it are not reused');
  assert.deepEqual(log.getRange('H10:H13').getValues().map((r) => r[0]), ['w:Her:d1', 'w:Her:d2', 'w:Her:d3', 'w:Her:d4']);
  assert.equal(log.getMaxRows(), 13);
  assert.equal(log.peek(13, 1).fmt.numberFormat, 'ddd, mmm d', 'new rows inherit the formats');
});

test('appends never overwrite a hand-typed row that has no Date or Entry ID yet', () => {
  const { api, sheet } = connected();
  const food = sheet('Food Log');
  // A meal being typed by hand (Date not filled in yet), and a note in the row below it.
  food.getRange('B5:F5').setValues([['19:00', 'Her', 'Dinner', 'Homemade lasagna (grandma recipe)', 780]]);
  food.getRange('M6').setValue('remember to weigh the leftovers');
  assert.deepEqual(api('upsertMeals', { entries: [meal(), meal({ entryId: 'm-2', description: 'Salad' })] }).data,
    { inserted: 2, updated: 0 });
  assert.deepEqual(food.getRange('A5:F5').getValues()[0],
    ['', '19:00', 'Her', 'Dinner', 'Homemade lasagna (grandma recipe)', 780]);
  assert.equal(food.getRange('M6').getValue(), 'remember to weigh the leftovers');
  assert.deepEqual(food.getRange('N5:N8').getValues().map((r) => r[0]), ['', '', 'm-1', 'm-2']);
  assert.deepEqual(food.getRange('E7:E8').getValues().map((r) => r[0]), ['Chicken burrito bowl', 'Salad']);

  // Food Library's column A is Name: a row typed without a Name yet is kept too.
  const lib = sheet('Food Library');
  lib.getRange('B5:C5').setValues([['1 bowl', 350]]);
  assert.deepEqual(api('upsertLibrary', { items: [libraryItem()] }).data, { inserted: 1, updated: 0 });
  assert.deepEqual(lib.getRange('A5:C5').getValues()[0], ['', '1 bowl', 350]);
  assert.deepEqual(lib.getRange('A6:C6').getValues()[0], ['Overnight oats', '1 jar', 420]);
});

test('a row that lost its date but kept its Entry ID is updated, never overwritten by appends', () => {
  const { api, sheet } = connected();
  const log = sheet('Weight Log');
  log.getRange('C8:H8').setValues([[180, '', 'manual', 'high', 'date cleared by hand', 'w:Him:2026-10-01']]);
  const entries = [
    weight({ entryId: 'w:Her:a', date: '2026-10-02' }),
    weight({ entryId: 'w:Her:b', date: '2026-10-03' }),
    weight({ entryId: 'w:Him:2026-10-01', date: '2026-10-01', person: 'Him', weightLb: 181 }),
    weight({ entryId: 'w:Her:c', date: '2026-10-04' }),
  ];
  assert.deepEqual(api('upsertWeights', { entries }).data, { inserted: 3, updated: 1 });
  assert.deepEqual(log.getRange('H5:H11').getValues().map((r) => r[0]),
    ['w:Her:2026-09-28', '', '', 'w:Him:2026-10-01', 'w:Her:a', 'w:Her:b', 'w:Her:c']);
  assert.deepEqual(log.getRange('B8:C8').getValues()[0], ['Him', 181]);
  assert.equal(ymd(log.getRange('A8').getValue()), '2026-10-01');
});

test('upsertMeals writes every column and keeps text that looks like a formula as text', () => {
  const { api, sheet } = connected();
  const res = api('upsertMeals', {
    entries: [meal(), meal({ entryId: 'm-2', person: 'Her', meal: 'Snack', description: '=IMPORTXML("http://x","//a")', kcal: 95.4, time: '' })],
  });
  assert.deepEqual(res.data, { inserted: 2, updated: 0 });
  const log = sheet('Food Log');
  const row = log.getRange('A5:O5').getValues()[0];
  assert.equal(ymd(row[0]), '2026-09-29');
  assert.deepEqual(row.slice(1, 14), [
    '12:30', 'Him', 'Lunch', 'Chicken burrito bowl', 820, 52, 85, 28, 'medium', 'photo',
    'chicken breast 150 g (248 kcal) · white rice 180 g (234 kcal)', 'extra salsa', 'm-1',
  ]);
  assert.equal(log.getRange('E6').getFormula(), '', 'not a formula');
  assert.equal(log.getRange('E6').getValue(), '=IMPORTXML("http://x","//a")');
  assert.equal(log.getRange('B6').getValue(), '');

  assert.deepEqual(api('upsertMeals', { entries: [meal({ kcal: 760, notes: '' })] }).data, { inserted: 0, updated: 1 });
  assert.deepEqual(log.getRange('F5:M5').getValues()[0], [760, 52, 85, 28, 'medium', 'photo', row[11], '']);
  assert.equal(log.getLastRow(), 6);
});

test('deleteEntries removes matching rows and ignores unknown ids', () => {
  const { api, sheet } = connected();
  api('upsertMeals', { entries: [meal(), meal({ entryId: 'm-2' }), meal({ entryId: 'm-3' })] });
  const log = sheet('Food Log');
  assert.deepEqual(api('deleteEntries', { kind: 'meal', entryIds: ['m-1', 'm-3', 'nope'] }).data, { deleted: 2 });
  assert.equal(log.getLastRow(), 5);
  assert.equal(log.getRange('N5').getValue(), 'm-2');
  assert.deepEqual(api('deleteEntries', { kind: 'meal', entryIds: [] }).data, { deleted: 0 });

  assert.deepEqual(api('deleteEntries', { kind: 'weight', entryIds: ['w:Her:2026-09-28'] }).data, { deleted: 1 });
  assert.equal(sheet('Weight Log').getLastRow(), 4);

  assert.equal(api('deleteEntries', { kind: 'photos', entryIds: ['x'] }).error.code, 'bad_request');
  assert.match(api('deleteEntries', { kind: 'meal', entryIds: ['ok', 7] }).error.message, /^entryIds\[1\]/);
});

test('getSummary maps computed values, turning "" and errors into null', () => {
  const { api, sheet } = connected();
  const daily = sheet('Daily Log');
  for (let i = 0; i < 154; i++) {
    daily.setComputed(`A${i + 5}`, wb.planDate(i));
    daily.setComputed(`B${i + 5}`, Math.floor(i / 7) + 1);
  }
  const computed = {
    D5: 185.2, E5: 1650, F5: 120, G5: 1670, H5: 3, J5: 2400, K5: 150, L5: 2780, M5: 2,
    Q5: 1650, R5: 120, S5: 1, U5: 2400, V5: 150, W5: 1, Q6: '#DIV/0!', S6: 0,
  };
  for (const [a1, v] of Object.entries(computed)) daily.setComputed(a1, v);
  const wci = sheet('Weekly Check-in');
  wci.setComputed('E5', 185.2);
  wci.setComputed('J5', 180);

  const her = api('getSummary', { person: 'Her', from: '2026-09-28', to: '2026-09-29' });
  assert.equal(her.ok, true);
  assert.deepEqual(her.data.days, [
    { date: '2026-09-28', week: 1, weightLb: 185.2, kcal: 1650, proteinG: 120, kcalTarget: 1670, meals: 3 },
    { date: '2026-09-29', week: 1, weightLb: null, kcal: null, proteinG: null, kcalTarget: null, meals: 0 },
  ]);
  assert.equal(her.data.person, 'Her');
  assert.equal(her.data.currentWeek, 1);
  assert.equal(her.data.weeks.length, 22);
  assert.deepEqual(her.data.weeks[0], {
    week: 1, monday: '2026-09-28', avgWeightLb: 185.2, targetWeightLb: 185, avgKcal: 1650, avgProteinG: 120,
    daysLogged: 1, impliedMaintenance: null,
  });
  assert.deepEqual(her.data.weeks[1], {
    week: 2, monday: '2026-10-05', avgWeightLb: null, targetWeightLb: null, avgKcal: null, avgProteinG: null,
    daysLogged: 0, impliedMaintenance: null,
  });
  assert.equal(her.data.weeks[21].monday, '2027-02-22');

  const him = api('getSummary', { person: 'Him', from: '2026-09-28', to: '2026-09-28' }).data;
  assert.deepEqual(him.days, [
    { date: '2026-09-28', week: 1, weightLb: null, kcal: 2400, proteinG: 150, kcalTarget: 2780, meals: 2 },
  ]);
  assert.equal(him.weeks[0].targetWeightLb, 180);
  assert.equal(him.weeks[0].avgWeightLb, null);
  assert.equal(him.weeks[0].avgKcal, 2400);

  const all = api('getSummary', { person: 'Her', from: '2020-01-01', to: '2030-01-01' }).data;
  assert.equal(all.days.length, 154);
  assert.equal(all.days[153].date, '2027-02-28');

  assert.equal(api('getSummary', { person: 'Them', from: '2026-09-28', to: '2026-09-29' }).error.code, 'bad_request');
  assert.equal(api('getSummary', { person: 'Her', from: 'yesterday', to: '2026-09-29' }).error.code, 'bad_request');
});

test('Food Library round trip: upsert, list, update', () => {
  const { api, sheet } = connected();
  assert.deepEqual(api('listLibrary', {}).data, { items: [] });
  assert.deepEqual(api('upsertLibrary', { items: [libraryItem()] }).data, { inserted: 1, updated: 0 });
  assert.deepEqual(api('listLibrary', {}).data.items, [libraryItem()]);
  assert.equal(sheet('Food Library').getRange('G5').getValue(), 'oats, breakfast jar');

  const bumped = libraryItem({ uses: 4, updatedAt: '2026-10-01T08:00:00.000Z' });
  assert.deepEqual(api('upsertLibrary', { items: [bumped] }).data, { inserted: 0, updated: 1 });
  assert.deepEqual(api('listLibrary', {}).data.items, [bumped]);

  assert.match(api('upsertLibrary', { items: [libraryItem({ addedBy: 'Chef' })] }).error.message, /^items\[0\]: unknown addedBy/);
  assert.match(api('upsertLibrary', { items: [libraryItem({ addedBy: 5 })] }).error.message, /^items\[0\]: unknown addedBy/);
  assert.match(api('upsertLibrary', { items: [libraryItem({ aliases: 'oats' })] }).error.message, /aliases/);
  assert.match(api('upsertLibrary', { items: [libraryItem({ uses: 1.5 })] }).error.message, /uses must be a whole number/);
  assert.match(api('upsertLibrary', { items: [libraryItem({ updatedAt: 'soon' })] }).error.message, /updatedAt/);
});

test('listLibrary gives hand-typed rows an Entry ID and skips rows without a name', () => {
  const { api, sheet } = connected();
  const lib = sheet('Food Library');
  lib.getRange('A5:I5').setValues([['Protein shake', '1 scoop', 130, 25, 3, 2, 'shake', 'Him', 0]]);
  lib.getRange('B6').setValue('orphan serving');
  const items = api('listLibrary', {}).data.items;
  assert.equal(items.length, 1);
  assert.match(items[0].entryId, /^[0-9a-f-]{36}$/);
  assert.deepEqual({ ...items[0], entryId: 'x' }, {
    entryId: 'x', name: 'Protein shake', serving: '1 scoop', kcal: 130, proteinG: 25, carbsG: 3, fatG: 2,
    aliases: ['shake'], addedBy: 'Him', uses: 0, updatedAt: '',
  });
  assert.equal(lib.getRange('K5').getValue(), items[0].entryId, 'ID written back');
  assert.equal(api('listLibrary', {}).data.items[0].entryId, items[0].entryId, 'stable');
});

test('a hand-typed library row with a blank Added by can be pushed back after a phone uses it', () => {
  const { api, sheet } = connected();
  const lib = sheet('Food Library');
  // Data validation allows a blank Added by, so hand-typed rows often have one.
  lib.getRange('A5:I5').setValues([['Overnight oats', '1 jar', 410, 18, 55, 12, '', '', 2]]);
  const [pulled] = api('listLibrary', {}).data.items;
  assert.equal(pulled.addedBy, '');
  // What the app sends after incrementLibraryUse: same row, uses + 1, addedBy still blank.
  const bumped = { ...pulled, uses: 3, updatedAt: '2026-10-02T07:30:00.000Z' };
  assert.deepEqual(api('upsertLibrary', { items: [bumped] }).data, { inserted: 0, updated: 1 });
  assert.deepEqual(api('listLibrary', {}).data.items, [bumped]);
  assert.equal(lib.getRange('H5').getValue(), '');
});

test('writes take the script lock; a busy lock is reported without writing', () => {
  const { api, gas, sheet } = connected();
  const before = gas.lock.waits;
  api('upsertMeals', { entries: [meal()] });
  assert.equal(gas.lock.waits, before + 1);
  assert.equal(gas.lock.releases, gas.lock.waits);

  gas.lock.failNext = true;
  const res = api('upsertMeals', { entries: [meal({ entryId: 'm-9' })] });
  assert.deepEqual(res, { ok: false, error: { code: 'internal', message: 'The sheet is busy — try again in a moment' } });
  assert.equal(sheet('Food Log').getLastRow(), 5);
});

test('actions report a missing tab as not_found', () => {
  const { api, gas } = connected();
  gas.ss.sheets = gas.ss.sheets.filter((s) => s.getName() !== 'Food Log');
  const res = api('upsertMeals', { entries: [meal()] });
  assert.equal(res.error.code, 'not_found');
  assert.match(res.error.message, /Food Log/);
});
