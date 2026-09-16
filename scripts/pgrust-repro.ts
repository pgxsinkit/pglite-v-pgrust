/**
 * The two pgrust engine gaps pgxsinkit's unit suite found, reduced to standalone SQL and run on
 * every engine this repo can reach.
 *
 * `bun run repro:pgrust`
 *
 * `docs/results/2026-09-07-pgxsinkit-unit-suite-on-pgrust.md` recorded 19 failures across 1987 tests
 * and two causes behind them. Both were reported by pgrust itself — a named file and a named node
 * family — so neither needed pgxsinkit to state it. This script is the statement without pgxsinkit:
 * `scripts/pgrust-repro-nullif.sql` and `scripts/pgrust-repro-acl-detoast.sql` are the smallest SQL
 * that reaches each gap, and every one of them is ordinary PostgreSQL that PGlite answers.
 *
 * Three lanes, one table:
 *
 *  - **PGlite** (`@electric-sql/pglite`, in memory) — the PostgreSQL 18.3 baseline. Both files must
 *    succeed here, which is what makes them bug reports rather than pgrust-specific SQL.
 *  - **pgrust wasm** (`createPgrustPglite`, memory store) — the lane the suite ran on.
 *  - **pgrust native** (`postgres --host-pipes` over ordinary file descriptors) — the lane that
 *    answers "is this wasm-only?". It needs a built binary (`PGRUST_DIR`'s `target/release/postgres`
 *    or `target/debug/postgres`) and an `initdb` (`/usr/lib/postgresql/18/bin`); without either it is
 *    reported as skipped rather than silently dropped, and the run still passes on the other two.
 *
 * **Both gaps are closed.** `malisper/pgrust#109` and `#110` were fixed upstream and arrived here
 * with pgrust 0.3 (`79ad992ede`), so the note on each case now says `fixedIn` and the expectation
 * has turned over: a pgrust lane must ANSWER both files, exactly as PGlite does. The SQL stays
 * because that is what makes the fix checkable — a regression is one run away from being news
 * again, and `marker` is kept so a refusal can say whether it is the same old gap or a new one.
 *
 * Exit 0 on `VERDICT: pgrust-repro PASS` — every lane that ran answered both files. Exit 1 the
 * moment any lane disagrees, and this script is where that would show up first.
 *
 * Environment:
 *   PGRUST_DIR          pgrust checkout for the native lane (default ../pgrust)
 *   PGRUST_NATIVE_BIN   the `postgres` binary itself, overriding the search above
 *   PGRUST_PGBIN        the PostgreSQL 18 bin directory holding `initdb`
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";

import { createPgrustPglite } from "../src/client/pgrust-factory";
import type { ParsedMessage } from "../src/vendor/pgrust/wire.js";
import { encodeQuery, encodeStartup, parseMessage, TERMINATE, WireReader } from "../src/vendor/pgrust/wire.js";

/** This repo's root: the script lives in `<root>/scripts/`. */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The sibling pgrust checkout, when `PGRUST_DIR` does not say otherwise. */
const DEFAULT_PGRUST_DIR = "../pgrust";

/** Where `initdb` lives, when `PGRUST_PGBIN` does not say otherwise. */
const DEFAULT_PGBIN = "/usr/lib/postgresql/18/bin";

/** Scratch for the native lane: a datadir and a server log per file, never reused across runs. */
const NATIVE_SCRATCH = path.join(REPO_ROOT, "tmp", "agents", "pgrust-repro");

/** How long the native postmaster gets to announce itself before the lane is called dead. */
const NATIVE_BOOT_TIMEOUT_MS = 60_000;

/** One reduced reproduction: a file, the words pgrust refused it with, and which pgrust fixed it. */
interface ReproCase {
  /** Short name, used for the scratch directory and the table. */
  readonly name: string;
  /** Path relative to this repo's root. */
  readonly file: string;
  /** The distinguishing part of pgrust's error, so a DIFFERENT failure is not mistaken for this one. */
  readonly marker: string;
  /** The pgrust that closed the gap. Set, the file must be ANSWERED; unset, it must be refused. */
  readonly fixedIn?: string;
}

const CASES: readonly ReproCase[] = [
  {
    name: "nullif",
    file: "scripts/pgrust-repro-nullif.sql",
    marker: "T_NullIfExpr not ported",
    fixedIn: "0.3 (malisper/pgrust#109)",
  },
  {
    name: "acl-detoast",
    file: "scripts/pgrust-repro-acl-detoast.sql",
    marker: "detoast gap",
    fixedIn: "0.3 (malisper/pgrust#110)",
  },
];

/** What one engine did with one file. `skipped` is a lane that could not run, not a failure. */
type Outcome =
  | { readonly kind: "ok"; readonly detail: string }
  | { readonly kind: "error"; readonly detail: string }
  | { readonly kind: "skipped"; readonly detail: string };

/** A lane's answer for every case, plus whatever it could say about its own build. */
interface LaneResult {
  readonly engine: string;
  readonly version: string;
  readonly outcomes: readonly Outcome[];
}

function log(line: string): void {
  process.stdout.write(`${line}\n`);
}

/** The first line of an error: the server's words, without a JS stack nobody asked for. */
function errorLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split("\n")[0] ?? message;
}

/** The last statement's first row, rendered short — enough to see the engine really answered. */
function rowSummary(rows: readonly unknown[]): string {
  const first = rows[0];
  return first === undefined ? "(no rows)" : JSON.stringify(first).slice(0, 120);
}

function readCase(reproCase: ReproCase): string {
  return readFileSync(path.join(REPO_ROOT, reproCase.file), "utf8");
}

// ---- PGlite -----------------------------------------------------------------------------------

async function runPglite(): Promise<LaneResult> {
  const outcomes: Outcome[] = [];
  let version = "(unknown)";
  for (const reproCase of CASES) {
    const db = await PGlite.create();
    try {
      const banner = await db.query<{ version: string }>("SELECT version()");
      version = banner.rows[0]?.version ?? version;
      const results = await db.exec(readCase(reproCase));
      outcomes.push({ kind: "ok", detail: rowSummary(results.at(-1)?.rows ?? []) });
    } catch (error) {
      outcomes.push({ kind: "error", detail: errorLine(error) });
    } finally {
      await db.close();
    }
  }
  return { engine: "PGlite (in memory)", version, outcomes };
}

// ---- pgrust, wasm -----------------------------------------------------------------------------

async function runPgrustWasm(): Promise<LaneResult> {
  const outcomes: Outcome[] = [];
  let version = "(unknown)";
  for (const reproCase of CASES) {
    const db = await createPgrustPglite(`memory://repro-${reproCase.name}`, { extensions: {} });
    try {
      const banner = await db.query<{ version: string }>("SELECT version()");
      version = banner.rows[0]?.version ?? version;
      const results = await db.exec(readCase(reproCase));
      outcomes.push({ kind: "ok", detail: rowSummary(results.at(-1)?.rows ?? []) });
    } catch (error) {
      outcomes.push({ kind: "error", detail: errorLine(error) });
    } finally {
      await db.close();
    }
  }
  return { engine: "pgrust wasm (memory store)", version, outcomes };
}

// ---- pgrust, native ---------------------------------------------------------------------------

/** The `postgres` binary for the native lane, or the reason there is none. */
function findNativeBinary(): { readonly bin: string } | { readonly reason: string } {
  const explicit = process.env["PGRUST_NATIVE_BIN"];
  if (explicit !== undefined && explicit !== "") {
    return existsSync(explicit) ? { bin: explicit } : { reason: `PGRUST_NATIVE_BIN=${explicit} does not exist` };
  }
  const configured = process.env["PGRUST_DIR"];
  const pgrustDir = path.resolve(
    REPO_ROOT,
    configured === undefined || configured === "" ? DEFAULT_PGRUST_DIR : configured,
  );
  for (const profile of ["release", "debug"]) {
    const candidate = path.join(pgrustDir, "target", profile, "postgres");
    if (existsSync(candidate)) {
      return { bin: candidate };
    }
  }
  return { reason: `no target/{release,debug}/postgres under ${pgrustDir} (cargo build -p main_main --bin postgres)` };
}

/** `initdb`, which the native lane needs to make a cluster pgrust can boot. */
function findInitdb(): { readonly initdb: string } | { readonly reason: string } {
  const configured = process.env["PGRUST_PGBIN"];
  const pgbin = configured === undefined || configured === "" ? DEFAULT_PGBIN : configured;
  const initdb = path.join(pgbin, "initdb");
  return existsSync(initdb) ? { initdb } : { reason: `no initdb at ${initdb} (set PGRUST_PGBIN)` };
}

/**
 * The host-pipes contract (`crates/backend/libpq/pqcomm_hostpipes`): one 16-byte little-endian
 * record per connection on the listener fd — magic `HPGP`, the fd the server READS the client from,
 * the fd it WRITES to, and a reserved word.
 */
function connectionRecord(inFd: number, outFd: number): Buffer {
  const record = Buffer.alloc(16);
  record.writeUInt32LE(0x50475048, 0);
  record.writeInt32LE(inFd, 4);
  record.writeInt32LE(outFd, 8);
  record.writeUInt32LE(0, 12);
  return record;
}

const sleep = async (ms: number): Promise<void> => await new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One SQL string against one freshly initdb'd native postmaster, over three pipes: fd 3 is the
 * listener the host announces connections on, fd 4/5 are the session's read/write ends. The server
 * is shut down by CLOSING the listener, which is the same fast shutdown a SIGINT performs and the
 * only one the wasm host has.
 */
async function runNativeOnce(bin: string, initdb: string, reproCase: ReproCase): Promise<Outcome> {
  const scratch = path.join(NATIVE_SCRATCH, reproCase.name);
  const datadir = path.join(scratch, "datadir");
  rmSync(scratch, { recursive: true, force: true });
  mkdirSync(scratch, { recursive: true });

  const init = spawnSync(initdb, ["-D", datadir, "--no-locale", "--encoding=UTF8", "-U", "postgres", "-A", "trust"], {
    encoding: "utf8",
  });
  if (init.status !== 0) {
    return {
      kind: "skipped",
      detail: `initdb failed: ${(init.stderr || init.stdout).trim().split("\n").at(-1) ?? ""}`,
    };
  }

  // The wasm lane's own settings, minus everything that would open a socket: the ONLY way in is the
  // listener fd. `ulimit -s` is what the dev profile's frames need under max_stack_depth.
  const argv = [
    "--host-pipes",
    "-D",
    datadir,
    ...["-c", "max_stack_depth=60000"],
    ...["-c", "io_method=sync"],
    ...["-c", "autovacuum=off"],
    ...["-c", "wal_sync_method=fdatasync"],
    ...["-c", "shared_buffers=32MB"],
    ...["-c", "listen_addresses="],
    ...["-c", "unix_socket_directories="],
  ];
  const child = spawn("bash", ["-c", 'ulimit -s 65520; exec "$@"', "bash", bin, ...argv], {
    stdio: ["ignore", "pipe", "pipe", "pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      PGRUST_HOSTPIPES_LISTEN_FD: "3",
      PGRUST_TZDIR: "/usr/share/zoneinfo",
      PGRUST_PGSHAREDIR: "/usr/share/postgresql/18",
    },
  });

  let serverLog = "";
  let exited: string | null = null;
  for (const stream of [child.stdout, child.stderr]) {
    if (stream === null) continue;
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      serverLog += chunk;
    });
  }
  child.on("exit", (code, signal) => {
    exited = `code=${code} signal=${signal}`;
  });
  // Read through a function: `exited` is only ever written from the callback above, and a direct
  // read would be narrowed to its initializer.
  const exitStatus = (): string | null => exited;

  // Node models `stdio` as a five-element tuple; the extra descriptors this transport needs are real
  // streams all the same, and a missing one means the spawn contract above was not honoured.
  const pipes = child.stdio as unknown as readonly unknown[];
  const pipe = (index: number): Readable & Writable => {
    const stream = pipes[index];
    if (stream === null || stream === undefined) {
      throw new Error(`pgrust-repro: the native postmaster was given no fd ${index}`);
    }
    return stream as Readable & Writable;
  };
  const listener = pipe(3);
  const toServer = pipe(4);
  const fromServer = pipe(5);

  const reader = new WireReader();
  let collector: { readonly messages: ParsedMessage[]; readonly resolve: (m: ParsedMessage[]) => void } | null = null;
  const pump = (): void => {
    for (;;) {
      const message = reader.next();
      if (message === null) break;
      if (collector === null) continue;
      collector.messages.push(parseMessage(message.t, message.body));
      if (message.t === "Z") {
        const done = collector;
        collector = null;
        done.resolve(done.messages);
      }
    }
  };
  fromServer.on("data", (chunk: Buffer) => {
    reader.feed(new Uint8Array(chunk));
    pump();
  });
  const collect = async (): Promise<ParsedMessage[]> =>
    await new Promise((resolve) => {
      collector = { messages: [], resolve };
      pump();
    });

  const finish = async (outcome: Outcome): Promise<Outcome> => {
    listener.end();
    for (let waited = 0; exitStatus() === null && waited < 5_000; waited += 50) {
      await sleep(50);
    }
    if (exitStatus() === null) child.kill("SIGINT");
    writeFileSync(path.join(scratch, "postmaster.log"), serverLog);
    return outcome;
  };

  const deadline = Date.now() + NATIVE_BOOT_TIMEOUT_MS;
  while (!/ready to accept connections/.test(serverLog)) {
    const status = exitStatus();
    if (status !== null) return await finish({ kind: "skipped", detail: `postmaster exited ${status}` });
    if (Date.now() > deadline) return await finish({ kind: "skipped", detail: "postmaster never became ready" });
    await sleep(25);
  }

  listener.write(connectionRecord(4, 5));
  const startup = collect();
  toServer.write(Buffer.from(encodeStartup({ user: "postgres", database: "postgres" })));
  await startup;

  const answered = collect();
  toServer.write(Buffer.from(encodeQuery(readCase(reproCase))));
  const messages = await answered;
  toServer.write(Buffer.from(TERMINATE));

  const failure = messages.find((message): message is ParsedMessage & { t: "E" } => message.t === "E");
  if (failure !== undefined && "message" in failure) {
    return await finish({ kind: "error", detail: `${failure.severity}: ${failure.message}` });
  }
  const rows = messages.filter((message): message is ParsedMessage & { t: "D" } => message.t === "D");
  const last = rows.at(-1);
  return await finish({
    kind: "ok",
    detail: last !== undefined && "values" in last ? JSON.stringify(last.values) : "(no rows)",
  });
}

/** The native postmaster's own banner, which names the build the two outcomes came from. */
function nativeVersion(scratchName: string): string {
  const logFile = path.join(NATIVE_SCRATCH, scratchName, "postmaster.log");
  if (!existsSync(logFile)) return "(unknown)";
  const line = readFileSync(logFile, "utf8")
    .split("\n")
    .find((entry) => entry.includes("starting pgrust"));
  return line === undefined ? "(unknown)" : (line.split("LOG:").at(-1)?.trim() ?? "(unknown)");
}

async function runPgrustNative(): Promise<LaneResult> {
  const notRun = (reason: string): LaneResult => ({
    engine: "pgrust native (host pipes)",
    version: "(not run)",
    outcomes: CASES.map(() => ({ kind: "skipped", detail: reason })),
  });
  const binary = findNativeBinary();
  if ("reason" in binary) return notRun(binary.reason);
  const init = findInitdb();
  if ("reason" in init) return notRun(init.reason);

  const outcomes: Outcome[] = [];
  for (const reproCase of CASES) {
    outcomes.push(await runNativeOnce(binary.bin, init.initdb, reproCase));
  }
  return {
    engine: `pgrust native (${path.relative(REPO_ROOT, binary.bin)})`,
    version: nativeVersion(CASES[0]?.name ?? ""),
    outcomes,
  };
}

// ---- the table, and the verdict ---------------------------------------------------------------

/**
 * What each lane is expected to do with each file. PGlite must answer; a pgrust lane that RAN must
 * do what the case's note says — answer it, once `fixedIn` names the pgrust that closed the gap, and
 * otherwise refuse it with the case's own marker. A skipped lane says nothing either way.
 */
function disagreement(engineIsPgrust: boolean, reproCase: ReproCase, outcome: Outcome): string | null {
  if (outcome.kind === "skipped") return null;
  if (!engineIsPgrust) {
    return outcome.kind === "ok" ? null : `PGlite refused ${reproCase.file}: ${outcome.detail}`;
  }
  if (reproCase.fixedIn !== undefined) {
    if (outcome.kind === "ok") return null;
    const same = outcome.detail.includes(reproCase.marker) ? "the same gap, back" : "something else";
    return `pgrust refused ${reproCase.file}, which ${reproCase.fixedIn} fixed — ${same}: ${outcome.detail}`;
  }
  if (outcome.kind === "ok") {
    return `pgrust ANSWERED ${reproCase.file} (${outcome.detail}) — the gap may be closed; re-check the note`;
  }
  return outcome.detail.includes(reproCase.marker)
    ? null
    : `pgrust refused ${reproCase.file} with something else: ${outcome.detail}`;
}

const lanes: LaneResult[] = [await runPglite(), await runPgrustWasm(), await runPgrustNative()];

log("");
for (const reproCase of CASES) {
  log(`${reproCase.file}`);
  const index = CASES.indexOf(reproCase);
  for (const lane of lanes) {
    const outcome = lane.outcomes[index] ?? { kind: "skipped", detail: "(no outcome)" };
    log(`  ${lane.engine.padEnd(48)} ${outcome.kind.toUpperCase().padEnd(8)} ${outcome.detail}`);
  }
  log("");
}
for (const lane of lanes) {
  log(`${lane.engine.padEnd(48)} ${lane.version}`);
}

const problems = lanes.flatMap((lane) =>
  CASES.map((reproCase, index) =>
    disagreement(lane.engine.startsWith("pgrust"), reproCase, lane.outcomes[index] ?? { kind: "skipped", detail: "" }),
  ).filter((problem): problem is string => problem !== null),
);

log("");
if (problems.length > 0) {
  for (const problem of problems) log(`  ${problem}`);
  log("VERDICT: pgrust-repro FAIL");
  process.exit(1);
}
log("VERDICT: pgrust-repro PASS");
