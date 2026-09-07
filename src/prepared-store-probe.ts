/**
 * The page half of the prepared-store probe: two pipelines to the same datadir, timed side by side.
 *
 * `scripts/probe-prepared-store.ts` drives this. Both legs run on this page, in this browser, with
 * the cross-origin isolation the Engines need, and both start from a tarball fetched over HTTP —
 * because the question is not "how fast is a store" but **how long after the download before the
 * database answers a query**.
 *
 *  - `prepared` — the four files a repacked store IS, written into the OPFS store directory and then
 *    opened. Nothing is replayed: the coordinator finds a datadir already there and skips its seed.
 *  - `pgliteDatadir` — the reference, and the shape of the thing being replaced: PGlite's own datadir
 *    tarball, restored through `loadDataDir` into the same kind of store. Some thousands of files,
 *    created one at a time through the filesystem they are being restored into.
 *
 * Each leg answers with the same five numbers — download, restore, boot, first query, total — so the
 * two rows of the results table are the same measurement of two pipelines. The Engine is closed at
 * the end of its own leg: this probe compares pipelines, not resident cost, and the two legs must
 * not share a browser moment.
 *
 * A `window` global rather than a UI control, exactly as the memory and idle probes are: nothing
 * about the benchmark page changes and the probe is invisible unless a driver asks for it by name.
 */

import { findConfiguration } from "./configurations";
import { configurationAvailability } from "./engines/availability";
import type { Configuration, EngineOpenOptions, EngineRunner } from "./engines/contract";
import type { StoreSeedStat } from "./engines/protocol";
import { createEngineRunner } from "./engines/registry";
import type { EnvironmentInfo } from "./environment";

/** The global the driver looks for. */
export const PREPARED_STORE_PROBE_GLOBAL = "__preparedStoreProbe";

/** Every phase of one pipeline, from "the bytes have arrived" to "the database answered". */
export interface PreparedStoreLegResult {
  readonly label: string;
  readonly available: boolean;
  readonly reason: string | null;
  /** The tarball, off the local preview server. It is a LOCAL number and means nothing about a CDN. */
  readonly downloadMs: number;
  readonly downloadBytes: number;
  /**
   * Turning the tarball into a store: gunzip, untar, verify, write. Reported separately where the
   * Engine can see it (the prepared leg) and folded into `bootMs` where it cannot (PGlite's
   * `loadDataDir` happens inside the create call and has no seam to time it at).
   */
  readonly restoreMs: number | null;
  /** Opening the Engine on that store: the coordinator, the pool, and the postmaster's own boot. */
  readonly bootMs: number;
  /** The first statement a client runs, and what it answered. */
  readonly firstQueryMs: number;
  readonly rowCount: string | null;
  /** A second statement over the whole payload column: proof the bytes are really there. */
  readonly payloadBytesMs: number;
  readonly payloadBytes: string | null;
  /** Everything after the download: restore + boot + both queries. The number the exercise is about. */
  readonly afterDownloadMs: number;
  readonly totalMs: number;
  /** The seed's own phase breakdown, on the leg that has one. */
  readonly seed: StoreSeedStat | null;
}

export interface PreparedStoreLegRequest {
  /** Where the tarball is, relative to this page or absolute. */
  readonly tarUrl: string;
  /** The Configuration whose Engine and store directory this leg uses. */
  readonly configurationId: string;
  /** `SELECT count(*) …`, and what it must answer. */
  readonly countSql: string;
  readonly expectedCount: string;
  /** `SELECT sum(length(payload)) …`, whose answer is reported rather than checked. */
  readonly payloadSql: string;
}

/** The shape `scripts/probe-prepared-store.ts` calls through `page.evaluate`. */
export interface PreparedStoreProbeHandle {
  prepared(request: PreparedStoreLegRequest): Promise<PreparedStoreLegResult>;
  pgliteDatadir(request: PreparedStoreLegRequest): Promise<PreparedStoreLegResult>;
}

interface Fetched {
  readonly bytes: ArrayBuffer;
  readonly ms: number;
}

async function fetchTarball(url: string): Promise<Fetched> {
  const startedAt = performance.now();
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`${url} answered ${response.status} ${response.statusText}`);
  }
  const bytes = await response.arrayBuffer();
  return { bytes, ms: performance.now() - startedAt };
}

function unavailable(configuration: Configuration, reason: string): PreparedStoreLegResult {
  return {
    label: configuration.label,
    available: false,
    reason,
    downloadMs: 0,
    downloadBytes: 0,
    restoreMs: null,
    bootMs: 0,
    firstQueryMs: 0,
    rowCount: null,
    payloadBytesMs: 0,
    payloadBytes: null,
    afterDownloadMs: 0,
    totalMs: 0,
    seed: null,
  };
}

function requireConfiguration(environment: EnvironmentInfo, id: string): Configuration | PreparedStoreLegResult {
  const configuration = findConfiguration(id);
  if (configuration === undefined) {
    throw new Error(`No Configuration with id "${id}"`);
  }
  const availability = configurationAvailability(configuration, environment);
  return availability.available ? configuration : unavailable(configuration, availability.reason ?? "unavailable");
}

function isConfiguration(value: Configuration | PreparedStoreLegResult): value is Configuration {
  return "engine" in value;
}

/**
 * Open one Engine on `options`, ask the two questions, and close it again.
 *
 * The Configuration is cloned with the probe's own open options rather than mutated: the page's
 * Configuration list is what the table's columns are, and a probe must not leave a `seedFromTar` on
 * one of them.
 */
async function runLeg(
  configuration: Configuration,
  options: EngineOpenOptions,
  request: PreparedStoreLegRequest,
  download: Fetched,
  wantsSeedStat: boolean,
): Promise<PreparedStoreLegResult> {
  const runner: EngineRunner = createEngineRunner(configuration.engine);
  const afterDownloadAt = performance.now();
  try {
    const bootAt = performance.now();
    await runner.open({ ...configuration, options }, "");
    const openMs = performance.now() - bootAt;

    // Only the prepared leg can separate the restore from the boot: its seed runs in a worker of its
    // own and reports its phases. PGlite's `loadDataDir` happens inside the create call, so there is
    // no honest seam to split it at and the whole of it is the boot.
    const seed = wantsSeedStat ? ((await runner.stats()).storeSeed ?? null) : null;
    const restoreMs = seed === null ? null : seed.totalMs;
    const bootMs = seed === null ? openMs : openMs - seed.totalMs;

    const count = await runner.scalar(request.countSql);
    if (count.value !== request.expectedCount) {
      throw new Error(
        `the restored datadir holds ${String(count.value)} rows, not the ${request.expectedCount} that were written`,
      );
    }
    const payload = await runner.scalar(request.payloadSql);
    const afterDownloadMs = performance.now() - afterDownloadAt;

    return {
      label: configuration.label,
      available: true,
      reason: null,
      downloadMs: download.ms,
      downloadBytes: download.bytes.byteLength,
      restoreMs,
      bootMs,
      firstQueryMs: count.elapsedMs,
      rowCount: count.value,
      payloadBytesMs: payload.elapsedMs,
      payloadBytes: payload.value,
      afterDownloadMs,
      totalMs: download.ms + afterDownloadMs,
      seed,
    };
  } finally {
    await runner.close();
  }
}

/** The prepared-store pipeline: four files into OPFS, then a postmaster that boots on them. */
export async function runPreparedLeg(
  environment: EnvironmentInfo,
  request: PreparedStoreLegRequest,
): Promise<PreparedStoreLegResult> {
  const configuration = requireConfiguration(environment, request.configurationId);
  if (!isConfiguration(configuration)) {
    return configuration;
  }
  const download = await fetchTarball(request.tarUrl);
  const options: EngineOpenOptions = {
    ...configuration.options,
    pgrustPostmaster: {
      ...configuration.options?.pgrustPostmaster,
      seedFromTar: download.bytes,
    },
  };
  return await runLeg(configuration, options, request, download, true);
}

/** The reference pipeline: PGlite's own datadir tarball, restored through `loadDataDir`. */
export async function runPgliteDatadirLeg(
  environment: EnvironmentInfo,
  request: PreparedStoreLegRequest,
): Promise<PreparedStoreLegResult> {
  const configuration = requireConfiguration(environment, request.configurationId);
  if (!isConfiguration(configuration)) {
    return configuration;
  }
  const store = configuration.options?.pglite;
  if (store === undefined) {
    throw new Error(`${configuration.id} is not a PGlite store Configuration; it has nothing to restore into`);
  }
  const download = await fetchTarball(request.tarUrl);
  const options: EngineOpenOptions = {
    ...configuration.options,
    pglite: { ...store, loadDataDir: download.bytes },
  };
  return await runLeg(configuration, options, request, download, false);
}

/** Publish the handle. Called once from `main.tsx`, after the environment has been read. */
export function installPreparedStoreProbe(environment: EnvironmentInfo): void {
  const handle: PreparedStoreProbeHandle = {
    prepared: async (request) => await runPreparedLeg(environment, request),
    pgliteDatadir: async (request) => await runPgliteDatadirLeg(environment, request),
  };
  (globalThis as unknown as Record<string, PreparedStoreProbeHandle>)[PREPARED_STORE_PROBE_GLOBAL] = handle;
}
