/**
 * Wire contract with the Apps Script web app (see docs/SHEET_SCHEMA.md).
 * Mirrors `apps-script/Code.gs`; change both together.
 */

export type SheetConfidence = 'high' | 'medium' | 'low';

export interface SheetWeightRow {
  entryId: string;
  /** `YYYY-MM-DD` */
  date: string;
  /** `HH:mm` or '' */
  time: string;
  person: string;
  weightLb: number;
  source: 'photo' | 'capture' | 'manual' | 'migrated';
  confidence: SheetConfidence;
  notes: string;
}

export interface SheetMealRow {
  entryId: string;
  date: string;
  time: string;
  person: string;
  meal: 'Breakfast' | 'Lunch' | 'Dinner' | 'Snack';
  description: string;
  kcal: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
  confidence: SheetConfidence;
  method: 'photo' | 'label' | 'barcode' | 'library' | 'restaurant' | 'manual';
  /** `chicken breast 150 g (248 kcal) · white rice 180 g (234 kcal)` */
  items: string;
  notes: string;
}

export interface SheetLibraryItem {
  entryId: string;
  name: string;
  serving: string;
  kcal: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
  aliases: string[];
  /** Person label, or '' when a hand-typed sheet row left Added by blank. */
  addedBy: string;
  uses: number;
  /** ISO timestamp */
  updatedAt: string;
}

export interface SheetSummaryDay {
  date: string;
  week: number;
  weightLb: number | null;
  kcal: number | null;
  proteinG: number | null;
  kcalTarget: number | null;
  meals: number;
}

export interface SheetSummaryWeek {
  week: number;
  /** `YYYY-MM-DD` of that week's Monday */
  monday: string;
  avgWeightLb: number | null;
  targetWeightLb: number | null;
  avgKcal: number | null;
  avgProteinG: number | null;
  daysLogged: number;
  impliedMaintenance: number | null;
}

export interface SheetSummary {
  person: string;
  days: SheetSummaryDay[];
  weeks: SheetSummaryWeek[];
  currentWeek: number;
}

export interface PingData {
  version: string;
  schemaVersion: number;
  spreadsheetName: string;
  timezone: string;
  people: string[];
  startDate: string;
  eventDate: string;
}

export interface UpsertResult {
  inserted: number;
  updated: number;
}

export interface ActionMap {
  ping: { payload: Record<string, never>; data: PingData };
  upsertWeights: { payload: { entries: SheetWeightRow[] }; data: UpsertResult };
  upsertMeals: { payload: { entries: SheetMealRow[] }; data: UpsertResult };
  deleteEntries: {
    payload: { kind: 'weight' | 'meal' | 'library'; entryIds: string[] };
    data: { deleted: number };
  };
  getSummary: { payload: { person: string; from: string; to: string }; data: SheetSummary };
  listLibrary: { payload: Record<string, never>; data: { items: SheetLibraryItem[] } };
  upsertLibrary: { payload: { items: SheetLibraryItem[] }; data: UpsertResult };
}

export type ActionName = keyof ActionMap;

export interface RequestBody<A extends ActionName = ActionName> {
  token: string;
  action: A;
  payload: ActionMap[A]['payload'];
}

export type ErrorCode = 'unauthorized' | 'bad_request' | 'not_found' | 'internal';

export type ResponseBody<A extends ActionName = ActionName> =
  | { ok: true; data: ActionMap[A]['data'] }
  | { ok: false; error: { code: ErrorCode; message: string } };
