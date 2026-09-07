/**
 * The browser half of the prepared-store lane: a tarball in, four OPFS files out.
 *
 * One worker, one job, and it is gone before the storage coordinator starts. It exists at all
 * because of where the work has to happen: writing a store's files means
 * `createSyncAccessHandle()`, which is granted in a dedicated worker and refused on the window's
 * main thread, and the storage coordinator cannot do it itself — that worker is pgrust's, vendored
 * byte-verbatim, and teaching it to read a tar would mean writing a tar reader into a file that must
 * stay identical to its source. tinytar is already a dependency here, so this side is the smaller
 * change by a wide margin.
 *
 * WHAT IT DOES, in the order it matters.
 *
 *  1. gunzip (`DecompressionStream("gzip")`), untar (tinytar);
 *  2. read `manifest.json` — the FIRST entry — and check every size and every digest against the
 *     four files, BEFORE a byte is written. The destination is a store directory, and a half-written
 *     store is worse than no store: the store fails closed on a format identity it does not accept,
 *     and the only sanctioned repair is deleting the whole directory;
 *  3. empty the OPFS directory and write the four files, `activation.bin` last, each through one
 *     sync access handle that is truncated, written, flushed and closed;
 *  4. report, and let the caller terminate it.
 *
 * What it does NOT do is open the store. The coordinator does that, on the `opfs` port with
 * `reset: false`, and finds a datadir already there — so its own fresh/existing fork reports
 * `restored: true` and skips the packed-image seed entirely. That is the whole trick: the datadir
 * arrives as four files rather than as some thousands, and nothing replays it.
 */

import { untar } from "tinytar";

import { emptyOpfsDirectory } from "../../opfs";
import {
  gunzip,
  parsePreparedStoreManifest,
  PREPARED_STORE_MANIFEST_NAME,
  PREPARED_STORE_OWNED_FILES,
  verifyPreparedStoreFiles,
} from "../../prepared-store-format";
import type { PreparedStoreManifest } from "../../prepared-store-format";

const ctx = self as unknown as DedicatedWorkerGlobalScope;

/** What the postmaster worker sends. The tarball is transferred, not copied: it is a big buffer. */
export interface StoreSeedRequest {
  readonly kind: "seed";
  /** The OPFS directory the store will own, as a `/`-separated path — the coordinator's `opfsDir`. */
  readonly opfsDir: string;
  /** The whole `.repacked.tar.gz`. */
  readonly tar: ArrayBuffer;
}

/** Every phase timed separately, because which of them costs anything is the finding. */
export interface StoreSeedTimings {
  readonly gunzipMs: number;
  readonly untarMs: number;
  readonly verifyMs: number;
  readonly writeMs: number;
  readonly totalMs: number;
}

export interface StoreSeedDone {
  readonly type: "seeded";
  readonly timings: StoreSeedTimings;
  /** Bytes actually written into OPFS: the four files' sizes, which is the store's size on disk. */
  readonly bytesWritten: number;
  readonly tarBytes: number;
  readonly manifest: PreparedStoreManifest;
}

export interface StoreSeedFailed {
  readonly type: "seed-error";
  readonly message: string;
}

export type StoreSeedResponse = StoreSeedDone | StoreSeedFailed;

/** The structural slice of a sync access handle this worker uses; a real one satisfies it. */
interface SyncAccessHandle {
  write(source: Uint8Array, options: { at: number }): number;
  truncate(size: number): void;
  flush(): void;
  close(): void;
}

interface SyncAccessCapableFileHandle {
  createSyncAccessHandle(): Promise<SyncAccessHandle>;
}

/**
 * Write one file whole, through one sync access handle.
 *
 * Truncate first, so a directory that somehow still held a longer file of this name cannot leave a
 * tail behind; `flush` before `close`, because `close` is not documented to be a durability
 * boundary and the next thing to touch these bytes is a different agent entirely.
 */
async function writeOpfsFile(directory: FileSystemDirectoryHandle, name: string, bytes: Uint8Array): Promise<number> {
  const file = (await directory.getFileHandle(name, { create: true })) as unknown as SyncAccessCapableFileHandle;
  const handle = await file.createSyncAccessHandle();
  try {
    handle.truncate(bytes.byteLength);
    let written = 0;
    while (written < bytes.byteLength) {
      const count = handle.write(bytes.subarray(written), { at: written });
      if (!Number.isSafeInteger(count) || count <= 0) {
        throw new Error(`writing ${name} made no progress at offset ${written}`);
      }
      written += count;
    }
    handle.flush();
    return written;
  } finally {
    handle.close();
  }
}

async function seed(request: StoreSeedRequest): Promise<StoreSeedDone> {
  const startedAt = performance.now();
  const tarBytes = request.tar.byteLength;

  const gunzipAt = performance.now();
  const tarball = await gunzip(new Uint8Array(request.tar));
  const gunzipMs = performance.now() - gunzipAt;

  const untarAt = performance.now();
  const entries = untar(tarball);
  const untarMs = performance.now() - untarAt;

  const byName = new Map<string, Uint8Array>();
  for (const entry of entries) {
    byName.set(entry.name.replace(/^\.?\//, ""), entry.data ?? new Uint8Array(0));
  }
  const manifestBytes = byName.get(PREPARED_STORE_MANIFEST_NAME);
  if (manifestBytes === undefined) {
    throw new Error(`the tarball carries no ${PREPARED_STORE_MANIFEST_NAME}; it is not a prepared store`);
  }

  const verifyAt = performance.now();
  const manifest = parsePreparedStoreManifest(new TextDecoder().decode(manifestBytes));
  await verifyPreparedStoreFiles(manifest, byName);
  const verifyMs = performance.now() - verifyAt;

  const writeAt = performance.now();
  // Emptied, not merged: the store owns this directory in full, and anything already in it belongs
  // to a store that is about to stop existing.
  const directory = await emptyOpfsDirectory(request.opfsDir);
  let bytesWritten = 0;
  for (const name of PREPARED_STORE_OWNED_FILES) {
    bytesWritten += await writeOpfsFile(directory, name, byName.get(name) ?? new Uint8Array(0));
  }
  const writeMs = performance.now() - writeAt;

  return {
    type: "seeded",
    timings: { gunzipMs, untarMs, verifyMs, writeMs, totalMs: performance.now() - startedAt },
    bytesWritten,
    tarBytes,
    manifest,
  };
}

ctx.addEventListener("message", (event: MessageEvent<StoreSeedRequest>) => {
  const request = event.data;
  if (request.kind !== "seed") {
    return;
  }
  seed(request).then(
    (done) => {
      ctx.postMessage(done);
    },
    (error: unknown) => {
      const message: StoreSeedFailed = {
        type: "seed-error",
        message: error instanceof Error ? (error.stack ?? error.message) : String(error),
      };
      ctx.postMessage(message);
    },
  );
});
