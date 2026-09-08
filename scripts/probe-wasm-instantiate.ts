/**
 * What the pgrust module costs a tab before a single row exists: compile, memory, instantiate.
 *
 * `bun run probe:wasm-instantiate`
 *
 * Every other memory number in this repo is taken with a database running — a booted postmaster, a
 * warm Suite, twelve workers. This one deliberately has none of that. The page fetches one `.wasm`,
 * compiles it, creates the one shared `WebAssembly.Memory` the module's import section asks for, and
 * instantiates it against **stub imports**: every `wasi_snapshot_preview1` function is `() => 0` and
 * `wasi.thread-spawn` is `() => -1`. Nothing is called afterwards — `_start` is never invoked, so no
 * postmaster boots and no thread is spawned. What the three numbers separate is therefore:
 *
 *  1. **compile** — what the browser pays to turn 46 MB of code section into machine code, and how
 *     much memory that code costs the renderer. This is the part a trim of the module would move.
 *  2. **memory** — what claiming the module's declared minimum costs before the guest writes a byte
 *     (`--initial-memory` in `wasm/wasm-build.sh`; the module here declares 4096 pages = 256 MiB).
 *  3. **instantiate** — linking plus the module's `start` section, which for a shared-memory build is
 *     `__wasm_init_memory`: the 6.9 MB data section being copied into the shared memory.
 *
 * The RSS is read from outside the browser, because that is the only number that says what is
 * resident: on Chromium through CDP `SystemInfo.getProcessInfo` for the renderer pids plus
 * `/proc/<pid>/status`; on Safari over ssh with `ps -axo pid=,rss=,comm=` against the WebContent
 * processes, the same way `docs/results/2026-09-08-webkit-memory-diet.md` took its numbers, because
 * Safari has no CDP and a driver can only read what the machine will tell it.
 *
 * The page is served with the two cross-origin isolation headers, from this file's own tiny server
 * rather than `dist/`: a shared `WebAssembly.Memory` cannot be created without them, and the module
 * imports one.
 *
 * Usage:
 *   bun run probe:wasm-instantiate [--module <path>] [--repeats N] [--safari] [--port N]
 */

import { spawn } from "node:child_process";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { Browser, Page } from "@playwright/test";
import { chromium } from "@playwright/test";

import { CROSS_ORIGIN_ISOLATION_HEADERS } from "./bench";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The shipped `wasm32-wasip1-threads` module, byte-identical to pgrust's `wasm-release` artefact. */
const DEFAULT_MODULE = resolve(REPO_ROOT, "public/pgrust/postgres-threads.wasm");

/**
 * The full Chromium build, not Playwright's headless shell — the same choice, for the same
 * comparability, as `scripts/probe-memory.ts`.
 */
const BROWSER_CHANNEL = "chromium";

/**
 * Chromium keeps a spare renderer warm, and `SystemInfo.getProcessInfo` says nothing about which
 * renderer is which. With the spare turned off there is exactly one, so every RSS delta below
 * belongs to the page without a heuristic. The count is reported so a future Chromium that ignores
 * the flag is visible rather than silently wrong.
 */
const CHROMIUM_ARGS: readonly string[] = ["--disable-features=SpareRendererForSitePerProcess"];

/** How long the renderer is left alone before its RSS is read, so a phase's allocations have landed. */
const SETTLE_MS = 1_500;

/** Per phase; a 46 MB compile on a cold cache is seconds, not minutes, but a wedged phase must end. */
const PHASE_TIMEOUT_MS = 180_000;

const MIB = 1024 * 1024;

/** Where the Mac's Safari reaches this machine's server, over `ssh -N -R`. */
const SAFARI_HOST = "mac001";
const SAFARI_WEBDRIVER = "http://127.0.0.1:4444";

type PhaseName = "compile" | "memory" | "instantiate";

const PHASES: readonly PhaseName[] = ["compile", "memory", "instantiate"];

/** What the page reports back for one phase. */
interface PhaseResult {
  readonly ms: number;
  /** `WebAssembly.Memory.buffer.byteLength` at the end of the phase, once there is a memory. */
  readonly memoryBytes: number | null;
  /** Resource-timing duration of the module fetch, so the compile row is not read as network time. */
  readonly fetchMs: number | null;
  readonly note: string;
}

interface ProbeState {
  readonly phase: string;
  readonly busy: boolean;
  readonly error: string | null;
  readonly results: Partial<Record<PhaseName, PhaseResult>>;
}

/** One process's resident size, on either platform. */
interface ProcessRss {
  readonly pid: number;
  readonly rssBytes: number | null;
}

interface Snapshot {
  readonly label: string;
  readonly processes: readonly ProcessRss[];
}

interface ModuleFacts {
  readonly path: string;
  readonly bytes: number;
  readonly initialPages: number;
  readonly maximumPages: number | null;
  readonly shared: boolean;
  readonly sections: readonly { readonly id: number; readonly name: string; readonly size: number }[];
}

interface RunReport {
  readonly lane: string;
  readonly browserVersion: string;
  readonly baseline: Snapshot;
  readonly snapshots: readonly Snapshot[];
  readonly state: ProbeState;
}

// ---------------------------------------------------------------------------------------------
// The module, read as bytes: the memory the page must create is the one the import section declares.
// ---------------------------------------------------------------------------------------------

const SECTION_NAMES: Readonly<Record<number, string>> = {
  0: "custom",
  1: "type",
  2: "import",
  3: "function",
  4: "table",
  5: "memory",
  6: "global",
  7: "export",
  8: "start",
  9: "element",
  10: "code",
  11: "data",
  12: "data count",
  13: "tag",
};

/** A LEB128 reader over the module, which is all the parsing a size map and a memory import need. */
class WasmReader {
  private readonly view: DataView;
  private offset: number;

  constructor(view: DataView) {
    this.view = view;
    this.offset = 0;
  }

  get position(): number {
    return this.offset;
  }

  set position(value: number) {
    this.offset = value;
  }

  get done(): boolean {
    return this.offset >= this.view.byteLength;
  }

  byte(): number {
    const value = this.view.getUint8(this.offset);
    this.offset += 1;
    return value;
  }

  varUint32(): number {
    let result = 0;
    let shift = 0;
    let byte = 0;
    do {
      byte = this.byte();
      result |= (byte & 0x7f) << shift;
      shift += 7;
    } while ((byte & 0x80) !== 0);
    return result >>> 0;
  }

  skip(count: number): void {
    this.offset += count;
  }

  name(): string {
    const length = this.varUint32();
    const bytes = new Uint8Array(this.view.buffer, this.view.byteOffset + this.offset, length);
    this.offset += length;
    return new TextDecoder().decode(bytes);
  }
}

/**
 * The section sizes and the imported memory's declared limits.
 *
 * `wasm32-wasip1-threads` links with `--import-memory --shared-memory`, so the module does not own a
 * memory: the host creates it and every instance is handed the same one. Its limits are written in
 * the import section and the host's `WebAssembly.Memory` must match them exactly, which is why the
 * page is told the numbers from here rather than from the build script's flags.
 */
async function readModuleFacts(path: string): Promise<ModuleFacts> {
  const buffer = await Bun.file(path).arrayBuffer();
  const reader = new WasmReader(new DataView(buffer));
  reader.skip(8); // magic + version
  const sections: { id: number; name: string; size: number }[] = [];
  let initialPages = 0;
  let maximumPages: number | null = null;
  let shared = false;
  while (!reader.done) {
    const id = reader.byte();
    const size = reader.varUint32();
    const start = reader.position;
    let name = SECTION_NAMES[id] ?? `section ${id}`;
    if (id === 0) {
      name = `custom: ${reader.name()}`;
    }
    if (id === 2) {
      const count = reader.varUint32();
      for (let index = 0; index < count; index += 1) {
        reader.name(); // module
        reader.name(); // field
        const kind = reader.byte();
        if (kind === 0x00) {
          reader.varUint32(); // type index
        } else if (kind === 0x01) {
          reader.byte(); // reftype
          const flags = reader.byte();
          reader.varUint32();
          if ((flags & 0x01) !== 0) {
            reader.varUint32();
          }
        } else if (kind === 0x02) {
          const flags = reader.byte();
          shared = (flags & 0x02) !== 0;
          initialPages = reader.varUint32();
          maximumPages = (flags & 0x01) !== 0 ? reader.varUint32() : null;
        } else if (kind === 0x03) {
          reader.byte(); // valtype
          reader.byte(); // mutability
        } else if (kind === 0x04) {
          reader.byte(); // tag attribute
          reader.varUint32(); // type index
        }
      }
    }
    sections.push({ id, name, size });
    reader.position = start + size;
  }
  return {
    path,
    bytes: buffer.byteLength,
    initialPages,
    maximumPages,
    shared,
    sections,
  };
}

// ---------------------------------------------------------------------------------------------
// The page. Deliberately the smallest thing that can hold a module: no framework, no worker, no
// Engine. It exposes a handle the driver steps through one phase at a time, because the memory
// question is "what did THAT phase cost" and a driver can only read RSS between phases.
// ---------------------------------------------------------------------------------------------

function probePage(moduleUrl: string, initialPages: number, maximumPages: number | null): string {
  const memoryDescriptor = JSON.stringify(
    maximumPages === null
      ? { initial: initialPages, shared: true }
      : { initial: initialPages, maximum: maximumPages, shared: true },
  );
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>wasm instantiate probe</title></head>
<body>
<pre data-testid="probe-state">idle</pre>
<script>
const MODULE_URL = ${JSON.stringify(moduleUrl)};
const MEMORY_DESCRIPTOR = ${memoryDescriptor};
const state = { phase: "idle", busy: false, error: null, results: {} };
const held = { module: null, memory: null, instance: null };
const publish = () => {
  document.querySelector('[data-testid=probe-state]').textContent = JSON.stringify(state);
};
const finish = (phase, result) => {
  state.results[phase] = result;
  state.phase = phase + ":done";
  state.busy = false;
  publish();
};
const fail = (phase, error) => {
  state.error = phase + ": " + (error && error.message ? error.message : String(error));
  state.phase = phase + ":error";
  state.busy = false;
  publish();
};
const fetchMs = () => {
  const entry = performance.getEntriesByType("resource").filter((e) => e.name.endsWith(MODULE_URL))[0];
  return entry ? entry.duration : null;
};
const phases = {
  // compileStreaming is what a real host does; the fetch is same-origin and localhost, and its
  // resource-timing duration is reported beside the total so the two are never conflated.
  compile: async () => {
    const started = performance.now();
    held.module = await WebAssembly.compileStreaming(fetch(MODULE_URL, { cache: "no-store" }));
    const ms = performance.now() - started;
    finish("compile", { ms, memoryBytes: null, fetchMs: fetchMs(), note: "compileStreaming, cache: no-store" });
  },
  // The module's declared minimum, shared, exactly as the import section asks for it.
  memory: async () => {
    const started = performance.now();
    held.memory = new WebAssembly.Memory(MEMORY_DESCRIPTOR);
    const ms = performance.now() - started;
    finish("memory", {
      ms,
      memoryBytes: held.memory.buffer.byteLength,
      fetchMs: null,
      note: "new WebAssembly.Memory(" + JSON.stringify(MEMORY_DESCRIPTOR) + ")",
    });
  },
  // Stub imports only: nothing here can run Postgres, and nothing is called after linking. The
  // module's start section (__wasm_init_memory) DOES run, which is the data section landing in the
  // shared memory.
  instantiate: async () => {
    const importObject = {};
    let stubs = 0;
    for (const descriptor of WebAssembly.Module.imports(held.module)) {
      importObject[descriptor.module] = importObject[descriptor.module] || {};
      if (descriptor.kind === "memory") {
        importObject[descriptor.module][descriptor.name] = held.memory;
      } else if (descriptor.kind === "global") {
        importObject[descriptor.module][descriptor.name] = 0;
      } else {
        stubs += 1;
        importObject[descriptor.module][descriptor.name] = descriptor.name === "thread-spawn"
          ? () => -1
          : () => 0;
      }
    }
    const started = performance.now();
    held.instance = await WebAssembly.instantiate(held.module, importObject);
    const ms = performance.now() - started;
    finish("instantiate", {
      ms,
      memoryBytes: held.memory.buffer.byteLength,
      fetchMs: null,
      note: stubs + " stub imports, " + Object.keys(held.instance.exports).length + " exports, nothing called",
    });
  },
};
window.__wasmProbe = {
  state,
  start(phase) {
    if (state.busy) { return "busy"; }
    state.busy = true;
    state.phase = phase + ":running";
    publish();
    phases[phase]().catch((error) => fail(phase, error));
    return "started";
  },
};
publish();
</script>
</body>
</html>
`;
}

/** Kick a phase off; the page returns immediately so the driver can read RSS while it runs. */
function startScript(phase: PhaseName): string {
  return `window.__wasmProbe.start(${JSON.stringify(phase)})`;
}

/** The page's whole state, as JSON, because Safari's WebDriver returns only what the page publishes. */
const POLL_SCRIPT = "JSON.stringify(window.__wasmProbe.state)";

// ---------------------------------------------------------------------------------------------
// Chromium lane: the renderer's RSS read from outside it, between phases.
// ---------------------------------------------------------------------------------------------

interface ProcessInfoResponse {
  readonly processInfo: readonly { readonly type: string; readonly id: number }[];
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

async function chromiumSnapshot(browser: Browser, label: string): Promise<Snapshot> {
  const session = await browser.newBrowserCDPSession();
  try {
    const info = (await session.send("SystemInfo.getProcessInfo" as never)) as ProcessInfoResponse;
    const processes = await Promise.all(
      info.processInfo
        .filter((entry) => entry.type === "renderer")
        .map(async (entry) => ({ pid: entry.id, rssBytes: await readRss(entry.id) })),
    );
    return { label, processes };
  } finally {
    await session.detach().catch(() => {});
  }
}

async function pollState(read: () => Promise<string>, phase: PhaseName): Promise<ProbeState> {
  const deadline = Date.now() + PHASE_TIMEOUT_MS;
  for (;;) {
    const state = JSON.parse(await read()) as ProbeState;
    if (state.error !== null) {
      throw new Error(`the page failed during ${phase}: ${state.error}`);
    }
    if (!state.busy && state.phase === `${phase}:done`) {
      return state;
    }
    if (Date.now() > deadline) {
      throw new Error(`${phase} did not finish within ${PHASE_TIMEOUT_MS} ms (phase=${state.phase})`);
    }
    await Bun.sleep(250);
  }
}

async function runChromium(url: string): Promise<RunReport> {
  const browser = await chromium.launch({ headless: true, channel: BROWSER_CHANNEL, args: [...CHROMIUM_ARGS] });
  try {
    const context = await browser.newContext();
    const page: Page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(url, { waitUntil: "load", timeout: 60_000 });
    const isolated = await page.evaluate("globalThis.crossOriginIsolated === true");
    if (isolated !== true) {
      throw new Error("the probe page is not cross-origin isolated; a shared memory cannot be created");
    }
    await Bun.sleep(SETTLE_MS);
    const baseline = await chromiumSnapshot(browser, "page loaded, nothing compiled");
    const snapshots: Snapshot[] = [];
    let state: ProbeState = { phase: "idle", busy: false, error: null, results: {} };
    for (const phase of PHASES) {
      const started = await page.evaluate(startScript(phase));
      if (started !== "started") {
        throw new Error(`the page refused to start ${phase}: ${String(started)}`);
      }
      state = await pollState(async () => String(await page.evaluate(POLL_SCRIPT)), phase);
      await Bun.sleep(SETTLE_MS);
      snapshots.push(await chromiumSnapshot(browser, `after ${phase}`));
    }
    if (errors.length > 0) {
      console.error(`  page errors: ${errors.join(" | ")}`);
    }
    return { lane: "Chromium", browserVersion: browser.version(), baseline, snapshots, state };
  } finally {
    await browser.close();
  }
}

// ---------------------------------------------------------------------------------------------
// Safari lane: real Safari on mac001 over WebDriver, with the page reached through `ssh -N -R` and
// the memory read with `ps` over ssh, because WebKit has no CDP.
// ---------------------------------------------------------------------------------------------

async function webdriver(method: string, path: string, body?: unknown): Promise<unknown> {
  const init: RequestInit = { method, headers: { "content-type": "application/json" } };
  const response = await fetch(
    SAFARI_WEBDRIVER + path,
    body === undefined ? init : { ...init, body: JSON.stringify(body) },
  );
  const payload = (await response.json()) as { value: unknown };
  if (!response.ok) {
    throw new Error(`${method} ${path}: ${JSON.stringify(payload.value).slice(0, 300)}`);
  }
  return payload.value;
}

/** Every WebContent process on the Mac and its RSS, which is the closest thing Safari has to a probe. */
async function safariSnapshot(label: string): Promise<Snapshot> {
  const child = spawn("ssh", ["-o", "BatchMode=yes", SAFARI_HOST, "ps -axo pid=,rss=,comm="], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  const text = await new Response(child.stdout as unknown as ReadableStream).text();
  const processes: ProcessRss[] = [];
  for (const line of text.split("\n")) {
    if (!line.includes("com.apple.WebKit.WebContent")) {
      continue;
    }
    const match = /^\s*(\d+)\s+(\d+)\s/.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) {
      processes.push({ pid: Number.parseInt(match[1], 10), rssBytes: Number.parseInt(match[2], 10) * 1024 });
    }
  }
  return { label, processes };
}

/** `ssh -N -R`: the Mac's Safari fetches the module from this machine's server on the same port. */
function reverseTunnel(port: number): { stop: () => void } {
  const child = spawn(
    "ssh",
    ["-o", "BatchMode=yes", "-o", "ExitOnForwardFailure=yes", "-N", "-R", `${port}:127.0.0.1:${port}`, SAFARI_HOST],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
  return { stop: () => void child.kill() };
}

async function runSafari(url: string, port: number): Promise<RunReport> {
  const tunnel = reverseTunnel(port);
  let sessionId: string | null = null;
  try {
    // The tunnel is a process, not a promise: give it a moment to bind before Safari asks for the page.
    await Bun.sleep(2_000);
    const session = (await webdriver("POST", "/session", {
      capabilities: { alwaysMatch: { browserName: "safari" } },
    })) as { sessionId: string; capabilities: { browserVersion?: string } };
    sessionId = session.sessionId;
    const exec = async (script: string): Promise<unknown> =>
      await webdriver("POST", `/session/${sessionId}/execute/sync`, { script: `return ${script}`, args: [] });
    await webdriver("POST", `/session/${sessionId}/url`, { url });
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const ready = await exec("globalThis.crossOriginIsolated === true && !!window.__wasmProbe").catch(() => false);
      if (ready === true) {
        break;
      }
      await Bun.sleep(1_000);
    }
    if ((await exec("globalThis.crossOriginIsolated === true")) !== true) {
      throw new Error("Safari's page is not cross-origin isolated; check the reverse tunnel's headers");
    }
    await Bun.sleep(SETTLE_MS);
    const baseline = await safariSnapshot("page loaded, nothing compiled");
    const snapshots: Snapshot[] = [];
    let state: ProbeState = { phase: "idle", busy: false, error: null, results: {} };
    for (const phase of PHASES) {
      const started = await exec(startScript(phase));
      if (started !== "started") {
        throw new Error(`the page refused to start ${phase}: ${String(started)}`);
      }
      state = await pollState(async () => String(await exec(POLL_SCRIPT)), phase);
      await Bun.sleep(SETTLE_MS);
      snapshots.push(await safariSnapshot(`after ${phase}`));
    }
    return {
      lane: "Safari",
      browserVersion: session.capabilities.browserVersion ?? "unknown",
      baseline,
      snapshots,
      state,
    };
  } finally {
    if (sessionId !== null) {
      await webdriver("DELETE", `/session/${sessionId}`).catch(() => {});
    }
    tunnel.stop();
  }
}

// ---------------------------------------------------------------------------------------------
// Reporting.
// ---------------------------------------------------------------------------------------------

function mib(bytes: number | null): string {
  return bytes === null ? "—" : (bytes / MIB).toFixed(1);
}

/**
 * The one process the phases moved.
 *
 * On Chromium with the spare renderer disabled there is exactly one; on Safari there may be several
 * WebContent processes (a just-closed tab's included), so the page's is the one that GREW, which is
 * the same attribution the WebKit memory-diet lane used.
 */
function trackedPid(baseline: Snapshot, snapshots: readonly Snapshot[]): number | undefined {
  const last = snapshots[snapshots.length - 1];
  if (last === undefined) {
    return baseline.processes[0]?.pid;
  }
  let best: { pid: number; growth: number } | undefined;
  for (const process of last.processes) {
    const before = baseline.processes.find((entry) => entry.pid === process.pid)?.rssBytes ?? 0;
    const growth = (process.rssBytes ?? 0) - before;
    if (best === undefined || growth > best.growth) {
      best = { pid: process.pid, growth };
    }
  }
  return best?.pid;
}

function rssOf(snapshot: Snapshot, pid: number | undefined): number | null {
  return snapshot.processes.find((entry) => entry.pid === pid)?.rssBytes ?? null;
}

function totalRss(snapshot: Snapshot): number {
  return snapshot.processes.reduce((sum, entry) => sum + (entry.rssBytes ?? 0), 0);
}

function renderReport(facts: ModuleFacts, report: RunReport): string {
  const pid = trackedPid(report.baseline, report.snapshots);
  const rows: string[] = [];
  const baselineRss = rssOf(report.baseline, pid);
  rows.push(
    `| ${report.baseline.label} | — | ${mib(baselineRss)} | — | ${mib(totalRss(report.baseline))} (${report.baseline.processes.length}) | — |`,
  );
  let previous = baselineRss;
  for (const [index, phase] of PHASES.entries()) {
    const snapshot = report.snapshots[index];
    const result = report.state.results[phase];
    if (snapshot === undefined || result === undefined) {
      continue;
    }
    const rss = rssOf(snapshot, pid);
    const delta = rss === null || previous === null ? "—" : mib(rss - previous);
    rows.push(
      `| ${snapshot.label} | ${result.ms.toFixed(0)} | ${mib(rss)} | ${delta} | ${mib(totalRss(snapshot))} (${snapshot.processes.length}) | ${result.memoryBytes === null ? "—" : `${mib(result.memoryBytes)} MiB`} |`,
    );
    previous = rss;
  }
  const compile = report.state.results.compile;
  const notes = PHASES.map((phase) => {
    const result = report.state.results[phase];
    return result === undefined ? `- ${phase}: (not run)` : `- ${phase}: ${result.note}`;
  });
  return [
    `### ${report.lane} ${report.browserVersion} — ${basename(facts.path)} (${facts.bytes.toLocaleString("en-US")} bytes)`,
    "",
    `| Step | wall (ms) | renderer RSS (MiB) | Δ RSS (MiB) | all renderers (MiB, n) | wasm memory |`,
    `| --- | --- | --- | --- | --- | --- |`,
    ...rows,
    "",
    compile?.fetchMs == null ? "" : `Module fetch inside the compile row: ${compile.fetchMs.toFixed(0)} ms.`,
    ...notes,
  ]
    .filter((line) => line !== "")
    .join("\n");
}

function renderModuleFacts(facts: ModuleFacts): string {
  const sections = [...facts.sections]
    .sort((left, right) => right.size - left.size)
    .map(
      (section) =>
        `| ${section.name} | ${section.size.toLocaleString("en-US")} | ${((section.size / facts.bytes) * 100).toFixed(1)}% |`,
    );
  return [
    `### ${basename(facts.path)} — sections`,
    "",
    `Declared memory import: ${facts.initialPages} pages (${mib(facts.initialPages * 65536)} MiB) minimum, ` +
      `${facts.maximumPages === null ? "no maximum" : `${facts.maximumPages} pages (${mib(facts.maximumPages * 65536)} MiB) maximum`}` +
      `, ${facts.shared ? "shared" : "unshared"}.`,
    "",
    `| Section | bytes | % of module |`,
    `| --- | --- | --- |`,
    ...sections,
  ].join("\n");
}

// ---------------------------------------------------------------------------------------------

const USAGE = `Usage: bun run probe:wasm-instantiate [options]

  --module <path>  The .wasm to probe (default: public/pgrust/postgres-threads.wasm)
  --repeats <N>    Repeat every lane N times, each in a fresh browser (default: 1)
  --port <N>       Port for the probe server (default: 4199, the port the Safari tunnel uses)
  --safari         Also drive real Safari on ${SAFARI_HOST} through safaridriver on ${SAFARI_WEBDRIVER}
  --no-chromium    Skip the Chromium lane
  -h, --help       Print this message`;

function argValue(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
}

async function main(argv: readonly string[]): Promise<number> {
  if (argv.includes("-h") || argv.includes("--help")) {
    console.log(USAGE);
    return 0;
  }
  const modulePath = resolve(REPO_ROOT, argValue(argv, "--module") ?? DEFAULT_MODULE);
  const repeats = Number.parseInt(argValue(argv, "--repeats") ?? "1", 10);
  const port = Number.parseInt(argValue(argv, "--port") ?? "4199", 10);
  const facts = await readModuleFacts(modulePath);
  console.log(renderModuleFacts(facts));
  console.log("");

  const moduleUrl = "/module.wasm";
  const html = probePage(moduleUrl, facts.initialPages, facts.maximumPages);
  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    development: false,
    fetch: (request: Request): Response => {
      const { pathname } = new URL(request.url);
      if (pathname === moduleUrl) {
        return new Response(Bun.file(modulePath), {
          headers: {
            "content-type": "application/wasm",
            "cache-control": "no-store",
            ...CROSS_ORIGIN_ISOLATION_HEADERS,
          },
        });
      }
      if (pathname === "/" || pathname === "/index.html") {
        return new Response(html, {
          headers: { "content-type": "text/html; charset=utf-8", ...CROSS_ORIGIN_ISOLATION_HEADERS },
        });
      }
      return new Response("Not found", { status: 404, headers: CROSS_ORIGIN_ISOLATION_HEADERS });
    },
  });
  const boundPort = server.port ?? port;
  const url = `http://127.0.0.1:${boundPort}/`;
  try {
    for (let round = 1; round <= repeats; round += 1) {
      if (!argv.includes("--no-chromium")) {
        console.log(renderReport(facts, await runChromium(url)));
        console.log("");
      }
      if (argv.includes("--safari")) {
        console.log(renderReport(facts, await runSafari(`http://localhost:${boundPort}/`, boundPort)));
        console.log("");
      }
      if (repeats > 1) {
        console.log(`(round ${round} of ${repeats})\n`);
      }
    }
  } finally {
    await server.stop(true);
  }
  return 0;
}

process.exitCode = await main(process.argv.slice(2));
