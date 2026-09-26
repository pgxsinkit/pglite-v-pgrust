/**
 * Four diagnostic switches for the store seam, and the URL that turns them on.
 *
 * - `?brokerStats=1` counts the store work of every Measurement, per Benchmark and per Configuration:
 *   on every pgrust Configuration the guest's file calls by kind (bytes, and the ms the guest spent
 *   inside them, for the Session's backend and for every thread), on the broker ones the requests
 *   the coordinator answered by kind and the ms it spent answering, and on every OPFS Configuration
 *   — PGlite's too — the synchronous access handle calls by kind with bytes and ms. It adds a store
 *   table under each Suite's results table in the Markdown export. What it costs is a clock read on
 *   either side of every file call, which is why it is a switch.
 * - `?brokerGather=1` is a pgrust-only broker lever: every broker Configuration's guests make one
 *   broker write per `fd_pwrite` instead of one per iovec, over 256 KiB channel payloads instead of
 *   the store library's 64 KiB (`wasm/broker-fs.js`, pgrust's host). It changes nothing PGlite runs,
 *   by construction: the broker is pgrust's transport, not the store.
 * - `?brokerSpin=<µs>` is the other broker lever, and aimed at the hand-off rather than the request
 *   count: before either side of a broker Configuration's seam parks in `Atomics.wait`, it polls the
 *   word it is about to wait on for up to that many µs — a guest for its reply, the coordinator for
 *   the next request (`wasm/broker-spin.js`). Bounded per wait; 0 is the behaviour without it. The
 *   values the README offers are 0, 50 and 200; any whole number up to {@link BROKER_SPIN_MAX_US} is
 *   accepted.
 * - `?storeLevers=grow,coalesce` changes how the pgrust broker coordinator's store talks to its port:
 *   `grow` makes the arena file grow in 4 MiB chunks instead of one truncate per allocation (trimmed
 *   back on close), `coalesce` makes contiguous arena writes inside one store call one handle write
 *   (`wasm/store-levers.js`, a wrapper around the port in pgrust's coordinator, never the store
 *   package). **The pgrust broker columns only**: the PGlite OPFS columns keep the published store
 *   untouched, so a pgrust-against-PGlite ratio from such a Run is not like for like, and the
 *   environment line says so.
 *
 * They arrive the way every other non-standard Run setting does (`?pgrustModule=`,
 * `?postmasterTuning=`): read once from the page URL, a value this page does not accept is ignored,
 * and never silent — the environment header and every Markdown export say `broker stats: on`,
 * `broker gather: on`, `broker spin: <N> µs` and `store levers: … (pgrust columns only)`. Off, every
 * Configuration's options are byte-for-byte the ones this repo's tables were produced with; so is
 * `?brokerSpin=0`, which is announced (so a 0-µs Run of an A/B carries its label) and changes nothing.
 */

/** The query parameter that counts the store work of every Measurement. */
export const BROKER_STATS_PARAM = "brokerStats";

/** The query parameter that turns on the broker's gathered writes. */
export const BROKER_GATHER_PARAM = "brokerGather";

/** The query parameter that sets the broker's spin before parking, in µs. */
export const BROKER_SPIN_PARAM = "brokerSpin";

/** The query parameter that names the pgrust coordinator's store levers. */
export const STORE_LEVERS_PARAM = "storeLevers";

/** The value that turns a stats or gather switch on; anything else leaves it off. */
const ON = "1";

/**
 * The largest spin accepted, in µs: pgrust's own bound (`MAX_BROKER_SPIN_US` in the vendored
 * `broker-spin.js`, which refuses anything larger), so the page never asks for one it would refuse.
 */
export const BROKER_SPIN_MAX_US = 1000;

/** The spins the README offers a phone. */
export const BROKER_SPIN_OFFERED_US: readonly number[] = [0, 50, 200];

/** A store lever by name, as pgrust's `wasm/store-levers.js` names them. */
export type StoreLever = "grow" | "coalesce";

/** Every store lever, in the order they are reported (`STORE_LEVER_NAMES` in the vendored module). */
export const STORE_LEVERS: readonly StoreLever[] = ["grow", "coalesce"];

export interface BrokerSwitches {
  /** Count the store work of every Measurement (`?brokerStats=1`). */
  readonly stats: boolean;
  /** One broker write per `fd_pwrite`, over 256 KiB channel payloads (`?brokerGather=1`). */
  readonly gather: boolean;
  /** The broker's spin before parking in µs (`?brokerSpin=`), or null when the URL did not set one. */
  readonly spinUs: number | null;
  /** The pgrust coordinator's store levers (`?storeLevers=`), in {@link STORE_LEVERS} order. */
  readonly storeLevers: readonly StoreLever[];
}

/** Every switch off: what every Run this repo reports uses. */
export const NO_BROKER_SWITCHES: BrokerSwitches = { stats: false, gather: false, spinUs: null, storeLevers: [] };

/** How the stats switch is announced wherever the environment is reported. */
export const BROKER_STATS_LINE = "broker stats: on";

/** How the gather switch is announced wherever the environment is reported. */
export const BROKER_GATHER_LINE = "broker gather: on";

/** How a spin is announced wherever the environment is reported. */
export function brokerSpinLine(spinUs: number): string {
  return `broker spin: ${spinUs} µs`;
}

/** How store levers are announced wherever the environment is reported: always with whom they touch. */
export function storeLeversLine(levers: readonly StoreLever[]): string {
  return `store levers: ${levers.join(", ")} (pgrust columns only)`;
}

/** A `?brokerSpin=` value as µs, or null for anything but a whole number from 0 to the maximum. */
export function parseBrokerSpin(raw: string | null | undefined): number | null {
  const text = raw?.trim() ?? "";
  if (!/^\d{1,4}$/.test(text)) {
    return null;
  }
  const value = Number(text);
  return value <= BROKER_SPIN_MAX_US ? value : null;
}

/** A `?storeLevers=` value as the levers it names, in canonical order; names this page does not know are dropped. */
export function parseStoreLevers(raw: string | null | undefined): readonly StoreLever[] {
  const named = new Set((raw ?? "").split(",").map((entry) => entry.trim()));
  return STORE_LEVERS.filter((lever) => named.has(lever));
}

/** The switches a `location.search` string turns on. */
export function parseBrokerSwitches(search: string): BrokerSwitches {
  const params = new URLSearchParams(search);
  return {
    stats: params.get(BROKER_STATS_PARAM)?.trim() === ON,
    gather: params.get(BROKER_GATHER_PARAM)?.trim() === ON,
    spinUs: parseBrokerSpin(params.get(BROKER_SPIN_PARAM)),
    storeLevers: parseStoreLevers(params.get(STORE_LEVERS_PARAM)),
  };
}

/** The switches on the current URL; all off wherever there is no `location` (under `bun test`). */
export function readBrokerSwitches(): BrokerSwitches {
  if (typeof location === "undefined") {
    return NO_BROKER_SWITCHES;
  }
  return parseBrokerSwitches(location.search);
}

/** The environment-line entries for whichever switches are set, in a fixed order. */
export function describeBrokerSwitches(switches: BrokerSwitches): readonly string[] {
  return [
    ...(switches.stats ? [BROKER_STATS_LINE] : []),
    ...(switches.gather ? [BROKER_GATHER_LINE] : []),
    ...(switches.spinUs === null ? [] : [brokerSpinLine(switches.spinUs)]),
    ...(switches.storeLevers.length === 0 ? [] : [storeLeversLine(switches.storeLevers)]),
  ];
}

/**
 * The stats switch as a Configuration's open options spell it: an EMPTY object when it is off, so
 * the options of a Run without it are exactly the ones this repo's tables were produced with.
 */
export function storeStatsOptions(switches: BrokerSwitches): { storeStats?: true } {
  return switches.stats ? { storeStats: true } : {};
}

/** The gather switch as a broker Configuration's pgrust options spell it; empty when it is off. */
export function brokerGatherOptions(switches: BrokerSwitches): { brokerGather?: true } {
  return switches.gather ? { brokerGather: true } : {};
}

/** The spin as a broker Configuration's pgrust options spell it; empty when it is unset or 0. */
export function brokerSpinOptions(switches: BrokerSwitches): { brokerSpinUs?: number } {
  return switches.spinUs === null || switches.spinUs === 0 ? {} : { brokerSpinUs: switches.spinUs };
}

/** The store levers as a broker Configuration's pgrust options spell them; empty when none is on. */
export function storeLeverOptions(switches: BrokerSwitches): { storeLevers?: readonly StoreLever[] } {
  return switches.storeLevers.length === 0 ? {} : { storeLevers: switches.storeLevers };
}
