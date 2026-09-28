/** Read a bathroom-scale display from a photo. OWNER: AI builder. */
import type { Confidence, WeightUnit } from '../types';
import type { PreparedImage } from '../photos/images';

export interface ScaleReading {
  /** false when the photo does not actually show a readable scale display. */
  isScale: boolean;
  value: number | null;
  unit: WeightUnit | null;
  confidence: Confidence;
  /** Why confidence is not high (glare, blur, display mid-update, ...). */
  issues: string[];
}

/**
 * Structured-output call (effort `medium`). `expectedUnit` is the user's scale unit;
 * `recentLb` (optional) is only used to break ambiguity between digit readings, never to
 * invent a value. Pure helper `toPounds` is exported for tests.
 */
export async function readScale(
  image: PreparedImage,
  opts: { expectedUnit: WeightUnit; recentLb: number | null },
): Promise<ScaleReading> {
  throw new Error('not implemented');
}

export function toPounds(value: number, unit: WeightUnit): number {
  throw new Error('not implemented');
}
