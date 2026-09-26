/**
 * What the results were produced on. Shown at the top of the page and embedded in every Markdown
 * export, because a benchmark number without its environment is not a result.
 */

import type { BrokerSwitches } from "./broker-switches";
import { describeBrokerSwitches, readBrokerSwitches } from "./broker-switches";
import { describeConcurrencyClientsOverride, readConcurrencyClientsOverride } from "./concurrency-clients";
import { detectOpfsSyncAccess } from "./opfs-sync-access";
import { describePgrustModule, readPgrustModule } from "./pgrust-module";
import type { PostmasterTuning } from "./postmaster-tuning";
import { describePostmasterTuning, hasPostmasterTuning, readPostmasterTuning } from "./postmaster-tuning";
import { describeRttIterations, readRttIterationsOverride } from "./rtt-iterations";

declare const __PGLITE_VERSION__: string;
declare const __OPFS_REPACKED_VERSION__: string;
declare const __PGRUST_VERSION__: string;
declare const __WASQLITE_VERSION__: string;

/** Substituted by Vite `define`; absent under `bun test`, hence the `typeof` guards. */
const PGLITE_VERSION = typeof __PGLITE_VERSION__ === "string" ? __PGLITE_VERSION__ : "unknown";
const OPFS_REPACKED_VERSION = typeof __OPFS_REPACKED_VERSION__ === "string" ? __OPFS_REPACKED_VERSION__ : "unknown";
const PGRUST_VERSION = typeof __PGRUST_VERSION__ === "string" ? __PGRUST_VERSION__ : "not synced";
const WASQLITE_VERSION = typeof __WASQLITE_VERSION__ === "string" ? __WASQLITE_VERSION__ : "unknown";

export interface EnvironmentInfo {
  readonly userAgent: string;
  readonly pgliteVersion: string;
  /** The store the two OPFS Configurations run on; it is as much a subject as PGlite itself. */
  readonly opfsRepackedVersion: string;
  /** The pgrust commit written by `bun run sync:pgrust`, or "not synced". */
  readonly pgrustVersion: string;
  /** The Reference Engine's npm version, read from `wa-sqlite`'s own manifest at build time. */
  readonly wasqliteVersion: string;
  /** Whether the JavaScript Promise Integration proposal is available (pgrust's wasm build wants it). */
  readonly jspiAvailable: boolean;
  /**
   * Whether this page is cross-origin isolated, i.e. whether both COOP and COEP arrived.
   *
   * `SharedArrayBuffer` and a shared `WebAssembly.Memory` are gated on it, and those two are the
   * whole of the pgrust threads build — so this is reported on its own line rather than folded into
   * a capability check, because a run that lost isolation would otherwise look like a run whose
   * browser lacks threads.
   */
  readonly crossOriginIsolated: boolean;
  /** Whether a real OPFS synchronous access handle opened in a dedicated worker (the store needs one). */
  readonly opfsSyncAccessAvailable: boolean;
  /** Why the probe was refused, when it was; null when the handle opened. */
  readonly opfsSyncAccessReason: string | null;
  /**
   * A non-standard RTT iteration count requested through `?rttIterations=N`, or null for the
   * defined 100. Reported everywhere the environment is, because it changes what the numbers mean.
   */
  readonly rttIterationsOverride: number | null;
  /**
   * A non-standard Concurrency Client count requested through `?concurrencyClients=N`, or null for
   * the defined four. Reported everywhere the environment is, for the same reason: it changes what
   * every number in that Suite means.
   */
  readonly concurrencyClientsOverride: number | null;
  /**
   * The pgrust Postmaster memory knobs requested through `?postmasterTuning=`, every one of them
   * null when the URL moved nothing. Reported for the same reason as the two above: a postmaster on
   * another pool size, another initial shared memory or another GUC is a different server, and its
   * numbers must not be read as this repo's.
   */
  readonly postmasterTuning: PostmasterTuning;
  /**
   * The alternate pgrust threads module requested through `?pgrustModule=<id>`, or null for the
   * build's own `postgres-threads.wasm`. Reported for the same reason as the three above: the six
   * threads and postmaster columns then run another pgrust build than {@link pgrustVersion} names.
   */
  readonly pgrustModule: string | null;
  /**
   * The two store-seam switches, `?brokerStats=1` and `?brokerGather=1`, both off unless the URL
   * turned them on. Reported for the same reason as the four above: counted store work is a Run
   * with a clock read on either side of every file call, and gathered writes are another broker.
   */
  readonly brokerSwitches: BrokerSwitches;
}

/**
 * Whether the page really got both isolation headers.
 *
 * `crossOriginIsolated` is the browser's own answer, not ours: it is true only when COOP
 * `same-origin` and COEP `require-corp` both arrived, which is exactly the condition
 * `SharedArrayBuffer` is gated on. Probed together with the constructor because a browser could in
 * principle have one without the other, and the threads Engine needs both.
 */
export function detectCrossOriginIsolation(): boolean {
  return typeof SharedArrayBuffer === "function" && globalThis.crossOriginIsolated === true;
}

/**
 * JSPI is not in lib.dom yet; probe the two entry points the proposal defines rather than widening
 * the whole namespace.
 */
export function detectJspi(): boolean {
  const wasm = WebAssembly as unknown as { Suspending?: unknown; promising?: unknown };
  return typeof wasm.Suspending === "function" && typeof wasm.promising === "function";
}

/**
 * Read the environment once, before anything is rendered.
 *
 * Asynchronous because one of the capabilities cannot be read synchronously: an OPFS synchronous
 * access handle can only be opened from a worker, so it is opened from one. Waiting for it costs a
 * few milliseconds at page load and buys a header — and a set of column headers — that are true
 * before the first Start is pressed rather than shortly after.
 */
export async function readEnvironment(): Promise<EnvironmentInfo> {
  const opfsSyncAccess = await detectOpfsSyncAccess();
  if (!opfsSyncAccess.available) {
    // Surfaced rather than swallowed: the headless lane records page errors, so a browser that
    // refuses handles says why in the run's own results file.
    console.error(`OPFS sync access unavailable: ${opfsSyncAccess.reason ?? "no reason given"}`);
  }
  return {
    userAgent: typeof navigator === "undefined" ? "unknown" : navigator.userAgent,
    pgliteVersion: PGLITE_VERSION,
    opfsRepackedVersion: OPFS_REPACKED_VERSION,
    pgrustVersion: PGRUST_VERSION,
    wasqliteVersion: WASQLITE_VERSION,
    jspiAvailable: detectJspi(),
    crossOriginIsolated: detectCrossOriginIsolation(),
    opfsSyncAccessAvailable: opfsSyncAccess.available,
    opfsSyncAccessReason: opfsSyncAccess.reason ?? null,
    rttIterationsOverride: readRttIterationsOverride(),
    concurrencyClientsOverride: readConcurrencyClientsOverride(),
    postmasterTuning: readPostmasterTuning(),
    pgrustModule: readPgrustModule(),
    brokerSwitches: readBrokerSwitches(),
  };
}

/** The one-line environment description embedded in Markdown exports. */
export function formatEnvironmentLine(environment: EnvironmentInfo): string {
  const parts = [
    `@pgxsinkit/pglite ${environment.pgliteVersion}`,
    `@pgxsinkit/pglite-opfs-repacked ${environment.opfsRepackedVersion}`,
    `pgrust ${environment.pgrustVersion}`,
    `wa-sqlite ${environment.wasqliteVersion}`,
    `JSPI ${environment.jspiAvailable ? "available" : "unavailable"}`,
    `cross-origin isolated ${environment.crossOriginIsolated ? "yes" : "no"}`,
    `OPFS sync access ${environment.opfsSyncAccessAvailable ? "available" : "unavailable"}`,
    environment.userAgent,
  ];
  if (environment.rttIterationsOverride !== null) {
    parts.push(describeRttIterations(environment.rttIterationsOverride));
  }
  if (environment.concurrencyClientsOverride !== null) {
    parts.push(describeConcurrencyClientsOverride(environment.concurrencyClientsOverride));
  }
  if (hasPostmasterTuning(environment.postmasterTuning)) {
    parts.push(describePostmasterTuning(environment.postmasterTuning));
  }
  if (environment.pgrustModule !== null) {
    parts.push(describePgrustModule(environment.pgrustModule));
  }
  parts.push(...describeBrokerSwitches(environment.brokerSwitches));
  return parts.join(" | ");
}
