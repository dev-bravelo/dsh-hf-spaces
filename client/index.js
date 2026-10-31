// dsh-hf-spaces Client half (docs/design.md, section 9). A classic script, no build step: the
// Harness loads it in the window and hands `require` React from its own module table
// (docs/contracts.md, section 2). It only reads and acts through the plugin's local routes.
//
// Only `slots` is required. Every other Harness service and slot is waited for with
// `ctx.inject` / `ctx.slots.inject`: when a Harness version does not have one, only that part of
// the interface is missing, and nothing fails (AGENTS.md, section 7).
//
// Look: the Harness's own theme tokens (`--dsw-*`) in one scoped style sheet (`dhs-` classes).
// One line of state in the header; the detail lives in the sidebar tab. Every state color comes
// with a word, and motion stops under prefers-reduced-motion.
window.__ModuleLoader__.load({
  id: 'dsh-hf-spaces',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;

    // Browser-relative routes, as the official open-in-app client does.
    const STATE_ROUTE = 'dsh-hf-spaces/state';
    const ACTION_ROUTE = 'dsh-hf-spaces/action';
    const SETUP_ROUTE = 'dsh-hf-spaces/setup';
    const BUNDLE = 'dsh-hf-spaces'; // the package name: key of the plugin's page in the Plugins panel
    const TAB_ID = 'dsh-hf-spaces/spaces';
    const TAB_KIND = 'dsh-hf-spaces';
    const CLOSED_KEY = 'dsh-hf-spaces:closed-notices';
    const FAST_MS = 2000; // while a Space starts or stops
    const SLOW_MS = 5000; // otherwise: a start begun from the chat shows within seconds
    const RESULT_MS = 5000; // a button's answer stays this long, unless it is an error

    const TEXT = {
      en: {
        start: 'Start', stop: 'Stop', extend: n => `+${n} min`, close: 'Close', openDetails: 'Open details',
        startingShort: (p, left) => `starting ${p}% · ~${left}`, until: time => `until ${time}`, stopsAt: time => `stops at ${time}`, failedShort: 'did not start',
        limitSoon: (l, time) => `${l} stops at ${time}`, limitHint: n => `The time limit of this start is near. +${n} min keeps it on.`,
        failed: l => `${l} did not start`, refused: l => `${l}: effort levels refused`, whyFailed: 'Why it did not start:',
        tab: 'Hugging Face Spaces', tabHint: 'State, progress, cost and recent starts of each Space',
        left: left => `about ${left} left`, onFor: 'On for', thisStart: 'This start', stops: 'Stops', idle: 'Without use',
        idleAfter: m => `after ${m} min`, at: time => `at ${time}`, soFar: 'so far',
        billed: 'Spent on this Space (Hugging Face billing, not the balance)', today: 'spent today', month: 'spent this month', gpuMin: n => `${n} GPU min`, billingUnread: e => `Billing not read: ${e}`, stale: e => `Not updated: ${e}`, reading: 'Reading…',
        starts: 'Recent starts', noStarts: 'No start recorded yet.', running: 'on now', seen: 'already on when first seen; cost is a minimum',
        log: n => `Run log of the last start (${n} lines)`,
        credentials: 'Credentials', credentialsOk: 'Credentials: all accepted', credentialsProblems: n => `Credentials: ${n} to fix`,
        kinds: { inference: 'read and model requests', control: 'start and stop', billing: 'billing' },
        missing: 'missing from the Harness vault', accepted: (u, r) => `accepted${u ? ` · ${u}` : ''}${r ? ` · ${r} token` : ''}`, rejected: e => `not accepted: ${e}`, checking: 'checking…',
        credentialProblem: n => `Credential ${n}`,
        setup: 'dsh-hf-spaces', setupHint: 'What the plugin read and the values it uses. Settings are edited in the profile configuration.', reload: 'Read again',
        problems: 'Configuration problems',
        source: { config: 'configuration', manifest: 'Space manifest', api: 'Hugging Face API', default: 'default' },
        checks: 'Checks', spaceApi: 'Space on Hugging Face', manifest: 'Manifest (dsh-hf-spaces.json)', served: 'Models served', efforts: 'Effort levels',
        notNeeded: 'not needed: set in the configuration', read: 'read', found: 'found', absent: 'absent: models come from the configuration',
        servedAt: time => `listed when it last served, ${time}`, servedLater: 'checked at the next start',
        effortsOk: 'all accepted', effortsRefused: l => `refused: ${l}`, effortsLater: 'checked at the next start', pending: 'Not read yet.',
        values: 'Values in use', address: 'Address', models: 'Models', defaultEffort: 'Default effort', prefix: 'Progress prefix', sleep: 'Space sleep time',
        hardware: 'Hardware', spaceOwn: 'the Space’s own', ready: 'Ready timeout', automatic: 'Automatic start', yes: 'yes', no: 'no',
        stopRules: 'Stop rules', rules: s => `${s.idleMinutes} min without use · limit ${s.sessionMinutes} min · warning ${s.warnMinutes} min before · +${s.extendMinutes} min`,
        variables: 'Start variables', mark: { ok: 'ok', warn: 'check', error: 'fix', pending: 'later', checking: '…' },
      },
      'pt-BR': {
        start: 'Ligar', stop: 'Desligar', extend: n => `+${n} min`, close: 'Fechar', openDetails: 'Abrir detalhes',
        startingShort: (p, left) => `ligando ${p}% · ~${left}`, until: time => `até ${time}`, stopsAt: time => `desliga às ${time}`, failedShort: 'não ligou',
        limitSoon: (l, time) => `${l} desliga às ${time}`, limitHint: n => `O teto desta partida está perto. +${n} min mantém ligado.`,
        failed: l => `${l} não ligou`, refused: l => `${l}: níveis de esforço recusados`, whyFailed: 'Por que não ligou:',
        tab: 'Spaces do Hugging Face', tabHint: 'Estado, andamento, custo e últimas partidas de cada Space',
        left: left => `faltam ~${left}`, onFor: 'Ligado há', thisStart: 'Esta partida', stops: 'Desliga', idle: 'Sem uso',
        idleAfter: m => `após ${m} min`, at: time => `às ${time}`, soFar: 'até agora',
        billed: 'Gasto deste Space (cobrança do Hugging Face, não é o saldo)', today: 'gasto hoje', month: 'gasto no mês', gpuMin: n => `${n} min de GPU`, billingUnread: e => `Cobrança não lida: ${e}`, stale: e => `Não atualizado: ${e}`, reading: 'Lendo…',
        starts: 'Últimas partidas', noStarts: 'Nenhuma partida registrada ainda.', running: 'ligado agora', seen: 'já estava ligado quando foi visto; o custo é um mínimo',
        log: n => `Log da última partida (${n} linhas)`,
        credentials: 'Credenciais', credentialsOk: 'Credenciais: todas aceitas', credentialsProblems: n => `Credenciais: ${n} a corrigir`,
        kinds: { inference: 'leitura e pedidos ao modelo', control: 'ligar e desligar', billing: 'cobrança' },
        missing: 'falta no cofre do Harness', accepted: (u, r) => `aceita${u ? ` · ${u}` : ''}${r ? ` · token ${r}` : ''}`, rejected: e => `recusada: ${e}`, checking: 'conferindo…',
        credentialProblem: n => `Credencial ${n}`,
        setup: 'dsh-hf-spaces', setupHint: 'O que o plugin leu e os valores que ele usa. A configuração se edita no perfil.', reload: 'Ler de novo',
        problems: 'Problemas na configuração',
        source: { config: 'configuração', manifest: 'manifesto do Space', api: 'API do Hugging Face', default: 'padrão' },
        checks: 'Conferências', spaceApi: 'Space no Hugging Face', manifest: 'Manifesto (dsh-hf-spaces.json)', served: 'Modelos servidos', efforts: 'Níveis de esforço',
        notNeeded: 'não precisa: está na configuração', read: 'lido', found: 'encontrado', absent: 'ausente: os modelos vêm da configuração',
        servedAt: time => `listados na última vez que serviu, ${time}`, servedLater: 'conferido na próxima partida',
        effortsOk: 'todos aceitos', effortsRefused: l => `recusados: ${l}`, effortsLater: 'conferidos na próxima partida', pending: 'Ainda não lido.',
        values: 'Valores em uso', address: 'Endereço', models: 'Modelos', defaultEffort: 'Esforço padrão', prefix: 'Prefixo do andamento', sleep: 'Pausa do Space sem uso',
        hardware: 'Hardware', spaceOwn: 'o do próprio Space', ready: 'Prazo para ficar pronto', automatic: 'Partida automática', yes: 'sim', no: 'não',
        stopRules: 'Regras de desligar', rules: s => `${s.idleMinutes} min sem uso · teto ${s.sessionMinutes} min · aviso ${s.warnMinutes} min antes · +${s.extendMinutes} min`,
        variables: 'Variáveis de partida', mark: { ok: 'ok', warn: 'conferir', error: 'corrigir', pending: 'depois', checking: '…' },
      },
    };
    const textOf = locale => TEXT[locale] ?? TEXT.en;

    const STYLE = `
.dhs-ind{display:inline-flex;align-items:center;gap:4px;min-width:0;max-width:min(340px,38vw);height:24px;font-size:12px;line-height:16px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.dhs-status{display:inline-flex;align-items:center;gap:6px;min-width:0;height:24px;margin:0;padding:0 6px;border:0;border-radius:6px;background:transparent;color:inherit;font:inherit;text-align:left}
button.dhs-status{cursor:pointer}
button.dhs-status:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dhs-name{color:var(--dsw-alias-label-primary);font-weight:500}
.dhs-text{min-width:0;overflow:hidden;text-overflow:ellipsis;font-variant-numeric:tabular-nums}
.dhs-dot{flex:none;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-label-tertiary)}
.dhs-dot[data-phase=off],.dhs-dot[data-phase=unknown]{background:transparent;box-shadow:inset 0 0 0 1px var(--dsw-alias-label-tertiary)}
.dhs-dot[data-phase=starting]{background:var(--dsw-alias-state-business-primary);animation:dhs-pulse 1.6s ease-in-out infinite}
.dhs-dot[data-phase=stopping]{animation:dhs-pulse 1.6s ease-in-out infinite}
.dhs-dot[data-phase=ready]{background:var(--dsw-alias-state-success-primary)}
.dhs-dot[data-phase=failed]{background:var(--dsw-alias-state-error-primary)}
.dhs-dot[data-warn=true],.dhs-dot[data-level=warn]{background:var(--dsw-alias-state-warn-primary)}
.dhs-dot[data-level=error]{background:var(--dsw-alias-state-error-primary)}
@keyframes dhs-pulse{0%,100%{opacity:1}50%{opacity:.3}}
.dhs-meter{flex:none;width:32px;height:3px;border-radius:2px;background:var(--dsw-alias-border-l2);overflow:hidden}
.dhs-meter>i,.dhs-bar>i{display:block;width:100%;height:100%;background:var(--dsw-alias-state-business-primary);transform-origin:left center;transition:transform .5s ease}
.dhs-btn{flex:none;height:24px;padding:0 8px;border:1px solid var(--dsw-alias-border-l3);border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:16px;cursor:pointer;white-space:nowrap}
.dhs-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dhs-btn:focus-visible,button.dhs-status:focus-visible,.dhs-panel summary:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}
.dhs-warn{color:var(--dsw-alias-state-warn-label)}
.dhs-error{color:var(--dsw-alias-state-error-primary)}
.dhs-muted{color:var(--dsw-alias-label-tertiary)}
.dhs-sr{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
.dhs-panel{box-sizing:border-box;height:100%;overflow:auto;padding:16px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}
.dhs-space+.dhs-space,.dhs-panel>.dhs-cred{margin-top:20px;padding-top:16px;border-top:1px solid var(--dsw-alias-border-l2)}
.dhs-head{display:flex;align-items:center;gap:8px;min-width:0}
.dhs-title{font-size:14px;line-height:20px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dhs-head .dhs-btn{margin-left:auto}
.dhs-meta{margin-top:2px;font-size:12px;line-height:16px;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}
.dhs-section{margin-top:16px}
.dhs-caption{margin-bottom:6px;font-size:12px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.dhs-progress{display:flex;justify-content:space-between;gap:12px;font-size:12px;font-variant-numeric:tabular-nums}
.dhs-bar{height:4px;margin-top:6px;border-radius:2px;background:var(--dsw-alias-border-l2);overflow:hidden}
.dhs-facts{display:grid;grid-template-columns:max-content 1fr;align-items:center;column-gap:16px;row-gap:6px;margin:0;font-size:12px;font-variant-numeric:tabular-nums}
.dhs-facts dt{color:var(--dsw-alias-label-secondary)}
.dhs-facts dd{display:flex;align-items:center;gap:8px;margin:0}
.dhs-pair{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.dhs-figure{font-size:16px;line-height:22px;font-weight:600;font-variant-numeric:tabular-nums}
.dhs-rows{display:grid;grid-template-columns:max-content max-content max-content minmax(0,1fr);column-gap:12px;row-gap:4px;font-size:12px;font-variant-numeric:tabular-nums}
.dhs-rows .dhs-reason{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary)}
.dhs-panel details{margin-top:16px}
.dhs-panel summary{cursor:pointer;font-size:12px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.dhs-log{margin:8px 0 0;padding:8px;border-radius:6px;background:var(--dsw-alias-markdown-code-block);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;white-space:pre-wrap;word-break:break-all;max-height:220px;overflow:auto}
.dhs-list{margin:8px 0 0;padding:0;list-style:none;display:flex;flex-direction:column;gap:4px;font-size:12px}
.dhs-toasts{position:fixed;right:16px;bottom:16px;z-index:1000;display:flex;flex-direction:column;gap:8px;width:min(360px,calc(100vw - 32px))}
.dhs-toast{padding:10px 12px;border-radius:8px;background:var(--dsw-alias-toast-bg);color:var(--dsw-alias-toast-label);box-shadow:var(--dsw-elevation-prominent);font-size:13px;line-height:18px}
.dhs-toast-title{display:flex;align-items:center;gap:6px;margin-bottom:2px;font-weight:600}
.dhs-toast-actions{display:flex;justify-content:flex-end;gap:6px;margin-top:8px}
.dhs-toast .dhs-btn{color:inherit;border-color:color-mix(in srgb,currentColor 32%,transparent)}
.dhs-toast .dhs-btn:hover{background:color-mix(in srgb,currentColor 12%,transparent)}
.dhs-setup{display:flex;flex-direction:column;gap:12px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}
.dhs-setup-head{display:flex;align-items:center;gap:12px}
.dhs-card{padding:12px 16px;border-radius:10px;background:var(--dsw-alias-settings-card-fill);box-shadow:inset 0 0 0 1px var(--dsw-alias-settings-card-stroke)}
.dhs-card>.dhs-section:first-child{margin-top:0}
.dhs-checks{margin:0;padding:0;list-style:none;display:grid;grid-template-columns:max-content max-content minmax(0,1fr);column-gap:12px;row-gap:4px;font-size:12px}
.dhs-checks>li{display:contents}
.dhs-mark{font-weight:600}
.dhs-mark[data-level=ok]{color:var(--dsw-alias-state-success-primary)}
.dhs-mark[data-level=warn]{color:var(--dsw-alias-state-warn-label)}
.dhs-mark[data-level=error]{color:var(--dsw-alias-state-error-primary)}
.dhs-mark[data-level=pending],.dhs-mark[data-level=checking]{color:var(--dsw-alias-label-tertiary)}
.dhs-table{width:100%;border-collapse:collapse;font-size:12px}
.dhs-table td{padding:3px 12px 3px 0;vertical-align:top;overflow-wrap:anywhere}
.dhs-table td:first-child{white-space:nowrap;color:var(--dsw-alias-label-secondary)}
@media (prefers-reduced-motion:reduce){.dhs-dot{animation:none!important}.dhs-meter>i,.dhs-bar>i{transition:none}}
`;

    // ---- Optional Harness services, set when (and while) they exist.
    const services = { directories: undefined, sidebar: undefined };

    // ---- Notices closed by the user stay closed after a reload (this viewer only).
    const closedStore = {
      read() {
        try { return new Set(JSON.parse(window.localStorage?.getItem(CLOSED_KEY) ?? '[]')); } catch { return new Set(); }
      },
      add(key) {
        try {
          const keys = [...this.read(), key].slice(-50);
          window.localStorage?.setItem(CLOSED_KEY, JSON.stringify(keys));
        } catch { /* storage blocked: closed for this view only */ }
      },
    };

    // ---- One shared poller for every component on screen: at most one request in flight and one
    // timer pending, however often components mount and unmount.
    const store = { data: { locale: 'en', spaces: [], account: { credentials: [] } }, result: undefined, listeners: new Set(), timer: undefined, inflight: undefined };
    /** True while the pointer is over the notices: an answer being read does not disappear. */
    const noticesHovered = () => {
      try { return Boolean(document.querySelector('.dhs-toasts:hover')); } catch { return false; }
    };
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
          if (store.listeners.size === 0) {
            clearTimeout(store.timer);
            store.timer = undefined;
          }
        };
      }, []);
      return data;
    }
    /** A button's answer is a notice: an error stays until closed, anything else for a few seconds. */
    function showResult(result) {
      store.result = result;
      notify();
      if (result.kind === 'error') return;
      const expire = () => {
        if (store.result !== result) return;
        if (noticesHovered()) return void setTimeout(expire, 1000); // paused while read
        store.result = undefined;
        notify();
      };
      setTimeout(expire, RESULT_MS);
    }
    async function act(route, action) {
      try {
        const response = await fetch(ACTION_ROUTE, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ route, action }) });
        const reply = await response.json().catch(() => ({}));
        showResult({ route, kind: response.ok ? reply.kind : 'error', text: reply.text ?? reply.error ?? `HTTP ${response.status}`, at: Date.now() });
      } catch (error) {
        showResult({ route, kind: 'error', text: String(error?.message ?? error), at: Date.now() });
      } finally {
        void refresh();
      }
    }
    /** Opens the plugin's sidebar tab in the session on screen; does nothing without the sidebar. */
    function openTab() {
      try { services.sidebar?.openTab(TAB_KIND, { revealIfOpened: true }); } catch { /* no session on screen */ }
    }

    /**
     * The model in effect in a session: the model-selection service resolves "the session's choice,
     * else the profile default". Without that service, the session's own choice only.
     */
    function useSessionProvider(sessionId, useSessions) {
      const chosen = useSessions(state => state.projectionsBySession?.[sessionId]?.values?.modelSelection?.next?.provider);
      const directories = services.directories;
      const source = React.useMemo(() => {
        try { return directories?.directoryFor(sessionId)?.store; } catch { return undefined; }
      }, [directories, sessionId]);
      const subscribe = React.useCallback((listener) => {
        try {
          const off = source?.subscribe?.(listener);
          return typeof off === 'function' ? off : () => {};
        } catch { return () => {}; }
      }, [source]);
      const read = React.useCallback(() => {
        try { return source?.getSnapshot?.()?.current?.provider; } catch { return undefined; }
      }, [source]);
      const current = React.useSyncExternalStore(subscribe, read, read);
      return current ?? chosen;
    }

    // ---- Small pieces.
    const button = (label, onClick, extra = {}) => h('button', { type: 'button', className: 'dhs-btn', onClick, ...extra }, label);
    const dot = (phase, warn) => h('span', { className: 'dhs-dot', 'data-phase': phase, 'data-warn': warn ? 'true' : undefined, 'aria-hidden': 'true' });
    const fill = percent => h('i', { style: { transform: `scaleX(${Math.max(0.02, Math.min(1, (percent ?? 0) / 100))})` } });
    /** The one action of a Space now: start it, or stop it. */
    const mainAction = (space, t) => {
      if (space.phase === 'stopping') return null;
      const on = space.phase === 'starting' || space.phase === 'ready';
      return on ? button(t.stop, () => act(space.route, 'off')) : button(t.start, () => act(space.route, 'on'));
    };
    /** The header's short state: what it is doing, and the one number that matters now. */
    const shortStatus = (space, t) => {
      if (space.phase === 'starting') return space.percent !== undefined ? t.startingShort(space.percent, space.left) : space.phaseText;
      if (space.phase === 'failed') return t.failedShort;
      if (space.phase === 'ready' && space.stopsAt) return `${space.phaseText} · ${space.warning ? t.stopsAt(space.stopsAt) : t.until(space.stopsAt)}`;
      return space.phaseText;
    };
    /** Everything known, for the tooltip. */
    const fullStatus = (space, t) => [space.label, space.progress ?? space.phaseText, space.on ? `${t.onFor.toLowerCase()} ${space.on}${space.cost ? ` · ${space.cost}` : ''}` : '', space.stopsAt ? t.stopsAt(space.stopsAt) : '']
      .filter(Boolean).join(' · ');
    const credentialText = (c, t) => (!c.present ? t.missing : c.ok === true ? t.accepted(c.user, c.role) : c.ok === false ? t.rejected(c.error) : t.checking);
    /** A credential that keeps a Space from serving or starting (billing alone does not). */
    const blocking = c => c.kind !== 'billing' && (!c.present || c.ok === false);
    const section = (title, ...children) => h('section', { className: 'dhs-section' }, h('div', { className: 'dhs-caption' }, title), ...children);

    /** Header indicator: one line, only in sessions whose model (chosen, or the profile default) is a configured Space. */
    function HeaderIndicator(props) {
      const provider = useSessionProvider(props.sessionId, props.useSessions);
      const data = useStore();
      const space = data.spaces.find(s => s.route === provider);
      if (!space) return null;
      const t = textOf(data.locale);
      const short = shortStatus(space, t);
      const full = fullStatus(space, t);
      const canOpen = Boolean(services.sidebar);
      return h('span', { className: 'dhs-ind' },
        // Announced only when the state changes, never at each percent (one atomic status).
        h('span', { className: 'dhs-sr', role: 'status', 'aria-atomic': 'true' }, `${space.label}: ${space.phaseText}`),
        h(canOpen ? 'button' : 'span', {
          className: 'dhs-status',
          title: full,
          ...(canOpen ? { type: 'button', onClick: openTab, 'aria-label': `${space.label} ${short}. ${t.openDetails}` } : {}),
        },
        dot(space.phase, space.warning),
        h('span', { className: 'dhs-name' }, space.label),
        h('span', { className: `dhs-text${space.warning ? ' dhs-warn' : space.phase === 'failed' ? ' dhs-error' : ''}` }, short),
        space.phase === 'starting' && space.percent !== undefined ? h('span', { className: 'dhs-meter', 'aria-hidden': 'true' }, fill(space.percent)) : null),
        mainAction(space, t));
    }

    /** One Space in the sidebar tab: state and action, progress or time on, billing, recent starts, run log. */
    function SpaceSection({ space, t }) {
      const facts = [];
      if (space.phase === 'ready' && space.on) facts.push([t.onFor, space.on]);
      if (space.phase === 'ready' && space.cost) facts.push([t.thisStart, `${space.cost} ${t.soFar}`]);
      if (space.stopsAt) facts.push([t.stops, h('span', { className: space.warning ? 'dhs-warn' : undefined }, t.at(space.stopsAt)), button(t.extend(space.extend), () => act(space.route, 'extend'))]);
      if (space.phase === 'ready' && space.idle > 0) facts.push([t.idle, t.idleAfter(space.idle)]);
      return h('div', { className: 'dhs-space' },
        h('div', { className: 'dhs-head' },
          dot(space.phase, space.warning),
          h('span', { className: 'dhs-title' }, space.label),
          h('span', { className: space.phase === 'failed' ? 'dhs-error' : 'dhs-muted' }, space.phaseText),
          mainAction(space, t)),
        h('div', { className: 'dhs-meta' }, [space.space, space.route, space.hardware].filter(Boolean).join(' · ')),
        space.phase === 'starting' && space.percent !== undefined ? h('div', { className: 'dhs-section' },
          h('div', { className: 'dhs-progress' }, h('span', null, space.stage), h('span', null, `${space.percent}% · ${t.left(space.left)}`)),
          h('div', { className: 'dhs-bar', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': space.percent, 'aria-valuetext': space.progress }, fill(space.percent))) : null,
        facts.length ? h('dl', { className: 'dhs-facts dhs-section' }, ...facts.flatMap(([label, ...value]) => [h('dt', { key: `${label}-t` }, label), h('dd', { key: `${label}-d` }, ...value)])) : null,
        space.failure ? h('div', { className: 'dhs-section', role: 'alert' }, h('span', { className: 'dhs-error' }, t.whyFailed), ' ', space.failure) : null,
        space.refused ? h('div', { className: 'dhs-section dhs-warn' }, space.refused) : null,
        section(t.billed, space.usage
          ? h('div', { className: 'dhs-pair' },
            h('div', null, h('div', { className: 'dhs-figure' }, space.usage.today), h('div', { className: 'dhs-muted' }, `${t.today} · ${t.gpuMin(space.usage.todayMinutes)}`)),
            h('div', null, h('div', { className: 'dhs-figure' }, space.usage.month), h('div', { className: 'dhs-muted' }, `${t.month} · ${t.gpuMin(space.usage.monthMinutes)}`)))
          : h('div', { className: space.usageError ? 'dhs-error' : 'dhs-muted' }, space.usageError ? t.billingUnread(space.usageError) : t.reading),
        space.usage && space.usageError ? h('div', { className: 'dhs-warn', style: { marginTop: 6, fontSize: 12 } }, t.stale(space.usageError)) : null),
        section(t.starts, space.starts.length
          ? h('div', { className: 'dhs-rows' }, ...space.starts.flatMap(s => [
            h('span', { key: `${s.at}-w`, title: s.seen ? t.seen : undefined }, `${s.day} ${s.clock}`),
            h('span', { key: `${s.at}-d` }, s.open ? t.running : s.duration ?? ''),
            h('span', { key: `${s.at}-c` }, s.cost ?? ''),
            h('span', { key: `${s.at}-r`, className: 'dhs-reason', title: s.end ?? '' }, s.end ?? '')]))
          : h('div', { className: 'dhs-muted' }, t.noStarts)),
        space.logTail ? h('details', null, h('summary', null, t.log(space.logTail.length)), h('pre', { className: 'dhs-log' }, space.logTail.join('\n'))) : null);
    }

    /** The sidebar tab: each Space, then the credentials (open by default when one needs a fix). */
    function SidebarPanel() {
      const data = useStore();
      const t = textOf(data.locale);
      const credentials = data.account?.credentials ?? [];
      const problems = credentials.filter(c => !c.present || c.ok === false).length;
      return h('div', { className: 'dhs-panel' },
        ...data.spaces.map(space => h(SpaceSection, { key: space.route, space, t })),
        credentials.length ? h('details', { className: 'dhs-cred', open: problems > 0 || undefined },
          h('summary', { className: problems ? 'dhs-error' : undefined }, problems ? t.credentialsProblems(problems) : t.credentialsOk),
          h('ul', { className: 'dhs-list' }, ...credentials.map(c => h('li', { key: c.kind },
            h('code', null, c.name), ` · ${t.kinds[c.kind] ?? c.kind}: `,
            h('span', { className: c.present && c.ok !== false ? undefined : 'dhs-error' }, credentialText(c, t)))))) : null);
    }

    /**
     * Notices: only what needs an action or blocks a Space. The time limit and the answer to a
     * button come from what the user does; a failed start, refused effort levels and a credential
     * that blocks starting persist until closed, and a closed one stays closed after a reload.
     */
    function Toasts() {
      const data = useStore();
      const [closed, setClosed] = React.useState(() => closedStore.read());
      const t = textOf(data.locale);
      const items = [];
      for (const s of data.spaces) {
        if (s.warning && s.stopsAt) items.push({ key: `limit:${s.route}:${s.stopsAt}`, level: 'warn', title: t.limitSoon(s.label, s.stopsAt), text: t.limitHint(s.extend), actions: [button(t.extend(s.extend), () => act(s.route, 'extend')), button(t.stop, () => act(s.route, 'off'))] });
        if (s.failure) items.push({ key: `failed:${s.route}:${s.failureAt ?? s.failure}`, level: 'error', title: t.failed(s.label), text: s.failure, remember: true });
        if (s.refused) items.push({ key: `refused:${s.route}:${s.refused}`, level: 'warn', title: t.refused(s.label), text: s.refused, remember: true });
      }
      for (const c of data.account?.credentials ?? []) {
        if (!blocking(c)) continue;
        // Not remembered: the same problem may come back later, and it blocks starting.
        items.push({ key: `credential:${c.kind}:${c.present}:${c.error ?? ''}`, level: 'error', title: t.credentialProblem(c.name), text: `${t.kinds[c.kind] ?? c.kind}: ${credentialText(c, t)}` });
      }
      if (data.result) items.push({ key: `result:${data.result.at}`, level: data.result.kind === 'error' ? 'error' : 'info', text: data.result.text });
      const open = items.filter(item => !closed.has(item.key));
      if (open.length === 0) return null;
      const close = (item) => {
        if (item.remember) closedStore.add(item.key);
        if (data.result && item.key === `result:${data.result.at}`) { store.result = undefined; notify(); }
        setClosed(new Set([...closed, item.key]));
      };
      return h('div', { className: 'dhs-toasts' }, open.map(item => h('div', { key: item.key, className: 'dhs-toast', role: item.level === 'error' ? 'alert' : 'status' },
        item.title ? h('div', { className: 'dhs-toast-title' }, item.level === 'info' ? null : h('span', { className: 'dhs-dot', 'data-level': item.level, 'aria-hidden': 'true' }), item.title) : null,
        h('div', null, item.text),
        h('div', { className: 'dhs-toast-actions' }, ...(item.actions ?? []), button(t.close, () => close(item), { 'aria-label': `${t.close}: ${item.title ?? item.text}` })))));
    }

    /** The plugin's page in the Plugins panel: what needs a fix first, then each value with its source. */
    function SetupPage() {
      const [setup, setSetup] = React.useState(undefined);
      const load = React.useCallback(async () => {
        try {
          const response = await fetch(SETUP_ROUTE, { headers: { accept: 'application/json' } });
          if (response.ok) setSetup(await response.json());
        } catch { /* the Host is restarting */ }
      }, []);
      React.useEffect(() => { void load(); }, [load]);
      if (!setup) return null;
      const t = textOf(setup.locale);
      const check = (key, level, label, value) => h('li', { key },
        h('span', { className: 'dhs-mark', 'data-level': level }, t.mark[level]),
        h('span', { className: 'dhs-muted' }, label),
        h('span', null, value));
      const readLevel = v => (v === 'read' || v === 'found' || v === 'not needed' ? 'ok' : v === 'absent' ? 'ok' : 'error');
      const readText = v => (v === 'not needed' ? t.notNeeded : v === 'read' ? t.read : v === 'found' ? t.found : v === 'absent' ? t.absent : v);
      const row = (label, value, source) => h('tr', { key: label },
        h('td', null, label),
        h('td', null, value, source ? h('span', { className: 'dhs-muted' }, ` · ${t.source[source] ?? source}`) : null));
      const spaceCard = (s) => {
        const v = s.values;
        return h('div', { key: s.route, className: 'dhs-card' },
          h('div', { className: 'dhs-head' }, h('span', { className: 'dhs-title' }, s.label), h('span', { className: 'dhs-muted' }, `${s.route} · ${s.id}`)),
          s.problem ? h('div', { className: 'dhs-section dhs-error', role: 'alert' }, s.problem) : null,
          s.pending ? h('div', { className: 'dhs-section dhs-muted' }, t.pending) : null,
          s.checks ? section(t.checks, h('ul', { className: 'dhs-checks' },
            check('api', readLevel(s.checks.api), t.spaceApi, readText(s.checks.api)),
            check('manifest', s.checks.manifest === 'not needed' || s.checks.manifest === 'found' || s.checks.manifest === 'absent' ? 'ok' : 'warn', t.manifest, readText(s.checks.manifest)),
            v ? check('served', s.servedAt ? 'ok' : 'pending', t.served, s.servedAt ? t.servedAt(new Date(s.servedAt).toLocaleString(setup.locale)) : t.servedLater) : null,
            s.efforts ? check('efforts', s.efforts.checked ? (s.efforts.refused.length ? 'warn' : 'ok') : 'pending', t.efforts, s.efforts.checked ? (s.efforts.refused.length ? t.effortsRefused(s.efforts.refused.join(', ')) : t.effortsOk) : t.effortsLater) : null)) : null,
          v ? section(t.values, h('table', { className: 'dhs-table' }, h('tbody', null,
            row(t.address, v.baseURL.value, v.baseURL.source),
            row(t.models, v.models.value.map(m => `${m.name} (${m.id})${m.efforts.length ? `: ${m.efforts.join(', ')}` : ''}`).join('; '), v.models.source),
            v.defaultEffort ? row(t.defaultEffort, v.defaultEffort.value, v.defaultEffort.source) : null,
            row(t.prefix, v.eventPrefix.value, v.eventPrefix.source),
            v.sleepSeconds ? row(t.sleep, `${Math.round(v.sleepSeconds.value / 60)} min`, v.sleepSeconds.source) : null,
            row(t.hardware, v.hardware ?? t.spaceOwn),
            row(t.ready, `${v.readyTimeoutMinutes} min`),
            row(t.automatic, v.automatic ? t.yes : t.no),
            row(t.stopRules, t.rules(v.stop)),
            v.startVariables.length ? row(t.variables, v.startVariables.join(', ')) : null))) : null);
      };
      const credentialLevel = c => (c.present && c.ok !== false ? (c.ok ? 'ok' : 'checking') : c.kind === 'billing' ? 'warn' : 'error');
      return h('div', { className: 'dhs-setup' },
        h('div', { className: 'dhs-setup-head' }, h('div', { className: 'dhs-muted' }, t.setupHint), button(t.reload, () => { void load(); })),
        setup.problems.length ? h('div', { className: 'dhs-card', role: 'alert' }, h('section', { className: 'dhs-section' }, h('div', { className: 'dhs-caption dhs-error' }, t.problems), ...setup.problems.map(p => h('div', { key: p, style: { overflowWrap: 'anywhere' } }, p)))) : null,
        h('div', { className: 'dhs-card' }, section(t.credentials, h('ul', { className: 'dhs-checks' },
          ...setup.credentials.map(c => check(c.kind, credentialLevel(c), t.kinds[c.kind] ?? c.kind, h('span', null, h('code', null, c.name), ` · ${credentialText(c, t)}`)))))),
        ...setup.spaces.map(spaceCard));
    }

    const inject = ['slots'];
    function apply(ctx) {
      // One scoped style sheet, removed with the plugin.
      // Each instance owns its element: during an update the old and new ones may briefly coexist.
      ctx.effect(() => {
        if (typeof document === 'undefined') return () => {};
        const style = document.createElement('style');
        style.setAttribute('data-dsh-hf-spaces', '');
        style.textContent = STYLE;
        document.head.appendChild(style);
        return () => style.remove();
      }, 'dsh-hf-spaces: style');
      ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
        name: 'conversation.session.header.utilities',
        id: 'dsh-hf-spaces',
        order: -20,
      }, HeaderIndicator));
      ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'dsh-hf-spaces-toasts' }, Toasts));
      ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({ name: 'plugins.bundle.config', key: BUNDLE }, SetupPage));
      ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name: 'sidebar.right.pane.tab', key: TAB_ID }, SidebarPanel));

      // Optional services: each part works without the others.
      ctx.inject(['sidebarRightTabs'], (scope) => {
        scope.effect(() => scope.sidebarRightTabs.register({
          id: TAB_ID,
          kind: TAB_KIND,
          title: () => textOf(store.data.locale).tab,
          guide: [{ id: 'open', order: 70, title: () => textOf(store.data.locale).tab, description: () => textOf(store.data.locale).tabHint }],
        }), 'dsh-hf-spaces: sidebar tab');
      });
      ctx.inject(['sidebarRight'], (scope) => {
        services.sidebar = scope.sidebarRight;
        scope.effect(() => () => { if (services.sidebar === scope.sidebarRight) services.sidebar = undefined; }, 'dsh-hf-spaces: sidebar');
      });
      ctx.inject(['modelDirectories'], (scope) => {
        services.directories = scope.modelDirectories;
        scope.effect(() => () => { if (services.directories === scope.modelDirectories) services.directories = undefined; }, 'dsh-hf-spaces: model of each session');
      });
      ctx.effect(() => () => clearTimeout(store.timer));
    }
    return { apply, inject };
  },
});
