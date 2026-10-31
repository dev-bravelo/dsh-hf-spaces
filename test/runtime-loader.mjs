// Mounts the plugin on an installed DeepSeek Harness, offline: no persistence, no network beyond
// 127.0.0.1. Run with the app's Electron in Node mode (see AGENTS.md, section 6):
//   ELECTRON_RUN_AS_NODE=1 DSH_TEST_RUNTIME_ROOT=<app>/resources/app.asar/dsh <app-exe> --test test/runtime.test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire, registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = process.env.DSH_TEST_RUNTIME_ROOT;
const requireRuntime = createRequire(path.join(root, 'package.json'));
const pluginRoot = pathToFileURL(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..') + path.sep).href;

// The plugin's `@deepseek-ai/*` imports are peers: resolve them to the installed Harness copies.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.startsWith(pluginRoot) && specifier.startsWith('@deepseek-ai/')) {
      return nextResolve(pathToFileURL(requireRuntime.resolve(specifier)).href, context);
    }
    return nextResolve(specifier, context);
  },
});

export const runtimePackage = name => requireRuntime(name);
/** File URL of an installed Harness package, for ES module imports. */
export const runtimeURL = name => pathToFileURL(requireRuntime.resolve(name)).href;
/** A Harness package's plugin export, whichever shape the installed version uses. */
export const asPlugin = mod => mod.default ?? mod;

/**
 * A context with the LLM service and the Harness credential store. The store gets an empty
 * temporary file, so credentials come only from the test's environment variables (source "env"),
 * as they would in the Desktop with nothing stored.
 */
export async function environment({ agents = false } = {}) {
  const { Context } = runtimePackage('@deepseek-ai/cordis');
  const ctx = new Context();
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-hf-spaces-test-'));
  // With `agents`: the real agent loop and the jobs registry, as on the Desktop, but no persistence.
  const stack = agents
    ? [['dsh-session'], ['dsh-session-projection'], ['dsh-agent'], ['dsh-llm'],
      ['dsh-system-prompt', { includeHarnessIdentity: false, includeRuntimeContext: false }],
      ['dsh-tools', { mode: 'native' }], ['dsh-agent-loop', { agents: [], maxParallelToolCalls: 1 }],
      ['dsh-jobs-local'], ['dsh-tool-jobs'], ['dsh-commands']]
    : [['dsh-llm']];
  for (const [name, config] of stack) await ctx.plugin(asPlugin(runtimePackage(`@deepseek-ai/${name}`)), config);
  if (ctx.get('sessionPersistence') !== undefined) throw new Error('Tests must never use a persistence backend');
  await ctx.plugin(asPlugin(runtimePackage('@deepseek-ai/dsh-credentials-local')), { path: path.join(store, '.credentials.yaml') });
  return {
    ctx,
    dispose: () => {
      ctx.fiber.dispose();
      fs.rmSync(store, { recursive: true, force: true });
    },
  };
}
