/**
 * Shared request plumbing for every Claude call: model/beta/fallback params, image blocks,
 * structured-output parsing with refusal and truncation handling. OWNER: AI builder.
 */
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import type { AutoParseableBetaOutputFormat } from '@anthropic-ai/sdk/lib/beta-parser';
import type {
  BetaContentBlockParam,
  BetaImageBlockParam,
  BetaTextBlockParam,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type { z } from 'zod';
import type { PreparedImage } from '../photos/images';
import { errorMessage } from '../lib/log';
import {
  AiResponseError,
  assertNotRefused,
  FALLBACK_BETA,
  getAnthropic,
  resolveModel,
  toAiError,
} from './client';

export type Effort = 'low' | 'medium' | 'high';

/** Non-streaming ceiling; adaptive thinking counts toward it, so leave room beyond the JSON. */
export const MAX_TOKENS = 16_000;

/**
 * Per-attempt HTTP timeout by effort. A non-streaming response arrives only once generation is
 * done, and thinking (always on for Opus 5.5) counts toward MAX_TOKENS, so a high-effort meal
 * estimate that uses a good part of that budget legitimately runs past two minutes. Cutting it
 * off would make the SDK retry it from scratch (re-billing the abandoned attempt) and finally
 * fail. `high` therefore gets the SDK's own non-streaming ceiling for this max_tokens (10 min);
 * the cheap calls keep short limits so a stalled connection is noticed quickly.
 */
export const REQUEST_TIMEOUT_BY_EFFORT: Readonly<Record<Effort, number>> = {
  low: 120_000,
  medium: 300_000,
  high: 600_000,
};

/** Optional per-call options (additive to the declared signatures). */
export interface AiCallOptions {
  /** Cancels the HTTP request (e.g. the run's abort signal). */
  signal?: AbortSignal;
}

/** Parameters every request shares: model, output ceiling and the server-side refusal fallback. */
export function baseParams(model: string) {
  return {
    model,
    max_tokens: MAX_TOKENS,
    betas: [FALLBACK_BETA],
    fallbacks: 'default' as const,
  };
}

/** The system prompt as one cacheable block — it is a constant, so repeat calls hit the cache. */
export function systemBlocks(text: string): BetaTextBlockParam[] {
  return [{ type: 'text', text, cache_control: { type: 'ephemeral' } }];
}

export function imageBlock(image: PreparedImage): BetaImageBlockParam {
  return { type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.base64 } };
}

/**
 * Images first, then the instructions/data text. With several images each gets a short label
 * (e.g. `Photo 2`) right before it, as the vision docs recommend, so the model can refer to them
 * by number.
 */
export function userContent(images: { image: PreparedImage; label?: string }[], text: string): BetaContentBlockParam[] {
  const blocks: BetaContentBlockParam[] = [];
  for (const { image, label } of images) {
    if (label) blocks.push({ type: 'text', text: `${label}:` });
    blocks.push(imageBlock(image));
  }
  blocks.push({ type: 'text', text });
  return blocks;
}

/**
 * The SDK's zod format throws from inside `parse()` when the text doesn't validate, which would
 * hide a refusal or a max_tokens cut-off. This wrapper records the error and yields null instead,
 * so the caller can check `stop_reason` first and then explain what went wrong.
 */
function lenientFormat<S extends z.ZodType>(schema: S) {
  const strict = betaZodOutputFormat(schema);
  let parseError: unknown = null;
  const format: AutoParseableBetaOutputFormat<z.infer<S> | null> = {
    ...strict,
    parse: (text: string) => {
      try {
        return strict.parse(text);
      } catch (e) {
        parseError = e;
        return null;
      }
    },
  };
  return { format, parseError: () => parseError };
}

export interface StructuredRequest<S extends z.ZodType> {
  /** Verb phrase for messages, e.g. `read the scale`. */
  task: string;
  schema: S;
  system: string;
  content: BetaContentBlockParam[];
  effort: Effort;
}

export interface StructuredResult<T> {
  data: T;
  /** The model that produced the answer (differs from Settings after a server-side fallback). */
  model: string;
}

/** One structured-output request. Throws AiRefusalError / AiApiError / AiResponseError. */
export async function structuredCall<S extends z.ZodType>(
  req: StructuredRequest<S>,
  opts: AiCallOptions = {},
): Promise<StructuredResult<z.infer<S>>> {
  const client = await getAnthropic();
  const model = await resolveModel();
  const { format, parseError } = lenientFormat(req.schema);
  let message;
  try {
    message = await client.beta.messages.parse(
      {
        ...baseParams(model),
        system: systemBlocks(req.system),
        messages: [{ role: 'user', content: req.content }],
        output_config: { effort: req.effort, format },
      },
      { signal: opts.signal, timeout: REQUEST_TIMEOUT_BY_EFFORT[req.effort] },
    );
  } catch (e) {
    throw toAiError(e, model);
  }
  assertNotRefused(message, req.task);
  const data = message.parsed_output;
  if (data === null || data === undefined) {
    throw new AiResponseError(missingOutputMessage(req.task, message.stop_reason, parseError()));
  }
  return { data, model: message.model };
}

function missingOutputMessage(task: string, stopReason: string | null, parseError: unknown): string {
  if (stopReason === 'max_tokens') return `Claude's answer was cut off while trying to ${task}; try again.`;
  if (parseError) return `Claude's answer didn't match the expected format while trying to ${task}: ${errorMessage(parseError)}`;
  return `Claude returned no answer while trying to ${task} (stop reason: ${stopReason ?? 'unknown'}).`;
}
