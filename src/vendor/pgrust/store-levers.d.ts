/**
 * Hand-written types for the vendored `store-levers.js`: two optional levers the pgrust storage
 * coordinator puts around its store's port — `grow` (the arena file grows in 4 MiB chunks, trimmed
 * back on close) and `coalesce` (contiguous arena writes inside one store call become one handle
 * write). U1 and U2 of `docs/results/2026-09-24-store-levers.md`; the store package itself, which
 * PGlite's OPFS columns run, is never changed.
 *
 * Ours, not pgrust's. It declares only what this repo touches: the lever names, which
 * `src/broker-switches.ts` keeps in step with (`?storeLevers=`), and the host's own check of a list.
 * The coordinator applies the levers itself from the `storeLevers` option it is booted with.
 */

/** Every lever the host knows, in the order it reports them. */
export declare const STORE_LEVER_NAMES: readonly string[];

/** The arena's growth chunk, in bytes. */
export declare const STORE_LEVER_GROW_BYTES: number;

/** The most arena bytes one coalesced write carries. */
export declare const STORE_LEVER_COALESCE_BYTES: number;

/**
 * A list of lever names (or a comma-separated string) as the levers that are on, or null when none
 * is; a `RangeError` for a name the host does not know.
 */
export declare function normalizeStoreLevers(
  value: readonly string[] | string | null | undefined,
): { readonly grow: boolean; readonly coalesce: boolean } | null;
