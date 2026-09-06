/**
 * Everything this app does in the Origin Private File System, in one place.
 *
 * Two things need OPFS: the `opfs-repacked` store the two Storage Configurations run on, and the
 * capability probe that decides whether those Configurations can run here at all. Both go through
 * the helpers below, so everything this app creates sits under one owned prefix and is taken away
 * again — an origin's OPFS outlives the page, and a benchmark has no business leaving a data
 * directory behind, let alone reading one back into a later Run. The prefix directory itself stays,
 * empty: removing it would race any other tab of this app that is mid-Run.
 *
 * The path helpers are pure and unit-tested; the directory helpers need a real OPFS and are
 * exercised by the Runs themselves.
 */

/** The one directory this app owns. Nothing outside it is ever created, read or removed. */
export const OPFS_DIRECTORY_PREFIX = "pglite-v-pgrust";

/** Where the capability probe puts its single file; created and removed inside one probe. */
export const OPFS_PROBE_DIRECTORY = `${OPFS_DIRECTORY_PREFIX}/opfs-sync-access-probe`;

/** The file the probe asks for a synchronous access handle on. */
export const OPFS_PROBE_FILE = "probe.bin";

/**
 * Split an OPFS path into its directory names.
 *
 * A Configuration's `dataDir` may be nested (`pglite-v-pgrust/opfs-repacked-relaxed`), so every
 * parent has to be walked. `.` and `..` are rejected rather than resolved: OPFS has no notion of
 * either, and quietly accepting them would let a path escape the owned prefix.
 */
export function opfsPathSegments(path: string): readonly string[] {
  const segments = path.split("/").filter((segment) => segment !== "");
  if (segments.length === 0) {
    throw new Error(`"${path}" is not an OPFS directory path`);
  }
  for (const segment of segments) {
    if (segment === "." || segment === "..") {
      throw new Error(`OPFS path "${path}" contains a relative segment`);
    }
  }
  return segments;
}

/** The OPFS root, or a clear failure: not every context grants one. */
async function opfsRoot(): Promise<FileSystemDirectoryHandle> {
  const storage: StorageManager | undefined = typeof navigator === "undefined" ? undefined : navigator.storage;
  if (typeof storage?.getDirectory !== "function") {
    throw new Error("This browser context has no Origin Private File System (navigator.storage.getDirectory)");
  }
  return await storage.getDirectory();
}

/** Walk to a directory, creating the parents on the way; `null` when a missing one is not created. */
async function directoryAt(segments: readonly string[], create: boolean): Promise<FileSystemDirectoryHandle | null> {
  let directory = await opfsRoot();
  for (const segment of segments) {
    try {
      directory = await directory.getDirectoryHandle(segment, { create });
    } catch (error: unknown) {
      if (!create && isNotFound(error)) {
        return null;
      }
      throw error;
    }
  }
  return directory;
}

function isNotFound(error: unknown): boolean {
  return error instanceof DOMException && error.name === "NotFoundError";
}

/**
 * An empty directory at `path`, whatever was there before.
 *
 * Every Run starts from nothing: the store owns its directory in full and refuses to open one that
 * holds anything it did not write, and a Configuration that inherited an earlier Run's data
 * directory would be measuring a warm store while claiming to measure a cold one.
 */
export async function emptyOpfsDirectory(path: string): Promise<FileSystemDirectoryHandle> {
  const segments = opfsPathSegments(path);
  const name = segments[segments.length - 1] ?? "";
  const parents = segments.slice(0, -1);
  const parent = await directoryAt(parents, true);
  if (parent === null) {
    throw new Error(`Could not create the OPFS parent directories of "${path}"`);
  }
  await removeEntry(parent, name);
  return await parent.getDirectoryHandle(name, { create: true });
}

/** Remove the directory at `path` and everything under it. A directory that is not there is fine. */
export async function removeOpfsDirectory(path: string): Promise<void> {
  const segments = opfsPathSegments(path);
  const name = segments[segments.length - 1] ?? "";
  const parent = await directoryAt(segments.slice(0, -1), false);
  if (parent === null) {
    return;
  }
  await removeEntry(parent, name);
}

async function removeEntry(parent: FileSystemDirectoryHandle, name: string): Promise<void> {
  try {
    await parent.removeEntry(name, { recursive: true });
  } catch (error: unknown) {
    if (isNotFound(error)) {
      return;
    }
    throw error;
  }
}
