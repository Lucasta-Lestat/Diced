/** Read a bathroom-scale display from a photo. OWNER: AI builder. */
import type { Confidence, WeightUnit } from '../types';
import type { PreparedImage } from '../photos/images';
import { SCALE_SYSTEM, scaleUserText } from './prompts';
import { type AiCallOptions, structuredCall, userContent } from './request';
import { ScaleSchema, toScaleReading } from './schemas';

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
  callOpts: AiCallOptions = {},
): Promise<ScaleReading> {
  const { data } = await structuredCall(
    {
      task: 'read the scale',
      schema: ScaleSchema,
      system: SCALE_SYSTEM,
      content: userContent([{ image }], scaleUserText(opts)),
      effort: 'medium',
    },
    callOpts,
  );
  return toScaleReading(data, opts.expectedUnit);
}

const LB_PER_KG = 2.20462;

export function toPounds(value: number, unit: WeightUnit): number {
  const lb = unit === 'kg' ? value * LB_PER_KG : value;
  return Math.round(lb * 10) / 10;
}
