/** Batch photo classification from thumbnails. OWNER: AI builder. */
import type { PhotoCategory } from '../types';
import type { PreparedImage } from '../photos/images';
import { CLASSIFY_SYSTEM, classifyLabel, classifyUserText } from './prompts';
import { type AiCallOptions, structuredCall, userContent } from './request';
import { ClassifySchema, toClassifyResults } from './schemas';

export interface ClassifyInput {
  assetId: string;
  image: PreparedImage;
}

export interface ClassifyOutput {
  category: PhotoCategory;
  /** 0..1 */
  confidence: number;
}

/** Thumbnails per request; larger batches are split (sequentially) into requests of this size. */
export const CLASSIFY_BATCH_SIZE = 16;

async function classifyChunk(inputs: ClassifyInput[], opts: AiCallOptions): Promise<Record<string, ClassifyOutput>> {
  const images = inputs.map((input, i) => ({ image: input.image, label: classifyLabel(i) }));
  const { data } = await structuredCall(
    {
      task: 'classify photos',
      schema: ClassifySchema,
      system: CLASSIFY_SYSTEM,
      content: userContent(images, classifyUserText(inputs.length)),
      effort: 'low',
    },
    opts,
  );
  return toClassifyResults(
    data,
    inputs.map((input) => input.assetId),
  );
}

/**
 * Classify up to 16 thumbnails in one request (structured output, effort `low`).
 * Returns a result for every input id (missing ids from the model → 'other', 0).
 */
export async function classifyBatch(
  inputs: ClassifyInput[],
  opts: AiCallOptions = {},
): Promise<Record<string, ClassifyOutput>> {
  const results: Record<string, ClassifyOutput> = {};
  for (let start = 0; start < inputs.length; start += CLASSIFY_BATCH_SIZE) {
    Object.assign(results, await classifyChunk(inputs.slice(start, start + CLASSIFY_BATCH_SIZE), opts));
  }
  return results;
}
