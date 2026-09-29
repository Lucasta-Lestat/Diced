/**
 * Shared domain types for the Diced app. Every module imports from here; keep
 * this file free of runtime imports so it is safe everywhere (including tests).
 */

/** Calendar date in the device's local time zone, `YYYY-MM-DD`. */
export type LocalDate = string;

/** Wall-clock time in the device's local time zone, `HH:mm`. */
export type LocalTime = string;

/** Person label exactly as used in the sheet's Person columns (`Her` / `Him`). */
export type PersonLabel = string;

export type Confidence = 'high' | 'medium' | 'low';

// ---------------------------------------------------------------------------
// Photos
// ---------------------------------------------------------------------------

/** What a photo shows, as far as the pipeline cares. */
export type PhotoCategory = 'scale' | 'food' | 'nutrition_label' | 'other';

/** A photo in the device library (a thin, serializable view of a MediaLibrary asset). */
export interface PhotoAsset {
  id: string;
  /** `ph://` / `content://` / `file://` URI usable by expo-image and the image manipulator. */
  uri: string;
  /** Capture time, ms since epoch. */
  creationTime: number;
  width: number;
  height: number;
  filename: string | null;
  /** iOS only, e.g. `['screenshot']`. Empty on Android. */
  mediaSubtypes: string[];
  /** Where the photo came from. `capture` = taken inside the app's quick-log screen. */
  origin: 'library' | 'capture';
  /** Category chosen at capture time (quick log), so classification can be skipped. */
  presetCategory?: PhotoCategory | null;
  /**
   * The photo sits in an album a messaging app saves received images to (e.g. `WhatsApp`),
   * so it is excluded like a messaging-app file name. Best-effort; absent when unknown.
   */
  fromMessagingAlbum?: boolean;
}

/** Per-photo processing state persisted in SQLite (table `photos`). */
export interface PhotoRecord {
  assetId: string;
  uri: string;
  creationTime: number;
  localDate: LocalDate;
  origin: 'library' | 'capture';
  /** Heuristic exclusion (e.g. `screenshot`) — excluded photos are never sent anywhere. */
  excludedReason: string | null;
  category: PhotoCategory | null;
  categoryConfidence: number | null;
  classifiedAt: number | null;
  /** Set once the photo's weight reading / meal draft has been produced. */
  processedAt: number | null;
  /** Last processing error, if any (retried on the next run). */
  error: string | null;
}

// ---------------------------------------------------------------------------
// Review workflow
// ---------------------------------------------------------------------------

/**
 * Lifecycle of a weight or meal entry:
 * needs_review → approved → synced (or sync_error → retried) ; needs_review → rejected.
 * Editing a synced entry moves it back to `approved` so the next sync upserts it.
 */
export type EntryStatus = 'needs_review' | 'approved' | 'rejected' | 'synced' | 'sync_error';

export type WeightUnit = 'lb' | 'kg';

/** One scale reading extracted from one photo. */
export interface WeightCandidate {
  assetId: string;
  takenAt: number;
  valueLb: number;
  rawValue: number;
  rawUnit: WeightUnit;
  readConfidence: Confidence;
}

/** The official weigh-in for one person on one day (what gets written to Weight Log). */
export interface WeightEntry {
  /** Deterministic: `w:<person>:<YYYY-MM-DD>` — also the sheet Entry ID. */
  id: string;
  person: PersonLabel;
  localDate: LocalDate;
  /** Local time of the chosen reading, or null for manual entries without a time. */
  time: LocalTime | null;
  valueLb: number | null;
  /** Which candidate was chosen (null for manual). */
  chosenAssetId: string | null;
  source: 'photo' | 'capture' | 'manual';
  confidence: Confidence;
  candidates: WeightCandidate[];
  /**
   * Machine-readable review flags, e.g. `differs_from_trend`, `unit_converted`,
   * `multiple_readings`, `low_read_confidence`, `not_morning`.
   */
  flags: string[];
  notes: string;
  status: EntryStatus;
  syncError: string | null;
  updatedAt: number;
  /**
   * The user picked `chosenAssetId` by hand (review). A later run that adds readings for the
   * day keeps that choice instead of re-picking automatically. Absent = automatic choice.
   */
  chosenByUser?: boolean;
}

export type MealSlot = 'breakfast' | 'lunch' | 'dinner' | 'snack';

export type EstimateMethod = 'photo' | 'label' | 'barcode' | 'library' | 'restaurant' | 'manual';

export interface Macros {
  kcal: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
}

/** Where a food item's numbers came from. */
export type ItemSource = 'model' | 'usda' | 'label' | 'openfoodfacts' | 'library' | 'web' | 'user';

export interface FoodItem {
  name: string;
  /** Human portion description, e.g. `1 cup`, `2 slices`. */
  portion: string;
  /** Estimated edible grams (null when unknown, e.g. a whole packaged item). */
  grams: number | null;
  macros: Macros;
  source: ItemSource;
  confidence: Confidence;
  /** Search phrase suitable for USDA FoodData Central, from the model. */
  usdaQuery: string | null;
  /** FoodData Central id when the numbers were reconciled against USDA. */
  fdcId: number | null;
  /** The model's own numbers before reconciliation (kept for transparency). */
  modelMacros: Macros | null;
}

export interface ClarifyingQuestion {
  id: string;
  question: string;
  /** Short answer chips, e.g. `['None', '1 tsp', '1 tbsp']`. */
  options: string[];
  /** Which item(s) the answer affects, by name. */
  affects: string[];
}

export interface MealEstimate {
  title: string;
  items: FoodItem[];
  totals: Macros;
  /** Plausible range for total calories. */
  kcalLow: number;
  kcalHigh: number;
  confidence: Confidence;
  method: EstimateMethod;
  questions: ClarifyingQuestion[];
  /** Assumptions the estimate relies on (hidden oil, portion basis, ...). */
  assumptions: string[];
  /** Food Library item the meal was matched to, if any. */
  libraryItemId: string | null;
  /** Restaurant / brand, if recognised. */
  brand: string | null;
  /** Barcode digits read from the photo, if any (validated GTIN). */
  barcode: string | null;
  /** Model id that produced the estimate (after any server-side fallback). */
  model: string;
  /** How many independent estimates were averaged (thorough mode = 2). */
  samples: number;
  createdAt: number;
  /**
   * The photos show only what was left after eating (a partly eaten or empty plate) and no
   * photo of the food before it. The pipeline then adds them to the earlier photos of the same
   * meal when it can. Absent = false.
   */
  leftoversOnly?: boolean;
}

export interface MealEntry {
  /** uuid v4 — also the sheet Entry ID. */
  id: string;
  person: PersonLabel;
  localDate: LocalDate;
  time: LocalTime;
  slot: MealSlot;
  /** Photos that make up this meal (several angles / before-after). */
  assetIds: string[];
  estimate: MealEstimate | null;
  /** What will be written to the sheet (starts as a copy of the estimate totals). */
  final: Macros;
  title: string;
  /** Answers to the estimate's clarifying questions, by question id. */
  answers: Record<string, string>;
  notes: string;
  status: EntryStatus;
  /** Pipeline error (estimation failed) or sync error. */
  error: string | null;
  updatedAt: number;
  /**
   * The meal's row may be in the Food Log: it was synced at least once, or it was approved /
   * sync_error before a re-estimate or merge moved it back to needs_review. Rejecting it must
   * then delete the row. Absent = never reached the sheet.
   */
  inSheet?: boolean;
}

/** A "usual meal" with confirmed numbers, shared between phones via the sheet. */
export interface LibraryItem {
  id: string;
  name: string;
  serving: string;
  macros: Macros;
  aliases: string[];
  addedBy: PersonLabel;
  /** Uses as last read from (or written to) the sheet. */
  uses: number;
  /** When the name / serving / numbers last changed (a use doesn't change it). */
  updatedAt: number;
  /** false until the item's content is pushed to the sheet. */
  synced: boolean;
  /**
   * Uses counted on this phone that the sheet doesn't have yet. They are added to the sheet's
   * count on the next sync instead of overwriting it, so the two phones' counts add up.
   */
  pendingUses?: number;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export type ClassificationMode = 'cloud_thumbnails' | 'manual';
export type AccuracyMode = 'standard' | 'thorough';

/** Non-secret settings (persisted in SQLite `kv`). Secrets live in SecureStore. */
export interface AppSettings {
  /** Which person this phone logs for (`Her` / `Him`). */
  person: PersonLabel | null;
  /** Apps Script web-app URL (`https://script.google.com/macros/s/.../exec`). */
  sheetWebAppUrl: string | null;
  /** ISO weekday of the weekly run: 1 = Monday … 7 = Sunday. */
  scheduleWeekday: number;
  scheduleHour: number;
  scheduleMinute: number;
  /** Also process new photos once a day in the background (Android; best-effort on iOS). */
  processDaily: boolean;
  /**
   * `cloud_thumbnails`: small, metadata-stripped thumbnails are sent to Claude to find
   * scale and food photos. `manual`: nothing is scanned automatically; the user picks
   * photos or uses quick capture.
   */
  classificationMode: ClassificationMode;
  /** `thorough` runs two independent estimates per meal and flags disagreement. */
  accuracyMode: AccuracyMode;
  /** Allow a web search for published nutrition when a restaurant/brand is recognised. */
  webLookupForRestaurants: boolean;
  /** Diameter of the household's usual dinner plate, for portion scale. */
  plateDiameterIn: number | null;
  /** Unit the scale displays (readings are always stored in lb). */
  scaleUnit: WeightUnit;
  /** Food photos closer together than this belong to the same meal. */
  mealGroupingMinutes: number;
  /** Readings before this hour count as the "morning" weigh-in. */
  morningCutoffHour: number;
  /** Claude model id. */
  model: string;
  /** End (ms) of the last completed scan window; next scan starts here. */
  lastScanEnd: number | null;
  /** When the last scheduled/automatic run finished (ms). */
  lastAutoRunAt: number | null;
  onboardingComplete: boolean;
}

export type SecretName = 'anthropicApiKey' | 'sheetToken' | 'usdaApiKey';

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

export type RunReason = 'manual' | 'weekly' | 'daily' | 'deeplink' | 'capture' | 'background';

export interface ProcessProgress {
  stage: 'scanning' | 'classifying' | 'reading_scale' | 'estimating_meals' | 'saving' | 'done';
  done: number;
  total: number;
  message: string;
}

export interface ProcessResult {
  reason: RunReason;
  windowStart: number;
  windowEnd: number;
  photosScanned: number;
  photosExcluded: number;
  photosClassified: number;
  scalePhotos: number;
  foodPhotos: number;
  weightEntriesCreated: number;
  mealsCreated: number;
  errors: string[];
  /** true when the time budget ran out; the rest is picked up next run. */
  partial: boolean;
}
