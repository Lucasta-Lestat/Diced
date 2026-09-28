'use strict';
/**
 * Seeds a FakeSpreadsheet with the parts of the real "Road to Feb 27" workbook
 * (Google Sheets conversion of Road_to_Feb27_Training_Plan.xlsx) that setupDiced
 * touches. Cell contents mirror the xlsx.
 */
const { FakeSpreadsheet, makeRule, parseDate } = require('./fakeGas');

const TZ = 'America/New_York';

const IDS = {
  dashboard: 0,
  gamePlan: 101,
  checkin: 102,
  his: 3333,
  her: 4444,
  library: 105,
  chart: 106,
};

const PHASES = [
  ...Array(5).fill('Build 1 / Foundation'),
  'Deload',
  ...Array(6).fill('Build 2'),
  'Holiday deload',
  ...Array(8).fill('Cut / Accelerate'),
  'Peak week',
];

const CHECKIN_HEADERS = [
  'Week', 'Week of (Mon)', 'Phase', 'Target weight', 'Weight (lb)', 'Waist (in)', 'Avg daily steps',
  'Hip thrust (lb) auto', 'Plan done % auto', 'Target weight', 'Weight (lb)', 'Waist (in)',
  'Shoulders (in)', 'Chest (in)', 'Bench (lb) auto', 'Squat (lb) auto', 'Deadlift (lb) auto',
  'OH press (lb) auto', 'Plan done % auto', 'Notes',
];

const YELLOW = '#fff8e1';

function ymdPlus(days) {
  return new Date(Date.UTC(2026, 8, 28 + days)).toISOString().slice(0, 10);
}

/** Midnight of plan day `days` in the sheet's time zone, like a computed date cell. */
function planDate(days) {
  return parseDate(ymdPlus(days), TZ, 'yyyy-MM-dd');
}

const lookupFormula = (col) =>
  `=IFERROR(LOOKUP(2,1/('Weekly Check-in'!$${col}$5:$${col}$26<>""),'Weekly Check-in'!$${col}$5:$${col}$26),"")`;

const firstFormula = (col) =>
  `=IFERROR(INDEX('Weekly Check-in'!$${col}$5:$${col}$26,MATCH(TRUE(),INDEX('Weekly Check-in'!$${col}$5:$${col}$26<>"",0),0)),"")`;

const HYPERLINK_HIS = `=HYPERLINK("#'His Workouts'!B"&(MATCH(CurWeek,'His Workouts'!$A:$A,0)-2),"▶ His week")`;
const HYPERLINK_HER = `=HYPERLINK("#'Her Workouts'!B"&(MATCH(CurWeek,'Her Workouts'!$A:$A,0)-2),"▶ Her week")`;

// NOW column (F) → Weekly Check-in column it reads, per the xlsx.
const DASHBOARD_LOOKUPS = {
  F10: 'E', F11: 'F', F12: 'H', F13: 'G',
  F24: 'K', F25: 'L', F26: 'M', F27: 'N', F28: 'O', F29: 'P', F30: 'Q', F31: 'R',
};

function seedDashboard(ss) {
  const sh = ss.addSheet('Dashboard', IDS.dashboard, 60, 20);
  sh.getRange('B1').setValue('ROAD TO FEB 27');
  sh.getRange('C4').setValue('PLAN WEEK');
  sh.getRange('C5').setFormula('=MIN(22,MAX(1,INT((TODAY()-StartDate)/7)+1))');
  sh.setComputed('C5', 1);
  sh.getRange('H5').setFormula(HYPERLINK_HIS);
  sh.getRange('H6').setFormula(HYPERLINK_HER);
  sh.getRange('B10').setValue('Body weight (lb)');
  sh.getRange('C10').setFormula(firstFormula('E'));
  sh.setComputed('C10', 185);
  sh.getRange('E10').setValue(155);
  sh.getRange('C24').setFormula(firstFormula('K'));
  sh.getRange('F14').setFormula(`=IFERROR(AVERAGE('Weekly Check-in'!$I$5:$I$26),"")`);
  sh.getRange('H10').setFormula(
    `=IF(F10="","Log Monday weigh-ins",IF(F10<=E10,"✓ GOAL HIT!","✓ On pace"))`,
  );
  for (const [a1, col] of Object.entries(DASHBOARD_LOOKUPS)) sh.getRange(a1).setFormula(lookupFormula(col));
  ss.setNamedRange('CurWeek', 'Dashboard', 'C5');
  return sh;
}

const HOW_TO_USE = [
  ['Yellow cells', 'are the only cells you type in. Everything else (Dashboard, charts, targets, completion %) calculates itself.'],
  ['Workouts tabs', 'Every session for all 22 weeks. For each exercise enter Weight (lb), Reps done and pick ✓ in Done.'],
  ['Example entry', 'Barbell Bench Press → Weight: 185 · Reps done: 8,8,7,6 · Done: ✓'],
  ['Weekly Check-in', 'Every Monday morning (after the bathroom, before food): weigh in. Measure waist (and his shoulders/chest) every other Monday. Enter average daily steps for the past week.'],
  ['Dashboard', 'Check it together on Mondays. Progress bars fill toward each goal; the charts show your line vs. the target line.'],
  ['Filter', 'Use the filter arrows on the Workouts header to show a single week (Wk column) or day.'],
];

function seedGamePlan(ss) {
  const sh = ss.addSheet('Game Plan', IDS.gamePlan, 60, 8);
  sh.getRange('B1').setValue('THE GAME PLAN');
  sh.getRange('B5').setValue('Plan starts');
  sh.getRange('C5').setValue(planDate(0));
  sh.getRange('B6').setValue('Event');
  sh.getRange('C6').setValue(parseDate('2027-02-27', TZ, 'yyyy-MM-dd'));
  sh.getRange('B40').setValue('NUTRITION TARGETS (estimates — adjust by results)');
  sh.getRange('B44').setValue('');
  sh.getRange('C44').setValue('Build: aim to gain ~¼ lb/week.');
  sh.getRange('C44:F44').merge();
  sh.getRange('B46').setValue('HOW TO USE THIS WORKBOOK').setBackground('#1f2a44').setFontWeight('bold');
  sh.getRange('C46:F46').setBackground('#1f2a44');
  HOW_TO_USE.forEach(([label, text], i) => {
    const r = 47 + i;
    sh.getRange(`B${r}`).setValue(label).setFontWeight('bold').setFontSize(10).setWrap(true);
    sh.getRange(`C${r}`).setValue(text).setFontSize(10).setWrap(true);
    sh.getRange(`C${r}:F${r}`).merge();
    sh.setRowHeight(r, 30);
  });
  sh.getRange('B47').setBackground(YELLOW);
  ss.setNamedRange('StartDate', 'Game Plan', 'C5');
  ss.setNamedRange('EventDate', 'Game Plan', 'C6');
  return sh;
}

function seedCheckin(ss) {
  const sh = ss.addSheet('Weekly Check-in', IDS.checkin, 40, 20);
  sh.getRange('A1').setValue('WEEKLY CHECK-IN');
  sh.getRange('A2').setValue('Every Monday morning: weigh in (after bathroom, before food). Measure waist / shoulders / chest every other week. Yellow = you fill in; lifts and plan % fill in automatically from the Workouts tabs.');
  sh.getRange('D3').setValue('HER  —  goal 155 lb');
  sh.getRange('D3:I3').merge();
  sh.getRange('J3').setValue('HIM  —  build, then lean out');
  sh.getRange('J3:S3').merge();
  sh.getRange('A4:T4').setValues([CHECKIN_HEADERS]);
  for (let w = 1; w <= 22; w++) {
    const r = w + 4;
    sh.getRange(`A${r}`).setValue(w);
    sh.getRange(`B${r}`).setFormula(`=StartDate+${7 * (w - 1)}`);
    sh.setComputed(`B${r}`, planDate(7 * (w - 1)));
    sh.getRange(`C${r}`).setValue(PHASES[w - 1]);
    sh.getRange(`D${r}`).setFormula(
      `=IF(OR(Dashboard!$C$10="",Dashboard!$E$10=""),"",ROUND(Dashboard!$E$10+(Dashboard!$C$10-Dashboard!$E$10)*(1-(B${r}-StartDate)/(EventDate-StartDate))^1.1,1))`,
    );
    sh.getRange(`I${r}`).setFormula(`=IF(B${r}>TODAY(),"",1)`);
    sh.getRange(`J${r}`).setFormula(
      `=IF(Dashboard!$C$24="","",ROUND(IF(A${r}<=13,Dashboard!$C$24+3*(A${r}-1)/12,Dashboard!$C$24+3+(Dashboard!$D$24-3)*(A${r}-13)/9),1))`,
    );
    for (const col of ['E', 'F', 'G', 'K', 'L', 'M', 'N']) {
      sh.getRange(`${col}${r}`).setBackground(YELLOW).setNumberFormat('0.0');
    }
  }
  sh.getRange('E5').setValue(185);
  sh.setComputed('D5', 185);
  sh.setFrozenRows(4);
  sh.setFrozenColumns(3);
  sh.setConditionalFormatRules([
    makeRule({ formula: '=$A5=CurWeek', background: '#dbeafe', ranges: [sh.getRange('A5:C26')] }),
    makeRule({ kind: 'gradient', ranges: [sh.getRange('I5:I26')] }),
  ]);
  return sh;
}

function seedWorkouts(ss, name, id) {
  const sh = ss.addSheet(name, id, 1500, 12);
  sh.getRange('A1').setValue(name.toUpperCase());
  sh.getRange('A2').setValue('Wk');
  for (let w = 1; w <= 22; w++) sh.getRange(`A${3 + (w - 1) * 20}`).setValue(w);
  return sh;
}

/** A fresh copy of the converted workbook, before Diced setup. */
function buildWorkbook() {
  const ss = new FakeSpreadsheet({ name: 'Road to Feb 27 Training Plan', timeZone: TZ });
  seedDashboard(ss);
  seedGamePlan(ss);
  seedCheckin(ss);
  seedWorkouts(ss, 'His Workouts', IDS.his);
  seedWorkouts(ss, 'Her Workouts', IDS.her);
  ss.addSheet('Exercise Library', IDS.library, 100, 10).getRange('A1').setValue('EXERCISE LIBRARY');
  ss.addSheet('Chart Data', IDS.chart, 30, 14).getRange('A1').setValue('Week');
  return ss;
}

module.exports = {
  buildWorkbook, planDate, ymdPlus, lookupFormula, TZ, IDS, DASHBOARD_LOOKUPS,
  HYPERLINK_HIS, HYPERLINK_HER, HOW_TO_USE,
};
