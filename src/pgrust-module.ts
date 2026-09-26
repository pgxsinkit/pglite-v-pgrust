/**
 * Which pgrust threads module the threads and postmaster Configurations load, and the URL that
 * swaps it.
 *
 * Every Run loads `postgres-threads.wasm`, the module of the release the build was synced from. A
 * build may also carry **alternate threads modules** — one each, from another `pgrust-assets/*`
 * release, installed by `bun run sync:pgrust --alt-release <tag>` at `alt/<id>/postgres-threads.wasm`
 * beside it, where `<id>` is the short commit in that tag. `?pgrustModule=<id>` makes the six pgrust
 * Threads and Postmaster Configurations load that one instead. Only the threads module differs: the
 * host JS, `vfs.img`, the store bundle and the single-session `postgres.wasm` stay the current
 * release's, so two Runs a URL apart compare the two modules and nothing else.
 *
 * It arrives the way the other non-standard Run settings do (`?rttIterations=`,
 * `?postmasterTuning=`): out of band on the page URL, ignored when it is malformed or names a module
 * this build does not carry rather than blanking the page, and never silent — the environment
 * header and every Markdown export say `pgrust module: <id> (alternate)`.
 */

/** The query parameter that swaps the pgrust threads module. */
export const PGRUST_MODULE_PARAM = "pgrustModule";

/** The threads module every Run loads unless the URL names an alternate. */
export const THREADS_MODULE_FILE = "postgres-threads.wasm";

/** The directory, under the pgrust assets, that alternate threads modules live in. */
export const ALTERNATE_MODULES_DIRECTORY = "alt";

/** An alternate's id: the short pgrust commit its release tag carries. */
const MODULE_ID = /^[0-9a-f]{7,40}$/;

/** Whether `value` has the shape of an alternate module's id (it may still name nothing in the build). */
export function isPgrustModuleId(value: string): boolean {
  return MODULE_ID.test(value);
}

/**
 * The threads module's path relative to the pgrust asset directory: `postgres-threads.wasm`, or
 * `alt/<id>/postgres-threads.wasm` for an alternate.
 *
 * Throws on an id that is not one, because this string becomes a URL path and the id is its only
 * variable part.
 */
export function threadsModulePath(moduleId: string | null | undefined): string {
  if (moduleId === null || moduleId === undefined) {
    return THREADS_MODULE_FILE;
  }
  if (!isPgrustModuleId(moduleId)) {
    throw new Error(`"${moduleId}" is not a pgrust module id (a short pgrust commit, 7 to 40 lowercase hex digits)`);
  }
  return `${ALTERNATE_MODULES_DIRECTORY}/${moduleId}/${THREADS_MODULE_FILE}`;
}

/**
 * The alternate a `location.search` asks for, or null.
 *
 * Null for no parameter, for a malformed id and for an id this build carries no module for: a
 * mistyped or stale URL must leave the page running the build's own module, not blank it or fail
 * six columns on a 404.
 */
export function parsePgrustModule(search: string, availableIds: readonly string[]): string | null {
  const raw = new URLSearchParams(search).get(PGRUST_MODULE_PARAM);
  if (raw === null) {
    return null;
  }
  const trimmed = raw.trim().toLowerCase();
  if (!isPgrustModuleId(trimmed) || !availableIds.includes(trimmed)) {
    return null;
  }
  return trimmed;
}

/**
 * The alternate threads modules this build carries, found in `public/pgrust/alt/` by
 * `vite.config.ts` at build time and substituted by Vite `define`.
 */
declare const __PGRUST_ALTERNATE_MODULES__: readonly string[];

/** Absent under `bun test`, hence the `typeof` guard: no build, no alternates. */
export const AVAILABLE_PGRUST_MODULES: readonly string[] =
  typeof __PGRUST_ALTERNATE_MODULES__ === "object" ? __PGRUST_ALTERNATE_MODULES__ : [];

/** The alternate on the current URL; null wherever there is no `location` (under `bun test`). */
export function readPgrustModule(): string | null {
  if (typeof location === "undefined") {
    return null;
  }
  return parsePgrustModule(location.search, AVAILABLE_PGRUST_MODULES);
}

/** How an alternate module is announced wherever the environment is reported. */
export function describePgrustModule(moduleId: string): string {
  return `pgrust module: ${moduleId} (alternate)`;
}

/**
 * The alternate as the threads and postmaster open options spell it: an EMPTY object when there is
 * none, so a default Configuration's options are byte-for-byte the ones this repo's tables were
 * produced with.
 */
export function pgrustModuleOptions(moduleId: string | null): { alternateModule?: string } {
  return moduleId === null ? {} : { alternateModule: moduleId };
}
