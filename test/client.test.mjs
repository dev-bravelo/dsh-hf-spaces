// Runs the Client half as the Harness would load it, with a minimal stand-in for React: enough to
// check its registration and what the header indicator shows. The real look is checked by hand
// on the Desktop (design, roadmap phase 2).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const source = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'client', 'index.js'), 'utf8');
const textOf = node => (node == null || typeof node === 'boolean' ? '' : typeof node === 'string' ? node
  : Array.isArray(node) ? node.map(textOf).join('') : textOf(node.children));

function load(views, actionReply = { kind: 'success', text: 'done' }) {
  let definition;
  const requests = [];
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children: children.flat() }),
    useState: initial => [initial, () => {}],
    useEffect: effect => { effect(); },
  };
  const context = {
    window: { __ModuleLoader__: { load: d => { definition = d; } } },
    fetch: async (url, init) => {
      requests.push({ url, init });
      return { ok: true, json: async () => (url === 'dsh-hf-spaces/action' ? actionReply : { locale: 'en', spaces: views }) };
    },
    setTimeout: () => 0,
    clearTimeout: () => {},
  };
  vm.runInNewContext(source, context);
  const plugin = definition.factory(name => { assert.equal(name, 'react'); return React; });
  return { definition, plugin, requests };
}

test('registers under the package name: header utilities and the overlay, with the slots service', () => {
  const { definition, plugin } = load([]);
  assert.equal(definition.id, 'dsh-hf-spaces');
  assert.deepEqual([...plugin.inject], ['slots']); // copied out of the script's own realm
  const registered = [];
  plugin.apply({
    slots: { inject: (name, fn) => fn(), register: (options, component) => { registered.push([options.name, component.name]); return () => {}; } },
    effect: () => {},
  });
  assert.deepEqual(registered, [['conversation.session.header.utilities', 'HeaderIndicator'], ['shell.overlay', 'Toasts']]);
});

test('header indicator: shown only for a Space route, with progress and the right buttons', async () => {
  const views = [{ route: 'my-llm', label: 'My LLM', phase: 'starting', phaseText: 'starting', progress: 'Copying the model · 35% · about 2 min left', extend: 60 }];
  const { plugin, requests } = load(views);
  const components = {};
  plugin.apply({ slots: { inject: (n, fn) => fn(), register: (o, c) => { components[o.name] = c; } }, effect: () => {} });
  const Header = components['conversation.session.header.utilities'];
  const forProvider = provider => ({ sessionId: 's1', useSessions: select => select({ projectionsBySession: { s1: { values: { modelSelection: { next: { provider } } } } } }) });
  Header(forProvider('my-llm')); // first render starts the shared poller
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests[0].url, 'dsh-hf-spaces/state', 'a browser-relative route');
  assert.equal(Header(forProvider('openai')), null, 'other providers show nothing');
  const shown = Header(forProvider('my-llm'));
  assert.match(textOf(shown), /My LLM · Copying the model · 35% · about 2 min left/);
  assert.ok(textOf(shown).includes('Stop'));
  assert.ok(!textOf(shown).includes('Start'));
});

/** Finds the first element whose text includes `label` and that has an onClick. */
const findButton = (node, label) => {
  if (!node || typeof node !== 'object') return undefined;
  if (Array.isArray(node)) { for (const n of node) { const found = findButton(n, label); if (found) return found; } return undefined; }
  if (node.type === 'button' && textOf(node.children) === label) return node;
  return findButton(node.children, label);
};

test('toasts: time limit soon with +N and Stop, a failure, and the answer to a button', async () => {
  const views = [{ route: 'my-llm', label: 'My LLM', phase: 'ready', phaseText: 'serving', stopsAt: '15:42', warning: true, extend: 60 },
    { route: 'other', label: 'Other', phase: 'failed', phaseText: 'failed', failure: 'Other could not be started: no GPU.' }];
  const { plugin, requests } = load(views, { kind: 'error', text: 'the credential X is missing' });
  const components = {};
  plugin.apply({ slots: { inject: (n, fn) => fn(), register: (o, c) => { components[o.name] = c; } }, effect: () => {} });
  const Toasts = components['shell.overlay'];
  Toasts();
  await new Promise(resolve => setImmediate(resolve));
  const shown = Toasts();
  assert.match(textOf(shown), /My LLM stops at 15:42\./);
  assert.match(textOf(shown), /Other could not start/);
  // The +60 button sends the extend action for that route, and its answer becomes a toast.
  await findButton(shown, '+60 min').props.onClick();
  const action = requests.find(r => r.url === 'dsh-hf-spaces/action');
  assert.deepEqual(JSON.parse(action.init.body), { route: 'my-llm', action: 'extend' });
  await new Promise(resolve => setImmediate(resolve));
  assert.match(textOf(Toasts()), /the credential X is missing/);
});
