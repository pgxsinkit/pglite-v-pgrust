/**
 * Types for the one wa-sqlite example VFS this repo uses.
 *
 * wa-sqlite ships ambient declarations for its API, its constants and `src/VFS.js`, but as of
 * v1.1.2 it no longer declares the modules under `src/examples/`. `MemoryVFS.js` is plain
 * JavaScript and `allowJs` is off, so this is what makes the import type-check.
 *
 * Deliberately minimal: the Engine worker only ever calls the static factory and hands the result
 * to `vfs_register`, so only that is described. `SQLiteVFS` is upstream's own global interface, and
 * `MemoryVFS` really does satisfy it — in 1.1.x it extends `FacadeVFS`, which extends the
 * `VFS.Base` that upstream declares as `implements SQLiteVFS`.
 */

declare module "wa-sqlite/src/examples/MemoryVFS.js" {
  export class MemoryVFS {
    /**
     * Construct the VFS against an Emscripten module and await its `isReady()`. This is the 1.1.x
     * replacement for `new MemoryVFS()`, which no longer exists.
     */
    static create(name: string, module: object): Promise<SQLiteVFS>;
  }
}
