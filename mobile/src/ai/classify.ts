/** Batch photo classification from thumbnails. OWNER: AI builder. */
import type { PhotoCategory } from '../types';
import type { PreparedImage } from '../photos/images';

export interface ClassifyInput {
  assetId: string;
  image: PreparedImage;
}

export interface ClassifyOutput {
  category: PhotoCategory;
  /** 0..1 */
  confidence: number;
}

/**
 * Classify up to 16 thumbnails in one request (structured output, effort `low`).
 * Returns a result for every input id (missing ids from the model → 'other', 0).
 */
export async function classifyBatch(inputs: ClassifyInput[]): Promise<Record<string, ClassifyOutput>> {
  throw new Error('not implemented');
}
