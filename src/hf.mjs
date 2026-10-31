/**
 * The small Hugging Face client this plugin needs, on Node's `fetch` only.
 * - Tokens go only to https://huggingface.co and to the Space's own https://*.hf.space address
 *   (or to this machine, in offline tests).
 * - Redirects are never followed with a token attached.
 * - Reads use the inference credential; start, stop and hardware changes use the control one.
 * Contracts: docs/contracts.md, section 1.
 */
import { isLoopbackURL, isSpaceURL } from './config.mjs';

export const HF_API = 'https://huggingface.co';
const TIMEOUT_MS = 15000;
/** A manifest is a few hundred bytes; anything far larger is refused instead of buffered. */
export const MAX_FILE_BYTES = 64 * 1024;

export class HfError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'HfError';
    this.status = status;
  }
}

const spacePath = id => id.split('/').map(encodeURIComponent).join('/');

function hint(status, kind) {
  if (status === 400 && kind === 'control') return ' (Hugging Face refused the request; for a hardware change, check the name, such as a100-large or l40sx1)';
  if (status === 401) return ` (the ${kind} credential is missing or was not accepted)`;
  if (status === 403) return kind === 'control'
    ? ' (the control credential cannot change this Space; it needs write access and the Space owner)'
    : ' (the inference credential cannot read this Space)';
  if (status === 404) return ` (no such Space, or the ${kind} credential cannot see it)`;
  return '';
}

/**
 * The runtime facts the supervisor needs, from GET /runtime or from the reply of pause, restart
 * and hardware requests. The prototype read errors from `errorMessage` or `compute.status.message`.
 * @returns {{ stage?: string, current: string | null, requested?: string, gcTimeout?: number, error?: string }}
 */
export function normalizeRuntime(body) {
  const error = body?.errorMessage ?? body?.compute?.status?.message;
  return {
    ...(typeof body?.stage === 'string' ? { stage: body.stage } : {}),
    current: typeof body?.hardware?.current === 'string' ? body.hardware.current : null,
    ...(typeof body?.hardware?.requested === 'string' ? { requested: body.hardware.requested } : {}),
    ...(Number.isSafeInteger(body?.gcTimeout) ? { gcTimeout: body.gcTimeout } : {}),
    ...(typeof error === 'string' && error ? { error } : {}),
  };
}

/** Model ids from an OpenAI-compatible `GET /v1/models` reply (`data`, or a `models` list). */
export function servedModelIds(body) {
  const list = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : [];
  return list.map(m => (typeof m === 'string' ? m : m?.id ?? m?.name)).filter(id => typeof id === 'string' && id);
}

/**
 * @param options.apiURL - https://huggingface.co, or a loopback URL for offline tests
 * @param options.getToken - async (kind: 'inference' | 'control') => token or undefined, per request
 * @param options.fetchImpl - fetch implementation (tests)
 */
export function createHfClient({ apiURL = HF_API, getToken, fetchImpl = globalThis.fetch, timeoutMs = TIMEOUT_MS } = {}) {
  const base = String(apiURL).replace(/\/+$/, '');
  const loopback = base !== HF_API;
  if (loopback && !isLoopbackURL(base)) throw new Error(`hfApiURL must be ${HF_API} (another address only on this machine, for tests)`);

  async function request(url, { kind = 'inference', method = 'GET', body } = {}) {
    const token = await getToken?.(kind);
    const response = await fetchImpl(url, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status >= 300 && response.status < 400) {
      throw new HfError(`${new URL(url).pathname} answered with a redirect, which is not followed with a token`, response.status);
    }
    return response;
  }
  const api = (path, options) => request(base + path, options);

  /** POST to a Space control endpoint, returning the runtime it reports. */
  async function control(id, action, what, body) {
    const response = await api(`/api/spaces/${spacePath(id)}/${action}`, { kind: 'control', method: 'POST', body });
    if (!response.ok) throw new HfError(`${what} Space ${id} failed: HTTP ${response.status}${hint(response.status, 'control')}`, response.status);
    return normalizeRuntime(await response.json().catch(() => ({})));
  }

  return {
    /**
     * What the plugin needs from GET /api/spaces/{id}.
     * @returns {Promise<{ sha?: string, host?: string, files: string[], stage?: string, gcTimeout?: number }>}
     */
    async getSpace(id) {
      const response = await api(`/api/spaces/${spacePath(id)}`);
      if (!response.ok) throw new HfError(`reading Space ${id} failed: HTTP ${response.status}${hint(response.status, 'inference')}`, response.status);
      const body = await response.json();
      const host = typeof body?.host === 'string' ? body.host.replace(/\/+$/, '') : undefined;
      if (host !== undefined && !isSpaceURL(host) && !(loopback && isLoopbackURL(host))) {
        throw new HfError(`Space ${id} reported an unexpected address; set \`baseURL\` for it`);
      }
      return {
        ...(typeof body?.sha === 'string' ? { sha: body.sha } : {}),
        ...(host ? { host } : {}),
        files: (Array.isArray(body?.siblings) ? body.siblings : []).map(s => s?.rfilename).filter(f => typeof f === 'string'),
        ...(typeof body?.runtime?.stage === 'string' ? { stage: body.runtime.stage } : {}),
        ...(Number.isSafeInteger(body?.runtime?.gcTimeout) ? { gcTimeout: body.runtime.gcTimeout } : {}),
      };
    },

    /** A file of the Space repository at revision `sha`; undefined when it does not exist. */
    async readSpaceFile(id, sha, file) {
      const response = await api(`/spaces/${spacePath(id)}/resolve/${encodeURIComponent(sha)}/${encodeURIComponent(file)}`);
      if (response.status === 404) return undefined;
      if (!response.ok) throw new HfError(`reading ${file} of Space ${id} failed: HTTP ${response.status}${hint(response.status, 'inference')}`, response.status);
      const tooLarge = () => new HfError(`${file} of Space ${id} is larger than ${MAX_FILE_BYTES} bytes; not read`);
      if (Number(response.headers.get('content-length')) > MAX_FILE_BYTES) {
        await response.body?.cancel();
        throw tooLarge();
      }
      const text = await response.text();
      if (Buffer.byteLength(text) > MAX_FILE_BYTES) throw tooLarge();
      return text;
    },

    /** GET /api/spaces/{id}/runtime. */
    async getRuntime(id) {
      const response = await api(`/api/spaces/${spacePath(id)}/runtime`);
      if (!response.ok) throw new HfError(`reading the state of Space ${id} failed: HTTP ${response.status}${hint(response.status, 'inference')}`, response.status);
      return normalizeRuntime(await response.json());
    },

    /**
     * Public hardware list with prices (GET /api/spaces/hardware, no token): name -> US$ per minute.
     * 21 flavors on 2026-10-30, billed per minute (a100-large 0.041667, US$ 2.50/h).
     */
    async listHardwarePrices() {
      const response = await fetchImpl(`${base}/api/spaces/hardware`, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) throw new HfError(`reading the hardware prices failed: HTTP ${response.status}`, response.status);
      const prices = new Map();
      for (const item of await response.json()) {
        const usd = Number(item?.unitCostUSD);
        if (typeof item?.name !== 'string' || !Number.isFinite(usd)) continue;
        prices.set(item.name, item.unitLabel === 'hour' ? usd / 60 : usd);
      }
      return prices;
    },

    /** Starts a stopped Space on the hardware it already has. */
    restart: id => control(id, 'restart', 'starting'),
    /** Pauses a Space: billing stops, and it stays paused until started again. */
    pause: id => control(id, 'pause', 'pausing'),
    /**
     * Sets a Space variable (POST /api/spaces/{id}/variables {key, value}, control credential).
     * Used for the start variables a Space declares; on a paused Space it does not start it.
     */
    async setVariable(id, key, value) {
      const response = await api(`/api/spaces/${spacePath(id)}/variables`, { kind: 'control', method: 'POST', body: { key, value } });
      if (!response.ok) throw new HfError(`setting variable ${key} of Space ${id} failed: HTTP ${response.status}${hint(response.status, 'control')}`, response.status);
      await response.body?.cancel().catch(() => {});
    },

    /** Changes the hardware; Hugging Face restarts the Space on it. */
    requestHardware: (id, flavor) => control(id, 'hardware', `moving to ${flavor}`, { flavor }),

    /**
     * Follows the Space run log (server-sent events) and calls `onLine` with each log line, until
     * the stream ends or `signal` aborts. While a Space is paused the server sends no headers at
     * all (verified 2026-10-30), so a stream with no headers after `headersTimeoutMs` is dropped.
     */
    async followRunLog(id, { onLine, signal, tail = 100, headersTimeoutMs = 15000 }) { // onLine(text, timestamp)
      const headers = new AbortController();
      const timer = setTimeout(() => headers.abort(new Error('no log yet')), headersTimeoutMs);
      const combined = AbortSignal.any([headers.signal, ...(signal ? [signal] : [])]);
      const token = await getToken?.('inference');
      let response;
      try {
        response = await fetchImpl(`${base}/api/spaces/${spacePath(id)}/logs/run?tail=${tail}`, {
          headers: { Accept: 'text/event-stream', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
          redirect: 'manual',
          signal: combined,
        });
      } finally {
        clearTimeout(timer);
      }
      if (!response.ok) throw new HfError(`reading the run log of Space ${id} failed: HTTP ${response.status}${hint(response.status, 'inference')}`, response.status);
      const decoder = new TextDecoder();
      let buffer = '';
      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let end;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end).replace(/\r$/, '');
          buffer = buffer.slice(end + 1);
          if (!line.startsWith('data:')) continue;
          let payload;
          try { payload = JSON.parse(line.slice(5)); } catch { continue; } // not a log line
          if (typeof payload?.data === 'string') onLine(payload.data, payload.timestamp);
        }
      }
    },

    /**
     * One minimal chat request, used to warm the model and to check that the server accepts an
     * effort value: a llama.cpp Qwen template answered HTTP 500 to values it does not know
     * (2026-09-21). `effort` undefined sends no reasoning field.
     * @returns {Promise<{ ok: boolean, status: number }>}
     */
    async probeChat(baseURL, model, effort, signal) {
      const root = String(baseURL).replace(/\/+$/, '');
      if (!isSpaceURL(root) && !(loopback && isLoopbackURL(root))) throw new HfError('the Space address must be https://<subdomain>.hf.space');
      const token = await getToken?.('inference');
      const response = await fetchImpl(`${root}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ok' }], max_tokens: 1, stream: false, ...(effort === undefined ? {} : { reasoning_effort: effort }) }),
        redirect: 'manual',
        // A first request on a cold model took 35-45 s; the caller's signal caps the whole warm-up.
        signal: AbortSignal.any([AbortSignal.timeout(5 * 60000), ...(signal ? [signal] : [])]),
      });
      await response.body?.cancel().catch(() => {});
      return { ok: response.ok, status: response.status };
    },

    /**
     * Model ids the Space serves, from `GET {baseURL}/models`. Answers only once the server is up.
     * The inference token goes only to the Space's own address (or to this machine in tests).
     */
    async listServedModels(baseURL) {
      const root = String(baseURL).replace(/\/+$/, '');
      if (!isSpaceURL(root) && !(loopback && isLoopbackURL(root))) throw new HfError('the Space address must be https://<subdomain>.hf.space');
      const response = await request(`${root}/models`);
      if (!response.ok) throw new HfError(`the Space answered GET /models with HTTP ${response.status}${hint(response.status, 'inference')}`, response.status);
      return servedModelIds(await response.json());
    },
  };
}
