/**
 * Configuration rules, without Harness imports. Each Space is checked on its own: a problem
 * refuses that Space (or one of its models) with a message that says the fix, and never stops the
 * other Spaces. See docs/design.md, section 6.
 */

/** Harness reasoning levels, from least to greatest effort. */
export const HARNESS_LEVELS = Object.freeze(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

/** Effort the selector starts on when a model lists it and nothing else is configured. */
export const PREFERRED_DEFAULT_EFFORT = 'medium';

export const DEFAULTS = Object.freeze({
  credentials: Object.freeze({ inference: 'HF_TOKEN', control: 'HF_TOKEN', billing: 'HF_TOKEN' }),
  eventPrefix: 'SPACE_EVENT',
});

const SPACE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
// A hand-declared pi-ai route id is a lowercase hyphenated identifier (dsh-llm-pi-ai README).
const ROUTE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ROUTE_MAX = 32;
const CREDENTIAL_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
// A Hugging Face token is also a valid identifier, so a pasted token must be caught explicitly.
const LOOKS_LIKE_TOKEN = /^hf_[A-Za-z0-9]{20,}$/;
const SPACE_HOSTNAME = /^[a-z0-9-]+\.hf\.space$/;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** True for a Space's own address, https://<subdomain>.hf.space, with no user or port. */
export function isSpaceURL(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && SPACE_HOSTNAME.test(u.hostname) && !u.port && !u.username && !u.password;
  } catch {
    return false;
  }
}

/** True for http(s) URLs on this machine, which only offline tests use. */
export function isLoopbackURL(url) {
  try {
    const u = new URL(url);
    return (u.protocol === 'http:' || u.protocol === 'https:') && LOOPBACK.has(u.hostname);
  } catch {
    return false;
  }
}

/** Route id from a label: lowercase, every other character a single `-`; undefined when unusable. */
export function routeFromLabel(label) {
  const route = String(label ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return route && route.length <= ROUTE_MAX ? route : undefined;
}

/**
 * Checks a `reasoning` map (Harness level -> value the server accepts) and returns it ordered
 * from least to greatest effort, `false` for "no reasoning control", or a problem.
 * @returns {{ value: false | Record<string, string> } | { problem: string }}
 */
export function normalizeReasoning(raw) {
  if (raw === false) return { value: false };
  if (raw === undefined || raw === null) return { value: undefined };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { problem: '`reasoning` must be a map of Harness level to server value, or false' };
  const keys = Object.keys(raw);
  if (keys.length === 0) return { problem: '`reasoning` is empty; list at least one level, or set it to false' };
  for (const key of keys) {
    if (!HARNESS_LEVELS.includes(key)) return { problem: `unknown reasoning level "${key}"; use ${HARNESS_LEVELS.join(', ')}` };
    if (typeof raw[key] !== 'string' || !raw[key].trim()) return { problem: `reasoning level "${key}" needs the value the server accepts, as text` };
  }
  const ordered = {};
  for (const level of HARNESS_LEVELS) if (level in raw) ordered[level] = raw[level].trim();
  return { value: ordered };
}

/**
 * Checks one model entry. `name` defaults to `id`; sizes stay unset when not given (the route's
 * documented fallbacks apply).
 * @returns {{ model: object } | { problem: string }}
 */
export function normalizeModel(raw) {
  if (!raw || typeof raw !== 'object') return { problem: 'a model entry must be an object' };
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (!id) return { problem: 'a model needs `id`, exactly as the Space lists it in GET /v1/models' };
  const model = { id, name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : id };
  for (const key of ['contextWindow', 'maxTokens']) {
    if (raw[key] === undefined) continue;
    if (!Number.isSafeInteger(raw[key]) || raw[key] <= 0) return { problem: `model "${id}": \`${key}\` must be a positive whole number` };
    model[key] = raw[key];
  }
  const reasoning = normalizeReasoning(raw.reasoning);
  if ('problem' in reasoning) return { problem: `model "${id}": ${reasoning.problem}` };
  if (reasoning.value !== undefined) model.reasoning = reasoning.value;
  return { model };
}

/**
 * Checks a list of models: duplicates and invalid entries are refused one by one.
 * @returns {{ models: object[], problems: string[] }}
 */
export function normalizeModels(list) {
  const models = [];
  const problems = [];
  const seen = new Set();
  for (const raw of Array.isArray(list) ? list : []) {
    const result = normalizeModel(raw);
    if ('problem' in result) { problems.push(result.problem); continue; }
    if (seen.has(result.model.id)) { problems.push(`model "${result.model.id}" is listed twice; keep one entry`); continue; }
    seen.add(result.model.id);
    models.push(result.model);
  }
  return { models, problems };
}

function credentialName(value, fallback, key, problems) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'string' && CREDENTIAL_NAME.test(value) && !LOOKS_LIKE_TOKEN.test(value)) return value;
  problems.push(`credentials.${key} must be a credential name from the Harness vault (letters, digits, _), not a token value; if a token was pasted here, remove it and revoke it`);
  return fallback;
}

/**
 * `baseURL` set by the user. The inference token travels with every model request, so only a
 * Space address is allowed (https://<subdomain>.hf.space), or this machine for offline tests.
 */
export function checkBaseURL(url) {
  if (typeof url !== 'string' || !url) return 'baseURL must be a URL';
  try { new URL(url); } catch { return `baseURL "${url}" is not a URL`; }
  if (!isSpaceURL(url) && !isLoopbackURL(url)) return 'baseURL must be the Space address, https://<subdomain>.hf.space/v1 (the inference token is sent there)';
  return undefined;
}

/**
 * Normalizes the plugin configuration. Spaces with a problem are left out of `spaces` and
 * reported in `problems`, each message prefixed with the Space id.
 * @returns {{ credentials: object, spaces: object[], problems: string[] }}
 */
export function normalizeConfig(raw = {}) {
  const problems = [];
  const credentials = {
    inference: credentialName(raw.credentials?.inference, DEFAULTS.credentials.inference, 'inference', problems),
    control: credentialName(raw.credentials?.control, DEFAULTS.credentials.control, 'control', problems),
    billing: credentialName(raw.credentials?.billing, DEFAULTS.credentials.billing, 'billing', problems),
  };
  const spaces = [];
  const routes = new Set();
  for (const [index, entry] of (Array.isArray(raw.spaces) ? raw.spaces : []).entries()) {
    const id = typeof entry?.id === 'string' ? entry.id.trim() : '';
    const where = id || `spaces[${index}]`;
    if (!SPACE_ID.test(id)) { problems.push(`${where}: \`id\` must be the Space id, owner/name`); continue; }
    const label = typeof entry.label === 'string' && entry.label.trim() ? entry.label.trim() : id.split('/')[1];
    const route = entry.route === undefined ? routeFromLabel(label) : entry.route;
    if (typeof route !== 'string' || !ROUTE_ID.test(route) || route.length > ROUTE_MAX) {
      problems.push(`${where}: route "${route ?? ''}" is not usable; set \`route\` to lowercase letters, digits and single hyphens, up to ${ROUTE_MAX} characters`);
      continue;
    }
    if (routes.has(route)) { problems.push(`${where}: route "${route}" is already used by another Space; set a different \`route\``); continue; }
    if (entry.baseURL !== undefined) {
      const bad = checkBaseURL(entry.baseURL);
      if (bad) { problems.push(`${where}: ${bad}`); continue; }
    }
    const listed = normalizeModels(entry.models);
    for (const problem of listed.problems) problems.push(`${where}: ${problem}`);
    if (entry.defaultEffort !== undefined && !HARNESS_LEVELS.includes(entry.defaultEffort)) {
      problems.push(`${where}: defaultEffort "${entry.defaultEffort}" is not a Harness level; use ${HARNESS_LEVELS.join(', ')}`);
      continue;
    }
    routes.add(route);
    spaces.push({
      id,
      label,
      route,
      ...(entry.baseURL === undefined ? {} : { baseURL: entry.baseURL.replace(/\/+$/, '') }),
      models: listed.models,
      ...(entry.defaultEffort === undefined ? {} : { defaultEffort: entry.defaultEffort }),
      ...(typeof entry.progress?.eventPrefix === 'string' && entry.progress.eventPrefix ? { eventPrefix: entry.progress.eventPrefix } : {}),
    });
  }
  return { credentials, spaces, problems };
}
