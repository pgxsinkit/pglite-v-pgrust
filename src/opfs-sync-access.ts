/**
 * Whether an OPFS synchronous access handle can actually be opened here.
 *
 * The `opfs-repacked` store the two Storage Configurations run on needs `createSyncAccessHandle()`
 * to succeed in a dedicated worker. That cannot be answered from the main thread — the method is
 * worker-only — and it cannot be answered by feature detection either: Playwright's WebKitGTK build
 * exposes the method and denies the handle. So the answer comes from a real handle opened in a real
 * dedicated worker, at environment-detection time, once per page load, before anything is run.
 *
 * This is the OPFS twin of `detectJspi`: a browser capability the environment header reports and the
 * availability gate reads, never a property of a Configuration.
 */

/** What the probe worker posts back. `reason` is present only when the handle was refused. */
export interface OpfsSyncAccessProbe {
  readonly available: boolean;
  readonly reason?: string;
}

/** A probe that neither answers nor fails is a hung page; a browser that grants handles is instant. */
const PROBE_TIMEOUT_MS = 15_000;

function createProbeWorker(): Worker {
  return new Worker(new URL("./opfs-sync-access.worker.ts", import.meta.url), { type: "module" });
}

/**
 * Run the probe once and terminate its worker, whatever the outcome.
 *
 * Never rejects: a probe that cannot start is the same answer as a probe that was refused — the
 * store cannot run here — and the reason is what the column header will show.
 */
export async function detectOpfsSyncAccess(): Promise<OpfsSyncAccessProbe> {
  let worker: Worker;
  try {
    worker = createProbeWorker();
  } catch (error: unknown) {
    return { available: false, reason: `OPFS probe worker failed to start: ${describeError(error)}` };
  }
  try {
    return await awaitProbe(worker);
  } finally {
    worker.terminate();
  }
}

function awaitProbe(worker: Worker): Promise<OpfsSyncAccessProbe> {
  return new Promise<OpfsSyncAccessProbe>((resolve) => {
    const timer = setTimeout(() => {
      settle({ available: false, reason: `OPFS probe timed out after ${PROBE_TIMEOUT_MS} ms` });
    }, PROBE_TIMEOUT_MS);
    const onMessage = (event: MessageEvent<OpfsSyncAccessProbe>): void => {
      settle(event.data);
    };
    const onError = (event: Event): void => {
      settle({
        available: false,
        reason: event instanceof ErrorEvent && event.message !== "" ? event.message : "OPFS probe worker error",
      });
    };
    const settle = (result: OpfsSyncAccessProbe): void => {
      clearTimeout(timer);
      worker.removeEventListener("message", onMessage);
      worker.removeEventListener("error", onError);
      worker.removeEventListener("messageerror", onError);
      resolve(result);
    };
    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", onError);
    worker.addEventListener("messageerror", onError);
  });
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
