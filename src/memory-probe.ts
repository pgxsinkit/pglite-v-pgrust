/**
 * The page half of the memory probe: run ONE Configuration and leave its Engine standing.
 *
 * `scripts/probe-memory.ts` drives this. Everything the probe wants lives in three different places
 * and only one of them is reachable from a driver script: a `WebAssembly.Memory` belongs to the
 * worker that created it, `performance.measureUserAgentSpecificMemory()` belongs to the page, and
 * the renderer's RSS and the live worker count belong to the browser (CDP). So the page exposes a
 * three-call handle — `run`, which opens an Engine and warms it with one Run of the RTT Suite;
 * `measurePage`, which asks the browser for the page's own memory; and `release`, which closes the
 * Engine — and the driver takes the browser's numbers between the first two, while the Engine is
 * still alive and before anything has forced a garbage collection.
 *
 * The order matters and is the reason `measurePage` is not folded into `run`: the page measurement
 * waits for a GC across the whole agent cluster, and an RSS taken after one would be a different
 * quantity from an RSS taken after a Run — for the Configurations where the measurement returns at
 * all.
 *
 * It is a `window` global rather than a UI control on purpose: nothing about the benchmark page
 * changes, the Suites still run exactly as they did, and the probe is invisible unless a driver asks
 * for it by name.
 */

import { findConfiguration } from "./configurations";
import { suiteAvailability } from "./engines/availability";
import type { EngineRunner } from "./engines/contract";
import { configurationDialect } from "./engines/contract";
import type { WasmMemoryStat } from "./engines/protocol";
import { createEngineRunner } from "./engines/registry";
import type { EnvironmentInfo } from "./environment";
import { planRun } from "./runner/run-suite";
import { RTT_SUITE } from "./suites/rtt";
import { isScenarioBenchmark } from "./suites/types";

/** The global the driver looks for. */
export const MEMORY_PROBE_GLOBAL = "__memoryProbe";

/**
 * How long to wait for `measureUserAgentSpecificMemory()`.
 *
 * It resolves on the browser's own schedule — it waits for a garbage collection across every agent
 * in the cluster — and against a pgrust Configuration it never resolves at all, because that
 * Engine's workers are parked in `Atomics.wait` inside the guest and cannot take part in one. So
 * this is a real outcome rather than a safety net, and it is short enough to be paid twice.
 */
const PAGE_MEMORY_TIMEOUT_MS = 30_000;

/** One line of `performance.measureUserAgentSpecificMemory()`'s breakdown, flattened for a table. */
export interface PageMemoryBreakdownEntry {
  readonly bytes: number;
  readonly types: readonly string[];
  /** The attribution's scope — `Window`, `DedicatedWorkerGlobalScope`, … — or "" when unattributed. */
  readonly scope: string;
}

export interface PageMemory {
  readonly bytes: number;
  readonly breakdown: readonly PageMemoryBreakdownEntry[];
}

export interface MemoryProbeResult {
  readonly configurationId: string;
  readonly label: string;
  /** False when this browser cannot run the Configuration; `reason` says why and nothing was opened. */
  readonly available: boolean;
  readonly reason: string | null;
  /** Wall time of open + the untimed setup + one pass over the RTT Benchmarks. */
  readonly runMs: number;
  readonly benchmarksRun: number;
  readonly wasmMemories: readonly WasmMemoryStat[];
}

/** What `measurePage` answers: the measurement, or why there is none. */
export interface PageMemoryReport {
  /** Null when the browser withheld the measurement (it needs cross-origin isolation) or timed out. */
  readonly memory: PageMemory | null;
  readonly note: string;
}

/** The shape `scripts/probe-memory.ts` calls through `page.evaluate`. */
export interface MemoryProbeHandle {
  run(configurationId: string): Promise<MemoryProbeResult>;
  measurePage(): Promise<PageMemoryReport>;
  release(): Promise<void>;
}

/** `performance.measureUserAgentSpecificMemory()`, which no TS lib declares yet. */
interface MeasuredMemory {
  readonly bytes: number;
  readonly breakdown: readonly {
    readonly bytes: number;
    readonly types?: readonly string[];
    readonly attribution?: readonly { readonly scope?: string }[];
  }[];
}

type MeasuringPerformance = Performance & {
  measureUserAgentSpecificMemory?: () => Promise<MeasuredMemory>;
};

let openRunner: EngineRunner | null = null;

export async function measurePageMemory(): Promise<PageMemoryReport> {
  const measure = (performance as MeasuringPerformance).measureUserAgentSpecificMemory;
  if (typeof measure !== "function") {
    return { memory: null, note: "performance.measureUserAgentSpecificMemory is not available here" };
  }
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), PAGE_MEMORY_TIMEOUT_MS));
  // It resolves on the browser's own schedule — it waits for a garbage collection — so a Run that
  // never gets one reports nothing rather than hanging the whole probe.
  const measured = await Promise.race([measure.call(performance), timeout]);
  if (measured === null) {
    return { memory: null, note: `no measurement within ${PAGE_MEMORY_TIMEOUT_MS} ms` };
  }
  return {
    memory: {
      bytes: measured.bytes,
      breakdown: measured.breakdown
        .filter((entry) => entry.bytes > 0)
        .map((entry) => ({
          bytes: entry.bytes,
          types: entry.types ?? [],
          scope: entry.attribution?.[0]?.scope ?? "",
        }))
        .sort((left, right) => right.bytes - left.bytes),
    },
    note: "per page: this agent cluster, the page's workers included",
  };
}

/**
 * Open one Configuration, run the RTT Suite's Benchmarks once each, and report what this side can
 * see. The Engine is left open: `release()` closes it, and the driver measures the browser in
 * between.
 */
export async function runMemoryProbe(
  environment: EnvironmentInfo,
  configurationId: string,
): Promise<MemoryProbeResult> {
  if (openRunner !== null) {
    throw new Error("The memory probe already has an Engine open; call release() first");
  }
  const configuration = findConfiguration(configurationId);
  if (configuration === undefined) {
    throw new Error(`No Configuration with id "${configurationId}"`);
  }
  const availability = suiteAvailability(RTT_SUITE, configuration, environment);
  if (!availability.available) {
    return {
      configurationId,
      label: configuration.label,
      available: false,
      reason: availability.reason ?? "unavailable",
      runMs: 0,
      benchmarksRun: 0,
      wasmMemories: [],
    };
  }

  const plan = planRun(RTT_SUITE, configuration, RTT_SUITE.initialSetupFor(configurationDialect(configuration)));
  const runner = createEngineRunner(configuration.engine);
  openRunner = runner;
  const startedAt = performance.now();
  await runner.open(configuration, plan.setupSql, plan.sessions);
  let benchmarksRun = 0;
  for (const benchmark of plan.benchmarks) {
    // One iteration each, which is what "warm" means here: the Engine has booted, the setup has run
    // and every statement has been executed once. The numbers are memory, not time.
    if (isScenarioBenchmark(benchmark)) {
      continue;
    }
    await runner.measure(benchmark.sql);
    benchmarksRun += 1;
  }
  const runMs = performance.now() - startedAt;

  const stats = await runner.stats();
  return {
    configurationId,
    label: configuration.label,
    available: true,
    reason: null,
    runMs,
    benchmarksRun,
    wasmMemories: stats.wasmMemories,
  };
}

export async function releaseMemoryProbe(): Promise<void> {
  const runner = openRunner;
  openRunner = null;
  await runner?.close();
}

/** Publish the handle. Called once from `main.tsx`, after the environment has been read. */
export function installMemoryProbe(environment: EnvironmentInfo): void {
  const handle: MemoryProbeHandle = {
    run: async (configurationId) => await runMemoryProbe(environment, configurationId),
    measurePage: measurePageMemory,
    release: releaseMemoryProbe,
  };
  (globalThis as unknown as Record<string, MemoryProbeHandle>)[MEMORY_PROBE_GLOBAL] = handle;
}
