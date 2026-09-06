/**
 * Whether a Configuration can run here, decided at runtime rather than pinned in a flag.
 *
 * Every Engine is wired up, so "available" is no longer a property of the Configuration — it is a
 * property of the browser the page is open in. Two capabilities are gated:
 *
 * - **JSPI**, per Engine. pgrust's `--stdio-wire` session suspends the guest on its blocking stdin
 *   read, which needs JS Promise Integration; without it the Engine cannot run at all.
 * - **An OPFS synchronous access handle**, per Configuration. The `opfs-repacked` store needs one to
 *   open its four files, and no Engine as such needs one: the same PGlite runs the Memory columns
 *   here regardless. That is why this gate reads the Configuration's store setting rather than its
 *   Engine, and why the Memory columns stay available in a browser that refuses handles.
 *
 * Neither reason is ever a Run failure. An unavailable column is greyed out with its reason and the
 * others carry on.
 */

import type { Configuration, EngineId } from "./contract";
import { pgliteStore } from "./contract";

/** Shown in the pgrust column header, and thrown by the pgrust worker, when JSPI is missing. */
export const JSPI_REQUIREMENT_MESSAGE =
  "pgrust requires JSPI (WebAssembly.Suspending/promising); use Chrome ≥137, Firefox ≥153 or Safari 27+";

/** Shown in the two OPFS column headers when a synchronous access handle cannot be opened here. */
export const OPFS_SYNC_ACCESS_REQUIREMENT_MESSAGE =
  "The opfs-repacked store requires an OPFS synchronous access handle in a dedicated worker; " +
  "Chromium and Firefox grant one, Playwright's WebKit build refuses it";

/** Engines whose worker cannot start without JS Promise Integration. */
const ENGINES_REQUIRING_JSPI: readonly EngineId[] = ["pgrust"];

export function engineRequiresJspi(engine: EngineId): boolean {
  return ENGINES_REQUIRING_JSPI.includes(engine);
}

/**
 * Whether this Configuration opens its data directory through a store, and therefore needs a
 * synchronous access handle. A Memory Configuration on the same Engine does not.
 */
export function configurationRequiresOpfsSyncAccess(configuration: Configuration): boolean {
  return pgliteStore(configuration.options) !== undefined;
}

export interface Availability {
  readonly available: boolean;
  /** Present only when `available` is false. */
  readonly reason?: string;
}

/** The slice of the environment availability depends on. */
export interface AvailabilityEnvironment {
  readonly jspiAvailable: boolean;
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
  if (configurationRequiresOpfsSyncAccess(configuration) && !environment.opfsSyncAccessAvailable) {
    return { available: false, reason: OPFS_SYNC_ACCESS_REQUIREMENT_MESSAGE };
  }
  return AVAILABLE;
}
