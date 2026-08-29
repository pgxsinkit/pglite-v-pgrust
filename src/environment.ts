/**
 * What the results were produced on. Shown at the top of the page and embedded in every Markdown
 * export, because a benchmark number without its environment is not a result.
 */

import { describeRttIterations, readRttIterationsOverride } from "./rtt-iterations";

declare const __PGLITE_VERSION__: string;
declare const __PGRUST_VERSION__: string;
declare const __WASQLITE_VERSION__: string;

/** Substituted by Vite `define`; absent under `bun test`, hence the `typeof` guards. */
const PGLITE_VERSION = typeof __PGLITE_VERSION__ === "string" ? __PGLITE_VERSION__ : "unknown";
const PGRUST_VERSION = typeof __PGRUST_VERSION__ === "string" ? __PGRUST_VERSION__ : "not synced";
const WASQLITE_VERSION = typeof __WASQLITE_VERSION__ === "string" ? __WASQLITE_VERSION__ : "unknown";

export interface EnvironmentInfo {
  readonly userAgent: string;
  readonly pgliteVersion: string;
  /** The pgrust commit written by `bun run sync:pgrust`, or "not synced". */
  readonly pgrustVersion: string;
  /** The Reference Engine's npm version, read from `wa-sqlite`'s own manifest at build time. */
  readonly wasqliteVersion: string;
  /** Whether the JavaScript Promise Integration proposal is available (pgrust's wasm build wants it). */
  readonly jspiAvailable: boolean;
  /**
   * A non-standard RTT iteration count requested through `?rttIterations=N`, or null for the
   * defined 100. Reported everywhere the environment is, because it changes what the numbers mean.
   */
  readonly rttIterationsOverride: number | null;
}

/**
 * JSPI is not in lib.dom yet; probe the two entry points the proposal defines rather than widening
 * the whole namespace.
 */
export function detectJspi(): boolean {
  const wasm = WebAssembly as unknown as { Suspending?: unknown; promising?: unknown };
  return typeof wasm.Suspending === "function" && typeof wasm.promising === "function";
}

export function readEnvironment(): EnvironmentInfo {
  return {
    userAgent: typeof navigator === "undefined" ? "unknown" : navigator.userAgent,
    pgliteVersion: PGLITE_VERSION,
    pgrustVersion: PGRUST_VERSION,
    wasqliteVersion: WASQLITE_VERSION,
    jspiAvailable: detectJspi(),
    rttIterationsOverride: readRttIterationsOverride(),
  };
}

/** The one-line environment description embedded in Markdown exports. */
export function formatEnvironmentLine(environment: EnvironmentInfo): string {
  const parts = [
    `@pgxsinkit/pglite ${environment.pgliteVersion}`,
    `pgrust ${environment.pgrustVersion}`,
    `wa-sqlite ${environment.wasqliteVersion}`,
    `JSPI ${environment.jspiAvailable ? "available" : "unavailable"}`,
    environment.userAgent,
  ];
  if (environment.rttIterationsOverride !== null) {
    parts.push(describeRttIterations(environment.rttIterationsOverride));
  }
  return parts.join(" | ");
}
