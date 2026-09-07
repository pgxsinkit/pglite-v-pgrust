/**
 * What an Engine costs a device that is not using it: CPU during a 120-second idle window.
 *
 * `bun run probe:idle-cpu`
 *
 * The Suites measure work. This measures the absence of it — a tab left open on a page with a
 * database in it, which is the state a real application spends almost all of its life in. The
 * question behind it is a phone's battery, so the numbers here are ABSOLUTE (CPU-ms per idle minute,
 * and what fraction of one core that is) rather than ratios: PGlite is a second data point, never a
 * pass mark, and the `blank` control — the same page with no Engine at all — is what says how much
 * of any row is the browser rather than the database.
 *
 * **Method.** One fresh browser per row, the full `chromium` channel rather than the headless shell
 * (`scripts/probe-memory.ts` explains why), one page, one Engine opened through the page's idle-probe
 * handle and warmed with one RTT Benchmark. Then nothing is asked of the page for 120 seconds while
 * the driver samples every 10 seconds:
 *
 *  * CDP `SystemInfo.getProcessInfo` — every process of THIS browser and its cumulative `cpuTime`.
 *    Summed across processes, the delta over the window is the row's CPU;
 *  * `/proc/<pid>/task/<tid>/status` — voluntary and involuntary context switches, summed over every
 *    thread of every one of those processes. Their delta is a WAKEUP count, at the only place that
 *    can see one from outside: a guest thread parked in `Atomics.wait` is a futex wait, and the
 *    kernel counts every wake of it. (pgrust's host could be made to count its own `poll_oneoff`
 *    returns, but only inside each thread worker, where no driver can read it without new plumbing
 *    in pgrust; the scheduler already counts the same events, for every Engine, on both platforms.)
 *  * `Target.getTargets` — how many Worker targets are alive, which is what the CPU is spread over.
 *
 * **Variants**, for the postmaster rows: `default` is the Engine as every Suite runs it; `quiet`
 * turns Postgres's periodic work down and pgrust's recheck cadence off; `background` is `default`
 * with a second tab in front, so the Engine's tab is hidden and the browser may throttle it.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { Browser, Page } from "@playwright/test";
import { chromium } from "@playwright/test";

import type {
  IdleProbeHandle,
  IdleProbeOpenRequest,
  IdleProbeOpenResult,
  IdleProbeVisibilityEvent,
} from "../src/idle-probe";
import { IDLE_PROBE_GLOBAL } from "../src/idle-probe";
import { buildApp, serveDist } from "./bench";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The full Chromium build: the same reason `probe:memory` gives, and the same browser to compare against. */
const BROWSER_CHANNEL = "chromium";

/** How long the page is left alone, and how often the OS is asked what it cost. */
const DEFAULT_IDLE_MS = 120_000;
const SAMPLE_INTERVAL_MS = 10_000;
/** Left alone before the window's first sample, so a just-booted server's startup work is outside it. */
const SETTLE_MS = 10_000;

const OPEN_TIMEOUT_MS = 300_000;
const QUERY_TIMEOUT_MS = 120_000;

/**
 * The quiet variant's GUCs: every periodic Postgres duty this server has, turned as far down as the
 * setting allows.
 *
 * `autovacuum_naptime` is in the list for completeness and does nothing here — the shared wire argv
 * already starts this server with `autovacuum=off`, so there is no launcher to nap.
 */
const QUIET_SETTINGS: readonly string[] = [
  "bgwriter_delay=10000",
  "wal_writer_delay=10000",
  "checkpoint_timeout=86400",
  "autovacuum_naptime=86400",
  // pgrust-only (GL-MEMWATCH-1): the process memory sampler's period, clamped to 100..60000 ms.
  "pgrust.memory_watchdog_interval=60000",
];

/**
 * The pgrust knob that is not a GUC: the period at which EVERY parked guest thread wakes to re-test
 * its predicate (GL-RECWAKE-1, `waiter::recheck_cadence_ms`, default 1000 ms; `<= 0` restores the
 * plain untimed park). It bounds the postmaster's park, every blocked backend's `poll`, and every
 * auxiliary process's latch wait — so it, not any GUC, is the floor on how often an idle pgrust
 * wakes up.
 */
const QUIET_ENV: Readonly<Record<string, string>> = { PGRUST_WAITER_RECHECK_MS: "0" };

interface Column {
  /** Row key, and what `--only` matches. */
  readonly id: string;
  readonly label: string;
  /** Null for the `blank` control: the page is loaded and no Engine is opened. */
  readonly configurationId: string | null;
  readonly settings?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  /** Whether a second tab is brought to the front for the idle window. */
  readonly background?: boolean;
  /**
   * Whether the page is FROZEN for the window (`Page.setWebLifecycleState`).
   *
   * Not the same thing as hidden, and the reason it is here: a headless Chromium reports every tab
   * `visible` whatever is brought to the front, so `background` cannot ask the throttling question on
   * this platform — but freezing is the state Android puts a long-backgrounded tab into, and it can
   * be asked for outright. The row is therefore "what if the OS froze this tab", measured rather
   * than assumed, and it needs a DevTools client attached for the window, which no other row has.
   */
  readonly freeze?: boolean;
}

const COLUMNS: readonly Column[] = [
  { id: "blank", label: "blank page (no Engine)", configurationId: null },
  { id: "pglite-memory", label: "PGlite Memory", configurationId: "pglite-memory" },
  {
    id: "pglite-opfs",
    label: "PGlite OPFS repacked (relaxed)",
    configurationId: "pglite-opfs-repacked-relaxed",
  },
  {
    id: "postmaster-memory",
    label: "pgrust Postmaster Memory (broker) — default GUCs",
    configurationId: "pgrust-postmaster-memory-broker",
  },
  {
    id: "postmaster-memory-quiet",
    label: "pgrust Postmaster Memory (broker) — quiet GUCs",
    configurationId: "pgrust-postmaster-memory-broker",
    settings: QUIET_SETTINGS,
    env: QUIET_ENV,
  },
  {
    id: "postmaster-memory-gucs-only",
    label: "pgrust Postmaster Memory (broker) — quiet GUCs, recheck cadence left at 1 s",
    configurationId: "pgrust-postmaster-memory-broker",
    settings: QUIET_SETTINGS,
  },
  {
    id: "postmaster-memory-background",
    label: "pgrust Postmaster Memory (broker) — default GUCs, tab hidden",
    configurationId: "pgrust-postmaster-memory-broker",
    background: true,
  },
  {
    id: "postmaster-memory-frozen",
    label: "pgrust Postmaster Memory (broker) — default GUCs, tab frozen",
    configurationId: "pgrust-postmaster-memory-broker",
    freeze: true,
  },
  {
    id: "pglite-memory-frozen",
    label: "PGlite Memory — tab frozen",
    configurationId: "pglite-memory",
    freeze: true,
  },
  {
    id: "postmaster-opfs",
    label: "pgrust Postmaster OPFS repacked (relaxed) — default GUCs",
    configurationId: "pgrust-postmaster-opfs-repacked-relaxed",
  },
  {
    id: "postmaster-opfs-quiet",
    label: "pgrust Postmaster OPFS repacked (relaxed) — quiet GUCs",
    configurationId: "pgrust-postmaster-opfs-repacked-relaxed",
    settings: QUIET_SETTINGS,
    env: QUIET_ENV,
  },
  {
    id: "postmaster-opfs-background",
    label: "pgrust Postmaster OPFS repacked (relaxed) — default GUCs, tab hidden",
    configurationId: "pgrust-postmaster-opfs-repacked-relaxed",
    background: true,
  },
];

interface ProcessInfoResponse {
  readonly processInfo: readonly { readonly type: string; readonly id: number; readonly cpuTime: number }[];
}

interface TargetsResponse {
  readonly targetInfos: readonly { readonly type: string }[];
}

/** One reading of everything outside the page. */
interface Sample {
  readonly atMs: number;
  /** Cumulative CPU seconds, by process type, as the browser reports them. */
  readonly cpuByType: Readonly<Record<string, number>>;
  readonly cpuTotal: number;
  /** Context switches summed over every thread of every process of this browser. */
  readonly ctxtSwitches: number;
  /** Threads the kernel sees, summed over the same processes. */
  readonly threads: number;
  readonly processes: number;
  readonly workerTargets: number;
}

/** Voluntary + involuntary context switches, and the thread count, for one process. */
async function processWakeups(pid: number): Promise<{ switches: number; threads: number }> {
  let switches = 0;
  let threads = 0;
  let tids: string[];
  try {
    tids = [...new Bun.Glob("*").scanSync({ cwd: `/proc/${pid}/task`, onlyFiles: false })];
  } catch {
    return { switches: 0, threads: 0 };
  }
  await Promise.all(
    tids.map(async (tid) => {
      try {
        const status = await Bun.file(`/proc/${pid}/task/${tid}/status`).text();
        const voluntary = /voluntary_ctxt_switches:\s+(\d+)/.exec(status)?.[1];
        const involuntary = /nonvoluntary_ctxt_switches:\s+(\d+)/.exec(status)?.[1];
        switches += Number(voluntary ?? 0) + Number(involuntary ?? 0);
        threads += 1;
      } catch {
        // A thread that ended between the listing and the read is one the next sample will not see.
      }
    }),
  );
  return { switches, threads };
}

async function takeSample(browser: Browser): Promise<Sample> {
  const session = await browser.newBrowserCDPSession();
  try {
    const info = (await session.send("SystemInfo.getProcessInfo" as never)) as ProcessInfoResponse;
    const targets = (await session.send("Target.getTargets" as never)) as TargetsResponse;
    const cpuByType: Record<string, number> = {};
    let cpuTotal = 0;
    for (const entry of info.processInfo) {
      cpuByType[entry.type] = (cpuByType[entry.type] ?? 0) + entry.cpuTime;
      cpuTotal += entry.cpuTime;
    }
    const wakeups = await Promise.all(info.processInfo.map(async (entry) => await processWakeups(entry.id)));
    return {
      atMs: performance.now(),
      cpuByType,
      cpuTotal,
      ctxtSwitches: wakeups.reduce((total, one) => total + one.switches, 0),
      threads: wakeups.reduce((total, one) => total + one.threads, 0),
      processes: info.processInfo.length,
      workerTargets: targets.targetInfos.filter((target) => target.type === "worker").length,
    };
  } finally {
    await session.detach().catch(() => {});
  }
}

interface ColumnReport {
  readonly column: Column;
  readonly open: IdleProbeOpenResult | null;
  readonly samples: readonly Sample[];
  /** What the page's own `visibilitychange` log says its state was across the window. */
  readonly visibility: string;
  /** The liveness query after the window: wall time across the worker boundary. */
  readonly afterMs: number | null;
  readonly note: string;
}

function delta(report: ColumnReport): {
  wallMs: number;
  cpuMs: number;
  cpuMsPerMinute: number;
  corePercent: number;
  wakeupsPerSecond: number;
  byType: Readonly<Record<string, number>>;
} {
  const first = report.samples[0];
  const last = report.samples[report.samples.length - 1];
  if (first === undefined || last === undefined || last === first) {
    return { wallMs: 0, cpuMs: 0, cpuMsPerMinute: 0, corePercent: 0, wakeupsPerSecond: 0, byType: {} };
  }
  const wallMs = last.atMs - first.atMs;
  const cpuMs = (last.cpuTotal - first.cpuTotal) * 1000;
  const byType: Record<string, number> = {};
  for (const type of new Set([...Object.keys(first.cpuByType), ...Object.keys(last.cpuByType)])) {
    byType[type] = ((last.cpuByType[type] ?? 0) - (first.cpuByType[type] ?? 0)) * 1000;
  }
  return {
    wallMs,
    cpuMs,
    cpuMsPerMinute: (cpuMs / wallMs) * 60_000,
    // One core fully busy is 1000 CPU-ms per wall second.
    corePercent: (cpuMs / wallMs) * 100,
    wakeupsPerSecond: ((last.ctxtSwitches - first.ctxtSwitches) / wallMs) * 1000,
    byType,
  };
}

/** The page's state across one window: one value when it held, `a→b` when it changed, `?` for silence. */
function visibilityOver(
  timeline: readonly IdleProbeVisibilityEvent[],
  openedAtEpochMs: number,
  closedAtEpochMs: number,
): string {
  if (timeline.length === 0) {
    return "?";
  }
  const at = (moment: number): string => {
    let state = "?";
    for (const event of timeline) {
      if (event.atMs <= moment) {
        state = event.state;
      }
    }
    return state;
  };
  const opened = at(openedAtEpochMs);
  const closed = at(closedAtEpochMs);
  return opened === closed ? opened : `${opened}→${closed}`;
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

async function openEngine(page: Page, request: IdleProbeOpenRequest): Promise<IdleProbeOpenResult> {
  const result = await withDeadline(
    page.evaluate(
      async ([globalName, payload]) =>
        await (
          (globalThis as unknown as Record<string, IdleProbeHandle>)[globalName as string] as
            | IdleProbeHandle
            | undefined
        )?.open(payload as IdleProbeOpenRequest),
      [IDLE_PROBE_GLOBAL, request] as const,
    ),
    OPEN_TIMEOUT_MS,
    `${request.configurationId}: opening the Engine`,
  );
  if (result === undefined) {
    throw new Error(`${request.configurationId}: the page published no ${IDLE_PROBE_GLOBAL} handle`);
  }
  return result;
}

async function probeOne(
  url: string,
  column: Column,
  idleMs: number,
  headless: boolean,
): Promise<{ report: ColumnReport; browserVersion: string; environmentLine: string }> {
  const browser = await chromium.launch({ headless, channel: BROWSER_CHANNEL });
  const notes: string[] = [];
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on("pageerror", (error) => notes.push(`page error: ${error.message}`));
    await page.goto(url, { waitUntil: "load", timeout: 120_000 });
    await page.locator('[data-testid="environment-line"]').waitFor({ state: "attached", timeout: 60_000 });
    const environmentLine = ((await page.locator('[data-testid="environment-line"]').textContent()) ?? "").trim();

    let open: IdleProbeOpenResult | null = null;
    if (column.configurationId !== null) {
      const request: IdleProbeOpenRequest = {
        configurationId: column.configurationId,
        ...(column.settings === undefined ? {} : { settings: column.settings }),
        ...(column.env === undefined ? {} : { env: column.env }),
      };
      open = await openEngine(page, request);
      if (!open.available) {
        notes.push(`skipped: ${open.reason ?? "unavailable"}`);
      }
    }

    if (column.background === true) {
      // A second tab, brought to the front: the Engine's page is then hidden, which is the state a
      // phone leaves it in most of the time and the state a browser is allowed to throttle.
      const front = await context.newPage();
      await front.goto("about:blank", { waitUntil: "load", timeout: 30_000 });
      await front.bringToFront();
    }

    // Frozen for the window, and resumed before the liveness query: the page's own task queues stop,
    // and whether its workers stop with them is the thing this row exists to find out.
    const lifecycle = column.freeze === true ? await page.context().newCDPSession(page) : null;
    if (lifecycle !== null) {
      await lifecycle.send("Page.enable");
      await lifecycle.send("Page.setWebLifecycleState", { state: "frozen" });
      notes.push("frozen with Page.setWebLifecycleState; a DevTools client is attached for the window");
    }

    const openedAtEpochMs = Date.now();
    // Settle first: a server that has just booted is still finishing its startup checkpoint and its
    // first buffer sweeps, and a window that began at the warm query would charge the idle row for
    // them. The clock starts once the page has been left alone for one sampling interval.
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));

    // The idle window: nothing is asked of the page, and the samples are taken from outside it.
    const samples: Sample[] = [await takeSample(browser)];
    const startedAt = performance.now();
    while (performance.now() - startedAt < idleMs) {
      const remaining = idleMs - (performance.now() - startedAt);
      await new Promise((resolve) => setTimeout(resolve, Math.min(SAMPLE_INTERVAL_MS, remaining)));
      samples.push(await takeSample(browser));
    }

    if (lifecycle !== null) {
      await lifecycle.send("Page.setWebLifecycleState", { state: "active" });
      await lifecycle.detach().catch(() => {});
    }

    const closedAtEpochMs = Date.now();
    // The page's OWN record of what it was, read once and after the fact: a `visibilityState` asked
    // for over CDP is answered by a tab that has a client attached to it, which is not the tab the
    // window measured. The listener is installed when the page loads and costs nothing while idle.
    const timeline = await page
      .evaluate(
        async (globalName) =>
          await (
            (globalThis as unknown as Record<string, IdleProbeHandle>)[globalName] as IdleProbeHandle
          ).visibility(),
        IDLE_PROBE_GLOBAL,
      )
      .catch(() => [] as IdleProbeVisibilityEvent[]);
    const visibility = visibilityOver(timeline, openedAtEpochMs, closedAtEpochMs);
    if (column.background === true && visibility !== "hidden") {
      notes.push(`the Engine's tab was ${visibility}, not hidden, for the window`);
    }

    let afterMs: number | null = null;
    if (open?.available === true) {
      const answered = await withDeadline(
        page.evaluate(
          async (globalName) =>
            await ((globalThis as unknown as Record<string, IdleProbeHandle>)[globalName] as IdleProbeHandle).query(),
          IDLE_PROBE_GLOBAL,
        ),
        QUERY_TIMEOUT_MS,
        `${column.id}: the liveness query after the idle window`,
      );
      afterMs = answered.ms;
      await page
        .evaluate(
          async (globalName) =>
            await ((globalThis as unknown as Record<string, IdleProbeHandle>)[globalName] as IdleProbeHandle).release(),
          IDLE_PROBE_GLOBAL,
        )
        .catch((error: unknown) => notes.push(`release failed: ${String(error)}`));
    }

    return {
      report: {
        column,
        open,
        samples,
        visibility,
        afterMs,
        note: notes.join("; "),
      },
      browserVersion: browser.version(),
      environmentLine,
    };
  } finally {
    await browser.close();
  }
}

function renderTable(reports: readonly ColumnReport[]): string {
  const header =
    "| Row | CPU-ms per idle minute | % of one core | wakeups/s | worker targets | threads | processes | query after idle (ms) |";
  const rule = "| --- | --- | --- | --- | --- | --- | --- | --- |";
  const rows = reports.map((report) => {
    const last = report.samples[report.samples.length - 1];
    const numbers = delta(report);
    const after = report.afterMs === null ? "—" : report.afterMs.toFixed(1);
    return (
      `| ${report.column.label} | ${numbers.cpuMsPerMinute.toFixed(0)} | ${numbers.corePercent.toFixed(2)}% | ` +
      `${numbers.wakeupsPerSecond.toFixed(0)} | ${last?.workerTargets ?? 0} | ${last?.threads ?? 0} | ` +
      `${last?.processes ?? 0} | ${after} |`
    );
  });
  return [header, rule, ...rows].join("\n");
}

function renderDetails(reports: readonly ColumnReport[]): string {
  return reports
    .map((report) => {
      const numbers = delta(report);
      const byType = Object.entries(numbers.byType)
        .filter(([, ms]) => ms !== 0)
        .sort((left, right) => right[1] - left[1])
        .map(([type, ms]) => `${type} ${ms.toFixed(0)} ms`)
        .join(", ");
      const perSample = report.samples
        .slice(1)
        .map((sample, index) => {
          const previous = report.samples[index];
          if (previous === undefined) {
            return "—";
          }
          return (
            ((sample.cpuTotal - previous.cpuTotal) * 1000) /
            ((sample.atMs - previous.atMs) / 1000) /
            1000
          ).toFixed(2);
        })
        .join(" ");
      const lines = [
        `${report.column.label}`,
        `    window ${(numbers.wallMs / 1000).toFixed(1)} s, CPU ${numbers.cpuMs.toFixed(0)} ms (${byType})`,
        `    per-sample fraction of one core: ${perSample}`,
        `    visibility ${report.visibility}${report.note === "" ? "" : `; ${report.note}`}`,
      ];
      if (report.open !== null && report.open.available) {
        lines.push(
          `    open+setup ${report.open.openMs.toFixed(0)} ms, warm "${report.open.warmBenchmark}" ` +
            `${report.open.warmMs.toFixed(2)} ms`,
        );
      }
      return lines.join("\n");
    })
    .join("\n\n");
}

const USAGE = `Usage: bun run probe:idle-cpu [options]

  --only <id>       Run one row; repeatable (default: all of them)
  --idle-ms <N>     Length of the idle window (default ${DEFAULT_IDLE_MS})
  --no-build        Reuse the existing dist/ instead of rebuilding
  --port <N>        Port for the local static server (default: a free one)
  --headed          Show the browser window
  -h, --help        Print this message

Rows: ${COLUMNS.map((column) => column.id).join(", ")}`;

async function main(argv: readonly string[]): Promise<number> {
  if (argv.includes("-h") || argv.includes("--help")) {
    console.log(USAGE);
    return 0;
  }
  const only: string[] = [];
  let build = true;
  let headless = true;
  let port = 0;
  let idleMs = DEFAULT_IDLE_MS;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    switch (flag) {
      case "--only":
        index += 1;
        only.push(argv[index] ?? "");
        break;
      case "--idle-ms":
        index += 1;
        idleMs = Number.parseInt(argv[index] ?? "0", 10);
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
  const columns = only.length === 0 ? COLUMNS : COLUMNS.filter((column) => only.includes(column.id));
  if (columns.length === 0) {
    console.error(`No row matches ${only.join(", ")}`);
    return 2;
  }

  if (build) {
    await buildApp();
  }
  const distDir = resolve(REPO_ROOT, "dist");
  if (!(await Bun.file(`${distDir}/index.html`).exists())) {
    throw new Error(`${distDir}/index.html is missing; run without --no-build`);
  }

  const server = serveDist(distDir, port);
  const reports: ColumnReport[] = [];
  let browserVersion = "";
  let environmentLine = "";
  try {
    const url = `http://127.0.0.1:${server.port ?? 0}/`;
    console.error(`probe-idle-cpu: serving ${distDir} at ${url}`);
    for (const column of columns) {
      console.error(`probe-idle-cpu: ${column.id} — ${(idleMs / 1000).toFixed(0)} s idle window…`);
      const one = await probeOne(url, column, idleMs, headless);
      reports.push(one.report);
      browserVersion = one.browserVersion;
      environmentLine = one.environmentLine;
      const numbers = delta(one.report);
      console.error(
        `probe-idle-cpu: ${column.id} — ${numbers.cpuMsPerMinute.toFixed(0)} CPU-ms/min ` +
          `(${numbers.corePercent.toFixed(2)}% of one core), ${numbers.wakeupsPerSecond.toFixed(0)} wakeups/s`,
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
  console.log("Detail:");
  console.log(renderDetails(reports));
  return 0;
}

process.exitCode = await main(process.argv.slice(2)).catch((thrown: unknown) => {
  console.error(
    `probe-idle-cpu failed: ${thrown instanceof Error ? (thrown.stack ?? thrown.message) : String(thrown)}`,
  );
  return 1;
});
