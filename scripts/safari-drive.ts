/**
 * Drive real Safari on mac001 over WebDriver, sampling the tab's WebContent RSS while a Suite runs.
 *
 * `bun run safari:drive --suite speedtest --label a-pglite-memory \
 *    --url 'https://pgxsinkit.github.io/pglite-v-pgrust/?configurations=pglite-memory'`
 *
 * **Setup — two commands, from this machine, before any Run:**
 *
 * ```sh
 * ssh mac001 'nohup safaridriver -p 4444 >/tmp/safaridriver.log 2>&1 &'   # start the driver, once
 * ssh -N -L 4444:127.0.0.1:4444 mac001                                    # the tunnel; leave it open
 * ```
 *
 * `curl -s http://127.0.0.1:4444/status` then answers `{"ready":true}`. `SAFARI_DRIVER_BASE`
 * overrides the base URL and `SAFARI_HOST` the ssh host.
 *
 * **safaridriver serves ONE session at a time**, so `POST /session` is retried on a bounded loop
 * rather than treated as fatal: another lane may be holding it. And **nobody may touch Safari while
 * a Run is in flight** — a click, a tab switch or a window drag lands in the numbers. That is not
 * politeness, it is the guard below.
 *
 * **The visibility guard.** A hidden Safari tab is throttled hard: on Safari 27.0 the same Speedtest
 * Suite costs ~6x more with the window minimised than with it on screen
 * (`docs/results/2026-09-19-safari-27-visible-window.md`). So a Run only counts with a visible page,
 * and this driver enforces it rather than trusting the operator to remember:
 *
 * - `document.visibilityState` is read after the page is ready and **before** the Start click. Not
 *   `visible` — refuse: delete the session and exit non-zero.
 * - a `visibilitychange` listener is installed before the click and read back at the end, so a page
 *   that was hidden *during* the Run is caught as well. Artefacts are still written, `valid` is
 *   `false` in `summary.json`, and the exit is non-zero.
 * - `--window minimised` minimises through WebDriver on purpose (that is how the A/B above was
 *   taken) and `--allow-hidden` permits a page that is already hidden. Both record the hidden state
 *   as intended rather than suppressing the check: `window`, `visibilityStart`, `visibilityEnd`,
 *   `visibilityChanges` and `valid` are all in `summary.json` either way.
 *
 * `caffeinate -d -u` holds the Mac's display awake for the length of the Run, because a display that
 * sleeps takes the window's visibility with it.
 *
 * **What comes out**, in `--out` (default `tmp/agents/safari/runs/<label>`): `markdown.md` (the
 * page's own export), `engine-stats.json` (each Engine's `WebAssembly.Memory.buffer.byteLength` —
 * Safari has no CDP, so a driver can only read what the page publishes), `rss.log` (the raw `ps`
 * samples) and `summary.json`. `cellsTotalMs` — the sum of column 2 of the markdown's `| Test` rows
 * — is the number to compare between Runs: the wall clock is quantised to the 5 s completion poll
 * and carries the asset fetch, the wasm compile and the store seed, none of which any Benchmark
 * measures. (On the Concurrency Suite that sum mixes ms, txn/s and p95 columns and means nothing;
 * read the cells there.)
 */

const BASE = process.env["SAFARI_DRIVER_BASE"] ?? "http://127.0.0.1:4444";
const HOST = process.env["SAFARI_HOST"] ?? "mac001";

type WindowMode = "normal" | "minimised";

interface Args {
  suite: string;
  url: string;
  label: string;
  out: string;
  window: WindowMode;
  allowHidden: boolean;
  sessionWaitMs: number;
  runTimeoutMs: number;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (name: string, fallback?: string): string => {
    const index = argv.indexOf(`--${name}`);
    if (index >= 0 && argv[index + 1] !== undefined) return argv[index + 1]!;
    if (fallback !== undefined) return fallback;
    throw new Error(`missing --${name}`);
  };
  const label = get("label");
  const windowRaw = get("window", "normal");
  const window: WindowMode =
    windowRaw === "minimised" || windowRaw === "minimized"
      ? "minimised"
      : windowRaw === "normal"
        ? "normal"
        : (() => {
            throw new Error(`--window takes 'normal' or 'minimised', not '${windowRaw}'`);
          })();
  return {
    suite: get("suite", "speedtest"),
    url: get("url"),
    label,
    out: get("out", `tmp/agents/safari/runs/${label}`),
    window,
    allowHidden: argv.includes("--allow-hidden"),
    sessionWaitMs: Number(get("session-wait-ms", String(30 * 60 * 1000))),
    runTimeoutMs: Number(get("run-timeout-ms", String(45 * 60 * 1000))),
  };
}

async function call(method: string, path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${method} ${path}: non-JSON reply ${response.status}: ${text.slice(0, 400)}`);
  }
  const value = (parsed as { value?: unknown }).value;
  if (!response.ok) {
    throw new Error(`${method} ${path}: ${response.status} ${JSON.stringify(value).slice(0, 400)}`);
  }
  return value;
}

const sleep = async (ms: number): Promise<void> => await new Promise((resolve) => setTimeout(resolve, ms));

async function acquireSession(waitMs: number): Promise<string> {
  const deadline = Date.now() + waitMs;
  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      const value = (await call("POST", "/session", {
        capabilities: { alwaysMatch: { browserName: "safari" } },
      })) as { sessionId?: string };
      const sessionId = value.sessionId;
      if (typeof sessionId !== "string") throw new Error(`no sessionId in ${JSON.stringify(value)}`);
      console.log(`[session] acquired on attempt ${attempt}: ${sessionId}`);
      return sessionId;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      console.log(`[session] attempt ${attempt} refused (${String(error).slice(0, 160)}); retrying in 15 s`);
      await sleep(15_000);
    }
  }
}

async function script<T>(session: string, source: string): Promise<T> {
  return (await call("POST", `/session/${session}/execute/sync`, { script: source, args: [] })) as T;
}

/** One `ps` sample per two seconds, straight off mac001, for as long as the Suite runs. */
function startSampler(logPath: string): { stop: () => void } {
  const remote =
    'while :; do printf "T %s\\n" "$(date +%s)"; ' +
    "ps -axo pid=,rss=,command= | grep -E 'WebKit\\.(WebContent|GPU|Networking)|MacOS/Safari' | grep -v grep; " +
    "sleep 2; done";
  const file = Bun.file(logPath).writer();
  const child = Bun.spawn(["ssh", "-o", "BatchMode=yes", HOST, remote], { stdout: "pipe", stderr: "ignore" });
  void (async () => {
    const decoder = new TextDecoder();
    // `FileSink.write` is declared as possibly-async; the sink is flushed by `end()` below either way.
    for await (const chunk of child.stdout) void file.write(decoder.decode(chunk));
    await file.end();
  })();
  return {
    stop: () => {
      child.kill();
    },
  };
}

/**
 * Hold the Mac's display awake and the machine user-active for the Run. `-t` is a backstop, not the
 * plan: the assertion is dropped by killing the ssh child in the caller's `finally`, and the timeout
 * only bounds it if that teardown never reaches the remote process.
 */
function startCaffeinate(seconds: number): { stop: () => void } {
  const child = Bun.spawn(["ssh", "-o", "BatchMode=yes", HOST, "caffeinate", "-d", "-u", "-t", String(seconds)], {
    stdout: "ignore",
    stderr: "ignore",
  });
  return {
    stop: () => {
      child.kill();
    },
  };
}

interface PeakRow {
  pid: string;
  kind: string;
  peakMb: number;
}

async function summarise(logPath: string): Promise<PeakRow[]> {
  const text = await Bun.file(logPath).text();
  const peaks = new Map<string, PeakRow>();
  for (const line of text.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (match === null) continue;
    const [, pid, rssKb, command] = match as unknown as [string, string, string, string];
    const kind = command.includes("WebKit.WebContent")
      ? "WebContent"
      : command.includes("WebKit.GPU")
        ? "GPU"
        : command.includes("WebKit.Networking")
          ? "Networking"
          : "Safari";
    const key = `${kind}:${pid}`;
    const mb = Number(rssKb) / 1024;
    const existing = peaks.get(key);
    if (existing === undefined || mb > existing.peakMb) peaks.set(key, { pid, kind, peakMb: mb });
  }
  return [...peaks.values()].sort((left, right) => right.peakMb - left.peakMb);
}

/** The sum of column 2 of the markdown's `| Test` rows — the Suite total the page itself measured. */
function cellsTotal(markdown: string): number {
  let total = 0;
  for (const line of markdown.split("\n")) {
    if (!line.trimStart().startsWith("| Test")) continue;
    const cell = Number(line.split("|")[2]);
    if (Number.isFinite(cell)) total += cell;
  }
  return total;
}

interface VisibilityChange {
  at: string;
  sinceStartMs: number;
  state: string;
}

/** Installed before the Start click; every transition is logged to a window global with a timestamp. */
const INSTALL_VISIBILITY_LISTENER = `
  (function () {
    var started = Date.now();
    window.__safariDriveVisibility = [];
    document.addEventListener('visibilitychange', function () {
      window.__safariDriveVisibility.push({
        at: new Date().toISOString(),
        sinceStartMs: Date.now() - started,
        state: document.visibilityState,
      });
    });
  })();
  return document.visibilityState;
`;

const READ_VISIBILITY = `
  return JSON.stringify({
    changes: window.__safariDriveVisibility || [],
    state: document.visibilityState,
  });
`;

const HIDDEN_REFUSAL = [
  "",
  "REFUSED: the page is not visible, and a hidden Safari tab is throttled about 6x.",
  "  Wake the Mac's display, un-minimise the Safari window, put it in front, and make sure",
  "  nobody is using Safari for anything else. Then run this again.",
  "  A deliberately hidden Run is --window minimised (minimise through WebDriver) or --allow-hidden.",
  "",
].join("\n");

async function main(): Promise<number> {
  const args = parseArgs();
  const hiddenAllowed = args.window === "minimised" || args.allowHidden;
  await Bun.$`mkdir -p ${args.out}`.quiet();
  // One run per directory: samples from an earlier one in the same file would be read as this one's.
  await Bun.$`rm -f ${args.out}/rss.log`.quiet();
  const session = await acquireSession(args.sessionWaitMs);
  const sampler = startSampler(`${args.out}/rss.log`);
  const caffeinate = startCaffeinate(Math.ceil(args.runTimeoutMs / 1000) + 300);
  const started = Date.now();
  try {
    await call("POST", `/session/${session}/url`, { url: args.url });
    for (let i = 0; ; i += 1) {
      const isolated = await script<boolean>(
        session,
        "return typeof window.crossOriginIsolated === 'boolean' && window.crossOriginIsolated === true " +
          "&& document.querySelector('[data-testid=start-" +
          args.suite +
          "]') !== null;",
      );
      if (isolated) break;
      if (i > 60) throw new Error("page never became cross-origin isolated with the Suite rendered");
      await sleep(2000);
    }
    const environment = await script<string>(
      session,
      "return (document.querySelector('[data-testid=environment-line]') || {}).textContent || '';",
    );
    console.log(`[env] ${environment.trim()}`);

    if (args.window === "minimised") {
      await call("POST", `/session/${session}/window/minimize`, {});
      // The visibilitychange this fires is the deliberate one, so it is landed before the listener
      // goes on: what the listener is for is a transition nobody asked for.
      await sleep(1500);
    }

    const visibilityStart = await script<string>(session, INSTALL_VISIBILITY_LISTENER);
    console.log(
      `[visibility] ${visibilityStart} at the click (window: ${args.window}${
        args.allowHidden ? ", --allow-hidden" : ""
      })`,
    );
    if (visibilityStart !== "visible" && !hiddenAllowed) {
      console.error(HIDDEN_REFUSAL);
      return 1;
    }

    await script(session, `document.querySelector('[data-testid=start-${args.suite}]').click(); return true;`);
    const clickedAt = Date.now();
    const deadline = clickedAt + args.runTimeoutMs;
    for (;;) {
      const state = await script<string>(
        session,
        `return document.querySelector('[data-testid=suite-${args.suite}]').getAttribute('data-state');`,
      );
      if (state === "complete") break;
      if (Date.now() > deadline) throw new Error(`Suite ${args.suite} did not complete within the timeout`);
      await sleep(5000);
    }
    const suiteMs = Date.now() - clickedAt;

    const markdown = await script<string>(
      session,
      `return document.querySelector('[data-testid=markdown-${args.suite}]').textContent;`,
    );
    const stats = await script<string>(
      session,
      `return (document.querySelector('[data-testid=engine-stats-${args.suite}]') || {}).textContent || '{}';`,
    );
    const errors = await script<string>(
      session,
      `return (document.querySelector('[data-testid=error-${args.suite}]') || {}).textContent || '';`,
    );
    const visibility = JSON.parse(await script<string>(session, READ_VISIBILITY)) as {
      changes: VisibilityChange[];
      state: string;
    };
    sampler.stop();
    await sleep(500);
    const peaks = await summarise(`${args.out}/rss.log`);

    const everHidden =
      visibilityStart !== "visible" ||
      visibility.state !== "visible" ||
      visibility.changes.some((change) => change.state !== "visible");
    const valid = hiddenAllowed || !everHidden;
    const invalidReason = valid
      ? ""
      : `the page was hidden during the Run (start ${visibilityStart}, end ${visibility.state}, ` +
        `${visibility.changes.length} transition(s)); Safari throttles a hidden tab about 6x`;
    const cellsTotalMs = cellsTotal(markdown);

    await Bun.write(`${args.out}/markdown.md`, markdown);
    await Bun.write(`${args.out}/engine-stats.json`, stats);
    await Bun.write(
      `${args.out}/summary.json`,
      `${JSON.stringify(
        {
          label: args.label,
          suite: args.suite,
          url: args.url,
          environment: environment.trim(),
          window: args.window,
          allowHidden: args.allowHidden,
          visibilityStart,
          visibilityEnd: visibility.state,
          visibilityChanges: visibility.changes,
          valid,
          invalidReason,
          cellsTotalMs,
          wallMsIncludingBoot: suiteMs,
          totalMsFromClick: Date.now() - started,
          errors: errors.trim(),
          engineStats: JSON.parse(stats) as unknown,
          peaks,
        },
        null,
        2,
      )}\n`,
    );
    console.log(`[done] ${args.label}: cells total: ${cellsTotalMs.toFixed(0)} ms`);
    console.log(`[wall] suite wall ${(suiteMs / 1000).toFixed(1)} s (quantised to the 5 s poll)`);
    console.log(`[peaks] ${peaks.map((row) => `${row.kind}/${row.pid} ${row.peakMb.toFixed(0)} MB`).join("  ")}`);
    if (errors.trim() !== "") console.log(`[errors] ${errors.trim().slice(0, 2000)}`);
    console.log(`[stats] ${stats}`);
    console.log(
      `[visibility] end ${visibility.state}, ${visibility.changes.length} transition(s)` +
        visibility.changes.map((change) => ` | ${change.at} (+${change.sinceStartMs} ms) ${change.state}`).join(""),
    );
    if (!valid) {
      console.error(`\n*** INVALID RUN — DO NOT PUBLISH THESE NUMBERS ***\n    ${invalidReason}\n`);
      return 1;
    }
    return 0;
  } finally {
    sampler.stop();
    caffeinate.stop();
    try {
      await call("DELETE", `/session/${session}`);
    } catch {
      // A session the driver already reaped is not a failure of the run.
    }
  }
}

process.exit(await main());
