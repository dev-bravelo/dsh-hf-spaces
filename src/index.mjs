/**
 * dsh-hf-spaces Host half:
 * - each configured Hugging Face Space in the Harness model selector, with the open model name
 *   and only the effort levels configured for it. Values come from the configuration, the Space
 *   manifest and the Hugging Face API, in that order (docs/design.md, section 6);
 * - a supervisor per Space that starts and pauses it (src/supervisor.mjs);
 * - the chat gate: a request to a stopped Space starts it and resumes the waiting sessions when
 *   it is ready (src/chat.mjs), with progress read from the Space run log (src/progress.mjs);
 * - the /space command, the stop rules and the cost as Hugging Face bills it (src/control.mjs);
 * - the plugin's records, billing usage and credential checks (src/account.mjs);
 * - local routes guarded by the Harness (src/web.mjs) for the Client half (client/index.js):
 *   header indicator, sidebar tab, toasts and the setup page.
 */
import path from 'node:path';
import Schema from '@deepseek-ai/schemastery';
import * as piAiModule from '@deepseek-ai/dsh-llm-pi-ai';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { HARNESS_LEVELS, INPUT_KINDS, normalizeConfig } from './config.mjs';
import { HF_API, createHfClient } from './hf.mjs';
import { LEDGER_FILE, attachAccount, createLedger, resolveStateDir } from './account.mjs';
import { MANIFEST_FILE, effectiveSpace, parseManifest } from './manifest.mjs';
import { attachChat } from './chat.mjs';
import { attachControl } from './control.mjs';
import { attachWeb } from './web.mjs';
import { textsFor } from './messages.mjs';
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
  input: Schema.array(Schema.string())
    .description(`What the model reads: ${INPUT_KINDS.join(', ')}. Unset: text only, and the Harness refuses images to it.`),
});

export const Config = Schema.object({
  credentials: Schema.object({
    inference: Schema.string().default('HF_TOKEN').description('Vault credential NAME that reads the Space: model requests, Space API and manifest. Never a token value.'),
    control: Schema.string().default('HF_TOKEN').description('Vault credential NAME with write access to the Space, to start and stop it.'),
    billing: Schema.string().default('HF_TOKEN').description('Vault credential NAME that reads the account billing, for the usage of each Space today and this month.'),
  }).default({}),
  locale: Schema.string().default('en').description('Language of the plugin messages in the chat: en or pt-BR.'),
  hfApiURL: Schema.string().default(HF_API).description('Hugging Face address. Change it only for offline tests on this machine.'),
  pollSeconds: Schema.number().default(5).description('Seconds between state reads while a Space starts or stops: 1 to 60.'),
  stateDir: Schema.string().description('Folder of the plugin records (recent starts); a relative path is under the Harness home. Unset: <Harness home>/state/dsh-hf-spaces.'),
  spaces: Schema.array(Schema.object({
    id: Schema.string().description('Space id, owner/name. The only required field.'),
    label: Schema.string().description('Provider name in the model selector. Defaults to the Space name.'),
    route: Schema.string().description('Provider id saved in sessions: lowercase letters, digits and hyphens, up to 32. Keep it stable. Defaults to the label.'),
    baseURL: Schema.string().description('OpenAI-compatible address of the Space, https://<subdomain>.hf.space/v1. Unset: read from Hugging Face.'),
    hardware: Schema.string().description('Hardware to start on, such as a100-large. Unset: the hardware the Space already has.'),
    start: Schema.object({
      automatic: Schema.boolean().description('Start the Space when a message is sent to it while it is off. Default true.'),
      variables: Schema.dict(Schema.any()).description('Space variables written before each start, for a Space with a start handshake. Placeholders: {{uuid}}, {{now}}, {{readyDeadline}} (Unix seconds).'),
      readyTimeoutMinutes: Schema.number().description('Give up and pause the Space if it is not ready after this many minutes: 1 to 120, default 15.'),
    }),
    defaultEffort: Schema.string().description('Effort the selector starts on. Unset: medium when every model lists it.'),
    models: Schema.array(Model).description(`Models served. Unset: read from ${MANIFEST_FILE} in the Space repository.`),
    progress: Schema.object({ eventPrefix: Schema.string().description('Prefix of the progress lines in the Space run log.') }),
    stop: Schema.object({
      idleMinutes: Schema.number().description('Pause after this many minutes without model requests; 0 turns it off. Default 30.'),
      sessionMinutes: Schema.number().description('Time limit of each start made by the plugin, counted from the start; 0 means none. Default 60.'),
      warnMinutes: Schema.number().description('Warning before the time limit. Default 5.'),
      extendMinutes: Schema.number().description('What /space + adds to the time limit. Default 60.'),
    }).description('Stop rules. They run in the plugin, so they apply only while the Harness is open.'),
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
    // For the setup page: whether the Space and its manifest were read, and why not.
    const checks = { api: 'not needed', manifest: 'not needed' };
    if (hf && (space.baseURL === undefined || space.models.length === 0)) {
      try {
        api = await hf.getSpace(space.id);
        checks.api = 'read';
        if (space.models.length === 0) checks.manifest = api.files.includes(MANIFEST_FILE) ? 'found' : 'absent';
        if (space.models.length === 0 && api.sha && api.files.includes(MANIFEST_FILE)) {
          const text = await hf.readSpaceFile(space.id, api.sha, MANIFEST_FILE);
          const parsed = text === undefined ? undefined : parseManifest(text);
          if (parsed && 'problem' in parsed) {
            checks.manifest = parsed.problem;
            log?.warn?.(`${space.id}: ${parsed.problem}`);
          } else if (parsed) manifest = parsed.manifest;
        }
      } catch (error) {
        readFailed = true;
        checks.api = error.message;
        log?.warn?.(`${space.id}: ${error.message}`);
      }
    }
    return { ...effectiveSpace(space, api, manifest), readFailed, checks };
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

  /** route -> entry ({ key, label, facts, supervisor, chat state }) for every registered Space. */
  const supervisors = new Map();
  const texts = textsFor(settings.locale);
  const ledger = createLedger({ file: path.join(resolveStateDir(settings.stateDir), LEDGER_FILE), log });
  const account = hf ? attachAccount({ hf, ledger, token, credentialNames: settings.credentials, log }) : undefined;
  const chat = hf
    ? attachChat({ ctx, entries: supervisors, hf, texts, token, credentialNames: settings.credentials, log, pollMs: settings.pollSeconds * 1000 })
    : undefined;
  const control = chat
    ? attachControl({ ctx, entries: supervisors, chat, account, texts, locale: settings.locale, pollMs: settings.pollSeconds * 1000, log })
    : undefined;

  /** route -> what the setup page shows: each effective value with its source, and what was read. */
  const setup = new Map();
  const setupOf = (space, result) => {
    const base = { id: space.id, label: space.label, route: space.route, checks: result.checks };
    if ('problem' in result) return { ...base, problem: result.problem };
    const s = result.space;
    return {
      ...base,
      values: {
        baseURL: s.baseURL,
        models: { value: s.models.value.map(m => ({ id: m.id, name: m.name, efforts: m.reasoning ? Object.keys(m.reasoning) : [] })), source: s.models.source },
        ...(s.defaultEffort ? { defaultEffort: s.defaultEffort } : {}),
        eventPrefix: s.eventPrefix,
        ...(s.idleSeconds ? { sleepSeconds: s.idleSeconds } : {}),
        hardware: s.hardware ?? null,
        readyTimeoutMinutes: s.readyTimeoutMinutes,
        automatic: s.automatic,
        stop: s.stop,
        startVariables: Object.keys(s.startVariables ?? {}),
      },
    };
  };
  const setupView = async () => ({
    problems: settings.problems,
    credentials: account ? await account.credentials() : [],
    spaces: settings.spaces.map((space) => {
      const view = setup.get(space.route) ?? { id: space.id, label: space.label, route: space.route, pending: true };
      const entry = supervisors.get(space.route);
      if (!entry) return view;
      const key = JSON.stringify([entry.sha, entry.facts.models]);
      return {
        ...view,
        phase: entry.supervisor.state().phase,
        ...(entry.servedAt ? { servedAt: entry.servedAt } : {}),
        efforts: entry.effortsChecked === key ? { checked: true, refused: entry.refusedEfforts ?? [] } : { checked: false },
      };
    }),
  });
  if (control) attachWeb({ ctx, control, setup: setupView, locale: settings.locale, log });
  const unsupervise = (route) => {
    const entry = supervisors.get(route);
    if (!entry) return;
    entry.supervisor.dispose(); // stops watching; the Space is left as it is
    chat?.release(entry);
    supervisors.delete(route);
  };
  const supervise = (space) => {
    if (!hf) return;
    const facts = {
      id: space.id,
      baseURL: space.baseURL.value,
      modelIds: space.models.value.map(m => m.id),
      models: space.models.value.map(m => ({ id: m.id, ...(m.reasoning ? { reasoning: m.reasoning } : {}) })),
      eventPrefix: space.eventPrefix.value,
      ...(space.hardware ? { hardware: space.hardware } : {}),
      readyTimeoutMinutes: space.readyTimeoutMinutes,
      automatic: space.automatic,
      stop: space.stop,
      ...(space.startVariables ? { startVariables: space.startVariables } : {}),
    };
    const key = JSON.stringify(facts);
    const previous = supervisors.get(space.route);
    if (previous?.key === key) return;
    const entry = { key, route: space.route, label: space.label, facts, sha: space.sha, sleepSeconds: space.idleSeconds?.value, readyUntil: 0, waiters: new Map() };
    entry.supervisor = createSupervisor({
      space: facts,
      client: hf,
      pollMs: settings.pollSeconds * 1000,
      onChange: (state) => {
        log?.info?.(`${space.id}: ${describeState(state)}`);
        if (state.phase === 'ready') entry.servedAt = Date.now(); // every configured model was listed
        if (supervisors.get(space.route) === entry) account?.track(entry, state, texts);
        chat?.onState(entry);
      },
    });
    if (previous) {
      previous.supervisor.dispose(); // stops watching; the Space is left as it is
      chat?.transfer(previous, entry); // a start in progress goes on under the new entry
    }
    supervisors.set(space.route, entry);
    entry.supervisor.check().catch(error => log?.warn?.(`${space.id}: state not read: ${error?.message ?? error}`));
  };

  let generation = 0;
  let disposed = false;
  /** Builds every Space's route again, in parallel; a newer call wins over an older one. */
  const refresh = async () => {
    const mine = ++generation;
    await Promise.all(settings.spaces.map(async (space) => {
      const result = await resolveSpace(space);
      if (disposed || mine !== generation) return;
      setup.set(space.route, setupOf(space, result));
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
    control?.dispose();
    chat?.dispose();
  });
  schedule();
  // When the credential service starts after this plugin, read Hugging Face again with it.
  ctx.inject(['credentials'], () => { schedule(); });
}
