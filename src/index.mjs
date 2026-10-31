/**
 * dsh-hf-spaces Host half, Phase 1:
 * - slice 1 puts each configured Hugging Face Space in the Harness model selector, with the open
 *   model name and only the effort levels configured for it. Values come from the configuration,
 *   the Space manifest and the Hugging Face API, in that order (docs/design.md, section 6);
 * - slice 2 gives each registered Space a supervisor that can start and pause it. Here it only
 *   reads and logs the Space state; starting from the chat comes in slice 3.
 */
import Schema from '@deepseek-ai/schemastery';
import * as piAiModule from '@deepseek-ai/dsh-llm-pi-ai';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { HARNESS_LEVELS, normalizeConfig } from './config.mjs';
import { HF_API, createHfClient } from './hf.mjs';
import { MANIFEST_FILE, effectiveSpace, parseManifest } from './manifest.mjs';
import { buildProviders, describeSpace } from './route.mjs';
import { createSupervisor, describeState } from './supervisor.mjs';

export const name = 'hf-spaces';
export const inject = ['llm'];

// Limits are checked per Space in config.mjs, not in the schema: a schema error would reject the
// whole configuration, and every Space with it.
const Model = Schema.object({
  id: Schema.string().description('Model id, exactly as the Space lists it in GET /v1/models.'),
  name: Schema.string().description('The open model name shown in the model selector. Defaults to the id.'),
  contextWindow: Schema.number().description('Context window in tokens. Unset: the route fallback (262,144).'),
  maxTokens: Schema.number().description('Output cap in tokens. Unset: the route fallback (32,768).'),
  reasoning: Schema.union([Schema.const(false), Schema.dict(Schema.string())])
    .description(`Effort levels the selector offers: Harness level (${HARNESS_LEVELS.join(', ')}) -> value the server accepts. false: no effort control.`),
});

export const Config = Schema.object({
  credentials: Schema.object({
    inference: Schema.string().default('HF_TOKEN').description('Vault credential NAME that reads the Space: model requests, Space API and manifest. Never a token value.'),
    control: Schema.string().default('HF_TOKEN').description('Vault credential NAME with write access to the Space, to start and stop it (later slice).'),
    billing: Schema.string().default('HF_TOKEN').description('Vault credential NAME that reads billing, for cost and balance (later slice).'),
  }).default({}),
  hfApiURL: Schema.string().default(HF_API).description('Hugging Face address. Change it only for offline tests on this machine.'),
  spaces: Schema.array(Schema.object({
    id: Schema.string().description('Space id, owner/name. The only required field.'),
    label: Schema.string().description('Provider name in the model selector. Defaults to the Space name.'),
    route: Schema.string().description('Provider id saved in sessions: lowercase letters, digits and hyphens, up to 32. Keep it stable. Defaults to the label.'),
    baseURL: Schema.string().description('OpenAI-compatible address of the Space, https://<subdomain>.hf.space/v1. Unset: read from Hugging Face.'),
    hardware: Schema.string().description('Hardware to start on, such as a100-large. Unset: the hardware the Space already has.'),
    start: Schema.object({
      readyTimeoutMinutes: Schema.number().description('Give up and pause the Space if it is not ready after this many minutes: 1 to 120, default 15.'),
    }),
    defaultEffort: Schema.string().description('Effort the selector starts on. Unset: medium when every model lists it.'),
    models: Schema.array(Model).description(`Models served. Unset: read from ${MANIFEST_FILE} in the Space repository.`),
    progress: Schema.object({ eventPrefix: Schema.string().description('Prefix of the progress lines in the Space run log.') }),
  })).default([]).description('Spaces offered in the model selector. Empty: the plugin registers nothing.'),
});

const piAi = piAiModule.default ?? piAiModule;
const cleanToken = v => (typeof v === 'string' && v.trim() && !/\s/.test(v.trim()) ? v.trim() : undefined);

export function apply(ctx, config) {
  const log = typeof ctx.logger === 'function' ? ctx.logger(name) : ctx.logger;
  const settings = normalizeConfig(config);
  for (const problem of settings.problems) log?.warn?.(problem);
  if (settings.spaces.length === 0) {
    log?.info?.('no usable Space configured; nothing registered');
    return;
  }

  // Read at request time, not at startup: the credential service may start after this plugin.
  // It already falls back to the launching environment, so nothing else is read here.
  /** @param kind - 'inference' for reads and model requests, 'control' to start and stop */
  const token = async (kind = 'inference') => {
    try {
      return cleanToken((await ctx.get('credentials')?.resolve(credentialRef(settings.credentials[kind])))?.value);
    } catch {
      return undefined; // vault absent or locked
    }
  };
  let hf;
  try {
    hf = createHfClient({ apiURL: config?.hfApiURL ?? HF_API, getToken: token });
  } catch (error) {
    log?.warn?.(error.message);
  }

  /**
   * Space API and manifest are read only when the configuration leaves something to fill.
   * `readFailed` marks a problem caused by a failed read, which must not remove a working route.
   */
  const resolveSpace = async (space) => {
    let api;
    let manifest;
    let readFailed = false;
    if (hf && (space.baseURL === undefined || space.models.length === 0)) {
      try {
        api = await hf.getSpace(space.id);
        if (space.models.length === 0 && api.sha && api.files.includes(MANIFEST_FILE)) {
          const text = await hf.readSpaceFile(space.id, api.sha, MANIFEST_FILE);
          const parsed = text === undefined ? undefined : parseManifest(text);
          if (parsed && 'problem' in parsed) log?.warn?.(`${space.id}: ${parsed.problem}`);
          else if (parsed) manifest = parsed.manifest;
        }
      } catch (error) {
        readFailed = true;
        log?.warn?.(`${space.id}: ${error.message}`);
      }
    }
    return { ...effectiveSpace(space, api, manifest), readFailed };
  };

  // Each Space's route lives in its own dsh-llm-pi-ai instance, so the profile's other routes do
  // not change and a problem with one Space never removes another. pi-ai also publishes
  // process-wide registries (configurable-provider directory, model discovery, sign-in flows) that
  // the profile's main instance owns; a second copy collides ("configurable provider ... is
  // already declared", seen by the private prototype on 2026-10-19), so these instances see no-op
  // versions of those three registrations (docs/contracts.md, section 2, "Model selector").
  const llmView = new Proxy(ctx.llm, {
    get(target, key) {
      if (key === 'registerConfigurableProviders') return () => ({ replace() {}, dispose() {} });
      if (key === 'registerModelDiscovery') return () => () => {};
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const routeCtx = ctx.extend({ llm: llmView, authorization: { registerFlow: () => () => {} } });

  /** route -> { key, fiber } of the pi-ai instance currently serving that Space. */
  const mounted = new Map();
  const unmount = (route) => {
    mounted.get(route)?.fiber.dispose();
    mounted.delete(route);
  };
  /** Routes other plugins already serve, which this plugin must not declare again. */
  const takenRoutes = () => new Set(ctx.llm.listProviders()
    .map(provider => provider.id)
    .filter(id => typeof id === 'string' && !mounted.has(id)));

  const mount = async (space) => {
    const providers = buildProviders([space], settings.credentials);
    const key = JSON.stringify(providers);
    if (mounted.get(space.route)?.key === key) return;
    unmount(space.route);
    if (takenRoutes().has(space.route)) {
      log?.warn?.(`${space.id}: route "${space.route}" is already served by another provider in this Harness; set a different \`route\``);
      return;
    }
    const fiber = routeCtx.plugin(piAi, providers);
    mounted.set(space.route, { key, fiber });
    try {
      await fiber;
      if (mounted.get(space.route)?.fiber === fiber) log?.info?.(describeSpace(space));
    } catch (error) {
      // Only undo this attempt: a newer refresh may already have replaced it.
      if (mounted.get(space.route)?.fiber === fiber) unmount(space.route);
      log?.warn?.(`${space.id}: route "${space.route}" not registered: ${error?.message ?? error}`);
    }
  };

  /** route -> { key, supervisor } for every registered Space. */
  const supervisors = new Map();
  const unsupervise = (route) => {
    supervisors.get(route)?.supervisor.dispose(); // stops watching; the Space is left as it is
    supervisors.delete(route);
  };
  const supervise = (space) => {
    if (!hf) return;
    const facts = {
      id: space.id,
      baseURL: space.baseURL.value,
      modelIds: space.models.value.map(m => m.id),
      ...(space.hardware ? { hardware: space.hardware } : {}),
      readyTimeoutMinutes: space.readyTimeoutMinutes,
    };
    const key = JSON.stringify(facts);
    if (supervisors.get(space.route)?.key === key) return;
    unsupervise(space.route);
    const supervisor = createSupervisor({ space: facts, client: hf, onChange: state => log?.info?.(`${space.id}: ${describeState(state)}`) });
    supervisors.set(space.route, { key, supervisor });
    supervisor.check().catch(error => log?.warn?.(`${space.id}: state not read: ${error?.message ?? error}`));
  };

  let generation = 0;
  let disposed = false;
  /** Builds every Space's route again, in parallel; a newer call wins over an older one. */
  const refresh = async () => {
    const mine = ++generation;
    await Promise.all(settings.spaces.map(async (space) => {
      const result = await resolveSpace(space);
      if (disposed || mine !== generation) return;
      if ('problem' in result) {
        log?.warn?.(result.problem);
        if (!result.readFailed) { // a passing network error keeps what works
          unmount(space.route);
          unsupervise(space.route);
        }
      } else {
        await mount(result.space);
        if (mounted.has(space.route)) supervise(result.space);
        else unsupervise(space.route);
      }
    }));
  };
  // Startup can ask twice in a row (plugin start, then the credential service): one run serves both.
  let timer;
  const schedule = () => {
    if (timer || disposed) return;
    timer = setTimeout(() => {
      timer = undefined;
      refresh().catch(error => log?.warn?.(`routes not refreshed: ${error?.message ?? error}`));
    }, 0);
  };

  ctx.effect(() => () => {
    disposed = true;
    clearTimeout(timer);
    for (const route of [...supervisors.keys()]) unsupervise(route);
  });
  schedule();
  // When the credential service starts after this plugin, read Hugging Face again with it.
  ctx.inject(['credentials'], () => { schedule(); });
}
