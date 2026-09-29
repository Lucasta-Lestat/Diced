/// <reference types="jest" />
import {
  describeSheetUrl,
  firstParam,
  isAppsScriptUrl,
  isValidTime,
  keyTestAllowsSave,
  macrosToInputs,
  numberToInput,
  parseDateInput,
  parseDecimal,
  parseIntInRange,
  parseMacroInputs,
  parseTimeInput,
  parseWeightInput,
  pathFromDeepLink,
  recentDates,
  sheetUrlHint,
  sheetUrlParts,
  slotForHour,
} from '../forms';

describe('parseDecimal', () => {
  it('accepts dot or comma decimals and trims', () => {
    expect(parseDecimal('182.4')).toBe(182.4);
    expect(parseDecimal(' 182,4 ')).toBe(182.4);
    expect(parseDecimal('182.')).toBe(182);
    expect(parseDecimal('.5')).toBe(0.5);
  });

  it('rejects junk', () => {
    expect(parseDecimal('')).toBeNull();
    expect(parseDecimal('abc')).toBeNull();
    expect(parseDecimal('1.2.3')).toBeNull();
    expect(parseDecimal('12lb')).toBeNull();
  });

  it('round-trips through numberToInput', () => {
    expect(numberToInput(182.44, 1)).toBe('182.4');
    expect(numberToInput(650.6)).toBe('651');
    expect(numberToInput(null)).toBe('');
  });
});

describe('parseWeightInput', () => {
  it('keeps lb and converts kg, rounded to 0.1 lb', () => {
    expect(parseWeightInput('182.4', 'lb')).toEqual({ ok: true, value: 182.4 });
    expect(parseWeightInput('100', 'kg')).toEqual({ ok: true, value: 220.5 });
  });

  it('rejects implausible body weights', () => {
    expect(parseWeightInput('18.2', 'lb').ok).toBe(false);
    expect(parseWeightInput('900', 'lb').ok).toBe(false);
    expect(parseWeightInput('', 'lb').ok).toBe(false);
  });
});

describe('times and dates', () => {
  it('normalizes typed times', () => {
    expect(parseTimeInput('7:05')).toBe('07:05');
    expect(parseTimeInput('0705')).toBe('07:05');
    expect(parseTimeInput('705')).toBe('07:05');
    expect(parseTimeInput('23:59')).toBe('23:59');
    expect(parseTimeInput('24:00')).toBeNull();
    expect(parseTimeInput('12:60')).toBeNull();
    expect(parseTimeInput('noon')).toBeNull();
    expect(isValidTime('07:05')).toBe(true);
    expect(isValidTime('7:05')).toBe(false);
  });

  it('validates dates and refuses the future', () => {
    expect(parseDateInput('2026-09-27', '2026-09-28')).toEqual({ ok: true, value: '2026-09-27' });
    expect(parseDateInput('2026-09-29', '2026-09-28').ok).toBe(false);
    expect(parseDateInput('2026-02-30', '2026-09-28').ok).toBe(false);
  });

  it('lists recent dates newest first', () => {
    expect(recentDates('2026-10-01', 3)).toEqual(['2026-10-01', '2026-09-30', '2026-09-29']);
  });

  it('suggests a slot from the hour', () => {
    expect(slotForHour(7)).toBe('breakfast');
    expect(slotForHour(12)).toBe('lunch');
    expect(slotForHour(16)).toBe('snack');
    expect(slotForHour(19)).toBe('dinner');
    expect(slotForHour(23)).toBe('snack');
  });
});

describe('parseIntInRange', () => {
  it('accepts whole numbers in range only', () => {
    expect(parseIntInRange('20', 1, 180, 'Minutes')).toEqual({ ok: true, value: 20 });
    expect(parseIntInRange('2.5', 1, 180, 'Minutes').ok).toBe(false);
    expect(parseIntInRange('0', 1, 180, 'Minutes').ok).toBe(false);
  });
});

describe('macro inputs', () => {
  it('requires calories and defaults blank macros to 0', () => {
    expect(parseMacroInputs({ kcal: '650.4', proteinG: '32', carbsG: '', fatG: '18,5' })).toEqual({
      ok: true,
      value: { kcal: 650, proteinG: 32, carbsG: 0, fatG: 18.5 },
    });
    expect(parseMacroInputs({ kcal: '', proteinG: '', carbsG: '', fatG: '' }).ok).toBe(false);
    expect(parseMacroInputs({ kcal: '20000', proteinG: '', carbsG: '', fatG: '' }).ok).toBe(false);
    expect(parseMacroInputs({ kcal: '500', proteinG: '-3', carbsG: '', fatG: '' }).ok).toBe(false);
  });

  it('fills inputs from macros', () => {
    expect(macrosToInputs({ kcal: 650.2, proteinG: 32.4, carbsG: 45, fatG: 18 })).toEqual({
      kcal: '650',
      proteinG: '32',
      carbsG: '45',
      fatG: '18',
    });
  });
});

describe('deep links and params', () => {
  it('maps diced:// links to router paths', () => {
    expect(pathFromDeepLink('diced://process-week')).toBe('/process-week');
    expect(pathFromDeepLink('diced:///review')).toBe('/review');
    expect(pathFromDeepLink('diced://connect?url=https%3A%2F%2Fx&token=t')).toBe('/connect?url=https%3A%2F%2Fx&token=t');
    expect(pathFromDeepLink('https://example.com/review')).toBeNull();
  });

  it('takes the first value of repeated params', () => {
    expect(firstParam(['a', 'b'])).toBe('a');
    expect(firstParam('a')).toBe('a');
    expect(firstParam(undefined)).toBe('');
  });

  it('hints at wrong Apps Script URLs', () => {
    expect(sheetUrlHint('https://script.google.com/macros/s/abc/exec')).toBeNull();
    expect(sheetUrlHint('http://script.google.com/macros/s/abc/exec')).toMatch(/https/);
    expect(sheetUrlHint('https://script.google.com/macros/s/abc/dev')).toMatch(/\/dev/);
    expect(sheetUrlHint('https://script.google.com/macros/s/abc')).toMatch(/\/exec/);
    expect(sheetUrlHint('https://script.google.com/macros/s/abc/exec?x=1')).toMatch(/exactly as the sheet shows it/);
    expect(sheetUrlHint('https://script.google.com/a/macros/example.com/s/abc/exec')).toBeNull();
    expect(sheetUrlHint('')).toBeNull();
  });

  it('warns about any host other than Google Apps Script', () => {
    expect(sheetUrlHint('https://evil.example/exec')).toMatch(/evil\.example.*not Google Apps Script/);
    expect(sheetUrlHint('https://script.google.com.evil.example/macros/s/abc/exec')).toMatch(/not Google Apps Script/);
    // A user@ part can make a foreign host look like Google.
    expect(sheetUrlHint('https://script.google.com@evil.example/macros/s/abc/exec')).toMatch(/evil\.example/);
  });
});

describe('sheet URL parts', () => {
  const ID = 'AKfycbx1234567890abcdefghijklmnopqrstuvwxyz9xQw';

  it('extracts the host and deployment id', () => {
    expect(sheetUrlParts(`https://script.google.com/macros/s/${ID}/exec`)).toEqual({ host: 'script.google.com', deploymentId: ID });
    expect(sheetUrlParts(`https://script.google.com/a/macros/example.com/s/${ID}/exec?x=1`)).toEqual({ host: 'script.google.com', deploymentId: ID });
    expect(sheetUrlParts('https://Evil.Example:8443/exec')).toEqual({ host: 'evil.example', deploymentId: null });
    expect(sheetUrlParts('https://script.google.com@evil.example/exec')?.host).toBe('evil.example');
    expect(sheetUrlParts('http://script.google.com/macros/s/x/exec')).toBeNull();
    expect(sheetUrlParts('not a url')).toBeNull();
  });

  it('accepts only Apps Script hosts', () => {
    expect(isAppsScriptUrl(`https://script.google.com/macros/s/${ID}/exec`)).toBe(true);
    expect(isAppsScriptUrl('https://script.googleusercontent.com/macros/echo?x=1')).toBe(true);
    expect(isAppsScriptUrl('https://evil.example/exec')).toBe(false);
    expect(isAppsScriptUrl('https://script.google.com.evil.example/exec')).toBe(false);
    expect(isAppsScriptUrl('')).toBe(false);
  });

  it('names destinations briefly for confirmations', () => {
    expect(describeSheetUrl(`https://script.google.com/macros/s/${ID}/exec`)).toBe('script.google.com · deployment AKfycb…9xQw');
    expect(describeSheetUrl('https://script.google.com/macros/s/short/exec')).toBe('script.google.com · deployment short');
    expect(describeSheetUrl('https://evil.example/exec')).toBe('evil.example');
  });
});

describe('keyTestAllowsSave', () => {
  it('refuses only a rejected key', () => {
    expect(keyTestAllowsSave({ ok: true, message: 'Connected' })).toBe(true);
    expect(keyTestAllowsSave({ ok: false, message: 'x', kind: 'auth' })).toBe(false);
    for (const kind of ['network', 'timeout', 'rate_limit', 'overloaded', 'permission', 'not_found']) {
      expect(keyTestAllowsSave({ ok: false, message: 'x', kind })).toBe(true);
    }
  });

  it('falls back to the rejected-key message when no kind is reported', () => {
    expect(keyTestAllowsSave({ ok: false, message: 'Claude API key rejected — check that you copied the whole key.' })).toBe(false);
    expect(keyTestAllowsSave({ ok: false, message: 'The key works, but model "x" was not found — check the model id in Settings.' })).toBe(true);
    expect(keyTestAllowsSave({ ok: false, message: "Couldn't reach Claude — check your internet connection." })).toBe(true);
  });
});
