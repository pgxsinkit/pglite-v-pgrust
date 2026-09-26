/**
 * Hand-written types for the vendored `io-stats.js`: the optional store counters every pgrust host
 * here can be handed, and which this repo also wraps PGlite's OPFS directory with, so both engines'
 * synchronous access handle calls are counted by the same code.
 *
 * Ours, not pgrust's. It declares only what this repo touches. Nothing in the module runs unless a
 * host is handed a buffer: `?brokerStats=1` is what creates one (`src/broker-switches.ts`).
 */

/** Guest file call kinds, in layout order. */
export type GuestCallKind = "read" | "write" | "sync" | "allocate" | "open" | "close" | "stat" | "seek" | "other";

/** Broker request kinds: the protocol's seventeen opcodes grouped for reading. */
export type BrokerRequestKind = "read" | "write" | "fsync" | "allocate" | "open" | "close" | "stat" | "other";

/** Synchronous access handle call kinds, in layout order. */
export type HandleCallKind = "read" | "write" | "truncate" | "flush" | "getSize";

export declare const GUEST_CALL_KINDS: readonly GuestCallKind[];
export declare const BROKER_REQUEST_KINDS: readonly BrokerRequestKind[];
export declare const HANDLE_CALL_KINDS: readonly HandleCallKind[];

/** How many calls of one kind, the bytes they moved and the ms spent inside them. */
export interface IoKindTotals {
  readonly calls: number;
  readonly bytes: number;
  readonly ms: number;
}

/** What moved between two snapshots; see `describeIoStats`. */
export interface IoStatsDescription {
  readonly guest: {
    /** Every agent's file calls. */
    readonly all: Readonly<Record<GuestCallKind, IoKindTotals>>;
    /** The file calls of the agents that read a Session's input: the Session backends. */
    readonly sessions: Readonly<Record<GuestCallKind, IoKindTotals>>;
    readonly sessionAgents: readonly number[];
  };
  readonly broker: {
    /** Requests the coordinator answered, by kind; a request it could not classify is `other`. */
    readonly requests: Readonly<Record<BrokerRequestKind, number>>;
    /** The requests' own payload bytes (a write's data plus every request's fixed fields). */
    readonly requestBytes: number;
    readonly served: number;
    /** The ms the coordinator's serve loop spent answering. */
    readonly servingMs: number;
  };
  readonly handles: Readonly<Record<HandleCallKind, IoKindTotals>>;
}

/** The counters themselves, over one buffer every agent shares. */
export declare class IoStats {
  /** Zeroed counters for `agents` guest agents; `shared: false` for a same-worker-only reader. */
  static create(options: { readonly agents: number; readonly shared?: boolean }): IoStats;
  static attach(buffer: ArrayBufferLike): IoStats;
  readonly buffer: SharedArrayBuffer | ArrayBuffer;
  readonly agents: number;
  /** A copy of every counter, for `describeIoStats`. */
  snapshot(): Float64Array;
}

/** A directory handle whose files' synchronous access handles count every call. */
export declare function countHandleCalls<T extends FileSystemDirectoryHandle>(directory: T, stats: IoStats): T;

/** What moved between two snapshots, by kind. */
export declare function describeIoStats(before: Float64Array, after: Float64Array): IoStatsDescription;
