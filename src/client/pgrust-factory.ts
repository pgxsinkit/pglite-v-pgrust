/**
 * `createPgrustPglite` — one call that gives pgxsinkit the store it asks for, on pgrust, under BUN.
 *
 * The store contract itself — the `PGliteWithLive` shape, `strictSync`, `dumpDataDir`,
 * `loadDataDir`, `close`, durability — lives in `./pgrust-client-pglite.ts` and is answered
 * identically above either boot. What is left here is the third of the job that is bun's: the
 * `node:worker_threads` postmaster of `./pgrust-engine.ts`, the `file` backend no browser has, and
 * the asset DIRECTORY (`public/pgrust/`) a filesystem host reads its build outputs from. The browser
 * half of the same seam is `./pgrust-browser-factory.ts`.
 *
 * **Store paths.** `memory://<name>` is the coordinator's heap — the sanctioned test/ephemeral lane,
 * and all bun can do about persistence in a browser's sense. `opfs://<name>` is refused here (bun
 * has no OPFS); `file:///absolute/directory` is bun's own persistent port, which pgxsinkit's
 * store-path contract never names and which exists for the prepared-store lane.
 */

import type { Extensions, PGliteInterfaceExtensions } from "@electric-sql/pglite";
import type { ClientPGlite } from "@pgxsinkit/client";

import {
  attachPgrustClient,
  CLOSE_EXIT_DEADLINE_MS,
  pgrustDurabilityOf,
  pgrustDurabilitySettings,
  pgrustGuestEnv,
  pgxsinkitStoreDirectory,
  resolvePgrustStorePath,
  restoreDatadir,
  type PgrustClientPGlite,
  type PgrustStoreOptions,
} from "./pgrust-client-pglite";
import { startPgrustPostmaster } from "./pgrust-engine";
import type { PgrustStore } from "./pgrust-store";

export {
  attachPgrustClient,
  CLOSE_EXIT_DEADLINE_MS,
  PgrustClientPGlite,
  pgrustDurabilityOf,
  pgrustDurabilitySettings,
  pgrustGuestEnv,
  pgxsinkitStoreDirectory,
  resolvePgrustStorePath,
  restoreDatadir,
} from "./pgrust-client-pglite";
export type {
  PgrustBackend,
  PgrustClientEngine,
  PgrustDurability,
  PgrustEngineShutdown,
  PgrustStoreOptions,
  ResolvedStorePath,
} from "./pgrust-client-pglite";

export interface PgrustAssetLocation {
  /**
   * Where `bun run sync:pgrust` wrote the pgrust build outputs: `postgres-threads.wasm`, `vfs.img`,
   * `vfs.json`, and the store bundle under `host/`. A directory path with a trailing separator.
   * `public/pgrust/` by default — one directory, because the four are one build output.
   */
  readonly directory?: string;
}

export interface CreatePgrustPgliteOptions<
  TExtensions extends Extensions = Extensions,
> extends PgrustStoreOptions<TExtensions> {
  /** Where the pgrust build outputs live. `public/pgrust/` by default. */
  readonly assets?: PgrustAssetLocation;
}

/**
 * Open a pgrust-backed PGlite on `storePath`, under bun.
 *
 * One postmaster, one session, one client — the client owns the engine and `close()` takes it down.
 * See `./pgrust-client-pglite.ts` for how each part of pgxsinkit's contract is answered.
 */
export async function createPgrustPglite<TExtensions extends Extensions = Extensions>(
  storePath: string,
  options: CreatePgrustPgliteOptions<TExtensions> = {},
): Promise<PgrustClientPGlite & PGliteInterfaceExtensions<TExtensions>> {
  const resolved = resolvePgrustStorePath(storePath, options.backend);
  const durability = pgrustDurabilityOf(options);

  const engine = await startPgrustPostmaster({
    sessions: 1,
    storage: {
      port: resolved.backend,
      // The broker is relaxed in BOTH durability modes: its strict mode syncs the store after every
      // mutating request, which is a per-request cost neither pgxsinkit mode asks for. What the
      // mode selects is the guest's own commit discipline, below.
      durability: "relaxed",
      ...(resolved.backend === "opfs" ? { opfsDir: pgxsinkitStoreDirectory(resolved.name) } : {}),
      // A file store's "name" IS its directory: there is no store identity to encode, because
      // nothing but this process is looking for it.
      ...(resolved.backend === "file" ? { fileDir: resolved.name } : {}),
      ...(options.reset === true ? { reset: true } : {}),
    },
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
    ...(options.assets?.directory === undefined ? {} : { assetDir: options.assets.directory }),
    exitDeadlineMs: options.closeDeadlineMs ?? CLOSE_EXIT_DEADLINE_MS,
  });

  return await attachPgrustClient(engine, resolved, options);
}

/**
 * The `createPglite` seam pgxsinkit's worker takes, bound to a set of defaults.
 *
 * `DefineSyncWorkerOptions.createPglite` is `(storePath, backendOverride?) => Promise<ClientPGlite>`
 * and that is exactly this signature. pgxsinkit hands a PLAIN store path and, in its test lane, a
 * `"memory"` backend override (ADR-0036); the backend is otherwise derived from the engine home's
 * capabilities, which for a pgrust store means the OPFS port. That mapping is the whole of this
 * adapter — everything else is {@link createPgrustPglite}, and what comes back is one of its
 * instances under the seam's own type.
 */
export function createPgrustPgliteFactory<TExtensions extends Extensions = Extensions>(
  defaults: Omit<CreatePgrustPgliteOptions<TExtensions>, "backend"> = {},
): (storePath: string, backendOverride?: "memory") => Promise<ClientPGlite> {
  return async (storePath: string, backendOverride?: "memory") =>
    // `ClientPGlite` is `PGliteWithLive`, a class type: a structurally identical instance of another
    // class does not satisfy it nominally, which is why pgxsinkit's own scenarios cast too.
    (await createPgrustPglite(storePath, {
      ...defaults,
      backend: backendOverride ?? "opfs",
    })) as unknown as ClientPGlite;
}
