/**
 * The optional Space manifest (`dsh-hf-spaces.json` in the Space repository) and the merge of
 * every source into one effective Space, each value tagged with where it came from.
 * See docs/design.md, section 6, "Ready to use" and "Space manifest".
 */
import { DEFAULTS, PREFERRED_DEFAULT_EFFORT, normalizeModels } from './config.mjs';

export const MANIFEST_FILE = 'dsh-hf-spaces.json';
export const MANIFEST_VERSION = 1;

/**
 * Parses and checks a manifest. An invalid manifest is refused as a whole, never applied in part.
 * @returns {{ manifest: object } | { problem: string }}
 */
export function parseManifest(text) {
  let raw;
  try { raw = JSON.parse(text); } catch { return { problem: `${MANIFEST_FILE} is not valid JSON` }; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { problem: `${MANIFEST_FILE} must be a JSON object` };
  if (raw.schemaVersion !== MANIFEST_VERSION) return { problem: `${MANIFEST_FILE}: schemaVersion must be ${MANIFEST_VERSION}` };
  const listed = normalizeModels(raw.models);
  if (listed.problems.length) return { problem: `${MANIFEST_FILE}: ${listed.problems.join('; ')}` };
  if (listed.models.length === 0) return { problem: `${MANIFEST_FILE}: \`models\` lists no model` };
  const manifest = { models: listed.models };
  if (raw.progress?.eventPrefix !== undefined) {
    if (typeof raw.progress.eventPrefix !== 'string' || !raw.progress.eventPrefix) return { problem: `${MANIFEST_FILE}: progress.eventPrefix must be text` };
    manifest.eventPrefix = raw.progress.eventPrefix;
  }
  if (raw.idleSeconds !== undefined) {
    if (!Number.isSafeInteger(raw.idleSeconds) || raw.idleSeconds <= 0) return { problem: `${MANIFEST_FILE}: idleSeconds must be a positive whole number` };
    manifest.idleSeconds = raw.idleSeconds;
  }
  return { manifest };
}

const sourced = (value, source) => ({ value, source });

/**
 * The effort the selector starts on: the configured one, else `medium` when every model lists
 * it. A route-wide default must be valid for each model on the route.
 */
export function defaultEffortFor(models, configured) {
  const withReasoning = models.filter(m => m.reasoning);
  if (withReasoning.length === 0 || withReasoning.length !== models.length) return undefined;
  const allHave = level => withReasoning.every(m => level in m.reasoning);
  if (configured !== undefined) return allHave(configured) ? sourced(configured, 'config') : undefined;
  return allHave(PREFERRED_DEFAULT_EFFORT) ? sourced(PREFERRED_DEFAULT_EFFORT, 'default') : undefined;
}

/**
 * Merges one configured Space with what Hugging Face reported and the manifest, in the order
 * configuration > manifest > Hugging Face API > documented default.
 * @param space - one entry of normalizeConfig().spaces
 * @param api - { host?, sha?, gcTimeout? } from the Space API, or undefined when not read
 * @param manifest - parseManifest().manifest, or undefined
 * @returns {{ space: object } | { problem: string }}
 */
export function effectiveSpace(space, api, manifest) {
  const baseURL = space.baseURL !== undefined
    ? sourced(space.baseURL, 'config')
    : api?.host ? sourced(`${api.host.replace(/\/+$/, '')}/v1`, 'api') : undefined;
  if (!baseURL) return { problem: `${space.id}: the Space address is unknown; it is read from Hugging Face, so check the inference credential, or set \`baseURL\`` };
  const models = space.models.length
    ? sourced(space.models, 'config')
    : manifest?.models?.length ? sourced(manifest.models, 'manifest') : undefined;
  if (!models) return { problem: `${space.id}: no model listed; add \`models\` to the configuration or a ${MANIFEST_FILE} to the Space` };
  const effort = defaultEffortFor(models.value, space.defaultEffort);
  if (space.defaultEffort !== undefined && !effort) {
    return { problem: `${space.id}: defaultEffort "${space.defaultEffort}" is not listed in the reasoning levels of every model` };
  }
  const eventPrefix = space.eventPrefix !== undefined
    ? sourced(space.eventPrefix, 'config')
    : manifest?.eventPrefix !== undefined ? sourced(manifest.eventPrefix, 'manifest') : sourced(DEFAULTS.eventPrefix, 'default');
  const idleSeconds = manifest?.idleSeconds !== undefined
    ? sourced(manifest.idleSeconds, 'manifest')
    : api?.gcTimeout > 0 ? sourced(api.gcTimeout, 'api') : undefined;
  return {
    space: {
      id: space.id,
      label: space.label,
      route: space.route,
      baseURL,
      models,
      ...(effort ? { defaultEffort: effort } : {}),
      eventPrefix,
      ...(idleSeconds ? { idleSeconds } : {}),
      ...(api?.sha ? { sha: api.sha } : {}),
      ...(space.hardware ? { hardware: space.hardware } : {}),
      readyTimeoutMinutes: space.readyTimeoutMinutes,
    },
  };
}
