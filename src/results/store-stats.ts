/**
 * The store work behind one Measurement, as `?brokerStats=1` counts it (`src/broker-switches.ts`).
 *
 * Three parts, each present only on the Configurations that have it:
 *
 * - **guest** — every pgrust Configuration: the WASI file calls the guest made, by kind, with the
 *   bytes a read or write moved and the ms the guest thread spent inside the call. `all` is every
 *   guest thread; `backend` is the Session backends alone, which the host recognises as the threads
 *   that read a Session's input. On a broker seam a file call's ms is the thread blocked on the
 *   coordinator; on a copy seam, or on the single-session build, it is the in-memory filesystem's.
 * - **broker** — the broker Configurations: the requests the coordinator answered, by kind, and the
 *   ms its serve loop spent answering them.
 * - **handles** — every OPFS Configuration, PGlite's included: the synchronous access handle calls
 *   the store made, by kind, with bytes and ms.
 *
 * The counting is `io-stats.js` from the vendored pgrust host, in PGlite's worker as much as in
 * pgrust's, so the two engines' handle calls are counted by the same code.
 */

import type {
  BrokerRequestKind,
  GuestCallKind,
  HandleCallKind,
  IoKindTotals,
  IoStatsDescription,
} from "../vendor/pgrust/io-stats.js";

export type { BrokerRequestKind, GuestCallKind, HandleCallKind };

/** Guest file call kinds, in table order. */
export const GUEST_KINDS: readonly GuestCallKind[] = [
  "read",
  "write",
  "sync",
  "allocate",
  "open",
  "close",
  "stat",
  "seek",
  "other",
];

/** Broker request kinds, in table order. */
export const BROKER_KINDS: readonly BrokerRequestKind[] = [
  "read",
  "write",
  "fsync",
  "allocate",
  "open",
  "close",
  "stat",
  "other",
];

/** Access handle call kinds, in table order. */
export const HANDLE_KINDS: readonly HandleCallKind[] = ["read", "write", "truncate", "flush", "getSize"];

/** Calls of one kind, the bytes they moved and the ms spent inside them. */
export type StoreKindTotals = IoKindTotals;

export interface GuestStoreStats {
  /** Every guest thread's file calls. */
  readonly all: Readonly<Record<GuestCallKind, StoreKindTotals>>;
  /** The Session backends' file calls alone. */
  readonly backend: Readonly<Record<GuestCallKind, StoreKindTotals>>;
}

export interface BrokerStoreStats {
  /** Requests the coordinator answered, by kind. */
  readonly requests: Readonly<Record<BrokerRequestKind, number>>;
  /** The ms the coordinator's serve loop spent answering them. */
  readonly servingMs: number;
}

export interface StoreStats {
  readonly guest?: GuestStoreStats;
  readonly broker?: BrokerStoreStats;
  readonly handles?: Readonly<Record<HandleCallKind, StoreKindTotals>>;
}

/** Which parts a Configuration has: the guest on pgrust, the broker on its broker seam, handles on OPFS. */
export interface StoreStatsParts {
  readonly guest: boolean;
  readonly broker: boolean;
  readonly handles: boolean;
}

/** The parts of one counters description a Configuration has. */
export function storeStatsFromDescription(description: IoStatsDescription, parts: StoreStatsParts): StoreStats {
  return {
    ...(parts.guest ? { guest: { all: description.guest.all, backend: description.guest.sessions } } : {}),
    ...(parts.broker
      ? { broker: { requests: description.broker.requests, servingMs: description.broker.servingMs } }
      : {}),
    ...(parts.handles ? { handles: description.handles } : {}),
  };
}

function addTotals<K extends string>(
  kinds: readonly K[],
  left: Readonly<Record<K, StoreKindTotals>>,
  right: Readonly<Record<K, StoreKindTotals>>,
): Record<K, StoreKindTotals> {
  const sum = {} as Record<K, StoreKindTotals>;
  for (const kind of kinds) {
    sum[kind] = {
      calls: left[kind].calls + right[kind].calls,
      bytes: left[kind].bytes + right[kind].bytes,
      ms: left[kind].ms + right[kind].ms,
    };
  }
  return sum;
}

function addStoreStats(left: StoreStats, right: StoreStats): StoreStats {
  const guest =
    left.guest !== undefined && right.guest !== undefined
      ? {
          all: addTotals(GUEST_KINDS, left.guest.all, right.guest.all),
          backend: addTotals(GUEST_KINDS, left.guest.backend, right.guest.backend),
        }
      : (left.guest ?? right.guest);
  const broker =
    left.broker !== undefined && right.broker !== undefined
      ? {
          requests: Object.fromEntries(
            BROKER_KINDS.map((kind) => [
              kind,
              (left.broker?.requests[kind] ?? 0) + (right.broker?.requests[kind] ?? 0),
            ]),
          ) as Record<BrokerRequestKind, number>,
          servingMs: left.broker.servingMs + right.broker.servingMs,
        }
      : (left.broker ?? right.broker);
  const handles =
    left.handles !== undefined && right.handles !== undefined
      ? addTotals(HANDLE_KINDS, left.handles, right.handles)
      : (left.handles ?? right.handles);
  return {
    ...(guest === undefined ? {} : { guest }),
    ...(broker === undefined ? {} : { broker }),
    ...(handles === undefined ? {} : { handles }),
  };
}

/**
 * A Benchmark's store work: the sum over every one of its Measurements, or undefined when none of
 * them was counted.
 *
 * A sum, not the aggregate the cell carries: an RTT row's cell is a trimmed mean per statement, and
 * its store row says what all of its statements did between them.
 */
export function sumStoreStats(measurements: readonly { readonly storeStats?: StoreStats }[]): StoreStats | undefined {
  let total: StoreStats | undefined;
  for (const measurement of measurements) {
    const stats = measurement.storeStats;
    if (stats !== undefined) {
      total = total === undefined ? stats : addStoreStats(total, stats);
    }
  }
  return total;
}

/** Every call of every kind, and every ms, of one table of totals. */
export function totalOf<K extends string>(
  kinds: readonly K[],
  totals: Readonly<Record<K, StoreKindTotals>>,
): StoreKindTotals {
  let calls = 0;
  let bytes = 0;
  let ms = 0;
  for (const kind of kinds) {
    calls += totals[kind].calls;
    bytes += totals[kind].bytes;
    ms += totals[kind].ms;
  }
  return { calls, bytes, ms };
}
