// dsh-hf-spaces Client half (docs/design.md, section 9). A classic script, no build step: the
// Harness loads it in the window and hands `require` React from its own module table
// (docs/contracts.md, section 2). It only reads and acts through the plugin's local routes.
window.__ModuleLoader__.load({
  id: 'dsh-hf-spaces',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;

    // Browser-relative routes, as the official open-in-app client does.
    const STATE_ROUTE = 'dsh-hf-spaces/state';
    const ACTION_ROUTE = 'dsh-hf-spaces/action';
    const FAST_MS = 2000; // while a Space starts or stops
    const SLOW_MS = 15000;

    const TEXT = {
      en: { start: 'Start', stop: 'Stop', extend: n => `+${n} min`, stopsAt: t => `stops at ${t}`, close: 'Close', limitSoon: (l, t) => `${l} stops at ${t}.`, failed: l => `${l} could not start`, refused: l => `${l}: effort levels` },
      'pt-BR': { start: 'Ligar', stop: 'Desligar', extend: n => `+${n} min`, stopsAt: t => `desliga às ${t}`, close: 'Fechar', limitSoon: (l, t) => `${l} desliga às ${t}.`, failed: l => `${l} não ligou`, refused: l => `${l}: níveis de esforço` },
    };

    // ---- One shared poller for every component on screen: at most one request in flight and one
    // timer pending, however often components mount and unmount.
    const store = { data: { locale: 'en', spaces: [] }, result: undefined, listeners: new Set(), timer: undefined, inflight: undefined };
    const notify = () => { for (const listener of store.listeners) listener({ ...store.data, result: store.result }); };
    function refresh() {
      if (store.inflight) return store.inflight;
      clearTimeout(store.timer);
      store.timer = undefined;
      store.inflight = (async () => {
        try {
          const response = await fetch(STATE_ROUTE, { headers: { accept: 'application/json' } });
          if (response.ok) {
            store.data = await response.json();
            notify();
          }
        } catch { /* the Host is restarting: try again later */ }
      })().finally(() => {
        store.inflight = undefined;
        if (store.listeners.size === 0 || store.timer) return;
        const busy = store.data.spaces.some(s => s.phase === 'starting' || s.phase === 'stopping');
        store.timer = setTimeout(refresh, busy ? FAST_MS : SLOW_MS);
      });
      return store.inflight;
    }
    function useStore() {
      const [data, setData] = React.useState({ ...store.data, result: store.result });
      React.useEffect(() => {
        store.listeners.add(setData);
        if (store.listeners.size === 1) void refresh();
        return () => {
          store.listeners.delete(setData);
          if (store.listeners.size === 0) clearTimeout(store.timer);
        };
      }, []);
      return data;
    }
    /** Runs a button's action and keeps its answer for a toast: a refusal must be visible. */
    async function act(route, action) {
      try {
        const response = await fetch(ACTION_ROUTE, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ route, action }) });
        const reply = await response.json().catch(() => ({}));
        store.result = { route, kind: response.ok ? reply.kind : 'error', text: reply.text ?? reply.error ?? `HTTP ${response.status}`, at: Date.now() };
      } catch (error) {
        store.result = { route, kind: 'error', text: String(error?.message ?? error), at: Date.now() };
      } finally {
        notify();
        void refresh();
      }
    }

    // ---- Small pieces, styled with the Harness's semantic tokens only.
    const COLOR = {
      ready: 'var(--dsw-alias-brand-primary)',
      starting: 'var(--dsw-alias-label-secondary)',
      stopping: 'var(--dsw-alias-label-secondary)',
      failed: 'var(--dsw-alias-label-error)',
    };
    const button = (label, onClick, title) => h('button', {
      type: 'button',
      onClick,
      title: title ?? label,
      style: {
        font: 'inherit', fontSize: 12, padding: '1px 8px', borderRadius: 6, cursor: 'pointer',
        color: 'var(--dsw-alias-label-primary)', background: 'transparent',
        border: '1px solid var(--dsw-alias-border-l2)',
      },
    }, label);

    /**
     * Header indicator: only in sessions whose model belongs to a configured Space. The session's
     * model comes from the model-selection projection, read the way the official agent-team client
     * reads it (docs/contracts.md, section 2); a session left on the catalog default shows nothing.
     */
    function HeaderIndicator(props) {
      const { sessionId, useSessions } = props;
      const provider = useSessions(state => state.projectionsBySession?.[sessionId]?.values?.modelSelection?.next?.provider);
      const data = useStore();
      const space = data.spaces.find(s => s.route === provider);
      if (!space) return null;
      const t = TEXT[data.locale] ?? TEXT.en;
      const on = space.phase === 'ready' || space.phase === 'starting' || space.phase === 'stopping';
      const parts = [space.label, space.progress ?? space.phaseText];
      if (space.phase === 'ready' && space.on) parts.push(space.cost ? `${space.on} · ${space.cost}` : space.on);
      if (space.stopsAt) parts.push(t.stopsAt(space.stopsAt));
      return h('span', {
        role: 'status',
        'aria-live': 'polite',
        style: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--dsw-alias-label-secondary)' },
      },
      h('span', { 'aria-hidden': true, style: { width: 7, height: 7, borderRadius: '50%', background: COLOR[space.phase] ?? 'var(--dsw-alias-border-l4)' } }),
      h('span', null, parts.join(' · ')),
      on ? null : button(t.start, () => act(space.route, 'on')),
      on && space.phase !== 'stopping' ? button(t.stop, () => act(space.route, 'off')) : null,
      space.stopsAt ? button(t.extend(space.extend), () => act(space.route, 'extend')) : null);
    }

    /** Toasts: time limit soon, a failed start, refused effort levels. Each can be closed. */
    function Toasts() {
      const data = useStore();
      const [closed, setClosed] = React.useState({});
      const t = TEXT[data.locale] ?? TEXT.en;
      const items = [];
      for (const s of data.spaces) {
        if (s.warning && s.stopsAt) items.push({ key: `limit:${s.route}:${s.stopsAt}`, text: t.limitSoon(s.label, s.stopsAt), actions: [button(t.extend(s.extend), () => act(s.route, 'extend')), button(t.stop, () => act(s.route, 'off'))] });
        if (s.failure) items.push({ key: `failed:${s.route}:${s.failure}`, title: t.failed(s.label), text: s.failure, error: true });
        if (s.refused) items.push({ key: `refused:${s.route}:${s.refused}`, title: t.refused(s.label), text: s.refused });
      }
      // The answer to the last button pressed (a refusal, an unconfirmed pause, "already off").
      if (data.result) items.push({ key: `result:${data.result.at}`, text: data.result.text, error: data.result.kind === 'error' });
      const open = items.filter(item => !closed[item.key]);
      if (open.length === 0) return null;
      return h('div', {
        style: { position: 'fixed', right: 16, bottom: 16, display: 'flex', flexDirection: 'column', gap: 8, zIndex: 1000, maxWidth: 380 },
      }, open.map(item => h('div', {
        key: item.key,
        role: item.error ? 'alert' : 'status',
        style: {
          padding: '10px 12px', borderRadius: 8, fontSize: 13, background: 'var(--dsw-alias-bg-base)',
          color: 'var(--dsw-alias-label-primary)', border: `1px solid ${item.error ? 'var(--dsw-alias-label-error)' : 'var(--dsw-alias-border-l4)'}`,
        },
      },
      item.title ? h('div', { style: { fontWeight: 600, marginBottom: 4 } }, item.title) : null,
      h('div', null, item.text),
      h('div', { style: { display: 'flex', gap: 6, marginTop: 8, justifyContent: 'flex-end' } },
        ...(item.actions ?? []),
        button(t.close, () => setClosed({ ...closed, [item.key]: true }))))));
    }

    const inject = ['slots'];
    function apply(ctx) {
      ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
        name: 'conversation.session.header.utilities',
        id: 'dsh-hf-spaces',
        order: -20,
      }, HeaderIndicator));
      ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'dsh-hf-spaces-toasts' }, Toasts));
      ctx.effect(() => () => clearTimeout(store.timer));
    }
    return { apply, inject };
  },
});
