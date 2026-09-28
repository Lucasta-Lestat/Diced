/** Published-nutrition lookup for chain restaurants / packaged brands via web search. OWNER: AI builder. */
import type { Macros } from '../types';

export interface PublishedNutrition {
  source: string; // URL
  itemName: string;
  macros: Macros;
  servingNote: string;
}

/**
 * Uses the `web_search_20260209` server tool plus a strict `report_nutrition` client tool
 * (tool_choice auto) to return official numbers for `brand` + `dish`, or null when nothing
 * reliable is found. Handles `pause_turn`.
 */
export async function lookupPublishedNutrition(brand: string, dish: string): Promise<PublishedNutrition | null> {
  throw new Error('not implemented');
}
