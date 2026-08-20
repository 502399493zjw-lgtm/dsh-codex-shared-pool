/** Models whose bundled Codex catalog advertises the priority Fast tier. */
export const CODEX_FAST_MODEL_IDS = [
  'gpt-5.4',
  'gpt-5.5',
  'gpt-5.6-luna',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
] as const

const fastModels = new Set<string>(CODEX_FAST_MODEL_IDS)

/**
 * Whether the selected Codex model accepts `service_tier: "priority"`.
 *
 * @param modelId - Codex model identifier.
 * @returns True when the bundled catalog advertises the Fast tier.
 */
export function supportsCodexFastMode(modelId: string): boolean {
  return fastModels.has(modelId)
}
