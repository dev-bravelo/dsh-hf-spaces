/**
 * The small Hugging Face client this plugin needs, on Node's `fetch` only.
 * - Tokens go only to https://huggingface.co (or to this machine, in offline tests).
 * - Redirects are never followed with a token attached.
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

function hint(status) {
  if (status === 401) return ' (the inference credential is missing or was not accepted)';
  if (status === 403) return ' (the inference credential cannot read this Space)';
  if (status === 404) return ' (no such Space, or the inference credential cannot see it)';
  return '';
}

/**
 * @param options.apiURL - https://huggingface.co, or a loopback URL for offline tests
 * @param options.getToken - async () => token or undefined, called for every request
 * @param options.fetchImpl - fetch implementation (tests)
 */
export function createHfClient({ apiURL = HF_API, getToken, fetchImpl = globalThis.fetch, timeoutMs = TIMEOUT_MS } = {}) {
  const base = String(apiURL).replace(/\/+$/, '');
  const loopback = base !== HF_API;
  if (loopback && !isLoopbackURL(base)) throw new Error(`hfApiURL must be ${HF_API} (another address only on this machine, for tests)`);

  async function request(path) {
    const token = await getToken?.();
    const response = await fetchImpl(base + path, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status >= 300 && response.status < 400) {
      throw new HfError(`Hugging Face answered ${path} with a redirect, which is not followed with a token`, response.status);
    }
    return response;
  }

  return {
    /**
     * What the plugin needs from GET /api/spaces/{id}.
     * @returns {Promise<{ sha?: string, host?: string, files: string[], stage?: string, gcTimeout?: number }>}
     */
    async getSpace(id) {
      const response = await request(`/api/spaces/${spacePath(id)}`);
      if (!response.ok) throw new HfError(`reading Space ${id} failed: HTTP ${response.status}${hint(response.status)}`, response.status);
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
      const response = await request(`/spaces/${spacePath(id)}/resolve/${encodeURIComponent(sha)}/${encodeURIComponent(file)}`);
      if (response.status === 404) return undefined;
      if (!response.ok) throw new HfError(`reading ${file} of Space ${id} failed: HTTP ${response.status}${hint(response.status)}`, response.status);
      const tooLarge = () => new HfError(`${file} of Space ${id} is larger than ${MAX_FILE_BYTES} bytes; not read`);
      if (Number(response.headers.get('content-length')) > MAX_FILE_BYTES) {
        await response.body?.cancel();
        throw tooLarge();
      }
      const text = await response.text();
      if (Buffer.byteLength(text) > MAX_FILE_BYTES) throw tooLarge();
      return text;
    },
  };
}
