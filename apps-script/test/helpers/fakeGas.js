'use strict';
/**
 * In-memory fake of the Apps Script services Code.gs uses. Cells store a value
 * and a formula (no formula evaluation — tests seed "computed" values with
 * setComputed), plus formats, data validation, merges and conditional formats,
 * so a whole workbook can be snapshotted and compared.
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const CODE_PATH = path.join(__dirname, '..', '..', 'Code.gs');

// ───────────── A1 helpers ─────────────

function colIndex(letters) {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

function colLetter(n) {
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function isDate(v) {
  return Object.prototype.toString.call(v) === '[object Date]';
}

// ───────────── Utilities (time-zone aware via Intl) ─────────────

function tzParts(date, tz) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const out = {};
  for (const p of fmt.formatToParts(date)) out[p.type] = p.value;
  return out;
}

function tzOffsetMs(utcMs, tz) {
  const p = tzParts(new Date(utcMs), tz);
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - utcMs;
}

function formatDate(date, tz, pattern) {
  if (!isDate(date)) throw new Error('formatDate: not a date');
  const p = tzParts(date, tz);
  const map = { yyyy: p.year, MM: p.month, dd: p.day, HH: p.hour, mm: p.minute, ss: p.second };
  return pattern.replace(/yyyy|MM|dd|HH|mm|ss|'[^']*'/g, (t) => (t in map ? map[t] : t.slice(1, -1)));
}

function parseDate(str, tz, pattern) {
  if (pattern !== 'yyyy-MM-dd') throw new Error('fake parseDate only supports yyyy-MM-dd');
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str);
  if (!m) throw new Error('Unparseable date: ' + str);
  const wall = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  let t = wall - tzOffsetMs(wall, tz);
  t = wall - tzOffsetMs(t, tz); // second pass settles DST edges
  return new Date(t);
}

function makeUtilities() {
  let n = 0;
  return {
    getUuid() {
      n += 1;
      const hex = n.toString(16).padStart(12, '0');
      return `a1b2c3d4-e5f6-4a7b-8c9d-${hex}`;
    },
    formatDate,
    parseDate,
  };
}

// ───────────── Spreadsheet model ─────────────

class FakeRange {
  constructor(sheet, row, col, numRows, numCols) {
    if (row < 1 || col < 1 || numRows < 1 || numCols < 1) throw new Error('Invalid range');
    if (row + numRows - 1 > sheet.maxRows || col + numCols - 1 > sheet.maxCols) {
      throw new Error('The coordinates of the range are outside the dimensions of the sheet.');
    }
    Object.assign(this, { sheet, row, col, numRows, numCols });
  }

  getSheet() { return this.sheet; }
  getRow() { return this.row; }
  getColumn() { return this.col; }
  getNumRows() { return this.numRows; }
  getNumColumns() { return this.numCols; }
  getLastRow() { return this.row + this.numRows - 1; }
  getLastColumn() { return this.col + this.numCols - 1; }
  getA1Notation() {
    const a = colLetter(this.col) + this.row;
    const b = colLetter(this.getLastColumn()) + this.getLastRow();
    return a === b ? a : `${a}:${b}`;
  }

  eachCell(fn) {
    for (let i = 0; i < this.numRows; i++) {
      for (let j = 0; j < this.numCols; j++) fn(this.row + i, this.col + j, i, j);
    }
  }

  grid(fn) {
    const out = [];
    for (let i = 0; i < this.numRows; i++) {
      const row = [];
      for (let j = 0; j < this.numCols; j++) row.push(fn(this.sheet.peek(this.row + i, this.col + j)));
      out.push(row);
    }
    return out;
  }

  checkShape(values, what) {
    if (!Array.isArray(values) || values.length !== this.numRows) {
      throw new Error(`${what}: the number of rows in the data does not match the range`);
    }
    for (const row of values) {
      if (!Array.isArray(row) || row.length !== this.numCols) {
        throw new Error(`${what}: the number of columns in the data does not match the range`);
      }
    }
  }

  getValues() { return this.grid((c) => (c ? c.v : '')); }
  getValue() { return this.getValues()[0][0]; }
  getFormulas() { return this.grid((c) => (c ? c.f : '')); }
  getFormula() { return this.getFormulas()[0][0]; }

  setValues(values) {
    this.checkShape(values, 'setValues');
    this.eachCell((r, c, i, j) => this.sheet.writeValue(r, c, values[i][j]));
    return this;
  }

  setValue(value) {
    this.eachCell((r, c) => this.sheet.writeValue(r, c, value));
    return this;
  }

  setFormulas(formulas) {
    this.checkShape(formulas, 'setFormulas');
    this.eachCell((r, c, i, j) => this.sheet.writeFormula(r, c, formulas[i][j]));
    return this;
  }

  setFormula(formula) {
    this.eachCell((r, c) => this.sheet.writeFormula(r, c, formula));
    return this;
  }

  setFormat(prop, value) {
    this.eachCell((r, c) => { this.sheet.cell(r, c).fmt[prop] = value; });
    return this;
  }

  setNumberFormat(v) { return this.setFormat('numberFormat', v); }
  setBackground(v) { return this.setFormat('background', v); }
  setFontWeight(v) { return this.setFormat('fontWeight', v); }
  setFontSize(v) { return this.setFormat('fontSize', v); }
  setFontColor(v) { return this.setFormat('fontColor', v); }
  setHorizontalAlignment(v) { return this.setFormat('hAlign', v); }
  setVerticalAlignment(v) { return this.setFormat('vAlign', v); }
  setWrap(v) { return this.setFormat('wrap', v); }

  getBackground() {
    const c = this.sheet.peek(this.row, this.col);
    return (c && c.fmt.background) || '#ffffff';
  }

  getNumberFormat() {
    const c = this.sheet.peek(this.row, this.col);
    return (c && c.fmt.numberFormat) || 'General';
  }

  setDataValidation(rule) {
    this.eachCell((r, c) => { this.sheet.cell(r, c).dv = rule; });
    return this;
  }

  getDataValidation() {
    const c = this.sheet.peek(this.row, this.col);
    return (c && c.dv) || null;
  }

  bounds() {
    return { r1: this.row, c1: this.col, r2: this.getLastRow(), c2: this.getLastColumn() };
  }

  merge() {
    const b = this.bounds();
    for (const m of this.sheet.merges) {
      const overlaps = !(m.r2 < b.r1 || m.r1 > b.r2 || m.c2 < b.c1 || m.c1 > b.c2);
      const same = m.r1 === b.r1 && m.c1 === b.c1 && m.r2 === b.r2 && m.c2 === b.c2;
      if (overlaps && !same) throw new Error('You must select all cells in a merged range to merge or unmerge them.');
      if (same) return this;
    }
    this.sheet.merges.push(b);
    return this;
  }

  breakApart() {
    const b = this.bounds();
    this.sheet.merges = this.sheet.merges.filter((m) => {
      const overlaps = !(m.r2 < b.r1 || m.r1 > b.r2 || m.c2 < b.c1 || m.c1 > b.c2);
      if (!overlaps) return true;
      const inside = m.r1 >= b.r1 && m.r2 <= b.r2 && m.c1 >= b.c1 && m.c2 <= b.c2;
      if (!inside) throw new Error('You must select all cells in a merged range to merge or unmerge them.');
      return false;
    });
    return this;
  }

  /** PASTE_FORMAT only: copies formats and merges, tiling the source over the destination. */
  copyTo(dest, type) {
    if (type !== 'PASTE_FORMAT') throw new Error('fake copyTo supports PASTE_FORMAT only');
    if (dest.sheet !== this.sheet) throw new Error('fake copyTo is same-sheet only');
    const rows = Math.max(dest.numRows, this.numRows);
    const cols = Math.max(dest.numCols, this.numCols);
    for (let i = 0; i < rows; i++) {
      for (let j = 0; j < cols; j++) {
        const src = this.sheet.peek(this.row + (i % this.numRows), this.col + (j % this.numCols));
        this.sheet.cell(dest.row + i, dest.col + j).fmt = { ...(src ? src.fmt : {}) };
      }
    }
    const b = this.bounds();
    const dr = dest.row - this.row;
    const dc = dest.col - this.col;
    for (const m of this.sheet.merges.slice()) {
      if (m.r1 >= b.r1 && m.r2 <= b.r2 && m.c1 >= b.c1 && m.c2 <= b.c2) {
        new FakeRange(this.sheet, m.r1 + dr, m.c1 + dc, m.r2 - m.r1 + 1, m.c2 - m.c1 + 1).breakApart().merge();
      }
    }
  }
}

class FakeSheet {
  constructor(ss, name, id, rows = 1000, cols = 26) {
    Object.assign(this, { ss, name, id, maxRows: rows, maxCols: cols });
    this.cells = new Map();
    this.merges = [];
    this.cfRules = [];
    this.frozenRows = 0;
    this.frozenCols = 0;
    this.colWidths = {};
    this.rowHeights = {};
  }

  key(r, c) { return `${r}:${c}`; }
  peek(r, c) { return this.cells.get(this.key(r, c)); }
  cell(r, c) {
    const k = this.key(r, c);
    if (!this.cells.has(k)) this.cells.set(k, { v: '', f: '', fmt: {}, dv: null });
    return this.cells.get(k);
  }

  /** Mirrors Sheets: "=…" becomes a formula, a leading apostrophe forces text. */
  writeValue(r, c, value) {
    if (value === undefined) throw new Error('setValues: undefined value');
    const cell = this.cell(r, c);
    if (typeof value === 'string' && value.startsWith('=')) {
      cell.f = value;
      cell.v = '';
    } else if (typeof value === 'string' && value.startsWith("'")) {
      cell.f = '';
      cell.v = value.slice(1);
    } else {
      cell.f = '';
      cell.v = value === null ? '' : value;
    }
  }

  writeFormula(r, c, formula) {
    if (typeof formula !== 'string' || (formula !== '' && !formula.startsWith('='))) {
      throw new Error('setFormula: not a formula: ' + formula);
    }
    const cell = this.cell(r, c);
    cell.f = formula;
    cell.v = '';
  }

  /** Test helper: set the value a formula would compute, keeping the formula. */
  setComputed(a1, value) {
    const range = this.getRange(a1);
    range.eachCell((r, c) => { this.cell(r, c).v = value; });
  }

  getName() { return this.name; }
  getSheetId() { return this.id; }
  getIndex() { return this.ss.sheets.indexOf(this) + 1; }
  getParent() { return this.ss; }
  getMaxRows() { return this.maxRows; }
  getMaxColumns() { return this.maxCols; }

  hasContent(cell) { return cell.f !== '' || (cell.v !== '' && cell.v !== null); }

  getLastRow() {
    let last = 0;
    for (const [k, cell] of this.cells) if (this.hasContent(cell)) last = Math.max(last, +k.split(':')[0]);
    return last;
  }

  getLastColumn() {
    let last = 0;
    for (const [k, cell] of this.cells) if (this.hasContent(cell)) last = Math.max(last, +k.split(':')[1]);
    return last;
  }

  getRange(a, b, c, d) {
    if (typeof a === 'number') return new FakeRange(this, a, b, c || 1, d || 1);
    const m = /^([A-Z]+)(\d+)?(?::([A-Z]+)(\d+)?)?$/.exec(a);
    if (!m) throw new Error('Bad A1 notation: ' + a);
    const c1 = colIndex(m[1]);
    const r1 = m[2] ? +m[2] : 1;
    const c2 = m[3] ? colIndex(m[3]) : c1;
    const r2 = m[3] ? (m[4] ? +m[4] : this.maxRows) : r1;
    return new FakeRange(this, r1, c1, r2 - r1 + 1, c2 - c1 + 1);
  }

  getDataRange() {
    return new FakeRange(this, 1, 1, Math.max(1, this.getLastRow()), Math.max(1, this.getLastColumn()));
  }

  /**
   * Rows >= `from` move by `delta`. With a negative delta the rows
   * [from + delta, from) are the deleted ones and are dropped.
   */
  shiftRows(from, delta) {
    const dropFrom = delta < 0 ? from + delta : Infinity;
    const place = (r) => (r >= from ? r + delta : r >= dropFrom ? null : r);
    const moved = new Map();
    for (const [k, cell] of this.cells) {
      const [r, c] = k.split(':').map(Number);
      const to = place(r);
      if (to !== null) moved.set(this.key(to, c), cell);
    }
    this.cells = moved;
    const heights = {};
    for (const [r, h] of Object.entries(this.rowHeights)) {
      const to = place(+r);
      if (to !== null) heights[to] = h;
    }
    this.rowHeights = heights;
    this.merges = this.merges
      .filter((m) => place(m.r1) !== null && place(m.r2) !== null)
      .map((m) => ({ ...m, r1: place(m.r1), r2: place(m.r2) }));
  }

  /** New rows inherit the formats and validation of the row above, like Sheets. */
  insertRowsAfter(after, howMany) {
    this.shiftRows(after + 1, howMany);
    this.maxRows += howMany;
    for (let c = 1; c <= this.maxCols; c++) {
      const src = this.peek(after, c);
      if (!src) continue;
      for (let i = 1; i <= howMany; i++) {
        const cell = this.cell(after + i, c);
        cell.fmt = { ...src.fmt };
        cell.dv = src.dv;
      }
    }
    this.ss.log.push(['insertRowsAfter', this.name, after, howMany]);
  }

  insertRowAfter(after) { this.insertRowsAfter(after, 1); }

  insertColumnsAfter(after, howMany) {
    if (after !== this.maxCols) throw new Error('fake insertColumnsAfter only appends');
    this.maxCols += howMany;
  }

  deleteRows(start, howMany) {
    if (this.maxRows - howMany <= this.frozenRows) {
      throw new Error('Sorry, it is not possible to delete all non-frozen rows.');
    }
    this.shiftRows(start + howMany, -howMany);
    this.maxRows -= howMany;
    this.ss.log.push(['deleteRows', this.name, start, howMany]);
  }

  deleteRow(row) { this.deleteRows(row, 1); }

  setFrozenRows(n) { this.frozenRows = n; }
  getFrozenRows() { return this.frozenRows; }
  setFrozenColumns(n) { this.frozenCols = n; }
  getFrozenColumns() { return this.frozenCols; }
  setColumnWidth(col, px) { this.colWidths[col] = px; return this; }
  getColumnWidth(col) { return this.colWidths[col] || 100; }
  setRowHeight(row, px) { this.rowHeights[row] = px; return this; }
  getRowHeight(row) { return this.rowHeights[row] || 21; }
  getConditionalFormatRules() { return this.cfRules.slice(); }
  setConditionalFormatRules(rules) { this.cfRules = rules.slice(); }
}

class FakeSpreadsheet {
  constructor({ name = 'Road to Feb 27', timeZone = 'America/New_York' } = {}) {
    Object.assign(this, { name, timeZone });
    this.sheets = [];
    this.named = {};
    this.toasts = [];
    this.log = [];
    this.nextId = 900000001;
  }

  getName() { return this.name; }
  getSpreadsheetTimeZone() { return this.timeZone; }
  getSheets() { return this.sheets.slice(); }
  getNumSheets() { return this.sheets.length; }
  getSheetByName(name) { return this.sheets.find((s) => s.name === name) || null; }

  addSheet(name, id, rows, cols) {
    const sheet = new FakeSheet(this, name, id, rows, cols);
    this.sheets.push(sheet);
    return sheet;
  }

  insertSheet(name, index) {
    if (this.getSheetByName(name)) throw new Error(`A sheet with the name "${name}" already exists.`);
    const sheet = new FakeSheet(this, name, this.nextId++);
    const at = index === undefined ? this.sheets.length : index;
    this.sheets.splice(at, 0, sheet);
    return sheet;
  }

  setNamedRange(name, sheetName, a1) { this.named[name] = { sheetName, a1 }; }

  getRangeByName(name) {
    const n = this.named[name];
    return n ? this.getSheetByName(n.sheetName).getRange(n.a1) : null;
  }

  toast(message, title) { this.toasts.push({ message, title }); }
}

// ───────────── Builders (validation, conditional formats) ─────────────

function newDataValidation() {
  const rule = { type: null, values: null, showDropdown: true, allowInvalid: true };
  const builder = {
    requireValueInList(values, showDropdown) {
      Object.assign(rule, { type: 'list', values: values.slice(), showDropdown: showDropdown !== false });
      return builder;
    },
    setAllowInvalid(v) { rule.allowInvalid = v; return builder; },
    setHelpText(v) { rule.helpText = v; return builder; },
    build() { return { ...rule, values: rule.values && rule.values.slice() }; },
  };
  return builder;
}

function makeRule({ formula = null, background = null, ranges = [], kind = 'boolean' }) {
  return {
    kind, formula, background, ranges,
    getBooleanCondition() {
      if (kind !== 'boolean') return null;
      return { getCriteriaType: () => 'CUSTOM_FORMULA', getCriteriaValues: () => [formula] };
    },
    getGradientCondition() { return kind === 'gradient' ? {} : null; },
    getRanges() { return ranges.slice(); },
  };
}

function newConditionalFormatRule() {
  const spec = { ranges: [] };
  const builder = {
    whenFormulaSatisfied(f) { spec.formula = f; return builder; },
    setBackground(c) { spec.background = c; return builder; },
    setRanges(ranges) { spec.ranges = ranges.slice(); return builder; },
    build() { return makeRule(spec); },
  };
  return builder;
}

// ───────────── Environment ─────────────

function makeProperties() {
  const store = {};
  return {
    store,
    getProperty: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
    setProperty(k, v) { store[k] = String(v); return this; },
    deleteProperty(k) { delete store[k]; return this; },
    getProperties: () => ({ ...store }),
  };
}

function makeUi(env) {
  const ui = {
    menus: [],
    alerts: [],
    dialogs: [],
    alertAnswer: 'YES',
    ButtonSet: { OK: 'OK', YES_NO: 'YES_NO', OK_CANCEL: 'OK_CANCEL' },
    Button: { YES: 'YES', NO: 'NO', OK: 'OK', CANCEL: 'CANCEL' },
    createMenu(name) {
      const menu = { name, items: [] };
      const builder = {
        addItem(caption, fn) { menu.items.push({ caption, fn }); return builder; },
        addSeparator() { return builder; },
        addToUi() { ui.menus.push(menu); },
      };
      return builder;
    },
    alert(title, prompt, buttons) {
      ui.alerts.push({ title, prompt, buttons });
      return ui.alertAnswer;
    },
    showModalDialog(output, title) { ui.dialogs.push({ html: output.getContent(), title, output }); },
  };
  return ui;
}

/**
 * Builds the service fakes around `ss`, loads Code.gs into a vm context and
 * returns handles for tests.
 */
function loadCode(ss, options = {}) {
  const env = { webAppUrl: options.webAppUrl === undefined ? null : options.webAppUrl };
  const scriptProps = makeProperties();
  const docProps = makeProperties();
  const lock = { waits: 0, releases: 0, held: false, failNext: false };
  const ui = makeUi(env);

  const SpreadsheetApp = {
    getActiveSpreadsheet: () => ss,
    getUi: () => ui,
    flush() {},
    newDataValidation,
    newConditionalFormatRule,
    CopyPasteType: { PASTE_FORMAT: 'PASTE_FORMAT', PASTE_NORMAL: 'PASTE_NORMAL', PASTE_VALUES: 'PASTE_VALUES' },
    BooleanCriteria: { CUSTOM_FORMULA: 'CUSTOM_FORMULA' },
  };
  const LockService = {
    getScriptLock: () => ({
      waitLock() {
        if (lock.failNext) {
          lock.failNext = false;
          throw new Error('Lock timeout');
        }
        if (lock.held) throw new Error('fake lock already held (nested lock?)');
        lock.waits += 1;
        lock.held = true;
      },
      releaseLock() {
        if (lock.held) lock.releases += 1;
        lock.held = false;
      },
      hasLock: () => lock.held,
    }),
  };
  const ContentService = {
    MimeType: { JSON: 'JSON', TEXT: 'TEXT' },
    createTextOutput(content) {
      return {
        content, mimeType: 'TEXT',
        setMimeType(m) { this.mimeType = m; return this; },
        getContent() { return this.content; },
        getMimeType() { return this.mimeType; },
      };
    },
  };
  const HtmlService = {
    createHtmlOutput(html) {
      return {
        html, width: null, height: null,
        setWidth(w) { this.width = w; return this; },
        setHeight(h) { this.height = h; return this; },
        getContent() { return this.html; },
      };
    },
  };
  const ScriptApp = { getService: () => ({ getUrl: () => env.webAppUrl }) };
  const PropertiesService = {
    getScriptProperties: () => scriptProps,
    getDocumentProperties: () => docProps,
  };

  const context = vm.createContext({
    SpreadsheetApp, LockService, ContentService, HtmlService, ScriptApp, PropertiesService,
    Utilities: makeUtilities(),
    console,
  });
  vm.runInContext(fs.readFileSync(CODE_PATH, 'utf8'), context, { filename: 'Code.gs' });

  return {
    ss, env, ui, lock, scriptProps, docProps, context,
    /** Evaluates an expression inside Code.gs's global scope (reaches top-level consts). */
    get: (expr) => vm.runInContext(expr, context),
    call: (fn, ...args) => context[fn](...args),
    post(body) {
      const raw = typeof body === 'string' ? body : JSON.stringify(body);
      const out = context.doPost({ postData: { contents: raw, type: 'text/plain' } });
      if (out.getMimeType() !== 'JSON') throw new Error('doPost did not return JSON');
      return JSON.parse(out.getContent());
    },
  };
}

// ───────────── Snapshot ─────────────

function serializeValue(v) {
  return isDate(v) ? `D:${v.toISOString()}` : v;
}

function serializeRule(rule) {
  return {
    kind: rule.kind,
    formula: rule.formula,
    background: rule.background,
    ranges: rule.ranges.map((r) => `${r.getSheet().getName()}!${r.getA1Notation()}`),
  };
}

/** Deterministic JSON-able view of the whole workbook (values, formulas, formats, …). */
function snapshot(ss) {
  return ss.sheets.map((sheet) => ({
    name: sheet.name,
    id: sheet.id,
    maxRows: sheet.maxRows,
    maxCols: sheet.maxCols,
    frozen: [sheet.frozenRows, sheet.frozenCols],
    colWidths: { ...sheet.colWidths },
    rowHeights: { ...sheet.rowHeights },
    merges: sheet.merges.map((m) => `${m.r1},${m.c1},${m.r2},${m.c2}`).sort(),
    cf: sheet.cfRules.map(serializeRule),
    cells: [...sheet.cells.entries()]
      .sort(([a], [b]) => {
        const [ar, ac] = a.split(':').map(Number);
        const [br, bc] = b.split(':').map(Number);
        return ar - br || ac - bc;
      })
      .map(([k, c]) => [k, serializeValue(c.v), c.f, JSON.stringify(c.fmt), c.dv ? JSON.stringify(c.dv) : '']),
  }));
}

module.exports = {
  FakeSpreadsheet, FakeSheet, FakeRange, loadCode, snapshot, makeRule,
  colIndex, colLetter, formatDate, parseDate,
};
