/**
 * Whether a Configuration can run here, decided at runtime rather than pinned in a flag.
 *
 * Every Engine is wired up, so "available" is no longer a property of the Configuration — it is a
 * property of the browser the page is open in. Three capabilities are gated:
 *
 * - **JSPI**, per Engine. pgrust's `--stdio-wire` session suspends the guest on its blocking stdin
 *   read, which needs JS Promise Integration; without it the Engine cannot run at all.
 * - **Shared memory**, per Engine, and the exact complement of the one above. pgrust's
 *   `wasm32-wasip1-threads` build needs no JSPI at all — its guest threads block that same read in
 *   `Atomics.wait` — but it imports one shared `WebAssembly.Memory` and speaks to the host over
 *   `SharedArrayBuffer` ring pipes, and both are gated on cross-origin isolation. This repo serves
 *   the two headers everywhere, so a `no` here is a browser that withholds them, not a missing
 *   server config.
 * - **An OPFS synchronous access handle**, per Configuration. The `opfs-repacked` store needs one to
 *   open its four files, and no Engine as such needs one: the same PGlite runs the Memory columns
 *   here regardless, and so does the same threads build. That is why this gate reads the
 *   Configuration's storage settings rather than its Engine, and why the Memory columns stay
 *   available in a browser that refuses handles.
 *
 * The two threads columns whose store is on OPFS are gated on shared memory **and** on a handle, and
 * they are asked in that order: a browser that has neither is told about isolation first, because
 * without it that Engine has nothing to open a store from in the first place.
 *
 * No reason is ever a Run failure. An unavailable column is greyed out with its reason and the
 * others carry on.
 */

import type { Configuration, EngineId } from "./contract";
import { pgliteStore, pgrustThreadsOpensOpfsStore } from "./contract";

/** Shown in the pgrust column header, and thrown by the pgrust worker, when JSPI is missing. */
export const JSPI_REQUIREMENT_MESSAGE =
  "pgrust requires JSPI (WebAssembly.Suspending/promising); use Chrome ≥137, Firefox ≥153 or Safari 27+";

/**
 * Shown in the four pgrust Threads column headers, and thrown by their worker, without isolation.
 *
 * It names the two headers because that is the actionable part: a reader who sees this on their own
 * deployment needs to know what to send, and a reader who sees it on `bun run dev` is looking at a
 * browser that withheld `SharedArrayBuffer` despite them.
 */
export const SHARED_MEMORY_REQUIREMENT_MESSAGE =
  "The pgrust threads build requires SharedArrayBuffer and a shared WebAssembly.Memory, which need " +
  "a cross-origin isolated page (Cross-Origin-Opener-Policy: same-origin plus " +
  "Cross-Origin-Embedder-Policy: require-corp)";

/** Shown in the four OPFS column headers when a synchronous access handle cannot be opened here. */
export const OPFS_SYNC_ACCESS_REQUIREMENT_MESSAGE =
  "The opfs-repacked store requires an OPFS synchronous access handle in a dedicated worker; " +
  "Chromium and Firefox grant one, Playwright's WebKit build refuses it";

/** Engines whose worker cannot start without JS Promise Integration. */
const ENGINES_REQUIRING_JSPI: readonly EngineId[] = ["pgrust"];

export function engineRequiresJspi(engine: EngineId): boolean {
  return ENGINES_REQUIRING_JSPI.includes(engine);
}

/**
 * Engines whose worker cannot start without `SharedArrayBuffer` and a shared `WebAssembly.Memory`.
 *
 * Deliberately not `pgrust`: the two builds want opposite things, and an Engine gated on both would
 * be reported unavailable in a browser that can in fact run it.
 */
const ENGINES_REQUIRING_SHARED_MEMORY: readonly EngineId[] = ["pgrust-threads"];

export function engineRequiresSharedMemory(engine: EngineId): boolean {
  return ENGINES_REQUIRING_SHARED_MEMORY.includes(engine);
}

/**
 * Whether this Configuration opens its data directory through a store on OPFS, and therefore needs a
 * synchronous access handle. A Memory Configuration on the same Engine does not.
 *
 * Two Engines reach the same store two ways — PGlite through the package's own filesystem, the
 * threads build through the broker's coordinator worker — and the handle is what both of them need,
 * so this asks the Configuration's storage settings rather than its Engine. The threads broker on
 * its **memory** port opens no OPFS file at all and is deliberately not gated here.
 */
export function configurationRequiresOpfsSyncAccess(configuration: Configuration): boolean {
  return pgliteStore(configuration.options) !== undefined || pgrustThreadsOpensOpfsStore(configuration.options);
}

export interface Availability {
  readonly available: boolean;
  /** Present only when `available` is false. */
  readonly reason?: string;
}

/** The slice of the environment availability depends on. */
export interface AvailabilityEnvironment {
  readonly jspiAvailable: boolean;
  /** Both isolation headers arrived, so `SharedArrayBuffer` and a shared memory exist. */
  readonly crossOriginIsolated: boolean;
  readonly opfsSyncAccessAvailable: boolean;
}

const AVAILABLE: Availability = { available: true };

export function configurationAvailability(
  configuration: Configuration,
  environment: AvailabilityEnvironment,
): Availability {
  if (engineRequiresJspi(configuration.engine) && !environment.jspiAvailable) {
    return { available: false, reason: JSPI_REQUIREMENT_MESSAGE };
  }
  if (engineRequiresSharedMemory(configuration.engine) && !environment.crossOriginIsolated) {
    return { available: false, reason: SHARED_MEMORY_REQUIREMENT_MESSAGE };
  }
  if (configurationRequiresOpfsSyncAccess(configuration) && !environment.opfsSyncAccessAvailable) {
    return { available: false, reason: OPFS_SYNC_ACCESS_REQUIREMENT_MESSAGE };
  }
  return AVAILABLE;
}
