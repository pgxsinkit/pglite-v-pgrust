/**
 * The pgrust store, from the host's side of the broker.
 *
 * **Why the host needs one at all.** A pgrust datadir lives in the storage coordinator's repacked
 * store, not in this process: the guest reaches it over a `SharedArrayBuffer` channel through the
 * WASI adapter, and nothing above pgwire can see a file. `dumpDataDir` and `loadDataDir` are
 * exactly the two things PGlite does through its own emscripten `FS` and this transport cannot —
 * one reads the whole datadir out, the other writes a whole datadir in **before a postmaster
 * exists** — so the host takes a broker channel of its own and speaks the same protocol every
 * guest thread speaks. `strictSync()` is the third: the store-wide sync is `fsync` with no fd, and
 * the broker has answered it that way since the protocol existed (`RepackedSyncBroker#fsync`
 * ignores the fd and calls `vfs.strictSync()`), so no host change was needed to reach it.
 *
 * **This blocks.** `RepackedSyncClient` parks the calling agent in `Atomics.wait` until the
 * coordinator answers — that is the whole point of the synchronous half of the protocol, and it is
 * why a guest thread can use it from inside wasm. On the host it means every method here may only
 * be called where blocking is allowed: bun's main thread and any Worker, never a browser's main
 * thread. It is the same rule {@link PgrustPGlite.execProtocolRawStream} follows.
 *
 * **Errors are errnos.** The broker answers `{ errno }` rather than throwing, so every call here
 * turns a non-zero errno into an `Error` naming the operation, the path and the errno's own name —
 * a bare `errno 44` in a stack trace is worth nothing.
 */

import type { RepackedBundle, RepackedStat, RepackedSyncClient } from "../vendor/pgrust/broker-fs.js";

/** The datadir the coordinator seeds and the guest boots from. pgrust's own, and not configurable. */
export const PGRUST_DATADIR = "/pgdata";

/** One entry of a walk, with the store's own metadata; `path` is absolute, `name` is the leaf. */
export interface PgrustStoreEntry {
  readonly path: string;
  readonly name: string;
  readonly kind: "directory" | "file";
  readonly mode: number;
  readonly size: number;
  readonly mtimeMs: number;
}

/** The default file mode a restored file is created with when the tarball carries none. */
const DEFAULT_FILE_MODE = 0o666;
/** The default directory mode, matching the store's own `mkdir` default. */
const DEFAULT_DIRECTORY_MODE = 0o777;

function joinPath(directory: string, name: string): string {
  return directory === "/" ? `/${name}` : `${directory}/${name}`;
}

/**
 * The coordinator's store, as this host sees it.
 *
 * A thin, typed, throwing facade over the broker's synchronous client: the calls are the store's
 * own (`readdir`/`lstat`/`open`/`read`/`write`/`mkdir`/`unlink`), and nothing here caches, because
 * the guest is writing to the same store at the same time.
 */
export class PgrustStore {
  readonly #client: RepackedSyncClient;
  readonly #bundle: RepackedBundle;

  constructor(client: RepackedSyncClient, bundle: RepackedBundle) {
    this.#client = client;
    this.#bundle = bundle;
  }

  #fail(operation: string, path: string, errno: number): never {
    throw new Error(`pgrust store: ${operation} ${path} failed with ${this.#bundle.errnoName(errno)}`);
  }

  /** Whether `path` exists at all. A missing path is a fact, not a failure; anything else throws. */
  exists(path: string): boolean {
    const answer = this.#client.lstat(path);
    if (answer.errno === 0) {
      return true;
    }
    if (answer.errno === this.#bundle.WASI_ERRNO["NOENT"]) {
      return false;
    }
    return this.#fail("lstat", path, answer.errno);
  }

  lstat(path: string): RepackedStat {
    const answer = this.#client.lstat(path);
    if (answer.errno !== 0 || answer.stat === undefined) {
      return this.#fail("lstat", path, answer.errno);
    }
    return answer.stat;
  }

  readdir(path: string): readonly string[] {
    const answer = this.#client.readdir(path);
    if (answer.errno !== 0) {
      return this.#fail("readdir", path, answer.errno);
    }
    return answer.entries;
  }

  readFile(path: string): Uint8Array {
    const stat = this.lstat(path);
    const opened = this.#client.open(path, this.#bundle.O_RDONLY);
    if (opened.errno !== 0) {
      return this.#fail("open", path, opened.errno);
    }
    try {
      const answer = this.#client.read(opened.fd, Number(stat.size), 0n);
      if (answer.errno !== 0) {
        return this.#fail("read", path, answer.errno);
      }
      return answer.bytes;
    } finally {
      this.#client.close(opened.fd);
    }
  }

  writeFile(path: string, bytes: Uint8Array, mode: number = DEFAULT_FILE_MODE): void {
    const flags = this.#bundle.O_WRONLY | this.#bundle.O_CREAT | this.#bundle.O_TRUNC;
    const opened = this.#client.open(path, flags, mode);
    if (opened.errno !== 0) {
      this.#fail("open", path, opened.errno);
    }
    try {
      const answer = this.#client.write(opened.fd, bytes, 0n);
      if (answer.errno !== 0) {
        this.#fail("write", path, answer.errno);
      }
      if (answer.count !== bytes.byteLength) {
        throw new Error(`pgrust store: write ${path} took ${answer.count} of ${bytes.byteLength} bytes`);
      }
    } finally {
      this.#client.close(opened.fd);
    }
  }

  /** Create `path` and every parent. Already there is success, exactly as `mkdir -p` is. */
  mkdirp(path: string, mode: number = DEFAULT_DIRECTORY_MODE): void {
    const answer = this.#client.mkdir(path, { recursive: true, mode });
    if (answer.errno === 0 || answer.errno === this.#bundle.WASI_ERRNO["EXIST"]) {
      return;
    }
    this.#fail("mkdir", path, answer.errno);
  }

  /**
   * Every entry under `root`, in PGlite's own `readDirectory` order: a directory is listed before
   * the entries inside it, and each level in the store's own `readdir` order. That order is what
   * makes a tarball restorable in one forward pass, and it is what PGlite's `createTarball`
   * produces, so a pgrust tarball and a PGlite one have the same shape as well as the same bytes.
   *
   * `lstat`, so a symlink (a tablespace link) is reported where it is rather than followed into a
   * second tree. The broker's wire has two kinds only, so a symlink arrives here as a file.
   */
  walk(root: string): readonly PgrustStoreEntry[] {
    const entries: PgrustStoreEntry[] = [];
    const visit = (directory: string): void => {
      for (const name of this.readdir(directory)) {
        if (name === "." || name === "..") {
          continue;
        }
        const path = joinPath(directory, name);
        const stat = this.lstat(path);
        entries.push({
          path,
          name,
          kind: stat.kind,
          mode: stat.mode,
          size: Number(stat.size),
          mtimeMs: Number(stat.mtimeMs),
        });
        if (stat.kind === "directory") {
          visit(path);
        }
      }
    };
    visit(root);
    return entries;
  }

  /** Empty `path` of everything, leaving the directory itself. Depth first, because `rmdir` needs it. */
  emptyDirectory(path: string): void {
    const entries = this.walk(path);
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (entry === undefined) {
        continue;
      }
      const answer = entry.kind === "directory" ? this.#client.rmdir(entry.path) : this.#client.unlink(entry.path);
      if (answer.errno !== 0) {
        this.#fail(entry.kind === "directory" ? "rmdir" : "unlink", entry.path, answer.errno);
      }
    }
  }

  /**
   * The store-wide durability boundary: `fsync` with NO fd, which the broker answers by calling
   * `strictSync()` on the whole store. On a clean store it touches no handle, so asking twice
   * costs nothing.
   */
  strictSync(): void {
    const answer = this.#client.fsync();
    if (answer.errno !== 0) {
      this.#fail("fsync", "<store>", answer.errno);
    }
  }
}
