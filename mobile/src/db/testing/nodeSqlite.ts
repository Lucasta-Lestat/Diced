/// <reference types="jest" />
/**
 * TEST ONLY — an in-memory stand-in for expo-sqlite's SQLiteDatabase backed by Node's
 * built-in `node:sqlite`, so repository SQL runs for real under Jest:
 *
 *   jest.mock('expo-sqlite', () => require('../testing/nodeSqlite').expoSqliteMock());
 *
 * Implements only the methods the data layer uses. Never import from app code.
 */

// Typed locally instead of via @types/node so Node globals don't leak into the app's
// type program (this file is compiled with the rest of src/).
type SQLInputValue = null | number | bigint | string | Uint8Array;
type Row = Record<string, unknown>;
interface NodeStatement {
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...params: unknown[]): Row | undefined;
  all(...params: unknown[]): Row[];
}
interface NodeDatabase {
  exec(sql: string): void;
  prepare(sql: string): NodeStatement;
  close(): void;
}
const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: new (path: string) => NodeDatabase };

type BindArgs = unknown[];

function toValue(v: unknown): SQLInputValue {
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v === undefined) return null;
  return v as SQLInputValue;
}

/** expo-sqlite accepts `(sql, [a, b])`, `(sql, a, b)` or `(sql, { $a: 1 })`. */
function bind(args: BindArgs): { positional: SQLInputValue[] } | { named: Record<string, SQLInputValue> } {
  if (args.length === 1 && Array.isArray(args[0])) return { positional: args[0].map(toValue) };
  if (args.length === 1 && args[0] !== null && typeof args[0] === 'object' && !(args[0] instanceof Uint8Array)) {
    const named: Record<string, SQLInputValue> = {};
    for (const [k, v] of Object.entries(args[0] as Record<string, unknown>)) named[k] = toValue(v);
    return { named };
  }
  return { positional: args.map(toValue) };
}

export function createNodeSqliteDb() {
  const raw = new DatabaseSync(':memory:');
  const statement = (sql: string, args: BindArgs) => {
    const stmt = raw.prepare(sql);
    const b = bind(args);
    return {
      run: () => ('named' in b ? stmt.run(b.named) : stmt.run(...b.positional)),
      get: () => ('named' in b ? stmt.get(b.named) : stmt.get(...b.positional)),
      all: () => ('named' in b ? stmt.all(b.named) : stmt.all(...b.positional)),
    };
  };
  return {
    databasePath: ':memory:',
    async execAsync(sql: string): Promise<void> {
      raw.exec(sql);
    },
    async runAsync(sql: string, ...args: BindArgs) {
      const r = statement(sql, args).run();
      return { lastInsertRowId: Number(r.lastInsertRowid), changes: Number(r.changes) };
    },
    async getFirstAsync<T>(sql: string, ...args: BindArgs): Promise<T | null> {
      const row = statement(sql, args).get();
      return row ? ({ ...row } as T) : null;
    },
    async getAllAsync<T>(sql: string, ...args: BindArgs): Promise<T[]> {
      return statement(sql, args)
        .all()
        .map((row) => ({ ...row }) as T);
    },
    async withTransactionAsync(task: () => Promise<void>): Promise<void> {
      raw.exec('BEGIN');
      try {
        await task();
        raw.exec('COMMIT');
      } catch (e) {
        raw.exec('ROLLBACK');
        throw e;
      }
    },
    async closeAsync(): Promise<void> {
      raw.close();
    },
  };
}

/** Module shape for `jest.mock('expo-sqlite', …)`: every open gets a fresh in-memory db. */
export function expoSqliteMock() {
  return {
    openDatabaseAsync: jest.fn(async () => createNodeSqliteDb()),
  };
}
