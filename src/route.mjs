/**
 * Builds the configuration of the plugin's own `@deepseek-ai/dsh-llm-pi-ai` instance: one
 * provider route per Space, which is what the Harness model selector lists.
 * Contract: docs/contracts.md, section 2, "Model selector".
 */

/**
 * Wire settings for OpenAI-compatible self-hosted servers such as llama.cpp: the system prompt
 * goes as `system` (pi-ai would send `developer` to reasoning models) and the output cap as
 * `max_tokens`. Seen with llama.cpp on 2026-10-19 by the private prototype.
 */
export const COMPAT = Object.freeze({ supportsDeveloperRole: false, maxTokensField: 'max_tokens' });

/**
 * @param spaces - effective Spaces (manifest.mjs, effectiveSpace)
 * @param credentials - normalized credential names
 * @returns the `config` of a dsh-llm-pi-ai instance
 */
export function buildProviders(spaces, credentials) {
  const providers = {};
  for (const space of spaces) {
    const models = space.models.value;
    providers[space.route] = {
      displayName: space.label,
      api: 'openai-completions',
      baseURL: space.baseURL.value,
      apiKeyEnv: credentials.inference,
      ...(space.defaultEffort ? { reasoning: space.defaultEffort.value } : {}),
      compat: { ...COMPAT, supportsReasoningEffort: models.some(m => m.reasoning) },
      models: models.map(m => ({
        id: m.id,
        name: m.name,
        ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
        ...(m.maxTokens ? { maxTokens: m.maxTokens } : {}),
        // `false` keeps the selector from offering an effort control the server would ignore.
        reasoningEfforts: m.reasoning ? { ...m.reasoning } : false,
      })),
    };
  }
  return { providers };
}

/** One log line per Space: what it serves and where each value came from. */
export function describeSpace(space) {
  const models = space.models.value;
  const parts = [
    `route ${space.route}`,
    `address from ${space.baseURL.source}`,
    `${models.length} model${models.length === 1 ? '' : 's'} from ${space.models.source} (${models.map(m => m.name).join(', ')})`,
    space.defaultEffort ? `default effort ${space.defaultEffort.value} (${space.defaultEffort.source})` : 'no default effort',
  ];
  return `${space.id}: ${parts.join('; ')}`;
}
