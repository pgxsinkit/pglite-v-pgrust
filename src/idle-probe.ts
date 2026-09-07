/**
 * The page half of the idle-CPU probe: open one Configuration, warm it, and then do nothing.
 *
 * `scripts/probe-idle-cpu.ts` (Linux, headless Chromium over CDP) and
 * `scripts/probe-idle-cpu-android.ts` (a phone over adb) drive this. The question both of them ask
 * is what an Engine costs a device that is not using it — a tab left open on a page that has a
 * database in it — so the page's whole job here is to get an Engine to the state a real application
 * would leave it in and then stay out of the way: no timers, no polling, no rendering.
 *
 * Three calls, for the same reason the memory probe has three: the numbers are taken **outside** the
 * page, by the browser and the OS, and they have to be taken while the Engine is standing.
 *
 *  1. `open` — open the Engine, run the Suite's setup and exactly one timed Benchmark, and leave it
 *     open. `settings` and `env` reach the postmaster Engine's argv and guest environment, which is
 *     how the quiet-GUC variant is a different Run of the same Configuration rather than a different
 *     Configuration;
 *  2. `query` — one `select 1`, timed on this side of the worker boundary. It is the after-the-idle
 *     liveness check: on a phone, a tab the OS has frozen answers late or not at all, and how late
 *     is the measurement;
 *  3. `release` — close the Engine and terminate its workers.
 *
 * A driver that wants the **blank** control simply never calls `open`: the page is loaded, the
 * environment has been read, and nothing else exists. That column is what every other one is read
 * against, because a loaded page is not free either.
 */

import { findConfiguration } from "./configurations";
import { configurationAvailability } from "./engines/availability";
import type { Configuration, EngineRunner } from "./engines/contract";
import { configurationDialect } from "./engines/contract";
import { createEngineRunner } from "./engines/registry";
import type { EnvironmentInfo } from "./environment";
import { planRun } from "./runner/run-suite";
import { RTT_SUITE } from "./suites/rtt";
import { isScenarioBenchmark } from "./suites/types";

/** The global the drivers look for. */
export const IDLE_PROBE_GLOBAL = "__idleProbe";

/** The liveness statement: one round trip, no rows to speak of, legal in both dialects. */
const LIVENESS_SQL = "select 1";

export interface IdleProbeOpenRequest {
  readonly configurationId: string;
  /**
   * Extra `name=value` settings for the postmaster Engine's argv (`-c name=value` each).
   *
   * Ignored by every other Engine, which is honest rather than lax: the quiet variant exists to
   * turn Postgres's own periodic work down, and there is no such thing to turn down elsewhere.
   */
  readonly settings?: readonly string[];
  /** Extra guest environment entries for the postmaster Engine; the pgrust knobs that are env vars. */
  readonly env?: Readonly<Record<string, string>>;
}

export interface IdleProbeOpenResult {
  readonly configurationId: string;
  readonly label: string;
  /** False when this browser cannot run the Configuration; `reason` says why and nothing was opened. */
  readonly available: boolean;
  readonly reason: string | null;
  /** Open, plus the untimed setup: what a page pays before it is idle. */
  readonly openMs: number;
  /** The one warm Benchmark, as the Engine's worker timed it. */
  readonly warmMs: number;
  /** Which Benchmark that was, so a row of the table can say what "warm" meant. */
  readonly warmBenchmark: string;
}

export interface IdleProbeQueryResult {
  /** Wall time across the worker boundary, which is what a frozen tab lengthens. */
  readonly ms: number;
  /** The same statement as the Engine's own worker timed it; the difference is the boundary. */
  readonly engineMs: number;
}

/** One `visibilitychange`, on the page's own clock. */
export interface IdleProbeVisibilityEvent {
  /** `Date.now()`, so a driver can line it up with a window it timed from outside the browser. */
  readonly atMs: number;
  readonly state: string;
}

export interface IdleProbeHandle {
  open(request: IdleProbeOpenRequest): Promise<IdleProbeOpenResult>;
  query(): Promise<IdleProbeQueryResult>;
  /**
   * Every `visibilitychange` since the page loaded, which is the only trustworthy record of whether a
   * window really measured a hidden tab.
   *
   * Asking the page directly cannot work: attaching a DevTools client to a background tab makes
   * Chrome (on Android above all) treat it as active, so a `document.visibilityState` read over CDP
   * answers `visible` whatever the tab was doing a moment earlier. A listener installed at load time
   * costs nothing while idle — no timer, no polling — and can be read once at the end, after the
   * measurement is over.
   */
  visibility(): Promise<readonly IdleProbeVisibilityEvent[]>;
  release(): Promise<void>;
}

/** Appended to by a `visibilitychange` listener installed once, at page load. */
const visibilityLog: IdleProbeVisibilityEvent[] = [];

let openRunner: EngineRunner | null = null;

/**
 * The Configuration, with the caller's postmaster settings folded into its open options.
 *
 * A copy, never a mutation: `findConfiguration` hands back the module-level record every other part
 * of the page reads, and a probe that edited it would change what the table means for the rest of
 * the session.
 */
function withSettings(configuration: Configuration, request: IdleProbeOpenRequest): Configuration {
  const settings = request.settings ?? [];
  const env = request.env ?? {};
  if (settings.length === 0 && Object.keys(env).length === 0) {
    return configuration;
  }
  return {
    ...configuration,
    options: {
      ...configuration.options,
      pgrustPostmaster: { ...configuration.options?.pgrustPostmaster, settings, env },
    },
  };
}

export async function openIdleProbe(
  environment: EnvironmentInfo,
  request: IdleProbeOpenRequest,
): Promise<IdleProbeOpenResult> {
  if (openRunner !== null) {
    throw new Error("The idle probe already has an Engine open; call release() first");
  }
  const found = findConfiguration(request.configurationId);
  if (found === undefined) {
    throw new Error(`No Configuration with id "${request.configurationId}"`);
  }
  const availability = configurationAvailability(found, environment);
  if (!availability.available) {
    return {
      configurationId: request.configurationId,
      label: found.label,
      available: false,
      reason: availability.reason ?? "unavailable",
      openMs: 0,
      warmMs: 0,
      warmBenchmark: "",
    };
  }

  const configuration = withSettings(found, request);
  const plan = planRun(RTT_SUITE, configuration, RTT_SUITE.initialSetupFor(configurationDialect(configuration)));
  const runner = createEngineRunner(configuration.engine);
  openRunner = runner;
  const startedAt = performance.now();
  await runner.open(configuration, plan.setupSql, plan.sessions);
  const openMs = performance.now() - startedAt;

  // One Benchmark, once: enough that the Engine has executed a real statement — planner, buffers,
  // WAL — before the idle window starts, and not so much that the window measures a cooling server.
  const benchmark = plan.benchmarks.find((candidate) => !isScenarioBenchmark(candidate));
  if (benchmark === undefined || isScenarioBenchmark(benchmark)) {
    throw new Error("The RTT Suite yielded no single-statement Benchmark to warm the Engine with");
  }
  const warm = await runner.measure(benchmark.sql);
  return {
    configurationId: request.configurationId,
    label: found.label,
    available: true,
    reason: null,
    openMs,
    warmMs: warm.elapsedMs,
    warmBenchmark: benchmark.label,
  };
}

export async function queryIdleProbe(): Promise<IdleProbeQueryResult> {
  const runner = openRunner;
  if (runner === null) {
    throw new Error("The idle probe has no Engine open");
  }
  const startedAt = performance.now();
  const measurement = await runner.measure(LIVENESS_SQL);
  return { ms: performance.now() - startedAt, engineMs: measurement.elapsedMs };
}

export async function releaseIdleProbe(): Promise<void> {
  const runner = openRunner;
  openRunner = null;
  await runner?.close();
}

/** Publish the handle. Called once from `main.tsx`, after the environment has been read. */
export function installIdleProbe(environment: EnvironmentInfo): void {
  visibilityLog.push({ atMs: Date.now(), state: document.visibilityState });
  document.addEventListener("visibilitychange", () => {
    visibilityLog.push({ atMs: Date.now(), state: document.visibilityState });
  });
  const handle: IdleProbeHandle = {
    open: async (request) => await openIdleProbe(environment, request),
    query: queryIdleProbe,
    visibility: async () => await Promise.resolve([...visibilityLog]),
    release: releaseIdleProbe,
  };
  (globalThis as unknown as Record<string, IdleProbeHandle>)[IDLE_PROBE_GLOBAL] = handle;
}
