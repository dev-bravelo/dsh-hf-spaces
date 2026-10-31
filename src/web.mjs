/**
 * Local HTTP routes for the Client half (docs/design.md, section 9; contracts in
 * docs/contracts.md, section 2). Plugin routes outside /api get no Harness fence, so every
 * request is first checked with the official guard, `connection.requestRejection` (the same
 * pattern as the official open-in-app plugin).
 *
 * - GET  /dsh-hf-spaces/state   -> { locale, spaces: [view] }, no Hugging Face request
 * - POST /dsh-hf-spaces/action  <- { route, action: 'on' | 'off' | 'extend' } -> { kind, text }
 */

export const STATE_PATH = '/dsh-hf-spaces/state';
export const ACTION_PATH = '/dsh-hf-spaces/action';
const MAX_BODY_BYTES = 4 * 1024;
const ACTIONS = { on: 'on', off: 'off', extend: '+' };

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(payload));
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

/** Registers the two routes once the web server and the connection guard are available. */
export function attachWeb({ ctx, control, locale, log }) {
  ctx.inject(['webServer', 'connection'], (sub) => {
    const rejected = (req, res) => {
      const rejection = Reflect.get(sub, 'connection').requestRejection(req);
      if (rejection === undefined) return false;
      res.statusCode = rejection;
      res.end();
      return true;
    };
    sub.effect(() => sub.webServer.register({
      kind: 'exact',
      path: STATE_PATH,
      handler: async (req, res) => {
        if (rejected(req, res)) return;
        if (req.method !== 'GET') return sendJson(res, 405, { error: 'GET only' });
        sendJson(res, 200, { locale, spaces: await control.views() });
      },
    }), `dsh-hf-spaces: GET ${STATE_PATH}`);
    sub.effect(() => sub.webServer.register({
      kind: 'exact',
      path: ACTION_PATH,
      handler: async (req, res) => {
        if (rejected(req, res)) return;
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST only' });
        let body;
        try {
          body = await readJson(req);
        } catch (error) {
          return sendJson(res, 400, { error: error.message });
        }
        const verb = ACTIONS[body?.action];
        if (!verb || typeof body.route !== 'string' || !/^[a-z0-9-]{1,32}$/.test(body.route)) {
          return sendJson(res, 400, { error: 'expected { route, action: on | off | extend }' });
        }
        try {
          const result = await control.run({ rawInput: `${verb} ${body.route}` });
          sendJson(res, 200, result);
        } catch (error) {
          log?.warn?.(`interface action ${body.action} on ${body.route} failed: ${error?.message ?? error}`);
          sendJson(res, 500, { kind: 'error', text: String(error?.message ?? error) });
        }
      },
    }), `dsh-hf-spaces: POST ${ACTION_PATH}`);
  });
}
