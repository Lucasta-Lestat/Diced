/** Published-nutrition lookup for chain restaurants / packaged brands via web search. OWNER: AI builder. */
import type Anthropic from '@anthropic-ai/sdk';
import type {
  BetaMessage,
  BetaMessageParam,
  BetaTool,
  BetaToolUseBlock,
  BetaWebSearchTool20260209,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type { Macros } from '../types';
import { assertNotRefused, getAnthropic, resolveModel, toAiError } from './client';
import { RESTAURANT_SYSTEM, restaurantUserText } from './prompts';
import { type AiCallOptions, baseParams, REQUEST_TIMEOUT_BY_EFFORT, systemBlocks } from './request';
import { toPublishedNutrition } from './schemas';

export interface PublishedNutrition {
  source: string; // URL
  itemName: string;
  macros: Macros;
  servingNote: string;
}

export const REPORT_TOOL_NAME = 'report_nutrition';
/** A long server-side search can pause the turn; resume it at most this many times. */
export const MAX_PAUSE_CONTINUATIONS = 3;

const WEB_SEARCH_TOOL: BetaWebSearchTool20260209 = { type: 'web_search_20260209', name: 'web_search', max_uses: 3 };

function nullable(type: 'string' | 'number', description: string) {
  return { anyOf: [{ type }, { type: 'null' }], description };
}

export const REPORT_NUTRITION_TOOL: BetaTool = {
  name: REPORT_TOOL_NAME,
  description:
    'Report the officially published nutrition for the requested item. Call this exactly once, at the end, after searching. ' +
    'If you found no published numbers for this exact item, call it with found=false and null for every other field.',
  strict: true,
  input_schema: {
    type: 'object',
    properties: {
      found: { type: 'boolean', description: 'True only if published numbers for this exact item were found.' },
      source_url: nullable('string', 'URL of the page (or PDF) the numbers come from.'),
      item_name: nullable('string', 'The item name exactly as the brand lists it.'),
      kcal: nullable('number', 'Calories for the whole item as served.'),
      protein_g: nullable('number', 'Protein in grams.'),
      carbs_g: nullable('number', 'Total carbohydrate in grams.'),
      fat_g: nullable('number', 'Total fat in grams.'),
      serving_note: nullable('string', 'Size/serving the numbers are for, e.g. "1 burrito, regular, US menu".'),
    },
    required: ['found', 'source_url', 'item_name', 'kcal', 'protein_g', 'carbs_g', 'fat_g', 'serving_note'],
    additionalProperties: false,
  },
};

async function send(client: Anthropic, model: string, messages: BetaMessageParam[], opts: AiCallOptions): Promise<BetaMessage> {
  try {
    return await client.beta.messages.create(
      {
        ...baseParams(model),
        system: systemBlocks(RESTAURANT_SYSTEM),
        messages,
        tools: [WEB_SEARCH_TOOL, REPORT_NUTRITION_TOOL],
        tool_choice: { type: 'auto' },
        output_config: { effort: 'medium' },
      },
      // Server-side searches add to the turn; a very long one comes back as pause_turn instead.
      { signal: opts.signal, timeout: REQUEST_TIMEOUT_BY_EFFORT.medium },
    );
  } catch (e) {
    throw toAiError(e, model);
  }
}

function findReport(message: BetaMessage): BetaToolUseBlock | undefined {
  return message.content.find((b): b is BetaToolUseBlock => b.type === 'tool_use' && b.name === REPORT_TOOL_NAME);
}

/**
 * Uses the `web_search_20260209` server tool plus a strict `report_nutrition` client tool
 * (tool_choice auto) to return official numbers for `brand` + `dish`, or null when nothing
 * reliable is found. Handles `pause_turn`. Throws on refusals and API errors (AiRefusalError /
 * AiApiError) — callers treat the lookup as optional and should fall back to the photo estimate.
 */
export async function lookupPublishedNutrition(
  brand: string,
  dish: string,
  opts: AiCallOptions = {},
): Promise<PublishedNutrition | null> {
  if (!brand.trim() || !dish.trim()) return null;
  const client = await getAnthropic();
  const model = await resolveModel();
  const messages: BetaMessageParam[] = [{ role: 'user', content: restaurantUserText(brand, dish) }];
  for (let turn = 0; turn <= MAX_PAUSE_CONTINUATIONS; turn++) {
    const message = await send(client, model, messages, opts);
    assertNotRefused(message, `look up nutrition for ${dish}`);
    const report = findReport(message);
    if (report) return toPublishedNutrition(report.input, dish);
    if (message.stop_reason !== 'pause_turn') return null;
    // Resume: send the paused assistant turn back unchanged; the server continues where it stopped.
    messages.push({ role: 'assistant', content: message.content });
  }
  return null;
}
