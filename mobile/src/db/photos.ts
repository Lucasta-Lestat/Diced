/** Photo processing state (table `photos`). OWNER: data-layer builder. */
import type { PhotoCategory, PhotoRecord } from '../types';
import { chunk, getDb, placeholders, withTransaction } from './database';

interface PhotoRow {
  asset_id: string;
  uri: string;
  creation_time: number;
  local_date: string;
  origin: string;
  excluded_reason: string | null;
  category: string | null;
  category_confidence: number | null;
  classified_at: number | null;
  processed_at: number | null;
  error: string | null;
}

const COLUMNS =
  'asset_id, uri, creation_time, local_date, origin, excluded_reason, category, ' +
  'category_confidence, classified_at, processed_at, error';
const COLUMN_COUNT = 11;
/** Stay far below SQLite's bound-parameter limit (999 on old builds). */
const ROWS_PER_INSERT = 50;
const CATEGORIES: PhotoCategory[] = ['scale', 'food', 'nutrition_label', 'other'];

function fromRow(r: PhotoRow): PhotoRecord {
  return {
    assetId: r.asset_id,
    uri: r.uri,
    creationTime: r.creation_time,
    localDate: r.local_date,
    origin: r.origin === 'capture' ? 'capture' : 'library',
    excludedReason: r.excluded_reason,
    category: (r.category as PhotoCategory | null) ?? null,
    categoryConfidence: r.category_confidence,
    classifiedAt: r.classified_at,
    processedAt: r.processed_at,
    error: r.error,
  };
}

function toParams(p: PhotoRecord): (string | number | null)[] {
  return [
    p.assetId,
    p.uri,
    p.creationTime,
    p.localDate,
    p.origin,
    p.excludedReason,
    p.category,
    p.categoryConfidence,
    p.classifiedAt,
    p.processedAt,
    p.error,
  ];
}

/** Insert records that are not yet known (existing rows are left untouched). Returns # inserted. */
export async function insertNewPhotos(records: PhotoRecord[]): Promise<number> {
  if (records.length === 0) return 0;
  return withTransaction(async (db) => {
    let inserted = 0;
    for (const batch of chunk(records, ROWS_PER_INSERT)) {
      const values = batch.map(() => `(${placeholders(COLUMN_COUNT)})`).join(', ');
      const result = await db.runAsync(
        `INSERT OR IGNORE INTO photos (${COLUMNS}) VALUES ${values}`,
        batch.flatMap(toParams),
      );
      inserted += result.changes;
    }
    return inserted;
  });
}

export async function getPhoto(assetId: string): Promise<PhotoRecord | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<PhotoRow>(`SELECT ${COLUMNS} FROM photos WHERE asset_id = ?`, assetId);
  return row ? fromRow(row) : null;
}

/** Records for the known ids, in the order of `assetIds` (unknown ids are skipped). */
export async function getPhotos(assetIds: string[]): Promise<PhotoRecord[]> {
  if (assetIds.length === 0) return [];
  const db = await getDb();
  const byId = new Map<string, PhotoRecord>();
  for (const ids of chunk([...new Set(assetIds)], 500)) {
    const rows = await db.getAllAsync<PhotoRow>(
      `SELECT ${COLUMNS} FROM photos WHERE asset_id IN (${placeholders(ids.length)})`,
      ids,
    );
    for (const r of rows) byId.set(r.asset_id, fromRow(r));
  }
  return assetIds.flatMap((id) => {
    const rec = byId.get(id);
    return rec ? [rec] : [];
  });
}

/** Photos in [startMs, endMs) that are not excluded and not yet classified, oldest first. */
export async function listUnclassified(startMs: number, endMs: number): Promise<PhotoRecord[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<PhotoRow>(
    `SELECT ${COLUMNS} FROM photos
     WHERE creation_time >= ? AND creation_time < ?
       AND excluded_reason IS NULL AND category IS NULL
     ORDER BY creation_time ASC, asset_id ASC`,
    startMs,
    endMs,
  );
  return rows.map(fromRow);
}

export async function setClassification(
  assetId: string,
  category: PhotoCategory,
  confidence: number,
): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    'UPDATE photos SET category = ?, category_confidence = ?, classified_at = ? WHERE asset_id = ?',
    category,
    confidence,
    Date.now(),
    assetId,
  );
}

/** Classified photos in the window with one of `categories` and processedAt == null, oldest first. */
export async function listUnprocessed(
  startMs: number,
  endMs: number,
  categories: PhotoCategory[],
): Promise<PhotoRecord[]> {
  if (categories.length === 0) return [];
  const db = await getDb();
  const rows = await db.getAllAsync<PhotoRow>(
    `SELECT ${COLUMNS} FROM photos
     WHERE creation_time >= ? AND creation_time < ?
       AND excluded_reason IS NULL
       AND category IN (${placeholders(categories.length)})
       AND processed_at IS NULL
     ORDER BY creation_time ASC, asset_id ASC`,
    [startMs, endMs, ...categories],
  );
  return rows.map(fromRow);
}

/** Marks photos done and clears any earlier error. */
export async function markProcessed(assetIds: string[]): Promise<void> {
  if (assetIds.length === 0) return;
  const db = await getDb();
  const now = Date.now();
  for (const ids of chunk(assetIds, 500)) {
    await db.runAsync(
      `UPDATE photos SET processed_at = ?, error = NULL WHERE asset_id IN (${placeholders(ids.length)})`,
      [now, ...ids],
    );
  }
}

export async function setPhotoError(assetId: string, error: string | null): Promise<void> {
  const db = await getDb();
  await db.runAsync('UPDATE photos SET error = ? WHERE asset_id = ?', error, assetId);
}

/** Counts by category in a window (for the home screen). */
export async function countByCategory(
  startMs: number,
  endMs: number,
): Promise<Record<PhotoCategory | 'unclassified' | 'excluded', number>> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ bucket: string; n: number }>(
    `SELECT CASE
              WHEN excluded_reason IS NOT NULL THEN 'excluded'
              WHEN category IS NULL THEN 'unclassified'
              ELSE category
            END AS bucket,
            COUNT(*) AS n
     FROM photos
     WHERE creation_time >= ? AND creation_time < ?
     GROUP BY bucket`,
    startMs,
    endMs,
  );
  const counts: Record<PhotoCategory | 'unclassified' | 'excluded', number> = {
    scale: 0,
    food: 0,
    nutrition_label: 0,
    other: 0,
    unclassified: 0,
    excluded: 0,
  };
  for (const { bucket, n } of rows) {
    if (bucket === 'unclassified' || bucket === 'excluded' || (CATEGORIES as string[]).includes(bucket)) {
      counts[bucket as keyof typeof counts] += n;
    } else {
      counts.other += n;
    }
  }
  return counts;
}
