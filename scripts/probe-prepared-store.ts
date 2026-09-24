/**
 * How long after the download before the database answers — for a **prepared store** against a
 * datadir tarball.
 *
 * `bun run probe:prepared-store`
 *
 * THE QUESTION. Shipping a ready-made Postgres to a browser means shipping a data directory. The way
 * that is done today is a tarball of the directory itself, and restoring one means creating every
 * file in it through the filesystem it is being restored INTO — a per-FILE cost, paid between "the
 * bytes arrived" and "the database answered". A repacked store is not a directory: it is four files,
 * and its format lives above its port, so the SAME four files a Node host wrote can be written into
 * a browser's OPFS and opened as the same store. Four writes, whatever the datadir holds.
 *
 * The reference leg's cost therefore tracks the datadir's FILE COUNT, not its size, and this probe
 * reports both so the two can be read apart. A datadir of one big table is at the cheap end of that
 * range; a datadir of many small relations is where the tarball path becomes minutes.
 *
 * THE THREE STAGES.
 *
 *  1. **Under bun, on the file port.** A pgrust postmaster whose store is a directory on this
 *     machine. A table with a 100-byte payload column is filled until the datadir passes the target,
 *     `CHECKPOINT`, then the client closes — which is a Postgres shutdown, a shutdown checkpoint and
 *     a coordinator that syncs and closes the store. Then `prepareStoreTar` reopens those four files
 *     directly, `repack()`s the arena (the store's own compaction: an arena that grew a write at a
 *     time still holds every superseded extent), seals them and writes `<name>.repacked.tar.gz` with
 *     a manifest inside it. The same dataset is then built a second time in **PGlite memory** and
 *     dumped with `dumpDataDir()`, which is the reference artefact.
 *  2. **In a real browser**, the prepared leg: fetch the tarball off the local preview server, untar
 *     the four files into the OPFS store directory in a dedicated worker, and boot the postmaster on
 *     them with `reset: false`. Then `SELECT count(*)` — whose value must match what was written —
 *     and `SELECT sum(length(payload))`.
 *  3. **The same page**, the reference leg: PGlite's datadir tarball restored through `loadDataDir`
 *     into the `opfs-repacked` store, and the same two queries.
 *
 * READ THE DOWNLOAD COLUMN FOR WHAT IT IS. Both tarballs are fetched from a Bun static server on
 * 127.0.0.1. That number is a loopback copy, not a network, and it is reported separately for
 * exactly that reason: what the probe is about is the wall time AFTER the download.
 */

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { arch, cpus, platform, release } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import type { Page } from "@playwright/test";
import { chromium } from "@playwright/test";

import { createPgrustPglite } from "../src/client/pgrust-factory";
import { PGRUST_DATADIR } from "../src/client/pgrust-store";
import { prepareStoreTar, type PrepareStoreTarResult } from "../src/client/prepared-store";
import type {
  PreparedStoreLegRequest,
  PreparedStoreLegResult,
  PreparedStoreProbeHandle,
} from "../src/prepared-store-probe";
import { PREPARED_STORE_PROBE_GLOBAL } from "../src/prepared-store-probe";
import type { BrowserContextKind } from "./bench";
import { BROWSER_CONTEXT_DESCRIPTIONS, buildApp, openBenchContext, serveDist } from "./bench";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Where the store is built and the tarballs are staged. Repo-local and gitignored. */
const WORK_ROOT = join(REPO_ROOT, "tmp", "prepared-store");

/** Inside `dist/`, so the same static server that serves the page serves the artefacts. */
const ARTIFACT_SUBDIR = "prepared-store";
const PREPARED_TAR_NAME = "pgrust.repacked.tar.gz";
const PGLITE_TAR_NAME = "pglite-datadir.tar.gz";

/**
 * The full Chromium build, not Playwright's default headless shell — the same choice
 * `scripts/probe-memory.ts` makes, and for a related reason: this lane wants a real browser's OPFS
 * and a real browser's worker scheduling, and the two probes should not differ in their browser.
 */
const BROWSER_CHANNEL = "chromium";

const MIB = 1024 * 1024;

/** The default datadir target: the size the prepared-store question was asked about. */
const DEFAULT_TARGET_MIB = 250;

/**
 * One insert batch: about 38 MiB of datadir, which is the granularity the fill loop can steer at.
 *
 * Big enough that the per-statement cost is noise, small enough that a 250 MiB target is not
 * overshot by a hundred. The datadir starts at the packed image's ~41 MiB, so six batches clear it.
 */
const BATCH_ROWS = 100_000;

/** Ninety minutes: filling a quarter-gigabyte datadir twice, and then a browser doing it once more. */
const BROWSER_LEG_TIMEOUT_MS = 900_000;

const TABLE = "prepared_payload";

/**
 * The dataset. One 100-character payload column, and a bigint key.
 *
 * The payload is random hex rather than a constant string, because a constant one would gzip to
 * nothing and make the tarball column meaningless. Hex is not incompressible either — it is four
 * bits per character — so the gzip ratio below is an ordinary text ratio, which is the honest middle.
 */
const CREATE_SQL = `CREATE TABLE ${TABLE} (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, payload text NOT NULL);`;
const INSERT_SQL =
  `INSERT INTO ${TABLE} (payload) ` +
  `SELECT substr(md5(random()::text) || md5(random()::text) || md5(random()::text) || md5(random()::text), 1, 100) ` +
  `FROM generate_series(1, ${BATCH_ROWS});`;
const COUNT_SQL = `SELECT count(*)::text FROM ${TABLE};`;
const PAYLOAD_SQL = `SELECT sum(length(payload))::text FROM ${TABLE};`;

interface Options {
  readonly targetMib: number;
  readonly build: boolean;
  readonly headless: boolean;
  readonly port: number;
  readonly keep: boolean;
  readonly skipPglite: boolean;
  /**
   * The browser context each leg's page lives in: `persistent` (a fresh on-disk profile, as
   * `bun run bench` uses since 2026-09-24) unless `--ephemeral-context` asks for the off-the-record
   * one every earlier Run of this probe used, where OPFS lives in the browser process.
   */
  readonly contextKind: BrowserContextKind;
}

const USAGE = `Usage: bun run probe:prepared-store [options]

  --target-mib <N>  Fill the datadir to at least this many MiB (default ${DEFAULT_TARGET_MIB})
  --no-build        Reuse the existing dist/ instead of rebuilding
  --no-pglite       Skip the PGlite datadir reference leg
  --port <N>        Port for the local static server (default: a free one)
  --headed          Show the browser window
  --keep            Leave the built store directory behind
  --ephemeral-context
                    The pre-2026-09-24 off-the-record context (default: a persistent one on disk)
  -h, --help        Print this message`;

function parseOptions(argv: readonly string[]): Options | number {
  if (argv.includes("-h") || argv.includes("--help")) {
    console.log(USAGE);
    return 0;
  }
  let targetMib = DEFAULT_TARGET_MIB;
  let build = true;
  let headless = true;
  let port = 0;
  let keep = false;
  let skipPglite = false;
  let contextKind: BrowserContextKind = "persistent";
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    switch (flag) {
      case "--target-mib":
        index += 1;
        targetMib = Number.parseInt(argv[index] ?? "", 10);
        break;
      case "--no-build":
        build = false;
        break;
      case "--no-pglite":
        skipPglite = true;
        break;
      case "--headed":
        headless = false;
        break;
      case "--keep":
        keep = true;
        break;
      case "--ephemeral-context":
        contextKind = "ephemeral";
        break;
      case "--port":
        index += 1;
        port = Number.parseInt(argv[index] ?? "0", 10);
        break;
      default:
        console.error(`Unknown argument "${flag ?? ""}"`);
        console.error(USAGE);
        return 2;
    }
  }
  if (!Number.isFinite(targetMib) || targetMib <= 0) {
    console.error("--target-mib needs a positive number of MiB");
    return 2;
  }
  return { targetMib, build, headless, port, keep, skipPglite, contextKind };
}

function mib(bytes: number): string {
  return (bytes / MIB).toFixed(1);
}

function seconds(ms: number): string {
  return (ms / 1000).toFixed(2);
}

/** What stage 1 produced under bun, in the two forms stages 2 and 3 consume. */
interface BuiltDataset {
  readonly rows: string;
  readonly datadirFiles: number;
  readonly datadirBytes: number;
  readonly fillMs: number;
  readonly checkpointMs: number;
  readonly shutdownMs: number;
  readonly prepared: PrepareStoreTarResult;
  readonly pglite: { readonly bytes: number; readonly buildMs: number; readonly dumpMs: number } | null;
}

/**
 * Stage 1a: a pgrust postmaster on the file port, filled to the target, sealed into a tarball.
 *
 * The store directory is reset before the run, because a directory that still held an earlier
 * build's store would be a different store; and the client is closed BEFORE the store is sealed,
 * because `prepareStoreTar` reopens those same four files and two owners of one store is not a thing
 * the file port can prevent across processes.
 */
async function buildPreparedStore(
  storeDir: string,
  tarPath: string,
  targetBytes: number,
): Promise<Omit<BuiltDataset, "pglite">> {
  console.error(`probe-prepared-store: building a datadir in ${storeDir} …`);
  const client = await createPgrustPglite(`file://${storeDir}`, {
    backend: "file",
    durability: "relaxed",
    reset: true,
    onServerLog: () => {},
  });

  let rows = "0";
  let datadirFiles = 0;
  let datadirBytes = 0;
  let fillMs = 0;
  let checkpointMs = 0;
  let shutdownMs = 0;
  try {
    await client.exec(CREATE_SQL);
    const fillAt = performance.now();
    for (;;) {
      await client.exec(INSERT_SQL);
      // The datadir as the STORE sees it, walked over the host's own broker channel — the same
      // number the browser leg will be booting on, rather than a table size that ignores the WAL,
      // the catalogs and the free space map.
      const walked = client.store.walk(PGRUST_DATADIR);
      datadirFiles = walked.length;
      datadirBytes = walked.reduce((total, entry) => total + (entry.kind === "file" ? entry.size : 0), 0);
      console.error(
        `probe-prepared-store:   datadir ${mib(datadirBytes)} MiB in ${datadirFiles} entries ` +
          `(target ${mib(targetBytes)} MiB)`,
      );
      if (datadirBytes >= targetBytes) {
        break;
      }
    }
    fillMs = performance.now() - fillAt;

    const checkpointAt = performance.now();
    await client.exec("CHECKPOINT;");
    checkpointMs = performance.now() - checkpointAt;

    const counted = await client.query<{ count: string }>(COUNT_SQL);
    rows = counted.rows[0]?.count ?? "0";

    const walked = client.store.walk(PGRUST_DATADIR);
    datadirFiles = walked.length;
    datadirBytes = walked.reduce((total, entry) => total + (entry.kind === "file" ? entry.size : 0), 0);
  } finally {
    const shutdownAt = performance.now();
    await client.close();
    shutdownMs = performance.now() - shutdownAt;
  }
  console.error(
    `probe-prepared-store: server stopped in ${seconds(shutdownMs)} s ` +
      `(checkpointed: ${String(client.engineShutdown?.checkpointed)}); sealing the store …`,
  );

  const prepared = await prepareStoreTar({
    fileDir: storeDir,
    tarPath,
    repack: true,
    datadir: { path: PGRUST_DATADIR, files: datadirFiles, bytes: datadirBytes },
  });
  return { rows, datadirFiles, datadirBytes, fillMs, checkpointMs, shutdownMs, prepared };
}

/**
 * Stage 1b: the reference artefact — the same dataset in PGlite, dumped as a datadir tarball.
 *
 * PGlite in memory, because that is the only backend it has under bun, and `dumpDataDir("gzip")`,
 * because that is what a host shipping a PGlite datadir actually produces. The row count is matched
 * to the pgrust dataset exactly, so the two legs in the browser restore the same data.
 */
async function buildPgliteDatadir(
  tarPath: string,
  rows: number,
): Promise<{ readonly bytes: number; readonly buildMs: number; readonly dumpMs: number }> {
  console.error(`probe-prepared-store: building the same ${rows} rows in PGlite memory …`);
  const buildAt = performance.now();
  const pg = new PGlite();
  await pg.waitReady;
  try {
    await pg.exec(CREATE_SQL);
    let written = 0;
    while (written < rows) {
      const batch = Math.min(BATCH_ROWS, rows - written);
      await pg.exec(INSERT_SQL.replace(`generate_series(1, ${BATCH_ROWS})`, `generate_series(1, ${batch})`));
      written += batch;
      console.error(`probe-prepared-store:   PGlite has ${written} of ${rows} rows`);
    }
    await pg.exec("CHECKPOINT;");
    const buildMs = performance.now() - buildAt;

    const dumpAt = performance.now();
    const dump = await pg.dumpDataDir("gzip");
    const bytes = new Uint8Array(await dump.arrayBuffer());
    const dumpMs = performance.now() - dumpAt;
    mkdirSync(dirname(tarPath), { recursive: true });
    writeFileSync(tarPath, bytes);
    return { bytes: bytes.byteLength, buildMs, dumpMs };
  } finally {
    await pg.close();
  }
}

async function withDeadline<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not finish within ${ms} ms`)), ms);
  });
  deadline.catch(() => {});
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

type Leg = "prepared" | "pgliteDatadir";

async function runLeg(page: Page, leg: Leg, request: PreparedStoreLegRequest): Promise<PreparedStoreLegResult> {
  return await withDeadline(
    page.evaluate(
      async ([globalName, which, payload]) => {
        const handle = (globalThis as unknown as Record<string, PreparedStoreProbeHandle>)[globalName as string];
        if (handle === undefined) {
          throw new Error(`the page published no ${String(globalName)} handle`);
        }
        return await handle[which as Leg](payload as unknown as PreparedStoreLegRequest);
      },
      [PREPARED_STORE_PROBE_GLOBAL, leg, request] as unknown[],
    ),
    BROWSER_LEG_TIMEOUT_MS,
    `${leg}: the browser leg`,
  );
}

/**
 * One fresh browser per leg, so neither leg inherits the other's renderer, OPFS state or heap — and,
 * in a persistent context, each leg gets its own fresh profile, so neither inherits the other's
 * files either.
 */
async function inBrowser<T>(
  url: string,
  headless: boolean,
  contextKind: BrowserContextKind,
  leg: Leg,
  body: (page: Page) => Promise<T>,
): Promise<{ readonly value: T; readonly browserVersion: string }> {
  const session = await openBenchContext(
    chromium,
    { headless, channel: BROWSER_CHANNEL },
    { kind: contextKind, profileName: `probe-prepared-store-${leg}`, keepProfile: false },
  );
  const { browser, page } = session;
  try {
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(url, { waitUntil: "load", timeout: 120_000 });
    await page.locator('[data-testid="environment-line"]').waitFor({ state: "attached", timeout: 60_000 });
    const value = await body(page);
    if (pageErrors.length > 0) {
      console.error(`  page errors: ${pageErrors.join(" | ")}`);
    }
    return { value, browserVersion: browser.version() };
  } finally {
    await session.close();
  }
}

function renderFileTable(prepared: PrepareStoreTarResult): string {
  const header = "| store file | before repack | after repack |";
  const rule = "| --- | --- | --- |";
  const rows = prepared.files.map(
    (file) => `| \`${file.name}\` | ${mib(file.bytesBeforeRepack)} MiB | ${mib(file.bytesAfterRepack)} MiB |`,
  );
  const totalBefore = prepared.files.reduce((total, file) => total + file.bytesBeforeRepack, 0);
  const totalAfter = prepared.files.reduce((total, file) => total + file.bytesAfterRepack, 0);
  return [header, rule, ...rows, `| **four files** | **${mib(totalBefore)} MiB** | **${mib(totalAfter)} MiB** |`].join(
    "\n",
  );
}

function renderLegTable(legs: readonly (readonly [string, PreparedStoreLegResult])[]): string {
  const header =
    "| pipeline | artefact | download (s, loopback) | restore (s) | boot (s) | first query (s) | after download (s) | total (s) |";
  const rule = "| --- | --- | --- | --- | --- | --- | --- | --- |";
  const rows = legs.map(([name, leg]) => {
    if (!leg.available) {
      return `| ${name} | — | — | — | — | — | — | — | (skipped: ${leg.reason ?? "unavailable"})`;
    }
    return (
      `| ${name} | ${mib(leg.downloadBytes)} MiB | ${seconds(leg.downloadMs)} | ` +
      `${leg.restoreMs === null ? "—" : seconds(leg.restoreMs)} | ${seconds(leg.bootMs)} | ` +
      `${seconds(leg.firstQueryMs)} | **${seconds(leg.afterDownloadMs)}** | ${seconds(leg.totalMs)} |`
    );
  });
  return [header, rule, ...rows].join("\n");
}

/** The bun-side environment, in the shape every other results doc in this repo states it. */
function runtimeLine(): string {
  const cpu = cpus()[0]?.model ?? "unknown CPU";
  return `bun ${Bun.version} on ${platform()} ${release()} (${arch()}, ${cpu.trim()})`;
}

/** The PGlite the page and the bun leg both run, as this repo pins it. */
function pgliteVersion(): string {
  try {
    const manifest = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    return manifest.dependencies?.["@electric-sql/pglite"] ?? "unknown";
  } catch {
    return "unknown";
  }
}

function renderReport(
  dataset: BuiltDataset,
  legs: readonly (readonly [string, PreparedStoreLegResult])[],
  browserVersion: string,
  environmentLine: string,
  targetMib: number,
  contextKind: BrowserContextKind,
): string {
  const { prepared } = dataset;
  const preparedLeg = legs.find(([, leg]) => leg.seed !== null)?.[1] ?? null;
  const referenceLeg = legs.find(([, leg]) => leg.seed === null)?.[1] ?? null;
  const lines: string[] = [];

  lines.push(`- Date: ${new Date().toISOString().slice(0, 10)}`);
  lines.push(`- Runtime: ${runtimeLine()}`);
  lines.push(`- Browser: Chromium ${browserVersion} (Playwright's \`chromium\` channel, headless)`);
  lines.push(`- Browser context: ${BROWSER_CONTEXT_DESCRIPTIONS[contextKind]}`);
  lines.push(
    `- Engines: pgrust \`${prepared.manifest.pgrustAssetCommit}\` (\`PostmasterMain\` over host pipes, ` +
      `wasm32-wasip1-threads) and \`@electric-sql/pglite\` ${pgliteVersion()}, both on the ` +
      `\`opfs-repacked\` store (format version ${prepared.manifest.store.formatVersion}, limits profile ` +
      `${prepared.manifest.store.limitsProfileVersion}, ${prepared.manifest.store.extentSize}-byte extents)`,
  );
  lines.push(
    `- Driver: \`bun run probe:prepared-store --target-mib ${targetMib}` +
      `${contextKind === "ephemeral" ? " --ephemeral-context" : ""}\``,
  );
  lines.push(`- Page: ${environmentLine}`);
  lines.push("");
  lines.push("## The question");
  lines.push("");
  lines.push(
    "Shipping a ready-made Postgres to a browser means shipping a data directory, and the way that is " +
      "done today is a tarball of the directory itself — a tree of a thousand files and up, each of " +
      "which has to be created through the filesystem it is being restored INTO. A repacked store is " +
      "not a directory: " +
      "it is **four files**, and its format lives above its port, so the four files a Node host wrote " +
      "can be written into a browser's OPFS and opened as the same store. Nothing is replayed and " +
      "nothing is converted. How much of the wall time between *the bytes arrived* and *the database " +
      "answered* does that remove?",
  );
  lines.push("");
  lines.push("## Method");
  lines.push("");
  lines.push(
    "One dataset, built twice under bun, restored twice in a real browser. Both legs fetch their " +
      "artefact over HTTP from the same local static server and are timed from the moment the fetch " +
      "starts to the moment the first query answers.",
  );
  lines.push("");
  lines.push(
    `- **Prepared store.** A pgrust postmaster on the **file port** — a directory on this machine — ` +
      `fills \`${TABLE}\` until \`${PGRUST_DATADIR}\` passes ${targetMib} MiB, runs \`CHECKPOINT\`, and ` +
      "shuts down (a real Postgres shutdown, ending in its shutdown checkpoint). `prepareStoreTar` then " +
      "reopens those four files directly, `repack()`s the arena, syncs, closes, and writes " +
      "`pgrust.repacked.tar.gz` — the four files plus a `manifest.json` carrying the store's format " +
      "identity, the pgrust commit and a SHA-256 per file. In the browser a dedicated worker gunzips " +
      "it, untars it, checks every digest, writes the four files into the OPFS store directory, and " +
      "the coordinator then opens that directory with `reset: false`.",
  );
  lines.push(
    "- **PGlite datadir tarball (the reference).** The same rows built in PGlite memory under bun and " +
      'dumped with `dumpDataDir("gzip")` — an ordinary datadir tarball. In the browser it is handed to ' +
      "the `opfs-repacked` store's PGlite factory as `loadDataDir`, which untars it file by file into " +
      "the store before the database boots.",
  );
  lines.push("");
  lines.push("Both legs then run `SELECT count(*)` — whose value must equal what was written, or the leg");
  lines.push("fails — and `SELECT sum(length(payload))` over the whole payload column.");
  lines.push("");
  lines.push("## The dataset");
  lines.push("");
  lines.push(
    `\`${TABLE}\` holds **${dataset.rows}** rows of a 100-character payload column. The pgrust datadir ` +
      `(\`${PGRUST_DATADIR}\`) came to **${mib(dataset.datadirBytes)} MiB in ${dataset.datadirFiles} entries**; ` +
      `filling it took ${seconds(dataset.fillMs)} s, its \`CHECKPOINT\` ${seconds(dataset.checkpointMs)} s, and ` +
      `the server's own shutdown ${seconds(dataset.shutdownMs)} s.`,
  );
  lines.push("");
  lines.push("## Sealing the store (bun, file port)");
  lines.push("");
  lines.push(renderFileTable(prepared));
  lines.push("");
  lines.push(
    `The repack took ${seconds(prepared.repackMs)} s and the strict sync after it ${seconds(prepared.syncMs)} s; ` +
      `the arena the store reports holding afterwards is ${mib(prepared.arenaBytesAfterRepack)} MiB. The tarball is ` +
      `**${mib(prepared.tarBytes)} MiB raw** and **${mib(prepared.gzipBytes)} MiB gzipped** ` +
      `(tar ${seconds(prepared.tarMs)} s, gzip ${seconds(prepared.gzipMs)} s). ` +
      `Preparing the whole artefact took **${seconds(prepared.totalMs)} s**.`,
  );
  lines.push("");
  lines.push(
    `Store format: version ${prepared.manifest.store.formatVersion}, limits profile ` +
      `${prepared.manifest.store.limitsProfileVersion}, ${prepared.manifest.store.extentSize}-byte extents. ` +
      `pgrust asset commit \`${prepared.manifest.pgrustAssetCommit}\`.`,
  );
  if (dataset.pglite !== null) {
    lines.push("");
    lines.push(
      `The reference artefact — the same ${dataset.rows} rows built in PGlite memory and dumped with ` +
        `\`dumpDataDir("gzip")\` — is **${mib(dataset.pglite.bytes)} MiB gzipped** (build ` +
        `${seconds(dataset.pglite.buildMs)} s, dump ${seconds(dataset.pglite.dumpMs)} s).`,
    );
  }
  lines.push("");
  lines.push("## In the browser");
  lines.push("");
  lines.push(renderLegTable(legs));
  lines.push("");
  if (preparedLeg?.seed != null) {
    const seed = preparedLeg.seed;
    lines.push(
      `The prepared leg's restore breaks down as gunzip ${seconds(seed.gunzipMs)} s, untar ` +
        `${seconds(seed.untarMs)} s, verify (sha256 over all four files) ${seconds(seed.verifyMs)} s, and ` +
        `${mib(seed.bytesWritten)} MiB written into OPFS in ${seconds(seed.writeMs)} s. The reference leg has ` +
        "no restore column of its own: PGlite's `loadDataDir` happens inside the create call and there is " +
        "no honest seam to time it at, so the whole of it is that leg's boot.",
    );
    lines.push("");
  }
  lines.push(
    "The download column is a loopback copy off a Bun static server on 127.0.0.1, reported separately " +
      "because it says nothing about a real network. The column that answers the question is **after " +
      "download**.",
  );
  lines.push("");
  lines.push("## What the numbers say");
  lines.push("");
  if (preparedLeg !== null && preparedLeg.available && referenceLeg !== null && referenceLeg.available) {
    const ratio = referenceLeg.afterDownloadMs / preparedLeg.afterDownloadMs;
    lines.push(
      `The same ${mib(dataset.datadirBytes)} MiB datadir is answering queries **${seconds(preparedLeg.afterDownloadMs)} s** ` +
        `after its bytes arrive through four files, against **${seconds(referenceLeg.afterDownloadMs)} s** through the ` +
        `datadir tarball: ${ratio.toFixed(1)}x. Of the prepared leg's time, ` +
        `${seconds(preparedLeg.restoreMs ?? 0)} s is turning the tarball into a store (most of it gunzip and ` +
        `SHA-256, not I/O — the four OPFS writes themselves are ` +
        `${seconds(preparedLeg.seed?.writeMs ?? 0)} s) and ${seconds(preparedLeg.bootMs)} s is the postmaster's own ` +
        "boot, which no restore format can remove.",
    );
    lines.push("");
    lines.push(
      `**Read the reference leg's cost against the datadir's SHAPE, not just its size.** This datadir is ` +
        `${mib(dataset.datadirBytes)} MiB in **${dataset.datadirFiles} entries** — one big table and its ` +
        "index, plus the catalogs — so `loadDataDir` creates about a thousand files, not tens of " +
        "thousands. That is the cheap end of its range, and it is why the reference here is seconds " +
        "rather than the minute-plus a datadir of many small relations costs: the per-file cost is what " +
        "the tarball path pays, and this dataset does not have many files. The prepared store's cost, by " +
        "contrast, is four writes whatever the datadir holds — its restore column is a function of the " +
        "arena's SIZE alone, and the gap widens with every additional file on the other side.",
    );
  } else if (preparedLeg !== null && preparedLeg.available) {
    lines.push(
      `The prepared store answers ${seconds(preparedLeg.afterDownloadMs)} s after its bytes arrive. The ` +
        "reference leg did not run, so there is no comparison in this table.",
    );
  } else {
    lines.push("Neither leg produced a comparable number in this run.");
  }
  return lines.join("\n");
}

async function main(argv: readonly string[]): Promise<number> {
  const parsed = parseOptions(argv);
  if (typeof parsed === "number") {
    return parsed;
  }
  const options = parsed;

  if (options.build) {
    await buildApp();
  }
  const distDir = resolve(REPO_ROOT, "dist");
  if (!(await Bun.file(join(distDir, "index.html")).exists())) {
    throw new Error(`${join(distDir, "index.html")} is missing; run without --no-build`);
  }

  const storeDir = join(WORK_ROOT, "store");
  const artifactDir = join(distDir, ARTIFACT_SUBDIR);
  const preparedTar = join(artifactDir, PREPARED_TAR_NAME);
  const pgliteTar = join(artifactDir, PGLITE_TAR_NAME);
  mkdirSync(artifactDir, { recursive: true });

  const built = await buildPreparedStore(storeDir, preparedTar, options.targetMib * MIB);
  const pglite = options.skipPglite ? null : await buildPgliteDatadir(pgliteTar, Number.parseInt(built.rows, 10));
  const dataset: BuiltDataset = { ...built, pglite };
  if (!options.keep) {
    // The store's bytes now live in the tarball; the directory is a quarter of a gigabyte of scratch.
    rmSync(storeDir, { recursive: true, force: true });
  }

  const server = serveDist(distDir, options.port);
  const legs: (readonly [string, PreparedStoreLegResult])[] = [];
  let browserVersion = "";
  let environmentLine = "";
  try {
    const url = `http://127.0.0.1:${server.port ?? 0}/`;
    console.error(`probe-prepared-store: serving ${distDir} at ${url}`);

    const request = (name: string): PreparedStoreLegRequest => ({
      tarUrl: `/${ARTIFACT_SUBDIR}/${name}`,
      configurationId: "",
      countSql: COUNT_SQL,
      expectedCount: dataset.rows,
      payloadSql: PAYLOAD_SQL,
    });

    console.error("probe-prepared-store: the prepared-store leg …");
    const preparedRun = await inBrowser(url, options.headless, options.contextKind, "prepared", async (page) => {
      environmentLine = ((await page.locator('[data-testid="environment-line"]').textContent()) ?? "").trim();
      return await runLeg(page, "prepared", {
        ...request(PREPARED_TAR_NAME),
        configurationId: "pgrust-postmaster-opfs-repacked-relaxed",
      });
    });
    browserVersion = preparedRun.browserVersion;
    legs.push(["prepared store (4 files -> OPFS, pgrust postmaster)", preparedRun.value]);

    if (pglite !== null) {
      console.error("probe-prepared-store: the PGlite datadir-tarball leg …");
      const pgliteRun = await inBrowser(
        url,
        options.headless,
        options.contextKind,
        "pgliteDatadir",
        async (page) =>
          await runLeg(page, "pgliteDatadir", {
            ...request(PGLITE_TAR_NAME),
            configurationId: "pglite-opfs-repacked-relaxed",
          }),
      );
      legs.push(["PGlite datadir tarball (loadDataDir -> OPFS repacked)", pgliteRun.value]);
    }
  } finally {
    await server.stop(true);
  }

  const report = renderReport(dataset, legs, browserVersion, environmentLine, options.targetMib, options.contextKind);
  console.log("");
  console.log(report);

  const resultsPath = join(REPO_ROOT, "docs", "results", `${new Date().toISOString().slice(0, 10)}-prepared-store.md`);
  mkdirSync(dirname(resultsPath), { recursive: true });
  writeFileSync(
    resultsPath,
    "# Four files, not four thousand: a prepared store against a datadir tarball\n\n" + `${report}\n`,
    "utf8",
  );
  console.error("");
  console.error(`probe-prepared-store: wrote ${resultsPath}`);
  console.error(
    `probe-prepared-store: artefacts left in ${artifactDir} ` +
      `(${mib(statSync(preparedTar).size)} MiB prepared` +
      `${pglite === null ? "" : `, ${mib(statSync(pgliteTar).size)} MiB PGlite`})`,
  );
  return 0;
}

process.exitCode = await main(process.argv.slice(2)).catch((thrown: unknown) => {
  console.error(
    `probe-prepared-store failed: ${thrown instanceof Error ? (thrown.stack ?? thrown.message) : String(thrown)}`,
  );
  return 1;
});
