/**
 * Two diagnostic switches for the store seam, and the URL that turns them on.
 *
 * - `?brokerStats=1` counts the store work of every Measurement, per Benchmark and per Configuration:
 *   on every pgrust Configuration the guest's file calls by kind (bytes, and the ms the guest spent
 *   inside them, for the Session's backend and for every thread), on the broker ones the requests
 *   the coordinator answered by kind and the ms it spent answering, and on every OPFS Configuration
 *   — PGlite's too — the synchronous access handle calls by kind with bytes and ms. It adds a store
 *   table under each Suite's results table in the Markdown export. What it costs is a clock read on
 *   either side of every file call, which is why it is a switch.
 * - `?brokerGather=1` is the one pgrust-only broker lever: every broker Configuration's guests make
 *   one broker write per `fd_pwrite` instead of one per iovec, over 256 KiB channel payloads instead
 *   of the store library's 64 KiB (`wasm/broker-fs.js`, pgrust's host). It changes nothing PGlite
 *   runs, by construction: the broker is pgrust's transport, not the store.
 *
 * They arrive the way every other non-standard Run setting does (`?pgrustModule=`,
 * `?postmasterTuning=`): read once from the page URL, ignored unless the value is exactly `1`, and
 * never silent — the environment header and every Markdown export say `broker stats: on` and
 * `broker gather: on`. Off, every Configuration's options are byte-for-byte the ones this repo's
 * tables were produced with.
 */

/** The query parameter that counts the store work of every Measurement. */
export const BROKER_STATS_PARAM = "brokerStats";

/** The query parameter that turns on the broker's gathered writes. */
export const BROKER_GATHER_PARAM = "brokerGather";

/** The value that turns a switch on; anything else leaves it off. */
const ON = "1";

export interface BrokerSwitches {
  /** Count the store work of every Measurement (`?brokerStats=1`). */
  readonly stats: boolean;
  /** One broker write per `fd_pwrite`, over 256 KiB channel payloads (`?brokerGather=1`). */
  readonly gather: boolean;
}

/** Both switches off: what every Run this repo reports uses. */
export const NO_BROKER_SWITCHES: BrokerSwitches = { stats: false, gather: false };

/** How the stats switch is announced wherever the environment is reported. */
export const BROKER_STATS_LINE = "broker stats: on";

/** How the gather switch is announced wherever the environment is reported. */
export const BROKER_GATHER_LINE = "broker gather: on";

/** The switches a `location.search` string turns on; a value other than `1` turns nothing on. */
export function parseBrokerSwitches(search: string): BrokerSwitches {
  const params = new URLSearchParams(search);
  return {
    stats: params.get(BROKER_STATS_PARAM)?.trim() === ON,
    gather: params.get(BROKER_GATHER_PARAM)?.trim() === ON,
  };
}

/** The switches on the current URL; both off wherever there is no `location` (under `bun test`). */
export function readBrokerSwitches(): BrokerSwitches {
  if (typeof location === "undefined") {
    return NO_BROKER_SWITCHES;
  }
  return parseBrokerSwitches(location.search);
}

/** The environment-line entries for whichever switches are on, in a fixed order. */
export function describeBrokerSwitches(switches: BrokerSwitches): readonly string[] {
  return [...(switches.stats ? [BROKER_STATS_LINE] : []), ...(switches.gather ? [BROKER_GATHER_LINE] : [])];
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
