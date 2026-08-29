/**
 * Whether a Configuration can run here, decided at runtime rather than pinned in a flag.
 *
 * Every Engine is wired up, so "available" is no longer a property of the Configuration — it is a
 * property of the browser the page is open in. pgrust's `--stdio-wire` session suspends the guest
 * on its blocking stdin read, which needs JS Promise Integration; without JSPI the Engine cannot
 * run at all and its column is reported unavailable instead of failing mid-Run. PGlite and the
 * wa-sqlite Reference Engine have no such requirement and are available everywhere.
 */

import type { Configuration, EngineId } from "./contract";

/** Shown in the pgrust column header, and thrown by the pgrust worker, when JSPI is missing. */
export const JSPI_REQUIREMENT_MESSAGE =
  "pgrust requires JSPI (WebAssembly.Suspending/promising); use Chrome ≥137, Firefox ≥153 or Safari 27+";

/** Engines whose worker cannot start without JS Promise Integration. */
const ENGINES_REQUIRING_JSPI: readonly EngineId[] = ["pgrust"];

export function engineRequiresJspi(engine: EngineId): boolean {
  return ENGINES_REQUIRING_JSPI.includes(engine);
}

export interface Availability {
  readonly available: boolean;
  /** Present only when `available` is false. */
  readonly reason?: string;
}

/** The slice of the environment availability depends on. */
export interface AvailabilityEnvironment {
  readonly jspiAvailable: boolean;
}

const AVAILABLE: Availability = { available: true };

export function configurationAvailability(
  configuration: Configuration,
  environment: AvailabilityEnvironment,
): Availability {
  if (engineRequiresJspi(configuration.engine) && !environment.jspiAvailable) {
    return { available: false, reason: JSPI_REQUIREMENT_MESSAGE };
  }
  return AVAILABLE;
}
