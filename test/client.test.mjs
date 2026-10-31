// Runs the Client half as the Harness would load it, with a minimal stand-in for React that keeps
// each component's hook state between renders: enough to check its registration and what each
// part shows. The real look is checked by hand on the Desktop (design, roadmap phase 2).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const source = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'client', 'index.js'), 'utf8');
const textOf = node => (node == null || typeof node === 'boolean' ? '' : typeof node === 'string' || typeof node === 'number' ? String(node)
  : Array.isArray(node) ? node.map(textOf).join('') : typeof node.type === 'function' ? textOf(node.type(node.props)) : textOf(node.children));
const tick = () => new Promise(resolve => setImmediate(resolve));

function makeReact() {
  const states = new Map(); // component -> hook values
  let current;
  let index = 0;
  const slot = () => { const hooks = states.get(current); const k = index++; return [hooks, k]; };
  const React = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children: children.flat() }, children: children.flat() }),
    useState(initial) {
      const [hooks, k] = slot();
      if (!(k in hooks)) hooks[k] = typeof initial === 'function' ? initial() : initial;
      return [hooks[k], (value) => { hooks[k] = typeof value === 'function' ? value(hooks[k]) : value; }];
    },
    useEffect(effect) {
      const [hooks, k] = slot();
      if (!hooks[k]) { hooks[k] = true; effect(); }
    },
    useMemo: fn => fn(),
    useCallback: fn => fn,
    useSyncExternalStore: (subscribe, read) => read(),
  };
  const render = (component, props = {}) => {
    if (!states.has(component)) states.set(component, []);
    current = component;
    index = 0;
    return component(props);
  };
  return { React, render };
}

const memoryStorage = () => { const m = new Map(); return { getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)) }; };

const STATE = {
  locale: 'en',
  spaces: [{
    route: 'my-llm', label: 'My LLM', space: 'your-user/your-llm-space', phase: 'starting', phaseText: 'starting',
    progress: 'Copying the model · 35% · about 2 min left', stage: 'Copying the model', percent: 35, left: '2 min', extend: 60, idle: 30,
    usage: { today: 'US$ 1.25', todayMinutes: 30, month: 'US$ 20.00', monthMinutes: 480 },
    starts: [{ at: 1, day: '31/10', clock: '12:15', duration: '42m', cost: 'US$ 1.75', end: '30 min without use', open: false }],
    logTail: ['SPACE_EVENT {"stage":"copy_progress"}'],
  }],
  account: { credentials: [{ kind: 'inference', name: 'HF_TOKEN', present: true, ok: true, user: 'your-user', role: 'fineGrained' }, { kind: 'control', name: 'SPACE_CONTROL', present: false }] },
};
const SETUP = {
  locale: 'en',
  problems: ['your-user/broken: route "Bad" is not usable'],
  credentials: STATE.account.credentials,
  spaces: [{
    id: 'your-user/your-llm-space', label: 'My LLM', route: 'my-llm', checks: { api: 'read', manifest: 'found' }, phase: 'off',
    efforts: { checked: true, refused: ['open-model: high'] },
    values: {
      baseURL: { value: 'https://your-user-your-llm-space.hf.space/v1', source: 'api' },
      models: { value: [{ id: 'open-model', name: 'Open Model 27B', efforts: ['off', 'low', 'medium'] }], source: 'manifest' },
      defaultEffort: { value: 'medium', source: 'default' }, eventPrefix: { value: 'SPACE_EVENT', source: 'manifest' },
      hardware: 'a100-large', readyTimeoutMinutes: 15, automatic: true, stop: { idleMinutes: 30, sessionMinutes: 60, warnMinutes: 5, extendMinutes: 60 }, startVariables: ['SPACE_SESSION'],
    },
  }],
};

function load({ state = STATE, actionReply = { kind: 'success', text: 'done' }, storage = memoryStorage(), document, timers } = {}) {
  let definition;
  const requests = [];
  const { React, render } = makeReact();
  const context = {
    window: { __ModuleLoader__: { load: (d) => { definition = d; } }, localStorage: storage },
    fetch: async (url, init) => {
      requests.push({ url, init });
      const body = url === 'dsh-hf-spaces/action' ? actionReply : url === 'dsh-hf-spaces/setup' ? SETUP : state;
      return { ok: true, json: async () => body };
    },
    setTimeout: (fn) => { timers?.push(fn); return timers?.length ?? 0; },
    clearTimeout: () => {},
    ...(document ? { document } : {}),
    Date,
  };
  vm.runInNewContext(source, context);
  const plugin = definition.factory((name) => { assert.equal(name, 'react'); return React; });
  return { definition, plugin, requests, render };
}

/** apply() with fake slots and the optional services given; returns what was registered. */
function apply(plugin, services = {}) {
  const components = {};
  const slotKeys = [];
  const injected = [];
  const tabs = [];
  plugin.apply({
    slots: {
      inject: (name, fn) => fn(),
      register: (options, component) => { components[options.name] = component; slotKeys.push([options.name, options.key ?? options.id]); return () => {}; },
    },
    effect: (fn) => { fn(); },
    inject: (names, fn) => {
      injected.push(names[0]);
      const service = services[names[0]];
      if (service) fn({ [names[0]]: service, effect: (f) => { f(); } });
    },
  });
  if (services.sidebarRightTabs) tabs.push(...services.sidebarRightTabs.registered);
  return { components, slotKeys, injected, tabs };
}

const forProvider = (provider, sessionId = 's1') => ({
  sessionId,
  useSessions: select => select({ projectionsBySession: { [sessionId]: { values: { modelSelection: { next: provider === undefined ? undefined : { provider } } } } } }),
});

const findBy = test => function find(node) {
  if (!node || typeof node !== 'object') return undefined;
  if (Array.isArray(node)) { for (const n of node) { const found = find(n); if (found) return found; } return undefined; }
  if (typeof node.type === 'function') return find(node.type(node.props));
  if (test(node)) return node;
  return find(node.children);
};
const findByClass = (node, name) => findBy(n => String(n.props?.className ?? '').split(' ').includes(name))(node);
const findByRole = (node, role) => findBy(n => n.props?.role === role)(node);

/** Finds the first element whose text is `label` and that has an onClick. */
const findButton = (node, label) => {
  if (!node || typeof node !== 'object') return undefined;
  if (Array.isArray(node)) { for (const n of node) { const found = findButton(n, label); if (found) return found; } return undefined; }
  if (typeof node.type === 'function') return findButton(node.type(node.props), label);
  if (node.type === 'button' && textOf(node.children) === label) return node;
  return findButton(node.children, label);
};

test('registers every part with the slots service only; the other services are optional', () => {
  const { definition, plugin } = load();
  assert.equal(definition.id, 'dsh-hf-spaces');
  assert.deepEqual([...plugin.inject], ['slots']); // copied out of the script's own realm
  const tabService = { registered: [], register(tab) { this.registered.push(tab); return () => {}; } };
  const { slotKeys, injected, tabs } = apply(plugin, { sidebarRightTabs: tabService });
  assert.deepEqual(slotKeys, [
    ['conversation.session.header.utilities', 'dsh-hf-spaces'],
    ['shell.overlay', 'dsh-hf-spaces-toasts'],
    ['plugins.bundle.config', 'dsh-hf-spaces'], // the plugin's page, under its package name
    ['sidebar.right.pane.tab', 'dsh-hf-spaces/spaces'],
  ]);
  assert.deepEqual(injected, ['sidebarRightTabs', 'sidebarRight', 'modelDirectories']);
  assert.equal(tabs[0].id, 'dsh-hf-spaces/spaces');
  assert.equal(tabs[0].kind, 'dsh-hf-spaces');
  assert.equal(tabs[0].title(), 'Hugging Face Spaces');
  // Without any optional service, apply() still registers the slots and throws nothing.
  assert.doesNotThrow(() => apply(load().plugin, {}));
});

test('header indicator: one short line for a Space route; the state opens the tab; one action', async () => {
  const { plugin, requests, render } = load();
  const opened = [];
  const { components } = apply(plugin, { sidebarRight: { openTab: (kind, options) => opened.push([kind, options]) } });
  const Header = components['conversation.session.header.utilities'];
  render(Header, forProvider('my-llm')); // first render starts the shared poller
  await tick();
  assert.equal(requests[0].url, 'dsh-hf-spaces/state', 'a browser-relative route');
  assert.equal(render(Header, forProvider('openai')), null, 'other providers show nothing');
  const shown = render(Header, forProvider('my-llm'));
  assert.match(textOf(shown), /My LLMstarting 35% · ~2 min/, 'the short line, not the whole progress sentence');
  assert.ok(findButton(shown, 'Stop'));
  assert.ok(!findButton(shown, 'Start'));
  assert.ok(!findButton(shown, '+60 min'), 'extending lives in the notice and the tab, not in the header');
  const status = findByClass(shown, 'dhs-status');
  assert.equal(status.type, 'button');
  assert.match(status.props.title, /Copying the model · 35% · about 2 min left/, 'the full line is the tooltip');
  assert.match(status.props['aria-label'], /Open details$/);
  status.props.onClick();
  assert.equal(opened[0][0], 'dsh-hf-spaces', 'the state opens the plugin tab');
  const live = findByRole(shown, 'status');
  assert.equal(textOf(live), 'My LLM: starting', 'announced: the state, never each percent');
});

test('header indicator: a session on the profile default model is recognized through the model-selection service', async () => {
  const { plugin, render } = load();
  const store = { getSnapshot: () => ({ current: { provider: 'my-llm', model: 'open-model' } }), subscribe: () => () => {} };
  const { components } = apply(plugin, { modelDirectories: { directoryFor: () => ({ store }) } });
  const Header = components['conversation.session.header.utilities'];
  render(Header, forProvider(undefined));
  await tick();
  assert.match(textOf(render(Header, forProvider(undefined))), /My LLM/, 'no choice in the session: the default model counts');
  // Without the service, a session with no choice shows nothing, as before.
  const bare = load();
  const Plain = apply(bare.plugin, {}).components['conversation.session.header.utilities'];
  bare.render(Plain, forProvider(undefined));
  await tick();
  assert.equal(bare.render(Plain, forProvider(undefined)), null);
  // A service that throws is ignored.
  const broken = load();
  const Broken = apply(broken.plugin, { modelDirectories: { directoryFor: () => { throw new Error('unknown session'); } } }).components['conversation.session.header.utilities'];
  broken.render(Broken, forProvider('my-llm'));
  await tick();
  assert.match(textOf(broken.render(Broken, forProvider('my-llm'))), /My LLM/);
});

test('sidebar tab: progress bar, billing, recent starts, run log and credentials', async () => {
  const { plugin, render } = load();
  const Panel = apply(plugin, {}).components['sidebar.right.pane.tab'];
  render(Panel, { sessionId: 's1' });
  await tick();
  const shown = render(Panel, { sessionId: 's1' });
  const text = textOf(shown);
  assert.match(text, /My LLM/);
  assert.match(text, /Copying the model35% · about 2 min left/, "stage on the left, percent and time left on the right");
  assert.match(text, /Spent on this Space \(Hugging Face billing, not the balance\)/);
  assert.match(text, /US\$ 1\.25spent today · 30 GPU min/);
  assert.match(text, /US\$ 20\.00spent this month · 480 GPU min/);
  assert.match(text, /31\/10 12:15/);
  assert.match(text, /30 min without use/);
  assert.match(text, /SPACE_EVENT/);
  assert.match(text, /Credentials: 1 to fix/, 'a credential to fix opens the list');
  assert.match(text, /HF_TOKEN · read and model requests: accepted · your-user · fineGrained token/);
  assert.match(text, /SPACE_CONTROL · start and stop: missing from the Harness vault/);
  assert.equal(findBy(n => n.type === 'details' && n.props?.className === 'dhs-cred')(shown).props.open, true);
  const bar = findByRole(shown, 'progressbar');
  assert.equal(bar.props['aria-valuenow'], 35);
  assert.equal(bar.props['aria-valuetext'], 'Copying the model · 35% · about 2 min left');
});

test('toasts: time limit soon with +N and Stop, a failure, a missing credential, and the answer to a button', async () => {
  const state = {
    locale: 'en',
    spaces: [{ route: 'my-llm', label: 'My LLM', phase: 'ready', phaseText: 'serving', stopsAt: '15:42', warning: true, extend: 60, starts: [] },
      { route: 'other', label: 'Other', phase: 'failed', phaseText: 'failed', failure: 'Other could not be started: no GPU.', starts: [] }],
    account: { credentials: [{ kind: 'control', name: 'SPACE_CONTROL', present: false }, { kind: 'billing', name: 'HF_TOKEN', present: false }] },
  };
  const { plugin, requests, render } = load({ state, actionReply: { kind: 'error', text: 'the credential X is missing' } });
  const Toasts = apply(plugin, {}).components['shell.overlay'];
  render(Toasts);
  await tick();
  const shown = render(Toasts);
  const text = textOf(shown);
  assert.match(text, /My LLM stops at 15:42The time limit of this start is near\. \+60 min keeps it on\./);
  assert.match(text, /Other did not start/);
  assert.match(text, /Credential SPACE_CONTROL/);
  assert.ok(!/Credential HF_TOKEN/.test(text), 'billing alone does not stop a Space: no toast');
  // The +60 button sends the extend action for that route, and its answer becomes a toast.
  await findButton(shown, '+60 min').props.onClick();
  const action = requests.find(r => r.url === 'dsh-hf-spaces/action');
  assert.deepEqual(JSON.parse(action.init.body), { route: 'my-llm', action: 'extend' });
  await tick();
  const afterAction = render(Toasts);
  assert.match(textOf(afterAction), /the credential X is missing/, 'an error answer stays');
  // A closed failure stays closed after a reload (this viewer); a credential that blocks starting comes back.
  const storage = memoryStorage();
  const again = load({ state, storage });
  const T2 = apply(again.plugin, {}).components['shell.overlay'];
  again.render(T2);
  await tick();
  const shownAgain = again.render(T2);
  const toastWith = pattern => findBy(n => n.props?.className === 'dhs-toast' && pattern.test(textOf(n)))(shownAgain);
  findButton(toastWith(/Other did not start/), 'Close').props.onClick();
  findButton(toastWith(/Credential SPACE_CONTROL/), 'Close').props.onClick();
  const reloaded = load({ state, storage });
  const T3 = apply(reloaded.plugin, {}).components['shell.overlay'];
  reloaded.render(T3);
  await tick();
  const afterReload = textOf(reloaded.render(T3));
  assert.ok(!/Other did not start/.test(afterReload), 'the failure stays closed after a reload');
  assert.match(afterReload, /Credential SPACE_CONTROL/, 'a blocking credential is shown again');
});

test('setup page: problems, credentials, checks and each effective value with its source', async () => {
  const { plugin, requests, render } = load();
  const Page = apply(plugin, {}).components['plugins.bundle.config'];
  assert.equal(render(Page, { view: 'page' }), null, 'nothing until the setup is read');
  await tick();
  assert.ok(requests.some(r => r.url === 'dsh-hf-spaces/setup'));
  const text = textOf(render(Page, { view: 'page' }));
  assert.match(text, /route "Bad" is not usable/);
  assert.match(text, /Space on Hugging Face/);
  assert.match(text, /okManifest \(dsh-hf-spaces\.json\)found/);
  assert.match(text, /checkEffort levelsrefused: open-model: high/);
  assert.match(text, /https:\/\/your-user-your-llm-space\.hf\.space\/v1 · Hugging Face API/);
  assert.match(text, /Open Model 27B \(open-model\): off, low, medium · Space manifest/);
  assert.match(text, /30 min without use · limit 60 min/);
  assert.match(text, /SPACE_SESSION/);
});

test('a button answer disappears after a few seconds, but not while the pointer is over the notices; an error stays', async () => {
  const timers = [];
  let hovered = true;
  const document = {
    querySelector: selector => (selector === '.dhs-toasts:hover' && hovered ? {} : null),
    head: { appendChild: () => {} },
    createElement: () => ({ setAttribute() {}, remove() {} }),
  };
  const { plugin, render } = load({ state: { locale: 'en', spaces: [{ route: 'my-llm', label: 'My LLM', phase: 'ready', phaseText: 'serving', starts: [] }], account: { credentials: [] } }, actionReply: { kind: 'success', text: 'My LLM paused' }, document, timers });
  const components = apply(plugin, {}).components;
  const Header = components['conversation.session.header.utilities'];
  const Toasts = components['shell.overlay'];
  render(Header, forProvider('my-llm'));
  render(Toasts);
  await tick();
  await findButton(render(Header, forProvider('my-llm')), 'Stop').props.onClick();
  await tick();
  assert.match(textOf(render(Toasts)), /My LLM paused/);
  const runAll = () => { for (const fn of timers.splice(0)) fn(); };
  runAll(); // the answer's time is up, but the pointer is over it
  await tick();
  assert.match(textOf(render(Toasts)), /My LLM paused/, 'kept while read');
  hovered = false;
  runAll();
  await tick();
  assert.doesNotMatch(textOf(render(Toasts) ?? ''), /My LLM paused/, 'gone once the pointer leaves');
});

test('the style sheet is added by apply and removed with the plugin', () => {
  const added = [];
  const document = {
    head: { appendChild: element => added.push(element) },
    createElement: () => ({ attributes: {}, setAttribute(k, v) { this.attributes[k] = v; }, remove() { this.removed = true; } }),
  };
  const { plugin } = load({ document });
  const disposers = [];
  plugin.apply({ slots: { inject: () => {} }, effect: fn => disposers.push(fn()), inject: () => {} });
  assert.equal(added.length, 1);
  assert.ok('data-dsh-hf-spaces' in added[0].attributes);
  assert.match(added[0].textContent, /\.dhs-ind\{/);
  assert.match(added[0].textContent, /prefers-reduced-motion/);
  for (const dispose of disposers) dispose?.();
  assert.equal(added[0].removed, true);
});
