/** Processing run history (table `runs`). OWNER: data-layer builder. */
import type { ProcessResult } from '../types';

export interface RunRecord extends ProcessResult {
  id: number;
  startedAt: number;
  finishedAt: number;
}

export async function recordRun(startedAt: number, result: ProcessResult): Promise<void> {
  throw new Error('not implemented');
}

export async function lastRuns(limit: number): Promise<RunRecord[]> {
  throw new Error('not implemented');
}
