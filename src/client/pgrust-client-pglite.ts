/**
 * `PgrustClientPGlite` — pgxsinkit's store contract, answered above whichever pgrust engine booted.
 *
 * **What pgxsinkit's store seam actually requires.** Its worker takes a
 * `createPglite(storePath, backendOverride?) => Promise<ClientPGlite>` and then treats what comes
 * back as PGlite: a `PGliteWithLive` (the `live` extension set up), a duck-typed `strictSync()` the
 * commitment barrier calls, `dumpDataDir(compression?)` for a store backup, a `loadDataDir`
 * create-option for a restore, `close()`, and a durability mode chosen by the registry rather than
 * by the caller. {@link PgrustPGlite} already answers everything above the transport; this file
 * answers the six that are about the STORE, and hands back an instance that satisfies the whole
 * contract.
 *
 * **Why it is its own module.** There are two pgrust boots — `./pgrust-engine.ts` under bun
 * (`node:worker_threads`, `node:fs`) and `./pgrust-browser-engine.ts` inside a browser worker
 * (`new Worker`, `fetch`, OPFS) — and everything ABOVE the boot is the same in both. Keeping the
 * client here is what lets the browser bundle exist at all: a module that statically imported the
 * bun boot would drag `node:fs` into a `<script type=module>`. Both factories build the same class
 * over the same {@link PgrustClientEngine} shape, so the two engines answer ONE contract rather than
 * two that resemble each other.
 *
 * **Where each of the six lands.**
 *
 * - `live` — PGlite's own extension, loaded verbatim by the base class. Nothing here touches it.
 * - `strictSync()` — the broker's `fsync` with NO fd, which the coordinator answers with a
 *   store-wide `strictSync()`. That opcode has always meant this ({@link RepackedSyncBroker}'s
 *   `#fsync` ignores the fd), so no pgrust change was needed to reach it.
 * - `dumpDataDir()` — a `CHECKPOINT` on the session, then `/pgdata` walked over the host's own
 *   broker channel and written with **tinytar**, the tar PGlite writes with, in PGlite's own entry
 *   layout: names relative to the datadir root with a leading `/`, a directory before its contents,
 *   dropped through the same `auto`/`gzip`/`none` rule and named after the store path's last
 *   segment. A pgxsinkit backup taken from either engine is the same artefact.
 * - `loadDataDir` — the same tarball, untarred into the store BEFORE the postmaster boots (the
 *   engine's `prepareStore` window): the coordinator has seeded `/pgdata` from the packed image, and
 *   a restore empties it and writes the backup's entries in its place. A PGlite datadir will not
 *   boot here and is not meant to — the FORMAT is shared, the datadir is not.
 * - `close()` — the whole engine, because this client is its single owner: the session's
 *   `Terminate`, then the listener EOF that is Postgres's own fast-shutdown request, then the
 *   guest's `exit(0)` under a bounded deadline, then every worker terminated so an OPFS store's
 *   handles are released. `client.stop()` in pgxsinkit calls `pglite.close()`, and this is what
 *   that means here.
 * - durability — `relaxed` is `synchronous_commit=off`, `strict` is `synchronous_commit=on`, and
 *   the BROKER is relaxed in both. The broker's own strict mode syncs the store on every mutating
 *   request, which is not what either pgxsinkit mode asks for; the guest's own fsyncs are
 *   durability boundaries in both, and `strictSync()` is the explicit one.
 *
 * **Store paths.** `memory://<name>` is the coordinator's heap — the sanctioned test/ephemeral
 * lane, and all bun can do. `opfs://<name>` is the store's OPFS port on the NESTED directory
 * pgxsinkit gives it: `pgxsinkit/stores/<identity>` (ADR-0049 D6), which pgrust's coordinator can
 * only own since it learned to walk a path.
 */

import type { Extensions, PGliteInterfaceExtensions } from "@electric-sql/pglite";
import { DIRTYPE, REGTYPE, tar, type TarFile, untar } from "tinytar";

import { PgrustPGlite, type PgrustDumpCompression, type PgrustSessionPipes } from "./pgrust-pglite";
import { PGRUST_DATADIR, type PgrustStore } from "./pgrust-store";

/**
 * How long `close()` gives the guest to exit after the listener closes, before the workers are
 * terminated regardless.
 *
 * A stopped Postgres runs its shutdown checkpoint first, which is what makes the store consistent;
 * a terminated one does not. Five seconds is the decision's deadline, and it is a deadline rather
 * than a wait: past it the workers go anyway, because a client that cannot be closed is worse than
 * a store that has to recover.
 */
export const CLOSE_EXIT_DEADLINE_MS = 5_000;

/** The MIME types PGlite's `loadTar` treats as gzipped, verbatim (`packages/pglite/src/fs/tarUtils.ts`). */
const COMPRESSED_MIME_TYPES: readonly string[] = [
  "application/x-gtar",
  "application/x-tar+gzip",
  "application/x-gzip",
  "application/gzip",
];

/**
 * Datadir entries a BACKUP never carries, by their datadir-relative name.
 *
 * `postmaster.pid` is the lock file a running postmaster owns, and PostgreSQL's own filesystem-level
 * backup rules exclude it: restored into a new store it would be a stale lock naming a process that
 * is not this one, and the next postmaster has to reason about whether that process is alive. PGlite
 * never writes one at all — it runs single-user, with no postmaster — so leaving it out is also what
 * makes the two engines' tarballs the same KIND of artefact rather than merely the same format.
 * `postmaster.opts` is the same file's argv record, and equally not part of a datadir.
 */
const BACKUP_EXCLUDED: readonly string[] = ["/postmaster.pid", "/postmaster.opts"];

/** PGlite's blob file, and the directory it needs before `COPY TO` can open it. */
const DEV_BLOB_DIRECTORY = "/dev";
const DEV_BLOB_PATH = "/dev/blob";
const EMPTY_BLOB_BYTES = new Uint8Array(0);

/** The modes a restored entry is created with when the tarball's own are unreadable. */
const DEFAULT_RESTORE_FILE_MODE = 0o644;
const DEFAULT_RESTORE_DIRECTORY_MODE = 0o755;
/** `S_IFREG` / `S_IFDIR`: tar carries permission bits only (`TPERMMASK`), so the kind is put back here. */
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;

/**
 * The three store backends a pgrust store can have here.
 *
 * `memory` and `opfs` are pgxsinkit's own two. `file` is neither — it is a DIRECTORY on this
 * machine, which no browser can open and which pgxsinkit's store-path contract never names. It
 * exists for the prepared-store lane: a store built under bun, in a place a build step can tar.
 */
export type PgrustBackend = "memory" | "opfs" | "file";

/** pgxsinkit's registry-declared durability, as `createClientPGlite` takes it. */
export type PgrustDurability = "relaxed" | "strict";

/**
 * What an engine's `shutdown()` reports: how the server actually stopped.
 *
 * `checkpointed` is the difference between a stopped Postgres and a killed one — the server log
 * showing its shutdown checkpoint — and it is the one fact a store's owner cannot get any other way.
 */
export interface PgrustEngineShutdown {
  readonly exitCode: number;
  readonly shutdownMs: number;
  /** Whether the server log shows the shutdown checkpoint — a stopped Postgres rather than a killed one. */
  readonly checkpointed: boolean;
}

/**
 * The half of a pgrust engine this client owns: its store, its sessions, and its shutdown.
 *
 * Structural on purpose. `./pgrust-engine.ts` (bun, `node:worker_threads`) and
 * `./pgrust-browser-engine.ts` (a browser worker's nested workers) are two different boots of the
 * same postmaster, and this is everything a PGlite-shaped client needs from either.
 */
export interface PgrustClientEngine {
  /** Announce one session to the postmaster and hand back its rings, unhandshaken. */
  openSession(): PgrustSessionPipes;
  /** The coordinator's store, over a broker channel of the host's own. Every method BLOCKS. */
  readonly store: PgrustStore;
  /** Close the listener — the fast-shutdown request — and wait for the guest's own `exit(0)`. */
  shutdown(): Promise<PgrustEngineShutdown>;
}

/**
 * Everything a pgrust store's options say that is not about WHERE the engine's own build outputs
 * live — the half both factories share, and the whole of what {@link attachPgrustClient} reads.
 */
export interface PgrustStoreOptions<TExtensions extends Extensions = Extensions> {
  /**
   * Which store backend, when the store path carries no scheme. A scheme-bearing path states it
   * itself, and the two must then agree.
   */
  readonly backend?: PgrustBackend;
  /**
   * The registry-declared durability (ADR-0047). `relaxed` (the default) is
   * `synchronous_commit=off`; `strict` is `synchronous_commit=on`. The broker is relaxed in both.
   */
  readonly durability?: PgrustDurability;
  /**
   * PGlite's own name for the same choice, for a caller holding a `PGliteOptions`-shaped object.
   * Read only when {@link durability} is absent; `true` means relaxed.
   */
  readonly relaxedDurability?: boolean;
  /**
   * A store-backup tarball to boot ON, exactly as PGlite's create option of this name: the datadir
   * the coordinator seeded is emptied and the tarball's entries are written in its place, before
   * the postmaster starts. It must be a PGRUST backup — a PGlite datadir has a different catalog
   * and will not boot here.
   */
  readonly loadDataDir?: File | Blob;
  /** PGlite extensions, set up on the client exactly as `PGlite.create` sets them up. */
  readonly extensions?: TExtensions;
  /** Extra `-c name=value` postmaster settings, appended after this factory's own. */
  readonly settings?: readonly string[];
  /** Extra guest environment entries, merged over the transport's own. */
  readonly env?: Readonly<Record<string, string>>;
  /**
   * `PGRUST_WAITER_RECHECK_MS`, opt-in and unset by default.
   *
   * It is the period every parked guest thread rechecks its predicate on, and turning it off (`0`)
   * is worth a quarter of an idle server's CPU — but it is also the backstop against a lost wake,
   * so nothing sets it for a caller.
   */
  readonly waiterRecheckMs?: number;
  /** The startup packet's `application_name`. */
  readonly applicationName?: string;
  /** Where the server's stderr goes. Silent by default. */
  readonly onServerLog?: (text: string) => void;
  /** How long `close()` waits for the guest's own exit; {@link CLOSE_EXIT_DEADLINE_MS} by default. */
  readonly closeDeadlineMs?: number;
  /**
   * Empty the store's directory before opening it, on either persistent backend.
   *
   * Off by default, because a persistent store's whole point is that the next open finds the last
   * one's state. The prepared-store lane turns it on: it builds a datadir from nothing every time,
   * and a directory that still held an earlier build's store would be a different store.
   */
  readonly reset?: boolean;
}

/**
 * The OPFS directory a pgxsinkit store owns, as the coordinator's `opfsDir`:
 * `pgxsinkit/stores/<identity>`, where the identity is `encodeURIComponent(storePath)`.
 *
 * Re-derived here rather than imported: `opfsStoreDirectoryPath` is internal to
 * `@pgxsinkit/client`'s `store-path.ts` (ADR-0049 D6) and the published package does not export it.
 * The encoding is the injective one that module documents — percent-encoding, never lossy
 * sanitising — so two store paths can never collapse onto one directory.
 */
export function pgxsinkitStoreDirectory(storePath: string): string {
  return `pgxsinkit/stores/${encodeURIComponent(storePath)}`;
}

/** A store path, resolved: which backend, which name, and the `dataDir` the instance reports. */
export interface ResolvedStorePath {
  readonly backend: PgrustBackend;
  readonly name: string;
  readonly dataDir: string;
}

/**
 * Resolve `memory://<name>`, `opfs://<name>`, `file://<absolute-directory>`, or a plain name plus an
 * explicit backend.
 *
 * A plain name with no backend is refused rather than defaulted: "memory" would be a silently
 * non-persistent store, and pgxsinkit's whole store-path contract exists to stop that happening by
 * accident. The thin `createPglite` adapter each factory ends in turns a plain path into a scheme.
 *
 * `file://` names a directory rather than a store identity, so its "name" is the path itself:
 * `file:///var/tmp/prepared` resolves to `/var/tmp/prepared`, absolute leading slash included.
 */
export function resolvePgrustStorePath(storePath: string, backend?: PgrustBackend): ResolvedStorePath {
  const separator = storePath.indexOf("://");
  if (separator === -1) {
    if (backend === undefined) {
      throw new Error(
        `pgrust store path ${JSON.stringify(storePath)} carries no scheme and no backend was given; ` +
          'pass "memory://<name>" or "opfs://<name>", or a plain name with `backend`',
      );
    }
    if (storePath.trim() === "") {
      throw new Error("a pgrust store path may not be empty");
    }
    if (backend === "file" && !storePath.startsWith("/")) {
      throw new Error(`a pgrust file store is a directory and must be absolute; got ${JSON.stringify(storePath)}`);
    }
    return { backend, name: storePath, dataDir: `${backend}://${storePath}` };
  }
  const scheme = storePath.slice(0, separator);
  const name = storePath.slice(separator + "://".length);
  if (scheme !== "memory" && scheme !== "opfs" && scheme !== "file") {
    throw new Error(`unknown pgrust store scheme ${JSON.stringify(scheme)}: expected "memory", "opfs" or "file"`);
  }
  if (name === "") {
    throw new Error(`pgrust store path ${JSON.stringify(storePath)} names no store`);
  }
  if (scheme === "file" && !name.startsWith("/")) {
    throw new Error(
      `pgrust store path ${JSON.stringify(storePath)} names a directory, which must be absolute ` +
        '("file:///var/tmp/store", three slashes)',
    );
  }
  if (backend !== undefined && backend !== scheme) {
    throw new Error(
      `pgrust store path ${JSON.stringify(storePath)} says ${scheme} but the backend option says ${backend}`,
    );
  }
  return { backend: scheme, name, dataDir: storePath };
}

/** Collapse the `//` a datadir-rooted entry name produces, and drop any trailing separator. */
function normalisePath(path: string): string {
  const collapsed = path.replace(/\/{2,}/g, "/");
  return collapsed.length > 1 && collapsed.endsWith("/") ? collapsed.slice(0, -1) : collapsed;
}

function parentOf(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut <= 0 ? "/" : path.slice(0, cut);
}

/**
 * Gzip, by PGlite's own rule (`maybeZip`): `none` never; otherwise `CompressionStream` when the
 * runtime has one, Node's `zlib` when it does not, and — for `auto` alone — uncompressed rather
 * than a failure.
 */
async function maybeZip(
  bytes: Uint8Array<ArrayBuffer>,
  compression: PgrustDumpCompression,
): Promise<[Uint8Array<ArrayBuffer>, boolean]> {
  if (compression === "none") {
    return [bytes, false];
  }
  if (typeof CompressionStream !== "undefined") {
    return [await through(new CompressionStream("gzip"), bytes), true];
  }
  const { promisify } = await import("node:util");
  const { gzip } = await import("node:zlib");
  return [new Uint8Array(await promisify(gzip)(bytes)), true];
}

/** Gunzip, by PGlite's own rule (`unzip`). */
async function unzip(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  if (typeof DecompressionStream !== "undefined") {
    return await through(new DecompressionStream("gzip"), bytes);
  }
  const { promisify } = await import("node:util");
  const { gunzip } = await import("node:zlib");
  return new Uint8Array(await promisify(gunzip)(bytes));
}

/** Push one buffer through a transform stream and collect what comes out. */
async function through(
  stream: CompressionStream | DecompressionStream,
  bytes: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  // Deliberately not awaited before the reads start: a big buffer fills the transform's queue, and
  // the write only settles once the reader has drained it.
  const written = writer.write(bytes).then(async () => await writer.close());
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    if (value !== undefined) {
      chunks.push(value);
      total += value.byteLength;
    }
  }
  await written;
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

/**
 * The datadir as tar entries, in PGlite's `readDirectory` layout.
 *
 * Names are the path with the datadir root removed, which leaves the leading `/` PGlite's own
 * entries carry (`fullPath.substring(path.length)`), and a directory is listed before anything
 * inside it. `size` is the store's, `data` empty for a directory — exactly what `createTarball`
 * hands `tar()`.
 */
function datadirEntries(store: PgrustStore): TarFile[] {
  return store
    .walk(PGRUST_DATADIR)
    .filter((entry) => !BACKUP_EXCLUDED.includes(entry.path.substring(PGRUST_DATADIR.length)))
    .map((entry) => ({
      name: entry.path.substring(PGRUST_DATADIR.length),
      mode: entry.mode,
      size: entry.size,
      type: entry.kind === "directory" ? DIRTYPE : REGTYPE,
      modifyTime: new Date(entry.mtimeMs),
      data: entry.kind === "directory" ? new Uint8Array(0) : store.readFile(entry.path),
    }));
}

/** Untar a backup exactly as PGlite's `loadTar` does, gzip sniffing and corrupt-retry included. */
async function readBackup(file: File | Blob): Promise<ReturnType<typeof untar>> {
  let tarball: Uint8Array<ArrayBuffer> = new Uint8Array(await file.arrayBuffer());
  const filename = typeof File !== "undefined" && file instanceof File ? file.name : undefined;
  const compressed =
    COMPRESSED_MIME_TYPES.includes(file.type) ||
    filename?.endsWith(".tgz") === true ||
    filename?.endsWith(".tar.gz") === true;
  if (compressed) {
    tarball = await unzip(tarball);
  }
  try {
    return untar(tarball);
  } catch (error: unknown) {
    // PGlite's own fallback: a gzipped tarball with the wrong mime type reads as corrupt.
    if (error instanceof Error && error.message.includes("File is corrupted")) {
      return untar(await unzip(tarball));
    }
    throw error;
  }
}

/**
 * Replace the seeded `/pgdata` with a backup's entries.
 *
 * Runs in the window between the coordinator's seed and the guest's first instruction, which is the
 * only time a whole datadir may be swapped: after it, a postmaster owns those files. The seed's own
 * `/pgdata` DIRECTORY is kept — its mode is the one Postgres validates at startup — and only its
 * contents go.
 */
export async function restoreDatadir(store: PgrustStore, backup: File | Blob): Promise<number> {
  const files = await readBackup(backup);
  store.emptyDirectory(PGRUST_DATADIR);
  for (const file of files) {
    const path = normalisePath(`${PGRUST_DATADIR}/${file.name}`);
    if (path === PGRUST_DATADIR) {
      continue;
    }
    // tar carries permission bits only (`TPERMMASK`), so the kind goes back on here; the store
    // tracks kind separately and never reads it out of the mode, so this is fidelity, not function.
    const permissions =
      file.mode ?? (file.type === DIRTYPE ? DEFAULT_RESTORE_DIRECTORY_MODE : DEFAULT_RESTORE_FILE_MODE);
    if (file.type === DIRTYPE) {
      store.mkdirp(path, S_IFDIR | permissions);
      continue;
    }
    store.mkdirp(parentOf(path));
    store.writeFile(path, file.data ?? new Uint8Array(0), S_IFREG | permissions);
  }
  // A durability boundary before the postmaster reads a byte, exactly as the coordinator's own seed
  // ends with one.
  store.strictSync();
  return files.length;
}

/**
 * A {@link PgrustPGlite} that owns its engine and its store.
 *
 * The three overrides are the whole difference: `strictSync`, `dumpDataDir` and a `close` that
 * takes the server down with it. Everything else — the wire, the type registries, `live` — is the
 * base class's, unchanged.
 */
export class PgrustClientPGlite extends PgrustPGlite {
  readonly #engine: PgrustClientEngine;
  readonly #store: PgrustStore;
  readonly #dataDir: string;
  readonly #closeDeadlineMs: number;
  #shutdown: PgrustEngineShutdown | undefined;

  constructor(
    engine: PgrustClientEngine,
    session: PgrustSessionPipes,
    resolved: ResolvedStorePath,
    options: { readonly extensions?: Extensions; readonly applicationName?: string; readonly closeDeadlineMs: number },
  ) {
    super(session, {
      ...(options.extensions ? { extensions: options.extensions } : {}),
      applicationName: options.applicationName ?? "pgxsinkit-pgrust",
    });
    this.#engine = engine;
    this.#store = engine.store;
    this.#dataDir = resolved.dataDir;
    this.#closeDeadlineMs = options.closeDeadlineMs;
  }

  /**
   * The store URL this instance opened, as PGlite reports its own `dataDir`.
   *
   * pgxsinkit reads it to classify a bring-your-own instance (`classifyNonPersistentDataDir`): a
   * `memory://` store is refused without the testing acknowledgment, an `opfs://` one passes. Both
   * answers are the true ones here.
   */
  get dataDir(): string {
    return this.#dataDir;
  }

  /** What the engine's shutdown reported. `undefined` until {@link close} has run. */
  get engineShutdown(): PgrustEngineShutdown | undefined {
    return this.#shutdown;
  }

  /**
   * The coordinator's store, over this host's own broker channel.
   *
   * The two things a wire client cannot ask its server: what the datadir actually holds on disk, and
   * a store-wide durability boundary. Live only while the engine is — after `close()` the doorbell
   * has stopped and every call would time out. See {@link PgrustStore}; every method BLOCKS.
   */
  get store(): PgrustStore {
    return this.#store;
  }

  /**
   * The store-wide durability boundary the commitment barrier calls (ADR-0049 D7).
   *
   * `fsync` with no fd on the broker, which the coordinator answers with `strictSync()` over the
   * whole store: arena before metadata, and the store's own health check inside it. It resolves
   * only when that returned, which is the barrier's requirement — data before authority.
   */
  async strictSync(): Promise<void> {
    await this._checkReady();
    this.#store.strictSync();
  }

  /**
   * `/dev/blob` — the file `COPY … FROM '/dev/blob'` reads and `COPY … TO '/dev/blob'` writes.
   *
   * PGlite makes it a character device inside its own emscripten FS, and the base client here
   * refuses the whole facility on the grounds that a wire client has no filesystem. That is true of
   * the base client and false of this one: the coordinator's store IS the guest's root filesystem
   * (`/pgdata` and `/share` are two directories in it), so the host can put a real file at
   * `/dev/blob` over the broker channel and the backend opens it like any other. `pg_read_file`,
   * `COPY FROM` and `COPY TO` all see it — nothing in the guest is special-cased.
   *
   * The three hooks map onto PGlite's own semantics rather than onto files: `_handleBlob` stages the
   * query's input, `_cleanupBlob` drops it the moment the query is done (the base calls it before
   * asking for the output, which is what keeps an input from being read back as one), and
   * `_getWrittenBlob` takes whatever the backend left and empties the file behind it. A blobless
   * query costs one `lstat` and nothing else; an instance that never runs `COPY` still creates the
   * empty file once, because `COPY TO` needs the directory to exist before Postgres opens the path.
   */
  #devBlobReady = false;
  /** Whether the CURRENT query's input bytes are sitting in the file. */
  #devBlobStaged = false;

  #ensureDevBlob(): void {
    if (this.#devBlobReady) {
      return;
    }
    this.#store.mkdirp(DEV_BLOB_DIRECTORY);
    this.#store.writeFile(DEV_BLOB_PATH, EMPTY_BLOB_BYTES);
    this.#devBlobReady = true;
  }

  override async _handleBlob(blob?: File | Blob): Promise<void> {
    this.#ensureDevBlob();
    if (blob === undefined) {
      return;
    }
    this.#store.writeFile(DEV_BLOB_PATH, new Uint8Array(await blob.arrayBuffer()));
    this.#devBlobStaged = true;
  }

  override async _cleanupBlob(): Promise<void> {
    if (!this.#devBlobStaged) {
      return;
    }
    this.#store.writeFile(DEV_BLOB_PATH, EMPTY_BLOB_BYTES);
    this.#devBlobStaged = false;
  }

  override async _getWrittenBlob(): Promise<File | Blob | undefined> {
    if (!this.#devBlobReady) {
      return undefined;
    }
    const size = Number(this.#store.lstat(DEV_BLOB_PATH).size);
    if (size === 0) {
      return undefined;
    }
    const bytes = this.#store.readFile(DEV_BLOB_PATH);
    this.#store.writeFile(DEV_BLOB_PATH, EMPTY_BLOB_BYTES);
    return new Blob([bytes.slice().buffer]);
  }

  /**
   * The datadir as a tarball, in PGlite's layout and PGlite's flavour.
   *
   * A `CHECKPOINT` first, through the session's own query path, so what the walk reads is committed
   * state rather than a torn mid-write datadir — the same thing PGlite's callers do, and the same
   * thing pgxsinkit's `performDatadirDump` does one level up (running it twice costs a no-op
   * checkpoint). Then `/pgdata` is walked over the host's broker channel and written with tinytar.
   *
   * The name is the store path's last segment, as PGlite names its own dump after its dataDir's.
   */
  override async dumpDataDir(compression: PgrustDumpCompression = "auto"): Promise<File | Blob> {
    await this._checkReady();
    await this.exec("CHECKPOINT");
    const tarball = tar(datadirEntries(this.#store));
    const [bytes, zipped] = await maybeZip(tarball, compression);
    const name = `${this.#dataDir.split("/").pop() ?? "pgdata"}${zipped ? ".tar.gz" : ".tar"}`;
    const type = zipped ? "application/x-gzip" : "application/x-tar";
    const blob = bytes.slice().buffer;
    return typeof File !== "undefined" ? new File([blob], name, { type }) : new Blob([blob], { type });
  }

  /**
   * End the session AND the server: this client is the store's single owner.
   *
   * In order: the base class's own close (extension teardown, `Terminate`, the backend's EOF), then
   * the engine's shutdown — the listener closing, which `pqcomm_hostpipes` turns into the very
   * handler a SIGINT runs, so Postgres writes its shutdown checkpoint and exits itself. Past the
   * deadline every worker is terminated regardless, which is what releases an OPFS store's four
   * exclusive handles.
   */
  override async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    // Bounded, and never fatal: a session that will not answer its `Terminate` must not stop the
    // server being taken down, which is the part that matters.
    await Promise.race([
      super.close().catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, this.#closeDeadlineMs)),
    ]);
    // One explicit durability boundary while the coordinator is still answering, before the server
    // is asked to go. The shutdown that follows already ends in a checkpoint and the coordinator's
    // own `strictSync()` + `close()`; this is the one that is this client's to ask for, and it is
    // what makes a persistent store's four files consistent even if the guest's exit is not clean.
    // Never fatal: a store that cannot be synced must not stop the server being taken down.
    try {
      this.#store.strictSync();
    } catch {
      // The engine's shutdown reports what actually happened; a failed pre-sync adds nothing to it.
    }
    this.#shutdown = await this.#engine.shutdown();
  }
}

/**
 * The durability an options bag selects: this repo's own name for it, else PGlite's, else relaxed.
 *
 * `relaxedDurability` is PGlite's boolean for the same choice and the only durability signal some
 * callers have; `durability` wins when both are present.
 */
export function pgrustDurabilityOf(options: {
  readonly durability?: PgrustDurability;
  readonly relaxedDurability?: boolean;
}): PgrustDurability {
  return options.durability ?? (options.relaxedDurability === false ? "strict" : "relaxed");
}

/**
 * The postmaster settings a store's durability implies, ahead of the caller's own.
 *
 * `relaxed` is `synchronous_commit=off`: a commit returns before its WAL record is flushed, which is
 * the trade pgxsinkit's relaxed mode makes everywhere. `strict` is Postgres's own default, stated.
 * The caller's `-c` entries come last, so a duplicate of theirs wins.
 */
export function pgrustDurabilitySettings(
  durability: PgrustDurability,
  extra: readonly string[] | undefined,
): readonly string[] {
  return [`synchronous_commit=${durability === "strict" ? "on" : "off"}`, ...(extra ?? [])];
}

/** The guest environment entries a store's options add, the caller's own last. */
export function pgrustGuestEnv(options: {
  readonly waiterRecheckMs?: number;
  readonly env?: Readonly<Record<string, string>>;
}): Readonly<Record<string, string>> {
  return {
    ...(options.waiterRecheckMs === undefined ? {} : { PGRUST_WAITER_RECHECK_MS: String(options.waiterRecheckMs) }),
    ...options.env,
  };
}

/**
 * pgxsinkit's "this instance is a PROVABLY persistent OPFS store" brand.
 *
 * A well-known symbol (`Symbol.for`, so it crosses module copies), and the ONLY proof the toolkit
 * accepts for an ADOPTED instance. It matters because of what the client does without it: a store
 * minted through the seam and then adopted by the boot (`precreatedPglite` — the provision-then-attach
 * accelerator) skips the pre-mint phase machine, so the toolkit runs its commitment barrier
 * (`strictSync` -> sentinel -> `opfs-committed`) only when `resolveAdoptedCommitmentBarrier` is
 * reached — and THAT is gated on this brand. Unbranded, the store's meta record stays at
 * `opfs-candidate` for its whole life, and the NEXT boot reads that as a torn candidate and DELETES
 * the directory. Observed exactly that way on the board: everything green, then a reload answering
 * `Could not start the local sync engine: removeEntry … modifications are not allowed`.
 *
 * The toolkit's own doc for the brand says an opfs-repacked store "reports no `dataDir`", which is why
 * nothing else can identify one. This engine's instances DO report `opfs://<name>` — but the gate
 * keys on the brand, not on the URL, so an external factory that wants the commitment barrier has to
 * stamp it. Only for the OPFS port: a `memory://` store is not persistent and must keep failing the
 * toolkit's own non-persistent-store guard.
 */
const OPFS_REPACKED_PERSISTENT = Symbol.for("pgxsinkit.opfsRepackedPersistent");

/**
 * Open one session on a booted engine and hand back the client that owns it.
 *
 * The last third of every pgrust factory, bun and browser alike: one session, one client, and a
 * client that never became ready taking the engine down with it — a half-open boot still holds a
 * postmaster and, on OPFS, four exclusive handles.
 */
export async function attachPgrustClient<TExtensions extends Extensions = Extensions>(
  engine: PgrustClientEngine,
  resolved: ResolvedStorePath,
  options: PgrustStoreOptions<TExtensions>,
): Promise<PgrustClientPGlite & PGliteInterfaceExtensions<TExtensions>> {
  try {
    const instance = new PgrustClientPGlite(engine, engine.openSession(), resolved, {
      ...(options.extensions ? { extensions: options.extensions } : {}),
      ...(options.applicationName ? { applicationName: options.applicationName } : {}),
      closeDeadlineMs: options.closeDeadlineMs ?? CLOSE_EXIT_DEADLINE_MS,
    });
    await instance.waitReady;
    if (resolved.backend === "opfs") {
      // Best-effort: an engine that could not be branded still works for one session, and the
      // toolkit falls back to classifying the `dataDir` for its non-persistence guard.
      try {
        Object.defineProperty(instance, OPFS_REPACKED_PERSISTENT, {
          value: true,
          enumerable: false,
          configurable: true,
        });
      } catch {
        // A frozen/exotic instance; nothing else here depends on the brand.
      }
    }
    return instance as PgrustClientPGlite & PGliteInterfaceExtensions<TExtensions>;
  } catch (error: unknown) {
    // A client that never became ready still left a postmaster running and, on OPFS, four
    // exclusively held handles.
    await engine.shutdown().catch(() => {});
    throw error;
  }
}
