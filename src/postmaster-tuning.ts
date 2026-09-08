/**
 * The three knobs that decide what one pgrust Postmaster Run costs in memory, and the URL that
 * moves them.
 *
 * A postmaster is not one wasm instance: it is a shared `WebAssembly.Memory` with a guest thread
 * stack carved out of it for every child process Postgres would have forked, and a host Worker
 * standing by for each of those threads. All three of the numbers that decide how big that gets are
 * defaults of the `pgrust-postmaster` Engine worker — the pool's base size, the shared memory's
 * initial claim, and the GUCs the argv carries — and all three are here so a Run can be asked what
 * it costs with other ones without rebuilding the app.
 *
 * It arrives the way the other non-standard Run settings do (`?rttIterations=`,
 * `?concurrencyClients=`): out of band on the page URL, ignored when it is malformed rather than
 * blanking the page, and never silent — the environment header and every Markdown export say what
 * was moved, because a Run on other knobs is not the Run this repo's tables report.
 *
 * `?postmasterTuning=pool:8,initial:134217728,shared_buffers=16MB`
 *
 * - `pool:<n>` — pool slots for the server itself, before the one per Session.
 * - `initial:<bytes>` — the shared memory's initial claim. It may not go below what the wasm module
 *   declares as its own minimum, which is a link-time constant of the pgrust build: a smaller claim
 *   is a `LinkError` at instantiation, not a smaller memory.
 * - anything else containing `=` — a `name=value` GUC appended to the postmaster's argv as
 *   `-c name=value`. Appended last, so it wins the duplicate against the engine defaults.
 */

/** The query parameter that moves the postmaster's memory knobs. */
export const POSTMASTER_TUNING_PARAM = "postmasterTuning";

/** The knobs one Run may move; null means "whatever the Engine worker's own default is". */
export interface PostmasterTuning {
  /** Pool slots for the server itself, before the one added per Session. */
  readonly poolBase: number | null;
  /** Bytes the one shared `WebAssembly.Memory` is created with. */
  readonly initialMemoryBytes: number | null;
  /** `name=value` GUCs, each appended to the postmaster's argv as `-c name=value`. */
  readonly settings: readonly string[];
}

/** Every knob left where the Engine worker put it: what every Run this repo reports uses. */
export const NO_POSTMASTER_TUNING: PostmasterTuning = {
  poolBase: null,
  initialMemoryBytes: null,
  settings: [],
};

/** A pool of fewer than this cannot hold a postmaster's own children, let alone a Session's backend. */
const MIN_POOL_BASE = 1;
/** Past this the pool is larger than the Engine's own session ceiling could ever need. */
const MAX_POOL_BASE = 64;
/** One wasm page under this and the guest's own static data would not fit under its initial claim. */
const MIN_INITIAL_MEMORY_BYTES = 16 * 1024 * 1024;
/** The wasm32 ceiling: a memory cannot be created larger than the address space it lives in. */
const MAX_INITIAL_MEMORY_BYTES = 4 * 1024 * 1024 * 1024;

/** A GUC name, as `-c name=value` accepts it. */
const GUC_NAME = /^[a-z_][a-z0-9_.]*$/;

function parsePositiveInteger(raw: string, min: number, max: number): number | null {
  if (!/^\d+$/.test(raw)) {
    return null;
  }
  const value = Number.parseInt(raw, 10);
  return value < min || value > max ? null : value;
}

/**
 * The tuning carried by a `location.search` string; every knob null and no setting when there is
 * none, and the same for any entry that does not parse. A mistyped URL must leave the page running
 * the Engine's own defaults rather than a half-applied set of somebody's intentions.
 */
export function parsePostmasterTuning(search: string): PostmasterTuning {
  const raw = new URLSearchParams(search).get(POSTMASTER_TUNING_PARAM);
  if (raw === null) {
    return NO_POSTMASTER_TUNING;
  }
  let poolBase: number | null = null;
  let initialMemoryBytes: number | null = null;
  const settings: string[] = [];
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (trimmed === "") {
      continue;
    }
    if (trimmed.startsWith("pool:")) {
      poolBase = parsePositiveInteger(trimmed.slice("pool:".length), MIN_POOL_BASE, MAX_POOL_BASE);
      continue;
    }
    if (trimmed.startsWith("initial:")) {
      initialMemoryBytes = parsePositiveInteger(
        trimmed.slice("initial:".length),
        MIN_INITIAL_MEMORY_BYTES,
        MAX_INITIAL_MEMORY_BYTES,
      );
      continue;
    }
    const separator = trimmed.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    if (!GUC_NAME.test(trimmed.slice(0, separator))) {
      continue;
    }
    settings.push(trimmed);
  }
  return { poolBase, initialMemoryBytes, settings };
}

/** The tuning on the current URL; every knob null wherever there is no `location` (under `bun test`). */
export function readPostmasterTuning(): PostmasterTuning {
  if (typeof location === "undefined") {
    return NO_POSTMASTER_TUNING;
  }
  return parsePostmasterTuning(location.search);
}

/** Whether this Run moved anything at all: what decides if the environment line has to say so. */
export function hasPostmasterTuning(tuning: PostmasterTuning): boolean {
  return tuning.poolBase !== null || tuning.initialMemoryBytes !== null || tuning.settings.length > 0;
}

/** How a moved knob is announced wherever the environment is reported. */
export function describePostmasterTuning(tuning: PostmasterTuning): string {
  const parts: string[] = [];
  if (tuning.poolBase !== null) {
    parts.push(`pool ${tuning.poolBase}`);
  }
  if (tuning.initialMemoryBytes !== null) {
    parts.push(`initial memory ${Math.round(tuning.initialMemoryBytes / (1024 * 1024))} MiB`);
  }
  parts.push(...tuning.settings);
  return `postmaster tuning: ${parts.join(", ")} (non-standard)`;
}

/**
 * The tuning as the `pgrust-postmaster` open options spell it: an EMPTY object when nothing was
 * moved, so an untuned Configuration's options are byte-for-byte the ones this repo's tables were
 * produced with rather than the same thing with three explicit nulls in it.
 */
export function postmasterTuningOptions(tuning: PostmasterTuning): {
  poolBase?: number;
  initialMemoryBytes?: number;
  settings?: readonly string[];
} {
  return {
    ...(tuning.poolBase === null ? {} : { poolBase: tuning.poolBase }),
    ...(tuning.initialMemoryBytes === null ? {} : { initialMemoryBytes: tuning.initialMemoryBytes }),
    ...(tuning.settings.length === 0 ? {} : { settings: tuning.settings }),
  };
}
