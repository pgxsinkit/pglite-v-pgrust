/**
 * `createPgrustPglite` for a BROWSER — pgxsinkit's local-store seam, answered by a pgrust postmaster
 * booted inside the worker that asks for it.
 *
 * **What the seam is.** pgxsinkit's board reads one build-time variable
 * (`VITE_BOARD_STORE_FACTORY=<absolute module URL>`), imports that module, and takes its default
 * export as `(storePath: string, backendOverride?: "memory") => Promise<ClientPGlite>`
 * (`apps/board/docs/local-store-seam.md`). Every local store the app opens is then minted by THAT
 * function. This file is that function, on this engine — {@link storeFactory} is the default export
 * and everything else here is what it needs.
 *
 * **What the seam passes, and what it therefore does not.** A plain store NAME and, in a test lane,
 * a `"memory"` backend override. Nothing else: no asset base, no storage layout, no isolation
 * arrangements. So this module owns all three.
 *
 * - *Assets.* `import.meta.url` — wherever this bundle is served from, `./pgrust/` sits beside it
 *   (`postgres-threads.wasm`, `vfs.img`, `vfs.json`, and the vendored host plus the store bundle
 *   under `host/`). `scripts/package-store-engine.ts` is what lays that shape down. Same-origin,
 *   necessarily: `new Worker(url)` refuses a cross-origin script, and the host spawns several.
 * - *Storage layout.* `opfs://<name>` opens the OPFS directory the toolkit's own store-path contract
 *   implies — `pgxsinkit/stores/<identity>` (ADR-0049 D6) — so a store this engine minted is in the
 *   place pgxsinkit looks for one. `memory://<name>` and a `"memory"` override are the coordinator's
 *   heap.
 * - *Isolation.* The pgrust threads build is `SharedArrayBuffer` plus a shared `WebAssembly.Memory`,
 *   which a browser hands out only on a cross-origin-isolated page (`VITE_BOARD_ISOLATED=1`), and
 *   its store client blocks in `Atomics.wait`, which a window's main thread may not do. Both are
 *   checked before anything is fetched, and both fail with the reason rather than with a deadlock —
 *   the in-process fallback engine home, which would call this on the main thread, is NOT a place
 *   this engine can run.
 *
 * **`live` is set up unconditionally.** The seam hands back a handle that is used exactly as a
 * `createClientPGlite` one is, and the engine's live-query manager subscribes through
 * `pglite.live` — but the seam passes no `extensions`, so a factory that waited to be asked would
 * never be. A caller's own extensions are merged over ours, so passing `live` explicitly is
 * harmless.
 *
 * **It announces itself.** A store minted here logs one line and broadcasts one message on
 * {@link STORE_FACTORY_CHANNEL}, both carrying the store path, the OPFS directory and the server's
 * own `SELECT version()`. That is the only honest way for a page to know WHICH engine answered: a
 * silent success looks identical to the built-in PGlite one, and the whole point of setting the
 * variable is that it did not.
 */

import type { Extensions, PGliteInterfaceExtensions } from "@electric-sql/pglite";
import { live } from "@electric-sql/pglite/live";
import type { ClientPGlite } from "@pgxsinkit/client";

import type { PgrustBrowserPort, PgrustBrowserStorageReport } from "./pgrust-browser-engine";
import { startPgrustBrowserPostmaster } from "./pgrust-browser-engine";
import type { PgrustClientPGlite, PgrustStoreOptions } from "./pgrust-client-pglite";
import {
  attachPgrustClient,
  CLOSE_EXIT_DEADLINE_MS,
  pgrustDurabilityOf,
  pgrustDurabilitySettings,
  pgrustGuestEnv,
  pgxsinkitStoreDirectory,
  resolvePgrustStorePath,
  restoreDatadir,
} from "./pgrust-client-pglite";
import type { PgrustStore } from "./pgrust-store";

/** The `BroadcastChannel` a mint announces itself on, readable from the page or any worker. */
export const STORE_FACTORY_CHANNEL = "pgrust-store-factory";

/** What a mint broadcasts and logs: enough for a page to prove WHICH engine answered. */
export interface PgrustStoreFactoryAnnouncement {
  readonly kind: "pgrust-store-minted";
  /** The plain store name the seam passed. */
  readonly storePath: string;
  /** The store URL the instance reports as its `dataDir` (`opfs://…` or `memory://…`). */
  readonly dataDir: string;
  /** The OPFS directory this store owns in full, or null on the memory port. */
  readonly opfsDir: string | null;
  /** The server's own `SELECT version()`. */
  readonly version: string;
  /**
   * Whether the coordinator opened a data directory that was ALREADY there.
   *
   * The one fact that separates a warm store from a cold one, and therefore the proof that an
   * `opfs://` store actually persisted across a reload: false on the first mint of a directory (the
   * datadir is seeded from the packed image), true on every one after it. Null on the memory port,
   * which is fresh by definition.
   */
  readonly restored: boolean | null;
  /** How long the whole mint took, boot included. */
  readonly elapsedMs: number;
}

/** The client a browser mint hands back: `PgrustClientPGlite`, with `live` set up. */
export type PgrustBrowserClient = PgrustClientPGlite & PGliteInterfaceExtensions<{ live: typeof live }>;

export interface CreatePgrustBrowserPgliteOptions<
  TExtensions extends Extensions = Extensions,
> extends PgrustStoreOptions<TExtensions> {
  /**
   * Where this engine's assets are served from: an absolute URL naming a directory.
   *
   * `./pgrust/` beside this module by default, which is the shape
   * `scripts/package-store-engine.ts` writes and the only one that needs no configuration at all.
   */
  readonly assetBase?: string;
  /** Pool slots for the server's own children, before the one this store's session adds. */
  readonly poolBase?: number;
  /** Bytes the one shared `WebAssembly.Memory` is created with; the host's own default otherwise. */
  readonly initialMemoryBytes?: number;
  /** Announce every mint on the console and the broadcast channel. On by default. */
  readonly announce?: boolean;
}

/**
 * The assets' default home: `./pgrust/` beside this module, whatever URL this module was served
 * from.
 *
 * The seam has no `assetBase` parameter and will not grow one, so a bundle has to be able to find
 * its own things. `import.meta.url` is how — which is also why this file must be bundled as ESM and
 * served, never inlined into somebody else's chunk.
 */
function defaultAssetBase(): string {
  return new URL("./pgrust/", import.meta.url).href;
}

/**
 * Whether this agent may run a pgrust store at all, and why not when it may not.
 *
 * Two separate refusals, because they have two separate fixes. A page that is not cross-origin
 * isolated has no `SharedArrayBuffer` and the whole threads build is unreachable (serve the two
 * headers — `VITE_BOARD_ISOLATED=1`). A window's main thread has `SharedArrayBuffer` but may not
 * `Atomics.wait`, and this store's broker client is synchronous by construction, so the in-process
 * engine home cannot host this engine at all (elect a worker — ADR-0049 placement).
 */
function assertHostable(): void {
  const inWorker = typeof WorkerGlobalScope !== "undefined" && globalThis instanceof WorkerGlobalScope;
  if (!inWorker) {
    throw new Error(
      "the pgrust store factory must run inside a Worker: its store client blocks in `Atomics.wait`, " +
        "which a window's main thread may not do, and the postmaster's threads are nested workers. " +
        "pgxsinkit's in-process (main-thread) engine home cannot host this engine — the elected " +
        "dedicated worker or the SharedWorker can.",
    );
  }
  if (!globalThis.crossOriginIsolated || typeof SharedArrayBuffer !== "function") {
    throw new Error(
      "the pgrust store factory needs a cross-origin-isolated page: SharedArrayBuffer and a shared " +
        "WebAssembly.Memory are withheld without Cross-Origin-Opener-Policy: same-origin and " +
        "Cross-Origin-Embedder-Policy: require-corp on every response (the board's VITE_BOARD_ISOLATED=1).",
    );
  }
}

/** `SELECT version()`, as a single string, or a description of why it could not be read. */
async function serverVersion(pglite: PgrustBrowserClient): Promise<string> {
  try {
    const result = await pglite.query<{ version: string }>("SELECT version()");
    return result.rows[0]?.version ?? "(no row)";
  } catch (error: unknown) {
    return `(unreadable: ${error instanceof Error ? error.message : String(error)})`;
  }
}

/** Say, on the console and on the channel, that THIS module minted a store — and on what server. */
function announceMint(announcement: PgrustStoreFactoryAnnouncement): void {
  console.info(
    `[pgrust-store-factory] minted ${announcement.storePath} -> ${announcement.dataDir}` +
      `${announcement.opfsDir === null ? "" : ` (opfs ${announcement.opfsDir})`} in ` +
      `${announcement.elapsedMs.toFixed(0)} ms, restored=${announcement.restored ?? "n/a"}; ` +
      `SELECT version() = ${announcement.version}`,
  );
  try {
    const channel = new BroadcastChannel(STORE_FACTORY_CHANNEL);
    channel.postMessage(announcement);
    channel.close();
  } catch {
    // A page with no BroadcastChannel still gets the console line; announcing must never fail a mint.
  }
}

/**
 * Open a pgrust-backed PGlite on `storePath`, in this worker.
 *
 * One postmaster, one session, one client — the client owns the engine and `close()` takes it down,
 * which is what releases an OPFS store's four exclusive handles. See `./pgrust-client-pglite.ts` for
 * how each part of pgxsinkit's store contract is answered.
 */
export async function createPgrustPglite<TExtensions extends Extensions = Extensions>(
  storePath: string,
  options: CreatePgrustBrowserPgliteOptions<TExtensions> = {},
): Promise<PgrustBrowserClient> {
  assertHostable();
  const startedAt = performance.now();
  const resolved = resolvePgrustStorePath(storePath, options.backend);
  if (resolved.backend === "file") {
    throw new Error(
      `pgrust store path ${JSON.stringify(storePath)} names a directory on a filesystem, which a browser ` +
        'has none of; use "opfs://<name>" or "memory://<name>"',
    );
  }
  const port: PgrustBrowserPort = resolved.backend;
  const durability = pgrustDurabilityOf(options);
  const opfsDir = port === "opfs" ? pgxsinkitStoreDirectory(resolved.name) : null;

  let storage: PgrustBrowserStorageReport | undefined;
  const engine = await startPgrustBrowserPostmaster({
    assetBase: options.assetBase ?? defaultAssetBase(),
    sessions: 1,
    ...(options.poolBase === undefined ? {} : { poolBase: options.poolBase }),
    ...(options.initialMemoryBytes === undefined ? {} : { initialMemoryBytes: options.initialMemoryBytes }),
    storage:
      opfsDir === null
        ? // The broker is relaxed in BOTH durability modes: its strict mode syncs the store after
          // every mutating request, which is a per-request cost neither pgxsinkit mode asks for.
          // What the mode selects is the guest's own commit discipline, below.
          { port: "memory", durability: "relaxed" }
        : { port: "opfs", opfsDir, durability: "relaxed", reset: options.reset === true },
    settings: pgrustDurabilitySettings(durability, options.settings),
    env: pgrustGuestEnv(options),
    ...(options.loadDataDir === undefined
      ? {}
      : {
          prepareStore: async (store: PgrustStore) => {
            await restoreDatadir(store, options.loadDataDir as File | Blob);
          },
        }),
    ...(options.onServerLog ? { onServerLog: options.onServerLog } : {}),
    onStorageReady: (line: string, report: PgrustBrowserStorageReport) => {
      storage = report;
      console.info(`[pgrust-store-factory] ${line}`);
    },
    exitDeadlineMs: options.closeDeadlineMs ?? CLOSE_EXIT_DEADLINE_MS,
  });

  // `live` first, the caller's own over it: the seam passes no extensions at all, and the engine's
  // live-query manager subscribes through `pglite.live` regardless.
  const instance = (await attachPgrustClient(engine, resolved, {
    ...options,
    extensions: { live, ...(options.extensions ?? {}) },
  })) as PgrustBrowserClient;

  if (options.announce !== false) {
    announceMint({
      kind: "pgrust-store-minted",
      storePath,
      dataDir: resolved.dataDir,
      opfsDir,
      version: await serverVersion(instance),
      restored: opfsDir === null ? null : storage?.restored === true,
      elapsedMs: performance.now() - startedAt,
    });
  }
  return instance;
}

/**
 * The `createPglite` seam pgxsinkit's engine home takes, bound to a set of defaults.
 *
 * pgxsinkit hands a PLAIN store path and, in its test lane, a `"memory"` backend override
 * (ADR-0036); the backend is otherwise the OPFS port, because that is what a persistent store on
 * this engine is. That mapping is the whole of this adapter.
 */
export function createPgrustBrowserPgliteFactory<TExtensions extends Extensions = Extensions>(
  defaults: Omit<CreatePgrustBrowserPgliteOptions<TExtensions>, "backend"> = {},
): (storePath: string, backendOverride?: "memory") => Promise<ClientPGlite> {
  return async (storePath: string, backendOverride?: "memory") =>
    // `ClientPGlite` is `PGliteWithLive`, a class type: a structurally identical instance of another
    // class does not satisfy it nominally, which is why pgxsinkit's own scenarios cast too.
    (await createPgrustPglite(storePath, {
      ...defaults,
      backend: backendOverride ?? "opfs",
    })) as unknown as ClientPGlite;
}

/**
 * The seam's default export: this module, called as `VITE_BOARD_STORE_FACTORY` names it.
 *
 * Defaults all the way down — assets beside this file, OPFS unless the caller overrides to memory,
 * relaxed durability, and an announcement per mint.
 */
const storeFactory = createPgrustBrowserPgliteFactory();

export default storeFactory;
