/**
 * The same idle question as `probe:idle-cpu`, asked of a phone: `bun run probe:idle-cpu-android`.
 *
 * A desktop's idle CPU is an abstraction; a phone's is a battery. So this drives a real Android
 * device over `adb`, opens the bench page in real Chrome on it, opens one Engine, and then measures
 * what the phone spends over three 120-second idle windows — foreground with the screen on, the tab
 * in the background, and the screen off — from the two places that can answer honestly:
 *
 *  * `/proc/<pid>/stat` fields 14 and 15 (utime + stime, `CLK_TCK` = 100), summed over every
 *    `com.android.chrome` process. Their delta is CPU-ms, which becomes CPU-ms per idle minute and a
 *    fraction of one core;
 *  * `dumpsys batterystats`, reset and unplugged before each window and read after it, which is
 *    Android's own estimate of what the app drew in mAh — converted here to %/hour of this phone's
 *    battery, because that is the unit the question was asked in.
 *
 * **The DevTools client is disconnected for every window.** An attached debugger keeps a renderer
 * awake and costs CPU of its own, so the page is set up over CDP, the client goes away, and the
 * windows are measured with nothing attached but `adb`. Reconnecting afterwards and timing one
 * `select 1` is also the freeze test: a tab Android has frozen answers late, or not at all.
 *
 * **What state each window really reached is read from the page, once, at the end.** The page logs
 * its own `visibilitychange` events from the moment it loads, and the driver lines that log up with
 * each window's clock — because a `document.visibilityState` asked for over CDP is answered by a tab
 * that has a client attached to it, and that tab is `visible` whatever it was doing a second earlier.
 * The lock screen is handled the same way round: a screen-on window wakes the phone, dismisses a
 * keyguard it can dismiss, waits a bounded five minutes for one it cannot, and then says so and
 * labels the window `screen on, keyguard showing` rather than calling a hidden page foreground.
 *
 * **The device is left as it was found.** Screen-off needs `stay_on_while_plugged_in = 0` and the
 * battery stats need `dumpsys battery unplug`; both are restored in a `finally` that also wakes the
 * screen, removes the adb forwards and stops the local server, whatever failed on the way.
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

const ADB = process.env["ADB_PATH"] ?? "/usr/bin/adb";
const CHROME_PACKAGE = "com.android.chrome";

/** The port the phone reaches this machine's static server on, through `adb reverse`. */
const SERVER_PORT = 4199;
/** The local end of `adb forward` to Chrome's DevTools socket. */
const DEVTOOLS_PORT = 9222;

/** Swipe up from the lower third of the screen: what dismisses a keyguard that has no PIN on it. */
const UNLOCK_SWIPE = "540 1800 540 600 200";
/** How long a locked phone is waited for before the window is labelled for the state it is really in. */
const KEYGUARD_WAIT_MS = 300_000;
/** How many times a page load is tried before the column is given up on. */
const NAVIGATION_ATTEMPTS = 3;

/** Galaxy S22 (SM-S9060). Only used to turn Android's mAh estimate into a percentage of a charge. */
const BATTERY_CAPACITY_MAH = 4500;

/** Linux `USER_HZ`: every Android kernel this runs on reports `/proc` times in 10 ms ticks. */
const CLOCK_TICK_MS = 10;

const DEFAULT_IDLE_MS = 120_000;
const SAMPLE_INTERVAL_MS = 10_000;
/** Left alone before a window's first sample, so the state change that opened it is outside it. */
const SETTLE_MS = 10_000;

const OPEN_TIMEOUT_MS = 600_000;
const QUERY_TIMEOUT_MS = 180_000;
const DEVTOOLS_TIMEOUT_MS = 60_000;

/** The quiet variant, and why each entry is in it: see `scripts/probe-idle-cpu.ts`. */
const QUIET_SETTINGS: readonly string[] = [
  "bgwriter_delay=10000",
  "wal_writer_delay=10000",
  "checkpoint_timeout=86400",
  "autovacuum_naptime=86400",
  "pgrust.memory_watchdog_interval=60000",
];
const QUIET_ENV: Readonly<Record<string, string>> = { PGRUST_WAITER_RECHECK_MS: "0" };

interface Column {
  readonly id: string;
  readonly label: string;
  readonly configurationId: string | null;
  readonly settings?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}

const COLUMNS: readonly Column[] = [
  { id: "blank", label: "blank page (no Engine)", configurationId: null },
  { id: "pglite-memory", label: "PGlite Memory", configurationId: "pglite-memory" },
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
    id: "pglite-opfs",
    label: "PGlite OPFS repacked (relaxed)",
    configurationId: "pglite-opfs-repacked-relaxed",
  },
  {
    id: "postmaster-opfs",
    label: "pgrust Postmaster OPFS repacked (relaxed) — default GUCs",
    configurationId: "pgrust-postmaster-opfs-repacked-relaxed",
  },
];

/** The four Configurations the study asks for; the OPFS pair is opt-in with `--only`. */
const DEFAULT_COLUMN_IDS: readonly string[] = [
  "blank",
  "pglite-memory",
  "postmaster-memory",
  "postmaster-memory-quiet",
];

type WindowId = "foreground" | "background" | "screen-off";

const WINDOWS: readonly { id: WindowId; label: string }[] = [
  { id: "foreground", label: "foreground, screen on" },
  { id: "background", label: "background tab, screen on" },
  { id: "screen-off", label: "background tab, screen off" },
];

// ---------------------------------------------------------------------------
// adb
// ---------------------------------------------------------------------------

let deviceSerial = "";

async function adb(args: readonly string[]): Promise<string> {
  const cmd = deviceSerial === "" ? [ADB, ...args] : [ADB, "-s", deviceSerial, ...args];
  const child = Bun.spawn({ cmd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) {
    throw new Error(`adb ${args.join(" ")} failed (${code}): ${stderr.trim() || stdout.trim()}`);
  }
  return stdout;
}

async function shell(command: string): Promise<string> {
  return await adb(["shell", command]);
}

/** Best effort: cleanup must not fail on a device that has already gone away. */
async function tryShell(command: string): Promise<void> {
  await shell(command).catch(() => "");
}

async function firstDevice(): Promise<string> {
  const listing = await adb(["devices"]);
  const serials = listing
    .split("\n")
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts[1] === "device")
    .map((parts) => parts[0] ?? "");
  const serial = serials[0];
  if (serial === undefined || serial === "") {
    throw new Error("adb lists no device in state `device`");
  }
  if (serials.length > 1) {
    console.error(`probe-idle-cpu-android: ${serials.length} devices attached; using ${serial}`);
  }
  return serial;
}

// ---------------------------------------------------------------------------
// What the phone can say about Chrome
// ---------------------------------------------------------------------------

interface Sample {
  readonly atMs: number;
  /** utime + stime over every Chrome process, in milliseconds. */
  readonly cpuMs: number;
  readonly processes: number;
  /** Voluntary + involuntary context switches over every thread of those processes, or null. */
  readonly ctxtSwitches: number | null;
}

async function chromePids(): Promise<number[]> {
  const listing = await shell(`ps -A -o PID,NAME | grep ${CHROME_PACKAGE} || true`);
  return listing
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => Number.parseInt(line.split(/\s+/)[0] ?? "", 10))
    .filter((pid) => Number.isFinite(pid));
}

/**
 * utime + stime of one `/proc/<pid>/stat` line.
 *
 * Fields are counted from the end of the process name, which is parenthesised and may itself contain
 * spaces: after the last `)` the first field is `state`, so `utime` and `stime` — 14 and 15 overall —
 * are offsets 11 and 12 there.
 */
function statCpuMs(line: string): number {
  const close = line.lastIndexOf(")");
  if (close < 0) {
    return 0;
  }
  const fields = line
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  const utime = Number.parseInt(fields[11] ?? "", 10);
  const stime = Number.parseInt(fields[12] ?? "", 10);
  if (!Number.isFinite(utime) || !Number.isFinite(stime)) {
    return 0;
  }
  return (utime + stime) * CLOCK_TICK_MS;
}

async function takeSample(withWakeups: boolean): Promise<Sample> {
  const pids = await chromePids();
  if (pids.length === 0) {
    return { atMs: performance.now(), cpuMs: 0, processes: 0, ctxtSwitches: null };
  }
  const stats = await shell(`cat ${pids.map((pid) => `/proc/${pid}/stat`).join(" ")} 2>/dev/null || true`);
  const cpuMs = stats
    .split("\n")
    .filter((line) => line.trim() !== "")
    .reduce((total, line) => total + statCpuMs(line), 0);
  let ctxtSwitches: number | null = null;
  if (withWakeups) {
    // One call, the glob expanded on the device: a round trip per thread would cost more than the
    // thing being measured.
    const status = await shell(
      `cat ${pids.map((pid) => `/proc/${pid}/task/*/status`).join(" ")} 2>/dev/null | grep ctxt_switches || true`,
    );
    const counts = [...status.matchAll(/ctxt_switches:\s+(\d+)/g)].map((match) => Number(match[1]));
    ctxtSwitches = counts.length === 0 ? null : counts.reduce((total, one) => total + one, 0);
  }
  return { atMs: performance.now(), cpuMs, processes: pids.length, ctxtSwitches };
}

/**
 * Chrome's battery-stats label, `u0a<appId>`, from its uid.
 *
 * `dumpsys batterystats <package>` still prints every uid on the device; the app's own row is the one
 * with this label, and picking it by name is the difference between Chrome's drain and the phone's.
 */
async function chromeUidLabel(): Promise<string> {
  const listing = await shell(`pm list packages -U ${CHROME_PACKAGE}`).catch(() => "");
  const uid = Number.parseInt(/uid:(\d+)/.exec(listing)?.[1] ?? "", 10);
  if (!Number.isFinite(uid) || uid < 10_000) {
    return "";
  }
  return `u0a${uid - 10_000}`;
}

/**
 * Android's own estimate of what Chrome drew since the last reset, in mAh.
 *
 * Two numbers, because the total is not the one the question is about: when Chrome is the foreground
 * app Android charges the **display** to it (`screen=0.87` against `cpu=0.05` in a 20-second window),
 * which is a fact about the phone being looked at rather than about the database in the tab. `cpu` is
 * what an Engine moves; `total` is reported beside it so nothing is hidden.
 */
async function batteryMah(uidLabel: string): Promise<{ mah: number | null; cpuMah: number | null; raw: string }> {
  const dump = await shell(`dumpsys batterystats ${CHROME_PACKAGE} | grep -A 1 "UID ${uidLabel}:"`).catch(() => "");
  const raw = dump.trim();
  const mah = Number.parseFloat(new RegExp(`UID ${uidLabel}:\\s+([\\d.]+)`).exec(raw)?.[1] ?? "");
  const cpuMah = Number.parseFloat(/\bcpu=([\d.]+)/.exec(raw)?.[1] ?? "");
  return {
    mah: Number.isFinite(mah) ? mah : null,
    cpuMah: Number.isFinite(cpuMah) ? cpuMah : null,
    raw: raw.replace(/\s+/g, " ").trim(),
  };
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

async function waitForDevtools(): Promise<string> {
  const deadline = Date.now() + DEVTOOLS_TIMEOUT_MS;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${DEVTOOLS_PORT}/json/version`);
      if (response.ok) {
        const body = (await response.json()) as { Browser?: string };
        return body.Browser ?? "unknown";
      }
      lastError = `HTTP ${response.status}`;
    } catch (error: unknown) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Chrome's DevTools socket never answered on 127.0.0.1:${DEVTOOLS_PORT} (${lastError})`);
}

async function connect(): Promise<Browser> {
  return await chromium.connectOverCDP(`http://127.0.0.1:${DEVTOOLS_PORT}`);
}

/** The bench page among whatever tabs Chrome has open. */
function benchPage(browser: Browser, url: string): Page | undefined {
  for (const context of browser.contexts()) {
    for (const page of context.pages()) {
      if (page.url().startsWith(url)) {
        return page;
      }
    }
  }
  return undefined;
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
    `${request.configurationId}: opening the Engine on the phone`,
  );
  if (result === undefined) {
    throw new Error(`${request.configurationId}: the page published no ${IDLE_PROBE_GLOBAL} handle`);
  }
  return result;
}

// ---------------------------------------------------------------------------
// The measurement
// ---------------------------------------------------------------------------

interface WindowReport {
  readonly id: WindowId;
  readonly label: string;
  readonly wallMs: number;
  readonly cpuMs: number;
  readonly cpuMsPerMinute: number;
  readonly corePercent: number;
  readonly wakeupsPerSecond: number | null;
  readonly mah: number | null;
  /** The CPU component of that estimate: the part an Engine, rather than the display, is responsible for. */
  readonly cpuMah: number | null;
  /** What `dumpsys batterystats` said, for a reader who wants the breakdown rather than the total. */
  readonly batteryLine: string;
  readonly wakefulness: string;
  /** When the window's first and last samples were taken, on the same clock as the page's own log. */
  readonly openedAtEpochMs: number;
  readonly closedAtEpochMs: number;
  /** What the page's `visibilitychange` log says its state was across the window. */
  readonly visibility: string;
  readonly note: string;
}

interface ColumnReport {
  readonly column: Column;
  readonly open: IdleProbeOpenResult | null;
  readonly windows: readonly WindowReport[];
  /** What the DevTools socket called itself when this column connected. */
  readonly devtools: string;
  /** Reconnect to answered `select 1`, which is the freeze test. */
  readonly reconnectMs: number | null;
  readonly queryMs: number | null;
  readonly note: string;
}

/**
 * Put the phone in the state this window is about, and say what state it actually reached.
 *
 * The screen-on windows have to WAKE the phone and dismiss its keyguard: `dumpsys battery unplug`,
 * which the battery accounting needs, also takes `stay_on_while_plugged_in` out of play, so a phone
 * left alone dozes off in the middle of a window. Waking here restarts the display timeout, which is
 * five minutes against a window of a little over two.
 */
async function prepareWindow(id: WindowId): Promise<WindowState> {
  const notes: string[] = [];
  if (id === "screen-off") {
    await shell("settings put global stay_on_while_plugged_in 0");
    await shell("input keyevent KEYCODE_SLEEP");
  } else {
    await shell("input keyevent KEYCODE_WAKEUP");
    await unlock(notes);
    if (id === "foreground") {
      // Resume Chrome's existing task — a LAUNCHER intent, not a VIEW one, so the Engine's own tab
      // comes back to the front instead of a new tab being opened in front of it.
      await shell(`monkey -p ${CHROME_PACKAGE} -c android.intent.category.LAUNCHER 1`);
    } else {
      // A second tab in front of the Engine's, which is what a phone does the moment anything else
      // is looked at.
      await shell(`am start -a android.intent.action.VIEW -d about:blank -p ${CHROME_PACKAGE}`);
    }
  }
  const power = (await shell("dumpsys power | grep -m1 mWakefulness=").catch(() => "")).trim();
  const asleep = /Asleep|Dozing/.test(power);
  if (id === "screen-off" && !asleep) {
    notes.push(`the screen did not sleep (${power})`);
  }
  if (id !== "screen-off" && asleep) {
    notes.push(`the screen did not stay on (${power})`);
  }
  const keyguard = id === "screen-off" ? true : await keyguardShowing();
  if (id !== "screen-off") {
    const focus = (await shell("dumpsys window | grep -m1 mCurrentFocus").catch(() => "")).trim();
    if (!focus.includes(CHROME_PACKAGE)) {
      notes.push(`the window in front is not Chrome (${focus.replace(/\s+/g, " ")})`);
    }
  }
  return { asleep, keyguard, notes };
}

/** What `prepareWindow` actually reached, which is what the row is allowed to claim. */
interface WindowState {
  readonly asleep: boolean;
  /** True when the lock screen is over the page — a hidden page, whatever the intent was. */
  readonly keyguard: boolean;
  readonly notes: readonly string[];
}

/** Whether the lock screen is over whatever is running. */
async function keyguardShowing(): Promise<boolean> {
  const dump = await shell('dumpsys window policy | grep -m1 "showing="').catch(() => "");
  return /showing=true/.test(dump);
}

/**
 * Get the lock screen out of the way, or say that it could not be.
 *
 * A swipe clears a keyguard with no credential on it, and `wm dismiss-keyguard` asks the system to do
 * the same. Neither can clear a PIN, pattern or biometric lock — nothing over adb can — so the last
 * resort is to WAIT for a human, in ten-second laps, and then to carry on and label the window for
 * what it really is. A page behind the lock screen is hidden, and a row that called that "foreground"
 * would be measuring something else.
 */
async function unlock(notes: string[]): Promise<void> {
  if (!(await keyguardShowing())) {
    return;
  }
  await tryShell("wm dismiss-keyguard");
  await tryShell(`input swipe ${UNLOCK_SWIPE}`);
  if (!(await keyguardShowing())) {
    return;
  }
  console.error(
    `probe-idle-cpu-android: the phone's lock screen is up and adb cannot clear it — waiting up to ` +
      `${KEYGUARD_WAIT_MS / 1000} s for it to be unlocked, then carrying on with the window labelled ` +
      '"screen on, keyguard showing"',
  );
  const deadline = Date.now() + KEYGUARD_WAIT_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10_000));
    if (!(await keyguardShowing())) {
      return;
    }
  }
  notes.push("the lock screen stayed up: the page was behind the keyguard, not in front of it");
}

async function runWindow(
  id: WindowId,
  label: string,
  idleMs: number,
  wakeups: boolean,
  uidLabel: string,
  notes: readonly string[],
): Promise<WindowReport> {
  await shell("dumpsys batterystats --reset").catch(() => "");
  await shell("dumpsys battery unplug").catch(() => "");
  await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));

  const openedAtEpochMs = Date.now();
  const samples: Sample[] = [await takeSample(wakeups)];
  const startedAt = performance.now();
  while (performance.now() - startedAt < idleMs) {
    const remaining = idleMs - (performance.now() - startedAt);
    await new Promise((resolve) => setTimeout(resolve, Math.min(SAMPLE_INTERVAL_MS, remaining)));
    samples.push(await takeSample(wakeups));
  }
  const battery = await batteryMah(uidLabel);
  const wakefulness = (await shell("dumpsys power | grep mWakefulness=").catch(() => "")).trim().split("\n")[0] ?? "";

  const first = samples[0];
  const last = samples[samples.length - 1];
  if (first === undefined || last === undefined) {
    throw new Error(`${id}: no samples`);
  }
  const wallMs = last.atMs - first.atMs;
  const cpuMs = last.cpuMs - first.cpuMs;
  const switches =
    first.ctxtSwitches === null || last.ctxtSwitches === null ? null : last.ctxtSwitches - first.ctxtSwitches;
  return {
    id,
    label,
    wallMs,
    cpuMs,
    cpuMsPerMinute: (cpuMs / wallMs) * 60_000,
    corePercent: (cpuMs / wallMs) * 100,
    wakeupsPerSecond: switches === null ? null : (switches / wallMs) * 1000,
    mah: battery.mah,
    cpuMah: battery.cpuMah,
    batteryLine: battery.raw,
    wakefulness: wakefulness.replace(/\s+/g, " ").trim(),
    openedAtEpochMs,
    closedAtEpochMs: Date.now(),
    // Filled in once the page's own timeline has been read, after every window is over.
    visibility: "",
    note: notes.join("; "),
  };
}

/**
 * What the page's own `visibilitychange` log says its state was during one window.
 *
 * `hidden` or `visible` when it held throughout, `a→b` when it changed inside the window, and `?`
 * when the page reported nothing at all.
 *
 * It is read from the page ONCE, at the end, rather than asked for per window: attaching a DevTools
 * client to a background tab makes Chrome — on Android especially — treat that tab as active, so a
 * `document.visibilityState` read over CDP answers `visible` whatever the tab was doing a moment
 * before. A listener installed at load time costs nothing while idle and cannot lie about it.
 */
function visibilityOver(timeline: readonly IdleProbeVisibilityEvent[], window: WindowReport): string {
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
  const opened = at(window.openedAtEpochMs);
  const closed = at(window.closedAtEpochMs);
  return opened === closed ? opened : `${opened}→${closed}`;
}

/**
 * Load the bench page, retrying a connection that times out.
 *
 * The one failure this has actually hit is a phone that was still on its way out of Doze, where the
 * first TCP connection over `adb reverse` never completes; a second attempt a few seconds later
 * always has.
 */
async function gotoWithRetries(page: Page, url: string, notes: string[]): Promise<void> {
  for (let attempt = 1; attempt <= NAVIGATION_ATTEMPTS; attempt += 1) {
    try {
      await page.goto(url, { waitUntil: "load", timeout: 120_000 });
      return;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
      if (attempt === NAVIGATION_ATTEMPTS) {
        throw error;
      }
      notes.push(`page load attempt ${attempt} failed (${message})`);
      await tryShell("input keyevent KEYCODE_WAKEUP");
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
  }
}

async function probeOne(
  url: string,
  column: Column,
  idleMs: number,
  wakeups: boolean,
  uidLabel: string,
): Promise<ColumnReport> {
  const notes: string[] = [];
  // Back on the charger and awake BEFORE anything else: the previous column ended with the screen off
  // and the battery reported unplugged, which is what Doze waits for — and a dozing phone answers a
  // page load over `adb reverse` with ERR_CONNECTION_TIMED_OUT.
  await tryShell("dumpsys battery reset");
  await shell(`am force-stop ${CHROME_PACKAGE}`);
  await shell("input keyevent KEYCODE_WAKEUP");
  await unlock(notes);
  await shell(`am start -a android.intent.action.VIEW -d about:blank -p ${CHROME_PACKAGE}`).catch(async () => {
    await shell(`monkey -p ${CHROME_PACKAGE} -c android.intent.category.LAUNCHER 1`);
    return "";
  });
  await adb(["forward", `tcp:${DEVTOOLS_PORT}`, "localabstract:chrome_devtools_remote"]);
  const devtools = await waitForDevtools();

  let open: IdleProbeOpenResult | null = null;
  {
    const browser = await connect();
    try {
      const context = browser.contexts()[0];
      if (context === undefined) {
        throw new Error("Chrome reported no browser context");
      }
      // The tab Chrome was started on, rather than a new one: `Target.createTarget` is not something
      // every Android Chrome answers, and a freshly force-stopped Chrome has exactly one tab.
      const page = context.pages()[0] ?? (await context.newPage());
      page.on("pageerror", (error) => notes.push(`page error: ${error.message}`));
      await gotoWithRetries(page, url, notes);
      await page.locator('[data-testid="environment-line"]').waitFor({ state: "attached", timeout: 120_000 });
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
    } finally {
      // `close()` on a connectOverCDP connection disconnects the client; it does not close Chrome.
      await browser.close();
    }
  }

  const windows: WindowReport[] = [];
  for (const window of WINDOWS) {
    const state = await prepareWindow(window.id);
    const label = window.id === "foreground" && state.keyguard ? "screen on, keyguard showing" : window.label;
    console.error(`probe-idle-cpu-android:   ${column.id} / ${window.id}…`);
    windows.push(await runWindow(window.id, label, idleMs, wakeups, uidLabel, state.notes));
  }

  // Wake the screen before reconnecting, so the freeze test measures Chrome rather than the display.
  await tryShell("input keyevent KEYCODE_WAKEUP");
  await unlock(notes);
  await tryShell("settings put global stay_on_while_plugged_in 2");

  let reconnectMs: number | null = null;
  let queryMs: number | null = null;
  let timeline: readonly IdleProbeVisibilityEvent[] = [];
  {
    // Always reconnect, engine or no engine: the page's visibility timeline is read here, and the
    // `blank` control needs it as much as any other row.
    const startedAt = performance.now();
    const browser = await connect().catch(() => null);
    if (browser === null) {
      notes.push("Chrome's DevTools socket did not answer when the client reconnected");
    } else {
      try {
        const page = benchPage(browser, url);
        if (page === undefined) {
          notes.push("the bench page was gone when the client reconnected");
        } else {
          if (open?.available === true) {
            const answered = await withDeadline(
              page.evaluate(
                async (globalName) =>
                  await (
                    (globalThis as unknown as Record<string, IdleProbeHandle>)[globalName] as IdleProbeHandle
                  ).query(),
                IDLE_PROBE_GLOBAL,
              ),
              QUERY_TIMEOUT_MS,
              `${column.id}: the liveness query after the idle windows`,
            ).catch((error: unknown) => {
              notes.push(`liveness query failed: ${error instanceof Error ? error.message : String(error)}`);
              return null;
            });
            reconnectMs = performance.now() - startedAt;
            queryMs = answered?.ms ?? null;
          }
          timeline = await page
            .evaluate(
              async (globalName) =>
                await (
                  (globalThis as unknown as Record<string, IdleProbeHandle>)[globalName] as IdleProbeHandle
                ).visibility(),
              IDLE_PROBE_GLOBAL,
            )
            .catch(() => []);
          if (open?.available === true) {
            await page
              .evaluate(
                async (globalName) =>
                  await (
                    (globalThis as unknown as Record<string, IdleProbeHandle>)[globalName] as IdleProbeHandle
                  ).release(),
                IDLE_PROBE_GLOBAL,
              )
              .catch(() => {});
          }
        }
      } finally {
        await browser.close();
      }
    }
  }
  await tryShell(`am force-stop ${CHROME_PACKAGE}`);
  const withVisibility = windows.map((window) => ({ ...window, visibility: visibilityOver(timeline, window) }));
  return { column, open, windows: withVisibility, devtools, reconnectMs, queryMs, note: notes.join("; ") };
}

function renderTable(reports: readonly ColumnReport[]): string {
  const header =
    "| Configuration | Window | page state | CPU-ms/min | % of one core | wakeups/s | CPU mAh/h | % battery/h | reconnect→answer (ms) |";
  const rule = "| --- | --- | --- | --- | --- | --- | --- | --- | --- |";
  const rows: string[] = [];
  for (const report of reports) {
    for (const [index, window] of report.windows.entries()) {
      const mahPerHour = window.cpuMah === null ? null : (window.cpuMah * 3_600_000) / window.wallMs;
      const percentPerHour = mahPerHour === null ? null : (mahPerHour / BATTERY_CAPACITY_MAH) * 100;
      const freeze =
        index === report.windows.length - 1 && report.reconnectMs !== null ? report.reconnectMs.toFixed(0) : "—";
      rows.push(
        `| ${report.column.label} | ${window.label} | ${window.visibility || "—"} | ` +
          `${window.cpuMsPerMinute.toFixed(0)} | ` +
          `${window.corePercent.toFixed(2)}% | ` +
          `${window.wakeupsPerSecond === null ? "—" : window.wakeupsPerSecond.toFixed(0)} | ` +
          `${mahPerHour === null ? "—" : mahPerHour.toFixed(2)} | ` +
          `${percentPerHour === null ? "—" : percentPerHour.toFixed(2)}% | ${freeze} |`,
      );
    }
  }
  return [header, rule, ...rows].join("\n");
}

function renderDetails(reports: readonly ColumnReport[]): string {
  return reports
    .map((report) => {
      const lines = [report.column.label];
      if (report.windows.length === 0) {
        lines.push(`    ${report.note === "" ? "no windows were measured" : report.note}`);
        return lines.join("\n");
      }
      if (report.open !== null && report.open.available) {
        lines.push(
          `    open+setup ${report.open.openMs.toFixed(0)} ms, warm "${report.open.warmBenchmark}" ` +
            `${report.open.warmMs.toFixed(2)} ms`,
        );
      }
      for (const window of report.windows) {
        lines.push(
          `    ${window.label}: ${(window.wallMs / 1000).toFixed(0)} s, CPU ${window.cpuMs.toFixed(0)} ms, ` +
            `mAh total ${window.mah === null ? "—" : window.mah.toFixed(4)}, cpu ` +
            `${window.cpuMah === null ? "—" : window.cpuMah.toFixed(4)} [${window.batteryLine}], ${window.wakefulness}` +
            `${window.note === "" ? "" : `; ${window.note}`}`,
        );
      }
      if (report.queryMs !== null) {
        lines.push(`    liveness query after the windows: ${report.queryMs.toFixed(1)} ms in the page`);
      }
      if (report.note !== "") {
        lines.push(`    ${report.note}`);
      }
      return lines.join("\n");
    })
    .join("\n\n");
}

const USAGE = `Usage: bun run probe:idle-cpu-android [options]

  --only <id>       Run one Configuration; repeatable (default: ${DEFAULT_COLUMN_IDS.join(", ")})
  --idle-ms <N>     Length of each idle window (default ${DEFAULT_IDLE_MS})
  --no-build        Reuse the existing dist/ instead of rebuilding
  --no-wakeups      Skip the per-thread context-switch counting (one fewer adb call per sample)
  --serial <id>     Device serial (default: the first device adb lists)
  -h, --help        Print this message

Configurations: ${COLUMNS.map((column) => column.id).join(", ")}`;

async function main(argv: readonly string[]): Promise<number> {
  if (argv.includes("-h") || argv.includes("--help")) {
    console.log(USAGE);
    return 0;
  }
  const only: string[] = [];
  let build = true;
  let wakeups = true;
  let idleMs = DEFAULT_IDLE_MS;
  let serial = "";
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
      case "--no-wakeups":
        wakeups = false;
        break;
      case "--serial":
        index += 1;
        serial = argv[index] ?? "";
        break;
      default:
        console.error(`Unknown argument "${flag ?? ""}"`);
        console.error(USAGE);
        return 2;
    }
  }
  const wanted = only.length === 0 ? DEFAULT_COLUMN_IDS : only;
  const columns = COLUMNS.filter((column) => wanted.includes(column.id));
  if (columns.length === 0) {
    console.error(`No Configuration matches ${wanted.join(", ")}`);
    return 2;
  }

  deviceSerial = serial === "" ? await firstDevice() : serial;
  const model = (await shell("getprop ro.product.model")).trim();
  const release = (await shell("getprop ro.build.version.release")).trim();
  const chromeVersion = (await shell(`dumpsys package ${CHROME_PACKAGE} | grep versionName | head -1`)).trim();
  const stayOn = (await shell("settings get global stay_on_while_plugged_in")).trim();
  const uidLabel = await chromeUidLabel();
  console.error(
    `probe-idle-cpu-android: ${model}, Android ${release}, ${chromeVersion} (${deviceSerial}), battery uid ${uidLabel}`,
  );

  if (build) {
    await buildApp();
  }
  const distDir = resolve(REPO_ROOT, "dist");
  if (!(await Bun.file(`${distDir}/index.html`).exists())) {
    throw new Error(`${distDir}/index.html is missing; run without --no-build`);
  }

  const server = serveDist(distDir, SERVER_PORT);
  const reports: ColumnReport[] = [];
  let devtools = "";
  try {
    await adb(["reverse", `tcp:${SERVER_PORT}`, `tcp:${SERVER_PORT}`]);
    const url = `http://localhost:${SERVER_PORT}/`;
    console.error(`probe-idle-cpu-android: serving ${distDir} at ${url} (through adb reverse)`);
    for (const column of columns) {
      console.error(`probe-idle-cpu-android: ${column.id}…`);
      // One Configuration failing must not throw away the ones already measured: a phone run is
      // half an hour, and a column that could not be opened is itself a result.
      try {
        const one = await probeOne(url, column, idleMs, wakeups, uidLabel);
        reports.push(one);
        devtools = one.devtools === "" ? devtools : one.devtools;
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`probe-idle-cpu-android: ${column.id} FAILED — ${message}`);
        reports.push({
          column,
          open: null,
          windows: [],
          devtools,
          reconnectMs: null,
          queryMs: null,
          note: `failed: ${message}`,
        });
        await tryShell(`am force-stop ${CHROME_PACKAGE}`);
      }
    }
  } finally {
    // Whatever failed, the phone goes back to how it was found.
    await tryShell("dumpsys battery reset");
    await tryShell("input keyevent KEYCODE_WAKEUP");
    await tryShell(`settings put global stay_on_while_plugged_in ${stayOn === "" ? "2" : stayOn}`);
    await adb(["forward", "--remove", `tcp:${DEVTOOLS_PORT}`]).catch(() => "");
    await adb(["reverse", "--remove", `tcp:${SERVER_PORT}`]).catch(() => "");
    await server.stop(true);
  }

  console.log("");
  console.log(`${model}, Android ${release}, ${chromeVersion}, ${devtools}`);
  console.log(`Battery ${BATTERY_CAPACITY_MAH} mAh; windows of ${(idleMs / 1000).toFixed(0)} s, sampled every 10 s`);
  console.log("");
  console.log(renderTable(reports));
  console.log("");
  console.log("Detail:");
  console.log(renderDetails(reports));
  return 0;
}

process.exitCode = await main(process.argv.slice(2)).catch((thrown: unknown) => {
  console.error(
    `probe-idle-cpu-android failed: ${thrown instanceof Error ? (thrown.stack ?? thrown.message) : String(thrown)}`,
  );
  return 1;
});
