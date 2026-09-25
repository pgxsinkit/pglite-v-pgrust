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
 * The page lives in a **persistent** browser context on a fresh profile: `launchPersistentContext`
 * on a user-data directory made for the Run under `tmp/bench-profiles/` (on the real disk) and
 * removed after it unless `--keep-profile` is passed. That puts OPFS in files on disk, as it is in a
 * user's own browser. Until 2026-09-24 the lane opened Playwright's `browser.newContext()` instead,
 * an off-the-record context in which Chromium keeps OPFS in memory in the browser process and every
 * access-handle call is one IPC to it — 0.2–0.4 ms a call whatever its size, a flush 3–5 µs — so
 * every OPFS number the lane published before then is a per-call bill users do not pay
 * (`docs/results/2026-09-24-store-levers.md` §3, `docs/results/2026-09-24-persistent-context.md`).
 * `--ephemeral-context` is that pre-2026-09-24 lane, kept so the old tables can be reproduced and
 * A/B'd; the results file's header says which context a Run used.
 *
 * Usage:
 *   bun run bench                                  # all three Suites, Chromium, fresh build
 *   bun run bench --suite rtt --iterations 5       # a short, explicitly non-standard RTT Run
 *   bun run bench --browser firefox --no-build     # reuse the existing dist/
 *   bun run bench --browser webkit                 # skips: Playwright's WebKit has no JSPI
 *   bun run bench --configurations pglite-memory,pgrust-memory --baseline pgrust-memory
 *   bun run bench --suite speedtest --configurations pgrust-postmaster-opfs-repacked-relaxed \
 *     --postmaster-tuning fsync=off,wal_buffers=4MB  # a non-standard pgrust Postmaster Run
 *   bun run bench --ephemeral-context              # the pre-2026-09-24 lane: OPFS in memory, one IPC per call
 *   bun run bench --keep-profile                   # leave the Run's profile in tmp/bench-profiles/
 *
 * `--postmaster-tuning` is the page's own `?postmasterTuning=` (`src/postmaster-tuning.ts`), passed
 * through verbatim: `pool:<n>`, `initial:<bytes>` and `name=value` GUCs, comma-separated. It moves
 * the pgrust Postmaster columns only, and the page's environment line and every Markdown export say
 * what was moved. An entry the page would silently drop is refused here instead, so a mistyped GUC
 * cannot produce a Run on the defaults under a tuned Run's name.
 */

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { Browser, BrowserContext, BrowserType, LaunchOptions, Page } from "@playwright/test";
import { chromium, firefox } from "@playwright/test";
import type { Server } from "bun";

import { formatSelectionSearch, resolveConfigurationSelection } from "../src/configuration-selection";
import { BASELINE_CANDIDATE_IDS, BASELINE_CONFIGURATION_ID, CONFIGURATION_IDS } from "../src/configurations";
import { parsePostmasterTuning, POSTMASTER_TUNING_PARAM } from "../src/postmaster-tuning";
import { MAX_RTT_ITERATIONS, MIN_RTT_ITERATIONS, RTT_ITERATIONS_PARAM } from "../src/rtt-iterations";
import type { SuiteId } from "../src/suites/types";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The Suites the page renders, in page order. */
const ALL_SUITE_IDS: readonly SuiteId[] = ["speedtest", "rtt", "concurrency"];

export type BenchBrowser = "chromium" | "firefox" | "webkit";

const BENCH_BROWSERS: readonly BenchBrowser[] = ["chromium", "firefox", "webkit"];

/**
 * The browser context a Run's page lives in.
 *
 * - `persistent` — the default since 2026-09-24: the browser type's own `launchPersistentContext` on
 *   a fresh user-data directory under {@link BENCH_PROFILES_DIR}, so OPFS is files on disk, as it is
 *   in a user's own profile. An access-handle call is then 12–16 µs and a flush 1.3–1.5 ms.
 * - `ephemeral` — the pre-2026-09-24 lane, `browser.newContext()`: an off-the-record context, in
 *   which Chromium keeps OPFS in memory in the browser process and every access-handle call is one
 *   IPC to it, 0.2–0.4 ms whatever its size, with a flush at 3–5 µs. Every OPFS number this lane
 *   published before 2026-09-24 was taken here; it is kept so they can be reproduced and A/B'd.
 *
 * The per-call and flush figures are timings (`docs/results/2026-09-24-store-levers.md` §3); why an
 * off-the-record context costs that, read from Chromium's source and seen on disk, is
 * `docs/results/2026-09-24-persistent-context.md` §1.
 */
export type BrowserContextKind = "persistent" | "ephemeral";

/** How the results file's header names each context kind. */
export const BROWSER_CONTEXT_DESCRIPTIONS: Readonly<Record<BrowserContextKind, string>> = {
  persistent: "persistent (a fresh profile on disk: OPFS on disk)",
  ephemeral:
    "ephemeral (--ephemeral-context: the pre-2026-09-24 lane, OPFS in memory in the browser process, one IPC per call)",
};

/**
 * Where persistent contexts' profiles are made: repo-local, gitignored, and on the real disk. Not the
 * OS temp directory, which Playwright would use for an empty `userDataDir` and which is a tmpfs on
 * the Linux box this repo's notes are measured on — a profile in RAM would put OPFS back in memory
 * by another route.
 */
export const BENCH_PROFILES_DIR = resolve(REPO_ROOT, "tmp/bench-profiles");

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
 *
 * Exported for `scripts/probe-wasm-instantiate.ts`, which serves one `.wasm` and one page from its
 * own server and needs the same pair: the module imports a SHARED memory, and a shared
 * `WebAssembly.Memory` cannot be constructed on a page that is not cross-origin isolated.
 */
export const CROSS_ORIGIN_ISOLATION_HEADERS: Readonly<Record<string, string>> = {
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
  /**
   * The pgrust Postmaster knobs, as `?postmasterTuning=<value>`; null leaves the Engine's defaults,
   * which is what every table this repo publishes was produced with.
   */
  readonly postmasterTuning: string | null;
  /**
   * The browser context the page lives in: `persistent` unless `--ephemeral-context`. See
   * {@link BrowserContextKind}.
   */
  readonly contextKind: BrowserContextKind;
  /** Leave a persistent context's profile in {@link BENCH_PROFILES_DIR} after the Run. */
  readonly keepProfile: boolean;
  /** Whether to run `vite build` first. */
  readonly build: boolean;
  /** Port for the local static server; 0 asks the OS for a free one. */
  readonly port: number;
  readonly headless: boolean;
  /**
   * The path prefix `dist/` is served under, matching the `BASE_PATH` it was built with.
   *
   * `/` for every ordinary run. `--base /pglite-v-pgrust/` drives the deployable build in the shape
   * GitHub Pages serves it, which is the only way to check that every run-time URL — the pgrust
   * assets, the host modules the threads Engines `import()`, the workers — really goes through
   * `import.meta.env.BASE_URL` rather than the site root.
   */
  readonly base: string;
  /**
   * Whether the static server sends the two cross-origin isolation headers.
   *
   * On by default, and off for `--plain`, which models a host that cannot send them — GitHub Pages.
   * There the page's own `coi-serviceworker` has to earn the isolation back, so a `--plain` run is
   * the test of that: it reloads once and then reports `cross-origin isolated yes` like any other.
   */
  readonly isolationHeaders: boolean;
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
  postmasterTuning: null,
  contextKind: "persistent",
  keepProfile: false,
  build: true,
  // Never 5580: a dev server or another session's browser may be sitting on it.
  port: 0,
  headless: true,
  base: "/",
  isolationHeaders: true,
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
  readonly contextKind: BrowserContextKind;
  /** The persistent context's profile when `--keep-profile` left it on disk; null otherwise. */
  readonly keptProfileDir: string | null;
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

export interface StaticServerOptions {
  /**
   * The path prefix the site is mounted at, matching the `BASE_PATH` the build was made with.
   * `/` by default; anything else is stripped off before a request becomes a file.
   */
  readonly base?: string;
  /**
   * Whether to send COOP + COEP. True by default. False models GitHub Pages, which cannot send
   * them at all, and leaves the page's own service worker to put them back.
   */
  readonly isolationHeaders?: boolean;
}

/** `/`, or a prefix with exactly one slash at each end. */
function normalizeBase(base: string | undefined): string {
  const trimmed = (base ?? "/").trim();
  if (trimmed === "" || trimmed === "/") {
    return "/";
  }
  const leading = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return leading.endsWith("/") ? leading : `${leading}/`;
}

/**
 * A static server for `dist/`, deliberately minimal: the build is already a plain static site.
 *
 * Exported for `scripts/probe-memory.ts`, which drives the same build in the same browser and must
 * serve it with the same two isolation headers — a probe that served it any other way would be
 * measuring a page the benchmark never runs on.
 */
export function serveDist(distDir: string, port: number, options: StaticServerOptions = {}): StaticServer {
  const base = normalizeBase(options.base);
  const isolation = options.isolationHeaders ?? true;
  const headers: Readonly<Record<string, string>> = isolation ? CROSS_ORIGIN_ISOLATION_HEADERS : {};
  return Bun.serve({
    port,
    hostname: "127.0.0.1",
    development: false,
    fetch: async (request: Request): Promise<Response> => {
      const { pathname } = new URL(request.url);
      if (!pathname.startsWith(base)) {
        return new Response(`Not found: this build is served under ${base}`, { status: 404, headers });
      }
      const withinBase = pathname.slice(base.length - 1);
      const requested = decodeURIComponent(withinBase === "/" ? "/index.html" : withinBase);
      const target = resolve(distDir, `.${requested}`);
      if (target !== distDir && !target.startsWith(`${distDir}/`)) {
        return new Response("Forbidden", { status: 403, headers });
      }
      const file = Bun.file(target);
      if (!(await file.exists())) {
        return new Response("Not found", { status: 404, headers });
      }
      return new Response(file, {
        headers: {
          "content-type": contentTypeFor(target),
          "cache-control": "no-store",
          ...headers,
        },
      });
    },
  });
}

/**
 * `vite build`, shared with `scripts/probe-memory.ts` so both lanes measure the same bundle.
 *
 * `BASE_PATH` is always set, never inherited: a lane that serves the build at `/` must not silently
 * get a build addressed at `/pglite-v-pgrust/` because that variable was exported in the shell.
 */
export async function buildApp(base: string = "/"): Promise<void> {
  const child = Bun.spawn({
    cmd: ["bun", "run", "build"],
    cwd: REPO_ROOT,
    env: { ...process.env, BASE_PATH: normalizeBase(base) },
    stdout: "inherit",
    stderr: "inherit",
  });
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

/** One launched browser, the context a Run's page lives in, and that page. */
export interface BenchContext {
  readonly kind: BrowserContextKind;
  /** The browser, for what only it can answer: `version()` and a browser-level CDP session. */
  readonly browser: Browser;
  readonly context: BrowserContext;
  /** The one page a Run drives. */
  readonly page: Page;
  /** The persistent context's profile directory; null for an ephemeral context. */
  readonly userDataDir: string | null;
  /** Close the browser, then remove the profile unless it was asked to be kept. */
  readonly close: () => Promise<void>;
}

export interface BenchContextOptions {
  readonly kind: BrowserContextKind;
  /**
   * The profile directory's name under {@link BENCH_PROFILES_DIR}, before a unique suffix: the
   * Run's id, so a kept profile can be matched to the results file it produced.
   */
  readonly profileName: string;
  readonly keepProfile: boolean;
}

/**
 * Launch a browser and open the context a Run's page lives in.
 *
 * Shared with the probes that drive the same page in the same browser (`probe-memory.ts`,
 * `probe-idle-cpu.ts`, `probe-prepared-store.ts`), so a probe's store is on the same kind of disk as
 * the benchmark's. A persistent context opens with one blank page already in it; driving that page
 * keeps the Run at one tab, as the ephemeral lane's single `newPage()` does.
 */
export async function openBenchContext(
  browserType: BrowserType,
  launchOptions: LaunchOptions,
  options: BenchContextOptions,
): Promise<BenchContext> {
  if (options.kind === "ephemeral") {
    const browser = await browserType.launch(launchOptions);
    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      return {
        kind: options.kind,
        browser,
        context,
        page,
        userDataDir: null,
        close: async (): Promise<void> => await browser.close(),
      };
    } catch (thrown) {
      await browser.close();
      throw thrown;
    }
  }

  await mkdir(BENCH_PROFILES_DIR, { recursive: true });
  // `mkdtemp`, so the directory is guaranteed fresh: a profile left by an earlier Run is never reused.
  const userDataDir = await mkdtemp(join(BENCH_PROFILES_DIR, `${options.profileName}-`));
  const removeProfile = async (): Promise<void> => {
    if (!options.keepProfile) {
      await rm(userDataDir, { recursive: true, force: true });
    }
  };
  let context: BrowserContext;
  try {
    context = await browserType.launchPersistentContext(userDataDir, launchOptions);
  } catch (thrown) {
    await removeProfile();
    throw thrown;
  }
  const close = async (): Promise<void> => {
    try {
      // Closing a persistent context closes its browser.
      await context.close();
    } finally {
      await removeProfile();
    }
  };
  try {
    const browser = context.browser();
    if (browser === null) {
      throw new Error(`${browserType.name()}: the persistent context reports no browser`);
    }
    const page = context.pages()[0] ?? (await context.newPage());
    return { kind: options.kind, browser, context, page, userDataDir, close };
  } catch (thrown) {
    await close();
    throw thrown;
  }
}

/**
 * The page URL a run drives: every out-of-band choice as a query parameter, and nothing else.
 *
 * The Configuration selection goes through exactly the parameters the page's own checkboxes write,
 * so `--configurations`/`--baseline` and a hand-edited link are the same mechanism.
 */
function pageUrl(port: number, options: BenchOptions): string {
  const params = new URLSearchParams();
  if (options.rttIterations !== null) {
    params.set(RTT_ITERATIONS_PARAM, String(options.rttIterations));
  }
  if (options.postmasterTuning !== null) {
    params.set(POSTMASTER_TUNING_PARAM, options.postmasterTuning);
  }
  const query = params.size === 0 ? "" : `?${params.toString()}`;
  const search =
    options.configurationIds === null && options.baselineId === null
      ? query
      : formatSelectionSearch(query, options.configurationIds, options.baselineId);
  return `http://127.0.0.1:${port}${normalizeBase(options.base)}${search}`;
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

/**
 * The results file: the lane's own header, the page's environment line, then every Suite's export
 * verbatim — its Warm-up line and Warm-up row included, so a file written by a Run with a Warm-up
 * can be told from an older one without it — then whatever failed.
 */
export function renderResultsFile(report: BenchReport, startedAt: string): string {
  const blocks: string[] = [
    "# pglite-v-pgrust benchmark run",
    [
      `- Browser: ${report.browser}`,
      `- Browser context: ${BROWSER_CONTEXT_DESCRIPTIONS[report.contextKind]}`,
      ...(report.keptProfileDir === null ? [] : [`- Profile kept at: ${report.keptProfileDir}`]),
      `- Started: ${startedAt}`,
      `- Driver: bun run bench`,
    ].join("\n"),
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
      contextKind: options.contextKind,
      keptProfileDir: null,
      skipped: true,
      reason: WEBKIT_SKIP_MESSAGE,
      environmentLine: "",
      suites: [],
      outputPath: null,
      consoleErrors: [],
    };
  }

  if (options.build) {
    await buildApp(options.base);
  }

  const distDir = resolve(REPO_ROOT, "dist");
  if (!(await Bun.file(join(distDir, "index.html")).exists())) {
    throw new Error(`${join(distDir, "index.html")} is missing; run bench without --no-build`);
  }

  const startedAt = new Date().toISOString();
  /** Names both the results file and the persistent context's profile directory. */
  const runId = `${startedAt.replaceAll(":", "-")}-${options.browser}`;
  const remaining = createDeadline(options.timeoutMs);
  const consoleErrors: string[] = [];
  const suites: SuiteReport[] = [];
  let environmentLine = "";
  let keptProfileDir: string | null = null;

  const server = serveDist(distDir, options.port, {
    base: options.base,
    isolationHeaders: options.isolationHeaders,
  });
  try {
    const listeningPort = server.port;
    if (listeningPort === undefined) {
      throw new Error("The static server is not listening on a TCP port");
    }
    const url = pageUrl(listeningPort, options);
    console.error(`bench: serving ${distDir} at ${url}`);

    const session = await openBenchContext(browserTypeFor(options.browser), launchOptionsFor(options), {
      kind: options.contextKind,
      profileName: runId,
      keepProfile: options.keepProfile,
    });
    console.error(
      `bench: browser context ${BROWSER_CONTEXT_DESCRIPTIONS[options.contextKind]}` +
        (session.userDataDir === null ? "" : ` at ${session.userDataDir}`),
    );
    if (options.keepProfile) {
      keptProfileDir = session.userDataDir;
    }
    try {
      const { page } = session;
      page.on("console", (message) => {
        if (message.type() === "error") {
          consoleErrors.push(message.text());
        }
      });
      page.on("pageerror", (error) => {
        consoleErrors.push(error.message);
      });

      await page.goto(url, { waitUntil: "load", timeout: Math.min(remaining(), 120_000) });
      if (!options.isolationHeaders) {
        // Without the headers the first load is not isolated: `coi-serviceworker` registers, reloads
        // the page once, and only the second load has them. Waiting for the reload here is what
        // makes a --plain run a test of that mechanism rather than a race against it —
        // `waitForFunction` re-evaluates in the document that comes back.
        console.error("bench: no isolation headers sent; waiting for the service worker's reload");
        await page.waitForFunction(() => globalThis.crossOriginIsolated, null, {
          timeout: Math.min(remaining(), 120_000),
        });
      }
      environmentLine = (await readText(page, "environment-line", Math.min(remaining(), 60_000))).trim();
      console.error(`bench: ${environmentLine}`);

      for (const suiteId of options.suites) {
        console.error(`bench: running ${suiteId}…`);
        suites.push(await runOneSuite(page, suiteId, remaining));
      }
    } finally {
      await session.close();
    }
  } finally {
    await server.stop(true);
  }

  await mkdir(options.outputDir, { recursive: true });
  const outputPath = resolve(options.outputDir, `${runId}.md`);
  const report: BenchReport = {
    browser: options.browser,
    contextKind: options.contextKind,
    keptProfileDir,
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
  --postmaster-tuning <entries>        pgrust Postmaster knobs, as the page's ?postmasterTuning=
                                       (pool:<n>, initial:<bytes>, name=value GUCs; comma-separated)
  --ephemeral-context                  The pre-2026-09-24 lane: an off-the-record context, OPFS in
                                       memory in the browser process, one IPC per call (default: a
                                       persistent context on a fresh profile in tmp/bench-profiles/)
  --keep-profile                       Leave the persistent context's profile on disk after the Run
  --no-build                           Reuse the existing dist/ instead of rebuilding
  --base <path>                        Build and serve under this path (default: /)
  --plain                              Serve without COOP/COEP, as GitHub Pages does
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
 * Refuse a tuning string the page would only partly apply.
 *
 * The page drops every entry it cannot parse and runs the rest, which is right for a hand-edited
 * link and wrong for a scripted Run: a dropped `shared_buffers=64MB` would be a Run on the defaults
 * reported under the tuned Run's name. So the CLI parses it with the page's own parser and refuses
 * any entry that did not survive.
 */
function parsePostmasterTuningArgument(raw: string, flag: string): string {
  const entries = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  if (entries.length === 0) {
    throw new Error(`${flag} needs at least one entry`);
  }
  for (const entry of entries) {
    const tuning = parsePostmasterTuning(`?${new URLSearchParams({ [POSTMASTER_TUNING_PARAM]: entry }).toString()}`);
    if (tuning.poolBase === null && tuning.initialMemoryBytes === null && tuning.settings.length === 0) {
      throw new Error(
        `${flag} entry "${entry}" is not one the page accepts (pool:<n>, initial:<bytes> or a name=value GUC)`,
      );
    }
  }
  return entries.join(",");
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
    postmasterTuning?: string;
    contextKind?: BrowserContextKind;
    keepProfile?: boolean;
    build?: boolean;
    port?: number;
    headless?: boolean;
    base?: string;
    isolationHeaders?: boolean;
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
      case "--postmaster-tuning":
        index += 1;
        options.postmasterTuning = parsePostmasterTuningArgument(requireValue(argv, index, flag), flag);
        break;
      case "--ephemeral-context":
        options.contextKind = "ephemeral";
        break;
      case "--keep-profile":
        options.keepProfile = true;
        break;
      case "--no-build":
        options.build = false;
        break;
      case "--base":
        index += 1;
        options.base = normalizeBase(requireValue(argv, index, flag));
        break;
      case "--plain":
        options.isolationHeaders = false;
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
    if (options.keepProfile === true && options.contextKind === "ephemeral") {
      throw new Error("--keep-profile keeps a persistent context's profile; an --ephemeral-context Run has none");
    }
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
  console.log(`Browser context: ${BROWSER_CONTEXT_DESCRIPTIONS[report.contextKind]}`);
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
  if (report.keptProfileDir !== null) {
    console.log("");
    console.log(`Profile kept at ${report.keptProfileDir}`);
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
