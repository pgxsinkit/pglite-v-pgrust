/**
 * The headless lane: build the app, serve `dist/`, drive the page in a real browser, and capture
 * exactly the Markdown the page's "Copy as Markdown" button produces.
 *
 * Nothing is timed here. Every Measurement is still taken inside the Engine's worker by the app
 * itself; this script only presses Start and reads the table the page renders, so a headless result
 * and a hand-run result are the same result.
 *
 * The page is driven through Playwright's library API (no Playwright test runner: `bun test` is the
 * only runner in this repo), and progress is detected from the DOM — the Suite section publishes
 * `data-state="complete"` — rather than from a sleep.
 *
 * Usage:
 *   bun run bench                                  # all three Suites, Chromium, fresh build
 *   bun run bench --suite rtt --iterations 5       # a short, explicitly non-standard RTT Run
 *   bun run bench --browser firefox --no-build     # reuse the existing dist/
 *   bun run bench --browser webkit                 # skips: Playwright's WebKit has no JSPI
 *   bun run bench --configurations pglite-memory,pgrust-memory --baseline pgrust-memory
 */

import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { BrowserType, LaunchOptions, Page } from "@playwright/test";
import { chromium, firefox } from "@playwright/test";
import type { Server } from "bun";

import { formatSelectionSearch, resolveConfigurationSelection } from "../src/configuration-selection";
import { BASELINE_CANDIDATE_IDS, BASELINE_CONFIGURATION_ID, CONFIGURATION_IDS } from "../src/configurations";
import { MAX_RTT_ITERATIONS, MIN_RTT_ITERATIONS, RTT_ITERATIONS_PARAM } from "../src/rtt-iterations";
import type { SuiteId } from "../src/suites/types";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The Suites the page renders, in page order. */
const ALL_SUITE_IDS: readonly SuiteId[] = ["speedtest", "rtt", "concurrency"];

export type BenchBrowser = "chromium" | "firefox" | "webkit";

const BENCH_BROWSERS: readonly BenchBrowser[] = ["chromium", "firefox", "webkit"];

/**
 * Playwright's WebKit is a build of WebKit, not Safari: it does not ship JS Promise Integration,
 * which pgrust's `--stdio-wire` session cannot run without. Launching it would only produce a
 * PGlite-only table already covered by Chromium, so the lane says so and stops.
 */
export const WEBKIT_SKIP_MESSAGE = "WebKit skipped: Playwright's WebKit build has no JSPI yet";

/**
 * Firefox has shipped JSPI on by default since 153; the pref is set anyway so an older build in the
 * Playwright cache still gets a fair chance. An unknown pref is inert.
 */
const FIREFOX_USER_PREFS: Readonly<Record<string, boolean>> = {
  "javascript.options.wasm_js_promise_integration": true,
};

const MIME_TYPES: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".data": "application/octet-stream",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
};

/**
 * Cross-origin isolation, exactly as `vite.config.ts` sets it for `dev` and `preview`.
 *
 * The lane serves `dist/` from its own Bun server, so the headers Vite sends never reach it: without
 * this pair the browser withholds `SharedArrayBuffer` and the two pgrust Threads columns report
 * themselves skipped in every headless run while the hand-run page shows numbers.
 */
const CROSS_ORIGIN_ISOLATION_HEADERS: Readonly<Record<string, string>> = {
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-embedder-policy": "require-corp",
};

export interface BenchOptions {
  readonly browser: BenchBrowser;
  /** Which Suites to run, in order. */
  readonly suites: readonly SuiteId[];
  /** A non-standard RTT iteration count, passed to the page as `?rttIterations=N`; null for 100. */
  readonly rttIterations: number | null;
  /**
   * The Configurations to run, passed to the page as `?configurations=<id,id,…>`; null runs every
   * Configuration the browser can. The page drops any of them it cannot run and says so in its own
   * export, so this narrows the run rather than asserting what will be in it.
   */
  readonly configurationIds: readonly string[] | null;
  /** The column every ratio is taken against, as `?baseline=<id>`; null leaves the page's default. */
  readonly baselineId: string | null;
  /** Whether to run `vite build` first. */
  readonly build: boolean;
  /** Port for the local static server; 0 asks the OS for a free one. */
  readonly port: number;
  readonly headless: boolean;
  /** Overall deadline for everything that happens in the browser. */
  readonly timeoutMs: number;
  readonly outputDir: string;
}

export const DEFAULT_BENCH_OPTIONS: BenchOptions = {
  browser: "chromium",
  suites: ALL_SUITE_IDS,
  rttIterations: null,
  configurationIds: null,
  baselineId: null,
  build: true,
  // Never 5580: a dev server or another session's browser may be sitting on it.
  port: 0,
  headless: true,
  // Three Suites against fourteen Configurations, five of which seed a whole data directory into a
  // cold store first. The default has to cover the run the default flags ask for.
  timeoutMs: 2_400_000,
  outputDir: resolve(REPO_ROOT, "tmp/results"),
};

export interface SuiteReport {
  readonly suiteId: SuiteId;
  /** Byte-identical to what the page's "Copy as Markdown" button writes to the clipboard. */
  readonly markdown: string;
  /**
   * The Run failures the page reported for this Suite, verbatim from its error panel; empty when
   * every Configuration completed. This is what turns a bare `failed` cell into a diagnosis.
   */
  readonly failures: string;
}

export interface BenchReport {
  readonly browser: BenchBrowser;
  /** True when the browser was never launched; `reason` says why. */
  readonly skipped: boolean;
  readonly reason: string | null;
  readonly environmentLine: string;
  readonly suites: readonly SuiteReport[];
  readonly outputPath: string | null;
  /** Anything the page logged as an error, kept because a failed column usually explains itself. */
  readonly consoleErrors: readonly string[];
}

function contentTypeFor(path: string): string {
  const dot = path.lastIndexOf(".");
  const extension = dot === -1 ? "" : path.slice(dot).toLowerCase();
  return MIME_TYPES[extension] ?? "application/octet-stream";
}

/** No WebSocket route is registered, so the server carries no per-socket data. */
export type StaticServer = Server<undefined>;

/**
 * A static server for `dist/`, deliberately minimal: the build is already a plain static site.
 *
 * Exported for `scripts/probe-memory.ts`, which drives the same build in the same browser and must
 * serve it with the same two isolation headers — a probe that served it any other way would be
 * measuring a page the benchmark never runs on.
 */
export function serveDist(distDir: string, port: number): StaticServer {
  return Bun.serve({
    port,
    hostname: "127.0.0.1",
    development: false,
    fetch: async (request: Request): Promise<Response> => {
      const { pathname } = new URL(request.url);
      const requested = decodeURIComponent(pathname === "/" ? "/index.html" : pathname);
      const target = resolve(distDir, `.${requested}`);
      if (target !== distDir && !target.startsWith(`${distDir}/`)) {
        return new Response("Forbidden", { status: 403, headers: CROSS_ORIGIN_ISOLATION_HEADERS });
      }
      const file = Bun.file(target);
      if (!(await file.exists())) {
        return new Response("Not found", { status: 404, headers: CROSS_ORIGIN_ISOLATION_HEADERS });
      }
      return new Response(file, {
        headers: {
          "content-type": contentTypeFor(target),
          "cache-control": "no-store",
          ...CROSS_ORIGIN_ISOLATION_HEADERS,
        },
      });
    },
  });
}

/** `vite build`, shared with `scripts/probe-memory.ts` so both lanes measure the same bundle. */
export async function buildApp(): Promise<void> {
  const child = Bun.spawn({ cmd: ["bun", "run", "build"], cwd: REPO_ROOT, stdout: "inherit", stderr: "inherit" });
  const code = await child.exited;
  if (code !== 0) {
    throw new Error(`vite build failed with exit code ${code}`);
  }
}

function browserTypeFor(browser: BenchBrowser): BrowserType {
  return browser === "firefox" ? firefox : chromium;
}

function launchOptionsFor(options: BenchOptions): LaunchOptions {
  return options.browser === "firefox"
    ? { headless: options.headless, firefoxUserPrefs: FIREFOX_USER_PREFS }
    : { headless: options.headless };
}

/**
 * The page URL a run drives: every out-of-band choice as a query parameter, and nothing else.
 *
 * The Configuration selection goes through exactly the parameters the page's own checkboxes write,
 * so `--configurations`/`--baseline` and a hand-edited link are the same mechanism.
 */
function pageUrl(port: number, options: BenchOptions): string {
  const base = options.rttIterations === null ? "" : `?${RTT_ITERATIONS_PARAM}=${options.rttIterations}`;
  const search =
    options.configurationIds === null && options.baselineId === null
      ? base
      : formatSelectionSearch(base, options.configurationIds, options.baselineId);
  return `http://127.0.0.1:${port}/${search}`;
}

/** A countdown against the overall deadline, so a stuck Run fails with a clear message. */
function createDeadline(timeoutMs: number): () => number {
  const expiresAt = Date.now() + timeoutMs;
  return (): number => {
    const left = expiresAt - Date.now();
    if (left <= 0) {
      throw new Error(`Bench deadline of ${timeoutMs} ms exceeded`);
    }
    return left;
  };
}

async function readText(page: Page, testId: string, timeout: number): Promise<string> {
  const locator = page.locator(`[data-testid="${testId}"]`);
  await locator.waitFor({ state: "attached", timeout });
  const text = await locator.textContent();
  if (text === null) {
    throw new Error(`Element [data-testid="${testId}"] has no text content`);
  }
  return text;
}

/** Press Start and wait for the Suite section to publish `data-state="complete"`. */
async function runOneSuite(page: Page, suiteId: SuiteId, remaining: () => number): Promise<SuiteReport> {
  const start = page.locator(`[data-testid="start-${suiteId}"]`);
  await start.waitFor({ state: "visible", timeout: Math.min(remaining(), 60_000) });
  await start.click({ timeout: Math.min(remaining(), 60_000) });
  await page
    .locator(`[data-testid="suite-${suiteId}"][data-state="complete"]`)
    .waitFor({ state: "attached", timeout: remaining() });
  return {
    suiteId,
    markdown: await readText(page, `markdown-${suiteId}`, Math.min(remaining(), 60_000)),
    failures: (await readText(page, `error-${suiteId}`, Math.min(remaining(), 60_000))).trim(),
  };
}

function renderResultsFile(report: BenchReport, startedAt: string): string {
  const blocks: string[] = [
    "# pglite-v-pgrust benchmark run",
    [`- Browser: ${report.browser}`, `- Started: ${startedAt}`, `- Driver: bun run bench`].join("\n"),
    report.environmentLine,
    ...report.suites.map((suite) => suite.markdown.trimEnd()),
  ];
  for (const suite of report.suites) {
    if (suite.failures !== "") {
      blocks.push([`### ${suite.suiteId}: reported Run failures`, "", "```", suite.failures, "```"].join("\n"));
    }
  }
  if (report.consoleErrors.length > 0) {
    blocks.push(["### Page errors", "", "```", ...report.consoleErrors, "```"].join("\n"));
  }
  return `${blocks.join("\n\n")}\n`;
}

export async function runBench(overrides: Partial<BenchOptions> = {}): Promise<BenchReport> {
  const options: BenchOptions = { ...DEFAULT_BENCH_OPTIONS, ...overrides };

  if (options.browser === "webkit") {
    return {
      browser: options.browser,
      skipped: true,
      reason: WEBKIT_SKIP_MESSAGE,
      environmentLine: "",
      suites: [],
      outputPath: null,
      consoleErrors: [],
    };
  }

  if (options.build) {
    await buildApp();
  }

  const distDir = resolve(REPO_ROOT, "dist");
  if (!(await Bun.file(join(distDir, "index.html")).exists())) {
    throw new Error(`${join(distDir, "index.html")} is missing; run bench without --no-build`);
  }

  const startedAt = new Date().toISOString();
  const remaining = createDeadline(options.timeoutMs);
  const consoleErrors: string[] = [];
  const suites: SuiteReport[] = [];
  let environmentLine = "";

  const server = serveDist(distDir, options.port);
  try {
    const listeningPort = server.port;
    if (listeningPort === undefined) {
      throw new Error("The static server is not listening on a TCP port");
    }
    const url = pageUrl(listeningPort, options);
    console.error(`bench: serving ${distDir} at ${url}`);

    const browser = await browserTypeFor(options.browser).launch(launchOptionsFor(options));
    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      page.on("console", (message) => {
        if (message.type() === "error") {
          consoleErrors.push(message.text());
        }
      });
      page.on("pageerror", (error) => {
        consoleErrors.push(error.message);
      });

      await page.goto(url, { waitUntil: "load", timeout: Math.min(remaining(), 120_000) });
      environmentLine = (await readText(page, "environment-line", Math.min(remaining(), 60_000))).trim();
      console.error(`bench: ${environmentLine}`);

      for (const suiteId of options.suites) {
        console.error(`bench: running ${suiteId}…`);
        suites.push(await runOneSuite(page, suiteId, remaining));
      }
    } finally {
      await browser.close();
    }
  } finally {
    await server.stop(true);
  }

  await mkdir(options.outputDir, { recursive: true });
  const outputPath = resolve(options.outputDir, `${startedAt.replaceAll(":", "-")}-${options.browser}.md`);
  const report: BenchReport = {
    browser: options.browser,
    skipped: false,
    reason: null,
    environmentLine,
    suites,
    outputPath,
    consoleErrors,
  };
  await Bun.write(outputPath, renderResultsFile(report, startedAt));
  return report;
}

const USAGE = `Usage: bun run bench [options]

  --browser <chromium|firefox|webkit>  Browser to drive (default: chromium)
  --suite <speedtest|rtt|concurrency>  Run one Suite; repeatable (default: all three)
  --iterations <N>                     Non-standard RTT iterations, ${MIN_RTT_ITERATIONS}-${MAX_RTT_ITERATIONS}
  --configurations <id,id,...>         Run only these Configurations; repeatable
  --baseline <id>                      Take every ratio against this Configuration
  --no-build                           Reuse the existing dist/ instead of rebuilding
  --port <N>                           Port for the local static server (default: a free one)
  --headed                             Show the browser window
  --timeout <ms>                       Overall in-browser deadline (default: 2400000)
  --out <dir>                          Results directory (default: tmp/results)
  -h, --help                           Print this message

Configuration ids, in column order:
${CONFIGURATION_IDS.map((id) => `  ${id}`).join("\n")}`;

interface CliInvocation {
  readonly help: boolean;
  readonly options: Partial<BenchOptions>;
}

/** Split `--flag=value` into two arguments so the parser only has one shape to handle. */
function normalizeArguments(argv: readonly string[]): readonly string[] {
  const normalized: string[] = [];
  for (const argument of argv) {
    const separator = argument.startsWith("--") ? argument.indexOf("=") : -1;
    if (separator === -1) {
      normalized.push(argument);
      continue;
    }
    normalized.push(argument.slice(0, separator), argument.slice(separator + 1));
  }
  return normalized;
}

function requireValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} needs a value`);
  }
  return value;
}

function parseInteger(raw: string, flag: string, min: number, max: number): number {
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${flag} expects an integer, got "${raw}"`);
  }
  const value = Number.parseInt(raw, 10);
  if (value < min || value > max) {
    throw new Error(`${flag} expects an integer between ${min} and ${max}, got ${value}`);
  }
  return value;
}

function parseBrowser(raw: string): BenchBrowser {
  const match = BENCH_BROWSERS.find((candidate) => candidate === raw);
  if (match === undefined) {
    throw new Error(`--browser expects one of ${BENCH_BROWSERS.join(", ")}, got "${raw}"`);
  }
  return match;
}

function parseSuite(raw: string): SuiteId {
  const match = ALL_SUITE_IDS.find((candidate) => candidate === raw);
  if (match === undefined) {
    throw new Error(`--suite expects one of ${ALL_SUITE_IDS.join(", ")}, got "${raw}"`);
  }
  return match;
}

/** The ids in one `--configurations` value; repeating the flag adds to the same list. */
function parseConfigurationList(raw: string): readonly string[] {
  const ids = raw
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id !== "");
  if (ids.length === 0) {
    throw new Error(`--configurations needs at least one id; valid ids are ${CONFIGURATION_IDS.join(", ")}`);
  }
  return ids;
}

/**
 * Refuse a selection the page could only silently correct.
 *
 * The page's own resolver decides, so the CLI and the page can never disagree about what an id
 * means — the one thing it cannot know here is which Configurations this browser will be able to
 * run, so it asks as though all of them could and lets the page report what it dropped.
 */
function validateSelection(configurationIds: readonly string[] | null, baselineId: string | null): void {
  const resolved = resolveConfigurationSelection({
    allIds: CONFIGURATION_IDS,
    availableIds: CONFIGURATION_IDS,
    baselineCandidateIds: BASELINE_CANDIDATE_IDS,
    requestedIds: configurationIds,
    requestedBaselineId: baselineId,
    defaultBaselineId: BASELINE_CONFIGURATION_ID,
  });
  if (resolved.unknownIds.length > 0) {
    throw new Error(
      `--configurations does not know ${resolved.unknownIds.join(", ")}; valid ids are ${CONFIGURATION_IDS.join(", ")}`,
    );
  }
  if (resolved.rejectedBaselineId !== null) {
    const candidates = resolved.selectedIds.filter((id) => BASELINE_CANDIDATE_IDS.includes(id));
    throw new Error(
      `--baseline expects one of the selected Configurations a ratio may be taken against ` +
        `(${candidates.join(", ")}), got "${resolved.rejectedBaselineId}"`,
    );
  }
}

export function parseBenchArguments(rawArgv: readonly string[]): CliInvocation {
  const argv = normalizeArguments(rawArgv);
  const options: {
    browser?: BenchBrowser;
    suites?: readonly SuiteId[];
    rttIterations?: number;
    configurationIds?: readonly string[];
    baselineId?: string;
    build?: boolean;
    port?: number;
    headless?: boolean;
    timeoutMs?: number;
    outputDir?: string;
  } = {};
  const suites: SuiteId[] = [];
  const configurationIds: string[] = [];
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index] ?? "";
    switch (flag) {
      case "-h":
      case "--help":
        help = true;
        break;
      case "--browser":
        index += 1;
        options.browser = parseBrowser(requireValue(argv, index, flag));
        break;
      case "--suite":
        index += 1;
        suites.push(parseSuite(requireValue(argv, index, flag)));
        break;
      case "--iterations":
        index += 1;
        options.rttIterations = parseInteger(
          requireValue(argv, index, flag),
          flag,
          MIN_RTT_ITERATIONS,
          MAX_RTT_ITERATIONS,
        );
        break;
      case "--configurations":
        index += 1;
        configurationIds.push(...parseConfigurationList(requireValue(argv, index, flag)));
        break;
      case "--baseline":
        index += 1;
        options.baselineId = requireValue(argv, index, flag);
        break;
      case "--no-build":
        options.build = false;
        break;
      case "--port":
        index += 1;
        options.port = parseInteger(requireValue(argv, index, flag), flag, 0, 65_535);
        break;
      case "--headed":
        options.headless = false;
        break;
      case "--timeout":
        index += 1;
        options.timeoutMs = parseInteger(requireValue(argv, index, flag), flag, 1_000, 3_600_000);
        break;
      case "--out":
        index += 1;
        options.outputDir = resolve(REPO_ROOT, requireValue(argv, index, flag));
        break;
      default:
        throw new Error(`Unknown argument "${flag}"`);
    }
  }

  if (suites.length > 0) {
    options.suites = suites;
  }
  if (configurationIds.length > 0) {
    options.configurationIds = configurationIds;
  }
  if (!help) {
    validateSelection(options.configurationIds ?? null, options.baselineId ?? null);
  }
  return { help, options };
}

async function main(rawArgv: readonly string[]): Promise<number> {
  let invocation: CliInvocation;
  try {
    invocation = parseBenchArguments(rawArgv);
  } catch (thrown) {
    console.error(thrown instanceof Error ? thrown.message : String(thrown));
    console.error("");
    console.error(USAGE);
    return 2;
  }

  if (invocation.help) {
    console.log(USAGE);
    return 0;
  }

  const report = await runBench(invocation.options);
  if (report.skipped) {
    console.log(report.reason ?? "Skipped");
    return 0;
  }

  console.log("");
  console.log(report.environmentLine);
  for (const suite of report.suites) {
    console.log("");
    console.log(suite.markdown.trimEnd());
  }
  for (const suite of report.suites) {
    if (suite.failures !== "") {
      console.log("");
      console.log(`${suite.suiteId}: reported Run failures`);
      console.log(suite.failures);
    }
  }
  if (report.consoleErrors.length > 0) {
    console.log("");
    console.log(`Page errors (${report.consoleErrors.length}):`);
    for (const message of report.consoleErrors) {
      console.log(`  ${message}`);
    }
  }
  console.log("");
  console.log(`Results written to ${report.outputPath ?? "(nowhere)"}`);
  return 0;
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2)).catch((thrown: unknown) => {
    console.error(`bench failed: ${thrown instanceof Error ? (thrown.stack ?? thrown.message) : String(thrown)}`);
    return 1;
  });
}
