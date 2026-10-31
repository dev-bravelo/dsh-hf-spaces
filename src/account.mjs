/**
 * The plugin's own records and the account part of the interface (docs/design.md, section 9):
 * - each Space's recent starts, kept in a small JSON file of this plugin (no Harness storage API);
 * - each Space's usage today and this month, from the billing API;
 * - each credential: in the vault or not, accepted or not, its account and token role;
 * - the public price of each hardware, for the cost of a start.
 * Hugging Face is read in the background, at most every few minutes; the interface only reads
 * what is already here, so it never waits for Hugging Face.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { costUsd } from './rules.mjs';

export const LEDGER_FILE = 'ledger.json';
const MAX_STARTS = 50;
const USAGE_TTL_MS = 10 * 60000;
const PRICES_TTL_MS = 6 * 3600000;
const CREDENTIAL_TTL_MS = 30 * 60000;
/** The vault is read again at most this often for the credential view; a new token shows within it. */
const VAULT_TTL_MS = 10000;

const expandHome = (value, home) => value.replace(/^~(?=$|[\\/])/, home);
/** The Harness home: DSH_HOME, else ~/.dsh. */
export const harnessHome = (env = process.env, home = os.homedir()) => (env.DSH_HOME ? path.resolve(expandHome(env.DSH_HOME, home)) : path.join(home, '.dsh'));

/** Default folder of this plugin's records: <Harness home>/state/dsh-hf-spaces. */
export const defaultStateDir = (env = process.env, home = os.homedir()) => path.join(harnessHome(env, home), 'state', 'dsh-hf-spaces');

/** The records folder: `stateDir` when set (a relative one is under the Harness home), else the default. */
export function resolveStateDir(stateDir, env = process.env, home = os.homedir()) {
  return stateDir ? path.resolve(harnessHome(env, home), expandHome(stateDir, home)) : defaultStateDir(env, home);
}

/** One Space's minutes and US$ in a usage-v2 reply, whose items carry the Space id as `label`. */
export function spaceUsage(body, spaceId) {
  const items = body?.usage?.Spaces;
  if (!Array.isArray(items)) return undefined;
  const mine = items.filter(item => item?.label === spaceId);
  return {
    minutes: mine.reduce((sum, item) => sum + (Number(item.quantity) || 0), 0),
    usd: mine.reduce((sum, item) => sum + (Number(item.totalCostMicroUSD) || 0), 0) / 1e6,
  };
}


/**
 * The records file. A start is an object `{ space, route, startedAt, readyAt?, endedAt?, end?,
 * hardware?, cost? }` changed in place, then saved with `save()`. A start still open when the
 * Harness closed is marked `end: 'unknown'` on the next load: when it stopped is not known.
 */
export function createLedger({ file, log }) {
  let data = { starts: [] };
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    data = {
      starts: (Array.isArray(saved?.starts) ? saved.starts : []).filter(s => s && typeof s.space === 'string' && Number.isFinite(s.startedAt)).slice(-MAX_STARTS),
    };
    for (const start of data.starts) if (start.endedAt === undefined && start.end === undefined) start.end = 'unknown';
  } catch { /* no records yet */ }
  const save = () => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const temporary = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, `${JSON.stringify({ version: 1, ...data }, null, 1)}\n`);
      fs.renameSync(temporary, file);
    } catch (error) {
      log?.warn?.(`records not saved in ${file}: ${error?.message ?? error}`);
    }
  };
  return {
    file,
    save,
    /** The last `count` starts of a Space, newest first. */
    starts: (spaceId, count = 5) => data.starts.filter(s => s.space === spaceId).slice(-count).reverse(),
    open(start) {
      data.starts.push(start);
      if (data.starts.length > MAX_STARTS) data.starts = data.starts.slice(-MAX_STARTS);
      save();
      return start;
    },
  };
}

/**
 * @param options.hf - Hugging Face client (getBillingUsage, whoami, listHardwarePrices)
 * @param options.token - async (kind) => token or undefined
 * @param options.credentialNames - { inference, control, billing }
 */
export function attachAccount({ hf, ledger, token, credentialNames, now = Date.now, log }) {
  // ---- Prices: the request itself is cached, so parallel callers share one read.
  let prices;
  let pricesAt;
  let loaded; // the last price list read, for callers that cannot wait
  const readPrices = () => {
    if (!prices || now() - pricesAt > PRICES_TTL_MS) {
      pricesAt = now();
      prices = hf.listHardwarePrices().then((list) => { loaded = list; return list; }, (error) => {
        log?.warn?.(`hardware prices not read: ${error?.message ?? error}`);
        prices = undefined; // read again next time
        return undefined;
      });
    }
    return prices;
  };
  const pricePerMinute = async hardware => (hardware ? (await readPrices())?.get(hardware) : undefined);
  /** The price from the last list read, without waiting; a missing list is read in the background. */
  const pricePerMinuteNow = (hardware) => {
    if (!hardware) return undefined;
    void readPrices();
    return loaded?.get(hardware);
  };

  /** A value read in the background: the last one is returned at once, a stale one is read again. */
  const cached = (ttlMs, read) => {
    const slots = new Map();
    return (key) => {
      const slot = slots.get(key) ?? {};
      slots.set(key, slot);
      if (!slot.pending && (slot.at === undefined || now() - slot.at > ttlMs)) {
        slot.at = now();
        slot.pending = read(key)
          .then((value) => { slot.value = value; slot.error = undefined; })
          .catch((error) => { slot.error = error?.message ?? String(error); })
          .finally(() => { slot.pending = undefined; });
      }
      return slot;
    };
  };

  // ---- Usage of a Space, today and this month (local midnight and first of the month).
  const usageSlot = cached(USAGE_TTL_MS, async (spaceId) => {
    const day = new Date(now());
    day.setHours(0, 0, 0, 0);
    const month = new Date(day);
    month.setDate(1);
    const read = async (from) => {
      const usage = spaceUsage(await hf.getBillingUsage(from.getTime(), now()), spaceId);
      if (!usage) throw new Error('the billing reply has no Spaces list');
      return usage;
    };
    const [today, sofar] = await Promise.all([read(day), read(month)]);
    return { today, month: sofar };
  });

  // ---- Credentials: checked once per token (a fingerprint, never the token), again after a while.
  const fingerprint = value => createHash('sha256').update(value).digest('hex').slice(0, 16);
  const kindOf = new Map(); // fingerprint -> a kind whose credential holds that token
  const whoamiSlot = cached(CREDENTIAL_TTL_MS, async key => hf.whoami(kindOf.get(key)));
  let vault; // [kind, fingerprint | undefined][], read at most every VAULT_TTL_MS
  let vaultAt;
  const readVault = () => {
    if (!vault || now() - vaultAt > VAULT_TTL_MS) {
      vaultAt = now();
      vault = Promise.all(Object.keys(credentialNames).map(async (kind) => {
        const value = await token(kind);
        return [kind, value ? fingerprint(value) : undefined];
      }));
    }
    return vault;
  };
  const credentials = async () => (await readVault()).map(([kind, key]) => {
    const name = credentialNames[kind];
    if (!key) return { kind, name, present: false };
    if (!kindOf.has(key)) kindOf.set(key, kind); // one check per token, whichever kinds share it
    const slot = whoamiSlot(key);
    return {
      kind,
      name,
      present: true,
      ...(slot.value ? { ok: true, ...slot.value } : {}),
      ...(slot.error ? { ok: false, error: slot.error } : {}),
    };
  });

  /**
   * Keeps each Space's start records in step with its supervisor state. A start opens when the
   * Space starts or is first seen serving, and closes when it is seen off or failed; the reason
   * comes from the state (a stop rule, /space off, or a pause outside the plugin).
   */
  const track = (entry, state, texts) => {
    const open = entry.record && entry.record.endedAt === undefined ? entry.record : undefined;
    if (!open && (state.phase === 'starting' || state.phase === 'ready')) {
      entry.record = ledger.open({
        space: entry.facts.id,
        route: entry.route,
        startedAt: state.startedAt ?? now(),
        ...(state.phase === 'ready' ? { readyAt: now(), seen: true } : {}),
        ...(state.hardware ?? entry.facts.hardware ?? state.requested ? { hardware: state.hardware ?? entry.facts.hardware ?? state.requested } : {}),
      });
      return;
    }
    if (!open) return;
    if (state.phase === 'ready' && open.readyAt === undefined) {
      open.readyAt = now();
      if (state.hardware) open.hardware = state.hardware;
      ledger.save();
    } else if (state.phase === 'off' || state.phase === 'failed') {
      open.endedAt = now();
      open.end = state.phase === 'failed' ? (state.reason ?? 'failed') : (state.reason ?? texts.pausedElsewhere);
      ledger.save();
      void pricePerMinute(open.hardware).then((rate) => {
        if (rate === undefined) return;
        open.cost = costUsd(open.endedAt - open.startedAt, rate);
        ledger.save();
      });
    }
  };

  return {
    pricePerMinute,
    pricePerMinuteNow,
    usage: spaceId => usageSlot(spaceId),
    credentials,
    track,
    starts: (spaceId, count) => ledger.starts(spaceId, count),
  };
}
