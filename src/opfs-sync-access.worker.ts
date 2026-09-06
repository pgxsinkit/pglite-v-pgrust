/**
 * The OPFS synchronous-access-handle probe, as a dedicated worker.
 *
 * `createSyncAccessHandle()` exists only in a worker scope, and its presence proves nothing:
 * Chromium and Firefox grant it in a dedicated worker and deny it in a SharedWorker, and
 * Playwright's WebKitGTK build denies it in both. So this asks for a real handle on a real file, in
 * exactly the worker kind the `opfs-repacked` store will run in, and reports what happened. The
 * probe file and its directory are removed either way — a capability check must leave no state.
 *
 * It is not an Engine and speaks no Engine protocol: it posts one message and is terminated.
 */

import { emptyOpfsDirectory, OPFS_PROBE_DIRECTORY, OPFS_PROBE_FILE, removeOpfsDirectory } from "./opfs";
import type { OpfsSyncAccessProbe } from "./opfs-sync-access";

const ctx = self as unknown as DedicatedWorkerGlobalScope;

function describe(error: unknown): string {
  if (error instanceof Error) {
    return error.name === "" || error.name === "Error" ? error.message : `${error.name}: ${error.message}`;
  }
  return String(error);
}

async function probe(): Promise<OpfsSyncAccessProbe> {
  try {
    const directory = await emptyOpfsDirectory(OPFS_PROBE_DIRECTORY);
    try {
      const file = await directory.getFileHandle(OPFS_PROBE_FILE, { create: true });
      if (typeof file.createSyncAccessHandle !== "function") {
        return { available: false, reason: "FileSystemFileHandle.createSyncAccessHandle is not implemented" };
      }
      const handle = await file.createSyncAccessHandle();
      handle.close();
      return { available: true };
    } finally {
      await removeOpfsDirectory(OPFS_PROBE_DIRECTORY);
    }
  } catch (error: unknown) {
    return { available: false, reason: describe(error) };
  }
}

void probe().then(
  (result) => {
    ctx.postMessage(result);
  },
  (error: unknown) => {
    // `probe` already catches; this only exists so a thrown cleanup error still answers the caller.
    ctx.postMessage({ available: false, reason: describe(error) } satisfies OpfsSyncAccessProbe);
  },
);
