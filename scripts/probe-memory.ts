/**
 * What each Engine costs in memory, on the benchmark page, in a real browser.
 *
 * `bun run probe:memory`
 *
 * The benchmark measures time and says nothing about size, and the three numbers that would answer
 * "how much memory does this Engine cost" live in three different places:
 *
 *  1. **the worker** — a `WebAssembly.Memory`'s `buffer.byteLength`, which only the agent that
 *     created it can read (`src/memory-probe.ts` asks the Engine's worker over the existing
 *     protocol);
 *  2. **the page** — `performance.measureUserAgentSpecificMemory()`, which reports the JS agent
 *     cluster, the page's workers included, and needs the cross-origin isolation this page already
 *     has;
 *  3. **the browser** — the renderer process's RSS and the live worker targets, over CDP.
 *
 * So each Configuration runs in a **fresh browser**: one page, therefore exactly one renderer, whose
 * RSS is then unambiguous. The Run is one warm pass of the RTT Suite (every Benchmark once, on an
 * Engine that has booted and run the Suite's setup) and the Engine is left open while the browser's
 * numbers are taken.
 *
 * Read the columns for what they are: the wasm memory is an ALLOCATION (pgrust's shared memory is
 * created at 256 MiB whether or not the guest touches it), the page memory is PER PAGE, and the RSS
 * is PER PROCESS — the only number that says what is resident.
 */

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { Browser, Page } from "@playwright/test";
import { chromium } from "@playwright/test";

import type { MemoryProbeHandle, MemoryProbeResult, PageMemoryReport } from "../src/memory-probe";
import { MEMORY_PROBE_GLOBAL } from "../src/memory-probe";
import { buildApp, serveDist } from "./bench";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The Configurations to compare, in table order.
 *
 * The three Memory columns are the comparison the probe exists for — the same page and the same
 * warm Run against PGlite in process, against one pgrust session on its own copy of the filesystem,
 * and against a whole pgrust postmaster. The two Storage columns follow because the store is a
 * coordinator worker with a 43 MiB arena in it, and it is worth knowing what that adds.
 */
const DEFAULT_CONFIGURATION_IDS: readonly string[] = [
  "pglite-memory",
  "pgrust-threads-memory",
  "pgrust-postmaster-memory-broker",
  "pglite-opfs-repacked-relaxed",
  "pgrust-postmaster-opfs-repacked-relaxed",
];

/** Per Configuration: boot, one warm Run, and a page-memory measurement that waits for a GC. */
const CONFIGURATION_TIMEOUT_MS = 300_000;

/**
 * The full Chromium build, not Playwright's default.
 *
 * `chromium.launch({ headless: true })` runs `chromium_headless_shell`, a stripped build in which
 * `performance.measureUserAgentSpecificMemory()` exists as a function and throws
 * `SecurityError: … is not available.` on a page that is demonstrably cross-origin isolated. The
 * `chromium` channel is the same Chromium version in new headless mode, and there the call returns.
 * `bun run bench` is left on the default shell: this is the one lane that needs the API.
 */
const BROWSER_CHANNEL = "chromium";

const MIB = 1024 * 1024;

interface ProcessInfoResponse {
  readonly processInfo: readonly { readonly type: string; readonly id: number }[];
}

interface TargetsResponse {
  readonly targetInfos: readonly { readonly type: string }[];
}

interface RendererProcess {
  readonly pid: number;
  /** Resident set size in bytes, or null when `/proc` no longer had the process. */
  readonly rssBytes: number | null;
}

/** What the browser can say about the processes the page lives in, and how many Workers are alive. */
interface BrowserSnapshot {
  /**
   * Every renderer process, not just the page's.
   *
   * Chromium keeps a **spare renderer** warm, so there are two of them and `getProcessInfo` says
   * nothing about which is which. The page's is picked by size: after the page has loaded a 10 MB
   * wasm bundle it is the larger by a wide margin (162 MiB against 67 MiB in this app), and the pid
   * chosen from the "before" snapshot is then followed into the "after" one, so the delta is the
   * same process either way. The total across renderers is reported beside it as a check.
   */
  readonly renderers: readonly RendererProcess[];
  /** Every live target of type `worker` — nested workers included, unlike `page.workers()`. */
  readonly workerTargets: number;
  /** The page's own dedicated workers, as Playwright sees them. */
  readonly pageWorkers: number;
}

/** The renderer the page is in: the biggest one. See {@link BrowserSnapshot.renderers}. */
function pageRenderer(snapshot: BrowserSnapshot): RendererProcess | undefined {
  return [...snapshot.renderers].sort((left, right) => (right.rssBytes ?? 0) - (left.rssBytes ?? 0))[0];
}

function rendererByPid(snapshot: BrowserSnapshot, pid: number | undefined): RendererProcess | undefined {
  return pid === undefined ? undefined : snapshot.renderers.find((renderer) => renderer.pid === pid);
}

function totalRendererRss(snapshot: BrowserSnapshot): number {
  return snapshot.renderers.reduce((total, renderer) => total + (renderer.rssBytes ?? 0), 0);
}

interface ConfigurationReport {
  readonly result: MemoryProbeResult;
  readonly before: BrowserSnapshot;
  /** Taken straight after the warm Run, before anything has asked the browser for a GC. */
  readonly after: BrowserSnapshot;
  readonly page: PageMemoryReport;
  /**
   * The same measurement once the Engine has been closed and its workers terminated.
   *
   * It is here to test the explanation for the blank cells: `measureUserAgentSpecificMemory()` waits
   * for a garbage collection across every agent in the cluster, and a pgrust worker parked in
   * `Atomics.wait` inside the guest can never take part in one. If the measurement returns on the
   * same page a moment after those workers are gone, that is the reason.
   */
  readonly pageAfterRelease: PageMemoryReport;
}

function mib(bytes: number | null): string {
  return bytes === null ? "—" : (bytes / MIB).toFixed(1);
}

/** VmRSS from `/proc`, which is where a Linux renderer's real footprint is written down. */
async function readRss(pid: number): Promise<number | null> {
  try {
    const status = await Bun.file(`/proc/${pid}/status`).text();
    const kb = /VmRSS:\s+(\d+) kB/.exec(status)?.[1];
    return kb === undefined ? null : Number.parseInt(kb, 10) * 1024;
  } catch {
    return null;
  }
}

async function snapshot(browser: Browser, page: Page): Promise<BrowserSnapshot> {
  const session = await browser.newBrowserCDPSession();
  try {
    // `SystemInfo.getProcessInfo` gives the OS pids and process types; RSS itself is not in CDP, and
    // `/proc/<pid>/status` is where Linux writes it down.
    const info = (await session.send("SystemInfo.getProcessInfo" as never)) as ProcessInfoResponse;
    const targets = (await session.send("Target.getTargets" as never)) as TargetsResponse;
    const renderers = await Promise.all(
      info.processInfo
        .filter((entry) => entry.type === "renderer")
        .map(async (entry) => ({ pid: entry.id, rssBytes: await readRss(entry.id) })),
    );
    return {
      renderers,
      workerTargets: targets.targetInfos.filter((target) => target.type === "worker").length,
      pageWorkers: page.workers().length,
    };
  } finally {
    await session.detach().catch(() => {});
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

async function probeOne(
  url: string,
  configurationId: string,
  headless: boolean,
): Promise<{ report: ConfigurationReport; browserVersion: string; environmentLine: string }> {
  const browser = await chromium.launch({ headless, channel: BROWSER_CHANNEL });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const consoleErrors: string[] = [];
    page.on("pageerror", (error) => consoleErrors.push(error.message));
    await page.goto(url, { waitUntil: "load", timeout: 120_000 });
    // The probe handle is published before the first render, and the environment line with it.
    await page.locator('[data-testid="environment-line"]').waitFor({ state: "attached", timeout: 60_000 });
    const environmentLine = ((await page.locator('[data-testid="environment-line"]').textContent()) ?? "").trim();

    const before = await snapshot(browser, page);
    const result = await withDeadline(
      page.evaluate(
        async ([globalName, id]) =>
          await (
            (globalThis as unknown as Record<string, MemoryProbeHandle>)[globalName as string] as
              | MemoryProbeHandle
              | undefined
          )?.run(id as string),
        [MEMORY_PROBE_GLOBAL, configurationId],
      ),
      CONFIGURATION_TIMEOUT_MS,
      `${configurationId}: the warm Run`,
    );
    if (result === undefined) {
      throw new Error(`${configurationId}: the page published no ${MEMORY_PROBE_GLOBAL} handle`);
    }
    // While the Engine is still open, and before the page measurement forces a garbage collection:
    // this ordering is the whole reason the page hands back a handle rather than a finished report.
    const after = await snapshot(browser, page);

    const pageMemory = await withDeadline(
      page.evaluate(
        async (globalName) =>
          await (
            (globalThis as unknown as Record<string, MemoryProbeHandle>)[globalName] as MemoryProbeHandle
          ).measurePage(),
        MEMORY_PROBE_GLOBAL,
      ),
      CONFIGURATION_TIMEOUT_MS,
      `${configurationId}: the page memory measurement`,
    );

    await page.evaluate(
      async (globalName) =>
        await ((globalThis as unknown as Record<string, MemoryProbeHandle>)[globalName] as MemoryProbeHandle).release(),
      MEMORY_PROBE_GLOBAL,
    );
    const pageAfterRelease = await withDeadline(
      page.evaluate(
        async (globalName) =>
          await (
            (globalThis as unknown as Record<string, MemoryProbeHandle>)[globalName] as MemoryProbeHandle
          ).measurePage(),
        MEMORY_PROBE_GLOBAL,
      ),
      CONFIGURATION_TIMEOUT_MS,
      `${configurationId}: the page memory measurement after release`,
    );
    if (consoleErrors.length > 0) {
      console.error(`  page errors: ${consoleErrors.join(" | ")}`);
    }
    return {
      report: { result, before, after, page: pageMemory, pageAfterRelease },
      browserVersion: browser.version(),
      environmentLine,
    };
  } finally {
    await browser.close();
  }
}

function renderTable(reports: readonly ConfigurationReport[]): string {
  const header =
    "| Configuration | warm Run (ms) | wasm memory (MiB) | page memory (MiB) | page renderer RSS before → after (MiB) | RSS delta (MiB) | all renderers RSS (MiB) | worker targets | page workers |";
  const rule = "| --- | --- | --- | --- | --- | --- | --- | --- | --- |";
  const rows = reports.map(({ result, before, after, page }) => {
    if (!result.available) {
      return `| ${result.label} | — | — | — | — | — | — | — | — | (skipped: ${result.reason ?? "unavailable"})`;
    }
    const wasm =
      result.wasmMemories.length === 0
        ? "—"
        : result.wasmMemories.map((memory) => `${mib(memory.bytes)} (${memory.name})`).join(", ");
    const beforeRenderer = pageRenderer(before);
    const afterRenderer = rendererByPid(after, beforeRenderer?.pid);
    const beforeBytes = beforeRenderer?.rssBytes ?? null;
    const afterBytes = afterRenderer?.rssBytes ?? null;
    const delta = beforeBytes === null || afterBytes === null ? "—" : mib(afterBytes - beforeBytes);
    return (
      `| ${result.label} | ${result.runMs.toFixed(0)} | ${wasm} | ${mib(page.memory?.bytes ?? null)} | ` +
      `${mib(beforeBytes)} → ${mib(afterBytes)} | ${delta} | ` +
      `${mib(totalRendererRss(after))} (${after.renderers.length} renderers) | ` +
      `${after.workerTargets} | ${after.pageWorkers} |`
    );
  });
  return [header, rule, ...rows].join("\n");
}

function renderBreakdowns(reports: readonly ConfigurationReport[]): string {
  const blocks: string[] = [];
  for (const { result, page, pageAfterRelease } of reports) {
    const released =
      pageAfterRelease.memory === null
        ? `    after release: still nothing (${pageAfterRelease.note})`
        : `    after release, Engine closed: ${mib(pageAfterRelease.memory.bytes)} MiB`;
    if (page.memory === null) {
      blocks.push([`${result.label}: no page memory (${page.note})`, released].join("\n"));
      continue;
    }
    const lines = page.memory.breakdown
      .slice(0, 6)
      .map(
        (entry) =>
          `    ${mib(entry.bytes).padStart(8)} MiB  ${entry.scope || "(unattributed)"}  [${entry.types.join(", ")}]`,
      );
    blocks.push([`${result.label} — ${page.note}`, ...lines, released].join("\n"));
  }
  return blocks.join("\n\n");
}

const USAGE = `Usage: bun run probe:memory [options]

  --config <id>   Probe one Configuration; repeatable (default: the five in DEFAULT_CONFIGURATION_IDS)
  --no-build      Reuse the existing dist/ instead of rebuilding
  --port <N>      Port for the local static server (default: a free one)
  --headed        Show the browser window
  -h, --help      Print this message`;

async function main(argv: readonly string[]): Promise<number> {
  if (argv.includes("-h") || argv.includes("--help")) {
    console.log(USAGE);
    return 0;
  }
  const ids: string[] = [];
  let build = true;
  let headless = true;
  let port = 0;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    switch (flag) {
      case "--config":
        index += 1;
        ids.push(argv[index] ?? "");
        break;
      case "--no-build":
        build = false;
        break;
      case "--headed":
        headless = false;
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
  const configurationIds = ids.length > 0 ? ids : DEFAULT_CONFIGURATION_IDS;

  if (build) {
    await buildApp();
  }
  const distDir = resolve(REPO_ROOT, "dist");
  if (!(await Bun.file(join(distDir, "index.html")).exists())) {
    throw new Error(`${join(distDir, "index.html")} is missing; run without --no-build`);
  }

  const server = serveDist(distDir, port);
  const reports: ConfigurationReport[] = [];
  let browserVersion = "";
  let environmentLine = "";
  try {
    const url = `http://127.0.0.1:${server.port ?? 0}/`;
    console.error(`probe-memory: serving ${distDir} at ${url}`);
    for (const configurationId of configurationIds) {
      console.error(`probe-memory: ${configurationId}…`);
      const one = await probeOne(url, configurationId, headless);
      reports.push(one.report);
      browserVersion = one.browserVersion;
      environmentLine = one.environmentLine;
      const { result } = one.report;
      console.error(
        result.available
          ? `probe-memory: ${configurationId} ran ${result.benchmarksRun} Benchmarks in ${result.runMs.toFixed(0)} ms`
          : `probe-memory: ${configurationId} skipped — ${result.reason ?? "unavailable"}`,
      );
    }
  } finally {
    await server.stop(true);
  }

  console.log("");
  console.log(`Chromium ${browserVersion}`);
  console.log(environmentLine);
  console.log("");
  console.log(renderTable(reports));
  console.log("");
  console.log("Page memory breakdown (top entries):");
  console.log(renderBreakdowns(reports));
  return 0;
}

process.exitCode = await main(process.argv.slice(2)).catch((thrown: unknown) => {
  console.error(`probe-memory failed: ${thrown instanceof Error ? (thrown.stack ?? thrown.message) : String(thrown)}`);
  return 1;
});
